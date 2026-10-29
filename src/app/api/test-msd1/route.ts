import { spawn } from "node:child_process";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { validateMsd1ChoiceAnswer } from "@/lib/msd1-evaluation.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

type ContextTurn = { role: string; text: string; turnIndex: number };
type RecordData = { id: string; text: string; context: ContextTurn[] };
type Msd1Settings = {
  instructions: string;
  criteria: { yes: string; no: string; unclear: string };
  stateFormat: "structured" | "text";
  optionOrder: Array<"yes" | "no" | "unclear">;
};

function readRecord(recordId: string): Promise<RecordData | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PYTHON || "python3", [path.join(process.cwd(), "scripts", "read-record.py")], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(stderr.slice(0, 300) || "Could not read the local message index."));
      try {
        const value = JSON.parse(stdout) as RecordData & { error?: string };
        resolve(value.error ? null : value);
      } catch { reject(new Error("The local message index returned invalid data.")); }
    });
    child.stdin.end(JSON.stringify({ recordId, includeContext: true }));
  });
}

function resolveDecisionEndpoint(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("MSD1 endpoint must use HTTPS.");
  let basePath = url.pathname.replace(/\/+$/, "");
  basePath = basePath.replace(/\/providers\/microsoft\/v1\/systemone$/i, "");
  basePath = basePath.replace(/\/openai(?:\/v1)?$/i, "");
  url.pathname = `${basePath}/providers/microsoft/v1/systemone`;
  url.search = "";
  url.hash = "";
  return url;
}

function validationError(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "Request body must be a JSON object.";
  const value = input as Record<string, unknown>;
  if (typeof value.recordId !== "string" || !/^[A-Za-z0-9_:-]{1,128}$/.test(value.recordId)) return "Provide a valid indexed message id.";
  if (typeof value.instructions !== "string" || !value.instructions.trim() || value.instructions.length > 5_000) return "Instructions must contain 1–5,000 characters.";
  if (value.stateFormat !== "structured" && value.stateFormat !== "text") return "Choose a supported MSD1 state format.";
  if (!Array.isArray(value.optionOrder) || value.optionOrder.length !== 3 || new Set(value.optionOrder).size !== 3 || value.optionOrder.some((label) => !["yes", "no", "unclear"].includes(String(label)))) return "Option order must include Yes, No, and Unclear exactly once.";
  if (!value.criteria || typeof value.criteria !== "object" || Array.isArray(value.criteria)) return "Provide definitions for Yes, No, and Unclear.";
  const criteria = value.criteria as Record<string, unknown>;
  if (["yes", "no", "unclear"].some((label) => typeof criteria[label] !== "string" || !String(criteria[label]).trim() || String(criteria[label]).length > 5_000)) return "Each option definition must contain 1–5,000 characters.";
  return null;
}

function buildState(record: RecordData, stateFormat: Msd1Settings["stateFormat"]) {
  const context = Array.isArray(record.context) ? record.context : [];
  const last = context[context.length - 1];
  const contextBeforeTarget = last?.text === record.text ? context.slice(0, -1) : context;
  if (stateFormat === "structured") return { target_requester_message: record.text, context_before_target: contextBeforeTarget.map(({ role, text }) => ({ role, text })) };
  const earlier = contextBeforeTarget.length
    ? contextBeforeTarget.map((turn) => `${turn.role}: ${turn.text}`).join("\n")
    : "(none)";
  return `Target requester message:\n${record.text}\n\nEarlier conversation context (only to clarify the target):\n${earlier}`;
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function POST(request: NextRequest) {
  let input: unknown;
  try { input = await request.json(); } catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 }); }
  const invalid = validationError(input);
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });
  const value = input as Msd1Settings & { recordId: string };
  const key = process.env.AZURE_TUB_KEY;
  if (!key) return NextResponse.json({ error: "MSD1 testing is not configured. Set AZURE_TUB_KEY on the research Mac." }, { status: 503 });
  let endpoint: URL;
  try { endpoint = resolveDecisionEndpoint(process.env.AZURE_MSD1_ENDPOINT || "https://tub-ias.services.ai.azure.com"); }
  catch { return NextResponse.json({ error: "AZURE_MSD1_ENDPOINT must be a valid HTTPS Foundry resource endpoint." }, { status: 503 }); }
  const deployment = process.env.AZURE_MSD1_DEPLOYMENT || "MSD1";
  try {
    const record = await readRecord(value.recordId);
    if (!record) return NextResponse.json({ error: "This message is not present in the active local index." }, { status: 404 });
    const state = buildState(record, value.stateFormat);
    const body = JSON.stringify({
      model: deployment,
      state,
      questions: {
        contains_ctps: {
          type: "choice",
          instructions: value.instructions.trim(),
          criteria: Object.fromEntries(value.optionOrder.map((label) => [label, value.criteria[label].trim()])),
        },
      },
    });
    if (body.length > 3_000_000) return NextResponse.json({ error: "This message and its context exceed the MSD1 test request limit." }, { status: 413 });
    const started = Date.now();
    let response: Response | null = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", "api-key": key },
        body,
        cache: "no-store",
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(90_000)]),
      });
      if (![429, 503].includes(response.status) || attempt === 3) break;
      const retrySeconds = Number(response.headers.get("retry-after"));
      await delay(Number.isFinite(retrySeconds) && retrySeconds > 0 ? Math.min(10_000, retrySeconds * 1000) : (attempt + 1) * 1_000);
    }
    if (!response?.ok) {
      const status = response?.status ?? 502;
      return NextResponse.json({ error: status === 429 ? "MSD1 is rate-limiting requests. Wait briefly, then resume the test." : `MSD1 rejected the test request (HTTP ${status}). Check the deployment name and criteria.` }, { status: status === 429 ? 429 : 502, headers: { "cache-control": "no-store" } });
    }
    let envelope: Record<string, unknown>;
    try { envelope = await response.json() as Record<string, unknown>; }
    catch { return NextResponse.json({ error: "MSD1 returned invalid JSON." }, { status: 502 }); }
    const answers = envelope.answers as Record<string, unknown> | undefined;
    let result: ReturnType<typeof validateMsd1ChoiceAnswer>;
    try { result = validateMsd1ChoiceAnswer(answers?.contains_ctps); }
    catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "MSD1 returned an invalid decision." }, { status: 502 }); }
    return NextResponse.json({
      recordId: record.id,
      choice: result.choice,
      probabilities: result.probabilities,
      confidence: result.probabilities[result.choice],
      model: typeof envelope.model === "string" ? envelope.model : "microsoft-decision-1",
      deployment,
      elapsedMs: Date.now() - started,
      excerpt: record.text.replace(/\s+/g, " ").slice(0, 360),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (request.signal.aborted) return NextResponse.json({ error: "MSD1 test request cancelled." }, { status: 499 });
    if (error instanceof Error && error.name === "TimeoutError") return NextResponse.json({ error: "MSD1 timed out. You can retry this message." }, { status: 504 });
    console.error("MSD1 test request failed.", error instanceof Error ? error.message : "Unknown error");
    return NextResponse.json({ error: "Could not reach the configured MSD1 deployment." }, { status: 502 });
  }
}
