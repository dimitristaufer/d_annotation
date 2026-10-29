import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { ANNOTATION_PROMPT_DIMENSIONS, DEFAULT_ANNOTATION_PROMPTS } from "@/lib/annotation-prompts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PromptSnapshot = {
  id: string;
  savedAt: string;
  label: string;
  source: string;
  promptVersion?: string;
  prompts: Record<string, string>;
  personReferenceCriteria: string;
  personReferenceRule?: string;
};

const dataDirectory = () => path.join(process.cwd(), "data");

async function readJson(filePath: string): Promise<unknown> {
  try { return JSON.parse(await readFile(filePath, "utf8")) as unknown; }
  catch { return null; }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function makeSnapshot(value: unknown, source: string, fallbackLabel: string, fallbackDate?: string): PromptSnapshot | null {
  const record = asRecord(value);
  if (!record) return null;
  const rawPrompts = asRecord(record.prompts) ?? record;
  const prompts = Object.fromEntries(ANNOTATION_PROMPT_DIMENSIONS.map(({ key }) => {
    const prompt = rawPrompts[key];
    return [key, typeof prompt === "string" && prompt.length <= 50_000 ? prompt : DEFAULT_ANNOTATION_PROMPTS[key]];
  }));
  const personReferenceCriteria = [record.personReferenceCriteria, rawPrompts.personReferenceCriteria, record.personReferencePrompt, rawPrompts.personReferencePrompt, record.legacyRelevancePrompt].find((item) => typeof item === "string" && item.length <= 50_000);
  const promptVersion = [record.promptVersion, rawPrompts.promptVersion].find((item) => typeof item === "string");
  const personReferenceRule = [record.personReferenceRule, rawPrompts.personReferenceRule].find((item) => typeof item === "string");
  const signature = JSON.stringify({ prompts, personReferenceCriteria });
  const id = createHash("sha256").update(signature).digest("hex").slice(0, 24);
  const suppliedDate = [record.savedAt, record.capturedAt, record.updatedAt, record.startedAt, record.runStartedAt].find((item) => typeof item === "string" && Number.isFinite(Date.parse(item)));
  const savedAt = typeof suppliedDate === "string" ? suppliedDate : fallbackDate ?? "";
  const suppliedLabel = [record.snapshotName, record.label, record.name].find((item) => typeof item === "string" && item.trim());
  return {
    id,
    savedAt,
    label: typeof suppliedLabel === "string" ? suppliedLabel : fallbackLabel,
    source,
    ...(typeof promptVersion === "string" ? { promptVersion } : {}),
    prompts,
    personReferenceCriteria: typeof personReferenceCriteria === "string" ? personReferenceCriteria : "Not stored for this prompt set.",
    personReferenceRule: typeof personReferenceRule === "string" ? personReferenceRule : "Rule metadata was not stored for this prompt set.",
  };
}

async function readSnapshotFiles(directory: string): Promise<PromptSnapshot[]> {
  let names: string[];
  try { names = (await readdir(directory)).filter((name) => name.toLowerCase().endsWith(".json")).sort(); }
  catch { return []; }
  const snapshots = await Promise.all(names.map(async (name) => makeSnapshot(await readJson(path.join(directory, name)), "Prompt backup", name.replace(/\.json$/i, ""))));
  return snapshots.filter((snapshot): snapshot is PromptSnapshot => snapshot !== null);
}

export async function GET() {
  const directory = dataDirectory();
  const [manualSnapshots, archivedHistory, batchHistory] = await Promise.all([
    readSnapshotFiles(path.join(directory, "prompt-snapshots")),
    readJson(path.join(directory, "annotation-prompt-history.json")),
    readJson(path.join(directory, "conversation-list-history.json")),
  ]);
  const archivedVersions = Array.isArray(asRecord(archivedHistory)?.versions)
    ? (asRecord(archivedHistory)?.versions as unknown[]).map((snapshot) => makeSnapshot(snapshot, "Saved before prompt edit", "Previous prompts"))
    : [];
  const batchRuns = Array.isArray(asRecord(batchHistory)?.runs) ? asRecord(batchHistory)?.runs as unknown[] : [];
  const batchVersions = batchRuns.flatMap((run) => {
    const record = asRecord(run);
    if (!record || !asRecord(record.prompts)) return [];
    const id = typeof record.listId === "string" ? record.listId : "";
    const label = id.startsWith("aggregate-")
      ? id === "aggregate-llm-fully-annotated" ? "All LLM Annotated (fully)" : "All LLM + At Least One Human Annotated (fully)"
      : `LLM batch run · ${id.slice(0, 12) || "list"}`;
    return [makeSnapshot(record.prompts, "LLM batch run", label, typeof record.startedAt === "string" ? record.startedAt : undefined)];
  });
  const unique = new Map<string, PromptSnapshot>();
  for (const snapshot of [...manualSnapshots, ...archivedVersions, ...batchVersions]) {
    if (snapshot && !unique.has(snapshot.id)) unique.set(snapshot.id, snapshot);
  }
  const versions = [...unique.values()].sort((left, right) => right.savedAt.localeCompare(left.savedAt));
  return NextResponse.json({ versions, count: versions.length }, { headers: { "cache-control": "no-store" } });
}
