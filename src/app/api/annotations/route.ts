import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Annotation = Record<string, unknown> & { updatedAt?: string; llmAnnotatedAt?: string };
type HumanAnnotation = { annotatorName: string; annotation: Annotation };
type RecordStore = { llm?: Annotation; humans?: Record<string, HumanAnnotation> };
type AnnotationIndex = { llm: Record<string, Annotation>; humans: Record<string, Record<string, Annotation>>; allHumans?: Record<string, Record<string, Annotation>> };
const dataDirectory = () => path.join(process.cwd(), "data");
const recordsDirectory = () => path.join(dataDirectory(), "shared-annotations");
const lockPath = () => path.join(dataDirectory(), "shared-annotations.lock");
const validId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_:-]{1,128}$/.test(id);
type AgreementSummary = { messages: number; comparisons: number; agreements: number; fieldComparisons: number; percent: number | null; updatedAt: string };
let agreementCache: { expiresAt: number; value: AgreementSummary } | null = null;
let llmHumanAgreementCache: { expiresAt: number; value: AgreementSummary } | null = null;
let paperFrameAgreementCache: { expiresAt: number; value: AgreementSummary } | null = null;
let paperFrameLlmHumanAgreementCache: { expiresAt: number; value: AgreementSummary } | null = null;
const annotationIndexCache = new Map<string, { expiresAt: number; value: AnnotationIndex }>();
let paperFrameMembershipCache: { expiresAt: number; key: string; recordIds: string[] } | null = null;
let paperFrameMembershipRequest: { key: string; promise: Promise<string[]> } | null = null;

function relevanceLabel(annotation: Annotation) {
  const value = annotation.relevance ?? annotation.decision;
  return value === "yes" || value === "no" || value === "uncertain" ? value : null;
}
function normalizeScoreLabel(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").toLowerCase() : "";
}
function comparableCategoryValue(annotation: Annotation, category: "domains" | "purposes" | "referents" | "identifiability") {
  if (category === "domains" || category === "purposes") {
    const values = annotation[category];
    return Array.isArray(values) ? JSON.stringify([...values].sort()) : null;
  }
  const referents = annotation.referents;
  if (!Array.isArray(referents)) return null;
  const relevance = relevanceLabel(annotation);
  if (relevance === "yes" && referents.length === 0) return null;
  if (category === "referents") {
    if (!referents.every((item) => Boolean(item && typeof item === "object" && (item as Record<string, unknown>).type))) return null;
    return JSON.stringify(referents.map((item) => normalizeScoreLabel((item as Record<string, unknown>).type)).sort());
  }
  if (!referents.every((item) => Boolean(item && typeof item === "object" && (item as Record<string, unknown>).type && (item as Record<string, unknown>).identifiability))) return null;
  return JSON.stringify(referents.map((item) => {
    const referent = item as Record<string, unknown>;
    return [normalizeScoreLabel(referent.type), normalizeScoreLabel(referent.identifiability)];
  }).map((pair) => JSON.stringify(pair)).sort());
}
function comparableAnnotationChecks(left: Annotation, right: Annotation) {
  const leftRelevance = relevanceLabel(left);
  const rightRelevance = relevanceLabel(right);
  if (!leftRelevance || !rightRelevance) return [];
  const checks = [leftRelevance === rightRelevance];
  if (leftRelevance !== "yes" || rightRelevance !== "yes") return checks;
  for (const category of ["domains", "purposes", "referents", "identifiability"] as const) {
    const leftValue = comparableCategoryValue(left, category);
    const rightValue = comparableCategoryValue(right, category);
    if (leftValue !== null && rightValue !== null) checks.push(leftValue === rightValue);
  }
  return checks;
}

