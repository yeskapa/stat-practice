const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

// Exercise the real review renderer without a browser or a running server.
function setup(payload = {}) {
  const nodes = new Map();
  function element() {
    return {
      children: [], textContent: "", className: "", value: "", listeners: {}, style: {}, dataset: {},
      classList: { add(name) { this.names.push(name); }, toggle() {}, names: [] },
      focus() { this.focused = true; }, scrollIntoView() {},
      append(...children) {
        this.children = this.children.filter((item) => !children.includes(item));
        this.children.push(...children);
      },
      insertBefore(child, before) {
        this.children = this.children.filter((item) => item !== child);
        this.children.splice(this.children.indexOf(before), 0, child);
      },
      replaceChildren() { this.children = []; },
      querySelectorAll() { return []; },
      querySelector() { return null; },
      closest() { return this; },
      setAttribute(name, value) { this[name] = value; },
      addEventListener(name, callback) { this.listeners[name] = callback; },
    };
  }
  const storage = new Map();
  const requests = [];
  const context = vm.createContext({
    FormData,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => payload };
    },
    clearInterval() {}, clearTimeout() {}, setTimeout() {}, setInterval() {},
    performance: { now: () => 1000 },
    crypto: { randomUUID: require("node:crypto").randomUUID },
    document: {
      hidden: false,
      body: element(),
      getElementById(id) {
        if (!nodes.has(id)) nodes.set(id, element());
        return nodes.get(id);
      },
      createElement: element,
      addEventListener() {},
    },
    window: { addEventListener() {}, scrollTo() {} },
    localStorage: { get length() { return storage.size; }, key: (index) => [...storage.keys()][index] ?? null, getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
  });
  const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../web/statistics.js"), "utf8"), context);
  vm.runInContext(source.replace("  boot();", "  globalThis.reviewTest = { state, renderStart, renderReviewQuestion, renderReviewGrid, loadReview, submitAttempt, processMutations, showFinish, transitionQuestion, setView, renderTimer, unitQuestionCount, normalizeReview, recoverTimedOutAttempt, flushNote, configureStorage, storageKey, durableKey, noteKey, readDurable, persistDurable, boot };"), context);
  const { state, renderReviewQuestion, renderReviewGrid } = context.reviewTest;
  state.attempt = { id: "attempt" };
  context.reviewTest.configureStorage({ id: "test-installation", legacyStorageAllowed: false });
  state.reviewQuestions = [{
    id: "q1", options: { A: "Alpha", B: "Bravo", C: "Charlie", D: "Delta" },
    chosen: "A", correct: "B", isCorrect: false, unanswered: false,
    answerPersistenceStatus: "recorded", changes: ["C", "A"],
    questionSeconds: 20, unitSeconds: 30, visits: 1, skips: 0,
    timingProvenance: "measured", visitDurations: [],
  }];
  return { state, nodes, storage, requests, context, window: context.window, ...context.reviewTest };
}

function controlledAnimations(node) {
  const animations = [];
  node.animate = (frames, options) => {
    const animation = { frames, options, cancelled: false, cancel() { this.cancelled = true; } };
    animation.finished = new Promise((resolve, reject) => { animation.finish = resolve; animation.fail = reject; });
    animations.push(animation);
    return animation;
  };
  return animations;
}

test("two installations with attempt ID 1 cannot replay each other's outbox, active pointer or notes", async () => {
  const { state, storage, requests, configureStorage, storageKey, durableKey, noteKey, readDurable, persistDurable, processMutations } = setup();
  const oldRecord = { attemptId: 1, answers: { oldQuestion: { choice: "A" } },
    outbox: [{ kind: "answer", questionId: "oldQuestion", choice: "A" }], position: 4, openVisit: null };
  storage.set("stat-mock-sync-1", JSON.stringify(oldRecord));
  storage.set("stat-mock-active-attempt", "1");
  storage.set("stat-note-1-q1", "Legacy note");
  configureStorage({ id: "installation-a", legacyStorageAllowed: false });
  state.attempt = { id: 1, status: "active" };
  state.durable = oldRecord;
  persistDurable();
  storage.set(storageKey("stat-mock-active-attempt"), "1");
  storage.set(noteKey(1, "q1"), "Installation A note");
  const firstOutboxKey = durableKey(1);
  configureStorage({ id: "installation-b", legacyStorageAllowed: false });
  state.durable = readDurable(1);
  assert.equal(state.durable.outbox.length, 0);
  assert.equal(Object.keys(state.durable.answers).length, 0);
  assert.equal(storage.get(storageKey("stat-mock-active-attempt")), undefined);
  assert.equal(storage.get(noteKey(1, "q1")), undefined);
  await processMutations();
  assert.equal(requests.length, 0);
  assert.equal(storage.get(firstOutboxKey), JSON.stringify(oldRecord));
  assert.equal(storage.get("stat-mock-sync-1"), JSON.stringify(oldRecord));
});

