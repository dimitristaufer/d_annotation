"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight, LoaderCircle, Search } from "lucide-react";

type Band = "primary" | "sensitivity" | "near_verbatim";
type SimilarityPair = { leftRecordId: string; rightRecordId: string; cosineSimilarity: number; leftPreview: string; rightPreview: string };
type Result = { band: Band; page: number; pageSize: number; total: number; totalPages: number; counts: Record<Band, number>; model: string; revision: string; records: number; pairs: SimilarityPair[] };
type ContextTurn = { role: string; text: string; turnIndex: number };
type ContextResult = { context: ContextTurn[]; text?: string; error?: string };

const BANDS: Array<{ id: Band; title: string; cutoff: string; detail: string }> = [
  { id: "primary", title: "High-similarity candidates", cutoff: "Cosine ≥ 0.999", detail: "Review each pair in context" },
  { id: "sensitivity", title: "Broader candidates", cutoff: "0.995 ≤ cosine < 0.999", detail: "Lower-confidence review candidates" },
  { id: "near_verbatim", title: "Highest-similarity candidates", cutoff: "Cosine ≥ 0.9999", detail: "Subset by score only" },
];

function formatCount(value: number | undefined) {
  return typeof value === "number" ? value.toLocaleString() : "—";
}

function RoleContext({ turns, error }: { turns: ContextTurn[] | null; error?: string }) {
  if (error) return <p className="similarity-detail-error" role="alert">{error}</p>;
  if (!turns) return <div className="similarity-context-loading"><LoaderCircle size={17} className="spin" /> Loading conversation context…</div>;
  return <div className="similarity-context-turns">{turns.map((turn, index) => {
    const requester = ["user", "requester"].includes(turn.role.toLowerCase());
    const target = index === turns.length - 1 && requester;
    return <article className={`similarity-context-turn ${target ? "similarity-context-target" : ""}`} key={`${turn.turnIndex}-${index}`}>
      <span>{requester ? "Requester" : turn.role}</span>
      {target && <b>TARGET FIRST MESSAGE</b>}
      <p>{turn.text}</p>
    </article>;
  })}</div>;
}

