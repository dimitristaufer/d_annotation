import test from "node:test";
import assert from "node:assert/strict";
import { matchReferentsByMention, multisetDifference } from "../src/lib/annotation-differences.mjs";

test("pairs the same referent by mention even when the taxonomy labels differ", () => {
  const result = matchReferentsByMention(
    [{ mention: "beautiful women", type: "Human groups" }],
    [{ mention: "the beautiful women", type: "Fictional or hypothetical people" }],
  );

  assert.deepEqual(result, { pairs: [{ leftIndex: 0, rightIndex: 0 }], unmatchedLeft: [], unmatchedRight: [] });
});

test("does not pair different referents merely because their taxonomy labels match", () => {
  const result = matchReferentsByMention(
    [{ mention: "William Wegman", type: "Public figures" }],
    [{ mention: "fallen enemies", type: "Public figures" }],
  );

  assert.deepEqual(result, { pairs: [], unmatchedLeft: [0], unmatchedRight: [0] });
});

test("multiset differences retain duplicate label counts", () => {
  assert.deepEqual(
    multisetDifference(["Public figures", "Human groups", "Human groups"], ["Public figures", "Fictional people"]),
    { leftOnly: ["Human groups", "Human groups"], rightOnly: ["Fictional people"] },
  );
});

test("multiset differences can compare normalized labels", () => {
  assert.deepEqual(
    multisetDifference([" Public figures  "], ["public figures"], (label) => label.trim().toLowerCase()),
    { leftOnly: [], rightOnly: [] },
  );
});
