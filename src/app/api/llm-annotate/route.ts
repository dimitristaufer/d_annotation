import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { addLlmUsage } from "@/lib/llm-usage";
import { isCtpLabel } from "@/lib/ctp-label.mjs";
import { buildLlmRecordReadRequest } from "@/lib/llm-record-read.mjs";
import { fetchWithModelRetry } from "@/lib/model-request-control.mjs";
import { ANNOTATION_PROMPT_DIMENSIONS, ANNOTATION_PROMPT_VERSION, DEFAULT_ANNOTATION_PROMPTS, DEFAULT_PERSON_REFERENCE_CRITERIA, PERSON_REFERENCE_RULE, buildMsd1ReferentInventoryPrompt, migrateStoredPromptSet, normalizePersonReferenceCriteria, type AnnotationPromptDimension } from "@/lib/annotation-prompts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

const MODEL = "gpt-6-luna";
const WINDOW_MS = 60_000;
const LIMIT = 30;
const allowed = {
  domains: new Set(["Personal life", "Professional life and education", "Health and caregiving", "Legal and financial", "Public life and culture"]),
  types: new Set(["Fictional or hypothetical people", "Public figures", "Named others", "Unnamed others", "Human groups"]),
  identifiability: new Set(["Directly identifiable", "Indirectly identifiable", "No identifying cues"]),
  purposes: new Set(["Help the requester act", "Inquire about or analyse the CTP", "Transform CTP-related material", "Portray or simulate the CTP"]),
};

type ContextTurn = { role: string; text: string; turnIndex: number };
type RecordData = { id: string; text: string; context: ContextTurn[]; ctpScreeningLabel?: unknown; ctpScreeningRunId?: unknown };
type RecordReadResult = RecordData | { skipped: true; ctpScreeningLabel: unknown; ctpScreeningRunId: unknown } | { unlabeled: true; ctpScreeningRunId: unknown };
type Dimension = typeof ANNOTATION_PROMPT_DIMENSIONS[number]["key"];
type ModelCallDimension = Dimension;
type ModelTrace = { stage: Dimension; model: string; endpoint: string; api: "chat" | "responses"; reasoningEffort: string; requestBody: unknown; httpStatus: number | null; responseJson: unknown; error?: string };