async function ensureDirectory() { await mkdir(recordsDirectory(), { recursive: true, mode: 0o700 }); }
async function readRecord(id: string): Promise<RecordStore> {
  try {
    const parsed = JSON.parse(await readFile(path.join(recordsDirectory(), `${id}.json`), "utf8")) as RecordStore;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}
async function writeRecord(id: string, value: RecordStore) {
  const file = path.join(recordsDirectory(), `${id}.json`);
  if (!value.llm && !Object.keys(value.humans ?? {}).length) { await unlink(file).catch((error) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); return; }
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, file);
}
async function mutateRecords<T>(ids: string[], operation: (id: string, record: RecordStore) => T) {
  await ensureDirectory();
  let lock;
  for (let attempt = 0; attempt < 250; attempt += 1) {
    try { lock = await open(lockPath(), "wx", 0o600); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try { if (Date.now() - (await stat(lockPath())).mtimeMs > 30_000) await unlink(lockPath()); } catch { /* the other writer released it */ }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  if (!lock) throw new Error("Could not lock shared annotations.");
  try {
    const results: T[] = [];
    for (const id of ids) {
      const record = await readRecord(id);
      results.push(operation(id, record));
      await writeRecord(id, record);
    }
    return results;
  } finally { await lock.close(); await unlink(lockPath()).catch(() => undefined); }
}
function cleanAnnotation(value: unknown): Annotation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const json = JSON.stringify(value);
  if (json.length > 100_000) return null;
  return JSON.parse(json) as Annotation;
}
function validatedIds(value: unknown, max = 5000): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = [...new Set(value)];
  return ids.length > 0 && ids.length <= max && ids.every(validId) ? ids : null;
}
async function readMany(ids: string[], includeHumans: boolean) {
  const llm: Record<string, Annotation> = {};
  const humans: Record<string, Record<string, Annotation>> = {};
  for (let offset = 0; offset < ids.length; offset += 100) {
    const records = await Promise.all(ids.slice(offset, offset + 100).map(async (id) => [id, await readRecord(id)] as const));
    for (const [id, record] of records) {
      if (record.llm) llm[id] = record.llm;
      if (includeHumans && Object.keys(record.humans ?? {}).length) humans[id] = Object.fromEntries(Object.entries(record.humans!).map(([name, item]) => [name, item.annotation]));
    }
  }
  return { llm, humans };
}

