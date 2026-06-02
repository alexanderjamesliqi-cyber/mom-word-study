const STORAGE_KEY = "momWordPlan.v2";
const page = document.body.dataset.page;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const fallbackMeanings = ["苹果", "香蕉", "学校", "开心", "窗户", "铅笔", "朋友", "家庭"];

let state = defaultState();
let currentIndex = Number(sessionStorage.getItem("currentWordIndex") || 0);
let currentPhase = sessionStorage.getItem("currentPhase") || "preview";
let recognition = null;
let planDraft = [];
let reviewState = defaultState();
let selectedReviewDate = todayKey();
let pendingLookup = null;
let lookupTimer = 0;
let draggedWordIndex = null;

function todayKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function defaultState() {
  return {
    date: todayKey(),
    words: [],
    progress: {}
  };
}

async function loadState(date = todayKey()) {
  try {
    const response = await fetch(`/api/state?date=${encodeURIComponent(date)}`, {
      headers: { Accept: "application/json" },
      cache: "no-store"
    });
    if (response.ok) {
      const data = await response.json();
      if (date === todayKey()) localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      return normalizeState(data);
    }
  } catch {
    // Opening the HTML file directly still works with browser-local data.
  }

  return loadLocalState();
}

function loadLocalState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return defaultState();

  try {
    return normalizeState(JSON.parse(raw));
  } catch {
    return defaultState();
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  fetch("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(state)
  }).catch(() => {
    // Local fallback has already been written.
  });
}

function normalizeState(value) {
  if (!value || typeof value !== "object") return defaultState();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value.date || "") ? value.date : todayKey();
  return {
    date,
    ...value,
    words: Array.isArray(value.words) ? value.words : [],
    progress: value.progress && typeof value.progress === "object" ? value.progress : {}
  };
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeWord(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeSpeech(value) {
  return normalizeWord(value).replace(/[^a-z\s'-]/g, "").replace(/\s+/g, " ");
}

function makeExample(word) {
  return `I can use ${word} in a sentence.`;
}

function buildWord(word, phonetic, meaning, sentence, phrase = "") {
  const text = String(word || "").trim();
  return {
    id: normalizeWord(text),
    text,
    phonetic: String(phonetic || "").trim(),
    meaning: String(meaning || "").trim(),
    phrase: String(phrase || "").trim(),
    sentence: String(sentence || "").trim() || makeExample(text)
  };
}

function ensureProgress(wordId) {
  if (!state.progress[wordId]) {
    state.progress[wordId] = {
      phase: "preview",
      views: 0,
      listened: 0,
      previewPlayed: false,
      sentenceText: "",
      sentenceTranscript: "",
      sentenceScore: 0,
      blankAnswer: "",
      blankCorrect: false,
      pronunciationTranscript: "",
      pronunciationScore: 0,
      meaningAnswer: "",
      meaningCorrect: false,
      completed: false,
      completedAt: ""
    };
  }
  return state.progress[wordId];
}

function currentWord() {
  if (currentIndex >= state.words.length) currentIndex = 0;
  return state.words[currentIndex] || null;
}

function setPosition(index, phase = "preview") {
  currentIndex = index;
  currentPhase = phase;
  sessionStorage.setItem("currentWordIndex", String(currentIndex));
  sessionStorage.setItem("currentPhase", currentPhase);
}

function formatTime(value) {
  if (!value) return "-";
  return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function speak(text, rate = 0.85) {
  if (!("speechSynthesis" in window)) return false;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "en-US";
  utterance.rate = rate;
  utterance.pitch = 1;
  window.speechSynthesis.speak(utterance);
  return true;
}

function getRecognition() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) return null;
  const instance = new Recognition();
  instance.lang = "en-US";
  instance.interimResults = false;
  instance.maxAlternatives = 1;
  return instance;
}

function listenOnce({ onStart, onResult, onError }) {
  recognition = getRecognition();
  if (!recognition) {
    onError("当前浏览器不支持语音识别，请换 Chrome 或直接完成测试。");
    return;
  }

  recognition.onstart = onStart;
  recognition.onerror = () => onError("没有听清楚，请再读一遍。");
  recognition.onresult = (event) => {
    const transcript = event.results?.[0]?.[0]?.transcript || "";
    onResult(transcript);
  };
  recognition.start();
}

function scorePronunciation(target, transcript) {
  const normalizedTarget = normalizeSpeech(target);
  const normalizedTranscript = normalizeSpeech(transcript);
  if (!normalizedTranscript) return 0;
  if (normalizedTranscript.split(" ").includes(normalizedTarget)) return 100;
  if (normalizedTranscript.includes(normalizedTarget)) return 88;

  let same = 0;
  const max = Math.max(normalizedTarget.length, normalizedTranscript.length);
  for (let index = 0; index < Math.min(normalizedTarget.length, normalizedTranscript.length); index += 1) {
    if (normalizedTarget[index] === normalizedTranscript[index]) same += 1;
  }
  return Math.round((same / Math.max(max, 1)) * 70);
}

function renderToday() {
  const label = $("#todayLabel");
  if (label) label.textContent = `今日：${todayKey()}`;
}

function initParent() {
  renderToday();
  selectedReviewDate = todayKey();
  reviewState = state;
  if ($("#reviewDate")) $("#reviewDate").value = selectedReviewDate;
  bindParentTabs();
  bindParentActions();
  renderParentPlan();
  renderReview();
}

function bindParentTabs() {
  $$("[data-parent-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      const tab = button.dataset.parentTab;
      $$("[data-parent-tab]").forEach((item) => {
        const active = item.dataset.parentTab === tab;
        item.classList.toggle("active", active);
        item.setAttribute("aria-selected", String(active));
      });
      $("#planTab").classList.toggle("active", tab === "plan");
      $("#reviewTab").classList.toggle("active", tab === "review");
      if (tab === "review") loadReviewForDate($("#reviewDate").value || todayKey());
    });
  });
}

