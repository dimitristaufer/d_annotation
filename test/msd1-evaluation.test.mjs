import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MSD1_TEST_SETTINGS, binaryMsd1Counts, effectiveMsd1Label, filterMsd1ReviewerRecords, filterMsd1RowsByMinimumConfidence, scoreMsd1Agreement, validateMsd1ChoiceAnswer } from "../src/lib/msd1-evaluation.mjs";

test("MSD1 test defaults distinguish embedded transcripts, requested characters, and topic-only mentions", () => {
  assert.deepEqual(DEFAULT_MSD1_TEST_SETTINGS.optionOrder, ["yes", "no", "unclear"]);
  assert.match(DEFAULT_MSD1_TEST_SETTINGS.instructions, /embedded transcript/);
  assert.match(DEFAULT_MSD1_TEST_SETTINGS.instructions, /future turn/);
  assert.match(DEFAULT_MSD1_TEST_SETTINGS.instructions, /organization name alone does not count/);
  assert.match(DEFAULT_MSD1_TEST_SETTINGS.criteria.yes, /human\/fictional characters/);
  assert.match(DEFAULT_MSD1_TEST_SETTINGS.criteria.no, /organization alone is insufficient/);
});

test("MSD1 choice validation requires three supported probabilities", () => {
  assert.deepEqual(validateMsd1ChoiceAnswer({
    type: "choice",
    choice: "no",
    probabilities: { yes: 0.1, no: 0.8, unclear: 0.1, ignored: 0.2 },
  }), { choice: "no", probabilities: { yes: 0.1, no: 0.8, unclear: 0.1 } });
  assert.throws(() => validateMsd1ChoiceAnswer({ type: "choice", choice: "uncertain", probabilities: { yes: 0, no: 0, unclear: 1 } }), /unsupported/);
  assert.throws(() => validateMsd1ChoiceAnswer({ type: "choice", choice: "yes", probabilities: { yes: 1, no: 0 } }), /probabilities/);
});

test("low confidence thresholds recode only Yes/No decisions as Unclear", () => {
  assert.equal(effectiveMsd1Label({ choice: "yes", probabilities: { yes: 0.62 } }, 0.65), "unclear");
  assert.equal(effectiveMsd1Label({ choice: "no", probabilities: { no: 0.9 } }, 0.65), "no");
  assert.equal(effectiveMsd1Label({ choice: "unclear", probabilities: { unclear: 0.2 } }, 0.95), "unclear");
});

test("minimum confidence includes only successful predictions meeting the selected-label probability", () => {
  const rows = [
    { recordId: "high", humanLabel: "yes", choice: "yes", confidence: 0.91 },
    { recordId: "boundary", humanLabel: "no", choice: "no", confidence: 0.8 },
    { recordId: "low", humanLabel: "yes", choice: "no", confidence: 0.79 },
    { recordId: "failed", humanLabel: "no", error: "request failed" },
  ];
  assert.deepEqual(filterMsd1RowsByMinimumConfidence(rows, 0.8).map((row) => row.recordId), ["high", "boundary"]);
  const filteredScore = scoreMsd1Agreement(filterMsd1RowsByMinimumConfidence(rows, 0.8));
  assert.equal(filteredScore.agreements, 2);
  assert.equal(filteredScore.compared, 2);
  assert.equal(filteredScore.percent, 100);
  assert.deepEqual(filterMsd1RowsByMinimumConfidence(rows, 1.1).map((row) => row.recordId), []);
  assert.deepEqual(filterMsd1RowsByMinimumConfidence(rows, Number.NaN).map((row) => row.recordId), ["high", "boundary", "low"]);
});

test("MSD1 test sets can select fully annotated, partially annotated, or all labeled human records", () => {
  const records = [
    { recordId: "full-yes", annotationCompleteness: "fully" },
    { recordId: "full-no", annotationCompleteness: "fully" },
    { recordId: "partial-yes", annotationCompleteness: "partially" },
  ];
  assert.deepEqual(filterMsd1ReviewerRecords(records).map((record) => record.recordId), ["full-yes", "full-no"]);
  assert.deepEqual(filterMsd1ReviewerRecords(records, "partially").map((record) => record.recordId), ["partial-yes"]);
  assert.deepEqual(filterMsd1ReviewerRecords(records, "all").map((record) => record.recordId), ["full-yes", "full-no", "partial-yes"]);
});

test("agreement scoring maps MSD1 Unclear to Kirsten Uncertain and ignores failed calls", () => {
  const score = scoreMsd1Agreement([
    { humanLabel: "yes", choice: "yes", probabilities: { yes: 0.9 } },
    { humanLabel: "uncertain", choice: "unclear", probabilities: { unclear: 0.7 } },
    { humanLabel: "no", choice: "yes", probabilities: { yes: 0.7 } },
    { humanLabel: "yes", error: "request failed" },
  ]);
  assert.equal(score.agreements, 2);
  assert.equal(score.compared, 3);
  assert.equal(score.percent, 2 / 3 * 100);
  assert.equal(score.decisiveCompared, 2);
  assert.equal(score.decisiveAgreements, 1);
  assert.equal(score.confusion.uncertain.uncertain, 1);
});

test("binary confusion counts treat human Yes/No as reference and exclude Unclear", () => {
  const score = scoreMsd1Agreement([
    { humanLabel: "yes", choice: "yes", probabilities: { yes: 0.9 } },
    { humanLabel: "no", choice: "yes", probabilities: { yes: 0.9 } },
    { humanLabel: "yes", choice: "no", probabilities: { no: 0.9 } },
    { humanLabel: "no", choice: "no", probabilities: { no: 0.9 } },
    { humanLabel: "uncertain", choice: "yes", probabilities: { yes: 0.9 } },
    { humanLabel: "yes", choice: "unclear", probabilities: { unclear: 0.9 } },
  ]);

  assert.deepEqual(binaryMsd1Counts(score.confusion), {
    truePositives: 1,
    falsePositives: 1,
    falseNegatives: 1,
    trueNegatives: 1,
  });
});
