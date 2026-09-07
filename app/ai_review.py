"""
AI-ревью для режима "Мок-интервью": сравнивает свободные текстовые ответы
пользователя с эталонными ответами (sample_answer для сценариев,
correct option + explanation для MCQ, показанных в открытом виде) и
возвращает структурированную оценку по каждому вопросу + общий % за весь
раунд.

Использует тот же провайдер (Gemini, google-genai SDK) и тот же паттерн
retry-при-503, что и ai_wrapper.py в shopping_bot на этом сервере — единая
конвенция для всех ботов, читающих GEMINI_API_KEY из .env.
"""
import json
import logging
import os
import time

from dotenv import load_dotenv
from google import genai
from google.genai import types

load_dotenv()

logger = logging.getLogger(__name__)

# Батч-ревью (сравнение нескольких ответов с эталонами за один запрос)
# объективно тяжелее, чем разбор одного списка покупок в shopping_bot —
# даём заметно больший таймаут, чтобы не ловить DEADLINE_EXCEEDED на
# раундах из 5+ вопросов.
GEMINI_MODEL_ID = "gemini-3.6-flash"
GEMINI_TIMEOUT_MS = 120_000

REVIEW_PROMPT_TEMPLATE = """
Ты — опытный технический интервьюер, проверяющий ответы кандидата на
собеседовании по темам DevOps/Cloud (AWS, Docker, Terraform, GitLab CI,
Kubernetes, Git).

Тебе дан список из {count} пар (вопрос, эталонный ответ, ответ кандидата).
Для КАЖДОГО вопроса оцени ответ кандидата по шкале 0-100 (score), исходя из
того, насколько он по смыслу совпадает с эталонным ответом (не требуй
слово-в-слово, важна суть и правильность фактов):
- Пустой ответ / "не знаю" → score 0.
- Ответ есть, но неверный по сути или перепутаны ключевые понятия → 5-30.
- Ответ верный по направлению, но неполный/неточный (упущены важные детали,
  названы не все шаги, спутана терминология) → 40-75.
- Ответ полный и корректный → 90-100.

Для КАЖДОГО вопроса дай конкретный фидбек на русском (2-3 предложения) —
ЭТО ГЛАВНОЕ ПРАВИЛО: фидбек должен объяснять по сути, а не просто
классифицировать ответ. НЕЛЬЗЯ ограничиваться фразами вроде "кандидат не
дал ответа" или "кандидат не ответил на вопрос" без продолжения — даже если
ответ пустой, обязательно кратко (1-2 предложения) объясни, в чём была бы
суть правильного ответа, чтобы кандидат мог этому научиться на разборе.
Для неточных/неполных ответов явно назови: что конкретно было верно, какие
детали/шаги/термины упущены или перепутаны, и что нужно было сказать
дополнительно. Разделяй по смыслу "кандидат не знал совсем" (пустой ответ
или явно неверная суть) и "кандидат знал направление, но ответил
неточно/неполно" (частично верно) — используй именно такие формулировки
там, где это применимо, вместо расплывчатого "не ответил".

В конце дай overall_percent (среднее по всем score, округлённое до целого)
и overall_feedback — 2-3 предложения общего резюме по всему раунду:
сильные темы и темы, которые стоит подтянуть.

Вопросы и ответы:
{qa_block}

ОТВЕТЬ СТРОГО В JSON, без markdown-разметки, без пояснений вне JSON:
{{
  "items": [
    {{"id": "id_вопроса", "score": 0-100, "feedback": "текст"}}
  ],
  "overall_percent": 0-100,
  "overall_feedback": "текст"
}}
"""