async function reserveSlot() {
  const directory = path.join(process.cwd(), "data");
  const file = path.join(directory, "llm-annotation-rate-limit.json");
  const lock = file + ".lock";
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let lockHandle;
  for (let attempt = 0; attempt < 250; attempt += 1) {
    try { lockHandle = await open(lock, "wx", 0o600); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try { if (Date.now() - (await stat(lock)).mtimeMs > 30_000) await unlink(lock); } catch { /* another request released the stale lock */ }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  if (!lockHandle) throw new Error("Could not acquire the local annotation rate-limit lock.");
  try {
    const now = Date.now();
    let starts: number[] = [];
    try {
      const saved = JSON.parse(await readFile(file, "utf8")) as { starts?: unknown };
      if (Array.isArray(saved.starts)) starts = saved.starts.filter((value): value is number => typeof value === "number" && Number.isFinite(value) && now - value < WINDOW_MS);
    } catch { /* first request creates the persistent window */ }
    if (starts.length >= LIMIT) return Math.max(1, Math.ceil((starts[0] + WINDOW_MS - now) / 1000));
    starts.push(now);
    const temporary = file + "." + randomUUID() + ".tmp";
    await writeFile(temporary, JSON.stringify({ starts }), { mode: 0o600 });
    await rename(temporary, file);
    return 0;
  } finally {
    await lockHandle.close();
    await unlink(lock).catch(() => undefined);
  }
}

function readRecord(recordId: string): Promise<RecordReadResult | null> {
  return new Promise((resolve, reject) => {
  const child = spawn(process.env.PYTHON || "python3", [path.join(process.cwd(), "scripts", "read-record.py")], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { out += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { err += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(err.slice(0, 400) || "Could not read the local message index."));
      try {
        const value = JSON.parse(out) as RecordData & { error?: string; skipped?: boolean; unlabeled?: boolean };
        if (value.skipped === true) {
          resolve({ skipped: true, ctpScreeningLabel: value.ctpScreeningLabel, ctpScreeningRunId: value.ctpScreeningRunId });
          return;
        }
        if (value.unlabeled === true) {
          resolve({ unlabeled: true, ctpScreeningRunId: value.ctpScreeningRunId });
          return;
        }
        resolve(value.error ? null : value);
      } catch { reject(new Error("The local message index returned invalid data.")); }
    });
    child.stdin.end(JSON.stringify(buildLlmRecordReadRequest(recordId)));
  });
}

function resolveEndpoint(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") throw new Error("invalid protocol");
  const currentPath = url.pathname.replace(/\/+$/, "");
  const api: "responses" | "chat" = currentPath.endsWith("/responses") ? "responses" : "chat";
  if (api === "chat" && !currentPath.endsWith("/chat/completions")) {
    const basePath = currentPath.endsWith("/openai/v1") ? currentPath : currentPath.endsWith("/openai") ? currentPath + "/v1" : currentPath || "/openai/v1";
    url.pathname = basePath + "/chat/completions";
  }
  return { url, api };
}

function parseObject(text: string) {
  let parsed: unknown;
  try { parsed = JSON.parse(text.trim()); } catch { throw new Error("The model returned invalid JSON. Check the prompt and try again."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("The model response must be a JSON object. Check the prompt and try again.");
  return parsed as Record<string, unknown>;
}

function safeEndpoint(endpoint: URL) {
  const safe = new URL(endpoint);
  for (const key of [...safe.searchParams.keys()]) if (/key|token|secret|signature|credential/i.test(key)) safe.searchParams.set(key, "[redacted]");
  return safe.toString();
}

async function callModel(endpoint: URL, api: "chat" | "responses", key: string, dimension: ModelCallDimension, prompt: string, record: RecordData, requestSignal: AbortSignal, reasoningEffort: "low" | "medium" | "high", referents?: unknown, personReferenceCriteria?: string): Promise<{ result: Record<string, unknown>; trace: ModelTrace }> {
  const azureHost = endpoint.hostname.includes("azure.com");
  const headers: Record<string, string> = { "content-type": "application/json" };
  headers[azureHost ? "api-key" : "authorization"] = azureHost ? key : "Bearer " + key;
  const system = prompt.trim();
  const payload = JSON.stringify({ recordId: record.id, requesterMessage: record.text, conversationContext: record.context, ...(dimension === "referent" ? { personReferenceCriteria: normalizePersonReferenceCriteria(personReferenceCriteria ?? DEFAULT_PERSON_REFERENCE_CRITERIA) || DEFAULT_PERSON_REFERENCE_CRITERIA } : {}), ...(dimension === "identifiability" || dimension === "domain" || dimension === "purpose" ? { referents: referents ?? [] } : {}) });
  const body = api === "chat"
    ? { model: MODEL, reasoning_effort: reasoningEffort, response_format: { type: "json_object" }, messages: [{ role: "system", content: system }, { role: "user", content: payload }] }
    : { model: MODEL, reasoning: { effort: reasoningEffort }, text: { format: { type: "json_object" } }, input: [{ role: "system", content: [{ type: "input_text", text: system }] }, { role: "user", content: [{ type: "input_text", text: payload }] }] };
  const trace: ModelTrace = { stage: dimension, model: MODEL, endpoint: safeEndpoint(endpoint), api, reasoningEffort, requestBody: body, httpStatus: null, responseJson: null };
  let response: Response;
  try {
    response = await fetchWithModelRetry(
      () => fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.any([requestSignal, AbortSignal.timeout(150_000)]), cache: "no-store" }),
      async () => { try { return await reserveSlot(); } catch { throw new Error("Could not access the shared LLM request limiter."); } },
      requestSignal,
      dimension,
    );
  } catch (error) {
    const message = requestSignal.aborted || error instanceof Error && error.message === "Annotation cancelled." ? "Annotation cancelled."
      : error instanceof Error && error.name === "TimeoutError" ? `The ${dimension} model call timed out. Try again.`
        : error instanceof Error && error.message.includes("shared LLM request limiter") ? error.message
          : error instanceof Error && error.message.includes("rate-limited after") ? `Azure rate-limited the ${dimension} model call after four attempts. Wait briefly and retry.`
            : "Could not connect to the configured Azure model endpoint.";
    trace.error = message;
    throw Object.assign(new Error(message), { modelTrace: trace });
  }
  trace.httpStatus = response.status;
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) trace.error = "Azure rejected the configured credentials. Check endpoint access and AZURE_TUB_KEY.";
    else if (response.status === 404) trace.error = "The endpoint or gpt-6-luna model was not found. Check AZURE_TUB_ENDPOINT.";
    else if (response.status >= 500) trace.error = "Azure is temporarily unavailable. Try again shortly.";
    let detail = "";
    try {
      const failure = await response.json() as { error?: { message?: unknown } | string; message?: unknown };
      const message = typeof failure.error === "object" && failure.error ? failure.error.message : typeof failure.error === "string" ? failure.error : failure.message;
      if (typeof message === "string") detail = message.replace(/[\r\n\t]+/g, " ").slice(0, 280);
    } catch { /* The HTTP status still gives a usable diagnosis. */ }
    trace.responseJson = { error: detail };
    if (!trace.error) trace.error = `Azure rejected the ${dimension} request (HTTP ${response.status}). ${detail || "Check the model endpoint settings."}`;
    throw Object.assign(new Error(trace.error), { modelTrace: trace });
  }
  let envelope: Record<string, unknown>;
  try { envelope = await response.json() as Record<string, unknown>; } catch { trace.error = "Azure returned an invalid model response."; throw Object.assign(new Error(trace.error), { modelTrace: trace }); }
  const usage = envelope.usage as Record<string, unknown> | undefined;
  const inputTokens = usage?.input_tokens ?? usage?.prompt_tokens;
  const outputTokens = usage?.output_tokens ?? usage?.completion_tokens;
  if (typeof inputTokens === "number" && Number.isSafeInteger(inputTokens) && inputTokens >= 0 && typeof outputTokens === "number" && Number.isSafeInteger(outputTokens) && outputTokens >= 0) {
    try { await addLlmUsage(inputTokens, outputTokens); }
    catch (error) { console.error("Could not persist GPT-6-Luna token usage.", error); }
  }
  let content = "";
  if (api === "chat") {
    const choices = envelope.choices as Array<{ message?: { content?: unknown } }> | undefined;
    if (typeof choices?.[0]?.message?.content === "string") content = choices[0].message!.content as string;
  } else if (typeof envelope.output_text === "string") content = envelope.output_text;
  else {
    const output = envelope.output as Array<{ content?: Array<{ type?: string; text?: string }> }> | undefined;
    content = output?.flatMap((item) => item.content || []).find((item) => item.type === "output_text")?.text || "";
  }
  if (!content) { trace.responseJson = envelope; trace.error = `Azure returned no JSON content for ${dimension}.`; throw Object.assign(new Error(trace.error), { modelTrace: trace }); }
  let result: Record<string, unknown>;
  try { result = parseObject(content); }
  catch (error) { trace.responseJson = content; trace.error = error instanceof Error ? error.message : "The model returned invalid JSON."; throw Object.assign(new Error(trace.error), { modelTrace: trace }); }
  trace.responseJson = result;
  return { result, trace };
}

