import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Annotation = Record<string, unknown>;
type HistoryItem = { recordId: string; previous: Annotation | null; annotation: Annotation };
type AnnotationRun = { id: string; listId: string; startedAt: string; completedAt?: string; reasoningEffort: string; prompts: Record<string, string>; expected: number; succeeded: number; failed: number; cancelled: boolean; items: HistoryItem[] };
const dataDirectory = () => path.join(process.cwd(), "data");
const dataFile = () => path.join(dataDirectory(), "conversation-list-history.json");
const lockFile = () => path.join(dataDirectory(), "conversation-list-history.lock");

async function readRuns(): Promise<AnnotationRun[]> {
  try {
    const value = JSON.parse(await readFile(dataFile(), "utf8")) as { runs?: unknown };
    return Array.isArray(value.runs) ? value.runs as AnnotationRun[] : [];
  } catch { return []; }
}

async function mutate<T>(operation: (runs: AnnotationRun[]) => { runs: AnnotationRun[]; result: T }) {
  await mkdir(dataDirectory(), { recursive: true, mode: 0o700 });
  let lock;
  for (let attempt = 0; attempt < 250; attempt += 1) {
    try { lock = await open(lockFile(), "wx", 0o600); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try { if (Date.now() - (await stat(lockFile())).mtimeMs > 30_000) await unlink(lockFile()); } catch { /* another write released it */ }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  if (!lock) throw new Error("Could not lock annotation history.");
  try {
    const { runs, result } = operation(await readRuns());
    const temporary = `${dataFile()}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, runs }), { mode: 0o600 });
    await rename(temporary, dataFile());
    return result;
  } finally { await lock.close(); await unlink(lockFile()).catch(() => undefined); }
}

function cleanAnnotation(value: unknown): Annotation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const json = JSON.stringify(value);
  if (json.length > 100_000) return null;
  return JSON.parse(json) as Annotation;
}

export async function GET(request: NextRequest) {
  const recordId = request.nextUrl.searchParams.get("recordId");
  if (recordId !== null) {
    if (!/^[A-Za-z0-9_:-]{1,128}$/.test(recordId)) return NextResponse.json({ error: "Invalid record ID." }, { status: 400 });
    const versions = (await readRuns()).flatMap((run) => run.items.filter((item) => item.recordId === recordId).flatMap((item) => {
      const result = [{ id: `${run.id}:result`, listId: run.listId, runStartedAt: run.startedAt, createdAt: String(item.annotation.llmAnnotatedAt ?? item.annotation.updatedAt ?? run.startedAt), annotation: item.annotation }];
      if (item.previous) result.push({ id: `${run.id}:previous`, listId: run.listId, runStartedAt: run.startedAt, createdAt: String(item.previous.llmAnnotatedAt ?? item.previous.updatedAt ?? run.startedAt), annotation: item.previous });
      return result;
    })).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return NextResponse.json({ versions }, { headers: { "cache-control": "no-store" } });
  }
  const listId = request.nextUrl.searchParams.get("listId");
  if (!listId) return NextResponse.json({ error: "A list ID is required." }, { status: 400 });
  return NextResponse.json({ runs: (await readRuns()).filter((run) => run.listId === listId) }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: NextRequest) {
  let input: { action?: unknown; runId?: unknown; listId?: unknown; reasoningEffort?: unknown; prompts?: unknown; expected?: unknown; recordId?: unknown; previous?: unknown; annotation?: unknown; failed?: unknown; cancelled?: unknown };
  try { input = await request.json() as typeof input; }
  catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 }); }
  if (input.action === "start") {
    if (typeof input.listId !== "string" || !input.listId || !["low", "medium", "high"].includes(String(input.reasoningEffort)) || !Number.isInteger(input.expected) || Number(input.expected) < 0 || Number(input.expected) > 100_000 || !input.prompts || typeof input.prompts !== "object" || Array.isArray(input.prompts)) return NextResponse.json({ error: "Invalid annotation run details." }, { status: 400 });
    const prompts = Object.fromEntries(Object.entries(input.prompts as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length <= 50_000));
    const run: AnnotationRun = { id: randomUUID(), listId: input.listId, startedAt: new Date().toISOString(), reasoningEffort: String(input.reasoningEffort), prompts, expected: Number(input.expected), succeeded: 0, failed: 0, cancelled: false, items: [] };
    await mutate((runs) => ({ runs: [...runs, run], result: undefined }));
    return NextResponse.json({ run }, { status: 201 });
  }
  if (typeof input.runId !== "string") return NextResponse.json({ error: "A run ID is required." }, { status: 400 });
  if (input.action === "result") {
    const annotation = cleanAnnotation(input.annotation);
    const previous = input.previous == null ? null : cleanAnnotation(input.previous);
    if (typeof input.recordId !== "string" || !input.recordId || !annotation || (input.previous != null && !previous)) return NextResponse.json({ error: "Invalid annotation result." }, { status: 400 });
    const found = await mutate((runs) => {
      const run = runs.find((item) => item.id === input.runId);
      if (!run) return { runs, result: false };
      if (!run.items.some((item) => item.recordId === input.recordId)) {
        const earlier = [...runs].reverse().filter((candidate) => candidate.listId === run.listId && candidate.id !== run.id).flatMap((candidate) => candidate.items).find((item) => item.recordId === input.recordId)?.annotation;
        run.items.push({ recordId: input.recordId as string, previous: previous ?? earlier ?? null, annotation });
        run.succeeded += 1;
      }
      return { runs, result: true };
    });
    return found ? NextResponse.json({ saved: true }) : NextResponse.json({ error: "Annotation run not found." }, { status: 404 });
  }
  if (input.action === "finish") {
    const run = await mutate((runs) => {
      const item = runs.find((entry) => entry.id === input.runId);
      if (!item) return { runs, result: null };
      item.completedAt = new Date().toISOString();
      item.failed = Number.isInteger(input.failed) ? Math.max(0, Number(input.failed)) : 0;
      item.cancelled = input.cancelled === true;
      return { runs, result: item };
    });
    return run ? NextResponse.json({ run }) : NextResponse.json({ error: "Annotation run not found." }, { status: 404 });
  }
  return NextResponse.json({ error: "Unknown history action." }, { status: 400 });
}
