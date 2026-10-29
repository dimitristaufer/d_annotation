"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Download, LoaderCircle, X } from "lucide-react";
import { DEFAULT_MSD1_TEST_SETTINGS, binaryMsd1Counts, effectiveMsd1Label, filterMsd1ReviewerRecords, filterMsd1RowsByMinimumConfidence, scoreMsd1Agreement } from "@/lib/msd1-evaluation.mjs";

type HumanLabel = "yes" | "no" | "uncertain";
type AnnotationCompleteness = "fully" | "partially" | "all";
type Reviewer = { name: string; records: Array<{ recordId: string; humanLabel: HumanLabel; annotationCompleteness: Exclude<AnnotationCompleteness, "all"> }> };
type ChoiceLabel = "yes" | "no" | "unclear";
type Msd1Settings = {
  instructions: string;
  criteria: { yes: string; no: string; unclear: string };
  stateFormat: "structured" | "text";
  optionOrder: ChoiceLabel[];
  confidenceThreshold: number;
};
type TestRow = {
  recordId: string;
  humanLabel: HumanLabel;
  annotationCompleteness?: Exclude<AnnotationCompleteness, "all">;
  choice?: ChoiceLabel;
  probabilities?: Record<ChoiceLabel, number>;
  confidence?: number;
  model?: string;
  elapsedMs?: number;
  excerpt?: string;
  error?: string;
};
type TestRun = { id: string; reviewer: string; startedAt: string; completedAt: string; settings: Msd1Settings; annotationCompleteness: AnnotationCompleteness; minimumConfidenceThreshold: number; rows: TestRow[] };
type Progress = { active: boolean; current: number; total: number; error: string };

const labelText: Record<ChoiceLabel | HumanLabel, string> = { yes: "Yes", no: "No", unclear: "Unclear", uncertain: "Unclear" };
const orderOptions: Array<{ value: string; labels: ChoiceLabel[]; label: string }> = [
  { value: "yes-no-unclear", labels: ["yes", "no", "unclear"], label: "Yes · No · Unclear" },
  { value: "no-yes-unclear", labels: ["no", "yes", "unclear"], label: "No · Yes · Unclear" },
  { value: "unclear-no-yes", labels: ["unclear", "no", "yes"], label: "Unclear · No · Yes" },
];

function copyDefaults(): Msd1Settings {
  return {
    instructions: DEFAULT_MSD1_TEST_SETTINGS.instructions,
    criteria: { ...DEFAULT_MSD1_TEST_SETTINGS.criteria },
    stateFormat: DEFAULT_MSD1_TEST_SETTINGS.stateFormat,
    optionOrder: [...DEFAULT_MSD1_TEST_SETTINGS.optionOrder] as ChoiceLabel[],
    confidenceThreshold: DEFAULT_MSD1_TEST_SETTINGS.confidenceThreshold,
  };
}

function csvCell(value: unknown) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