function exactKeys(value: Record<string, unknown>, keys: string[], name: string) {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) throw new Error(name + " result has the wrong JSON fields. Review its prompt and retry.");
}

function labels(value: unknown, valid: Set<string>, name: string) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !valid.has(item)) || new Set(value).size !== value.length) throw new Error(name + " result has invalid labels. Review its prompt and retry.");
  return value as string[];
}

function validateReferents(result: Record<string, unknown>) {
  exactKeys(result, ["referents"], "Referent");
  if (!Array.isArray(result.referents) || result.referents.length > 1000) throw new Error("Referent result must contain an array of at most 1,000 entries.");
  const referents = result.referents.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Referent result contains an invalid item.");
    const entry = item as Record<string, unknown>;
    exactKeys(entry, ["mention", "type"], "Referent item");
    if (typeof entry.mention !== "string" || !entry.mention.trim() || entry.mention.length > 500 || typeof entry.type !== "string" || !allowed.types.has(entry.type)) throw new Error("Referent result has a missing mention or invalid type. Review its prompt and retry.");
    return { mention: entry.mention.trim(), type: entry.type };
  });
  const mentions = referents.map((item) => item.mention.trim().replace(/\s+/g, " ").toLocaleLowerCase());
  if (new Set(mentions).size !== mentions.length) throw new Error("Referent result contains duplicate canonical mentions. Review its prompt and retry.");
  return { referents };
}

