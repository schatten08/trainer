// =====================================================================
// State
// =====================================================================
let mockState = {
  questions: [],
  index: 0,
  answers: [], // строки, по индексу вопроса (для навигации назад/вперёд)
};

let linuxState = {
  questions: [],
  index: 0,
  answers: [], // строки, по индексу вопроса (для навигации назад/вперёд)
};

let tfQuizState = {
  questions: [],
  currentIndex: 0,
  selectedCount: 15,
  selectedDifficulty: "",
  answers: [], // { id, correct, skipped }
  currentShuffledOptions: [], // [{ text, originalIndex }]
  isRetryRound: false,
  retryQueue: [], // question objects to re-ask after first pass
  retryResults: { practiced: 0, nowCorrect: 0 },
};

// Экзамен Terraform Associate — полная симуляция: 65 вопросов, 60 минут,
// без подсказок/объяснений во время прохождения, без возврата назад,
// автосдача по истечении времени.
const EXAM_DURATION_SEC = 60 * 60;
const EXAM_PASS_THRESHOLD_PCT = 70;

// Локализация UI-обвязки экрана экзамена (метки/кнопки/разбор) — должна
// совпадать с языком вопросов (exam-lang-select), иначе интерфейс получается
// смешанным: RU-метки поверх EN-контента. examLang хранит текущий выбор,
// tExam(key) возвращает строку для него.
let examLang = "ru";

const EXAM_I18N = {
  ru: {
    question: (i, total) => `Вопрос ${i} / ${total}`,
    skip: "Не знаю / затрудняюсь ответить",
    resultTitle: "Результат экзамена",
    passed: (pct) => `✅ Сдано (порог ${pct}%)`,
    failed: (pct) => `❌ Не сдано (порог ${pct}%)`,
    correct: "✓ Верно:",
    wrong: "✗ Неверно:",
    skipped: "? Не знал:",
    timedOut: "Время истекло (60 минут) — экзамен завершён автоматически.",
    timeSpent: (min, sec) => `Затрачено времени: ${min} мин ${sec} сек из 60.`,
    skippedAnswer: "Пропущен",
    wrongAnswer: "Неверный ответ",
    reviewLabel: "Разбор:",
    backToMenu: "В меню",
  },
  en: {
    question: (i, total) => `Question ${i} / ${total}`,
    skip: "I don't know / not sure",
    resultTitle: "Exam Result",
    passed: (pct) => `✅ Passed (threshold ${pct}%)`,
    failed: (pct) => `❌ Not passed (threshold ${pct}%)`,
    correct: "✓ Correct:",
    wrong: "✗ Wrong:",
    skipped: "? Skipped:",
    timedOut: "Time is up (60 minutes) — the exam was submitted automatically.",
    timeSpent: (min, sec) => `Time spent: ${min} min ${sec} sec out of 60.`,
    skippedAnswer: "Skipped",
    wrongAnswer: "Wrong answer",
    reviewLabel: "Explanation:",
    backToMenu: "Back to menu",
  },
};

function tExam(key) {
  return (EXAM_I18N[examLang] || EXAM_I18N.ru)[key];
}

let examState = {
  questions: [],
  currentIndex: 0,
  answers: [], // { id, question, options, correct_index, chosenLocalIndex, correctLocalIndex, correct, skipped, explanation }
  currentShuffledOptions: [],
  secondsLeft: EXAM_DURATION_SEC,
  timerHandle: null,
  finished: false,
};

const screens = {
  setup: document.getElementById("screen-setup"),
  mock: document.getElementById("screen-mock"),
  mockLoading: document.getElementById("screen-mock-loading"),
  mockResult: document.getElementById("screen-mock-result"),
  linux: document.getElementById("screen-linux"),
  linuxLoading: document.getElementById("screen-linux-loading"),
  linuxResult: document.getElementById("screen-linux-result"),
  tfQuiz: document.getElementById("screen-tf-quiz"),
  tfQuizResult: document.getElementById("screen-tf-quiz-result"),
  examIntro: document.getElementById("screen-exam-intro"),
  exam: document.getElementById("screen-exam"),
  examResult: document.getElementById("screen-exam-result"),
  pdp: document.getElementById("screen-pdp"),
};

let currentScreen = "setup";

// =====================================================================
// Навигация между экранами + поддержка кнопок "Назад/Вперёд" браузера
// через History API (SPA без перезагрузки страницы).
// =====================================================================
function showScreen(name, opts = {}) {
  const { push = true } = opts;
  Object.values(screens).forEach((el) => el.classList.remove("active"));
  screens[name].classList.add("active");
  currentScreen = name;
  if (push) {
    history.pushState({ screen: name }, "", `#${name}`);
  }
}

// Экраны, в которые безопасно возвращаться браузерными кнопками
// назад/вперёд без потери состояния квиза (loading/result зависят
// от завершённого запроса и на них при popstate откатываем в setup).
const RESTORABLE_SCREENS = new Set(["setup", "mock", "linux", "tfQuiz", "examIntro", "pdp"]);

window.addEventListener("popstate", (e) => {
  const target = e.state && e.state.screen;
  if (currentScreen === "exam" && target !== "exam") {
    // Уход со страницы экзамена кнопкой "назад" браузера — останавливаем
    // таймер, чтобы он не продолжал тикать в фоне после ухода с экрана.
    stopExamTimer();
  }
  if (target && RESTORABLE_SCREENS.has(target) && screens[target]) {
    if (target === "mock" && mockState.questions.length === 0) {
      showScreen("setup", { push: false });
    } else if (target === "linux" && linuxState.questions.length === 0) {
      showScreen("setup", { push: false });
    } else if (target === "tfQuiz" && tfQuizState.questions.length === 0) {
      showScreen("setup", { push: false });
    } else {
      Object.values(screens).forEach((el) => el.classList.remove("active"));
      screens[target].classList.add("active");
      currentScreen = target;
      if (target === "setup") refreshSetupScreen();
      if (target === "pdp") renderPdp();
    }
  } else {
    Object.values(screens).forEach((el) => el.classList.remove("active"));
    screens.setup.classList.add("active");
    currentScreen = "setup";
    refreshSetupScreen();
  }
});