function bindParentActions() {
  $("#quickWordInput").addEventListener("input", () => scheduleLookup());
  $("#quickWordInput").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    addPendingWord();
  });
  $("#confirmAddWord").addEventListener("click", addPendingWord);

  $("#lookupHint").addEventListener("click", (event) => {
    if (!event.target.closest("[data-confirm-lookup]")) return;
    addPendingWord();
  });

  $("#wordRows").addEventListener("dragstart", (event) => {
    const card = event.target.closest("[data-word-index]");
    if (!card) return;
    draggedWordIndex = Number(card.dataset.wordIndex);
    card.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
  });

  $("#wordRows").addEventListener("dragover", (event) => {
    event.preventDefault();
    const card = event.target.closest("[data-word-index]");
    if (!card || draggedWordIndex === null) return;
    const targetIndex = Number(card.dataset.wordIndex);
    if (targetIndex === draggedWordIndex) return;
    moveDraftWord(draggedWordIndex, targetIndex);
    draggedWordIndex = targetIndex;
  });

  $("#wordRows").addEventListener("dragend", () => {
    draggedWordIndex = null;
    renderDraftWords();
  });

  $("#wordRows").addEventListener("click", (event) => {
    const deleteButton = event.target.closest("[data-delete-word]");
    if (!deleteButton) return;
    planDraft.splice(Number(deleteButton.dataset.deleteWord), 1);
    renderDraftWords();
  });

  $("#wordRows").addEventListener("pointerdown", startSwipeDelete);

  $("#planForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const words = planDraft.slice();
    const nextProgress = {};
    words.forEach((word) => {
      nextProgress[word.id] = state.progress[word.id] || ensureProgress(word.id);
    });
    state = { date: todayKey(), words, progress: nextProgress };
    sessionStorage.setItem("currentWordIndex", "0");
    sessionStorage.setItem("currentPhase", "preview");
    saveState();
    renderParentPlan();
    renderReview();
  });

  $("#loadReviewDate").addEventListener("click", () => {
    loadReviewForDate($("#reviewDate").value || todayKey());
  });

  $("#reviewDate").addEventListener("change", () => {
    loadReviewForDate($("#reviewDate").value || todayKey());
  });

  $("#loadSample").addEventListener("click", () => {
    planDraft = [
      buildWord("apple", "/ˈæpəl/", "苹果", "I eat an apple after lunch.", "an apple"),
      buildWord("banana", "/bəˈnɑːnə/", "香蕉", "The banana is yellow.", "a yellow banana"),
      buildWord("school", "/skuːl/", "学校", "I go to school every day.", "go to school"),
      buildWord("happy", "/ˈhæpi/", "开心的", "I feel happy today.", "feel happy"),
      buildWord("window", "/ˈwɪndoʊ/", "窗户", "Please open the window.", "open the window")
    ];
    renderDraftWords();
    renderLookupHint(null);
  });

  $("#clearPlan").addEventListener("click", () => {
    state = defaultState();
    sessionStorage.setItem("currentWordIndex", "0");
    sessionStorage.setItem("currentPhase", "preview");
    saveState();
    renderParentPlan();
    renderReview();
  });

}

