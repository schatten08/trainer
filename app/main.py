import json
import random
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app.ai_review import review_provider

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"
DATA_DIR = Path(__file__).resolve().parent / "data"
SCENARIOS_FILE = DATA_DIR / "scenarios.json"
LINUX_FILE = DATA_DIR / "linux_scenarios.json"
QUESTIONS_FILE = DATA_DIR / "questions.json"
QUESTIONS_HARD_FILE = DATA_DIR / "questions_hard.json"
QUESTIONS_EN_FILE = DATA_DIR / "questions_en.json"
QUESTIONS_HARD_EN_FILE = DATA_DIR / "questions_hard_en.json"

app = FastAPI(title="Interview Trainer")


class NoCacheStaticFiles(StaticFiles):
    """StaticFiles с Cache-Control: no-cache — браузер обязан каждый раз
    ревалидировать файл через ETag/Last-Modified (быстрый 304, если файл
    не менялся), но не может тихо отдавать устаревшую версию app.js/
    style.css/index.html из локального кэша после деплоя новой версии.
    Без этого разные устройства могли получать разные закэшированные
    версии HTML/JS/CSS одновременно — рассинхрон приводил к сломанным
    обработчикам кликов (JS ищет элемент из нового HTML, которого нет
    в закэшированной старой версии) и "слипшимся" стилям на мобильных.
    """

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-cache"
        return response

with open(SCENARIOS_FILE, encoding="utf-8") as f:
    SCENARIOS = json.load(f)
for q in SCENARIOS:
    q.setdefault("type", "scenario")
    q.setdefault("difficulty", "middle")

with open(LINUX_FILE, encoding="utf-8") as f:
    LINUX_SCENARIOS = json.load(f)
for q in LINUX_SCENARIOS:
    q.setdefault("type", "linux")
    q.setdefault("difficulty", "middle")
    q.setdefault("subtopic", "general")

with open(QUESTIONS_FILE, encoding="utf-8") as f:
    _ALL_MCQ = json.load(f)
with open(QUESTIONS_HARD_FILE, encoding="utf-8") as f:
    _ALL_MCQ_HARD = json.load(f)
with open(QUESTIONS_EN_FILE, encoding="utf-8") as f:
    _ALL_MCQ_EN = json.load(f)
with open(QUESTIONS_HARD_EN_FILE, encoding="utf-8") as f:
    _ALL_MCQ_HARD_EN = json.load(f)

# Раздел MCQ-квиза сейчас включён только для Terraform (подготовка к
# Terraform Associate 004) — остальные темы (AWS/Docker/GitLab CI/K8s/Git)
# в questions.json пока не подключены к UI.
TF_MCQ = [q for q in _ALL_MCQ if q.get("topic") == "Terraform"] + [
    q for q in _ALL_MCQ_HARD if q.get("topic") == "Terraform"
]
for q in TF_MCQ:
    q.setdefault("type", "mcq")
    q.setdefault("difficulty", "easy")
TF_MCQ_BY_ID = {q["id"]: q for q in TF_MCQ}

# Англоязычная версия того же пула Terraform-вопросов (те же id и
# correct_index, что и в TF_MCQ — только текст question/options/
# explanation переведён) — используется в экране "Экзамен" при выборе
# lang=en, чтобы можно было тренироваться в условиях, близких к реальному
# (англоязычному) экзамену Terraform Associate 004.
TF_MCQ_EN = [q for q in _ALL_MCQ_EN if q.get("topic") == "Terraform"] + [
    q for q in _ALL_MCQ_HARD_EN if q.get("topic") == "Terraform"
]
for q in TF_MCQ_EN:
    q.setdefault("type", "mcq")
    q.setdefault("difficulty", "easy")

TF_MCQ_BY_LANG = {"ru": TF_MCQ, "en": TF_MCQ_EN}

SCENARIOS_BY_ID = {c["id"]: c for c in SCENARIOS}
LINUX_BY_ID = {c["id"]: c for c in LINUX_SCENARIOS}

TOPICS = sorted({q["topic"] for q in SCENARIOS})

# Подразделы Linux Troubleshooting — соответствуют пунктам PDP-блока
# "Linux / Troubleshooting" (systemd/journald, сеть, диск/память/CPU,
# общие кейсы). Порядок и подписи заданы явно (не алфавитный sorted),
# чтобы в UI отражать логику освоения из PDP: systemd → perf → network → general.
LINUX_SUBTOPICS = [
    {"id": "systemd", "label": "systemd, journald"},
    {"id": "perf", "label": "Диск / память / CPU"},
    {"id": "network", "label": "Сеть"},
    {"id": "general", "label": "Общие кейсы"},
]