// =====================================================================
// LocalStorage: история результатов раундов (Мок-интервью / Linux)
// =====================================================================
const LS_HISTORY = "quiz_history";

function saveHistory(pct, topic, label) {
  const history = JSON.parse(localStorage.getItem(LS_HISTORY) || "[]");
  history.push({
    date: new Date().toLocaleDateString("ru-RU"),
    pct: pct !== null && pct !== undefined ? pct : null,
    topic,
    label,
  });
  localStorage.setItem(LS_HISTORY, JSON.stringify(history));
}

function renderHistory() {
  const list = document.getElementById("history-list");
  const block = document.getElementById("history-block");
  const history = JSON.parse(localStorage.getItem(LS_HISTORY) || "[]");
  list.innerHTML = "";
  if (history.length === 0) {
    block.style.display = "none";
    return;
  }
  block.style.display = "block";
  history
    .slice(-8)
    .reverse()
    .forEach((entry) => {
      const li = document.createElement("li");
      const topicLabel = entry.topic ? entry.topic : "Все темы";
      const pctLabel = entry.pct !== null && entry.pct !== undefined ? `${entry.pct}%` : "н/д";
      li.innerHTML = `<span>${entry.date} · ${entry.label || ""} · ${topicLabel}</span><span>${pctLabel}</span>`;
      list.appendChild(li);
    });
}

function refreshSetupScreen() {
  renderHistory();
}

// =====================================================================
// Setup screen: список тем (используется для Мок-интервью)
// =====================================================================
async function loadTopics() {
  const res = await fetch("/api/topics");
  const data = await res.json();
  const select = document.getElementById("topic-select");
  data.topics.forEach((topic) => {
    const opt = document.createElement("option");
    opt.value = topic;
    opt.textContent = `${topic} (${data.counts[topic]})`;
    select.appendChild(opt);
  });
}

// Подразделы Linux Troubleshooting (systemd, сеть, диск/память/CPU,
// общие кейсы) — соответствуют пунктам PDP-блока "Linux / Troubleshooting",
// чтобы можно было целенаправленно закрепить конкретный пункт плана,
// а не гонять все 29 кейсов вперемешку.
async function loadLinuxSubtopics() {
  const res = await fetch("/api/linux-trainer/subtopics");
  const data = await res.json();
  const select = document.getElementById("linux-subtopic-select");
  data.subtopics.forEach((st) => {
    const opt = document.createElement("option");
    opt.value = st.id;
    opt.textContent = `${st.label} (${st.count})`;
    select.appendChild(opt);
  });
}

// =====================================================================
// Мок-интервью: сценарные вопросы со свободным ответом + AI-ревью
// (score/feedback от бэкенда через Gemini, см. app/ai_review.py).
// =====================================================================
const MOCK_INTERVIEW_COUNT = 5;

async function startMockInterview() {
  const topic = document.getElementById("topic-select").value;
  const includeSenior = document.getElementById("mock-include-senior").checked;
  const params = new URLSearchParams({
    count: MOCK_INTERVIEW_COUNT,
    level: includeSenior ? "all" : "junior_middle",
  });
  if (topic) params.set("topic", topic);

  const res = await fetch(`/api/mock-interview/start?${params.toString()}`);
  const data = await res.json();

  if (data.count === 0) {
    alert("Нет сценарных вопросов для выбранной темы.");
    return;
  }

  mockState.questions = data.questions;
  mockState.index = 0;
  mockState.answers = new Array(data.questions.length).fill("");

  showScreen("mock");
  renderMockQuestion();
}

function renderMockQuestion() {
  const q = mockState.questions[mockState.index];
  const total = mockState.questions.length;

  document.getElementById("mock-progress-text").textContent =
    `Вопрос ${mockState.index + 1} / ${total}`;
  document.getElementById("mock-progress-topic").textContent =
    `${q.topic}${q.difficulty ? " · " + q.difficulty : ""}`;
  document.getElementById("mock-progress-fill").style.width = `${(mockState.index / total) * 100}%`;
  renderQuestionHtml(document.getElementById("mock-question-text"), q.question);
  document.getElementById("mock-answer-input").value = mockState.answers[mockState.index] || "";

  const isLast = mockState.index + 1 >= total;
  document.getElementById("btn-mock-next").textContent = isLast
    ? "Завершить и получить AI-оценку →"
    : "Следующий вопрос →";
  document.getElementById("btn-mock-prev").disabled = mockState.index === 0;
}

function mockPrev() {
  if (mockState.index === 0) return;
  mockState.answers[mockState.index] = document.getElementById("mock-answer-input").value.trim();
  mockState.index--;
  renderMockQuestion();
}

async function mockNext() {
  mockState.answers[mockState.index] = document.getElementById("mock-answer-input").value.trim();

  const isLast = mockState.index + 1 >= mockState.questions.length;
  if (!isLast) {
    mockState.index++;
    renderMockQuestion();
    return;
  }

  const answers = mockState.questions.map((q, i) => ({ id: q.id, user_answer: mockState.answers[i] }));

  showScreen("mockLoading");
  try {
    const res = await fetch("/api/mock-interview/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderReviewResult(data, {
      questions: mockState.questions,
      pctEl: "mock-result-pct",
      feedbackEl: "mock-overall-feedback",
      itemsEl: "mock-result-items",
      screen: "mockResult",
      historyLabel: "Мок-интервью",
      historyTopic: document.getElementById("topic-select").value,
    });
  } catch (e) {
    renderReviewResult(
      {
        items: answers.map((a) => ({ id: a.id, score: null, feedback: "", reference_answer: null })),
        overall_percent: null,
        overall_feedback: `Не удалось получить AI-оценку: ${e.message}`,
      },
      {
        questions: mockState.questions,
        pctEl: "mock-result-pct",
        feedbackEl: "mock-overall-feedback",
        itemsEl: "mock-result-items",
        screen: "mockResult",
        historyLabel: "Мок-интервью",
        historyTopic: document.getElementById("topic-select").value,
      }
    );
  }
}