function validate(result: { referents: Array<{ mention: string; type: string }>; domain: Record<string, unknown>; identifiability: Record<string, unknown>; purpose: Record<string, unknown> }) {
  exactKeys(result.domain, ["domains"], "Domain");
  exactKeys(result.identifiability, ["referents"], "Identifiability");
  exactKeys(result.purpose, ["purposes"], "Purpose");
  const domains = labels(result.domain.domains, allowed.domains, "Domain");
  const purposes = labels(result.purpose.purposes, allowed.purposes, "Purpose");
  if (!Array.isArray(result.identifiability.referents)) throw new Error("Identifiability result must contain a referents array.");
  const identified = result.identifiability.referents.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Identifiability result contains an invalid item.");
    const entry = item as Record<string, unknown>;
    exactKeys(entry, ["mention", "identifiability"], "Identifiability item");
    if (typeof entry.mention !== "string" || typeof entry.identifiability !== "string" || !allowed.identifiability.has(entry.identifiability)) throw new Error("Identifiability result has an invalid label. Review its prompt and retry.");
    return { mention: entry.mention, identifiability: entry.identifiability };
  });
  if (result.referents.length !== identified.length || result.referents.some((item, i) => item.mention !== identified[i].mention)) throw new Error("Identifiability must return one label per referent, in order, using each canonical mention exactly. Review its prompt and retry.");
  return { domains, purposes, referents: result.referents.map((item, i) => ({ ...item, identifiability: identified[i].identifiability })) };
}

async function prompts() {
  let result = { ...DEFAULT_ANNOTATION_PROMPTS };
  let personReferenceCriteria = DEFAULT_PERSON_REFERENCE_CRITERIA;
  try {
    const fs = await import("node:fs/promises");
    const stored = JSON.parse(await fs.readFile(path.join(process.cwd(), "data", "annotation-prompts.json"), "utf8")) as unknown;
    const migrated = migrateStoredPromptSet(stored);
    result = migrated.prompts;
    personReferenceCriteria = migrated.personReferenceCriteria;
  } catch { /* Use the built-in prompts until the shared prompt file is created. */ }
  return { prompts: result, personReferenceCriteria };
}

function validateHumanInventory(value: unknown) {
  if (!Array.isArray(value) || value.length > 1000) throw new Error("The frozen human inventory must be an array of at most 1,000 referents.");
  const referents = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("The frozen human inventory contains an invalid item.");
    const entry = item as Record<string, unknown>;
    if (typeof entry.mention !== "string" || !entry.mention.trim() || entry.mention.length > 500 || typeof entry.type !== "string" || !allowed.types.has(entry.type) || entry.identifiability !== undefined && (typeof entry.identifiability !== "string" || !allowed.identifiability.has(entry.identifiability))) throw new Error("The frozen human inventory contains a missing mention or invalid label.");
    return { mention: entry.mention.trim(), type: entry.type, ...(entry.identifiability === undefined ? {} : { identifiability: entry.identifiability }) };
  });
  const mentions = referents.map((item) => item.mention.replace(/\s+/g, " ").toLocaleLowerCase());
  if (new Set(mentions).size !== mentions.length) throw new Error("The frozen human inventory contains duplicate canonical mentions.");
  return referents;
}