LINUX_REVIEW_PROMPT_TEMPLATE = """
Ты — опытный Senior Systems Engineer / SRE, проверяющий ответы кандидата на
собеседовании по Linux troubleshooting. Каждый вопрос — реальный
диагностический кейс (сервер работает медленно, сервис не стартует, диск
переполнен и т.п.), и ЭТАЛОННЫЙ ОТВЕТ описывает не только правильный вывод,
но и МЕТОДОЛОГИЮ расследования: конкретные команды/инструменты и порядок
их применения.

Тебе дан список из {count} пар (вопрос, эталонный ответ, ответ кандидата).
Для КАЖДОГО вопроса оцени ответ кандидата по шкале 0-100 (score), оценивая
ИМЕННО ДИАГНОСТИЧЕСКУЮ МЕТОДОЛОГИЮ, а не только финальный вывод:
- Пустой ответ / "не знаю" → score 0.
- Кандидат называет только финальный вывод/причину без объяснения, КАК он
  бы это обнаружил (какие команды/инструменты использовал бы) → 15-35,
  даже если сам вывод верный — на реальном собеседовании и в реальной
  работе важно именно умение диагностировать, а не угадать причину.
- Кандидат называет релевантные команды/инструменты, но в случайном
  порядке или упускает важный шаг (например, сразу лезет в strace, минуя
  очевидные top/journalctl) → 40-65.
- Кандидат выстраивает логичную последовательность "от простого к
  сложному", называет конкретные команды и объясняет, что каждая команда
  должна показать и почему это ведёт к следующему шагу → 75-95.
- Ответ полностью совпадает по методологии и глубине с эталонным (или
  предлагает не менее обоснованную альтернативную последовательность
  действий, достигающую того же результата) → 90-100.

Для КАЖДОГО вопроса дай конкретный фидбек на русском (2-4 предложения) —
ЭТО ГЛАВНОЕ ПРАВИЛО: фидбек должен разбирать МЕТОДОЛОГИЮ, а не только факт.
Явно укажи: (1) какие шаги/команды кандидат назвал верно, (2) какие важные
шаги/инструменты пропустил или сделал бы в неоптимальном порядке, (3) если
ответ пустой или содержит только вывод без методологии — кратко опиши,
какую последовательность диагностики стоило бы применить, чтобы кандидат
мог этому научиться на разборе. Не ограничивайся фразой "кандидат не
ответил" без объяснения сути правильного подхода.

В конце дай overall_percent (среднее по всем score, округлённое до целого)
и overall_feedback — 2-3 предложения общего резюме по всему раунду: что
говорит об уровне troubleshooting-навыков кандидата (например, "хорошо
понимает инструменты, но пропускает системную методологию 'от простого к
сложному'") и какие конкретные области Linux стоит подтянуть.

Вопросы и ответы:
{qa_block}

ОТВЕТЬ СТРОГО В JSON, без markdown-разметки, без пояснений вне JSON:
{{
  "items": [
    {{"id": "id_вопроса", "score": 0-100, "feedback": "текст"}}
  ],
  "overall_percent": 0-100,
  "overall_feedback": "текст"
}}
"""


def _build_qa_block(items):
    lines = []
    for i, item in enumerate(items, start=1):
        lines.append(
            f"{i}. [id={item['id']}] Вопрос ({item['topic']}): {item['question']}\n"
            f"   Эталонный ответ: {item['reference_answer']}\n"
            f"   Ответ кандидата: {item['user_answer'] or '(пустой ответ / не знаю)'}"
        )
    return "\n\n".join(lines)