function backFromMockInterview() {
  refreshSetupScreen();
  showScreen("setup");
}

// =====================================================================
// Linux Troubleshooting: диагностические кейсы со свободным ответом,
// AI оценивает МЕТОДОЛОГИЮ расследования (см. review_linux_round в
// app/ai_review.py), а не только фактический вывод.
// =====================================================================
const LINUX_TRAINER_COUNT = 5;

async function startLinuxTrainer() {
  const difficulty = document.getElementById("linux-difficulty-select").value;
  const subtopic = document.getElementById("linux-subtopic-select").value;
  const params = new URLSearchParams({ count: LINUX_TRAINER_COUNT });
  if (difficulty) params.set("difficulty", difficulty);
  if (subtopic) params.set("subtopic", subtopic);

  const res = await fetch(`/api/linux-trainer/start?${params.toString()}`);
  const data = await res.json();

  if (data.count === 0) {
    alert("Нет Linux-кейсов для выбранной сложности/подраздела.");
    return;
  }

  linuxState.questions = data.questions;
  linuxState.index = 0;
  linuxState.answers = new Array(data.questions.length).fill("");

  showScreen("linux");
  renderLinuxQuestion();
}

const LINUX_SUBTOPIC_LABELS = {
  systemd: "systemd, journald",
  perf: "Диск / память / CPU",
  network: "Сеть",
  general: "Общие кейсы",
};

function renderLinuxQuestion() {
  const q = linuxState.questions[linuxState.index];
  const total = linuxState.questions.length;

  document.getElementById("linux-progress-text").textContent =
    `Вопрос ${linuxState.index + 1} / ${total}`;
  const subtopicLabel = LINUX_SUBTOPIC_LABELS[q.subtopic] || q.subtopic || "";
  document.getElementById("linux-progress-topic").textContent =
    `${subtopicLabel}${q.difficulty ? " · " + q.difficulty : ""}`;
  document.getElementById("linux-progress-fill").style.width = `${(linuxState.index / total) * 100}%`;
  renderQuestionHtml(document.getElementById("linux-question-text"), q.question);
  document.getElementById("linux-answer-input").value = linuxState.answers[linuxState.index] || "";

  const isLast = linuxState.index + 1 >= total;
  document.getElementById("btn-linux-next").textContent = isLast
    ? "Завершить и получить AI-оценку →"
    : "Следующий вопрос →";
  document.getElementById("btn-linux-prev").disabled = linuxState.index === 0;
}

function linuxPrev() {
  if (linuxState.index === 0) return;
  linuxState.answers[linuxState.index] = document.getElementById("linux-answer-input").value.trim();
  linuxState.index--;
  renderLinuxQuestion();
}

async function linuxNext() {
  linuxState.answers[linuxState.index] = document.getElementById("linux-answer-input").value.trim();

  const isLast = linuxState.index + 1 >= linuxState.questions.length;
  if (!isLast) {
    linuxState.index++;
    renderLinuxQuestion();
    return;
  }

  const answers = linuxState.questions.map((q, i) => ({ id: q.id, user_answer: linuxState.answers[i] }));

  showScreen("linuxLoading");
  try {
    const res = await fetch("/api/linux-trainer/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderReviewResult(data, {
      questions: linuxState.questions,
      pctEl: "linux-result-pct",
      feedbackEl: "linux-overall-feedback",
      itemsEl: "linux-result-items",
      screen: "linuxResult",
      historyLabel: "Linux Troubleshooting",
      historyTopic: "",
    });
  } catch (e) {
    renderReviewResult(
      {
        items: answers.map((a) => ({ id: a.id, score: null, feedback: "", reference_answer: null })),
        overall_percent: null,
        overall_feedback: `Не удалось получить AI-оценку: ${e.message}`,
      },
      {
        questions: linuxState.questions,
        pctEl: "linux-result-pct",
        feedbackEl: "linux-overall-feedback",
        itemsEl: "linux-result-items",
        screen: "linuxResult",
        historyLabel: "Linux Troubleshooting",
        historyTopic: "",
      }
    );
  }
}

function backFromLinuxTrainer() {
  refreshSetupScreen();
  showScreen("setup");
}

// =====================================================================
// Terraform Quiz: MCQ-квиз для подготовки к экзамену Terraform Associate.
// Единственная тема с MCQ-режимом (см. /api/quiz/terraform). Логика
// шаффла вариантов, повтора ошибок сессии — как в прежнем прототипе.
// =====================================================================
function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Некоторые вопросы содержат код-сниппет (HCL/CLI output), обёрнутый в
// ```...``` (как в markdown) — рендерим его как <pre><code> с моноширинным
// шрифтом, остальной текст экранируем как обычный textContent, чтобы
// нельзя было случайно инжектнуть произвольный HTML через JSON-контент.
function renderQuestionHtml(container, text) {
  const parts = text.split(/```([\s\S]*?)```/g);
  container.innerHTML = "";
  parts.forEach((part, idx) => {
    if (idx % 2 === 1) {
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = part.replace(/^\n/, "").replace(/\n$/, "");
      pre.appendChild(code);
      container.appendChild(pre);
    } else if (part) {
      const span = document.createElement("span");
      span.textContent = part;
      container.appendChild(span);
    }
  });
}


// Размер пула Terraform MCQ (total + по сложности) — подтягивается с
// бэкенда через /api/quiz/terraform/meta, а не хардкодится в HTML, чтобы
// кнопка "Все" на экране настройки не расходилась с реальным пулом при
// добавлении следующего раунда контента (round5+).
let tfQuizMeta = { total: 0, counts: { easy: 0, hard: 0 } };

async function loadTfQuizMeta() {
  const res = await fetch("/api/quiz/terraform/meta");
  tfQuizMeta = await res.json();
  updateTfQuizAllButton();
}

