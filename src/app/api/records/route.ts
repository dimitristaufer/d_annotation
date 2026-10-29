import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { searchWorkers, type SearchEvent } from "@/lib/search-workers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type SignalSet = { personReference?: boolean; personName: boolean; personNoun: boolean; personPronoun: boolean; coreference: boolean; embeddedContent: boolean };
type EvidenceSpan = { text: string; start: number; end: number; lemma?: string; label?: string; requester_reference?: boolean; cluster_index?: number; turn_index?: number };
type Screening = { target: SignalSet; conversation: SignalSet; names: EvidenceSpan[]; nouns: EvidenceSpan[]; pronouns: EvidenceSpan[]; coreferenceMentions: EvidenceSpan[] };
type Turn = { role: string; text: string; turnIndex: number };
export type RecordRow = { id: string; sampleKey: string; conversationId: string; sourceConversationId: string; sourceShard: string; sourceRow: number; turnIndex: number; requesterTurnIndex: number; stratum: string; text: string; context?: Turn[]; duplicateGroup?: { id: string; size: number }; screening: Screening; metadata: { language: string; characters: number; words: number; conversationTurns: number; personCoreferenceClusters?: number; personCoreferenceMentions?: number; requesterWords?: number; personCoreferencePer100Words?: number } };

type Query = { q: string; stratum: string; signals: string[]; presidio: boolean; match: "all" | "any"; coref_min_mentions: number; coref_min_rate: number; page: number; limit: number; exclude: string[]; include: string[]; include_only: boolean; include_context: boolean; action: "search" | "page" | "sample"; jobId: string; unit: string; sample_n: number; seed: string; ids_only: boolean; first_messages_only: boolean; paper_first_messages_only: boolean; unique_groups: boolean; duplicate_cluster_id: string; ctp_label: "yes" | "no" | "unclear" | "" };

async function handle(request: NextRequest, body?: { exclude?: unknown; include?: unknown; includeOnly?: unknown }) {
  const params = request.nextUrl.searchParams;
  const rawSignals = params.getAll("signal").flatMap((value) => value.split(","));
  const signals = [...new Set(rawSignals.filter((value) => ["names", "nouns", "pronouns", "coreference", "embedded"].includes(value)))];
  const page = Math.max(1, Number(params.get("page") ?? 1));
  const requestedJob = params.get("jobId") ?? "";
  const action = params.get("action") === "sample" ? "sample" : page > 1 && requestedJob ? "page" : "search";
  const query: Query = {
    q: (params.get("q") ?? "").trim(),
    stratum: params.get("stratum") ?? "all",
    signals,
    presidio: params.get("presidio") === "1",
    match: params.get("match") === "all" ? "all" : "any",
    coref_min_mentions: Math.min(100000, Math.max(0, Math.trunc(Number(params.get("corefMinMentions") ?? 0) || 0))),
    coref_min_rate: Math.min(100000, Math.max(0, Number(params.get("corefMinRate") ?? 0) || 0)),
    page,
    limit: Math.min(50, Math.max(1, Number(params.get("limit") ?? 24))),
    exclude: Array.isArray(body?.exclude) ? body.exclude.filter((item): item is string => typeof item === "string") : [],
    include: Array.isArray(body?.include) ? body.include.filter((item): item is string => typeof item === "string") : [],
    include_only: body?.includeOnly === true,
    include_context: params.get("context") !== "0",
    action,
    jobId: requestedJob.replace(/[^a-z0-9]/gi, "") || randomUUID().replace(/-/g, ""),
    unit: ["messages", "conversations", "first_messages", "paper_first_messages", "embedding_sensitivity", "embedding_primary", "embedding_near_verbatim", "english_ge_90", "english_ge_80", "english_ge_50"].includes(params.get("unit") ?? "") ? params.get("unit")! : "messages",
    sample_n: Math.min(5000, Math.max(1, Math.trunc(Number(params.get("n") ?? 1) || 1))),
    seed: params.get("seed") ?? "wildchat-prescreen-v1",
    ids_only: params.get("idsOnly") === "1",
    first_messages_only: params.get("unit") === "first_messages",
    paper_first_messages_only: params.get("unit") === "paper_first_messages",
    ctp_label: ["yes", "no", "unclear"].includes(params.get("ctpLabel") ?? "") ? params.get("ctpLabel") as "yes" | "no" | "unclear" : "",
    unique_groups: params.get("uniqueGroups") === "1",
    duplicate_cluster_id: /^(?:tc|pf)_\d{1,20}$/.test(params.get("duplicateClusterId") ?? "") ? params.get("duplicateClusterId")! : "",
  };

  const encoder = new TextEncoder();
  let cancelTask = () => {};
  let closed = false;
  let signalHandler: (() => void) | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        if (closed) return;
        closed = true;
        if (signalHandler) request.signal.removeEventListener("abort", signalHandler);
        try { controller.close(); } catch { /* the client may already have disconnected */ }
      };
      const send = (event: SearchEvent) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)); }
        catch { closed = true; cancelTask(); }
      };
      const dispatch = (task: Query) => {
        cancelTask = searchWorkers.submit(task as unknown as Record<string, unknown>, (event) => {
          if (event.event === "cache_miss" && task.action === "page") {
            dispatch({ ...task, action: "search", jobId: randomUUID().replace(/-/g, "") });
            return;
          }
          send(event);
          if (["complete", "page", "sample", "error", "cancelled"].includes(event.event)) close();
        }, request.signal);
      };
      signalHandler = () => { cancelTask(); close(); };
      if (request.signal.aborted) { close(); return; }
      request.signal.addEventListener("abort", signalHandler, { once: true });
      dispatch(query);
    },
    cancel() { closed = true; cancelTask(); },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "private, no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  const body = await request.json() as { exclude?: unknown; include?: unknown; includeOnly?: unknown };
  return handle(request, body);
}