test("authorized legacy migration copies records once without overwriting scoped entries or deleting originals", () => {
  const { storage, configureStorage, storageKey, durableKey, noteKey, readDurable } = setup();
  const legacy = JSON.stringify({ attemptId: 1, answers: {}, outbox: [{ kind: "answer", questionId: "q1" }] });
  storage.set("stat-mock-active-attempt", "1");
  storage.set("stat-mock-sync-1", legacy);
  storage.set("stat-note-1-q1", "Old draft");
  storage.set("stat-mock:legacy-installation:stat-note-1-q1", "Newer draft");
  configureStorage({ id: "legacy-installation", legacyStorageAllowed: true });
  assert.equal(storage.get(storageKey("stat-mock-active-attempt")), "1");
  assert.equal(storage.get(durableKey(1)), legacy);
  assert.equal(readDurable(1).outbox.length, 1);
  assert.equal(storage.get(noteKey(1, "q1")), "Newer draft");
  assert.equal(storage.get("stat-note-1-q1"), "Old draft");
  storage.delete(storageKey("stat-mock-active-attempt"));
  configureStorage({ id: "legacy-installation", legacyStorageAllowed: true });
  assert.equal(storage.has(storageKey("stat-mock-active-attempt")), false);
  assert.equal(storage.get("stat-mock-active-attempt"), "1");
});

test("boot establishes installation identity before reading tests or restoring an attempt", async () => {
  const { state, storage, context, boot } = setup();
  const order = [];
  storage.set("stat-mock-active-attempt", "1");
  context.fetch = async (url) => {
    order.push(url);
    return { ok: true, json: async () => url === "/api/installation"
      ? { id: "fresh-database", legacyStorageAllowed: false } : [] };
  };
  await boot();
  assert.deepEqual(order, ["/api/installation", "/api/tests"]);
  assert.equal(state.view, "start");
  assert.equal(state.installationId, "fresh-database");
});

test("navigation waits for the full fade before replacing content and ignores repeated clicks", async () => {
  const { state, nodes, transitionQuestion } = setup();
  state.view = "exam";
  const region = nodes.get("exam-view");
  const animations = controlledAnimations(region);
  let displayedQuestion = 1;
  const navigation = transitionQuestion(() => { displayedQuestion = 2; });
  await transitionQuestion(() => { displayedQuestion = 3; });
  assert.equal(displayedQuestion, 1);
  assert.equal(region.inert, true);
  assert.equal(animations.length, 1);
  assert.equal(animations[0].options.duration, 500);
  assert.equal(animations[0].frames[1].opacity, 0);
  animations[0].finish();
  await new Promise(setImmediate);
  assert.equal(displayedQuestion, 2);
  assert.equal(animations.length, 2);
  assert.equal(animations[1].options.duration, 500);
  assert.equal(animations[1].frames[1].opacity, 1);
  assert.equal(state.navigating, true);
  animations[1].finish();
  await navigation;
  assert.equal(state.navigating, false);
  assert.equal(Boolean(region.inert), false);
  assert.equal(nodes.get("question-heading").focused, true);
  assert.ok(animations.every((animation) => animation.cancelled));
});

test("timer expiry invalidates a pending transition and prevents further navigation during recovery", async () => {
  const app = setup();
  app.state.view = "exam";
  app.state.attempt.status = "active";
  app.context.fetch = () => new Promise(() => {});
  const animations = controlledAnimations(app.nodes.get("exam-view"));
  let replaced = false;
  const navigation = app.transitionQuestion(() => { replaced = true; });
  app.recoverTimedOutAttempt();
  await app.transitionQuestion(() => { replaced = true; });
  animations[0].finish();
  await navigation;
  await app.transitionQuestion(() => { replaced = true; });
  assert.equal(replaced, false);
  assert.equal(app.nodes.get("forward-button").disabled, true);
  assert.equal(app.state.navigating, false);
});