// Обновляет подпись и data-count кнопки "Все" в зависимости от текущего
// выбора сложности — если выбран конкретный уровень (easy/hard), "Все"
// должно означать "все вопросы этого уровня", а не общий пул.
function updateTfQuizAllButton() {
  const btn = document.getElementById("tf-quiz-count-all");
  if (!btn) return;
  const difficulty = document.getElementById("tf-quiz-difficulty-select").value;
  const count = difficulty ? tfQuizMeta.counts[difficulty] || 0 : tfQuizMeta.total;
  btn.dataset.count = String(count || 1);
  btn.textContent = `Все (${count})`;
  if (btn.classList.contains("selected")) {
    tfQuizState.selectedCount = count;
  }
}

function setupTfQuizCountButtons() {
  const buttons = document.querySelectorAll("#tf-quiz-count-group .count-btn");
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      buttons.forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      tfQuizState.selectedCount = parseInt(btn.dataset.count, 10);
    });
  });
  document
    .getElementById("tf-quiz-difficulty-select")
    .addEventListener("change", updateTfQuizAllButton);
}

async function startTfQuiz() {
  tfQuizState.selectedDifficulty = document.getElementById("tf-quiz-difficulty-select").value;
  tfQuizState.isRetryRound = false;
  tfQuizState.retryQueue = [];
  tfQuizState.retryResults = { practiced: 0, nowCorrect: 0 };

  const params = new URLSearchParams({ count: tfQuizState.selectedCount });
  if (tfQuizState.selectedDifficulty) params.set("difficulty", tfQuizState.selectedDifficulty);

  const res = await fetch(`/api/quiz/terraform?${params.toString()}`);
  const data = await res.json();

  if (data.count === 0) {
    alert("Нет вопросов для выбранной сложности.");
    return;
  }

  tfQuizState.questions = data.questions;
  tfQuizState.currentIndex = 0;
  tfQuizState.answers = [];

  showScreen("tfQuiz");
  renderTfQuizQuestion();
}

function renderTfQuizQuestion() {
  const q = tfQuizState.questions[tfQuizState.currentIndex];
  const total = tfQuizState.questions.length;

  const modeLabel = tfQuizState.isRetryRound ? " · повтор ошибок сессии" : "";

  document.getElementById("tf-quiz-progress-text").textContent =
    `Вопрос ${tfQuizState.currentIndex + 1} / ${total}${modeLabel}`;
  document.getElementById("tf-quiz-progress-topic").textContent =
    q.difficulty === "hard" ? "Terraform · hard" : "Terraform";
  document.getElementById("tf-quiz-progress-fill").style.width = `${(tfQuizState.currentIndex / total) * 100}%`;

  renderQuestionHtml(document.getElementById("tf-quiz-question-text"), q.question);

  // Shuffle options every time the question is rendered
  const shuffled = shuffleArray(
    q.options.map((text, originalIndex) => ({ text, originalIndex }))
  );
  tfQuizState.currentShuffledOptions = shuffled;

  const optionsList = document.getElementById("tf-quiz-options-list");
  optionsList.innerHTML = "";

  shuffled.forEach((opt, localIdx) => {
    const div = document.createElement("div");
    div.className = "option";
    renderQuestionHtml(div, opt.text);
    div.dataset.localIndex = localIdx;
    div.addEventListener("click", () => selectTfQuizAnswer(localIdx));
    optionsList.appendChild(div);
  });

  document.getElementById("tf-quiz-explanation-box").classList.add("hidden");
  document.getElementById("btn-tf-quiz-next").classList.add("hidden");
  document.getElementById("btn-tf-quiz-skip").classList.remove("hidden");
}

function highlightTfQuizOptions(correctLocalIndex, chosenLocalIndex) {
  const options = document.querySelectorAll("#tf-quiz-options-list .option");
  options.forEach((opt) => opt.classList.add("disabled"));
  options.forEach((opt) => {
    const idx = parseInt(opt.dataset.localIndex, 10);
    if (idx === correctLocalIndex) {
      opt.classList.add("correct");
    } else if (idx === chosenLocalIndex && chosenLocalIndex !== correctLocalIndex) {
      opt.classList.add("wrong");
    }
  });
}

function findTfQuizCorrectLocalIndex(q) {
  return tfQuizState.currentShuffledOptions.findIndex((opt) => opt.originalIndex === q.correct_index);
}

function selectTfQuizAnswer(chosenLocalIndex) {
  const q = tfQuizState.questions[tfQuizState.currentIndex];
  document.getElementById("btn-tf-quiz-skip").classList.add("hidden");

  const correctLocalIndex = findTfQuizCorrectLocalIndex(q);
  const isCorrect = chosenLocalIndex === correctLocalIndex;

  highlightTfQuizOptions(correctLocalIndex, chosenLocalIndex);
  registerTfQuizAnswer(q, isCorrect, false);
  showTfQuizExplanationAndNextButton(q);
}

function skipTfQuizAnswer() {
  const q = tfQuizState.questions[tfQuizState.currentIndex];
  document.getElementById("btn-tf-quiz-skip").classList.add("hidden");

  const correctLocalIndex = findTfQuizCorrectLocalIndex(q);
  highlightTfQuizOptions(correctLocalIndex, -1);
  registerTfQuizAnswer(q, false, true);
  showTfQuizExplanationAndNextButton(q);
}

function registerTfQuizAnswer(q, isCorrect, skipped) {
  if (tfQuizState.isRetryRound) {
    tfQuizState.retryResults.practiced++;
    if (isCorrect) tfQuizState.retryResults.nowCorrect++;
    return; // retry round doesn't affect first-pass score
  }

  tfQuizState.answers.push({
    id: q.id,
    correct: isCorrect,
    skipped: skipped,
  });

  if (!isCorrect) {
    tfQuizState.retryQueue.push(q);
  }
}

