import assert from "node:assert/strict";
import test from "node:test";
import { pairwiseAnnotationAgreement } from "../src/lib/pairwise-agreement.mjs";

test("pairwise agreement aggregates comparable fields across all annotator pairs", () => {
  const result = pairwiseAnnotationAgreement(["A", "B", "C"], (left, right) => {
    if (left === "A" && right === "B") return { matches: 2, total: 2 };
    if (left === "A" && right === "C") return { matches: 1, total: 2 };
    return null;
  });
  assert.deepEqual(result, { pairs: 3, comparablePairs: 2, matches: 3, total: 4, percent: 75 });
});

test("pairwise agreement reports unavailable when no annotation pair exists", () => {
  assert.equal(pairwiseAnnotationAgreement(["A"], () => ({ matches: 1, total: 1 })), null);
});

test("pairwise agreement reports unavailable when pairs have no comparable fields", () => {
  assert.deepEqual(pairwiseAnnotationAgreement(["A", "B"], () => null), {
    pairs: 1, comparablePairs: 0, matches: 0, total: 0, percent: null,
  });
});