def _attach_reference_answers(review_result, cards_by_id):
    """Домешивает reference_answer (sample_answer карточки) в каждый item
    результата ревью — кандидат должен видеть подробный правильный ответ
    независимо от score, а не только короткий фидбек AI. Мутирует
    review_result на месте (dict с ключом "items" — список dict)."""
    for item in review_result.get("items", []):
        card = cards_by_id.get(item.get("id"))
        item["reference_answer"] = card["sample_answer"] if card else None
    return review_result


@app.get("/api/topics")
def get_topics():
    """Возвращает список тем DevOps/Cloud и количество сценариев в каждой."""
    counts = {topic: sum(1 for q in SCENARIOS if q["topic"] == topic) for topic in TOPICS}
    return {
        "topics": TOPICS,
        "counts": counts,
        "total": len(SCENARIOS),
    }


@app.get("/api/mock-interview/start")
def start_mock_interview(
    count: int = Query(5, ge=1, le=len(SCENARIOS)),
    topic: str | None = Query(None, description="Фильтр по конкретной теме"),
    level: str = Query(
        "junior_middle",
        description=(
            "junior_middle (по умолчанию, без вопросов уровня senior) | "
            "senior (только senior) | all (весь пул вперемешку)"
        ),
    ),
):
    """Запускает раунд 'Мок-интервью': отдаёт случайные сценарные вопросы
    без эталонного ответа (sample_answer скрыт — иначе кандидат может
    просто скопировать его вместо того, чтобы отвечать своими словами).

    По умолчанию (level=junior_middle) senior-вопросы (архитектурные, вроде
    мультиаккаунтного AWS SSO или StatefulSet-миграции БД) не показываются —
    большинству кандидатов на junior/middle позицию их спрашивать
    нерелевантно, и это только сбивает с толку при подготовке.
    """
    if level == "senior":
        base = [q for q in SCENARIOS if q["difficulty"] == "senior"]
    elif level == "all":
        base = SCENARIOS
    else:
        base = [q for q in SCENARIOS if q["difficulty"] != "senior"]

    pool = base if not topic else [q for q in base if q["topic"] == topic]
    count = min(count, len(pool))
    selected = random.sample(pool, count) if count > 0 else []
    questions = [
        {"id": q["id"], "topic": q["topic"], "question": q["question"], "difficulty": q["difficulty"]}
        for q in selected
    ]
    return {"questions": questions, "count": len(questions)}


class MockInterviewAnswer(BaseModel):
    id: str
    user_answer: str = ""


class MockInterviewReviewRequest(BaseModel):
    answers: list[MockInterviewAnswer]


@app.post("/api/mock-interview/review")
def review_mock_interview(payload: MockInterviewReviewRequest):
    """Принимает свободные ответы кандидата на сценарные вопросы и
    возвращает AI-оценку (score 0-100 + фидбек) по каждому вопросу и общий
    % за раунд. Эталонные ответы (sample_answer) берутся с бэкенда по id,
    а не принимаются от клиента — иначе клиент мог бы подделать эталон.
    В ответ дополнительно подмешивается reference_answer по каждому
    вопросу (независимо от score) — кандидат должен видеть подробный
    правильный ответ даже если ответил неверно, а не только фидбек AI.
    """
    if not payload.answers:
        raise HTTPException(status_code=400, detail="Список ответов пуст")

    items = []
    for ans in payload.answers:
        card = SCENARIOS_BY_ID.get(ans.id)
        if not card:
            raise HTTPException(
                status_code=404, detail=f"Сценарный вопрос с id={ans.id} не найден"
            )
        items.append({
            "id": card["id"],
            "topic": card["topic"],
            "question": card["question"],
            "reference_answer": card["sample_answer"],
            "user_answer": ans.user_answer.strip(),
        })

    result = review_provider.review_round(items)
    _attach_reference_answers(result, SCENARIOS_BY_ID)
    return result


@app.get("/api/quiz/terraform/meta")
def get_terraform_quiz_meta():
    """Возвращает размер пула Terraform MCQ-вопросов (всего + по сложности).
    Нужен, чтобы UI (кнопка 'Все (N)' на экране настройки) показывал
    актуальное число вместо захардкоженного значения — при добавлении
    следующего раунда контента (round5+) счётчик обновится сам, без
    правки HTML.
    """
    counts = {
        "easy": sum(1 for q in TF_MCQ if q["difficulty"] == "easy"),
        "hard": sum(1 for q in TF_MCQ if q["difficulty"] == "hard"),
    }
    return {"total": len(TF_MCQ), "counts": counts}