function showTfQuizExplanationAndNextButton(q) {
  const explBox = document.getElementById("tf-quiz-explanation-box");
  document.getElementById("tf-quiz-explanation-text").textContent = q.explanation;
  explBox.classList.remove("hidden");

  const isLast = tfQuizState.currentIndex + 1 >= tfQuizState.questions.length;
  const nextBtn = document.getElementById("btn-tf-quiz-next");
  nextBtn.classList.remove("hidden");

  if (!isLast) {
    nextBtn.textContent = "Следующий вопрос →";
  } else if (!tfQuizState.isRetryRound && tfQuizState.retryQueue.length > 0) {
    nextBtn.textContent = `Повторить ${tfQuizState.retryQueue.length} ошибок этой сессии →`;
  } else {
    nextBtn.textContent = "Показать результат →";
  }
}

function nextTfQuizQuestion() {
  const isLast = tfQuizState.currentIndex + 1 >= tfQuizState.questions.length;

  if (!isLast) {
    tfQuizState.currentIndex++;
    renderTfQuizQuestion();
    return;
  }

  if (!tfQuizState.isRetryRound && tfQuizState.retryQueue.length > 0) {
    tfQuizState.isRetryRound = true;
    tfQuizState.questions = shuffleArray(tfQuizState.retryQueue);
    tfQuizState.currentIndex = 0;
    renderTfQuizQuestion();
    return;
  }

  finishTfQuiz();
}

function finishTfQuiz() {
  const total = tfQuizState.answers.length;
  const score = tfQuizState.answers.filter((a) => a.correct).length;
  const skippedCount = tfQuizState.answers.filter((a) => a.skipped).length;
  const wrongCount = total - score - skippedCount;
  const pct = total > 0 ? Math.round((score / total) * 100) : 0;

  document.getElementById("tf-quiz-result-score-value").textContent = `${score} / ${total}`;
  document.getElementById("tf-quiz-result-score-pct").textContent = `${pct}%`;
  document.getElementById("tf-quiz-result-correct-count").textContent = score;
  document.getElementById("tf-quiz-result-wrong-count").textContent = wrongCount;
  document.getElementById("tf-quiz-result-skipped-count").textContent = skippedCount;

  const retryInfo = document.getElementById("tf-quiz-result-retry-info");
  if (tfQuizState.retryResults.practiced > 0) {
    retryInfo.textContent = `Повторили ${tfQuizState.retryResults.practiced} ошибок этой сессии, из них теперь усвоено: ${tfQuizState.retryResults.nowCorrect}.`;
    retryInfo.classList.remove("hidden");
  } else {
    retryInfo.classList.add("hidden");
  }

  saveHistory(pct, "Terraform", "Terraform Quiz");
  showScreen("tfQuizResult");
}

function backFromTfQuiz() {
  refreshSetupScreen();
  showScreen("setup");
}

// =====================================================================
// Экзамен Terraform Associate — полная симуляция реального экзамена:
// 65 вопросов (весь пул), таймер 60 минут с автосдачей, порог 70%,
// без подсказок/объяснений во время прохождения и без возврата к
// предыдущим вопросам (как на настоящем MCQ-экзамене). Разбор ошибок
// (correct answer + explanation) показывается только на финальном экране.
// =====================================================================
function openExamIntro() {
  showScreen("examIntro");
}

function cancelExamIntro() {
  refreshSetupScreen();
  showScreen("setup");
}

async function startExam() {
  const lang = document.getElementById("exam-lang-select")?.value || "ru";
  examLang = lang === "en" ? "en" : "ru";
  const res = await fetch(`/api/quiz/terraform?count=65&lang=${encodeURIComponent(lang)}`);
  const data = await res.json();

  if (data.count === 0) {
    alert(examLang === "en" ? "Failed to load exam questions." : "Не удалось загрузить вопросы для экзамена.");
    return;
  }

  examState.questions = shuffleArray(data.questions);
  examState.currentIndex = 0;
  examState.answers = [];
  examState.secondsLeft = EXAM_DURATION_SEC;
  examState.finished = false;

  showScreen("exam");
  renderExamQuestion();
  startExamTimer();
}

function startExamTimer() {
  stopExamTimer();
  updateExamTimerDisplay();
  examState.timerHandle = setInterval(() => {
    examState.secondsLeft--;
    updateExamTimerDisplay();
    if (examState.secondsLeft <= 0) {
      finishExam({ timedOut: true });
    }
  }, 1000);
}

function stopExamTimer() {
  if (examState.timerHandle) {
    clearInterval(examState.timerHandle);
    examState.timerHandle = null;
  }
}

function updateExamTimerDisplay() {
  const el = document.getElementById("exam-timer");
  const total = Math.max(0, examState.secondsLeft);
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  el.textContent = `${mm}:${ss}`;
  el.classList.toggle("badge-timer-warning", total <= 5 * 60);
}

function renderExamQuestion() {
  const q = examState.questions[examState.currentIndex];
  const total = examState.questions.length;

  document.getElementById("exam-progress-text").textContent =
    tExam("question")(examState.currentIndex + 1, total);
  document.getElementById("exam-progress-fill").style.width = `${(examState.currentIndex / total) * 100}%`;

  renderQuestionHtml(document.getElementById("exam-question-text"), q.question);

  const shuffled = shuffleArray(
    q.options.map((text, originalIndex) => ({ text, originalIndex }))
  );
  examState.currentShuffledOptions = shuffled;

  const optionsList = document.getElementById("exam-options-list");
  optionsList.innerHTML = "";

  shuffled.forEach((opt, localIdx) => {
    const div = document.createElement("div");
    div.className = "option";
    renderQuestionHtml(div, opt.text);
    div.dataset.localIndex = localIdx;
    div.addEventListener("click", () => selectExamAnswer(localIdx));
    optionsList.appendChild(div);
  });

  document.getElementById("btn-exam-skip").textContent = tExam("skip");
  document.getElementById("btn-exam-skip").classList.remove("hidden");
}