async function readAgreement(frameId = ""): Promise<AgreementSummary> {
  const cached = frameId ? paperFrameAgreementCache : agreementCache;
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  let files: string[] = [];
  try { files = (await readdir(recordsDirectory())).filter((file) => file.endsWith(".json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (frameId) files = await filesInPaperFrame(frameId, files);
  let messages = 0;
  let comparisons = 0;
  let agreements = 0;
  let fieldComparisons = 0;
  for (let offset = 0; offset < files.length; offset += 100) {
    const records = await Promise.all(files.slice(offset, offset + 100).map(async (file): Promise<RecordStore> => {
      const id = file.slice(0, -5);
      return validId(id) ? readRecord(id) : {};
    }));
    for (const record of records) {
      const annotations = Object.values(record.humans ?? {}).map((entry) => entry.annotation);
      let comparedMessage = false;
      for (let left = 0; left < annotations.length; left += 1) for (let right = left + 1; right < annotations.length; right += 1) {
        const checks = comparableAnnotationChecks(annotations[left], annotations[right]);
        if (!checks.length) continue;
        comparedMessage = true;
        comparisons += 1;
        fieldComparisons += checks.length;
        agreements += checks.filter(Boolean).length;
      }
      if (comparedMessage) messages += 1;
    }
  }
  const value = { messages, comparisons, agreements, fieldComparisons, percent: fieldComparisons ? agreements / fieldComparisons * 100 : null, updatedAt: new Date().toISOString() };
  if (frameId) paperFrameAgreementCache = { expiresAt: Date.now() + 60_000, value };
  else agreementCache = { expiresAt: Date.now() + 60_000, value };
  return value;
}

async function readLlmHumanAgreement(frameId = ""): Promise<AgreementSummary> {
  const cached = frameId ? paperFrameLlmHumanAgreementCache : llmHumanAgreementCache;
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  let files: string[] = [];
  try { files = (await readdir(recordsDirectory())).filter((file) => file.endsWith(".json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (frameId) files = await filesInPaperFrame(frameId, files);
  let messages = 0;
  let comparisons = 0;
  let agreements = 0;
  let fieldComparisons = 0;
  for (let offset = 0; offset < files.length; offset += 100) {
    const records = await Promise.all(files.slice(offset, offset + 100).map(async (file): Promise<RecordStore> => {
      const id = file.slice(0, -5);
      return validId(id) ? readRecord(id) : {};
    }));
    for (const record of records) {
      if (!record.llm) continue;
      let comparedMessage = false;
      for (const human of Object.values(record.humans ?? {})) {
        const checks = comparableAnnotationChecks(record.llm, human.annotation);
        if (!checks.length) continue;
        comparedMessage = true;
        comparisons += 1;
        fieldComparisons += checks.length;
        agreements += checks.filter(Boolean).length;
      }
      if (comparedMessage) messages += 1;
    }
  }
  const value = { messages, comparisons, agreements, fieldComparisons, percent: fieldComparisons ? agreements / fieldComparisons * 100 : null, updatedAt: new Date().toISOString() };
  if (frameId) paperFrameLlmHumanAgreementCache = { expiresAt: Date.now() + 60_000, value };
  else llmHumanAgreementCache = { expiresAt: Date.now() + 60_000, value };
  return value;
}

async function readAnnotationIndex(annotatorName: string, includeAllHumans: boolean, frameId: string): Promise<AnnotationIndex> {
  if (frameId && frameId !== "english_ge_90") throw new Error("Unsupported annotation queue frame.");
  const cacheKey = `${annotatorName}\u0000${includeAllHumans ? "all" : "active"}\u0000${frameId || "all"}`;
  const cached = annotationIndexCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  let files: string[] = [];
  try { files = (await readdir(recordsDirectory())).filter((file) => file.endsWith(".json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (frameId) {
    files = await filesInPaperFrame(frameId, files);
  }
  const llm: Record<string, Annotation> = {};
  const humans: Record<string, Record<string, Annotation>> = {};
  const allHumans: Record<string, Record<string, Annotation>> = {};
  for (let offset = 0; offset < files.length; offset += 100) {
    const records = await Promise.all(files.slice(offset, offset + 100).map(async (file) => {
      const id = file.slice(0, -5);
      return validId(id) ? [id, await readRecord(id)] as const : null;
    }));
    for (const entry of records) {
      if (!entry) continue;
      const [id, record] = entry;
      if (record.llm) llm[id] = record.llm;
      const human = record.humans?.[annotatorName]?.annotation;
      if (human) humans[id] = { [annotatorName]: human };
      if (includeAllHumans) {
        const byAnnotator = Object.fromEntries(Object.entries(record.humans ?? {}).flatMap(([name, entry]) => entry?.annotation ? [[name, entry.annotation] as const] : []));
        if (Object.keys(byAnnotator).length) allHumans[id] = byAnnotator;
      }
    }
  }
  const value = includeAllHumans ? { llm, humans, allHumans } : { llm, humans };
  annotationIndexCache.set(cacheKey, { expiresAt: Date.now() + 30_000, value });
  return value;
}

async function filterRecordIdsToPaperFrame(recordIds: string[]) {
  if (recordIds.length > 1_000_000) throw new Error("There are too many annotation records to filter against the paper frame.");
  const orderedIds = [...recordIds].sort();
  const hash = createHash("sha256");
  for (const id of orderedIds) hash.update(id).update("\u0000");
  const key = hash.digest("hex");
  if (paperFrameMembershipCache?.key === key && paperFrameMembershipCache.expiresAt > Date.now()) return paperFrameMembershipCache.recordIds;
  if (paperFrameMembershipRequest?.key === key) return paperFrameMembershipRequest.promise;
  const child = spawn(process.env.PYTHON ?? "python3", [path.join(process.cwd(), "scripts", "query-index.py")], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const maxStdoutBytes = 64 * 1024 * 1024;
  const maxStderrBytes = 64 * 1024;
  const result = new Promise<string[]>((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        child.kill();
        reject(new Error("Frame membership response exceeded the size limit."));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= maxStderrBytes) return;
      const kept = chunk.subarray(0, maxStderrBytes - stderrBytes);
      stderrBytes += kept.length;
      stderr.push(kept);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `Frame membership query exited (${code ?? "unknown"}).`));
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(stdout).toString("utf8")) as { recordIds?: unknown };
        if (!Array.isArray(parsed.recordIds) || !parsed.recordIds.every((id) => typeof id === "string")) throw new Error("Frame membership query returned an invalid result.");
        resolve(parsed.recordIds);
      } catch (error) { reject(error); }
    });
  });
  child.stdin.on("error", () => undefined);
  child.stdin.end(JSON.stringify({ action: "filter_frame_ids", frame_id: "english_ge_90", record_ids: orderedIds }));
  paperFrameMembershipRequest = { key, promise: result };
  try {
    const matches = await result;
    paperFrameMembershipCache = { expiresAt: Date.now() + 30_000, key, recordIds: matches };
    return matches;
  } finally {
    if (paperFrameMembershipRequest?.key === key) paperFrameMembershipRequest = null;
  }
}

async function filesInPaperFrame(frameId: string, files: string[]) {
  if (frameId !== "english_ge_90") throw new Error("Unsupported annotation frame.");
  const validFiles = files.filter((file) => file.endsWith(".json") && validId(file.slice(0, -5)));
  const frameIds = new Set(await filterRecordIdsToPaperFrame(validFiles.map((file) => file.slice(0, -5))));
  return validFiles.filter((file) => frameIds.has(file.slice(0, -5)));
}

export async function GET(request: NextRequest) {
  if (request.nextUrl.searchParams.get("agreement") === "llm-human") return NextResponse.json(await readLlmHumanAgreement(request.nextUrl.searchParams.get("frame") ?? ""), { headers: { "cache-control": "no-store" } });
  if (request.nextUrl.searchParams.get("agreement") === "true") return NextResponse.json(await readAgreement(request.nextUrl.searchParams.get("frame") ?? ""), { headers: { "cache-control": "no-store" } });
  if (request.nextUrl.searchParams.get("index") === "true") {
    const annotatorName = (request.nextUrl.searchParams.get("annotatorName") ?? "").trim().slice(0, 48);
    if (!annotatorName) return NextResponse.json({ error: "Provide an annotator name." }, { status: 400 });
    const includeAllHumans = request.nextUrl.searchParams.get("includeAllHumans") === "true";
    const frameId = request.nextUrl.searchParams.get("frame") ?? "";
    try {
      return NextResponse.json(await readAnnotationIndex(annotatorName, includeAllHumans, frameId), { headers: { "cache-control": "no-store" } });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load the framed annotation index." }, { status: 500 });
    }
  }
  const ids = [...new Set((request.nextUrl.searchParams.get("recordIds") ?? "").split(",").filter(Boolean))];
  if (!ids.length || ids.length > 5000 || !ids.every(validId)) return NextResponse.json({ error: "Provide up to 5,000 valid record IDs." }, { status: 400 });
  const result = await readMany(ids, request.nextUrl.searchParams.get("includeHumans") === "true");
  return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: NextRequest) {
  let input: { action?: unknown; recordIds?: unknown; includeHumans?: unknown; items?: unknown };
  try { input = await request.json() as typeof input; }
  catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 }); }
  if (input.action === "read") {
    const ids = validatedIds(input.recordIds);
    if (!ids) return NextResponse.json({ error: "Provide up to 5,000 valid record IDs." }, { status: 400 });
    return NextResponse.json(await readMany(ids, input.includeHumans === true), { headers: { "cache-control": "no-store" } });
  }
  if (!Array.isArray(input.items) || input.items.length > 1000) return NextResponse.json({ error: "Provide up to 1,000 annotation records." }, { status: 400 });
  const items: Array<{ source: "llm" | "human"; recordId: string; annotatorName: string; annotation: Annotation }> = [];
  for (const raw of input.items) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return NextResponse.json({ error: "Invalid annotation record." }, { status: 400 });
    const item = raw as Record<string, unknown>;
    const annotation = cleanAnnotation(item.annotation);
    if ((item.source !== "llm" && item.source !== "human") || !validId(item.recordId) || !annotation) return NextResponse.json({ error: "Invalid annotation record." }, { status: 400 });
    const annotatorName = typeof item.annotatorName === "string" ? item.annotatorName.trim().slice(0, 48) : "";
    if (item.source === "human" && !annotatorName) return NextResponse.json({ error: "Human annotations require an annotator name." }, { status: 400 });
    items.push({ source: item.source, recordId: item.recordId, annotatorName, annotation });
  }
  await mutateRecords([...new Set(items.map((item) => item.recordId))], (id, record) => {
    for (const item of items.filter((candidate) => candidate.recordId === id)) {
      if (item.source === "llm") {
        if (!record.llm || (item.annotation.updatedAt ?? "") >= (record.llm.updatedAt ?? "")) record.llm = item.annotation;
      } else {
        const humans = record.humans ?? (record.humans = {});
        const previous = humans[item.annotatorName]?.annotation;
        if (!previous || (item.annotation.updatedAt ?? "") >= (previous.updatedAt ?? "")) humans[item.annotatorName] = { annotatorName: item.annotatorName, annotation: item.annotation };
      }
    }
  });
  agreementCache = null;
  llmHumanAgreementCache = null;
  paperFrameAgreementCache = null;
  paperFrameLlmHumanAgreementCache = null;
  annotationIndexCache.clear();
  paperFrameMembershipCache = null;
  return NextResponse.json({ saved: items.length });
}

