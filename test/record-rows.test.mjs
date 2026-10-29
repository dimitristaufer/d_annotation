import test from "node:test";
import assert from "node:assert/strict";
import { mergeRecordRowsById, uniqueRecordRows } from "../src/lib/record-rows.mjs";

test("search rows keep distinct records even when their text is identical", () => {
  const first = { id: "source-a:1", text: "same message" };
  const second = { id: "source-b:1", text: "same message" };
  assert.deepEqual(uniqueRecordRows([first, second]), [first, second]);
});

test("duplicate record IDs are rendered once, preserving their first result position", () => {
  const first = { id: "a", text: "first occurrence" };
  const second = { id: "b", text: "another record" };
  const repeated = { id: "a", text: "overlapping page copy" };
  assert.deepEqual(uniqueRecordRows([first, second, repeated]), [first, second]);
});

test("overlapping search pages append only new record IDs", () => {
  const existing = [{ id: "a", text: "A" }, { id: "b", text: "B" }];
  const next = [{ id: "b", text: "duplicate page row" }, { id: "c", text: "C" }];
  assert.deepEqual(mergeRecordRowsById(existing, next), [existing[0], existing[1], next[1]]);
});
