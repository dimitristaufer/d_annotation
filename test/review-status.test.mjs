import test from "node:test";
import assert from "node:assert/strict";
import { combineReviewFilterIds, filterHumanAnnotationsToProfiles, filterRowsByReviewSnapshot, humanAnnotationStatusMode, humanReviewStatusMode, idsAnnotatedByHuman, idsWithAtLeastTwoAnnotators, isReviewStatusMode, recordIdsFromSignature, recordIdsSignature, reviewStatusFilterSignature, sampleRecordIds, searchNeedsAnnotationSnapshot } from "../src/lib/review-status.mjs";

test("record ID signatures stay stable across background refreshes with unchanged IDs", () => {
  const first = recordIdsSignature(["b", "a", "a"]);
  const refreshed = recordIdsSignature(["a", "b"]);
  assert.equal(first, refreshed);
  assert.deepEqual(recordIdsFromSignature(first), ["a", "b"]);
  assert.deepEqual(recordIdsFromSignature(""), []);
});

test("review status signatures are stable when annotation refresh changes ID order", () => {
  assert.equal(reviewStatusFilterSignature("partial", ["b", "a", "a"]), reviewStatusFilterSignature("partial", ["a", "b"]));
});

test("review status signatures change when the included record set changes", () => {
  assert.notEqual(reviewStatusFilterSignature("full", ["a", "b"]), reviewStatusFilterSignature("full", ["a"]));
});

test("all annotation queues are recognized as status-filtered views", () => {
  for (const mode of ["partial", "full", "llm_human", "llm_human:Kirsten", "human:Kirsten", "llm_all_humans", "human_2plus"]) {
    assert.equal(isReviewStatusMode(mode), true);
    assert.notEqual(reviewStatusFilterSignature(mode, ["a"]), "");
  }
  assert.equal(isReviewStatusMode("all"), false);
  assert.equal(humanReviewStatusMode("Kirsten"), "llm_human:Kirsten");
  assert.equal(humanAnnotationStatusMode("Kirsten"), "human:Kirsten");
});

test("only annotation-filtered searches wait for the shared annotation snapshot", () => {
  assert.equal(searchNeedsAnnotationSnapshot("all", false), false);
  assert.equal(searchNeedsAnnotationSnapshot("all", true), true);
  assert.equal(searchNeedsAnnotationSnapshot("todo", false), true);
  assert.equal(searchNeedsAnnotationSnapshot("human:Kirsten", false), true);
});

test("per-human queues include that user's partial and full annotations and deduplicate sources", () => {
  const first = {
    partial: { Kirsten: { relevance: "yes", referents: [] } },
    full: { Kirsten: { relevance: "no" } },
    empty: { Kirsten: {} },
    other: { Dimitri: { relevance: "yes" } },
  };
  const second = {
    partial: { "  kirsten ": { relevance: "yes", referents: [] } },
    another: { Kirsten: { decision: "uncertain" } },
  };
  assert.deepEqual(idsAnnotatedByHuman([first, second], "Kirsten", (annotation) => Boolean(annotation.relevance ?? annotation.decision)), ["partial", "full", "another"]);
});

test("two-human queue requires two distinct annotators and de-duplicates sources", () => {
  const local = { recordA: { Kirsten: { relevance: "yes" } }, recordB: { Kirsten: { relevance: "no" } } };
  const shared = { recordA: { Kirsten: { relevance: "yes" }, Dimitri: { relevance: "yes" } }, recordB: { Dimitri: {} } };
  assert.deepEqual(idsWithAtLeastTwoAnnotators([local, shared], (annotation) => Boolean(annotation.relevance)), ["recordA"]);
});

test("human queue samples are deterministic, order-independent, and unique", () => {
  const ids = ["message-5", "message-2", "message-2", "message-4", "message-1", "message-3"];
  const sample = sampleRecordIds(ids, 3, "human-queue-seed");
  assert.equal(sample.length, 3);
  assert.equal(new Set(sample).size, 3);
  assert.deepEqual(sample, sampleRecordIds([...ids].reverse(), 3, "human-queue-seed"));
  assert.notDeepEqual(sample, sampleRecordIds(ids, 3, "different-seed"));
});

test("human queue sampling returns the available pool size and handles empty requests", () => {
  assert.deepEqual(sampleRecordIds(["b", "a", "b"], 10, "seed").sort(), ["a", "b"]);
  assert.deepEqual(sampleRecordIds(["a"], 0, "seed"), []);
  assert.deepEqual(sampleRecordIds([], 4, "seed"), []);
});

test("retired annotator labels are excluded from active queues without deleting saved data", () => {
  const saved = {
    recordA: { Dimitri: { relevance: "yes" }, "Annotator 1": { relevance: "yes" } },
    recordB: { "Annotator 1": { relevance: "yes" } },
  };
  const active = filterHumanAnnotationsToProfiles(saved, ["Dimitri", "Kirsten"]);
  assert.deepEqual(active, {
    recordA: { Dimitri: { relevance: "yes" } },
  });
  assert.deepEqual(idsWithAtLeastTwoAnnotators([active], (annotation) => Boolean(annotation.relevance)), []);
  assert.equal(saved.recordA["Annotator 1"].relevance, "yes");
});

test("annotation filters cannot reintroduce records when a status queue is empty", () => {
  assert.deepEqual(combineReviewFilterIds("partial", [], ["matching-filter"], true), []);
});

test("annotation filters intersect a non-empty review status queue", () => {
  assert.deepEqual(combineReviewFilterIds("partial", ["a", "b"], ["b", "c"], true), ["b"]);
});

test("annotation filters cannot widen a named human queue", () => {
  const mode = humanReviewStatusMode("Kirsten");
  assert.deepEqual(combineReviewFilterIds(mode, ["kirsten"], ["kirsten", "dimitri"], true), ["kirsten"]);
  assert.deepEqual(combineReviewFilterIds(mode, [], ["dimitri"], true), []);
});

test("annotation filters remain independent in an all-status view", () => {
  assert.deepEqual(combineReviewFilterIds("all", [], ["matching-filter"], true), ["matching-filter"]);
});

test("status results keep the request snapshot if the live annotation set changes", () => {
  const rows = [{ id: "partial-1" }, { id: "full-1" }];
  assert.deepEqual(
    filterRowsByReviewSnapshot(rows, "partial", ["partial-1"], ["full-1"]),
    [{ id: "partial-1" }],
  );
});

test("combined annotation queues retain their request snapshot", () => {
  const rows = [{ id: "combined-1" }, { id: "llm-only" }];
  assert.deepEqual(
    filterRowsByReviewSnapshot(rows, "llm_human", ["combined-1"], ["llm-only"]),
    [{ id: "combined-1" }],
  );
});

test("a named human queue retains its own request snapshot", () => {
  const rows = [{ id: "dimitri-record" }, { id: "kirsten-record" }];
  assert.deepEqual(
    filterRowsByReviewSnapshot(rows, humanReviewStatusMode("Kirsten"), ["kirsten-record"], ["dimitri-record"]),
    [{ id: "kirsten-record" }],
  );
});

test("non-status views leave server results unchanged", () => {
  const rows = [{ id: "a" }, { id: "b" }];
  assert.equal(filterRowsByReviewSnapshot(rows, "all", ["a"], []), rows);
});