export async function DELETE(request: NextRequest) {
  let input: { source?: unknown; recordIds?: unknown; annotatorName?: unknown; all?: unknown };
  try { input = await request.json() as typeof input; }
  catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 }); }
  if (input.source === "llm" && input.all === true) {
    await ensureDirectory();
    const ids = (await readdir(recordsDirectory())).filter((file) => file.endsWith(".json")).map((file) => file.slice(0, -5)).filter(validId);
    let deleted = 0;
    for (let offset = 0; offset < ids.length; offset += 1000) {
      const removed = await mutateRecords(ids.slice(offset, offset + 1000), (_id, record) => {
        const hadLlmAnnotation = Boolean(record.llm);
        delete record.llm;
        return hadLlmAnnotation;
      });
      deleted += removed.filter(Boolean).length;
    }
    annotationIndexCache.clear();
    agreementCache = null;
    llmHumanAgreementCache = null;
    paperFrameAgreementCache = null;
    paperFrameLlmHumanAgreementCache = null;
    paperFrameMembershipCache = null;
    return NextResponse.json({ deleted });
  }
  const ids = validatedIds(input.recordIds);
  const annotatorName = typeof input.annotatorName === "string" ? input.annotatorName.trim().slice(0, 48) : "";
  if ((input.source !== "llm" && input.source !== "human") || !ids || (input.source === "human" && !annotatorName)) return NextResponse.json({ error: "Invalid annotation reset request." }, { status: 400 });
  await mutateRecords(ids, (id, record) => {
    if (input.source === "llm") delete record.llm;
    else if (record.humans) {
      delete record.humans[annotatorName];
      if (!Object.keys(record.humans).length) delete record.humans;
    }
  });
  agreementCache = null;
  llmHumanAgreementCache = null;
  paperFrameAgreementCache = null;
  paperFrameLlmHumanAgreementCache = null;
  annotationIndexCache.clear();
  paperFrameMembershipCache = null;
  return NextResponse.json({ deleted: ids.length });
}