function findExamCorrectLocalIndex(q) {
  return examState.currentShuffledOptions.findIndex((opt) => opt.originalIndex === q.correct_index);
}

function selectExamAnswer(chosenLocalIndex) {
  const q = examState.questions[examState.currentIndex];
  const correctLocalIndex = findExamCorrectLocalIndex(q);
  const isCorrect = chosenLocalIndex === correctLocalIndex;
  registerExamAnswer(q, isCorrect, false);
  advanceExam();
}

function skipExamAnswer() {
  const q = examState.questions[examState.currentIndex];
  registerExamAnswer(q, false, true);
  advanceExam();
}

function registerExamAnswer(q, isCorrect, skipped) {
  examState.answers.push({
    id: q.id,
    question: q.question,
    correct: isCorrect,
    skipped: skipped,
    explanation: q.explanation,
  });
}

function advanceExam() {
  const isLast = examState.currentIndex + 1 >= examState.questions.length;
  if (isLast) {
    finishExam({ timedOut: false });
    return;
  }
  examState.currentIndex++;
  renderExamQuestion();
}

function finishExam({ timedOut }) {
  if (examState.finished) return;
  examState.finished = true;
  stopExamTimer();

  // При автосдаче по таймауту оставшиеся неотвеченные вопросы
  // засчитываются как "не знал" — как и было бы на реальном экзамене,
  // где время просто заканчивается.
  if (timedOut) {
    for (let i = examState.answers.length; i < examState.questions.length; i++) {
      const q = examState.questions[i];
      examState.answers.push({
        id: q.id,
        question: q.question,
        correct: false,
        skipped: true,
        explanation: q.explanation,
      });
    }
  }

  const total = examState.answers.length;
  const score = examState.answers.filter((a) => a.correct).length;
  const skippedCount = examState.answers.filter((a) => a.skipped).length;
  const wrongCount = total - score - skippedCount;
  const pct = total > 0 ? Math.round((score / total) * 100) : 0;
  const passed = pct >= EXAM_PASS_THRESHOLD_PCT;

  document.getElementById("exam-result-score-value").textContent = `${score} / ${total}`;
  document.getElementById("exam-result-score-pct").textContent = `${pct}%`;
  document.getElementById("exam-result-correct-count").textContent = score;
  document.getElementById("exam-result-wrong-count").textContent = wrongCount;
  document.getElementById("exam-result-skipped-count").textContent = skippedCount;

  document.getElementById("exam-result-title").textContent = tExam("resultTitle");
  document.getElementById("exam-result-label-correct").textContent = tExam("correct");
  document.getElementById("exam-result-label-wrong").textContent = tExam("wrong");
  document.getElementById("exam-result-label-skipped").textContent = tExam("skipped");
  document.getElementById("btn-exam-restart").textContent = tExam("backToMenu");

  const verdictEl = document.getElementById("exam-result-verdict");
  const verdictTextEl = document.getElementById("exam-result-verdict-text");
  verdictEl.classList.remove("exam-verdict-pass", "exam-verdict-fail");
  if (passed) {
    verdictEl.classList.add("exam-verdict-pass");
    verdictTextEl.textContent = tExam("passed")(EXAM_PASS_THRESHOLD_PCT);
  } else {
    verdictEl.classList.add("exam-verdict-fail");
    verdictTextEl.textContent = tExam("failed")(EXAM_PASS_THRESHOLD_PCT);
  }

  const timeInfoEl = document.getElementById("exam-result-time-info");
  const elapsedSec = EXAM_DURATION_SEC - Math.max(0, examState.secondsLeft);
  const elapsedMin = Math.floor(elapsedSec / 60);
  const elapsedRestSec = elapsedSec % 60;
  timeInfoEl.textContent = timedOut
    ? tExam("timedOut")
    : tExam("timeSpent")(elapsedMin, elapsedRestSec);

  // Разбор ошибок и пропущенных вопросов — показывается только теперь,
  // на финальном экране, как единственная точка обратной связи в
  // экзаменационном режиме.
  const reviewEl = document.getElementById("exam-result-review");
  reviewEl.innerHTML = "";
  const toReview = examState.answers.filter((a) => !a.correct);
  toReview.forEach((a) => {
    const row = document.createElement("div");
    row.className = "mock-result-row";
    row.innerHTML = `
      <div class="mock-result-question">${a.question}</div>
      <div class="mock-result-score">${a.skipped ? tExam("skippedAnswer") : tExam("wrongAnswer")}</div>
      <div class="mock-result-reference">
        <div class="mock-result-reference-label">${tExam("reviewLabel")}</div>
        <div class="mock-result-reference-text">${a.explanation || ""}</div>
      </div>
    `;
    reviewEl.appendChild(row);
  });

  saveHistory(pct, "Terraform", passed ? "Экзамен (сдано)" : "Экзамен (не сдано)");
  showScreen("examResult");
}

function backFromExam() {
  refreshSetupScreen();
  showScreen("setup");
}

// Предупреждаем о потере прогресса при закрытии/обновлении страницы
// во время активного экзамена (таймер запущен и экзамен не завершён).
window.addEventListener("beforeunload", (e) => {
  if (examState.timerHandle && !examState.finished) {
    e.preventDefault();
    e.returnValue = "";
  }
});

