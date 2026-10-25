/* Deterministic completion analysis, also loaded directly by the Node tests. */
((root) => {
  "use strict";
  const percent = (part, total) => total ? `${(100 * part / total).toFixed(1)}%` : "—";
  const seconds = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const median = (values) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const outcome = (q) => q.autoCredit ? "Correct" : q.answerPersistenceStatus === "not_recorded" ? "Uncertain"
    : q.isCorrect ? "Correct" : q.unanswered ? "Unanswered" : "Incorrect";
  const completeTime = (q) => seconds(q.questionSeconds) && ["recorded", "reconstructed"].includes(q.timingProvenance);
  const category = (q) => q.category === "verbal" ? "Verbal" : q.category === "quantitative" ? "Quantitative" : "Uncategorised";

  function summarize(questions) {
    const times = questions.filter(completeTime).map((q) => q.questionSeconds);
    return {
      total: questions.length,
      correct: questions.filter((q) => outcome(q) === "Correct").length,
      incorrect: questions.filter((q) => outcome(q) === "Incorrect").length,
      unanswered: questions.filter((q) => outcome(q) === "Unanswered").length,
      uncertain: questions.filter((q) => outcome(q) === "Uncertain").length,
      knownTime: questions.reduce((sum, q) => sum + (seconds(q.questionSeconds) ? q.questionSeconds : 0), 0),
      timed: times.length, median: median(times),
      mean: times.length ? times.reduce((a, b) => a + b, 0) / times.length : null,
    };
  }

  function analyze(review) {
    const questions = review.questions || [];
    const duration = review.content?.durationSeconds;
    const budget = seconds(duration) && duration > 0 ? duration : null;
    const allowance = budget && questions.length ? budget / questions.length : null;
    const groups = (key) => {
      const result = new Map();
      questions.forEach((q, i) => {
        const name = key(q, i);
        if (!result.has(name)) result.set(name, []);
        result.get(name).push(q);
      });
      return [...result].map(([name, items]) => ({ name, items, ...summarize(items) }));
    };
    const changes = { gained: [], lost: [], wrongToWrong: [], eligible: 0, changed: 0 };
    questions.forEach((q, index) => {
      const history = q.changes || [];
      const edits = history.filter((h) => h && typeof h === "object" && h.from != null && h.from !== h.to);
      if (edits.length) changes.changed += 1;
      // Require a continuous history from initial selection to the saved final answer.
      if (q.autoCredit || !edits.length || outcome(q) === "Uncertain" || !q.chosen || !q.correct || !history.length
          || !history[0] || typeof history[0] !== "object" || history[0].from != null
          || !history[0].to || history.at(-1).to !== q.chosen) return;
      if (history.some((h, i) => !h || typeof h !== "object" || !h.to || (i && h.from !== history[i - 1].to))) return;
      changes.eligible += 1;
      const firstCorrect = history[0].to === q.correct;
      if (!firstCorrect && q.isCorrect) changes.gained.push(index);
      else if (firstCorrect && !q.isCorrect) changes.lost.push(index);
      else if (!firstCorrect && !q.isCorrect) changes.wrongToWrong.push(index);
    });
    // Missing visit records are not evidence that a question was answered in one visit.
    const baseline = summarize(questions.filter((q) => q.visits === 1 && q.skips === 0 && outcome(q) !== "Uncertain"));
    const baselineRate = baseline.total ? baseline.correct / baseline.total : null;
    const returnGroup = (name, items) => {
      const known = items.filter((q) => outcome(q) !== "Uncertain");
      const summary = summarize(known);
      const rate = summary.total ? summary.correct / summary.total : null;
      return {
        name, items: known, ...summary, rate, excluded: items.length - known.length,
        difference: rate !== null && baselineRate !== null ? 100 * (rate - baselineRate) : null,
        relative: rate !== null && baselineRate > 0 ? rate / baselineRate : null,
      };
    };
    const returns = [
      returnGroup("One visit, no skips", questions.filter((q) => q.visits === 1 && q.skips === 0)),
      returnGroup("Revisited", questions.filter((q) => q.visits > 1)),
      returnGroup("Skipped then returned", questions.filter((q) => q.visits > 1 && q.skips > 0)),
    ];
    return {
      questions, ...summarize(questions), budget, allowance, changes, returns,
      unknownVisits: questions.filter((q) => !(q.visits >= 1)).length,
      categories: groups(category),
      blocks: groups((q, i) => `${Math.floor(i / 10) * 10 + 1}–${Math.min(questions.length, Math.floor(i / 10) * 10 + 10)}`),
      units: groups((q, i) => q.unitId || q._unit?.id || `Question ${i + 1}`),
      outcomes: groups(outcome),
      revisited: questions.filter((q) => q.visits > 1),
      recovered: questions.filter((q) => q.skips > 0 && q.chosen && outcome(q) !== "Uncertain"),
      slow: allowance === null ? [] : questions.filter((q) => completeTime(q) && q.questionSeconds > allowance),
      fast: allowance === null ? [] : questions.filter((q) => completeTime(q) && q.questionSeconds <= allowance),
    };
  }

  function render(container, review, openQuestion) {
    container.replaceChildren();
    const data = analyze(review);
    const { questions } = data;
    const node = (tag, text, className) => {
      const item = document.createElement(tag);
      if (text !== undefined) item.textContent = text;
      if (className) item.className = className;
      return item;
    };
    const time = (value) => {
      if (!seconds(value)) return "—";
      const rounded = Math.round(value);
      return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
    };
    const section = (title, expandable = false) => {
      const item = node(expandable ? "details" : "section", undefined, "statistics-section");
      item.append(node(expandable ? "summary" : "h2", title));
      container.append(item);
      return item;
    };
    const table = (parent, headers, rows, caption) => {
      const wrap = node("div", undefined, "statistics-scroll");
      const item = node("table", undefined, "statistics-table");
      if (caption) item.append(node("caption", caption));
      const head = node("thead");
      const tr = node("tr");
      headers.forEach((title) => { const th = node("th", title); th.setAttribute("scope", "col"); tr.append(th); });
      head.append(tr);
      const body = node("tbody");
      rows.forEach((row) => {
        const line = node("tr");
        row.forEach((value) => {
          const cell = node("td");
          if (typeof value === "object" && value !== null) cell.append(value);
          else cell.textContent = String(value);
          line.append(cell);
        });
        body.append(line);
      });
      item.append(head, body); wrap.append(item); parent.append(wrap);
      return body;
    };
    const link = (q, index = questions.indexOf(q)) => {
      const button = node("button", `Question ${index + 1}`, "statistics-link");
      button.type = "button";
      button.addEventListener("click", () => openQuestion(index));
      return button;
    };
    const outcomeBar = (items) => {
      const bar = node("div", undefined, "statistics-outcomes");
      const counts = summarize(items);
      const labels = [["Correct", counts.correct], ["Incorrect", counts.incorrect], ["Unanswered", counts.unanswered], ["Uncertain", counts.uncertain]];
      bar.setAttribute("role", "img");
      bar.setAttribute("aria-label", items.length ? labels.map(([label, n]) => `${n} ${label.toLowerCase()}`).join(", ") : "No question outcomes available");
      labels.forEach(([label, n]) => {
        if (!n) return;
        const segment = node("span", undefined, `outcome-${label.toLowerCase()}`);
        segment.style.width = `${100 * n / items.length}%`;
        segment.title = `${label}: ${n} (${percent(n, items.length)})`;
        bar.append(segment);
      });
      return bar;
    };

    const timing = review.review?.attempt?.timing;
    const active = seconds(timing?.activeTimeMs) ? timing.activeTimeMs / 1000 : null;
    const overview = section("Your result");
    const metrics = node("dl", undefined, "statistics-metrics");
    [
      ["Correct", percent(data.correct, data.total), `${data.correct} of ${data.total} questions`],
      ["Answered", `${data.correct + data.incorrect}/${data.total}`, "Recorded answers"],
      ["Active time", time(active), `of ${time(data.budget)} available`],
      ["Typical question", time(data.median), "Median active time"],
    ].forEach(([label, value, detail]) => {
      const group = node("div");
      group.append(node("dt", label), node("dd", value), node("dd", detail, "statistics-note"));
      metrics.append(group);
    });
    overview.append(metrics, outcomeBar(questions));
    const legend = node("dl", undefined, "statistics-legend");
    [["Correct", data.correct], ["Incorrect", data.incorrect], ["Unanswered", data.unanswered], ["Uncertain", data.uncertain]].forEach(([label, count]) => {
      if (label === "Uncertain" && !count) return;
      const item = node("div");
      item.append(node("dt", label), node("dd", `${count} · ${percent(count, data.total)}`));
      legend.append(item);
    });
    overview.append(legend);
    if (data.uncertain) overview.append(node("p", `${data.uncertain} ${data.uncertain === 1 ? "answer was" : "answers were"} not recorded reliably. These are shown separately from unanswered questions.`, "statistics-note"));
    const known = questions.filter((q) => seconds(q.questionSeconds)).length;
    const reconstructed = questions.filter((q) => q.timingProvenance === "reconstructed").length;
    const incomplete = questions.filter((q) => q.timingProvenance === "incomplete").length;
    if (incomplete || known < data.total || timing?.incomplete) overview.append(node("p", "Some timing records are missing or incomplete. Available measurements are shown below.", "statistics-note"));
    const unattributed = active === null ? null : active - data.knownTime;
    const timingDetail = node("div");
    timingDetail.append(node("h3", `Timing · ${data.timed} of ${data.total} complete`));
    table(timingDetail, ["Measure", "Value"], [
      ["Mean question time", time(data.mean)],
      ["Time remaining", time(active !== null && data.budget !== null ? Math.max(0, data.budget - active) : null)],
      ["Wall span", time(seconds(timing?.wallSpanMs) ? timing.wallSpanMs / 1000 : null)],
      ["Known paused time", time(seconds(timing?.knownPausedTimeMs) ? timing.knownPausedTimeMs / 1000 : null)],
      ["Accuracy on recorded answers", percent(data.correct, data.correct + data.incorrect)],
      ["Attempt timing source", timing?.provenance || "Unavailable"],
    ]);
    timingDetail.append(node("p", `Time available for ${known}/${data.total} questions; ${reconstructed} reconstructed, ${incomplete} incomplete. ${unattributed === null ? "" : unattributed >= 0 ? `Time not attributed to questions: ${time(unattributed)}. ` : "Question times exceed the active total; timing totals do not reconcile. "}${timing?.incomplete ? "Attempt timing is incomplete. " : ""}Missing time stays unknown. Medians and pace comparisons exclude partial timings.`, "statistics-note"));

    const timeUse = section("Where your time went");
    timeUse.append(node("p", "Share of questions compared with share of known question time", "statistics-note"));
    const timeHead = node("div", undefined, "statistics-time-heading");
    timeHead.append(node("span", "Result"), node("span", "Questions"), node("span", "Known active time"));
    timeUse.append(timeHead);
    ["Correct", "Incorrect", "Unanswered", "Uncertain"].forEach((name) => {
      const group = data.outcomes.find((g) => g.name === name);
      if (!group) return;
      const row = node("div", undefined, "statistics-time-row");
      row.append(node("strong", name));
      [[group.total, data.total, `${group.total} of ${data.total} · ${percent(group.total, data.total)}`],
        [group.knownTime, data.knownTime, `${time(group.knownTime)} · ${percent(group.knownTime, data.knownTime)}`]].forEach(([value, total, label], index) => {
        const cell = node("div", undefined, "statistics-time-measure");
        const hasTime = group.items.some((q) => seconds(q.questionSeconds));
        cell.append(node("span", index === 1 && !hasTime ? "Timing unavailable" : label));
        const track = node("div", undefined, "statistics-measure-track");
        track.setAttribute("aria-hidden", "true");
        const fill = node("span", undefined, `outcome-${name.toLowerCase()}`);
        fill.style.width = total ? `${100 * value / total}%` : "0%";
        track.append(fill); cell.append(track); row.append(cell);
      });
      timeUse.append(row);
    });
    timeUse.append(node("p", `${known ? time(data.knownTime) : "No known time"} attributed to questions · ${data.timed}/${data.total} complete question timings. Includes partial records and shared-stimulus reading.`, "statistics-note"));

    const graphSection = section("Time, result and returns");
    const chartKey = node("div", undefined, "statistics-chart-key");
    ["Correct", "Incorrect", "Unanswered", "Uncertain"].forEach((name) => {
      const label = node("span", name);
      const swatch = node("span", undefined, `statistics-key-swatch outcome-${name.toLowerCase()}`);
      swatch.setAttribute("aria-hidden", "true"); label.append(swatch); chartKey.append(label);
    });
    graphSection.append(chartKey);
    const maximum = Math.max(1, data.allowance || 0, ...questions.filter((q) => seconds(q.questionSeconds)).map((q) => q.questionSeconds));
    const step = [5, 10, 15, 30, 60, 120, 300, 600, 1200, 3600].find((v) => v >= maximum / 4) || Math.ceil(maximum / 4);
    const scale = Math.ceil(maximum / step) * step;
    const chart = node("div", undefined, "statistics-chart");
    const yAxis = node("div", undefined, "statistics-y-axis");
    yAxis.setAttribute("aria-label", "Active time, minutes and seconds");
    for (let tick = 0; tick <= scale; tick += step) {
      const label = node("span", time(tick));
      label.style.bottom = `${100 * tick / scale}%`;
      yAxis.append(label);
    }
    const graphScroll = node("div", undefined, "statistics-scroll");
    const plot = node("div", undefined, "statistics-plot");
    plot.style.minWidth = `${Math.max(240, questions.length * 14)}px`;
    for (let tick = step; tick <= scale; tick += step) {
      const rule = node("div", undefined, "statistics-gridline");
      rule.style.bottom = `${100 * tick / scale}%`;
      rule.setAttribute("aria-hidden", "true"); plot.append(rule);
    }
    if (data.allowance !== null) {
      const reference = node("div", undefined, "statistics-reference");
      reference.style.bottom = `${100 * data.allowance / scale}%`;
      reference.setAttribute("aria-hidden", "true"); plot.append(reference);
    }
    const columns = node("div", undefined, "statistics-columns");
    const readout = node("p", "Hover a question for details. Use arrow keys to move between questions; Enter opens review.", "statistics-chart-readout");
    const announcement = node("p", undefined, "sr-only");
    announcement.setAttribute("role", "status");
    announcement.setAttribute("aria-live", "polite");
    const chartButtons = [];
    questions.forEach((q, index) => {
      const value = seconds(q.questionSeconds) ? q.questionSeconds : null;
      const visits = q.visitDurations || [];
      const first = visits[0]?.durationMs;
      const visitSum = visits.reduce((sum, v) => sum + (seconds(v.durationMs) ? v.durationMs : 0), 0);
      const splitAvailable = value !== null && seconds(first) && Math.abs(visitSum / 1000 - value) < 0.01;
      const initial = splitAvailable ? first / 1000 : null;
      const label = `Question ${index + 1}: ${outcome(q)}, ${category(q)}, ${value === null ? "timing unavailable" : `${time(value)} active time (${q.timingProvenance})`}, ${q.visits} visits${splitAvailable ? `; initial recorded visit ${time(initial)}, returns ${time(value - initial)}` : ""}`;
      const column = node("button", undefined, "statistics-column");
      column.type = "button"; column.title = label; column.setAttribute("aria-label", label);
      column.tabIndex = index === 0 ? 0 : -1;
      column.addEventListener("mouseenter", () => { readout.textContent = label; });
      column.addEventListener("focus", () => {
        readout.textContent = label;
        announcement.textContent = label;
        chartButtons.forEach((button, i) => { button.tabIndex = i === index ? 0 : -1; });
      });
      column.addEventListener("keydown", (event) => {
        let next;
        if (event.key === "ArrowRight") next = Math.min(questions.length - 1, index + 1);
        else if (event.key === "ArrowLeft") next = Math.max(0, index - 1);
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = questions.length - 1;
        else return;
        event.preventDefault(); chartButtons[next].focus();
      });
      chartButtons.push(column);
      column.addEventListener("click", () => openQuestion(index));
      const bar = node("span", undefined, `statistics-bar outcome-${outcome(q).toLowerCase()}${completeTime(q) && q.timingProvenance === "recorded" ? "" : " timing-estimated"}`);
      bar.style.height = value === null ? "0%" : `${100 * value / scale}%`;
      const returns = node("span", undefined, "statistics-return");
      returns.style.height = splitAvailable && value > 0 ? `${100 * (value - initial) / value}%` : "0%";
      bar.append(returns);
      column.append(bar, node("span", value === null ? "?" : value === 0 ? "0" : "", "statistics-missing"));
      columns.append(column);
    });
    plot.append(columns); graphScroll.append(plot);
    const axis = node("div", undefined, "statistics-axis");
    axis.style.minWidth = plot.style.minWidth;
    questions.forEach((q, i) => {
      const tick = node("span", i === 0 || (i + 1) % 5 === 0 || i === questions.length - 1 ? String(i + 1) : "");
      axis.append(tick);
    });
    graphScroll.append(axis); chart.append(yAxis, graphScroll); graphSection.append(chart);
    graphSection.append(node("p", data.allowance === null ? "Question number · Average time allowance unavailable" : `Question number · Dashed line: ${time(data.allowance)} average time available`, "statistics-chart-caption"), readout, announcement);
    graphSection.append(node("p", "Select a column to review. Dark portions show return time where visit timings reconcile. Dashed columns: estimated or partial time; ?: unavailable. Time includes stimulus reading.", "statistics-note"));

    const categorySection = section("Verbal and quantitative");
    const groupRows = (groups) => groups.map((g) => [g.name, `${g.correct}/${g.total}`, percent(g.correct, g.total), g.incorrect, g.unanswered, g.uncertain, time(g.knownTime), time(g.median), `${g.timed}/${g.total}`, outcomeBar(g.items)]);
    const headers = ["Group", "Correct", "Correct %", "Incorrect", "Unanswered", "Uncertain", "Known time", "Median", "Complete timings", "Outcomes"];
    const comparisons = node("div", undefined, "statistics-comparisons");
    data.categories.forEach((g) => {
      const row = node("div", undefined, "statistics-comparison");
      const name = node("div", undefined, "statistics-comparison-name");
      name.append(node("h3", g.name), node("span", `${g.correct} of ${g.total} correct`, "statistics-note"));
      const distribution = node("div", undefined, "statistics-comparison-bar");
      distribution.append(outcomeBar(g.items), node("span", `${g.incorrect} incorrect · ${g.unanswered} unanswered${g.uncertain ? ` · ${g.uncertain} uncertain` : ""}`, "statistics-note"));
      const accuracy = node("strong", percent(g.correct, g.total), "statistics-comparison-score");
      const pace = node("div", undefined, "statistics-comparison-pace");
      pace.append(node("span", `${time(g.median)} median`), node("span", `${time(g.knownTime)} known total`, "statistics-note"));
      row.append(name, distribution, accuracy, pace); comparisons.append(row);
    });
    categorySection.append(comparisons);
    const revisitSection = section("Does returning help?");
    const comparisonsByVisit = node("div", undefined, "statistics-comparisons");
    data.returns.forEach((g, i) => {
      const row = node("div", undefined, "statistics-comparison");
      const name = node("div", undefined, "statistics-comparison-name");
      name.append(node("h3", g.name), node("span", `${g.correct} of ${g.total} correct`, "statistics-note"));
      const distribution = node("div", undefined, "statistics-comparison-bar");
      distribution.append(outcomeBar(g.items));
      const score = node("strong", percent(g.correct, g.total), "statistics-comparison-score");
      const delta = g.difference;
      const comparison = i === 0 ? "Comparison group" : delta === null ? "No comparison available"
        : `${delta > 0 ? "+" : ""}${delta.toFixed(1)} percentage points`;
      const difference = node("div", undefined, "statistics-comparison-pace");
      difference.append(node("span", comparison));
      if (i > 0 && g.relative !== null) difference.append(node("span", `${g.relative.toFixed(2)}× one-visit accuracy`, "statistics-note"));
      row.append(name, distribution, score, difference); comparisonsByVisit.append(row);
    });
    revisitSection.append(comparisonsByVisit);
    if (data.changes.eligible) {
      table(revisitSection, ["Answer revisions", "Questions"], [
        ["Incorrect → correct", data.changes.gained.length],
        ["Correct → incorrect", data.changes.lost.length],
        ["Net correct answers gained", data.changes.gained.length - data.changes.lost.length],
      ]);
    }
    revisitSection.append(node("p", "Compared with one-visit accuracy in this attempt. Skipped then returned is part of the revisited group. This association does not show that returning caused better or worse results.", "statistics-note"));
    const excluded = data.returns[0].excluded + data.returns[1].excluded;
    if (excluded || data.unknownVisits) revisitSection.append(node("p", `${excluded} uncertain outcomes and ${data.unknownVisits} questions without visit records excluded from the accuracy comparison.`, "statistics-note"));

    const detail = section("Detailed breakdown", true);
    detail.append(node("p", "Return comparisons use questions with recorded visit counts and reliable final outcomes. Unanswered questions count as not correct. Revisited means more than one recorded visit; skipped then returned also requires a recorded unanswered departure. Percentage points show the accuracy difference; the multiplier divides by one-visit accuracy and is unavailable when that accuracy is zero. Answer revisions use continuous first-to-final histories, including changes within one visit.", "statistics-note"));
    detail.append(timingDetail, node("h3", "Verbal and quantitative"));
    table(detail, headers, groupRows(data.categories));
    detail.append(node("h3", "Time use and answer changes"));
    const knownTotal = data.knownTime;
    table(detail, ["Outcome", "Questions", "Known time", "Share of known question time", "Time distribution"], data.outcomes.map((g) => {
      const bar = node("div", undefined, "statistics-outcomes");
      const fill = node("span", undefined, `outcome-${g.name.toLowerCase()}`);
      fill.style.width = knownTotal ? `${100 * g.knownTime / knownTotal}%` : "0%";
      bar.setAttribute("role", "img");
      bar.setAttribute("aria-label", `${g.name}: ${percent(g.knownTime, knownTotal)} of known question time`);
      bar.append(fill);
      return [g.name, g.total, time(g.knownTime), percent(g.knownTime, knownTotal), bar];
    }));
    if (data.allowance !== null) table(detail, ["Pace group", "Questions", "Correct", "Correct %"], [["At or below average allowance", data.fast], ["Above average allowance", data.slow]].map(([name, items]) => [name, items.length, summarize(items).correct, percent(summarize(items).correct, items.length)]));
    table(detail, ["First recorded → final answer", "Questions"], [["Incorrect → correct", data.changes.gained.length], ["Correct → incorrect", data.changes.lost.length], ["Incorrect → incorrect", data.changes.wrongToWrong.length], ["Correct → correct", data.changes.eligible - data.changes.gained.length - data.changes.lost.length - data.changes.wrongToWrong.length]]);
    const netChange = data.changes.gained.length - data.changes.lost.length;
    if (data.changes.eligible) detail.append(node("p", `Net change: ${netChange >= 0 ? "+" : ""}${netChange} correct answers compared with first recorded selections.`));
    detail.append(node("p", `${data.changes.changed} questions have recorded answer changes; ${data.changes.eligible} have continuous histories used above. These are observations, not evidence that changing an answer causes better or worse performance.`, "statistics-note"));
    const blocks = detail;
    blocks.append(node("h3", "Results by question block"));
    table(blocks, headers, groupRows(data.blocks));
    blocks.append(node("p", "Blocks follow paper order, not elapsed time: questions may have been revisited.", "statistics-note"));
    const units = detail;
    units.append(node("h3", "Results by shared stimulus"));
    table(units, headers, groupRows(data.units.map((g) => ({ ...g, name: `Questions ${g.items.map((q) => questions.indexOf(q) + 1).join(", ")}` }))));

    const queue = section("Question review");
    queue.append(node("p", "Select a question to review it. Active time includes shared-stimulus reading.", "statistics-note"));
    const controls = node("div", undefined, "statistics-controls");
    const filterLabel = node("label", "Show "); const filter = node("select");
    [["missed", "Incorrect, unanswered and uncertain"], ["all", "All questions"], ["correct", "Correct"], ["slow", "Above average time allowance"], ["returned", "Revisited"], ["skipped", "Skipped then returned"]].forEach(([value, title]) => {
      const option = node("option", title); option.value = value; filter.append(option);
    });
    filter.value = "missed"; filterLabel.append(filter);
    const sortLabel = node("label", "Sort "); const sort = node("select");
    [["time", "Longest time first"], ["number", "Question number"], ["visits", "Most visits first"]].forEach(([value, title]) => {
      const option = node("option", title); option.value = value; sort.append(option);
    });
    sort.value = "time"; sortLabel.append(sort); controls.append(filterLabel, sortLabel); queue.append(controls);
    const queueContent = node("div", undefined, "statistics-question-list"); queue.append(queueContent);
    const renderQueue = () => {
      queueContent.replaceChildren();
      const items = questions.filter((q) => filter.value === "all" || (filter.value === "correct" ? outcome(q) === "Correct" : filter.value === "slow" ? data.slow.includes(q) : filter.value === "returned" ? q.visits > 1 : filter.value === "skipped" ? q.visits > 1 && q.skips > 0 : outcome(q) !== "Correct"));
      items.sort((a, b) => sort.value === "number" ? questions.indexOf(a) - questions.indexOf(b) : sort.value === "visits" ? b.visits - a.visits : (seconds(b.questionSeconds) ? b.questionSeconds : -1) - (seconds(a.questionSeconds) ? a.questionSeconds : -1));
      if (!items.length) { queueContent.append(node("p", "No questions match this view.")); return; }
      table(queueContent, ["Question", "Category", "Result", "Active time", "Initial visit", "Return time", "Timing", "Visits", "Changes"], items.map((q) => {
        const visits = q.visitDurations || [];
        const sum = visits.reduce((total, v) => total + (seconds(v.durationMs) ? v.durationMs : 0), 0);
        const canSplit = seconds(q.questionSeconds) && seconds(visits[0]?.durationMs) && Math.abs(sum / 1000 - q.questionSeconds) < 0.01;
        const first = canSplit ? visits[0].durationMs / 1000 : null;
        const duration = node("div", undefined, "statistics-question-time");
        duration.append(node("span", time(q.questionSeconds)));
        const track = node("div", undefined, "statistics-measure-track");
        track.setAttribute("aria-hidden", "true");
        const fill = node("span", undefined, `outcome-${outcome(q).toLowerCase()}`);
        fill.style.width = seconds(q.questionSeconds) ? `${100 * q.questionSeconds / maximum}%` : "0%";
        track.append(fill); duration.append(track);
        return [link(q), category(q), outcome(q), duration, time(first), time(canSplit ? q.questionSeconds - first : null), q.timingProvenance || "unavailable", q.visits >= 1 ? q.visits : "—", (q.changes || []).filter((h) => h && typeof h === "object" && h.from != null && h.from !== h.to).length];
      }));
      const scroll = queueContent.children[0];
      scroll.tabIndex = 0;
      scroll.setAttribute("role", "region");
      scroll.setAttribute("aria-label", "Question review table");
    };
    filter.addEventListener("change", renderQueue); sort.addEventListener("change", renderQueue); renderQueue();
    container.insertBefore(queue, graphSection);
    container.append(detail);
    if (!questions.length) container.append(node("p", "No question results are available for this attempt."));
  }

  root.Statistics = { analyze, render, percent };
  if (typeof module !== "undefined") module.exports = root.Statistics;
})(globalThis);