export async function PATCH(request: NextRequest) {
  let input: { action?: unknown; oldName?: unknown; newName?: unknown };
  try { input = await request.json() as typeof input; }
  catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 }); }
  const oldName = typeof input.oldName === "string" ? input.oldName.trim().slice(0, 48) : "";
  const newName = typeof input.newName === "string" ? input.newName.trim().slice(0, 48) : "";
  if (input.action !== "rename-human" || !oldName || !newName) return NextResponse.json({ error: "Invalid annotator rename request." }, { status: 400 });
  await ensureDirectory();
  const ids = (await readdir(recordsDirectory())).filter((file) => file.endsWith(".json")).map((file) => file.slice(0, -5)).filter(validId);
  await mutateRecords(ids, (_id, record) => {
    const previous = record.humans?.[oldName];
    if (!previous || !record.humans) return;
    const existing = record.humans[newName];
    if (!existing || (existing.annotation.updatedAt ?? "") < (previous.annotation.updatedAt ?? "")) record.humans[newName] = { annotatorName: newName, annotation: previous.annotation };
    delete record.humans[oldName];
    if (!Object.keys(record.humans).length) delete record.humans;
  });
  agreementCache = null;
  llmHumanAgreementCache = null;
  paperFrameAgreementCache = null;
  paperFrameLlmHumanAgreementCache = null;
  annotationIndexCache.clear();
  paperFrameMembershipCache = null;
  return NextResponse.json({ renamed: true });
}