// =====================================================================
// Общий рендер результата AI-ревью (Мок-интервью / Linux Troubleshooting).
// ВСЕГДА показывает reference_answer (подробный эталонный ответ/разбор
// методологии) независимо от score — кандидат должен видеть, как надо
// было отвечать, даже если ответил неверно, а не только короткий фидбек.
// =====================================================================
function renderReviewResult(data, cfg) {
  const pctEl = document.getElementById(cfg.pctEl);
  pctEl.textContent = data.overall_percent !== null && data.overall_percent !== undefined
    ? `${data.overall_percent}%`
    : "Оценка недоступна";

  document.getElementById(cfg.feedbackEl).textContent = data.overall_feedback || "";

  const container = document.getElementById(cfg.itemsEl);
  container.innerHTML = "";
  data.items.forEach((item) => {
    const q = cfg.questions.find((mq) => mq.id === item.id);
    const row = document.createElement("div");
    row.className = "mock-result-row";
    const scoreLabel = item.score !== null && item.score !== undefined ? `${item.score}/100` : "н/д";
    const referenceBlock = item.reference_answer
      ? `<div class="mock-result-reference">
           <div class="mock-result-reference-label">Эталонный ответ / разбор:</div>
           <div class="mock-result-reference-text">${item.reference_answer}</div>
         </div>`
      : "";
    row.innerHTML = `
      <div class="mock-result-question">${q ? q.question : item.id}</div>
      <div class="mock-result-score">Оценка: <b>${scoreLabel}</b></div>
      <div class="mock-result-feedback">${item.feedback || ""}</div>
      ${referenceBlock}
    `;
    container.appendChild(row);
  });

  saveHistory(data.overall_percent, cfg.historyTopic, cfg.historyLabel);
  showScreen(cfg.screen);
}

// =====================================================================
// PDP (Personal Development Plan) — цель Senior Systems Engineer (L3).
// Составлен по фидбеку коллеги после мок-интервью. Прогресс (чекбоксы)
// хранится в localStorage, чтобы можно было отмечать выполнение задач
// прямо в трейнере, без внешних инструментов.
// =====================================================================
const LS_PDP_PROGRESS = "pdp_progress"; // { [taskId]: true }

const PDP_PLAN = [
  {
    id: "linux",
    title: "Linux / Troubleshooting",
    priority: "high",
    note: "Рекомендация коллеги. Приоритет №1 — база для всех остальных направлений.",
    tasks: [
      { id: "linux-systemd", text: "systemd, journald — управление и диагностика сервисов" },
      { id: "linux-network", text: "Сетевой troubleshooting: tcpdump, ss/netstat, DNS-диагностика" },
      { id: "linux-perf", text: "Диагностика диска/памяти/CPU: iostat, vmstat, top/htop, strace" },
      { id: "linux-cases", text: "Разобрать 5+ типичных кейсов troubleshooting для Senior Systems Engineer" },
    ],
  },
  {
    id: "english",
    title: "English → B2",
    priority: "high",
    note: "Идёт параллельно с техподготовкой. Фокус на техническом английском для интервью.",
    tasks: [
      { id: "eng-mock", text: "Пройти mock-интервью на английском (technical + behavioral)" },
      { id: "eng-explain", text: "Практика объяснения архитектуры/кода на английском" },
      { id: "eng-b2", text: "Общая грамматика/разговорная практика до уровня B2" },
    ],
  },
  {
    id: "terraform",
    title: "Terraform",
    priority: "high",
    note: "Terraform Associate — экзамен на MCQ (1 час, без бесплатного retake), не hands-on lab как CKA. Полностью бесплатный путь реалистичен: сам Terraform — open source, официальные HashiCorp-тьюториалы бесплатны, практика — на реальной инфраструктуре в AWS Free Tier. Платный practice-экзамен (Tutorials Dojo и т.п.) — недорогая финальная проверка готовности непосредственно перед покупкой самого экзамена, не первый шаг.",
    tasks: [
      { id: "tf-modules", text: "Modules: структура, переиспользование, versioning" },
      { id: "tf-state", text: "Remote state, workspaces, state locking" },
      { id: "tf-sensitive", text: "Sensitive variables, secrets management" },
      { id: "tf-hashicorp-tutorials", text: "HashiCorp Learn тьюториалы (бесплатно) — official exam objectives 004" },
      { id: "tf-free-tier-practice", text: "Практика на реальной инфраструктуре в AWS Free Tier: свои modules/state/workspaces, а не только теория" },
      { id: "tf-practice-exam", text: "Практический экзамен (Tutorials Dojo/аналог, недорого) — проверка готовности перед покупкой самого экзамена" },
      { id: "tf-cert", text: "Сдать сертификацию Terraform Associate" },
    ],
  },
  {
    id: "aws",
    title: "AWS Deep Dive + Solutions Architect Associate",
    priority: "medium",
    note: "AWS SAA — экзамен на MCQ/multiple-response (130 минут, 65 вопросов), не hands-on lab. Реалистичный бесплатный путь: AWS Free Tier (настоящие сервисы, руками, а не симуляция) + AWS Skill Builder бесплатный 4-step exam prep plan + официальный exam guide. Платный practice-экзамен (Tutorials Dojo/AWS Official Practice Exam) — недорогая финальная проверка готовности перед покупкой самого экзамена, не первый шаг.",
    tasks: [
      { id: "aws-vpc", text: "VPC: peering, transit gateway, routing" },
      { id: "aws-iam", text: "IAM: policies, roles, trust relationships" },
      { id: "aws-lb", text: "Load Balancers: ALB vs NLB internals" },
      { id: "aws-r53", text: "Route53, ACM, DynamoDB — глубже базового уровня" },
      { id: "aws-free-tier", text: "AWS Free Tier: реальный аккаунт — руками поднять VPC/ALB/IAM/Route53, а не только читать документацию" },
      { id: "aws-skillbuilder", text: "AWS Skill Builder: бесплатный 4-step exam prep plan + официальный exam guide" },
      { id: "aws-practice-exam", text: "Практический экзамен (Tutorials Dojo/AWS Official Practice Exam) — проверка готовности перед покупкой самого экзамена" },
      { id: "aws-cert", text: "Сдать AWS Solutions Architect Associate" },
    ],
  },
  {
    id: "k8s",
    title: "Kubernetes",
    priority: "low",
    note: "CKA — hands-on lab-экзамен (не тесты), без практики почти нереально сдать. Бесплатный путь покрывает ~80% пользы: Killercoda + свой kind/minikube кластер, который специально ломаешь и чинишь. Платный курс (KodeKloud CKA) — не как первый шаг, а непосредственно перед экзаменом для systematic coverage всего syllabus'а.",
    tasks: [
      { id: "k8s-book", text: "\"Kubernetes in Action\" — последнее издание, в оригинале (EN)" },
      { id: "k8s-killercoda", text: "Killercoda: бесплатные live-кластеры — RBAC, NetworkPolicy, etcd backup/restore, troubleshooting node" },
      { id: "k8s-kind-break", text: "Свой kind/minikube кластер: специально ломать и чинить (убить kubelet, испортить kubeconfig, забить диск ноды)" },
      { id: "k8s-killer-sh", text: "killer.sh симулятор (идёт с ваучером на экзамен) — прогнать перед покупкой самого CKA" },
      { id: "k8s-kodekloud", text: "KodeKloud CKA-курс (платно) — непосредственно перед экзаменом, для полного покрытия syllabus'а" },
      { id: "k8s-cka", text: "Сдать CKA сертификацию" },
    ],
  },
  {
    id: "ai-tools",
    title: "AI-инструменты",
    priority: "low",
    note: "Углубить понимание конфигурации, не только использование.",
    tasks: [
      { id: "ai-config", text: "Настроить и объяснить конфигурацию Copilot/Agent.MD для команды" },
      { id: "ai-cert", text: "AI-сертификация (по плану)" },
    ],
  },
];