export async function POST(request: NextRequest) {
  let input: { recordId?: unknown; reasoningEffort?: unknown; prompts?: unknown; personReferenceCriteria?: unknown; personReferencePrompt?: unknown; condition?: unknown; humanInventory?: unknown; includeDiagnostics?: unknown };
  try { input = await request.json() as typeof input; } catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 }); }
  if (typeof input.recordId !== "string" || !input.recordId.trim() || input.recordId.length > 300) return NextResponse.json({ error: "A valid message id is required." }, { status: 400 });
  const condition = input.condition === "human_inventory" ? "human_inventory" : "end_to_end";
  if (input.condition !== undefined && input.condition !== "end_to_end" && input.condition !== "human_inventory") return NextResponse.json({ error: "Condition must be end_to_end or human_inventory." }, { status: 400 });
  if (condition === "human_inventory" && !Array.isArray(input.humanInventory)) return NextResponse.json({ error: "Human-inventory diagnosis requires a frozen human referent inventory." }, { status: 400 });
  const reasoningEffort = input.reasoningEffort === undefined ? "low" : input.reasoningEffort;
  if (reasoningEffort !== "low" && reasoningEffort !== "medium" && reasoningEffort !== "high") return NextResponse.json({ error: "Reasoning effort must be low, medium, or high." }, { status: 400 });
  if (input.prompts !== undefined && (!input.prompts || typeof input.prompts !== "object" || Array.isArray(input.prompts) || ANNOTATION_PROMPT_DIMENSIONS.some(({ key }) => typeof (input.prompts as Record<string, unknown>)[key] !== "string" || ((input.prompts as Record<string, string>)[key]?.length ?? 0) > 50_000))) return NextResponse.json({ error: "A prompt snapshot must contain valid text for each annotation category." }, { status: 400 });
  const suppliedCriteria = input.personReferenceCriteria ?? input.personReferencePrompt;
  if (suppliedCriteria !== undefined && (typeof suppliedCriteria !== "string" || suppliedCriteria.length > 50_000)) return NextResponse.json({ error: "Referent eligibility criteria must be text no longer than 50,000 characters." }, { status: 400 });
  let humanInventory: ReturnType<typeof validateHumanInventory> = [];
  try { if (condition === "human_inventory") humanInventory = validateHumanInventory(input.humanInventory); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid frozen human inventory." }, { status: 400 }); }
  let recordResult: RecordReadResult | null;
  try { recordResult = await readRecord(input.recordId.trim()); }
  catch (error) {
    console.error("Could not verify/read the MSD1 label:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Could not verify the MSD1 label and read the message from the active index." }, { status: 503 });
  }
  if (!recordResult) return NextResponse.json({ error: "This message is not present in the active local index, or has no verified MSD1 label." }, { status: 404 });
  if ("unlabeled" in recordResult) return NextResponse.json({ error: "This message has no verified MSD1 label in the pinned ≥90% English frame; annotation was not started." }, { status: 409, headers: { "cache-control": "no-store" } });
  const ctpLabel = recordResult.ctpScreeningLabel;
  const screeningRunId = recordResult.ctpScreeningRunId;
  if (!isCtpLabel(ctpLabel)) return NextResponse.json({ error: "This message has no verified MSD1 label in the pinned ≥90% English frame; annotation was not started." }, { status: 409, headers: { "cache-control": "no-store" } });
  if (ctpLabel !== "yes") return NextResponse.json({ skipped: true, ctpLabel, screeningRunId }, { headers: { "cache-control": "no-store" } });
  if (typeof screeningRunId !== "string" || "skipped" in recordResult) return NextResponse.json({ error: "The verified MSD1 Yes message could not be read from the active index." }, { status: 503 });
  const record = recordResult;
  const endpoint = process.env.AZURE_TUB_ENDPOINT;
  const key = process.env.AZURE_TUB_KEY;
  if (!endpoint || !key) return NextResponse.json({ error: "LLM annotation is not configured. An administrator must set AZURE_TUB_ENDPOINT and AZURE_TUB_KEY on the server." }, { status: 503 });
  let target: ReturnType<typeof resolveEndpoint>;
  try { target = resolveEndpoint(endpoint); } catch { return NextResponse.json({ error: "AZURE_TUB_ENDPOINT must be a valid HTTPS endpoint URL." }, { status: 503 }); }
  const traces: ModelTrace[] = [];
  const callStage = async (dimension: Dimension, prompt: string, record: RecordData, requestSignal: AbortSignal, effort: "low" | "medium" | "high", referents?: unknown, personReferenceCriteria?: string) => {
    try {
      const result = await callModel(target!.url, target!.api, key!, dimension, prompt, record, requestSignal, effort, referents, personReferenceCriteria);
      traces.push(result.trace);
      return result.result;
    } catch (error) {
      const trace = (error as Error & { modelTrace?: ModelTrace }).modelTrace;
      if (trace) traces.push(trace);
      throw error;
    }
  };
  const traceOrder: Dimension[] = ["referent", "domain", "identifiability", "purpose"];
  const orderedTraces = () => [...traces].sort((left, right) => traceOrder.indexOf(left.stage) - traceOrder.indexOf(right.stage));
  try {
    const sharedPrompts = await prompts();
    const promptsByDimension = input.prompts === undefined ? sharedPrompts.prompts : input.prompts as Record<AnnotationPromptDimension, string>;
    const personReferenceCriteria = typeof suppliedCriteria === "string" ? suppliedCriteria : sharedPrompts.personReferenceCriteria;
    const referentResult = condition === "end_to_end" ? await callStage("referent", buildMsd1ReferentInventoryPrompt(promptsByDimension.referent), record, request.signal, reasoningEffort, undefined, personReferenceCriteria) : null;
    const validatedReferentResult = condition === "end_to_end" ? validateReferents(referentResult!) : null;
    const referents = condition === "human_inventory" ? humanInventory.map(({ mention, type }) => ({ mention, type })) : validatedReferentResult!.referents;
    const relevance = ctpLabel;
    let annotation: ReturnType<typeof validate>;
    const [domain, purpose, identifiability] = await Promise.all([
      callStage("domain", promptsByDimension.domain, record, request.signal, reasoningEffort, referents),
      callStage("purpose", promptsByDimension.purpose, record, request.signal, reasoningEffort, referents),
      referents.length
        ? callStage("identifiability", promptsByDimension.identifiability, record, request.signal, reasoningEffort, referents)
        : Promise.resolve({ referents: [] }),
    ]);
    annotation = validate({ referents, domain, identifiability, purpose });
    const result = { relevance, domains: annotation.domains, referents: annotation.referents, purposes: annotation.purposes, llmAnnotatedAt: new Date().toISOString() };
    return NextResponse.json({ annotation: result, ...(input.includeDiagnostics === true ? { diagnostics: { schemaVersion: 3, promptVersion: ANNOTATION_PROMPT_VERSION, condition, personReferenceRule: PERSON_REFERENCE_RULE, ctpScreeningLabel: ctpLabel, ctpScreeningRunId: screeningRunId, model: MODEL, reasoningEffort, frozenHumanInventory: condition === "human_inventory" ? humanInventory : undefined, sourceContext: record.context, stages: orderedTraces() } } : {}) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error during LLM annotation.";
    console.error("LLM annotation failed:", message);
    return NextResponse.json({ error: message, ...(input.includeDiagnostics === true ? { diagnostics: { schemaVersion: 3, promptVersion: ANNOTATION_PROMPT_VERSION, condition, personReferenceRule: PERSON_REFERENCE_RULE, ctpScreeningLabel: ctpLabel, ctpScreeningRunId: screeningRunId, model: MODEL, reasoningEffort, frozenHumanInventory: condition === "human_inventory" ? humanInventory : undefined, stages: orderedTraces() } } : {}) }, { status: 502, headers: { "cache-control": "no-store" } });
  }
}
