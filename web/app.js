(() => {
  "use strict";

  const API = "/api";
  const STORAGE_KEY = "stat-mock-active-attempt";
  const SYNC_PREFIX = "stat-mock-sync-";
  const LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H"];

  const state = {
    tests: [],
    test: null,
    questions: [],
    attempt: null,
    answers: {},
    index: 0,
    view: "loading",
    timerId: null,
    timerRemainingMs: 0,
    timerUnsyncedMs: 0,
    timerLastPerformanceMs: null,
    timerSyncPending: false,
    durable: null,
    syncRunning: false,
    syncRetryId: null,
    mutationWaiters: [],
    timingVisit: null,
    timingStartAt: null,
    timingStartPerformanceMs: null,
    timeoutRecovery: false,
    review: null,
    reviewQuestions: [],
    reviewIndex: 0,
    hideReviewAnswers: false,
    filter: "all",
    noteTimer: null,
    enteredQuestionId: null,
    visible: !document.hidden,
    navigating: false,
    viewVersion: 0,
    submitting: false,
    noteSaveQueue: Promise.resolve(),
    noteSavePending: 0,
    installationId: null,
  };

  const el = Object.fromEntries([
    "app-title", "save-status", "exam-toolbar", "question-nav", "timer",
    "main-content", "loading-view", "start-view", "test-list", "exam-view",
    "question-heading", "stimulus-content", "unit-question-count", "review-unit-question-count", "unit-position", "visible-question-number",
    "prompt-content", "answer-form", "answer-options", "finish-view", "finish-heading", "finish-submit-note", "answer-count",
    "results-view", "results-heading", "results-test-title", "results-statistics", "review-questions", "view-statistics",
    "review-view", "review-heading", "review-summary", "review-filters", "review-hide-answers", "review-grid", "filter-empty",
    "review-detail", "review-stimulus", "review-question-number", "review-prompt",
    "review-options", "review-metrics", "review-answer-line", "review-note", "note-status",
    "error-view", "error-message", "retry-button", "exam-footer", "back-button", "forward-button"
  ].map((id) => [id, document.getElementById(id)]));

  function firstDefined(object, keys, fallback = undefined) {
    if (!object) return fallback;
    for (const key of keys) {
      if (object[key] !== undefined && object[key] !== null) return object[key];
    }
    return fallback;
  }

  async function api(path, options = {}) {
    const headers = { Accept: "application/json", ...(options.headers || {}) };
    if (options.body && !(options.body instanceof FormData)) headers["Content-Type"] = "application/json";
    const response = await fetch(`${API}${path}`, { ...options, headers });
    if (!response.ok) {
      let message = `Request failed (${response.status})`;
      try {
        const body = await response.json();
        message = firstDefined(body, ["detail", "message", "error"], message);
      } catch (_) { /* Keep the status-based message. */ }
      throw new Error(typeof message === "string" ? message : JSON.stringify(message));
    }
    if (response.status === 204) return null;
    return response.json();
  }

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function durableKey(attemptId) {
    return storageKey(`${SYNC_PREFIX}${attemptId}`);
  }

  function storageKey(key) {
    if (!state.installationId) throw new Error("Local storage is not connected to this installation.");
    return `stat-mock:${state.installationId}:${key}`;
  }

  function noteKey(attemptId, questionId) {
    return storageKey(`stat-note-${attemptId}-${questionId}`);
  }

  function configureStorage(installation) {
    if (typeof installation?.id !== "string" || !installation.id) throw new Error("Installation identity is unavailable.");
    state.installationId = installation.id;
    const marker = storageKey("legacy-imported");
    if (localStorage.getItem(marker) !== null) return;
    if (installation.legacyStorageAllowed === true) {
      // Copy once, keeping original records and any newer installation-scoped values intact.
      const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
      for (const key of keys) {
        if (key !== STORAGE_KEY && !key?.startsWith(SYNC_PREFIX) && !key?.startsWith("stat-note-")) continue;
        const scoped = storageKey(key);
        if (localStorage.getItem(scoped) === null) localStorage.setItem(scoped, localStorage.getItem(key));
      }
    }
    localStorage.setItem(marker, "true");
  }

  function readDurable(attemptId) {
    try {
      const stored = JSON.parse(localStorage.getItem(durableKey(attemptId)) || "null");
      if (stored?.attemptId === attemptId && Array.isArray(stored.outbox)) return stored;
    } catch (_) { /* Start a clean outbox if storage was manually corrupted. */ }
    return { version: 1, attemptId, answers: {}, outbox: [], position: 0, openVisit: null };
  }

  function persistDurable() {
    try {
      localStorage.setItem(durableKey(state.attempt.id), JSON.stringify(state.durable));
      return true;
    } catch (_) {
      setSaveStatus("Local save failed — do not close this page", true);
      return false;
    }
  }

  function setView(name) {
    state.viewVersion += 1;
    state.view = name;
    const map = {
      loading: el["loading-view"],
      start: el["start-view"],
      exam: el["exam-view"],
      finish: el["finish-view"],
      results: el["results-view"],
      review: el["review-view"],
      error: el["error-view"],
    };
    Object.entries(map).forEach(([key, node]) => { node.hidden = key !== name; });
    const timed = name === "exam" || name === "finish";
    el["exam-toolbar"].hidden = !timed;
    el["exam-footer"].hidden = !timed;
    document.body.classList.toggle("is-reviewing", name === "review");
  }

  function setError(error) {
    clearInterval(state.timerId);
    el["error-message"].textContent = error?.message || "An unexpected error occurred.";
    setView("error");
    el["retry-button"].focus();
  }

  function setSaveStatus(text, isError = false) {
    el["save-status"].textContent = text;
    el["save-status"].style.color = isError ? "#f9f1c6" : "";
  }

  function normalizeTestList(payload) {
    const list = Array.isArray(payload) ? payload : firstDefined(payload, ["tests", "items"], []);
    return list.map((test) => ({
      ...test,
      id: firstDefined(test, ["id", "test_id", "testId"]),
      title: firstDefined(test, ["title", "name"], "Untitled test"),
      questionCount: Number(firstDefined(test, ["questionCount", "question_count", "total_questions"], 70)),
      durationSeconds: Number(firstDefined(test, ["durationSeconds", "duration_seconds"], 7200)),
      attempt: firstDefined(test, ["attempt", "latestAttempt", "latest_attempt"], null),
    }));
  }

  function flattenQuestions(test) {
    if (!test) return [];
    if (Array.isArray(test.questions)) {
      return test.questions.map((question, index) => ({ ...question, _number: index + 1, _unit: question.unit || {} }));
    }
    const questions = [];
    (test.units || []).forEach((unit) => {
      (unit.questions || []).forEach((question) => {
        questions.push({ ...question, _number: questions.length + 1, _unit: unit });
      });
    });
    return questions;
  }

  function normalizeAttempt(payload) {
    const attempt = firstDefined(payload, ["attempt"], payload) || {};
    const rawAnswers = firstDefined(attempt, ["answers", "responses"], {});
    let answers = {};
    const answerRecords = {};
    if (Array.isArray(rawAnswers)) {
      rawAnswers.forEach((answer) => {
        const id = firstDefined(answer, ["question_id", "questionId", "id"]);
        if (id) {
          answers[id] = firstDefined(answer, ["choice", "answer", "selected_answer"]);
          answerRecords[id] = answer;
        }
      });
    } else {
      Object.entries(rawAnswers || {}).forEach(([id, answer]) => {
        answers[id] = typeof answer === "object" && answer !== null
          ? firstDefined(answer, ["choice", "answer", "selected_answer"])
          : answer;
        answerRecords[id] = typeof answer === "object" && answer !== null ? answer : { choice: answer, revision: 0 };
      });
    }
    return {
      ...attempt,
      id: firstDefined(attempt, ["id", "attempt_id", "attemptId"]),
      testId: firstDefined(attempt, ["test_id", "testId"], state.test?.id),
      status: firstDefined(attempt, ["status"], "active"),
      deadlineAt: firstDefined(attempt, ["deadline_at", "deadlineAt"]),
      serverNow: firstDefined(attempt, ["serverNow", "server_now"]),
      remainingSeconds: Number(firstDefined(attempt, ["remaining_seconds", "remainingSeconds"], NaN)),
      remainingMs: Number(firstDefined(attempt, ["remaining_ms", "remainingMs"], NaN)),
      currentQuestion: firstDefined(attempt, ["currentQuestionId", "current_question", "currentQuestion", "current_question_id"]),
      answers,
      answerRecords,
    };
  }

  async function boot() {
    setView("loading");
    try {
      configureStorage(await api("/installation"));
      const payload = await api("/tests");
      state.tests = normalizeTestList(payload);
      const savedId = localStorage.getItem(storageKey(STORAGE_KEY));
      if (savedId) {
        try {
          const attempt = normalizeAttempt(await api(`/attempts/${encodeURIComponent(savedId)}`));
          if (attempt.status === "submitted" || attempt.status === "expired") {
            localStorage.removeItem(storageKey(STORAGE_KEY));
          } else {
            const testId = attempt.testId || state.tests[0]?.id;
            if (testId) {
              state.test = await api(`/tests/${encodeURIComponent(testId)}`);
              state.questions = flattenQuestions(state.test);
              beginExam(attempt);
              return;
            }
          }
        } catch (_) {
          localStorage.removeItem(storageKey(STORAGE_KEY));
        }
      }
      renderStart();
    } catch (error) {
      setError(error);
    }
  }

  function renderStart() {
    el["app-title"].textContent = "STAT mock test";
    el["test-list"].replaceChildren();
    if (!state.tests.length) {
      const p = document.createElement("p");
      p.textContent = "No practice papers are available. Add a local content pack to begin.";
      el["test-list"].append(p);
    }
    state.tests.forEach((test) => {
      const item = document.createElement("article");
      item.className = "test-item";
      const copy = document.createElement("div");
      const heading = document.createElement("h2");
      heading.textContent = test.title;
      const meta = document.createElement("p");
      meta.className = "test-meta";
      meta.textContent = `${test.questionCount} questions · ${formatDuration(test.durationSeconds)}`;
      copy.append(heading, meta);
      const attempt = test.attempt;
      if (attempt) {
        const status = document.createElement("p");
        status.className = "test-status";
        if (attempt.status === "active") {
          status.textContent = `In progress · ${Number(attempt.answeredCount || 0)} answered · ${clock(Number(attempt.remainingSeconds || 0))} remaining`;
        } else {
          const totals = attempt.totals || {};
          const completedOn = attempt.submittedAt == null ? "" : new Date(attempt.submittedAt).toLocaleDateString(undefined, {
            day: "numeric", month: "short", year: "numeric",
          });
          status.textContent = `Completed${completedOn ? ` on ${completedOn}` : ""} · ${Number(totals.raw || 0)} of ${test.questionCount} correct`;
        }
        copy.append(status);
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = "button button-forward";
      button.textContent = !attempt ? "Start test" : (attempt.status === "active" ? "Continue test" : "Review results");
      button.addEventListener("click", () => selectTest(test, button));
      item.append(copy, button);
      el["test-list"].append(item);
    });
    setView("start");
  }

  async function selectTest(test, button) {
    const attempt = test.attempt;
    if (!attempt) return startTest(test, button);
    button.disabled = true;
    button.textContent = attempt.status === "active" ? "Opening…" : "Loading review…";
    try {
      if (attempt.status === "active") {
        const [content, attemptPayload] = await Promise.all([
          api(`/tests/${encodeURIComponent(test.id)}`),
          api(`/attempts/${encodeURIComponent(attempt.id)}`),
        ]);
        state.test = content;
        state.questions = flattenQuestions(content);
        beginExam(normalizeAttempt(attemptPayload));
      } else {
        state.test = test;
        state.attempt = normalizeAttempt(attempt);
        await loadReview();
      }
    } catch (error) {
      button.disabled = false;
      button.textContent = attempt.status === "active" ? "Continue test" : "Review results";
      setError(error);
    }
  }

  async function startTest(test, button) {
    button.disabled = true;
    button.textContent = "Starting…";
    try {
      const [content, attemptPayload] = await Promise.all([
        api(`/tests/${encodeURIComponent(test.id)}`),
        api("/attempts", { method: "POST", body: JSON.stringify({ testId: test.id }) }),
      ]);
      state.test = content;
      state.questions = flattenQuestions(content);
      if (!state.questions.length) throw new Error("This test has no questions.");
      beginExam(normalizeAttempt(attemptPayload));
    } catch (error) {
      button.disabled = false;
      button.textContent = "Start test";
      setError(error);
    }
  }

  function beginExam(attempt) {
    state.attempt = attempt;
    state.durable = readDurable(attempt.id);
    Object.entries(attempt.answerRecords || {}).forEach(([questionId, record]) => {
      const serverRevision = Number(record.revision || 0);
      const localRevision = Number(state.durable.answers[questionId]?.revision || 0);
      if (serverRevision >= localRevision) {
        state.durable.answers[questionId] = {
          choice: record.choice, revision: serverRevision,
          mutationId: record.mutationId || null, acknowledged: true,
        };
      }
    });
    state.answers = { ...attempt.answers };
    Object.entries(state.durable.answers).forEach(([questionId, record]) => {
      if (record.choice) state.answers[questionId] = record.choice;
    });
    localStorage.setItem(storageKey(STORAGE_KEY), attempt.id);
    const byId = state.questions.findIndex((question) => question.id === attempt.currentQuestion);
    const storedIndex = Number(state.durable.position);
    state.index = byId >= 0 ? byId : (Number.isInteger(storedIndex) && storedIndex >= 0 && storedIndex < state.questions.length ? storedIndex : 0);
    persistDurable();
    el["app-title"].textContent = attempt.blindReview ? "Blind review — 20 minutes" : "STAT mock test";
    configureDeadline();
    renderQuestionNav();
    setView("exam");
    renderQuestion(false);
    startTimer();
    processMutations();
  }

  function configureDeadline() {
    const deadline = timestampMs(state.attempt.deadlineAt);
    const serverNow = timestampMs(state.attempt.serverNow);
    let remainingMs;
    if (Number.isFinite(state.attempt.remainingMs)) remainingMs = state.attempt.remainingMs;
    else if (Number.isFinite(state.attempt.remainingSeconds)) remainingMs = state.attempt.remainingSeconds * 1000;
    else if (Number.isFinite(deadline) && Number.isFinite(serverNow)) remainingMs = deadline - serverNow;
    else remainingMs = Number(firstDefined(state.test, ["durationSeconds", "duration_seconds"], 7200)) * 1000;
    const pendingMs = (state.durable?.outbox || []).filter((item) => item.kind === "timing")
      .reduce((total, item) => total + item.elapsedMs, 0);
    state.timerRemainingMs = Math.max(0, remainingMs - pendingMs);
    state.timerUnsyncedMs = 0;
    state.timerLastPerformanceMs = performance.now();
  }

  function timestampMs(value) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  }

  function renderQuestionNav() {
    el["question-nav"].replaceChildren();
    state.questions.forEach((question, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = String(index + 1);
      button.dataset.index = String(index);
      button.setAttribute("aria-label", `Question ${index + 1}${state.answers[question.id] ? ", answered" : ", not answered"}`);
      button.addEventListener("click", () => navigateTo(index));
      el["question-nav"].append(button);
    });
    const finish = document.createElement("button");
    finish.type = "button";
    finish.className = "finish-nav";
    finish.textContent = "End";
    finish.setAttribute("aria-label", "End test");
    finish.addEventListener("click", showFinish);
    el["question-nav"].append(finish);
    updateQuestionNav();
  }

  function updateQuestionNav() {
    [...el["question-nav"].querySelectorAll("button[data-index]")].forEach((button) => {
      const index = Number(button.dataset.index);
      const question = state.questions[index];
      const current = state.view === "exam" && index === state.index;
      const answered = Boolean(state.answers[question.id]);
      button.classList.toggle("is-current", current);
      button.classList.toggle("is-answered", answered);
      button.setAttribute("aria-current", current ? "page" : "false");
      button.setAttribute("aria-label", `Question ${index + 1}${current ? ", current" : ""}${answered ? ", answered" : ", not answered"}`);
    });
    const finish = el["question-nav"].querySelector(".finish-nav");
    if (finish) {
      finish.classList.toggle("is-current", state.view === "finish");
      finish.setAttribute("aria-current", state.view === "finish" ? "page" : "false");
    }
  }

  function optionsFor(question) {
    const raw = question.options || question.choices || {};
    if (Array.isArray(raw)) {
      return LETTERS.slice(0, raw.length).map((letter, index) => [letter, typeof raw[index] === "object" ? firstDefined(raw[index], ["html", "text", "value"], "") : raw[index]]);
    }
    return LETTERS.filter((letter) => letter in raw || letter.toLowerCase() in raw)
      .map((letter) => [letter, firstDefined(raw, [letter, letter.toLowerCase()], "")]);
  }

  function setTrustedHtml(node, html) {
    node.innerHTML = html || "";
    node.querySelectorAll("img").forEach((image) => {
      if (image.closest("a")) return;
      const link = document.createElement("a");
      link.href = image.src;
      link.target = "_blank";
      link.rel = "noopener";
      link.className = "source-image-link";
      link.title = "Open image at full size in a new tab";
      link.setAttribute("aria-label", `${image.alt || "Question image"}. Open at full size in a new tab.`);
      image.replaceWith(link);
      link.append(image);
    });
  }

  function stimulusFor(unit, question) {
    return firstDefined(unit, ["stimulusHtml", "stimulus_html"], firstDefined(question, ["stimulusHtml", "stimulus_html"], ""))
      + (question.stimulusSupplementHtml || "");
  }

  function unitQuestionCount(unit, questions, currentQuestion = {}) {
    const unitId = unit.id || currentQuestion.unitId;
    const count = unit.questions?.length || currentQuestion.unitQuestionCount
      || (unitId ? questions.filter((question) => (question._unit?.id || question.unitId) === unitId).length : 1) || 1;
    return count === 1 ? "There is 1 question in this unit." : `There are ${count} questions in this unit.`;
  }

  async function transitionQuestion(change) {
    if (state.navigating) return;
    if (["exam", "finish"].includes(state.view) && (state.timeoutRecovery || state.submitting)) return;
    const region = el[state.view === "review" ? "review-detail" : state.view === "finish" ? "finish-view" : "exam-view"];
    if (!region.animate || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      try { change(); } catch (error) { setError(error); }
      return;
    }
    state.navigating = true;
    const version = state.viewVersion;
    const attemptId = state.attempt?.id;
    let fade, reveal, next, renderedVersion;
    const wasInert = region.inert;
    let nextWasInert;
    try {
      region.inert = true;
      fade = region.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 500, fill: "forwards" });
      await fade.finished;
      if (state.viewVersion !== version || state.attempt?.id !== attemptId) return;
      change();
      renderedVersion = state.viewVersion;
      next = el[state.view === "review" ? "review-detail" : state.view === "finish" ? "finish-view" : "exam-view"];
      nextWasInert = next.inert;
      next.inert = true;
      reveal = next.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 500, fill: "both" });
      await reveal.finished;
    } catch (error) {
      if (error.name !== "AbortError") setError(error);
    } finally {
      fade?.cancel();
      reveal?.cancel();
      if (next) next.inert = nextWasInert;
      region.inert = wasInert;
      state.navigating = false;
      if (renderedVersion === state.viewVersion) {
        const heading = el[state.view === "review" ? "review-question-number" : state.view === "finish" ? "finish-heading" : "question-heading"];
        heading.focus({ preventScroll: true });
      }
    }
  }

  function followSourceReference(eventObject, promptNode, stimulusNode) {
    const link = eventObject.target.closest("a[data-source-ref], a[href^='#']");
    if (!link || !promptNode.contains(link)) return;
    const targetId = link.dataset.sourceRef || link.getAttribute("href")?.slice(1);
    if (!targetId) return;
    const target = [...stimulusNode.querySelectorAll("[id]")].find((node) => node.id === targetId);
    if (!target) return;
    eventObject.preventDefault();
    stimulusNode.querySelectorAll(".is-source-highlight").forEach((node) => node.classList.remove("is-source-highlight"));
    target.classList.add("is-source-highlight");
    target.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function renderQuestion(moveFocus = true) {
    const question = state.questions[state.index];
    if (!question) return;
    const unit = question._unit || {};
    el["unit-question-count"].textContent = unitQuestionCount(unit, state.questions, question);
    el["prompt-content"].closest(".question-region").scrollTop = 0;
    const stimulus = stimulusFor(unit, question);
    const prompt = firstDefined(question, ["promptHtml", "prompt_html", "prompt", "stemHtml", "stem_html"], "");
    setTrustedHtml(el["stimulus-content"], stimulus);
    setTrustedHtml(el["prompt-content"], prompt);
    el["visible-question-number"].textContent = `Question ${state.index + 1}`;
    el["question-heading"].textContent = `Question ${state.index + 1} of ${state.questions.length}`;

    const unitQuestions = state.questions.filter((item) => (item._unit?.id || null) === (unit.id || null));
    if (unit.title && unitQuestions.length > 1) {
      el["unit-position"].hidden = false;
      el["unit-position"].textContent = `${unit.title}: question ${unitQuestions.indexOf(question) + 1} of ${unitQuestions.length}`;
    } else {
      el["unit-position"].hidden = true;
    }

    el["answer-options"].replaceChildren();
    optionsFor(question).forEach(([letter, html]) => {
      const label = document.createElement("label");
      label.className = "answer-row";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = `answer-${question.id}`;
      input.value = letter;
      input.checked = state.answers[question.id] === letter;
      input.addEventListener("change", () => saveAnswer(question.id, letter));
      const skin = document.createElement("span");
      skin.className = "radio-skin";
      skin.setAttribute("aria-hidden", "true");
      const copy = document.createElement("span");
      copy.className = "answer-copy";
      const key = document.createElement("span");
      key.className = "option-letter sr-only";
      key.textContent = letter;
      const text = document.createElement("span");
      text.className = "option-text";
      setTrustedHtml(text, html);
      copy.append(key, text);
      label.append(input, skin, copy);
      el["answer-options"].append(label);
    });

    el["back-button"].hidden = state.index === 0;
    el["back-button"].textContent = "Back";
    el["forward-button"].textContent = state.index === state.questions.length - 1 ? "Finish" : "Next";
    el["forward-button"].disabled = false;
    updateQuestionNav();
    state.durable.position = state.index;
    persistDurable();
    enterQuestion(question);
    if (moveFocus) {
      el["question-heading"].focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  function saveAnswer(questionId, choice) {
    const previous = state.durable.answers[questionId] || state.attempt.answerRecords?.[questionId] || {};
    const mutation = {
      kind: "answer", mutationId: uuid(), questionId,
      revision: Number(previous.revision || 0) + 1, choice, clientAt: Date.now(),
    };
    state.durable.answers[questionId] = {
      choice, revision: mutation.revision, mutationId: mutation.mutationId, acknowledged: false,
    };
    state.durable.outbox.push(mutation);
    if (!persistDurable()) return;
    state.answers[questionId] = choice;
    updateQuestionNav();
    setSaveStatus("Saved locally — syncing…");
    processMutations();
  }

  function event(type, questionId = null, unitId = null, payload = {}) {
    if (!state.attempt?.id) return Promise.resolve();
    state.durable.outbox.push({
      kind: "event", clientEventId: uuid(), type, questionId, unitId,
      clientAt: Date.now(), payload,
    });
    persistDurable();
    processMutations();
    return Promise.resolve();
  }

  function syncPayload(items, submit = false) {
    return {
      answers: items.filter((item) => item.kind === "answer").map(({ kind, ...item }) => item),
      events: items.filter((item) => item.kind === "event").map(({ kind, ...item }) => item),
      timingSamples: items.filter((item) => item.kind === "timing").map(({ kind, ...item }) => item),
      submit,
    };
  }

  function reconcileAnswers(attempt) {
    Object.entries(attempt.answerRecords || {}).forEach(([questionId, server]) => {
      const local = state.durable.answers[questionId];
      if (!local || Number(server.revision || 0) >= Number(local.revision || 0)) {
        state.durable.answers[questionId] = {
          choice: server.choice, revision: Number(server.revision || 0),
          mutationId: server.mutationId || null, acknowledged: true,
        };
        state.answers[questionId] = server.choice;
      }
    });
  }

  async function processMutations(keepalive = false) {
    if (state.syncRunning || !state.durable?.outbox.length || state.attempt?.status !== "active") return;
    clearTimeout(state.syncRetryId);
    state.syncRunning = true;
    let succeeded = false;
    const batch = state.durable.outbox.slice(0, 50);
    const ids = new Set(batch.map((item) => item.mutationId || item.clientEventId || item.sampleId));
    try {
      const response = normalizeAttempt(await api(`/attempts/${encodeURIComponent(state.attempt.id)}/sync`, {
        method: "POST", body: JSON.stringify(syncPayload(batch)), keepalive,
      }));
      const continued = response.id !== state.attempt.id && response.blindReview && response.status === "active";
      succeeded = true;
      state.durable.outbox = state.durable.outbox.filter((item) =>
        !ids.has(item.mutationId || item.clientEventId || item.sampleId));
      if (continued) {
        persistDurable();
        beginBlindReview(response);
        return;
      }
      state.attempt = response;
      reconcileAnswers(response);
      persistDurable();
      const serverRemaining = Number(response.remainingMs);
      if (Number.isFinite(serverRemaining)) {
        const pending = state.durable.outbox.filter((item) => item.kind === "timing")
          .reduce((total, item) => total + item.elapsedMs, 0);
        const current = state.visible && state.timingStartPerformanceMs !== null
          ? Math.min(15_000, Math.max(0, performance.now() - state.timingStartPerformanceMs)) : 0;
        state.timerRemainingMs = Math.max(0, serverRemaining - pending - current);
      }
      setSaveStatus(state.durable.outbox.length ? "Syncing…" : "Saved");
      if (response.status !== "active") {
        clearInterval(state.timerId);
        await loadReview();
      }
    } catch (error) {
      setSaveStatus("Saved locally — connection needed", true);
      state.syncRetryId = setTimeout(processMutations, 2000);
    } finally {
      state.syncRunning = false;
      if (succeeded && state.durable.outbox.length && state.attempt?.status === "active") processMutations(keepalive);
      if (!state.durable.outbox.length) {
        const waiters = state.mutationWaiters.splice(0);
        waiters.forEach(({ resolve }) => resolve());
      }
    }
  }

  function waitForMutations() {
    if (!state.syncRunning && !state.durable.outbox.length) return Promise.resolve();
    processMutations();
    return new Promise((resolve) => state.mutationWaiters.push({ resolve }));
  }

  function queueTimingSample() {
    if (!state.timingVisit || state.timingStartPerformanceMs === null || !state.visible) return;
    const nowPerformance = performance.now();
    const now = Date.now();
    const elapsed = Math.round(nowPerformance - state.timingStartPerformanceMs);
    const start = state.timingStartAt;
    state.timingStartAt = now;
    state.timingStartPerformanceMs = nowPerformance;
    state.timerUnsyncedMs = 0;
    if (elapsed < 1 || elapsed > 15_000) return;
    state.durable.outbox.push({
      kind: "timing", sampleId: uuid(), visitId: state.timingVisit.visitId,
      questionId: state.timingVisit.questionId, unitId: state.timingVisit.unitId,
      elapsedMs: elapsed, clientStartAt: start, clientEndAt: now,
    });
    persistDurable();
    processMutations();
  }

  function startTimingVisit(question = null) {
    const questionId = question?.id || null;
    const unitId = question?._unit?.id || null;
    const saved = state.durable.openVisit;
    state.timingVisit = saved && saved.questionId === questionId
      ? saved : { visitId: uuid(), questionId, unitId };
    state.durable.openVisit = state.timingVisit;
    state.timingStartAt = Date.now();
    state.timingStartPerformanceMs = performance.now();
    persistDurable();
    if (questionId && (!saved || saved.visitId !== state.timingVisit.visitId)) {
      event("question_entered", questionId, unitId, { visitId: state.timingVisit.visitId });
    }
  }

  function stopTimingVisit(recordLeave = true) {
    if (!state.timingVisit) return;
    queueTimingSample();
    if (recordLeave && state.timingVisit.questionId) {
      event("question_left", state.timingVisit.questionId, state.timingVisit.unitId);
    }
    state.timingVisit = null;
    state.timingStartAt = null;
    state.timingStartPerformanceMs = null;
    state.durable.openVisit = null;
    persistDurable();
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function leaveCurrentQuestion() {
    if (!state.enteredQuestionId) return;
    stopTimingVisit(true);
    state.enteredQuestionId = null;
  }

  function enterQuestion(question) {
    if (state.enteredQuestionId === question.id) return;
    leaveCurrentQuestion();
    state.enteredQuestionId = question.id;
    startTimingVisit(question);
  }

  function navigateTo(index) {
    if (!["exam", "finish"].includes(state.view) || (state.view === "exam" && index === state.index) || index < 0 || index >= state.questions.length) return;
    return transitionQuestion(() => {
      if (state.view === "exam") leaveCurrentQuestion();
      else { stopTimingVisit(false); setView("exam"); }
      state.index = index;
      renderQuestion();
    });
  }

  function showFinish() {
    if (state.view !== "exam") return;
    return transitionQuestion(renderFinish);
  }

  function renderFinish() {
    leaveCurrentQuestion();
    const answered = Object.values(state.answers).filter(Boolean).length;
    el["answer-count"].textContent = `Number of questions answered: ${answered} out of ${state.questions.length}.`;
    el["back-button"].hidden = false;
    el["back-button"].textContent = "Go Back";
    el["finish-heading"].textContent = state.attempt.blindReview ? "Complete blind review" : "Complete test";
    el["finish-submit-note"].textContent = state.attempt.blindReview ?
      "Completing blind review saves your revised answers and reveals results for both submissions." :
      (state.attempt.blindReviewPlanned ?
        "Completing saves your timed submission and starts 20 minutes of blind review. No results are revealed yet." :
        "Completing the test saves your answers. Your answers cannot be changed afterwards.");
    if (state.attempt.blindReviewPlanned) {
      el["answer-count"].textContent += " Your timed answers will be saved, then you will have 20 minutes of blind review. Feedback stays hidden until that review is complete.";
    }
    el["forward-button"].textContent = state.attempt.blindReview ? "Finish and reveal results" :
      (state.attempt.blindReviewPlanned ? "Save and start blind review" : "Review the test");
    setView("finish");
    updateQuestionNav();
    startTimingVisit(null);
    el["finish-heading"].focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function returnToExam() {
    return navigateTo(state.index);
  }

  async function submitAttempt(reason = "user") {
    if (!state.attempt?.id || state.submitting) return;
    state.submitting = true;
    state.viewVersion += 1;
    const submittingId = state.attempt.id;
    stopTimingVisit(false);
    el["forward-button"].disabled = true;
    el["back-button"].disabled = true;
    el["forward-button"].textContent = "Submitting…";
    try {
      await waitForMutations();
      if (state.attempt.id !== submittingId) return;
      const snapshot = Object.entries(state.durable.answers).flatMap(([questionId, answer]) =>
        answer.choice && answer.mutationId && answer.revision > 0 ? [{
          mutationId: answer.mutationId, questionId, revision: answer.revision,
          choice: answer.choice, clientAt: Date.now(),
        }] : []);
      const response = normalizeAttempt(await api(`/attempts/${encodeURIComponent(state.attempt.id)}/sync`, {
        method: "POST",
        body: JSON.stringify({ answers: snapshot, events: [], timingSamples: [], submit: true }),
      }));
      state.attempt = response;
      clearInterval(state.timerId);
      if (response.status === "active" && response.blindReview) {
        beginBlindReview(response);
        return;
      }
      await loadReview();
    } catch (error) {
      el["forward-button"].disabled = false;
      el["back-button"].disabled = false;
      el["forward-button"].textContent = "Review the test";
      setSaveStatus("Submission failed", true);
      if (reason === "user") setError(error);
    } finally {
      state.submitting = false;
    }
  }

  function beginBlindReview(attempt) {
    state.enteredQuestionId = null;
    state.timingVisit = null;
    state.timingStartAt = null;
    state.timingStartPerformanceMs = null;
    state.timeoutRecovery = false;
    el["back-button"].disabled = false;
    el["forward-button"].disabled = false;
    beginExam(attempt);
    setSaveStatus("Timed submission saved. Blind review: answers remain hidden.");
  }

  function startTimer() {
    clearInterval(state.timerId);
    const tick = () => {
      accrueTimer();
      const remaining = Math.max(0, Math.ceil(state.timerRemainingMs / 1000));
      renderTimer(remaining);
      document.title = `${clock(remaining)} — ${state.view === "finish" ? "Complete test" : `Question ${state.index + 1}`}`;
      if (state.timerUnsyncedMs >= 5000) syncTimer();
      if (remaining <= 0) {
        clearInterval(state.timerId);
        renderTimer(0);
        recoverTimedOutAttempt();
      }
    };
    tick();
    state.timerId = setInterval(tick, 500);
  }

  function accrueTimer() {
    const now = performance.now();
    if (state.timerLastPerformanceMs === null) {
      state.timerLastPerformanceMs = now;
      return;
    }
    const elapsed = Math.max(0, now - state.timerLastPerformanceMs);
    state.timerLastPerformanceMs = now;
    if (!state.visible || (state.view !== "exam" && state.view !== "finish") || state.attempt?.status !== "active") return;
    state.timerRemainingMs = Math.max(0, state.timerRemainingMs - elapsed);
    state.timerUnsyncedMs += elapsed;
  }

  async function syncTimer(keepalive = false) {
    accrueTimer();
    queueTimingSample();
    processMutations(keepalive);
  }

  async function recoverTimedOutAttempt() {
    if (state.timeoutRecovery || !state.attempt?.id) return;
    state.timeoutRecovery = true;
    state.viewVersion += 1;
    el["back-button"].disabled = true;
    el["forward-button"].disabled = true;
    setSaveStatus("Saving completed phase…");
    let retryMs = 500;
    while (state.timeoutRecovery) {
      try {
        await syncTimer();
        await waitForMutations();
        if (state.attempt.status !== "active") {
          state.timeoutRecovery = false;
          return;
        }
        const attempt = normalizeAttempt(await api(`/attempts/${encodeURIComponent(state.attempt.id)}`));
        state.attempt = attempt;
        if (attempt.status === "active") {
          configureDeadline();
          state.timeoutRecovery = false;
          el["back-button"].disabled = false;
          el["forward-button"].disabled = false;
          startTimer();
          return;
        }
        state.timeoutRecovery = false;
        await loadReview();
        return;
      } catch (_) {
        setSaveStatus("Time expired — reconnecting…", true);
        await delay(retryMs);
        retryMs = Math.min(10000, retryMs * 2);
      }
    }
  }

  function renderTimer(seconds) {
    const text = clock(seconds);
    const digits = ["abcdef", "bc", "abdeg", "abcdg", "bcfg", "acdfg", "acdefg", "abc", "abcdefg", "abcdfg"];
    const paths = { a: "M3 2H9", b: "M10 3V9", c: "M10 11V17", d: "M3 18H9", e: "M2 11V17", f: "M2 3V9", g: "M3 10H9" };
    el.timer.setAttribute("aria-label", text);
    // Only clock-generated digits enter this SVG; no test content is interpolated.
    el.timer.innerHTML = [...text].map((digit) => digit === ":"
      ? '<svg class="timer-colon" viewBox="0 0 4 20" aria-hidden="true"><path d="M2 6v2m0 4v2" stroke="currentColor" stroke-width="2"/></svg>'
      : `<svg viewBox="0 0 12 20" aria-hidden="true"><path d="${[...digits[Number(digit)]].map((segment) => paths[segment]).join(" ")}" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`).join("");
  }

  function clock(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return [hours, minutes, secs].map((value) => String(value).padStart(2, "0")).join(":");
  }

  function formatDuration(seconds) {
    const value = Math.max(0, Math.round(Number(seconds) || 0));
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const secs = value % 60;
    if (hours && !secs) return `${hours} h ${minutes} min`;
    if (hours) return `${hours}h ${minutes}m ${secs}s`;
    if (minutes) return `${minutes}m ${secs}s`;
    return `${secs}s`;
  }

  function metric(question, keys, fallback = 0) {
    const metrics = firstDefined(question, ["metrics", "metric"], {});
    return firstDefined(question, keys, firstDefined(metrics, keys, fallback));
  }

  function normalizeReview(payload) {
    const review = firstDefined(payload, ["review"], payload) || {};
    const content = firstDefined(review, ["test", "content"], state.test || review);
    let baseQuestions = flattenQuestions(content);
    const resultQuestions = firstDefined(review, ["questions", "results", "items"], []);
    const resultsById = new Map((Array.isArray(resultQuestions) ? resultQuestions : []).map((question) => [firstDefined(question, ["id", "question_id", "questionId"]), question]));
    if (!baseQuestions.length && Array.isArray(resultQuestions)) {
      baseQuestions = resultQuestions.map((question, index) => ({ ...question, id: firstDefined(question, ["id", "question_id", "questionId"]), _number: index + 1, _unit: question.unit || {} }));
    }
    const questions = baseQuestions.map((question, index) => {
      const result = resultsById.get(question.id) || question;
      const chosen = firstDefined(result, ["chosenAnswer", "chosen_answer", "selectedAnswer", "selected_answer", "choice"]);
      const correct = firstDefined(result, ["correctAnswer", "correct_answer", "key"]);
      const unanswered = Boolean(firstDefined(result, ["unanswered", "is_unanswered"], !chosen));
      const isCorrect = Boolean(firstDefined(result, ["isCorrect", "is_correct", "correct"], chosen && correct && chosen === correct));
      const questionSecondsValue = metric(result, ["activeTimeSeconds", "active_time_seconds", "active_seconds", "question_time_seconds"], null);
      const unitSecondsValue = metric(result, ["unitActiveTimeSeconds", "unit_active_time_seconds", "unit_seconds"], null);
      const questionSeconds = questionSecondsValue === null
        ? (metric(result, ["activeTimeMs", "active_time_ms"], null) === null ? null : Number(metric(result, ["activeTimeMs", "active_time_ms"], null)) / 1000)
        : Number(questionSecondsValue);
      const unitSeconds = unitSecondsValue === null
        ? (metric(result, ["unitActiveTimeMs", "unit_active_time_ms"], null) === null ? null : Number(metric(result, ["unitActiveTimeMs", "unit_active_time_ms"], null)) / 1000)
        : Number(unitSecondsValue);
      const visits = Number(metric(result, ["visits", "visit_count"], 0));
      const skips = Number(metric(result, ["skips", "skip_count"], 0));
      const changes = firstDefined(result, ["answerHistory", "answer_history", "changes"], []);
      const threshold = Number(firstDefined(result, ["slowThresholdSeconds", "slow_threshold_seconds"], firstDefined(review, ["slowThresholdSeconds", "slow_threshold_seconds"], Number(firstDefined(content, ["durationSeconds", "duration_seconds"], 7200)) / Math.max(1, baseQuestions.length))));
      return {
        ...question,
        ...result,
        id: question.id || firstDefined(result, ["id", "question_id", "questionId"]),
        _number: index + 1,
        _unit: question._unit || result.unit || {},
        chosen, correct, unanswered, isCorrect, questionSeconds, unitSeconds, visits, skips, changes,
        timingProvenance: firstDefined(result, ["timingProvenance", "timing_provenance"], "unavailable"),
        visitDurations: firstDefined(result, ["visitDurations", "visit_durations"], []),
        answerPersistenceStatus: firstDefined(result, ["answerPersistenceStatus", "answer_persistence_status"], chosen ? "recorded" : "no_answer_recorded"),
        recoveredDataStatus: firstDefined(result, ["recoveredDataStatus", "recovered_data_status"], "unavailable"),
        slow: Boolean(firstDefined(result, ["slow", "is_slow"], questionSeconds !== null && questionSeconds > threshold)),
        note: firstDefined(result, ["note", "review_note"], ""),
      };
    });
    return { review, content, questions };
  }

  async function loadReview() {
    try {
      const payload = await api(`/attempts/${encodeURIComponent(state.attempt.id)}/review`);
      state.review = normalizeReview(payload);
      state.reviewQuestions = state.review.questions;
      state.reviewIndex = 0;
      state.filter = "all";
      state.hideReviewAnswers = localStorage.getItem("stat-mock-hide-review-answers") === "true";
      el["review-hide-answers"].checked = state.hideReviewAnswers;
      localStorage.setItem(storageKey(STORAGE_KEY), state.attempt.id);
      renderResults();
    } catch (error) {
      setError(error);
    }
  }

  function reviewScoreText(review, questions) {
    const summary = firstDefined(review, ["summary", "score", "totals"], review);
    const totalCorrect = Number(firstDefined(summary, ["rawTotal", "raw_total", "raw", "correct", "total_correct"], questions.filter((q) => q.isCorrect).length));
    const total = Number(firstDefined(summary, ["questionCount", "question_count", "total"], questions.length));
    const verbal = firstDefined(summary, ["verbalTotal", "verbal_total", "verbal"]);
    const quantitative = firstDefined(summary, ["quantitativeTotal", "quantitative_total", "quantitative"]);
    let text = `${totalCorrect} of ${total} correct`;
    if (verbal !== undefined && quantitative !== undefined) text += ` · Verbal ${verbal} · Quantitative ${quantitative}`;
    const timing = review.attempt?.timing;
    if (timing) {
      text += ` · Active ${formatDuration(Number(timing.activeTimeMs || 0) / 1000)} (${timing.provenance}${timing.incomplete ? ", incomplete" : ""})`;
      text += ` · Wall span ${formatDuration(Number(timing.wallSpanMs || 0) / 1000)}`;
      if (timing.knownPausedTimeMs) text += ` · Known paused ${formatDuration(timing.knownPausedTimeMs / 1000)}`;
    }
    return text;
  }

  function renderResults() {
    clearInterval(state.timerId);
    document.title = "Test results — STAT mock test";
    el["app-title"].textContent = "STAT mock test";
    el["results-test-title"].textContent = firstDefined(state.review.content, ["title", "name"], "STAT mock test");
    Statistics.render(el["results-statistics"], state.review, (index) => {
      state.reviewIndex = index;
      state.filter = "all";
      renderReview();
      renderReviewQuestion();
    });
    const linked = state.review.review.linkedAttempts;
    if (linked) {
      const isTimed = Number(state.attempt.id) === linked.original_attempt_id;
      el["results-test-title"].textContent += isTimed ? " — Timed submission" : " — After blind review";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "button button-neutral";
      button.textContent = isTimed ? "View blind review submission" : "View timed submission";
      button.addEventListener("click", async () => {
        state.attempt = { id: isTimed ? linked.review_attempt_id : linked.original_attempt_id };
        await loadReview();
      });
      el["results-statistics"].append(button);
    }
    setView("results");
    el["results-heading"].focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }

  function renderReview() {
    clearInterval(state.timerId);
    document.title = "Test review — STAT mock test";
    el["app-title"].textContent = "STAT mock test";
    el["review-summary"].textContent = reviewScoreText(state.review.review, state.reviewQuestions);
    [...el["review-filters"].querySelectorAll("button")].forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.filter === state.filter));
    });
    renderReviewGrid();
    setView("review");
    renderReviewQuestion(false);
  }

  function matchesFilter(question) {
    if (state.filter === "wrong") return !question.isCorrect;
    if (state.filter === "unfair") return Boolean(question.autoCredit);
    if (state.filter === "slow") return question.slow;
    if (state.filter === "skipped") return question.skips > 0;
    return true;
  }

  function renderReviewGrid() {
    el["review-grid"].replaceChildren();
    let matches = 0;
    state.reviewQuestions.forEach((question, index) => {
      if (!matchesFilter(question)) return;
      matches += 1;
      const status = question.autoCredit ? "Unfair — credit awarded" : question.isCorrect ? "Correct" : (question.answerPersistenceStatus === "not_recorded" ? "Answer not recorded" : (question.unanswered ? "Unanswered" : "Incorrect"));
      const button = document.createElement("button");
      button.type = "button";
      button.className = `${question.isCorrect ? "is-correct" : "is-wrong"}${index === state.reviewIndex ? " is-selected" : ""}`;
      button.setAttribute("aria-label", `Question ${index + 1}: ${status}${question.slow ? ", slow" : ""}${question.skips ? ", skipped" : ""}`);
      button.setAttribute("aria-current", index === state.reviewIndex ? "true" : "false");
      const number = document.createElement("span");
      number.textContent = String(index + 1);
      const text = document.createElement("span");
      text.className = "grid-status";
      text.textContent = status;
      button.append(number, text);
      if (question.slow || question.skips) {
        const flags = document.createElement("span");
        flags.className = "grid-flags";
        flags.textContent = [question.slow ? "Slow" : "", question.skips ? "Skipped" : ""].filter(Boolean).join(" · ");
        button.append(flags);
      }
      button.addEventListener("click", () => {
        if (index === state.reviewIndex) return;
        transitionQuestion(() => {
          flushNote();
          state.reviewIndex = index;
          renderReviewGrid();
          renderReviewQuestion();
        });
      });
      el["review-grid"].append(button);
    });
    el["filter-empty"].hidden = matches !== 0;
    el["review-detail"].hidden = matches === 0;
  }

  function renderReviewQuestion(moveFocus = true) {
    const question = state.reviewQuestions[state.reviewIndex];
    if (!question || !matchesFilter(question)) {
      const first = state.reviewQuestions.findIndex(matchesFilter);
      if (first < 0) return;
      state.reviewIndex = first;
      renderReviewGrid();
      return renderReviewQuestion(moveFocus);
    }
    const unit = question._unit || {};
    el["review-unit-question-count"].textContent = unitQuestionCount(unit, state.reviewQuestions, question);
    el["review-prompt"].closest(".question-region").scrollTop = 0;
    setTrustedHtml(el["review-stimulus"], stimulusFor(unit, question));
    setTrustedHtml(el["review-prompt"], firstDefined(question, ["promptHtml", "prompt_html", "prompt", "stemHtml", "stem_html"], ""));
    el["review-question-number"].textContent = `Question ${state.reviewIndex + 1}`;
    el["review-options"].replaceChildren();
    optionsFor(question).forEach(([letter, html]) => {
      const row = document.createElement("div");
      row.className = "review-option";
      const correct = !state.hideReviewAnswers && letter === question.correct;
      const chosen = !state.hideReviewAnswers && letter === question.chosen;
      if (correct) row.classList.add("is-correct");
      if (chosen && !correct) row.classList.add("is-chosen-wrong");
      const key = document.createElement("div");
      key.className = "review-option-key";
      key.textContent = letter;
      const copy = document.createElement("div");
      setTrustedHtml(copy, html);
      if (correct || chosen) {
        const mark = document.createElement("span");
        mark.className = "answer-mark";
        mark.textContent = correct && chosen ? "Your answer · Correct answer" : (correct ? "Correct answer" : "Your answer");
        copy.append(mark);
      }
      row.append(key, copy);
      el["review-options"].append(row);
    });
    el["review-metrics"].textContent = metricsText(question);
    el["review-answer-line"].textContent = question.autoCredit
      ? `Unfair question — full credit awarded automatically. ${question.unfairReason}${state.hideReviewAnswers ? " · Answers hidden for practice" : ` · Your answer: ${question.chosen || "—"} · Published answer: ${question.correct || "—"}`}`
      : state.hideReviewAnswers
      ? `${question.isCorrect ? "Correct" : question.answerPersistenceStatus === "not_recorded" ? "Answer not recorded — persistence uncertain" : question.unanswered ? "Unanswered" : "Incorrect"} · Answers hidden for practice`
      : question.answerPersistenceStatus === "not_recorded"
      ? `Answer not recorded — persistence uncertain; no choice was recovered · Correct answer: ${question.correct || "—"}`
      : question.unanswered
      ? `${question.answerPersistenceStatus === "explicitly_unanswered" ? "Explicitly left unanswered" : "No answer recorded"} · Correct answer: ${question.correct || "—"}`
      : `Your answer: ${question.chosen || "—"} · Correct answer: ${question.correct || "—"} · ${question.isCorrect ? "Correct" : "Incorrect"}`;
    el["review-note"].closest(".note-field").hidden = state.hideReviewAnswers;
    const pendingNote = localStorage.getItem(noteKey(state.attempt.id, question.id));
    el["review-note"].value = pendingNote === null ? (question.note || "") : pendingNote;
    el["note-status"].textContent = pendingNote === null ? "Notes save automatically." : "Unsynced note recovered; saving…";
    if (pendingNote !== null) state.noteTimer = setTimeout(flushNote, 0);
    if (moveFocus) {
      el["review-question-number"].setAttribute("tabindex", "-1");
      el["review-question-number"].focus({ preventScroll: true });
      el["review-detail"].scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function changeText(changes) {
    if (!changes) return "";
    if (typeof changes === "string") return changes;
    if (!Array.isArray(changes) || !changes.length) return "";
    const values = changes.map((item) => typeof item === "string" ? item : firstDefined(item, ["choice", "answer", "to"])).filter(Boolean);
    return values.length > 1 ? `changed ${values.join(" → ")}` : "";
  }

  function metricsText(question) {
    const provenance = question.timingProvenance;
    const parts = [
      question.questionSeconds === null
        ? `Question timing unavailable (${provenance})`
        : `${formatDuration(question.questionSeconds)} question active (${provenance})`,
      question.unitSeconds === null
        ? "Unit timing incomplete"
        : `${formatDuration(question.unitSeconds)} unit active`,
      `${question.visits} ${question.visits === 1 ? "visit" : "visits"}`,
      question.skips === 0 ? "not skipped" : `skipped ${question.skips === 1 ? "once" : question.skips === 2 ? "twice" : `${question.skips} times`}`,
    ];
    const changed = state.hideReviewAnswers ? "" : changeText(question.changes);
    const visitTimes = question.visitDurations.map((visit) => formatDuration(visit.durationMs / 1000));
    if (visitTimes.length) parts.push(`visit times ${visitTimes.join(", ")}`);
    if (changed) parts.push(changed);
    if (question.slow) parts.push("slow");
    return parts.join(" · ");
  }

  function scheduleNoteSave() {
    clearTimeout(state.noteTimer);
    el["note-status"].textContent = "Saving…";
    const question = state.reviewQuestions[state.reviewIndex];
    if (question) localStorage.setItem(noteKey(state.attempt.id, question.id), el["review-note"].value);
    state.noteTimer = setTimeout(flushNote, 600);
  }

  async function flushNote() {
    clearTimeout(state.noteTimer);
    const question = state.reviewQuestions[state.reviewIndex];
    if (!question || !state.attempt?.id) return;
    const note = el["review-note"].value;
    const attemptId = state.attempt.id;
    const key = noteKey(attemptId, question.id);
    if (note === (question.note || "") && !state.noteSavePending) return;
    state.noteSavePending += 1;
    try {
      const saving = state.noteSaveQueue.then(() => api(`/attempts/${encodeURIComponent(attemptId)}/reviews/${encodeURIComponent(question.id)}`, {
        method: "PUT",
        body: JSON.stringify({ note }),
        keepalive: true,
      }));
      state.noteSaveQueue = saving.catch(() => {});
      await saving;
      question.note = note;
      if (localStorage.getItem(key) === note) localStorage.removeItem(key);
      if (state.attempt.id === attemptId && state.reviewQuestions[state.reviewIndex] === question && el["review-note"].value === note) el["note-status"].textContent = "Note saved.";
    } catch (_) {
      if (state.attempt.id === attemptId && state.reviewQuestions[state.reviewIndex] === question && el["review-note"].value === note) el["note-status"].textContent = "Note not saved. Keep this page open and try again.";
    } finally {
      state.noteSavePending -= 1;
    }
  }

  el["app-title"].addEventListener("click", () => {
    if (state.view === "exam" || state.view === "finish") {
      accrueTimer();
      stopTimingVisit();
      state.enteredQuestionId = null;
      state.visible = false;
      clearInterval(state.timerId);
      processMutations(true);
    }
    // The home link reloads the list; retain the outbox but skip automatic resume.
    localStorage.removeItem(storageKey(STORAGE_KEY));
  });

  el["review-questions"].addEventListener("click", () => {
    renderReview();
    el["review-heading"].setAttribute("tabindex", "-1");
    el["review-heading"].focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  });
  el["view-statistics"].addEventListener("click", () => {
    flushNote();
    renderResults();
  });

  el["back-button"].addEventListener("click", () => {
    if (state.view === "finish") returnToExam();
    else if (state.view === "exam") navigateTo(state.index - 1);
  });

  el["forward-button"].addEventListener("click", () => {
    if (state.view === "finish") submitAttempt("user");
    else if (state.view === "exam" && state.index === state.questions.length - 1) showFinish();
    else if (state.view === "exam") navigateTo(state.index + 1);
  });

  el["review-filters"].addEventListener("click", (eventObject) => {
    const button = eventObject.target.closest("button[data-filter]");
    if (!button) return;
    transitionQuestion(() => {
      flushNote();
      state.filter = button.dataset.filter;
      const first = state.reviewQuestions.findIndex(matchesFilter);
      if (first >= 0 && !matchesFilter(state.reviewQuestions[state.reviewIndex])) state.reviewIndex = first;
      [...el["review-filters"].querySelectorAll("button")].forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
      renderReviewGrid();
      renderReviewQuestion(false);
    });
  });

  el["review-hide-answers"].addEventListener("change", () => {
    state.hideReviewAnswers = el["review-hide-answers"].checked;
    localStorage.setItem("stat-mock-hide-review-answers", String(state.hideReviewAnswers));
    renderReviewQuestion(false);
  });

  el["review-note"].addEventListener("input", scheduleNoteSave);
  el["review-note"].addEventListener("blur", flushNote);
  el["retry-button"].addEventListener("click", boot);
  el["prompt-content"].addEventListener("click", (eventObject) => {
    followSourceReference(eventObject, el["prompt-content"], el["stimulus-content"]);
  });
  el["review-prompt"].addEventListener("click", (eventObject) => {
    followSourceReference(eventObject, el["review-prompt"], el["review-stimulus"]);
  });

  document.addEventListener("visibilitychange", () => {
    accrueTimer();
    if (state.view !== "exam" && state.view !== "finish") return;
    const question = state.questions[state.index];
    if (document.hidden) {
      queueTimingSample();
      state.visible = false;
      clearInterval(state.timerId);
      if (state.view === "exam" && question) event("visibility_hidden", question.id, question._unit?.id || null);
      processMutations(true);
    } else {
      state.visible = true;
      state.timerLastPerformanceMs = performance.now();
      state.timingStartAt = Date.now();
      state.timingStartPerformanceMs = performance.now();
      if (state.view === "exam" && question) event("visibility_visible", question.id, question._unit?.id || null);
      startTimer();
    }
  });

  window.addEventListener("pagehide", () => {
    accrueTimer();
    queueTimingSample();
    state.visible = false;
    if (state.view === "exam" || state.view === "finish") processMutations(true);
    if (state.view === "review") flushNote();
  });

  boot();
})();
