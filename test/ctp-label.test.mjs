import assert from "node:assert/strict";
import test from "node:test";
import { isCtpLabel, partitionCtpRecordIds } from "../src/lib/ctp-label.mjs";

test("accepts only the pinned MSD1 Contains CTPs labels", () => {
  assert.equal(isCtpLabel("yes"), true);
  assert.equal(isCtpLabel("no"), true);
  assert.equal(isCtpLabel("unclear"), true);
  assert.equal(isCtpLabel("uncertain"), false);
  assert.equal(isCtpLabel(null), false);
});

test("partitions records from saved labels and fails closed for unlabeled IDs", () => {
  const labels = { yes: "yes", no: "no", unclear: "unclear" };
  assert.deepEqual(partitionCtpRecordIds(["yes", "no", "unclear", "outside", "yes"], labels), {
    yesRecordIds: ["yes"],
    no: 1,
    unclear: 1,
    unlabeled: 1,
  });
});