test("rendering failure restores interaction and displays the error instead of rejecting an event handler", async () => {
  const { state, nodes, transitionQuestion } = setup();
  state.view = "exam";
  const region = nodes.get("exam-view");
  const animations = controlledAnimations(region);
  const navigation = transitionQuestion(() => { throw new Error("Question unavailable"); });
  animations[0].finish();
  await navigation;
  assert.equal(state.view, "error");
  assert.equal(nodes.get("error-message").textContent, "Question unavailable");
  assert.equal(state.navigating, false);
  assert.equal(Boolean(region.inert), false);
});

test("review note saves stay ordered and cannot clear newer drafts or update another question's status", async () => {
  const { state, nodes, storage, context, flushNote } = setup();
  const pending = [];
  context.fetch = (url, options) => new Promise((resolve) => pending.push({
    note: JSON.parse(options.body).note,
    complete: () => resolve({ ok: true, json: async () => ({}) }),
  }));
  const note = nodes.get("review-note");
  const question = state.reviewQuestions[0];
  question.note = "Original";
  note.value = "First edit";
  storage.set("stat-mock:test-installation:stat-note-attempt-q1", note.value);
  const first = flushNote();
  await new Promise(setImmediate);
  note.value = "Original";
  storage.set("stat-mock:test-installation:stat-note-attempt-q1", note.value);
  const latest = flushNote();
  assert.equal(pending.length, 1);
  state.reviewQuestions.push({ id: "q2" });
  state.reviewIndex = 1;
  note.value = "Other question draft";
  nodes.get("note-status").textContent = "Other question status";
  pending[0].complete();
  await first;
  await new Promise(setImmediate);
  assert.equal(storage.get("stat-mock:test-installation:stat-note-attempt-q1"), "Original");
  assert.equal(pending.length, 2);
  assert.equal(pending[1].note, "Original");
  assert.equal(nodes.get("note-status").textContent, "Other question status");
  pending[1].complete();
  await latest;
  assert.equal(question.note, "Original");
  assert.equal(storage.has("stat-mock:test-installation:stat-note-attempt-q1"), false);
  assert.equal(nodes.get("note-status").textContent, "Other question status");
});

test("navigation cannot replace another view or attempt after its fade completes", async () => {
  for (const leave of [({ setView }) => setView("results"), ({ state }) => { state.attempt = { id: "another" }; }]) {
    const app = setup();
    app.state.view = "exam";
    const animations = controlledAnimations(app.nodes.get("exam-view"));
    let replaced = false;
    const navigation = app.transitionQuestion(() => { replaced = true; });
    leave(app);
    animations[0].finish();
    await navigation;
    assert.equal(replaced, false);
    assert.equal(app.state.navigating, false);
    assert.equal(animations.length, 1);
  }
});

test("reduced motion replaces content immediately and canceled animations release navigation", async () => {
  const { state, nodes, window, transitionQuestion } = setup();
  state.view = "exam";
  const animations = controlledAnimations(nodes.get("exam-view"));
  window.matchMedia = () => ({ matches: true });
  let replacements = 0;
  await transitionQuestion(() => { replacements += 1; });
  assert.equal(replacements, 1);
  assert.equal(animations.length, 0);
  window.matchMedia = () => ({ matches: false });
  const navigation = transitionQuestion(() => { replacements += 1; });
  animations[0].fail(Object.assign(new Error("Canceled"), { name: "AbortError" }));
  await navigation;
  assert.equal(replacements, 1);
  assert.equal(state.navigating, false);
  assert.equal(animations[0].cancelled, true);
});

