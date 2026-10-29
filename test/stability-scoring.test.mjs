import test from "node:test";
import assert from "node:assert/strict";
import { sameStabilityOutput, stabilityCategoryValue } from "../src/lib/stability-scoring.mjs";

const categories = ["Contains CTPs", "Domains", "Purposes", "Referents", "Identifiability"];

test("stability scoring excludes optional referent names and descriptions and ignores order", () => {
  const first = { relevance: "yes", domains: ["Personal life", "Public life and culture"], purposes: ["Help the requester act"], referents: [{ mention: "Alice Smith", description: "The neighbour", type: "Public figures", identifiability: "Directly identifiable" }, { mention: "Bob Jones", description: "A colleague", type: "Named others", identifiability: "Indirectly identifiable" }] };
  const second = { ...first, domains: [...first.domains].reverse(), purposes: [...first.purposes], referents: [...first.referents].reverse().map((item) => ({ ...item, mention: item.mention.split(" ").reverse().join(" "), description: "Different wording" })) };
  assert.equal(sameStabilityOutput(first, second, categories), true);
});

test("stability scoring still penalises missing referents and changed classifications", () => {
  const base = { relevance: "yes", domains: ["Personal life"], purposes: [], referents: [{ mention: "Alice Smith", type: "Public figures", identifiability: "Directly identifiable" }] };
  assert.equal(sameStabilityOutput(base, { ...base, referents: [] }, categories), false);
  assert.equal(sameStabilityOutput(base, { ...base, referents: [{ ...base.referents[0], type: "Named others" }] }, categories), false);
  assert.equal(sameStabilityOutput(base, { ...base, referents: [{ ...base.referents[0], identifiability: "Indirectly identifiable" }] }, categories), false);
});

test("referent type and classification values are unordered and preserve duplicates", () => {
  const annotation = { referents: [{ type: "Public figures", identifiability: "Directly identifiable" }, { type: "Public figures", identifiability: "Directly identifiable" }] };
  assert.deepEqual(stabilityCategoryValue(annotation, "Referents"), ["public figures", "public figures"]);
  assert.deepEqual(stabilityCategoryValue(annotation, "Identifiability"), ["[\"public figures\",\"directly identifiable\"]", "[\"public figures\",\"directly identifiable\"]"]);
});
