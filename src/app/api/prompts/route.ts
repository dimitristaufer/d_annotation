import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { ANNOTATION_PROMPT_DIMENSIONS, ANNOTATION_PROMPT_VERSION, DEFAULT_ANNOTATION_PROMPTS, DEFAULT_PERSON_REFERENCE_CRITERIA, PERSON_REFERENCE_RULE, migrateStoredPromptSet, type AnnotationPromptDimension } from "@/lib/annotation-prompts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PROMPT_LENGTH = 50_000;
const promptFile = () => path.join(process.cwd(), "data", "annotation-prompts.json");
const promptHistoryFile = () => path.join(process.cwd(), "data", "annotation-prompt-history.json");
let writeQueue: Promise<void> = Promise.resolve();

function serializeWrite<T>(action: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(action, action);
  writeQueue = result.then(() => undefined, () => undefined);
  return result;
}

type SharedPrompts = { prompts: Record<AnnotationPromptDimension, string>; personReferenceCriteria: string };

async function writePrompts(value: SharedPrompts) {
  const filePath = promptFile();
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify({ schemaVersion: 3, promptVersion: ANNOTATION_PROMPT_VERSION, updatedAt: new Date().toISOString(), ...value }), { mode: 0o600 });
  await rename(temporaryPath, filePath);
}

async function preservePromptSet(value: unknown) {
  const old = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const oldVersion = typeof old.promptVersion === "string" ? old.promptVersion : "unknown";
  const hasClearReferenceRule = oldVersion.startsWith("simple-referent-inventory-v");
  const snapshot = {
    ...(old.prompts && typeof old.prompts === "object" ? { prompts: old.prompts } : {}),
    ...(typeof old.personReferencePrompt === "string" ? { personReferencePrompt: old.personReferencePrompt } : {}),
    ...(typeof old.personReferenceCriteria === "string" ? { personReferenceCriteria: old.personReferenceCriteria } : {}),
    ...(old.legacyPrompts && typeof old.legacyPrompts === "object" ? { legacyPrompts: old.legacyPrompts } : {}),
    ...(typeof old.legacyRelevancePrompt === "string" ? { legacyRelevancePrompt: old.legacyRelevancePrompt } : {}),
    ...(typeof old.updatedAt === "string" ? { updatedAt: old.updatedAt } : {}),
    ...(typeof old.personReferenceRule === "string" ? { personReferenceRule: old.personReferenceRule } : { personReferenceRule: hasClearReferenceRule ? PERSON_REFERENCE_RULE : "Legacy instructions stored as a separate Contains CTPs model prompt." }),
    promptVersion: oldVersion,
  };
  const id = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex").slice(0, 24);
  let versions: Array<Record<string, unknown>> = [];
  try {
    const existing = JSON.parse(await readFile(promptHistoryFile(), "utf8")) as { versions?: unknown };
    if (Array.isArray(existing.versions)) versions = existing.versions.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)));
  } catch { /* Create the prompt history on the first saved edit. */ }
  if (versions.some((entry) => entry.id === id)) return;
  versions.push({ ...snapshot, id, savedAt: new Date().toISOString(), label: hasClearReferenceRule ? "Previous prompt set" : "Previous prompt set (legacy terminology)" });
  const filePath = promptHistoryFile();
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify({ versions }), { mode: 0o600 });
  await rename(temporaryPath, filePath);
}

async function readPrompts() {
  try {
    const stored = JSON.parse(await readFile(promptFile(), "utf8")) as Record<string, unknown>;
    const migrated = migrateStoredPromptSet(stored);
    if (migrated.needsMigration) {
      await preservePromptSet(stored);
      const current: SharedPrompts = { prompts: migrated.prompts, personReferenceCriteria: migrated.personReferenceCriteria };
      await writePrompts(current);
      return current;
    }
    return { prompts: migrated.prompts, personReferenceCriteria: migrated.personReferenceCriteria };
  } catch { return { prompts: { ...DEFAULT_ANNOTATION_PROMPTS }, personReferenceCriteria: DEFAULT_PERSON_REFERENCE_CRITERIA }; }
}

export async function GET() {
  const shared = await serializeWrite(async () => {
    try { return await readPrompts(); }
    catch {
      const defaults = { prompts: { ...DEFAULT_ANNOTATION_PROMPTS }, personReferenceCriteria: DEFAULT_PERSON_REFERENCE_CRITERIA };
      await writePrompts(defaults);
      return defaults;
    }
  });
  return NextResponse.json({ prompts: shared.prompts, personReferenceCriteria: shared.personReferenceCriteria, promptVersion: ANNOTATION_PROMPT_VERSION, personReferenceRule: PERSON_REFERENCE_RULE }, { headers: { "cache-control": "no-store" } });
}

export async function PUT(request: NextRequest) {
  let input: { dimension?: unknown; prompt?: unknown };
  try { input = await request.json() as { dimension?: unknown; prompt?: unknown }; }
  catch { return NextResponse.json({ error: "Invalid prompt update." }, { status: 400 }); }
  const dimension = input.dimension;
  const isAnnotationDimension = ANNOTATION_PROMPT_DIMENSIONS.some(({ key }) => key === dimension);
  if (!isAnnotationDimension && dimension !== "personReference" && dimension !== "relevance") return NextResponse.json({ error: "Unknown annotation dimension." }, { status: 400 });
  if (typeof input.prompt !== "string" || input.prompt.length > MAX_PROMPT_LENGTH) {
    return NextResponse.json({ error: `Prompt must be text no longer than ${MAX_PROMPT_LENGTH.toLocaleString()} characters.` }, { status: 400 });
  }
  const shared = await serializeWrite(async () => {
    const current = await readPrompts();
    const isPersonReferenceCriteria = dimension === "personReference" || dimension === "relevance";
    const updated = isPersonReferenceCriteria
      ? { ...current, personReferenceCriteria: input.prompt as string }
      : { ...current, prompts: { ...current.prompts, [dimension as AnnotationPromptDimension]: input.prompt as string } };
    if (isPersonReferenceCriteria ? current.personReferenceCriteria !== updated.personReferenceCriteria : current.prompts[dimension as AnnotationPromptDimension] !== updated.prompts[dimension as AnnotationPromptDimension]) {
      await preservePromptSet(current);
    }
    await writePrompts(updated);
    return updated;
  });
  return NextResponse.json({ prompts: shared.prompts, personReferenceCriteria: shared.personReferenceCriteria, promptVersion: ANNOTATION_PROMPT_VERSION, personReferenceRule: PERSON_REFERENCE_RULE }, { headers: { "cache-control": "no-store" } });
}