test("unit counts use source units, review counts, and explicit unit IDs without grouping unknown units", () => {
  const { unitQuestionCount, normalizeReview } = setup();
  assert.equal(unitQuestionCount({ questions: [{}, {}] }, []), "There are 2 questions in this unit.");
  const normalized = normalizeReview({ review: { questions: [
    { id: "a", unitId: "unit-a", unitQuestionCount: 3 },
  ] } });
  assert.equal(unitQuestionCount({}, normalized.questions, normalized.questions[0]), "There are 3 questions in this unit.");
  const questions = [{ unitId: "a" }, { unitId: "a" }, { unitId: "b" }, {}];
  assert.equal(unitQuestionCount({}, questions, questions[0]), "There are 2 questions in this unit.");
  assert.equal(unitQuestionCount({}, questions, questions[2]), "There is 1 question in this unit.");
  assert.equal(unitQuestionCount({}, questions, questions[3]), "There is 1 question in this unit.");
});

test("seven-segment timer preserves a readable accessible clock at low time and zero", () => {
  const { nodes, renderTimer } = setup();
  for (const [seconds, clock] of [[7200, "02:00:00"], [9, "00:00:09"], [0, "00:00:00"]]) {
    renderTimer(seconds);
    const timer = nodes.get("timer");
    assert.equal(timer["aria-label"], clock);
    assert.equal((timer.innerHTML.match(/<svg/g) || []).length, 8);
    assert.equal((timer.innerHTML.match(/aria-hidden="true"/g) || []).length, 8);
    assert.doesNotMatch(timer.innerHTML, /undefined|NaN/);
  }
});

test("unfair questions are listed with automatic credit and a reason", () => {
  const { state, nodes, renderReviewQuestion, renderReviewGrid } = setup();
  Object.assign(state.reviewQuestions[0], {
    autoCredit: true, isCorrect: true, unfairReason: "Unstated room-sharing assumption.",
  });
  state.filter = "unfair";
  renderReviewGrid();
  assert.equal(nodes.get("review-grid").children.length, 1);
  renderReviewQuestion();
  assert.match(nodes.get("review-answer-line").textContent, /full credit awarded automatically/);
  assert.match(nodes.get("review-answer-line").textContent, /Unstated room-sharing assumption/);
  state.hideReviewAnswers = true;
  renderReviewQuestion();
  assert.doesNotMatch(nodes.get("review-answer-line").textContent, /Published answer/);
  state.filter = "wrong";
  renderReviewGrid();
  assert.equal(nodes.get("review-grid").children.length, 0);
});

test("test list shows completion dates alongside scores", () => {
  const { state, nodes, renderStart } = setup();
  const submittedAt = new Date(2026, 9, 17, 12).getTime();
  state.tests = [
    { title: "Finished paper", questionCount: 70, durationSeconds: 7200,
      attempt: { status: "submitted", submittedAt, totals: { raw: 59 } } },
    { title: "Legacy paper", questionCount: 70, durationSeconds: 7200,
      attempt: { status: "expired", totals: { raw: 42 } } },
    { title: "Unstarted paper", questionCount: 70, durationSeconds: 7200, attempt: null },
  ];
  renderStart();
  const items = nodes.get("test-list").children;
  const date = new Date(submittedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  assert.equal(items[0].children[0].children[2].textContent, `Completed on ${date} · 59 of 70 correct`);
  assert.equal(items[1].children[0].children[2].textContent, "Completed · 42 of 70 correct");
  assert.equal(items[2].children[0].children.length, 2);
});

test("practice toggle hides answer indicators, choice history, and notes, and restores them", () => {
  const { state, nodes, storage, renderReviewQuestion, renderReviewGrid } = setup();
  const toggle = nodes.get("review-hide-answers");
  state.reviewQuestions[0].note = "Remember to compare both values.";
  renderReviewQuestion(false);
  assert.equal(nodes.get("review-note").closest(".note-field").hidden, false);
  assert.match(nodes.get("review-answer-line").textContent, /Your answer: A · Correct answer: B/);
  assert.match(nodes.get("review-metrics").textContent, /changed C → A/);

  toggle.checked = true;
  toggle.listeners.change();
  assert.equal(nodes.get("review-note").closest(".note-field").hidden, true);
  assert.equal(nodes.get("review-note").value, "Remember to compare both values.");
  assert.equal(storage.get("stat-mock-hide-review-answers"), "true");
  assert.equal(nodes.get("review-answer-line").textContent, "Incorrect · Answers hidden for practice");
  assert.doesNotMatch(nodes.get("review-metrics").textContent, /changed/);
  assert.match(nodes.get("review-metrics").textContent, /question active/);
  const rows = nodes.get("review-options").children;
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.equal(row.classList.names.length, 0);
    assert.equal(row.children[1].children.length, 0);
  }
  assert.equal(rows[0].children[1].innerHTML, "Alpha");
  renderReviewGrid();
  assert.equal(nodes.get("review-grid").children[0].children[1].textContent, "Incorrect");

  toggle.checked = false;
  toggle.listeners.change();
  assert.equal(nodes.get("review-note").closest(".note-field").hidden, false);
  assert.equal(nodes.get("review-note").value, "Remember to compare both values.");
  assert.equal(storage.get("stat-mock-hide-review-answers"), "false");
  assert.match(nodes.get("review-answer-line").textContent, /Your answer: A · Correct answer: B/);
  assert.equal(nodes.get("review-options").children[0].classList.names[0], "is-chosen-wrong");
  assert.equal(nodes.get("review-options").children[1].classList.names[0], "is-correct");
});

