import test from "node:test";
import assert from "node:assert/strict";
import { mergeAnnotationSnapshot, mergeAnnotationSubset, mergeHumanAnnotationSnapshot, mergeHumanAnnotationSubset } from "../src/lib/annotation-state.mjs";

test("an unchanged annotation snapshot preserves the current state reference", () => {
  const current = { a: { relevance: "yes", updatedAt: "1" }, b: { relevance: "no", updatedAt: "2" } };
  const refreshed = { a: { relevance: "yes", updatedAt: "1" }, b: { relevance: "no", updatedAt: "2" } };
  assert.equal(mergeAnnotationSnapshot(current, refreshed), current);
});

test("an annotation snapshot updates changed rows and removes deleted rows", () => {
  const current = { a: { relevance: "yes", updatedAt: "1" }, b: { relevance: "no", updatedAt: "2" } };
  const changed = { relevance: "no", updatedAt: "3" };
  const next = mergeAnnotationSnapshot(current, { a: changed });
  assert.notEqual(next, current);
  assert.equal(next.a, changed);
  assert.equal(Object.hasOwn(next, "b"), false);
});

test("a subset refresh changes or deletes only the requested IDs", () => {
  const current = { a: { relevance: "yes", updatedAt: "1" }, b: { relevance: "no", updatedAt: "2" } };
  const refreshed = { a: { relevance: "no", updatedAt: "3" } };
  const next = mergeAnnotationSubset(current, refreshed, ["a", "missing"]);
  assert.notEqual(next, current);
  assert.deepEqual(next.a, refreshed.a);
  assert.equal(next.b, current.b);
  assert.equal(Object.hasOwn(next, "missing"), false);
});

test("unchanged human annotation snapshots preserve nested state references", () => {
  const current = { a: { Dimitri: { relevance: "yes", updatedAt: "1" } } };
  const refreshed = { a: { Dimitri: { relevance: "yes", updatedAt: "1" } } };
  assert.equal(mergeHumanAnnotationSnapshot(current, refreshed), current);
});

test("human annotation subset refresh replaces only the requested record maps", () => {
  const current = {
    a: { Dimitri: { relevance: "yes", updatedAt: "1" } },
    b: { Kirsten: { relevance: "no", updatedAt: "2" } },
  };
  const refreshed = { a: { Dimitri: { relevance: "no", updatedAt: "3" }, Kirsten: { relevance: "yes", updatedAt: "4" } } };
  const next = mergeHumanAnnotationSubset(current, refreshed, ["a"]);
  assert.notEqual(next, current);
  assert.deepEqual(next.a, refreshed.a);
  assert.equal(next.b, current.b);
});