export function Msd1TestingTool({ reviewers, disabled = false }: { reviewers: Reviewer[]; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [reviewer, setReviewer] = useState("Kirsten");
  const [annotationCompleteness, setAnnotationCompleteness] = useState<AnnotationCompleteness>("fully");
  const [settings, setSettings] = useState<Msd1Settings>(copyDefaults);
  const [runs, setRuns] = useState<TestRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [minimumConfidenceThreshold, setMinimumConfidenceThreshold] = useState(0);
  const [workingRows, setWorkingRows] = useState<TestRow[]>([]);
  const [progress, setProgress] = useState<Progress>({ active: false, current: 0, total: 0, error: "" });
  const abortRef = useRef<AbortController | null>(null);
  const [fullMessageRecordId, setFullMessageRecordId] = useState<string | null>(null);
  const [fullMessageText, setFullMessageText] = useState("");
  const [fullMessageLoading, setFullMessageLoading] = useState(false);
  const [fullMessageError, setFullMessageError] = useState("");
  const fullMessageControllerRef = useRef<AbortController | null>(null);

  const selectedReviewer = reviewers.find((item) => item.name === reviewer) ?? reviewers[0];
  const selectedRecords = filterMsd1ReviewerRecords(selectedReviewer?.records ?? [], annotationCompleteness) as Reviewer["records"];
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? null;
  const visibleRows = progress.active ? workingRows : selectedRun?.rows ?? [];
  const succeededRows = visibleRows.filter((row) => !row.error && row.choice);
  const includedRows = filterMsd1RowsByMinimumConfidence(succeededRows, minimumConfidenceThreshold) as TestRow[];
  const includedRecordIds = new Set(includedRows.map((row) => row.recordId));
  const excludedConfidenceRows = succeededRows.length - includedRows.length;
  const agreement = useMemo(() => scoreMsd1Agreement(includedRows, settings.confidenceThreshold), [includedRows, settings.confidenceThreshold]);
  const recentRuns = useMemo(() => [...runs].reverse(), [runs]);

  const openTool = () => {
    if (!reviewers.length) return;
    setReviewer((current) => reviewers.some((item) => item.name === current) ? current : reviewers.some((item) => item.name === "Kirsten") ? "Kirsten" : reviewers[0].name);
    setWorkingRows([]);
    setProgress({ active: false, current: 0, total: 0, error: "" });
    setOpen(true);
  };

  const runTest = async () => {
    if (!selectedReviewer || !selectedRecords.length || progress.active) return;
    const selectedRecordsSnapshot = [...selectedRecords];
    const annotationCompletenessSnapshot = annotationCompleteness;
    const controller = new AbortController();
    abortRef.current = controller;
    const settingsSnapshot: Msd1Settings = { ...settings, criteria: { ...settings.criteria }, optionOrder: [...settings.optionOrder] };
    const startedAt = new Date().toISOString();
    const currentRows: TestRow[] = [];
    setMinimumConfidenceThreshold(0);
    setSelectedRunId("");
    setWorkingRows([]);
    setProgress({ active: true, current: 0, total: selectedRecordsSnapshot.length, error: "" });
    for (let index = 0; index < selectedRecordsSnapshot.length; index += 1) {
      if (controller.signal.aborted) break;
      const item = selectedRecordsSnapshot[index];
      setProgress((current) => ({ ...current, current: index + 1 }));
      let row: TestRow;
      try {
        const response = await fetch("/api/test-msd1", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ recordId: item.recordId, instructions: settingsSnapshot.instructions, criteria: settingsSnapshot.criteria, stateFormat: settingsSnapshot.stateFormat, optionOrder: settingsSnapshot.optionOrder }),
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = await response.json() as { error?: string; choice?: ChoiceLabel; probabilities?: Record<ChoiceLabel, number>; confidence?: number; model?: string; elapsedMs?: number; excerpt?: string };
        if (!response.ok || !payload.choice || !payload.probabilities) throw new Error(payload.error || `MSD1 request failed (${response.status}).`);
        row = { recordId: item.recordId, humanLabel: item.humanLabel, annotationCompleteness: item.annotationCompleteness, choice: payload.choice, probabilities: payload.probabilities, confidence: payload.confidence, model: payload.model, elapsedMs: payload.elapsedMs, excerpt: payload.excerpt };
      } catch (error) {
        if (controller.signal.aborted) break;
        row = { recordId: item.recordId, humanLabel: item.humanLabel, annotationCompleteness: item.annotationCompleteness, error: error instanceof Error ? error.message : "MSD1 request failed." };
      }
      currentRows.push(row);
      setWorkingRows([...currentRows]);
    }
    abortRef.current = null;
    setProgress((current) => ({ ...current, active: false }));
    if (currentRows.length) {
      const run: TestRun = { id: crypto.randomUUID(), reviewer: selectedReviewer.name, startedAt, completedAt: new Date().toISOString(), settings: settingsSnapshot, annotationCompleteness: annotationCompletenessSnapshot, minimumConfidenceThreshold: 0, rows: currentRows };
      setRuns((current) => [...current, run]);
      setSelectedRunId(run.id);
    }
  };

  const cancelTest = () => abortRef.current?.abort();

  const loadFullMessage = async (recordId: string) => {
    fullMessageControllerRef.current?.abort();
    const controller = new AbortController();
    fullMessageControllerRef.current = controller;
    setFullMessageRecordId(recordId);
    setFullMessageText("");
    setFullMessageError("");
    setFullMessageLoading(true);
    try {
      const response = await fetch(`/api/context?recordId=${encodeURIComponent(recordId)}&targetOnly=1`, { cache: "no-store", signal: controller.signal });
      const payload = await response.json() as { text?: string; error?: string };
      if (!response.ok || typeof payload.text !== "string") throw new Error(payload.error || `Could not load the full message (${response.status}).`);
      if (fullMessageControllerRef.current === controller) setFullMessageText(payload.text);
    } catch (error) {
      if (!controller.signal.aborted && fullMessageControllerRef.current === controller) setFullMessageError(error instanceof Error ? error.message : "Could not load the full message.");
    } finally {
      if (fullMessageControllerRef.current === controller) {
        fullMessageControllerRef.current = null;
        setFullMessageLoading(false);
      }
    }
  };

  const closeFullMessage = useCallback(() => {
    fullMessageControllerRef.current?.abort();
    fullMessageControllerRef.current = null;
    setFullMessageRecordId(null);
    setFullMessageLoading(false);
    setFullMessageError("");
  }, []);

  useEffect(() => {
    if (!fullMessageRecordId) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeFullMessage();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [fullMessageRecordId, closeFullMessage]);

  const selectRun = (run: TestRun) => {
    setSelectedRunId(run.id);
    setReviewer(run.reviewer);
    setAnnotationCompleteness(run.annotationCompleteness);
    setSettings({ ...run.settings, criteria: { ...run.settings.criteria }, optionOrder: [...run.settings.optionOrder] });
    setMinimumConfidenceThreshold(run.minimumConfidenceThreshold);
    setProgress({ active: false, current: 0, total: 0, error: "" });
  };

  const downloadRun = () => {
    if (!selectedRun) return;
    const columns = ["record_id", "human_reviewer", "human_annotation_completeness", "human_contains_ctps", "msd1_raw_choice", "msd1_displayed_choice", "confidence", "minimum_confidence_threshold", "included_in_scoring", "p_yes", "p_no", "p_unclear", "status", "message_excerpt"];
    const includedForExport = filterMsd1RowsByMinimumConfidence(selectedRun.rows, minimumConfidenceThreshold) as TestRow[];
    const includedRecordIds = new Set(includedForExport.map((row) => row.recordId));
    const values = selectedRun.rows.map((row) => {
      const effective = row.choice ? effectiveMsd1Label(row, settings.confidenceThreshold) : "";
      const included = includedRecordIds.has(row.recordId);
      return [row.recordId, selectedRun.reviewer, row.annotationCompleteness ?? selectedRun.annotationCompleteness, row.humanLabel, row.choice ?? "", effective, row.confidence ?? "", minimumConfidenceThreshold, included, row.probabilities?.yes ?? "", row.probabilities?.no ?? "", row.probabilities?.unclear ?? "", row.error ?? "succeeded", row.excerpt ?? ""];
    });
    const blob = new Blob([`\uFEFF${[columns, ...values].map((line) => line.map(csvCell).join(",")).join("\r\n")}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `msd1-contains-ctps-${selectedRun.reviewer.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${selectedRun.startedAt.slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const options = orderOptions.find((item) => item.labels.join("|") === settings.optionOrder.join("|"))?.value ?? orderOptions[0].value;
  const disagreementCount = includedRows.filter((row) => {
    const predicted = effectiveMsd1Label(row, settings.confidenceThreshold);
    const normalized = predicted === "unclear" ? "uncertain" : predicted;
    return normalized !== row.humanLabel;
  }).length;
  const binaryCounts = binaryMsd1Counts(agreement.confusion);
  const binaryCompared = binaryCounts.truePositives + binaryCounts.falsePositives + binaryCounts.falseNegatives + binaryCounts.trueNegatives;

  return <>
    <button type="button" className="sample-trigger msd1-test-trigger" disabled={disabled || reviewers.length === 0} onClick={openTool} title={reviewers.length ? "Test Microsoft Decision 1 against saved human Contains CTPs labels" : "No saved human Contains CTPs labels are available yet"}>
      <span>Test MSD1</span>
    </button>
    {open && <>
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !progress.active) setOpen(false); }}>
      <section className="profile-dialog msd1-test-dialog" role="dialog" aria-modal="true" aria-labelledby="msd1-test-title">
        <button className="icon-btn modal-close" aria-label="Close MSD1 test" disabled={progress.active} onClick={() => setOpen(false)}><X size={17} /></button>
        <h2 id="msd1-test-title">Test MSD1 · Contains CTPs</h2>
        <p className="sample-description">Runs Microsoft Decision 1 against messages with the selected reviewer’s saved Contains CTPs label. Choose fully annotated human labels, partially annotated human labels, or both. LLM completion is not required. Human labels are used only for scoring and are never sent to MSD1. Tests do not change saved annotations.</p>
        <div className="msd1-test-settings">
          <label>Compare with human reviewer<select disabled={progress.active} value={reviewers.some((item) => item.name === reviewer) ? reviewer : selectedReviewer?.name ?? ""} onChange={(event) => { setReviewer(event.target.value); setSelectedRunId(""); setWorkingRows([]); setProgress({ active: false, current: 0, total: 0, error: "" }); }}>
            {reviewers.map((item) => <option key={item.name} value={item.name}>{item.name} · {filterMsd1ReviewerRecords(item.records, annotationCompleteness).length} messages</option>)}
          </select></label>
          <label>Test set size<input value={`${selectedRecords.length} ${annotationCompleteness === "all" ? "labeled messages (full and partial)" : `${annotationCompleteness} annotated messages`}`} readOnly /></label>
          <label className="msd1-wide-field">Human annotation completeness<select disabled={progress.active} value={annotationCompleteness} onChange={(event) => { setAnnotationCompleteness(event.target.value as AnnotationCompleteness); setSelectedRunId(""); setWorkingRows([]); setProgress({ active: false, current: 0, total: 0, error: "" }); }}><option value="fully">Fully annotated</option><option value="partially">Partially annotated</option><option value="all">Full and partial annotations</option></select></label>
          <label className="msd1-wide-field">Decision instructions<textarea disabled={progress.active} rows={3} value={settings.instructions} onChange={(event) => setSettings((current) => ({ ...current, instructions: event.target.value }))} /></label>
          <label>Yes criteria<textarea disabled={progress.active} rows={4} value={settings.criteria.yes} onChange={(event) => setSettings((current) => ({ ...current, criteria: { ...current.criteria, yes: event.target.value } }))} /></label>
          <label>No criteria<textarea disabled={progress.active} rows={4} value={settings.criteria.no} onChange={(event) => setSettings((current) => ({ ...current, criteria: { ...current.criteria, no: event.target.value } }))} /></label>
          <label>Unclear criteria<textarea disabled={progress.active} rows={3} value={settings.criteria.unclear} onChange={(event) => setSettings((current) => ({ ...current, criteria: { ...current.criteria, unclear: event.target.value } }))} /></label>
          <label>Input format<select disabled={progress.active} value={settings.stateFormat} onChange={(event) => setSettings((current) => ({ ...current, stateFormat: event.target.value as Msd1Settings["stateFormat"] }))}><option value="structured">Structured message and context</option><option value="text">Readable text</option></select></label>
          <label>Answer option order<select disabled={progress.active} value={options} onChange={(event) => setSettings((current) => ({ ...current, optionOrder: [...(orderOptions.find((item) => item.value === event.target.value)?.labels ?? orderOptions[0].labels)] }))}>{orderOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
          <label className="msd1-threshold-field">Convert low-confidence Yes/No to Unclear <span>{Math.round(settings.confidenceThreshold * 100)}%</span><input disabled={progress.active} type="range" min="0" max="0.95" step="0.05" value={settings.confidenceThreshold} onChange={(event) => {
            const value = Number(event.target.value);
            setSettings((current) => ({ ...current, confidenceThreshold: value }));
            if (selectedRunId) setRuns((current) => current.map((run) => run.id === selectedRunId ? { ...run, settings: { ...run.settings, confidenceThreshold: value } } : run));
          }} /><small>Scoring adjustment only; it does not make another model call.</small></label>
        </div>
        <p className="msd1-api-note">MSD1 uses typed decisions. Its API does not expose a temperature or reasoning-effort control. This test varies supported question wording, criteria, input format, and option order; both confidence sliders affect scoring only.</p>
        {progress.active && <div className="batch-progress"><div className="batch-progress-copy" aria-live="polite"><LoaderCircle size={12} className="spin" /> Testing message {progress.current} of {progress.total} · {workingRows.filter((row) => !row.error).length} succeeded · {workingRows.filter((row) => row.error).length} failed</div><div className="batch-progress-track"><span style={{ width: `${progress.total ? (workingRows.length / progress.total) * 100 : 0}%` }} /></div></div>}
        {progress.error && <p className="sample-error" role="alert">{progress.error}</p>}
        {runs.length > 0 && <div className="msd1-run-history" aria-label="Previous MSD1 test runs">{recentRuns.map((run) => {
          const runRows = filterMsd1RowsByMinimumConfidence(run.rows, run.minimumConfidenceThreshold) as TestRow[];
          const stats = scoreMsd1Agreement(runRows, run.settings.confidenceThreshold);
          const completenessLabel = run.annotationCompleteness === "all" ? "full + partial" : run.annotationCompleteness;
          return <button type="button" key={run.id} className={selectedRunId === run.id ? "selected" : ""} disabled={progress.active} onClick={() => selectRun(run)}>{run.reviewer} · {completenessLabel} · {stats.agreements}/{stats.compared} · {stats.percent == null ? "—" : `${stats.percent.toFixed(1)}%`} · {new Date(run.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</button>;
        })}</div>}
        {visibleRows.length > 0 && <section className="msd1-results">
          <div className="msd1-result-heading"><b>{progress.active ? "Current test" : `Results · ${selectedRun?.reviewer ?? ""}`}</b><span>{includedRows.length} included · {excludedConfidenceRows} below threshold · {visibleRows.length - succeededRows.length} failed</span></div>
          <label className="msd1-min-confidence-field">Minimum confidence required to be included <span>{Math.round(minimumConfidenceThreshold * 100)}%</span><input disabled={progress.active} type="range" min="0" max="1" step="0.05" value={minimumConfidenceThreshold} onChange={(event) => {
            const value = Number(event.target.value);
            setMinimumConfidenceThreshold(value);
            if (selectedRunId) setRuns((current) => current.map((run) => run.id === selectedRunId ? { ...run, minimumConfidenceThreshold: value } : run));
          }} /><small>Confidence is MSD1’s probability for its selected label. Lower-confidence results stay visible but do not count in scores.</small></label>
          <div className="msd1-metric-grid">
            <div><span>Exact agreement</span><b>{agreement.percent == null ? "—" : `${agreement.percent.toFixed(1)}%`}</b><small>{agreement.agreements}/{agreement.compared} labels</small></div>
            <div><span>Yes/No agreement</span><b>{agreement.decisivePercent == null ? "—" : `${agreement.decisivePercent.toFixed(1)}%`}</b><small>{agreement.decisiveAgreements}/{agreement.decisiveCompared} determinate human labels</small></div>
            <div><span>Disagreements</span><b>{disagreementCount}</b><small>among successful requests</small></div>
          </div>
          <div className="msd1-confusion-wrap"><table className="msd1-confusion"><caption>Human label × MSD1 label</caption><thead><tr><th>Human</th><th>Yes</th><th>No</th><th>Unclear</th></tr></thead><tbody>{(["yes", "no", "uncertain"] as const).map((human) => <tr key={human}><th>{labelText[human]}</th><td>{agreement.confusion[human].yes}</td><td>{agreement.confusion[human].no}</td><td>{agreement.confusion[human].uncertain}</td></tr>)}</tbody></table></div>
          <div className="msd1-binary-counts" aria-label="Binary confusion counts">
            <div className="msd1-binary-counts-heading"><b>Binary counts</b><span>Human Yes/No are the reference · Unclear excluded · n={binaryCompared}</span></div>
            <div className="msd1-binary-count-grid">
              <div><span>True positives</span><b>{binaryCounts.truePositives}</b><small>Human Yes · MSD1 Yes</small></div>
              <div><span>False positives</span><b>{binaryCounts.falsePositives}</b><small>Human No · MSD1 Yes</small></div>
              <div><span>False negatives</span><b>{binaryCounts.falseNegatives}</b><small>Human Yes · MSD1 No</small></div>
              <div><span>True negatives</span><b>{binaryCounts.trueNegatives}</b><small>Human No · MSD1 No</small></div>
            </div>
          </div>
          <div className="msd1-result-list">{visibleRows.map((row) => {
            const effective = row.choice ? effectiveMsd1Label(row, settings.confidenceThreshold) as ChoiceLabel : null;
            const normalized = effective === "unclear" ? "uncertain" : effective;
            const differs = Boolean(effective && normalized !== row.humanLabel);
            const excluded = !row.error && Boolean(row.choice) && !includedRecordIds.has(row.recordId);
            return <article key={row.recordId} className={`msd1-result-row ${row.error ? "failed" : excluded ? "excluded" : differs ? "differs" : "matches"}`}>
              <div className="msd1-result-labels"><code>{row.recordId}</code><span>Human <b>{labelText[row.humanLabel]}</b></span>{row.error ? <strong className="msd1-error-label">Failed</strong> : <span>MSD1 <b>{effective ? labelText[effective] : "—"}</b>{row.choice && effective !== row.choice && <small>raw: {labelText[row.choice]}</small>}</span>}{excluded && <strong className="msd1-excluded-label">Excluded from scores</strong>}{row.confidence != null && <small>{Math.round(row.confidence * 100)}% confidence</small>}</div>
              {row.error ? <p role="alert">{row.error}</p> : <button type="button" className="msd1-full-message-trigger" onClick={() => void loadFullMessage(row.recordId)}>{differs ? "Review full message" : "View full message"}{row.elapsedMs != null && <small>{(row.elapsedMs / 1000).toFixed(1)}s</small>}</button>}
            </article>;
          })}</div>
          {!progress.active && selectedRun && <button type="button" className="dialog-secondary msd1-export-button" onClick={downloadRun}><Download size={14} /> Export this run as CSV</button>}
        </section>}
        <div className="dialog-actions">{progress.active ? <button type="button" className="dialog-secondary" onClick={cancelTest}>Cancel test</button> : <button type="button" className="dialog-secondary" onClick={() => setOpen(false)}>Close</button>}{!progress.active && <button type="button" className="dialog-primary" disabled={!selectedRecords.length || !settings.instructions.trim() || Object.values(settings.criteria).some((item) => !item.trim())} onClick={() => void runTest()}>Run MSD1 test · {selectedRecords.length}</button>}</div>
      </section>
    </div>
    {fullMessageRecordId && typeof document !== "undefined" && createPortal(<div className="msd1-full-message-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeFullMessage(); }}>
      <section className="profile-dialog msd1-full-message-dialog" role="dialog" aria-modal="true" aria-labelledby="msd1-full-message-title" aria-busy={fullMessageLoading}>
        <button type="button" className="icon-btn modal-close" aria-label="Close full message" autoFocus onClick={closeFullMessage}><X size={17} /></button>
        <h2 id="msd1-full-message-title">Full requester message</h2>
        <code className="msd1-full-message-id">{fullMessageRecordId}</code>
        {fullMessageLoading ? <p className="msd1-full-message-status"><LoaderCircle size={14} className="spin" /> Loading full message…</p> : fullMessageError ? <div className="msd1-full-message-error" role="alert"><p>{fullMessageError}</p><button type="button" className="dialog-secondary" onClick={() => void loadFullMessage(fullMessageRecordId)}>Retry</button></div> : <div className="msd1-full-message-body">{fullMessageText || <span className="msd1-full-message-empty">The message is empty.</span>}</div>}
      </section>
    </div>, document.body)}
    </>}
  </>;
}