test("hidden review retains correct, unanswered and missing-answer outcomes", () => {
  const { state, nodes, renderReviewQuestion } = setup();
  state.hideReviewAnswers = true;
  const question = state.reviewQuestions[0];
  for (const [updates, expected] of [
    [{ isCorrect: true }, "Correct"],
    [{ isCorrect: false, unanswered: true }, "Unanswered"],
    [{ answerPersistenceStatus: "not_recorded" }, "Answer not recorded — persistence uncertain"],
  ]) {
    Object.assign(question, updates);
    renderReviewQuestion(false);
    assert.equal(nodes.get("review-answer-line").textContent, `${expected} · Answers hidden for practice`);
  }
});

test("completed results open with statistics and support round trips through question review", async () => {
  const { state, nodes, loadReview } = setup({
    test: { title: "Completed paper", durationSeconds: 100 }, totals: { raw: 1, verbal: 1, quantitative: 0 },
    questions: [
      { id: "q1", selectedAnswer: "A", correctAnswer: "A", correct: true, category: "verbal",
        activeTimeMs: 40000, timingProvenance: "recorded", visits: 2,
        visitDurations: [{ durationMs: 30000 }, { durationMs: 10000 }] },
      { id: "q2", selectedAnswer: "A", correctAnswer: "B", correct: false },
      { id: "q3", correctAnswer: "B", correct: false, unanswered: true },
      { id: "q4", correctAnswer: "B", correct: false, unanswered: true, answerPersistenceStatus: "not_recorded" },
    ],
  });
  await loadReview();
  assert.equal(state.view, "results");
  assert.equal(nodes.get("results-view").hidden, false);
  assert.equal(nodes.get("review-view").hidden, true);
  assert.equal(nodes.get("exam-footer").hidden, true);
  assert.equal(nodes.get("results-test-title").textContent, "Completed paper");
  const statistics = nodes.get("results-statistics");
  assert.deepEqual(statistics.children.map((item) => item.children[0]?.textContent), [
    "Your result", "Where your time went", "Question review", "Time, result and returns",
    "Verbal and quantitative", "Does returning help?", "Detailed breakdown",
  ]);
  const walk = (item) => [item, ...item.children.flatMap(walk)];
  const elements = walk(statistics);
  const timeRows = elements.filter((item) => item.className === "statistics-time-row");
  assert.equal(timeRows[0].children[1].children[0].textContent, "1 of 4 · 25.0%");
  assert.equal(timeRows[0].children[2].children[0].textContent, "0:40 · 100.0%");
  assert.equal(timeRows[0].children[2].children[1].children[0].style.width, "100%");
  assert.equal(timeRows[1].children[2].children[0].textContent, "Timing unavailable");
  const metric = elements.find((item) => item.className === "statistics-metrics");
  assert.equal(metric.children[0].children[1].textContent, "25.0%");
  assert.equal(metric.children[1].children[1].textContent, "2/4");
  assert.ok(elements.some((item) => item.textContent.includes("not recorded reliably")));
  const categories = elements.filter((item) => item.className === "statistics-comparison");
  assert.equal(categories[0].children[2].textContent, "100.0%");
  const yAxis = elements.find((item) => item.className === "statistics-y-axis");
  assert.equal(yAxis.children[0].textContent, "0:00");
  assert.equal(yAxis.children.at(-1).textContent, "0:40");
  const chartButtons = elements.filter((item) => item.className === "statistics-column");
  assert.deepEqual(chartButtons.map((item) => item.tabIndex), [0, -1, -1, -1]);
  chartButtons[1].listeners.mouseenter();
  const readout = elements.find((item) => item.className === "statistics-chart-readout");
  assert.match(readout.textContent, /Question 2: Incorrect.*timing unavailable/);
  assert.equal(readout["aria-live"], undefined);
  chartButtons[1].focus = chartButtons[1].listeners.focus;
  let prevented = false;
  chartButtons[0].listeners.keydown({ key: "ArrowRight", preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(chartButtons.map((item) => item.tabIndex), [-1, 0, -1, -1]);
  assert.match(readout.textContent, /Question 2/);
  const split = elements.find((item) => item.className === "statistics-return");
  assert.equal(split.hidden, undefined);
  assert.equal(split.style.height, "25%");
  assert.equal(elements.filter((item) => item.type === "checkbox").length, 0);
  const disclosures = elements.filter((item) => item.children[0]?.textContent === "Detailed breakdown");
  assert.equal(disclosures.length, 1);
  assert.equal(elements.filter((item) => item.children[0]?.textContent === "Does returning help?").length, 1);
  const selects = elements.filter((item) => item.listeners.change && item.children.some((child) => child.value === "missed" || child.value === "time"));
  const filter = selects[0];
  const queue = statistics.children.find((item) => item.children[0]?.textContent === "Question review").children.at(-1);
  const queueRows = () => walk(queue).find((item) => item.className === "statistics-table").children.at(-1).children;
  assert.equal(queueRows().length, 3);
  filter.value = "all";
  filter.listeners.change();
  assert.equal(queueRows().length, 4);
  assert.equal(queueRows()[0].children[0].children[0].textContent, "Question 1");
  assert.equal(queueRows()[0].children[3].children[0].children[1].children[0].style.width, "100%");
  filter.value = "slow";
  filter.listeners.change();
  assert.equal(queueRows().length, 1);
  filter.value = "returned";
  filter.listeners.change();
  assert.equal(queueRows().length, 1);
  assert.equal(queueRows()[0].children[0].children[0].textContent, "Question 1");
  filter.value = "skipped";
  filter.listeners.change();
  assert.equal(queue.children[0].textContent, "No questions match this view.");
  filter.value = "correct";
  filter.listeners.change();
  assert.equal(queueRows().length, 1);
  const graphButton = walk(statistics).find((item) => item["aria-label"]?.startsWith("Question 2:"));
  graphButton.listeners.click();
  assert.equal(state.view, "review");
  assert.equal(state.reviewIndex, 1);
  assert.equal(state.filter, "all");
  nodes.get("view-statistics").listeners.click();
  nodes.get("review-questions").listeners.click();
  assert.equal(state.view, "review");
  state.reviewIndex = 1;
  state.filter = "wrong";
  nodes.get("view-statistics").listeners.click();
  assert.equal(state.view, "results");
  nodes.get("review-questions").listeners.click();
  assert.equal(state.view, "review");
  assert.equal(state.reviewIndex, 1);
  assert.equal(state.filter, "wrong");
});

test("time comparison preserves zero, partial and unavailable measurements and ranks missed questions", async () => {
  const { nodes, loadReview } = setup({
    test: { title: "Mixed timing", durationSeconds: 180 },
    questions: [
      { id: "q1", selectedAnswer: "A", correctAnswer: "A", correct: true, activeTimeMs: 0, timingProvenance: "recorded" },
      { id: "q2", selectedAnswer: "B", correctAnswer: "A", correct: false, activeTimeMs: 30000, timingProvenance: "recorded" },
      { id: "q3", selectedAnswer: "B", correctAnswer: "A", correct: false, activeTimeMs: 90000, timingProvenance: "incomplete" },
      { id: "q4", correct: false, unanswered: true },
    ],
  });
  await loadReview();
  const walk = (item) => [item, ...item.children.flatMap(walk)];
  const elements = walk(nodes.get("results-statistics"));
  const rows = elements.filter((item) => item.className === "statistics-time-row");
  assert.equal(rows[0].children[2].children[0].textContent, "0:00 · 0.0%");
  assert.equal(rows[1].children[1].children[0].textContent, "2 of 4 · 50.0%");
  assert.equal(rows[1].children[2].children[0].textContent, "2:00 · 100.0%");
  assert.equal(rows[2].children[2].children[0].textContent, "Timing unavailable");
  const queue = elements.find((item) => item.className === "statistics-question-list");
  const table = walk(queue).find((item) => item.className === "statistics-table");
  assert.deepEqual(table.children[1].children.map((row) => row.children[0].children[0].textContent), ["Question 3", "Question 2", "Question 4"]);
  assert.equal(table.children[1].children[1].children[3].children[0].children[1].children[0].style.width, `${100 / 3}%`);
  assert.equal(queue.children[0].tabIndex, 0);
  assert.equal(queue.children[0]["aria-label"], "Question review table");
});

for (const view of ["exam", "finish"]) {
  test(`header exit from ${view} stops timing and preserves the resumable outbox`, async () => {
    const { state, nodes, storage, requests } = setup({ id: "attempt", status: "active", answers: {} });
    state.view = view;
    state.attempt.status = "active";
    state.durable = { attemptId: "attempt", answers: { q1: { choice: "A" } }, outbox: [], openVisit: null };
    state.timingVisit = { visitId: "visit", questionId: view === "exam" ? "q1" : null };
    state.timingStartPerformanceMs = 500;
    state.timingStartAt = Date.now() - 500;
    storage.set("stat-mock:test-installation:stat-mock-active-attempt", "attempt");
    nodes.get("app-title").listeners.click();
    assert.equal(storage.has("stat-mock:test-installation:stat-mock-active-attempt"), false);
    assert.equal(state.timingVisit, null);
    assert.equal(state.visible, false);
    const saved = JSON.parse(storage.get("stat-mock:test-installation:stat-mock-sync-attempt"));
    assert.equal(saved.answers.q1.choice, "A");
    assert.equal(saved.openVisit, null);
    assert.ok(saved.outbox.some((item) => item.kind === "timing" && item.elapsedMs === 500));
    assert.equal(requests[0].url, "/api/attempts/attempt/sync");
    assert.equal(JSON.parse(requests[0].options.body).submit, false);
  });
}

for (const mode of ['submit', 'timeout']) {
  test(`${mode} enters blind review without requesting feedback`, async () => {
    const payload = { id: 9, test_id: 'sample', status: 'active', blindReview: true,
      remaining_ms: 1200000, answers: { q1: { choice: 'A', revision: 1, mutationId: 'saved' } } };
    const { state, nodes, storage, requests, submitAttempt, processMutations, showFinish } = setup(payload);
    state.attempt = { id: 8, status: 'active', blindReviewPlanned: true };
    state.test = { id: 'sample' };
    state.questions = [{ id: 'q1', options: { A: 'Alpha', B: 'Bravo', C: 'Charlie', D: 'Delta' },
      _unit: { id: 'u1' } }];
    state.answers = { q1: 'A' };
    state.view = 'exam';
    state.durable = { attemptId: 8, answers: { q1: { choice: 'A', revision: 1, mutationId: 'saved' } },
      outbox: [], position: 0, openVisit: null };
    if (mode === 'submit') await submitAttempt();
    else {
      state.durable.outbox.push({ kind: 'timing', sampleId: 'last', visitId: 'visit', elapsedMs: 5000 });
      await processMutations();
    }
    assert.equal(state.attempt.id, 9);
    assert.equal(state.view, 'exam', nodes.get('error-message').textContent);
    assert.equal(state.timerRemainingMs, 1200000);
    assert.equal(state.answers.q1, 'A');
    assert.equal(storage.get('stat-mock:test-installation:stat-mock-active-attempt'), 9);
    assert.equal(nodes.get('app-title').textContent, 'Blind review — 20 minutes');
    assert.ok(requests.every((r) => !r.url.endsWith('/review')));
    showFinish();
    assert.equal(nodes.get('forward-button').textContent, 'Finish and reveal results');
    await Promise.resolve();
  });
}