export default function NearDuplicatesPage() {
  const [band, setBand] = useState<Band>("primary");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<Result | null>(null);
  const [counts, setCounts] = useState<Record<Band, number> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<SimilarityPair | null>(null);
  const [contexts, setContexts] = useState<[ContextTurn[] | null, ContextTurn[] | null]>([null, null]);
  const [contextError, setContextError] = useState("");
  const [contextLoading, setContextLoading] = useState(false);
  const contextRequestId = useRef(0);

  const load = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ band, page: String(page), limit: "24" });
      const response = await fetch(`/api/embedding-similarities?${params}`, { signal, cache: "no-store" });
      const payload = await response.json() as Result & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not load similarity candidates.");
      setResult(payload);
      setCounts(payload.counts);
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load similarity candidates.");
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [band, page]);

  useEffect(() => {
    const requestedBand = new URLSearchParams(window.location.search).get("band");
    if (requestedBand === "primary" || requestedBand === "sensitivity" || requestedBand === "near_verbatim") {
      window.history.replaceState(window.history.state, "", window.location.pathname);
      if (requestedBand !== band) {
        setBand(requestedBand);
        setPage(1);
        return;
      }
    }
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [band, load]);

  const openPair = (pair: SimilarityPair) => {
    const requestId = ++contextRequestId.current;
    setSelected(pair);
    setContexts([null, null]);
    setContextError("");
    setContextLoading(true);
    const requests = [pair.leftRecordId, pair.rightRecordId].map(async (recordId) => {
      const response = await fetch(`/api/context?recordId=${encodeURIComponent(recordId)}`, { cache: "no-store" });
      const payload = await response.json() as ContextResult;
      if (!response.ok) throw new Error(payload.error || "Could not load the selected message context.");
      return payload.context;
    });
    void Promise.all(requests).then(([left, right]) => {
      if (requestId === contextRequestId.current) setContexts([left, right]);
    }).catch((cause: unknown) => {
      if (requestId === contextRequestId.current) setContextError(cause instanceof Error ? cause.message : "Could not load the selected message context.");
    }).finally(() => { if (requestId === contextRequestId.current) setContextLoading(false); });
  };

  const changeBand = (next: Band) => {
    contextRequestId.current += 1;
    setSelected(null);
    setResult(null);
    setBand(next);
    setPage(1);
  };

  const total = counts?.[band] ?? result?.total ?? 0;
  const totalPages = Math.ceil(total / 24);

  return <main className="similarity-page">
    <header className="similarity-header">
      <a href="/" className="similarity-back"><ArrowLeft size={15} /> Back to annotation tool</a>
      <div className="similarity-title-row">
        <div><div className="eyebrow">WILDCHAT FIRST-MESSAGE FRAME</div><h1>Embedding similarity review</h1></div>
        <span className="similarity-readonly">Review only · CTP annotations are unchanged</span>
      </div>
      <p className="similarity-intro">Browse high-similarity pairs among retained signal-positive first messages. A manual audit found pairs with changed subjects, recipe contents, and quoted requests, so similarity is only a discovery aid: it does not remove screening messages, transfer labels, or establish duplicates.</p>
      <div className="similarity-band-row" role="group" aria-label="Cosine similarity review band">
        {BANDS.map((item) => <button key={item.id} type="button" className={`similarity-band ${band === item.id ? "is-selected" : ""}`} onClick={() => changeBand(item.id)}>
          <span>{item.title}</span><b>{item.cutoff}</b><small>{item.detail}</small><strong>{formatCount(counts?.[item.id])} pairs</strong>
        </button>)}
      </div>
      <div className="similarity-method-note"><b>Review pairs, not a screening frame.</b> Counts are unique unordered pairs from each message’s exact top-100 neighbors at cosine ≥ 0.995; reciprocal matches are shown once. Some rows reached the 100-neighbor cap, so additional qualifying pairs may be absent. Compare full target text and conversation context before treating any pair as equivalent; no pair is excluded from CTP screening.</div>
    </header>

    <div className="similarity-content">
      <section className="similarity-pair-list" aria-label="Candidate message pairs">
        <div className="similarity-list-heading"><div><span className="eyebrow">{BANDS.find((item) => item.id === band)?.title.toUpperCase()}</span><h2>{loading ? "Loading candidates" : `${formatCount(total)} candidate pairs`}</h2></div><small>{result?.model ?? "BAAI/bge-small-en-v1.5"}</small></div>
        {error ? <div className="similarity-state similarity-error" role="alert"><b>Could not load similarity data</b><span>{error}</span></div> : loading && !result ? <div className="similarity-state"><LoaderCircle size={18} className="spin" /> Loading similarity candidates…</div> : result?.pairs.length ? <>
          <div className="similarity-pairs-scroll">{result.pairs.map((pair) => <button type="button" key={`${pair.leftRecordId}:${pair.rightRecordId}`} className={`similarity-pair ${selected?.leftRecordId === pair.leftRecordId && selected?.rightRecordId === pair.rightRecordId ? "is-selected" : ""}`} onClick={() => openPair(pair)}>
            <span className="similarity-pair-score">Cosine <b>{pair.cosineSimilarity.toFixed(6)}</b></span>
            <span className="similarity-preview-pair"><span><small>{pair.leftRecordId}</small>{pair.leftPreview}</span><span><small>{pair.rightRecordId}</small>{pair.rightPreview}</span></span>
          </button>)}</div>
          <div className="similarity-pagination"><span>Page {formatCount(page)} of {formatCount(totalPages)}</span><div><button type="button" aria-label="Previous page" disabled={page <= 1 || loading} onClick={() => { contextRequestId.current += 1; setSelected(null); setResult(null); setPage((value) => Math.max(1, value - 1)); }}><ChevronLeft size={15} /></button><button type="button" aria-label="Next page" disabled={page >= totalPages || loading} onClick={() => { contextRequestId.current += 1; setSelected(null); setResult(null); setPage((value) => Math.min(totalPages, value + 1)); }}><ChevronRight size={15} /></button></div></div>
        </> : <div className="similarity-state"><Search size={18} /> No candidate pairs in this band.</div>}
      </section>

      <section className="similarity-detail" aria-label="Selected pair comparison">
        {!selected ? <div className="similarity-empty-detail"><Search size={21} /><h2>Select a pair to compare</h2><p>The complete conversation prefix through each target first message will appear here.</p></div> : <>
          <div className="similarity-detail-heading"><div><span className="eyebrow">PAIR COMPARISON</span><h2>Cosine similarity {selected.cosineSimilarity.toFixed(6)}</h2></div><span className="similarity-readonly">No labels saved</span></div>
          {contextLoading && <div className="similarity-context-loading"><LoaderCircle size={17} className="spin" /> Loading both conversation prefixes…</div>}
          {contextError && <p className="similarity-detail-error" role="alert">{contextError}</p>}
          {!contextError && !contextLoading && <div className="similarity-context-grid">
            <section><header><b>Message A</b><code>{selected.leftRecordId}</code></header><RoleContext turns={contexts[0]} /></section>
            <section><header><b>Message B</b><code>{selected.rightRecordId}</code></header><RoleContext turns={contexts[1]} /></section>
          </div>}
        </>}
      </section>
    </div>
  </main>;
}
