import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanAnnotatorName, createAnnotatorRosterStore, normalizeAnnotatorName } from "../src/lib/annotator-roster.mjs";

async function withTempDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wildchat-annotators-"));
  try { await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("normalizes shared names consistently and rejects invalid names", () => {
  assert.equal(normalizeAnnotatorName("  KIRSTEN   "), "kirsten");
  assert.equal(cleanAnnotatorName("  Dimitri  "), "Dimitri");
  assert.equal(cleanAnnotatorName(""), null);
  assert.equal(cleanAnnotatorName("a".repeat(49)), null);
  assert.equal(cleanAnnotatorName("bad\nname"), null);
});

test("returns registered profiles and discovers legacy annotators from shared annotations", async () => {
  await withTempDirectory(async (directory) => {
    const annotations = path.join(directory, "shared-annotations");
    await mkdir(annotations, { recursive: true });
    await writeFile(path.join(annotations, "record-1.json"), JSON.stringify({ humans: { Kirsten: { annotatorName: "Kirsten", annotation: { relevance: "yes" } } } }));
    const store = createAnnotatorRosterStore(directory);
    await store.register(["Dimitri"]);
    assert.deepEqual(await store.list(), ["Dimitri", "Kirsten"]);
  });
});

test("profile registration, rename, and removal are shared across store instances", async () => {
  await withTempDirectory(async (directory) => {
    const firstBrowser = createAnnotatorRosterStore(directory);
    const secondBrowser = createAnnotatorRosterStore(directory);
    await firstBrowser.register(["Dimitri", "Kirsten"]);
    assert.deepEqual(await secondBrowser.list(), ["Dimitri", "Kirsten"]);

    await firstBrowser.rename("Kirsten", "Kirsten Example");
    assert.deepEqual(await secondBrowser.list(), ["Dimitri", "Kirsten Example"]);

    await secondBrowser.remove("Dimitri");
    assert.deepEqual(await firstBrowser.list(), ["Kirsten Example"]);
    await secondBrowser.register(["Dimitri"]);
    assert.deepEqual(await firstBrowser.list(), ["Dimitri", "Kirsten Example"]);
  });
});

test("concurrent browser registrations do not overwrite one another", async () => {
  await withTempDirectory(async (directory) => {
    const firstBrowser = createAnnotatorRosterStore(directory);
    const secondBrowser = createAnnotatorRosterStore(directory);
    await Promise.all([firstBrowser.register(["Dimitri"]), secondBrowser.register(["Kirsten"])]);
    assert.deepEqual(await firstBrowser.list(), ["Dimitri", "Kirsten"]);
  });
});