@app.get("/api/quiz/terraform")
def get_terraform_quiz(
    count: int = Query(15, ge=1, le=len(TF_MCQ)),
    difficulty: str | None = Query(
        None, description="easy | hard | пусто = вперемешку (только обычные + hard-вопросы)"
    ),
    lang: str = Query(
        "ru", description="ru (по умолчанию) | en — язык вопросов/вариантов ответа"
    ),
):
    """Возвращает случайную выборку MCQ-вопросов по Terraform (подготовка
    к экзамену Terraform Associate 004). Единственная тема, для которой
    сейчас включён MCQ-режим — остальные темы questions.json пока не
    подключены к UI. lang=en отдаёт тот же пул вопросов (те же id и
    correct_index), но с переведённым текстом — для тренировки в условиях
    англоязычного оригинала экзамена."""
    source = TF_MCQ_BY_LANG.get(lang, TF_MCQ)
    pool = source if not difficulty else [q for q in source if q["difficulty"] == difficulty]
    count = min(count, len(pool))
    selected = random.sample(pool, count) if count > 0 else []
    return {"questions": selected, "count": len(selected), "total_available": len(source)}


@app.get("/api/linux-trainer/subtopics")
def get_linux_subtopics():
    """Возвращает список подразделов Linux Troubleshooting (соответствуют
    пунктам PDP-блока) с количеством кейсов в каждом — для UI-фильтра
    перед стартом раунда."""
    counts = {st["id"]: sum(1 for q in LINUX_SCENARIOS if q["subtopic"] == st["id"]) for st in LINUX_SUBTOPICS}
    return {
        "subtopics": [{**st, "count": counts.get(st["id"], 0)} for st in LINUX_SUBTOPICS],
        "total": len(LINUX_SCENARIOS),
    }


@app.get("/api/linux-trainer/start")
def start_linux_trainer(
    count: int = Query(5, ge=1, le=len(LINUX_SCENARIOS)),
    difficulty: str | None = Query(
        None, description="junior | middle | senior | пусто = вперемешку"
    ),
    subtopic: str | None = Query(
        None, description="systemd | perf | network | general | пусто = все подразделы"
    ),
):
    """Запускает раунд тренера 'Linux Troubleshooting': отдаёт случайные
    диагностические кейсы без эталонного ответа. Ответ оценивается не как
    факт, а как методология расследования (последовательность действий,
    инструменты, гипотезы) — см. review_provider.review_linux_round.
    """
    base = LINUX_SCENARIOS
    if difficulty:
        base = [q for q in base if q["difficulty"] == difficulty]
    if subtopic:
        base = [q for q in base if q["subtopic"] == subtopic]

    count = min(count, len(base))
    selected = random.sample(base, count) if count > 0 else []
    questions = [
        {
            "id": q["id"],
            "topic": q["topic"],
            "question": q["question"],
            "difficulty": q["difficulty"],
            "subtopic": q["subtopic"],
        }
        for q in selected
    ]
    return {"questions": questions, "count": len(questions)}


@app.post("/api/linux-trainer/review")
def review_linux_trainer(payload: MockInterviewReviewRequest):
    """Аналог /api/mock-interview/review, но для Linux troubleshooting-кейсов:
    оценивается диагностическая методология кандидата (использует
    отдельный AI-промпт, ориентированный на порядок действий/инструменты,
    а не только фактическую правильность ответа). В ответ дополнительно
    подмешивается reference_answer с подробным разбором методологии по
    каждому вопросу — независимо от score, чтобы кандидат мог разобрать
    правильный подход даже при неверном/неполном ответе.
    """
    if not payload.answers:
        raise HTTPException(status_code=400, detail="Список ответов пуст")

    items = []
    for ans in payload.answers:
        card = LINUX_BY_ID.get(ans.id)
        if not card:
            raise HTTPException(
                status_code=404, detail=f"Linux-кейс с id={ans.id} не найден"
            )
        items.append({
            "id": card["id"],
            "topic": card["topic"],
            "question": card["question"],
            "reference_answer": card["sample_answer"],
            "user_answer": ans.user_answer.strip(),
        })

    result = review_provider.review_linux_round(items)
    _attach_reference_answers(result, LINUX_BY_ID)
    return result


app.mount("/static", NoCacheStaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache"})
