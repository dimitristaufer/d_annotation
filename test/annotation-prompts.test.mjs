import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const source = await readFile(new URL("../src/lib/annotation-prompts.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const prompts = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("migrates a legacy binary response into clear referent inclusion criteria", () => {
  const legacy = {
    promptVersion: "inventory-context-v3-editable-reference",
    personReferencePrompt: 'Use only referentsToAssess. Return only one JSON object: {"relevance":"yes"}.',
    prompts: {
      referent: "Extract people. Apply the supplied personReferencePrompt as inclusion criteria. Return a JSON object with exactly this shape: {\"referents\":[]}.",
      domain: "Use referentsToAssess as the complete person inventory.",
      identifiability: "Assess each entry in referentsToAssess.",
      purpose: "Use referentsToAssess as the person inventory.",
    },
  };

  const migrated = prompts.migrateStoredPromptSet(legacy);
  assert.equal(migrated.needsMigration, true);
  assert.equal(migrated.personReferenceCriteria, prompts.DEFAULT_PERSON_REFERENCE_CRITERIA);
  assert.match(migrated.prompts.referent, /Contains CTPs label Yes/);
  assert.match(migrated.prompts.domain, /supplied referent list/);
  assert.match(migrated.prompts.identifiability, /supplied referent list/);
  assert.match(migrated.prompts.purpose, /supplied referent list/);
  assert.doesNotMatch(JSON.stringify(migrated), /referentsToAssess|personReferencePrompt/);
  assert.match(migrated.prompts.referent, /MSD1 frame has already assigned this message.*Yes/);
  assert.match(migrated.prompts.referent, /"referents":\[\{"mention":"","type":""\}\]/);
  assert.doesNotMatch(migrated.prompts.referent, /Return "yes"|"relevance"|uncertain|must have an empty referent list/i);

  const saved = prompts.migrateStoredPromptSet({
    promptVersion: migrated.promptVersion,
    prompts: migrated.prompts,
    personReferenceCriteria: migrated.personReferenceCriteria,
  });
  assert.equal(saved.needsMigration, false);
});

test("adds the criteria instruction when migrating an older referent prompt", () => {
  const migrated = prompts.migrateStoredPromptSet({
    promptVersion: "inventory-context-v2",
    prompts: { referent: "Extract third-party people. Return a JSON object with exactly this shape: {\"referents\":[]} ." },
  });
  assert.match(migrated.prompts.referent, /Apply the supplied Contains CTPs eligibility criteria/);
});

test("inserts criteria before a custom referent prompt's output instructions", () => {
  const custom = "Detailed eligibility rules for the annotation. Return each referent once, in first-appearance order. Return only one valid JSON object with the required shape.";
  const migrated = prompts.migrateStoredPromptSet({
    promptVersion: "simple-referent-inventory-v4",
    personReferenceCriteria: prompts.DEFAULT_PERSON_REFERENCE_CRITERIA,
    prompts: { referent: custom },
  });
  const criteriaIndex = migrated.prompts.referent.indexOf("Apply the supplied Contains CTPs eligibility criteria");
  const outputIndex = migrated.prompts.referent.indexOf("Return each referent once");
  assert.equal(migrated.needsMigration, true);
  assert.ok(criteriaIndex >= 0 && criteriaIndex < outputIndex);
  assert.ok(migrated.prompts.referent.includes("Detailed eligibility rules for the annotation."));
});

test("renames the criterion in saved prompts while preserving its meaning", () => {
  const migrated = prompts.migrateStoredPromptSet({
    promptVersion: "simple-referent-inventory-v5",
    personReferenceCriteria: "Person Reference includes third-party people and human groups.",
    prompts: {
      referent: "Apply the supplied Person Reference inclusion criteria to build the referent list.",
    },
  });
  assert.equal(migrated.needsMigration, true);
  assert.equal(migrated.personReferenceCriteria, "Contains CTPs includes third-party people and human groups.");
  assert.match(migrated.prompts.referent, /^The verified MSD1 frame/);
  assert.match(migrated.prompts.referent, /supplied Contains CTPs eligibility criteria to build the referent list\./);
  assert.doesNotMatch(migrated.prompts.referent, /"relevance"|uncertain|Return "yes"/i);
  assert.doesNotMatch(migrated.prompts.referent, /Person Reference/i);
});

test("the referent prompt inventories people without making a CTP decision", () => {
  const migrated = prompts.migrateStoredPromptSet({
    promptVersion: "simple-referent-inventory-v6",
    personReferenceCriteria: prompts.DEFAULT_PERSON_REFERENCE_CRITERIA,
    prompts: { referent: 'List eligible people. Apply the supplied Contains CTPs criteria. Return exactly this JSON shape: {"referents":[{"mention":"","type":""}]}. The list may be empty.' },
  });

  assert.equal(migrated.needsMigration, true);
  assert.match(migrated.prompts.referent, /MSD1 frame has already assigned this message.*Yes/);
  assert.doesNotMatch(migrated.prompts.referent, /uncertain|"relevance"|"no"/i);
  assert.match(migrated.prompts.referent, /Return exactly this JSON shape: \{"referents":\[/);
});

test("the MSD1 referent prompt builder is idempotent and removes legacy classification text", () => {
  const legacy = 'Extract people using eligibility criteria. Determine whether the target contains third-party people or human groups that meet the supplied Contains CTPs criteria. Return "yes" when at least one definitely qualifies, "no" when none qualifies, and "uncertain" only when it is genuinely unresolved whether any qualify. List only definite qualifying people or groups. A "yes" result must have at least one referent; "no" and "uncertain" must have an empty referent list. Return one JSON object with exactly two fields: a string "relevance" ("yes", "no", or "uncertain") and a "referents" array.';
  const once = prompts.buildMsd1ReferentInventoryPrompt(legacy);
  assert.equal(prompts.buildMsd1ReferentInventoryPrompt(once), once);
  assert.doesNotMatch(once, /"relevance"|Return "yes"|uncertain|exactly two fields/i);
  assert.match(once, /"referents":\[\{"mention":"","type":""\}\]/);
});