function loadPdpProgress() {
  return JSON.parse(localStorage.getItem(LS_PDP_PROGRESS) || "{}");
}

function savePdpProgress(progress) {
  localStorage.setItem(LS_PDP_PROGRESS, JSON.stringify(progress));
}

function togglePdpTask(taskId, checked) {
  const progress = loadPdpProgress();
  progress[taskId] = checked;
  savePdpProgress(progress);
  renderPdp();
}

function renderPdp() {
  const progress = loadPdpProgress();
  const container = document.getElementById("pdp-groups");
  container.innerHTML = "";

  let totalTasks = 0;
  let doneTasks = 0;

  PDP_PLAN.forEach((group) => {
    const groupDone = group.tasks.filter((t) => progress[t.id]).length;
    totalTasks += group.tasks.length;
    doneTasks += groupDone;
    const groupPct = Math.round((groupDone / group.tasks.length) * 100);

    const groupEl = document.createElement("div");
    groupEl.className = "pdp-group";
    groupEl.innerHTML = `
      <div class="pdp-group-header">
        <span class="pdp-group-title">${group.title}</span>
        <span class="pdp-priority pdp-priority-${group.priority}">${
          group.priority === "high" ? "приоритет: сейчас" : group.priority === "medium" ? "приоритет: далее" : "приоритет: backlog"
        }</span>
      </div>
      <p class="pdp-group-note">${group.note}</p>
      <div class="pdp-group-bar-bg"><div class="pdp-group-bar-fill" style="width:${groupPct}%"></div></div>
      <span class="pdp-group-pct">${groupDone} / ${group.tasks.length} (${groupPct}%)</span>
    `;

    const tasksEl = document.createElement("div");
    tasksEl.className = "pdp-tasks";
    group.tasks.forEach((task) => {
      const label = document.createElement("label");
      label.className = "pdp-task-row";
      const checked = !!progress[task.id];
      label.innerHTML = `
        <input type="checkbox" data-task-id="${task.id}" ${checked ? "checked" : ""}>
        <span class="${checked ? "pdp-task-done" : ""}">${task.text}</span>
      `;
      const checkbox = label.querySelector("input");
      checkbox.addEventListener("change", (e) => togglePdpTask(task.id, e.target.checked));
      tasksEl.appendChild(label);
    });

    groupEl.appendChild(tasksEl);
    container.appendChild(groupEl);
  });

  const overallPct = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;
  document.getElementById("pdp-overall-fill").style.width = `${overallPct}%`;
  document.getElementById("pdp-overall-text").textContent =
    `${doneTasks} / ${totalTasks} выполнено (${overallPct}%)`;
}

function openPdp() {
  renderPdp();
  showScreen("pdp");
}

function backFromPdp() {
  refreshSetupScreen();
  showScreen("setup");
}

// =====================================================================
// Init
// =====================================================================
document.addEventListener("DOMContentLoaded", () => {
  loadTopics();
  loadLinuxSubtopics();
  loadTfQuizMeta();
  setupTfQuizCountButtons();
  refreshSetupScreen();
  history.replaceState({ screen: "setup" }, "", "#setup");

  document.getElementById("btn-mock-interview").addEventListener("click", startMockInterview);
  document.getElementById("btn-mock-prev").addEventListener("click", mockPrev);
  document.getElementById("btn-mock-next").addEventListener("click", mockNext);
  document.getElementById("btn-mock-restart").addEventListener("click", backFromMockInterview);

  document.getElementById("btn-linux-trainer").addEventListener("click", startLinuxTrainer);
  document.getElementById("btn-linux-prev").addEventListener("click", linuxPrev);
  document.getElementById("btn-linux-next").addEventListener("click", linuxNext);
  document.getElementById("btn-linux-restart").addEventListener("click", backFromLinuxTrainer);

  document.getElementById("btn-tf-quiz").addEventListener("click", startTfQuiz);
  document.getElementById("btn-tf-quiz-next").addEventListener("click", nextTfQuizQuestion);
  document.getElementById("btn-tf-quiz-skip").addEventListener("click", skipTfQuizAnswer);
  document.getElementById("btn-tf-quiz-restart").addEventListener("click", backFromTfQuiz);

  document.getElementById("btn-tf-exam").addEventListener("click", openExamIntro);
  document.getElementById("btn-exam-start-confirm").addEventListener("click", startExam);
  document.getElementById("btn-exam-cancel").addEventListener("click", cancelExamIntro);
  document.getElementById("btn-exam-skip").addEventListener("click", skipExamAnswer);
  document.getElementById("btn-exam-restart").addEventListener("click", backFromExam);

  document.getElementById("btn-pdp").addEventListener("click", openPdp);
  document.getElementById("btn-pdp-back").addEventListener("click", backFromPdp);
});