function renderParentPlan() {
  planDraft = state.words.slice();
  renderDraftWords();
  $("#savedWords").innerHTML = state.words
    .map((word) => {
      const progress = ensureProgress(word.id);
      return `<span class="saved-chip ${progress.completed ? "done" : ""}">${escapeHtml(word.text)}</span>`;
    })
    .join("");
}

async function lookupWord(query) {
  try {
    const response = await fetch(`/api/lookup?q=${encodeURIComponent(query)}`, {
      headers: { Accept: "application/json" },
      cache: "no-store"
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function scheduleLookup() {
  clearTimeout(lookupTimer);
  const query = $("#quickWordInput").value.trim();
  if (!query) {
    renderLookupHint(null);
    return;
  }
  lookupTimer = window.setTimeout(async () => {
    const item = await lookupWord(query);
    pendingLookup = normalizeLookupItem(query, item);
    renderLookupHint(pendingLookup);
  }, 260);
}

function normalizeLookupItem(query, item) {
  if (item?.text) return item;
  if (/^[a-zA-Z][a-zA-Z\s'-]*$/.test(query)) {
    return buildWord(query, "", "", makeExample(query), `use ${query}`);
  }
  return null;
}

function renderLookupHint(item) {
  pendingLookup = item;
  if (!item) {
    $("#lookupHint").innerHTML = "";
    return;
  }
  $("#lookupHint").innerHTML = `
    <button class="lookup-card" type="button" data-confirm-lookup>
      <span class="lookup-word">${escapeHtml(item.text)}</span>
      <span>${escapeHtml(item.phonetic || "音标待补充")}</span>
      <strong>${escapeHtml(item.meaning || "中文待补充")}</strong>
      <small>${escapeHtml(item.phrase || item.sentence || "")}</small>
      <b>确认添加</b>
    </button>
  `;
}

async function addPendingWord() {
  const query = $("#quickWordInput").value.trim();
  if (!query) return;
  if (!pendingLookup || pendingLookup.text.toLowerCase() !== query.toLowerCase()) {
    pendingLookup = normalizeLookupItem(query, await lookupWord(query));
  }
  if (!pendingLookup?.text) {
    $("#lookupHint").innerHTML = `<p class="lookup-empty">没有找到可添加的英文单词。</p>`;
    return;
  }
  if (!planDraft.some((word) => word.id === pendingLookup.id)) {
    planDraft.push(buildWord(
      pendingLookup.text,
      pendingLookup.phonetic,
      pendingLookup.meaning,
      pendingLookup.sentence,
      pendingLookup.phrase
    ));
  }
  $("#quickWordInput").value = "";
  renderLookupHint(null);
  renderDraftWords();
}

function renderDraftWords() {
  const container = $("#wordRows");
  if (!planDraft.length) {
    container.innerHTML = `<div class="empty-list">还没有添加单词</div>`;
    return;
  }
  container.innerHTML = planDraft.map((word, index) => `
    <article class="simple-word-card" draggable="true" data-word-index="${index}">
      <div class="drag-handle" aria-hidden="true">☰</div>
      <div class="simple-word-main">
        <strong>${escapeHtml(word.text)}</strong>
        <span>${escapeHtml(word.phonetic || "音标待补充")} · ${escapeHtml(word.meaning || "中文待补充")}</span>
        <small>${escapeHtml(word.phrase || word.sentence || "")}</small>
      </div>
      <button class="delete-swipe-btn" type="button" data-delete-word="${index}">删除</button>
    </article>
  `).join("");
}

function moveDraftWord(fromIndex, toIndex) {
  const [word] = planDraft.splice(fromIndex, 1);
  planDraft.splice(toIndex, 0, word);
  renderDraftWords();
}

function startSwipeDelete(event) {
  const card = event.target.closest(".simple-word-card");
  if (!card || event.target.closest("button")) return;
  const startX = event.clientX;
  const startY = event.clientY;
  const index = Number(card.dataset.wordIndex);

  const move = (moveEvent) => {
    const deltaX = moveEvent.clientX - startX;
    const deltaY = Math.abs(moveEvent.clientY - startY);
    if (deltaX > 42 && deltaY < 28) {
      card.classList.add("show-delete");
    } else if (deltaX < -20) {
      card.classList.remove("show-delete");
    }
  };

  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };

  card.querySelector("[data-delete-word]").dataset.deleteWord = String(index);
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

async function loadReviewForDate(date) {
  selectedReviewDate = date || todayKey();
  reviewState = selectedReviewDate === state.date ? state : await loadState(selectedReviewDate);
  renderReview();
}

function reviewProgress(wordId) {
  if (!reviewState.progress[wordId]) {
    reviewState.progress[wordId] = {
      phase: "preview",
      completed: false,
      sentenceText: "",
      blankAnswer: "",
      blankCorrect: false,
      pronunciationTranscript: "",
      pronunciationScore: 0,
      meaningAnswer: "",
      meaningCorrect: false,
      completedAt: ""
    };
  }
  return reviewState.progress[wordId];
}

function renderReview() {
  const total = reviewState.words.length;
  const done = reviewState.words.filter((word) => reviewProgress(word.id).completed).length;
  const passed = reviewState.words.filter((word) => isTestPassed(reviewProgress(word.id))).length;
  const weakWords = reviewState.words.filter((word) => !isTestPassed(reviewProgress(word.id)));

  $("#metricTotal").textContent = total;
  $("#metricDone").textContent = done;
  $("#metricPassed").textContent = passed;
  $("#metricWeak").textContent = weakWords.length;
  $("#reviewSummary").textContent = buildReviewSummary(total, done, passed, weakWords, reviewState.date);
  $("#reviewRows").innerHTML = reviewState.words.map(renderReviewRow).join("");
}

function isTestPassed(progress) {
  return progress.completed && progress.blankCorrect && progress.meaningCorrect && progress.pronunciationScore >= 75;
}

function buildReviewSummary(total, done, passed, weakWords, date) {
  if (!total) return `${date} 没有布置单词。`;
  if (passed === total) return `${date} 的单词已全部完成，填空、读音和中文选择都通过。`;
  const weakList = weakWords.slice(0, 5).map((word) => word.text).join("、");
  return `${date} 已完成 ${done}/${total} 个，测试通过 ${passed}/${total} 个。建议重点复习：${weakList || "暂无"}。`;
}

function renderReviewRow(word) {
  const progress = reviewProgress(word.id);
  const phaseText = progress.completed ? "已完成" : phaseLabel(progress.phase);
  const pronunciation = progress.pronunciationTranscript
    ? `${progress.pronunciationScore} 分：${escapeHtml(progress.pronunciationTranscript)}`
    : "未朗读";

  return `
    <tr>
      <td><strong>${escapeHtml(word.text)}</strong><br><span>${escapeHtml(word.phonetic || "-")} ${escapeHtml(word.meaning || "")}</span></td>
      <td><span class="status-pill ${progress.completed ? "done" : "weak"}">${phaseText}</span></td>
      <td>${escapeHtml(progress.sentenceText || "未造句")}</td>
      <td>${progress.blankAnswer ? (progress.blankCorrect ? "正确" : `错误：${escapeHtml(progress.blankAnswer)}`) : "未测试"}</td>
      <td>${pronunciation}</td>
      <td>${progress.meaningAnswer ? (progress.meaningCorrect ? "正确" : `错误：${escapeHtml(progress.meaningAnswer)}`) : "未选择"}</td>
      <td>${formatTime(progress.completedAt)}</td>
    </tr>
  `;
}

function phaseLabel(phase) {
  return {
    preview: "看词听音",
    sentence: "造句朗读",
    test: "测试"
  }[phase] || "未开始";
}

function initChild() {
  renderToday();
  bindChildActions();
  renderChild();
}

function bindChildActions() {
  $("#speakWordBtn").addEventListener("click", () => {
    const word = currentWord();
    if (!word) return;
    ensureProgress(word.id).listened += 1;
    saveState();
    speak(word.text);
  });

  $("#toSentenceBtn").addEventListener("click", () => {
    const word = currentWord();
    if (!word) return;
    ensureProgress(word.id).phase = "sentence";
    setPosition(currentIndex, "sentence");
    saveState();
    renderChild();
  });

  $("#speakSentenceBtn").addEventListener("click", () => {
    const word = currentWord();
    if (word) speak(word.sentence, 0.78);
  });

  $("#readSentenceBtn").addEventListener("click", () => {
    const word = currentWord();
    if (!word) return;
    const progress = ensureProgress(word.id);
    $("#sentenceFeedback").textContent = "正在听，请朗读你的句子。";
    $("#sentenceFeedback").className = "feedback";
    listenOnce({
      onStart: () => {
        $("#sentenceFeedback").textContent = "正在听，请朗读你的句子。";
      },
      onResult: (transcript) => {
        progress.sentenceTranscript = transcript;
        progress.sentenceScore = scorePronunciation(word.text, transcript);
        saveState();
        $("#sentenceFeedback").textContent = `听到：${transcript}。${progress.sentenceScore >= 70 ? "发音里听到了目标单词。" : "目标单词不够清楚，可以再读一次。"}`;
        $("#sentenceFeedback").className = progress.sentenceScore >= 70 ? "feedback good" : "feedback bad";
      },
      onError: (message) => {
        $("#sentenceFeedback").textContent = message;
        $("#sentenceFeedback").className = "feedback bad";
      }
    });
  });

  $("#sentenceForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const word = currentWord();
    if (!word) return;
    const progress = ensureProgress(word.id);
    progress.sentenceText = $("#sentenceInput").value.trim();
    progress.phase = "test";
    setPosition(currentIndex, "test");
    saveState();
    renderChild();
  });

  $("#readWordBtn").addEventListener("click", () => {
    const word = currentWord();
    if (!word) return;
    const progress = ensureProgress(word.id);
    $("#pronunciationFeedback").textContent = "正在听，请读这个单词。";
    $("#pronunciationFeedback").className = "feedback";
    listenOnce({
      onStart: () => {
        $("#pronunciationFeedback").textContent = "正在听，请读这个单词。";
      },
      onResult: (transcript) => {
        progress.pronunciationTranscript = transcript;
        progress.pronunciationScore = scorePronunciation(word.text, transcript);
        saveState();
        $("#pronunciationFeedback").textContent = `听到：${transcript}。读音评分 ${progress.pronunciationScore} 分。`;
        $("#pronunciationFeedback").className = progress.pronunciationScore >= 75 ? "feedback good" : "feedback bad";
      },
      onError: (message) => {
        $("#pronunciationFeedback").textContent = message;
        $("#pronunciationFeedback").className = "feedback bad";
      }
    });
  });

  $("#testForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const word = currentWord();
    if (!word) return;
    const progress = ensureProgress(word.id);
    progress.blankAnswer = $("#blankInput").value.trim();
    progress.blankCorrect = normalizeWord(progress.blankAnswer) === word.id;
    progress.meaningAnswer = $("input[name='meaningChoice']:checked")?.value || "";
    progress.meaningCorrect = progress.meaningAnswer === word.meaning;
    progress.completed = true;
    progress.phase = "done";
    progress.completedAt = new Date().toISOString();
    saveState();

    const passed = isTestPassed(progress);
    $("#testFeedback").textContent = passed ? "通过了，进入下一个单词。" : "已记录结果，建议稍后再复习这个单词。";
    $("#testFeedback").className = passed ? "feedback good" : "feedback bad";

    setTimeout(() => {
      moveToNextWord();
      renderChild();
    }, 650);
  });
}

function renderChild() {
  const total = state.words.length;
  const done = state.words.filter((word) => ensureProgress(word.id).completed).length;
  const percent = total ? Math.round((done / total) * 100) : 0;

  $("#totalCount").textContent = total;
  $("#doneCount").textContent = done;
  $("#progressPercent").textContent = `${percent}%`;
  if ($(".progress-ring")) $(".progress-ring").style.setProperty("--progress", `${percent * 3.6}deg`);
  if ($("#progressFill")) $("#progressFill").style.width = `${percent}%`;
  $("#wordTrail").innerHTML = state.words
    .map((word, index) => {
      const progress = ensureProgress(word.id);
      const classes = ["trail-chip"];
      if (progress.completed) classes.push("done");
      if (index === currentIndex) classes.push("current");
      return `<button class="${classes.join(" ")}" type="button" data-word-index="${index}">${escapeHtml(word.text)}</button>`;
    })
    .join("");

  $$("[data-word-index]").forEach((button) => {
    button.addEventListener("click", () => {
      const nextIndex = Number(button.dataset.wordIndex);
      const nextWord = state.words[nextIndex];
      if (nextWord) ensureProgress(nextWord.id).phase = "preview";
      setPosition(nextIndex, "preview");
      saveState();
      renderChild();
    });
  });

  if (!total) {
    $("#emptyChild").hidden = false;
    $("#studyArea").hidden = true;
    return;
  }

  $("#emptyChild").hidden = true;
  $("#studyArea").hidden = false;

  const word = currentWord();
  const progress = ensureProgress(word.id);
  progress.views += 1;
  if (progress.phase && progress.phase !== "done") currentPhase = progress.phase;

  $("#cardIndex").textContent = `第 ${currentIndex + 1} 个 / 共 ${total} 个`;
  $("#currentWord").textContent = word.text;
  $("#currentPhonetic").textContent = word.phonetic || "音标待补充";
  $("#currentMeaning").textContent = word.meaning || "中文待补充";
  $("#exampleSentence").textContent = word.sentence;
  $("#sentenceInput").value = progress.sentenceText || "";
  $("#sentenceFeedback").textContent = progress.sentenceTranscript ? `上次听到：${progress.sentenceTranscript}` : "";
  $("#sentenceFeedback").className = progress.sentenceScore >= 70 ? "feedback good" : "feedback";
  $("#blankQuestion").textContent = makeBlankQuestion(word);
  $("#blankInput").value = progress.blankAnswer || "";
  $("#pronunciationFeedback").textContent = progress.pronunciationTranscript
    ? `听到：${progress.pronunciationTranscript}。读音评分 ${progress.pronunciationScore} 分。`
    : "";
  $("#pronunciationFeedback").className = progress.pronunciationScore >= 75 ? "feedback good" : "feedback";
  $("#testFeedback").textContent = "";
  renderMeaningOptions(word, progress);
  showPhase(currentPhase);
  if (currentPhase === "preview" && !progress.previewPlayed) {
    progress.previewPlayed = true;
    progress.listened += 1;
    speak(word.text);
  }
  saveState();
}

function showPhase(phase) {
  ["preview", "sentence", "test"].forEach((name) => {
    $(`[data-step='${name}']`).classList.toggle("active", name === phase);
  });
  $("#previewPhase").hidden = phase !== "preview";
  $("#sentencePhase").hidden = phase !== "sentence";
  $("#testPhase").hidden = phase !== "test";
}

function makeBlankQuestion(word) {
  const sentence = word.sentence || makeExample(word.text);
  const pattern = new RegExp(`\\b${word.text}\\b`, "i");
  if (pattern.test(sentence)) return sentence.replace(pattern, "____");
  return `____ means ${word.meaning || "这个中文意思"}.`;
}

function renderMeaningOptions(word, progress) {
  const meanings = state.words.map((item) => item.meaning).filter(Boolean);
  const pool = Array.from(new Set([word.meaning, ...meanings, ...fallbackMeanings])).filter(Boolean);
  const options = pool.filter((meaning) => meaning !== word.meaning).slice(0, 2);
  options.splice((word.text.length + options.length) % 3, 0, word.meaning || "中文待补充");

  $("#meaningOptions").innerHTML = options
    .map((meaning, index) => {
      const checked = progress.meaningAnswer === meaning;
      return `
        <label class="choice-card">
          <input type="radio" name="meaningChoice" value="${escapeHtml(meaning)}" ${checked ? "checked" : ""} />
          <span>${escapeHtml(meaning)}</span>
        </label>
      `;
    })
    .join("");
}

function moveToNextWord() {
  const total = state.words.length;
  if (!total) return;
  for (let offset = 1; offset <= total; offset += 1) {
    const nextIndex = (currentIndex + offset) % total;
    if (!ensureProgress(state.words[nextIndex].id).completed) {
      setPosition(nextIndex, "preview");
      return;
    }
  }
  setPosition(0, "preview");
}

async function boot() {
  state = await loadState();
  if (page === "parent") initParent();
  if (page === "child") initChild();
}

boot();
