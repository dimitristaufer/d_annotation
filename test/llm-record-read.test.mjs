import test from "node:test";
import assert from "node:assert/strict";
import { buildLlmRecordReadRequest } from "../src/lib/llm-record-read.mjs";

test("LLM annotation record reads include context and the pinned CTP label", () => {
  assert.deepEqual(buildLlmRecordReadRequest("wc:123"), {
    recordId: "wc:123",
    includeContext: true,
    includeCtpLabel: true,
  });
});
