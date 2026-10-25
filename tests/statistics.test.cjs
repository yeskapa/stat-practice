const assert = require("node:assert/strict");
const { test } = require("node:test");
const { analyze, percent } = require("../web/statistics.js");

test("automatic credit counts even with an unrecorded answer", () => {
  const data = analyze({ questions: [question({
    autoCredit: true, isCorrect: true, unanswered: true, answerPersistenceStatus: "not_recorded",
  })] });
  assert.equal(data.correct, 1);
  assert.equal(data.uncertain, 0);
  assert.equal(data.unanswered, 0);
});

const question = (overrides = {}) => ({
  category: "verbal", unitId: "u1", isCorrect: false, unanswered: false,
  answerPersistenceStatus: "recorded", timingProvenance: "recorded",
  questionSeconds: 20, chosen: "B", correct: "A", visits: 1, skips: 0,
  changes: [], ...overrides,
});
const review = (questions, durationSeconds = 120) => ({ content: { durationSeconds }, questions });

test("outcomes partition all questions; category percentages use their own denominators", () => {
  const result = analyze(review([
    question({ isCorrect: true, chosen: "A" }),
    question(),
    question({ category: "quantitative", unanswered: true, chosen: null }),
    question({ category: "quantitative", unanswered: true, chosen: null, answerPersistenceStatus: "not_recorded" }),
  ]));
  assert.equal(result.total, 4);
  assert.equal(result.correct, 1);
  assert.equal(result.incorrect, 1);
  assert.equal(result.unanswered, 1);
  assert.equal(result.uncertain, 1);
  assert.equal(result.categories[0].total, 2);
  assert.equal(percent(result.categories[0].correct, result.categories[0].total), "50.0%");
  assert.equal(percent(result.correct, result.correct + result.incorrect), "50.0%");
  assert.equal(result.allowance, 30);
});

test("missing and partial timing do not become zero or contaminate median and pace", () => {
  const result = analyze(review([
    question({ questionSeconds: 0 }),
    question({ questionSeconds: 40, timingProvenance: "reconstructed" }),
    question({ questionSeconds: 200, timingProvenance: "incomplete" }),
    question({ questionSeconds: null, timingProvenance: "unavailable" }),
    question({ questionSeconds: NaN }),
    question({ questionSeconds: -10 }),
  ]));
  assert.equal(result.timed, 2);
  assert.equal(result.median, 20);
  assert.equal(result.mean, 20);
  assert.equal(result.knownTime, 240);
  assert.equal(result.slow.length, 1);
  assert.equal(result.fast.length, 1);
  assert.equal(result.units[0].knownTime, 240);
});

test("answer revision analysis requires continuous initial-to-final histories", () => {
  const history = (...choices) => choices.map((to, i) => ({ from: i ? choices[i - 1] : null, to }));
  const result = analyze(review([
    question({ chosen: "A", isCorrect: true, changes: history("B", "A") }),
    question({ changes: history("A", "B") }),
    question({ changes: history("C", "B") }),
    question({ chosen: "A", isCorrect: true, changes: history("A", "B", "A") }),
    question({ changes: [{ from: "A", to: "B" }] }),
    question({ changes: [{ from: null, to: "A" }, { from: "C", to: "B" }] }),
    question({ changes: history("B", "C") }),
    question({ changes: ["A", "B"] }),
    question({ answerPersistenceStatus: "not_recorded", changes: history("A", "B") }),
  ]));
  assert.equal(result.changes.eligible, 4);
  assert.deepEqual(result.changes.gained, [0]);
  assert.deepEqual(result.changes.lost, [1]);
  assert.deepEqual(result.changes.wrongToWrong, [2]);
});

test("blocks, units, returns and recovered skips are derived from the full attempt", () => {
  const items = Array.from({ length: 23 }, (_, i) => question({ unitId: `u${Math.floor(i / 3)}`, visits: i === 0 ? 3 : 1, skips: i < 2 ? 1 : 0 }));
  const result = analyze(review(items));
  assert.deepEqual(result.blocks.map((b) => [b.name, b.total]), [["1–10", 10], ["11–20", 10], ["21–23", 3]]);
  assert.equal(result.units.length, 8);
  assert.equal(result.units.reduce((sum, g) => sum + g.knownTime, 0), result.knownTime);
  assert.equal(result.revisited.length, 1);
  assert.equal(result.recovered.length, 2);
});

test("empty results and unavailable allowances have no fabricated statistics", () => {
  const empty = analyze(review([]));
  assert.equal(empty.median, null);
  assert.equal(empty.allowance, null);
  assert.equal(percent(0, 0), "—");
  const noBudget = analyze({ questions: [question()] });
  assert.equal(noBudget.budget, null);
  assert.deepEqual(noBudget.slow, []);
});

test("return accuracy compares reliable outcomes with one-visit questions, without double counting skips", () => {
  const result = analyze(review([
    question({ isCorrect: true }), question(),
    question({ visits: 2, isCorrect: true }),
    question({ visits: 3, skips: 1, isCorrect: true }),
    question({ visits: 2, skips: 1, unanswered: true, chosen: null }),
    question({ visits: 2, answerPersistenceStatus: "not_recorded", isCorrect: true }),
    question({ visits: 1, answerPersistenceStatus: "not_recorded" }),
    question({ visits: 0, isCorrect: true }),
    question({ visits: 1, skips: 1 }),
  ]));
  const [baseline, returned, skipped] = result.returns;
  assert.equal(baseline.total, 2);
  assert.equal(baseline.rate, 0.5);
  assert.equal(baseline.excluded, 1);
  assert.equal(returned.total, 3);
  assert.equal(returned.correct, 2);
  assert.equal(returned.excluded, 1);
  assert.ok(Math.abs(returned.difference - 100 / 6) < 1e-10);
  assert.equal(returned.relative, 4 / 3);
  assert.equal(skipped.total, 2);
  assert.equal(skipped.rate, 0.5);
  assert.equal(skipped.difference, 0);
  assert.equal(result.unknownVisits, 1);
});

test("return comparisons handle worse results, absent groups and zero baseline accuracy", () => {
  const worse = analyze(review([question({ isCorrect: true }), question({ visits: 2 })])).returns[1];
  assert.equal(worse.difference, -100);
  assert.equal(worse.relative, 0);
  const zero = analyze(review([question(), question({ visits: 2, isCorrect: true })])).returns[1];
  assert.equal(zero.difference, 100);
  assert.equal(zero.relative, null);
  const noBaseline = analyze(review([question({ visits: 2, isCorrect: true })])).returns[1];
  assert.equal(noBaseline.rate, 1);
  assert.equal(noBaseline.difference, null);
  assert.equal(noBaseline.relative, null);
  for (const group of analyze(review([])).returns) {
    assert.equal(group.rate, null);
    assert.equal(group.difference, null);
    assert.equal(group.relative, null);
  }
});