class ReviewProvider:
    def __init__(self):
        self.api_key = os.getenv("GEMINI_API_KEY")
        if self.api_key:
            self.client = genai.Client(
                api_key=self.api_key,
                http_options=types.HttpOptions(timeout=GEMINI_TIMEOUT_MS),
            )
            self.model_id = GEMINI_MODEL_ID
        else:
            self.client = None
            logger.warning(
                "GEMINI_API_KEY не задан — режим 'Мок-интервью' будет "
                "возвращать fallback-оценку без реального AI-ревью."
            )

    def _generate_with_retries(self, prompt, max_retries=3):
        assert self.client is not None, "_generate_with_retries вызван без инициализированного client"
        last_error: Exception | None = None
        for attempt in range(max_retries):
            try:
                response = self.client.models.generate_content(
                    model=self.model_id,
                    contents=prompt,
                    config={"response_mime_type": "application/json"},
                )
                response_text = response.text or ""
                logger.debug("AI review response: %s", response_text)
                return json.loads(response_text.strip())
            except Exception as e:
                last_error = e
                is_retryable = (
                    "503" in str(e)
                    or "Service Unavailable" in str(e)
                    or "504" in str(e)
                    or "DEADLINE_EXCEEDED" in str(e)
                    or "timeout" in str(e).lower()
                )
                if is_retryable:
                    logger.warning(
                        "AI review %s, попытка %d/%d, повтор через 2с...",
                        "таймаут" if "DEADLINE_EXCEEDED" in str(e) or "504" in str(e) else "503",
                        attempt + 1, max_retries,
                    )
                    time.sleep(2)
                    continue
                raise e

        logger.error("AI review error после %d попыток: %s", max_retries, last_error)
        if last_error is not None:
            raise last_error
        raise RuntimeError("AI review завершился без результата и без исключения")

    def review_round(self, items, prompt_template=REVIEW_PROMPT_TEMPLATE):
        """
        items: список dict {id, topic, question, reference_answer, user_answer}.
        prompt_template: шаблон промпта (по умолчанию — общий DevOps/Cloud
        review; для Linux troubleshooting передаётся LINUX_REVIEW_PROMPT_TEMPLATE,
        оценивающий диагностическую методологию, а не только факт).
        Возвращает dict {items: [{id, score, feedback}], overall_percent, overall_feedback}.
        Если ключ API не настроен или Gemini недоступен после ретраев —
        возвращает fallback-объект с score=None и явным сообщением об ошибке
        (вместо того чтобы молча притвориться, что оценка успешна).
        """
        if not self.client:
            return self._fallback_result(
                items, "AI-провайдер не настроен (нет GEMINI_API_KEY на сервере)."
            )

        prompt = prompt_template.format(
            count=len(items), qa_block=_build_qa_block(items)
        )

        try:
            data = self._generate_with_retries(prompt)
        except Exception as e:
            logger.error("Не удалось получить AI-ревью: %s", e)
            return self._fallback_result(
                items, "Не удалось связаться с AI-провайдером (Gemini сейчас недоступен)."
            )

        # Защита от неполного/повреждённого ответа модели: гарантируем, что
        # каждый исходный id получит хоть какую-то запись в результате.
        by_id = {it.get("id"): it for it in data.get("items", []) if it.get("id")}
        result_items = []
        for item in items:
            entry = by_id.get(item["id"])
            if entry:
                result_items.append({
                    "id": item["id"],
                    "score": entry.get("score"),
                    "feedback": entry.get("feedback", ""),
                })
            else:
                result_items.append({
                    "id": item["id"],
                    "score": None,
                    "feedback": "AI не вернул оценку по этому вопросу.",
                })

        return {
            "items": result_items,
            "overall_percent": data.get("overall_percent"),
            "overall_feedback": data.get("overall_feedback", ""),
        }

    def review_linux_round(self, items):
        """Оценка раунда тренера 'Linux Troubleshooting' — использует
        LINUX_REVIEW_PROMPT_TEMPLATE, ориентированный на диагностическую
        методологию (порядок действий/инструменты), а не только на
        совпадение с эталонным выводом."""
        return self.review_round(items, prompt_template=LINUX_REVIEW_PROMPT_TEMPLATE)

    @staticmethod
    def _fallback_result(items, message):
        return {
            "items": [
                {"id": item["id"], "score": None, "feedback": message}
                for item in items
            ],
            "overall_percent": None,
            "overall_feedback": message,
        }


review_provider = ReviewProvider()
