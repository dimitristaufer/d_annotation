"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowRight, Check, CheckCheck, ChevronDown, CircleHelp, Copy, Download, FileText, Filter, Inbox, ListFilter, LoaderCircle, LogOut, MessageSquareText, Pencil, Plus, Search, Trash2, UserRound, X } from "lucide-react";
import type { RecordRow } from "./api/records/route";
import { ANNOTATION_PROMPT_DIMENSIONS, ANNOTATION_PROMPT_VERSION, DEFAULT_ANNOTATION_PROMPTS, DEFAULT_PERSON_REFERENCE_CRITERIA, PERSON_REFERENCE_RULE, type AnnotationPromptDimension, type SharedPromptDimension } from "@/lib/annotation-prompts";
import { mergeAnnotationSnapshot, mergeAnnotationSubset, mergeHumanAnnotationSnapshot, mergeHumanAnnotationSubset } from "@/lib/annotation-state.mjs";
import { mergeRecordRowsById, uniqueRecordRows } from "@/lib/record-rows.mjs";
import { matchReferentsByMention, multisetDifference } from "@/lib/annotation-differences.mjs";
import { pairwiseAnnotationAgreement } from "@/lib/pairwise-agreement.mjs";
import { combineReviewFilterIds, filterHumanAnnotationsToProfiles, filterRowsByReviewSnapshot, humanAnnotationStatusMode, humanReviewStatusMode, idsAnnotatedByHuman, idsWithAtLeastTwoAnnotators, isReviewStatusMode, recordIdsFromSignature, recordIdsSignature, reviewStatusFilterSignature, sampleRecordIds, searchNeedsAnnotationSnapshot } from "@/lib/review-status.mjs";
import { readJsonResponse } from "@/lib/annotation-response.mjs";
import { partitionCtpRecordIds } from "@/lib/ctp-label.mjs";
import type { CtpLabelLookup, CtpScreeningLabel } from "@/lib/ctp-screening";
import { sameStabilityOutput, stabilityCategoryValue } from "@/lib/stability-scoring.mjs";
import { Msd1TestingTool } from "./components/msd1-testing-tool";

type Label = "yes" | "no" | "uncertain";
type ContextTurn = { role: string; text: string; turnIndex: number };
type DripReferent = { mention?: string; type?: string; identifiability?: string };
type Annotation = { relevance?: Label; domains?: string[]; referents?: DripReferent[]; purposes?: string[]; note?: string; updatedAt?: string; decision?: Label; llmAnnotatedAt?: string };
type AnnotatorProfile = { id: string; name: string; createdAt: string; shared?: boolean; retired?: boolean };
type StoredAnnotation = Annotation & { id: string; recordId: string; profileId: string };
type SampleResult = { csv: string; recordIds: string[]; recordIdGroups?: Array<{ unitId: string; recordIds: string[] }>; total: number; sampled: number; unitsSampled?: number; unit: string; seed: string };
type SampleUnit = "messages" | "conversations" | "first_messages" | "paper_first_messages" | "embedding_sensitivity" | "embedding_primary" | "embedding_near_verbatim" | "english_ge_90" | "english_ge_80" | "english_ge_50";
type CtpLabel = "yes" | "no" | "unclear" | "";
type CtpScreeningCounts = { frameId: string; frameRecords: number; counts: { yes: number; no: number; unclear: number } };
type CtpScreeningPartition = { yesRecordIds: string[]; no: number; unclear: number; unlabeled: number; runId: string };
type BatchProgress = { active: boolean; sampling: boolean; completed: number; total: number; succeeded: number; failed: number; skipped: number; current: number; startedAt: number; cancelled: boolean; error: string; errors: string[] };
type BatchAnnotationScope = "paper_frame" | "all_humans" | "two_or_more_humans" | `annotator:${string}`;
type RedoComparison = { id: string; original: Annotation; proposed: Annotation | null; loading: boolean; error: string };
type ConversationList = { id: string; name: string; conversationIds: string[]; createdAt: string; updatedAt: string };
type PromptDownloadVersion = { id: string; savedAt: string; label: string; source: string; promptVersion?: string; prompts: Record<string, string>; personReferenceCriteria: string; personReferenceRule?: string };
type ConversationListIdMatch = { conversationId: string; requesterMessages: number; indexedConversations: number };
type ListHistoryItem = { recordId: string; previous: Annotation | null; annotation: Annotation };
type ListAnnotationRun = { id: string; listId: string; startedAt: string; completedAt?: string; reasoningEffort: string; prompts: Record<string, string>; expected: number; succeeded: number; failed: number; cancelled: boolean; items: ListHistoryItem[] };
type LlmHistoryVersion = { id: string; listId: string; runStartedAt: string; createdAt: string; annotation: Annotation };
type AnnotationSource = "llm" | "human";
type HistoryVersion = { key: string; label: string; source: AnnotationSource; annotations: Record<string, Annotation>; prompts?: Record<string, string>; startedAt?: string };
type StabilityCategory = Exclude<HistoryCategory, "Notes">;
type StabilityTrace = { condition: "end_to_end" | "human_inventory"; annotation?: Annotation; error?: string; diagnostics?: Record<string, unknown> };
type StabilityRepeat = { annotations: Record<string, Annotation>; errors: Record<string, string>; diagnosticAnnotations: Record<string, Annotation>; diagnosticErrors: Record<string, string>; traces: Record<string, StabilityTrace[]>; succeeded: number; failed: number };
type StabilityRecord = { recordId: string; conversationId: string; turnIndex: number; messageText: string; humanAnnotation?: Annotation | null };
type StabilityResult = { startedAt: string; completedAt: string; repetitions: number; recordIds: string[]; records: StabilityRecord[]; reasoningEffort: string; prompts: Record<AnnotationPromptDimension, string>; personReferenceCriteria: string; promptVersion: string; personReferenceRule: string; humanReviewer: string; model: string; humanSnapshot: Record<string, Annotation | null>; runs: StabilityRepeat[]; cancelled: boolean };
type HistoryMessage = { conversationId: string; turnIndex: number; messageText: string };
type HistoryComparisonItem = { recordId: string; conversationId: string; turnIndex: number; messageText: string; previous: Annotation | null; annotation: Annotation | null };
type StabilityProgress = { active: boolean; preparing: boolean; completed: number; total: number; repetition: number; failed: number; error: string; errors: string[] };
type CompareField = "Contains CTPs" | "Domains" | "Referents" | "Purposes";
const COMPARE_FIELDS: CompareField[] = ["Contains CTPs", "Domains", "Referents", "Purposes"];
type Payload = { items: RecordRow[]; total: number; totalKnown: boolean; complete: boolean; jobId: string; page: number; limit: number; corpus: number; positive: number; negative: number; shardCount: number; totalSourceShards: number; snapshot: string; reviewStatusIds?: string[] };
function formatDuration(milliseconds: number) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
function delayWithAbort(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) { resolve(); return; }
    let timer = 0;
    const finish = () => { window.clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    timer = window.setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}
async function screenCtpRecordIds(recordIds: string[], signal: AbortSignal): Promise<CtpScreeningPartition> {
  const uniqueIds = [...new Set(recordIds)];
  const labels: Record<string, CtpScreeningLabel> = {};
  let runId = "";
  for (let offset = 0; offset < uniqueIds.length; offset += 10_000) {
    const response = await fetch("/api/ctp-screening", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "labels", recordIds: uniqueIds.slice(offset, offset + 10_000) }),
      signal,
      cache: "no-store",
    });
    const result = await readJsonResponse<Partial<CtpLabelLookup> & { error?: string }>(response);
    if (!response.ok || result.frameId !== "english_ge_90" || typeof result.runId !== "string" || !result.labels || typeof result.labels !== "object") {
      throw new Error(result.error || "Could not verify the pinned MSD1 CTP screening labels.");
    }
    if (runId && runId !== result.runId) throw new Error("The MSD1 screening run changed while the messages were being checked. Please retry.");
    runId = result.runId;
    Object.assign(labels, result.labels);
  }
  const partition = partitionCtpRecordIds(uniqueIds, labels);
  return { ...partition, runId };
}
function showCtpSkippedPopup(counts: Pick<CtpScreeningPartition, "no" | "unclear" | "unlabeled">) {
  if (!counts.no && !counts.unclear && !counts.unlabeled) return;
  const lines = [`MSD1 screening skipped ${counts.no.toLocaleString()} "No" and ${counts.unclear.toLocaleString()} "Unclear" messages.`];
  if (counts.unlabeled) lines.push(`${counts.unlabeled.toLocaleString()} messages were outside the pinned ≥90% English frame and were also left unannotated.`);
  lines.push("Only messages labeled Yes were sent to GPT-6-Luna.");
  window.alert(lines.join("\n\n"));
}
function isFullyAnnotated(annotation?: Annotation) {
  const relevance = annotation?.relevance ?? annotation?.decision;
  if (!relevance) return false;
  if (relevance !== "yes") return true;
  const referents = annotation?.referents ?? [];
  return Array.isArray(annotation?.domains) && Array.isArray(annotation?.purposes) && Array.isArray(annotation?.referents) && referents.length > 0 && referents.every((referent) => Boolean(referent.type && referent.identifiability));
}
function ConversationListsSkeleton() {
  return <>{[0, 1, 2].map((item) => <article className="conversation-list-skeleton" aria-hidden="true" key={item}><span className="skeleton-bar skeleton-icon" /><div><span className="skeleton-bar skeleton-title" /><span className="skeleton-bar skeleton-subtitle" /></div><span className="skeleton-bar skeleton-action" /></article>)}</>;
}
function hasAnnotation(annotation?: Annotation) { return Boolean(annotation?.relevance ?? annotation?.decision); }
function isPartiallyAnnotated(annotation?: Annotation) { return hasAnnotation(annotation) && !isFullyAnnotated(annotation); }
function annotationFieldValues(annotation: Annotation, field: CompareField): string[] {
  if (field === "Contains CTPs") return [annotation.relevance ?? annotation.decision ?? "Not set"];
  if (field === "Domains") return annotation.domains?.length ? annotation.domains : ["Not set"];
  if (field === "Purposes") return annotation.purposes?.length ? annotation.purposes : ["Not set"];
  if (!annotation.referents?.length) return ["Not set"];
  return annotation.referents.map((referent) => [referent.mention || "Unnamed referent", referent.type, referent.identifiability].filter(Boolean).join(" · "));
}
function sameStringSet(left: string[], right: string[]) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}
function normalizeAnnotationText(value: string | undefined) {
  return (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}
function formatDifferenceLabels(values: string[]) {
  if (!values.length) return "None";
  const groups = new Map<string, { label: string; count: number }>();
  for (const value of values) {
    const key = normalizeAnnotationText(value);
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { label: value, count: 1 });
  }
  return [...groups.values()].map(({ label, count }) => count > 1 ? `${label} × ${count}` : label).join(", ");
}
function AnnotationDifferenceSummary({ category, llmOnly, humanOnly, humanName }: { category: string; llmOnly: string[]; humanOnly: string[]; humanName: string }) {
  if (!llmOnly.length && !humanOnly.length) return null;
  return <div className="annotation-difference-detail" role="note" aria-label={`${category} differences`}>
    <strong>{category}</strong>
    <span><b>LLM only:</b> {formatDifferenceLabels(llmOnly)}</span>
    <span><b>{humanName} only:</b> {formatDifferenceLabels(humanOnly)}</span>
  </div>;
}
function referentTypeValues(referents: DripReferent[]) {
  return referents.map((item) => normalizeAnnotationText(item.type)).sort();
}
function referentClassificationValues(referents: DripReferent[]) {
  return referents.map((item) => JSON.stringify([normalizeAnnotationText(item.type), normalizeAnnotationText(item.identifiability)])).sort();
}
function sameReferentTypes(left: DripReferent[], right: DripReferent[]) {
  return JSON.stringify(referentTypeValues(left)) === JSON.stringify(referentTypeValues(right));
}
function sameReferentClassifications(left: DripReferent[], right: DripReferent[]) {
  return JSON.stringify(referentClassificationValues(left)) === JSON.stringify(referentClassificationValues(right));
}
const HISTORY_CATEGORIES = ["Contains CTPs", "Domains", "Referents", "Identifiability", "Purposes", "Notes"] as const;
const HISTORY_COMPARISON_CATEGORIES = HISTORY_CATEGORIES.filter((category) => category !== "Notes");
type HistoryCategory = typeof HISTORY_CATEGORIES[number];
const STABILITY_CATEGORIES: StabilityCategory[] = ["Contains CTPs", "Domains", "Referents", "Identifiability", "Purposes"];
function historyCategoryValue(annotation: Annotation, category: HistoryCategory) {
  if (category === "Contains CTPs") return annotation.relevance ?? annotation.decision ?? null;
  if (category === "Domains") return [...(annotation.domains ?? [])].sort();
  if (category === "Purposes") return [...(annotation.purposes ?? [])].sort();
  if (category === "Notes") return annotation.note ?? null;
  if (category === "Referents") return referentTypeValues(annotation.referents ?? []);
  return referentClassificationValues(annotation.referents ?? []);
}
function messageAnnotationAgreement(llm: Annotation | undefined, human: Annotation | undefined) {
  if (!llm || !human) return null;
  const checks: boolean[] = [];
  const llmRelevance = llm.relevance ?? llm.decision;
  const humanRelevance = human.relevance ?? human.decision;
  if (!llmRelevance || !humanRelevance) return null;
  checks.push(llmRelevance === humanRelevance);
  if (llmRelevance === "yes" && humanRelevance === "yes") {
    if (Array.isArray(llm.domains) && Array.isArray(human.domains)) checks.push(JSON.stringify([...llm.domains].sort()) === JSON.stringify([...human.domains].sort()));
    if (Array.isArray(llm.purposes) && Array.isArray(human.purposes)) checks.push(JSON.stringify([...llm.purposes].sort()) === JSON.stringify([...human.purposes].sort()));
    if (Array.isArray(llm.referents) && Array.isArray(human.referents)) {
      // Names and descriptions are optional adjudication aids. Score the
      // unordered multisets of labels instead, preserving duplicate entries.
      checks.push(sameReferentTypes(llm.referents, human.referents));
      checks.push(sameReferentClassifications(llm.referents, human.referents));
    }
  }
  return { matches: checks.filter(Boolean).length, total: checks.length, percent: checks.filter(Boolean).length / checks.length * 100 };
}
function downstreamAnnotationAgreement(model: Annotation | undefined, human: Annotation | undefined) {
  if (!model || !human) return null;
  const modelRelevance = model.relevance ?? model.decision;
  const humanRelevance = human.relevance ?? human.decision;
  if (!modelRelevance || !humanRelevance || modelRelevance !== humanRelevance) return null;
  if (humanRelevance !== "yes") return { matches: 0, total: 0, percent: 0 };
  const checks: boolean[] = [];
  if (Array.isArray(model.domains) && Array.isArray(human.domains)) checks.push(sameStringSet(model.domains, human.domains));
  if (Array.isArray(model.purposes) && Array.isArray(human.purposes)) checks.push(sameStringSet(model.purposes, human.purposes));
  if (Array.isArray(model.referents) && Array.isArray(human.referents)) {
    checks.push(sameReferentClassifications(model.referents, human.referents));
  }
  return checks.length ? { matches: checks.filter(Boolean).length, total: checks.length, percent: checks.filter(Boolean).length / checks.length * 100 } : null;
}
function matchedReferentIdentifiabilityChanged(previous: Annotation, annotation: Annotation) {
  return !sameReferentClassifications(previous.referents ?? [], annotation.referents ?? []);
}
function changedHistoryCategories(item: { previous: Annotation | null; annotation: Annotation | null }): HistoryCategory[] {
  if (!item.previous || !item.annotation) return [];
  return comparableHistoryCategories(item).filter((category) => category === "Identifiability"
    ? matchedReferentIdentifiabilityChanged(item.previous!, item.annotation!)
    : category === "Referents"
      ? referentInventoryChanged(item.previous!, item.annotation!)
      : JSON.stringify(historyCategoryValue(item.previous!, category)) !== JSON.stringify(historyCategoryValue(item.annotation!, category)));
}
function changedAnnotationCategories(item: { previous: Annotation | null; annotation: Annotation | null }) {
  return changedHistoryCategories(item).filter((category) => category !== "Notes");
}
function formatHistoryValue(value: unknown) { return value == null ? "Not set" : typeof value === "string" ? value : JSON.stringify(value); }
function displayHistoryCategory(annotation: Annotation | null, category: HistoryCategory) {
  if (!annotation) return "No annotation";
  if (category === "Contains CTPs") return annotation.relevance ?? annotation.decision ?? "Not set";
  if (category === "Domains") return annotation.domains?.length ? annotation.domains.join(", ") : "Not set";
  if (category === "Purposes") return annotation.purposes?.length ? annotation.purposes.join(", ") : "Not set";
  if (category === "Notes") return annotation.note?.trim() || "Not set";
  if (!annotation.referents?.length) return "Not set";
  return annotation.referents.map((item) => [item.mention || "Unnamed referent", item.type, category === "Identifiability" ? item.identifiability : undefined].filter(Boolean).join(" · ")).join("; ");
}
function hasHistoryCategory(annotation: Annotation | null, category: HistoryCategory) {
  if (!annotation) return false;
  if (category === "Contains CTPs") return Boolean(annotation.relevance ?? annotation.decision);
  if (category === "Domains") return Array.isArray(annotation.domains);
  if (category === "Purposes") return Array.isArray(annotation.purposes);
  if (category === "Notes") return typeof annotation.note === "string";
  if (!Array.isArray(annotation.referents)) return false;
  const relevance = annotation.relevance ?? annotation.decision;
  if ((category === "Referents" || category === "Identifiability") && relevance === "yes" && annotation.referents.length === 0) return false;
  if (category === "Referents") return annotation.referents.every((item) => Boolean(item.type));
  return annotation.referents.every((item) => Boolean(item.type && item.identifiability));
}
function comparableHistoryCategories(item: { previous: Annotation | null; annotation: Annotation | null }): HistoryCategory[] {
  const previousRelevance = item.previous?.relevance ?? item.previous?.decision;
  const annotationRelevance = item.annotation?.relevance ?? item.annotation?.decision;
  const downstreamNotApplicable = Boolean(previousRelevance && annotationRelevance && (previousRelevance !== "yes" || annotationRelevance !== "yes"));
  return HISTORY_CATEGORIES.filter((category) => !(downstreamNotApplicable && category !== "Contains CTPs" && category !== "Notes") && hasHistoryCategory(item.previous, category) && hasHistoryCategory(item.annotation, category));
}
function referentInventoryChanged(previous: Annotation, annotation: Annotation) {
  const left = previous.referents ?? [];
  const right = annotation.referents ?? [];
  return !sameReferentTypes(left, right);
}
function stabilityAgreement(result: StabilityResult, category: StabilityCategory, throughRepeat: number) {
  let compared = 0;
  let matched = 0;
  for (const recordId of result.recordIds) {
    const values = result.runs.slice(0, throughRepeat).map((run) => run.annotations[recordId]).filter((item): item is Annotation => Boolean(item)).map((annotation) => JSON.stringify(stabilityCategoryValue(annotation, category)));
    for (let left = 0; left < values.length; left += 1) for (let right = left + 1; right < values.length; right += 1) {
      compared += 1;
      if (values[left] === values[right]) matched += 1;
    }
  }
  return compared ? matched / compared * 100 : null;
}
function stabilitySummary(result: StabilityResult) {
  let compared = 0;
  let matched = 0;
  let stableEntries = 0;
  let comparableEntries = 0;
  for (const recordId of result.recordIds) {
    const annotations = result.runs.map((run) => run.annotations[recordId]).filter((item): item is Annotation => Boolean(item));
    if (annotations.length < 2) continue;
    comparableEntries += 1;
    const isStable = annotations.every((item) => sameStabilityOutput(item, annotations[0], STABILITY_CATEGORIES));
    if (isStable) stableEntries += 1;
    for (let left = 0; left < annotations.length; left += 1) for (let right = left + 1; right < annotations.length; right += 1) {
      compared += 1;
      if (sameStabilityOutput(annotations[left], annotations[right], STABILITY_CATEGORIES)) matched += 1;
    }
  }
  return { agreement: compared ? matched / compared * 100 : null, stableEntries, comparableEntries };
}
function stabilityDiagnosticSummary(result: StabilityResult) {
  let matches = 0;
  let total = 0;
  let comparableMessages = 0;
  let excludedMessages = 0;
  for (const record of result.records) {
    let recordHasScore = false;
    if (!record.humanAnnotation) { excludedMessages += 1; continue; }
    if (result.runs.some((run) => Boolean(run.diagnosticErrors[record.recordId]?.includes("incomplete") || run.diagnosticErrors[record.recordId]?.includes("No frozen human")))) excludedMessages += 1;
    for (const run of result.runs) {
      const annotation = run.diagnosticAnnotations[record.recordId];
      if (!annotation) continue;
      const score = downstreamAnnotationAgreement(annotation, record.humanAnnotation);
      if (score && score.total > 0) { matches += score.matches; total += score.total; recordHasScore = true; }
    }
    if (recordHasScore) comparableMessages += 1;
  }
  return { percent: total ? matches / total * 100 : null, matches, total, comparableMessages, excludedMessages };
}
const STABILITY_COLORS: Record<StabilityCategory, string> = { "Contains CTPs": "#c74f74", Domains: "#4b81b7", Referents: "#7c65b2", Identifiability: "#438b77", Purposes: "#d18a37" };
function StabilityChart({ result, visible, hovered, onToggle, onHover }: { result: StabilityResult; visible: StabilityCategory[]; hovered: number | null; onToggle: (category: StabilityCategory) => void; onHover: (repetition: number | null) => void }) {
  const width = 720;
  const height = 300;
  const left = 54;
  const right = 16;
  const top = 18;
  const bottom = 48;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const maxRepeat = Math.max(2, result.runs.length);
  const xFor = (repetition: number) => left + ((repetition - 2) / Math.max(1, maxRepeat - 2)) * plotWidth;
  const yFor = (agreement: number) => top + (1 - agreement / 100) * plotHeight;
  const repetitions = Array.from({ length: Math.max(0, result.runs.length - 1) }, (_, index) => index + 2);
  const series = useMemo(() => Object.fromEntries(STABILITY_CATEGORIES.map((category) => [category, repetitions.map((repeat) => ({ repeat, value: stabilityAgreement(result, category, repeat) }))])) as Record<StabilityCategory, Array<{ repeat: number; value: number | null }>>, [result]);
  const selectedRepeat = hovered && hovered <= result.runs.length ? hovered : result.runs.length;
  return <div className="stability-chart-wrap">
    <div className="stability-chart-title"><b>Pairwise exact agreement by repeat</b><span>Agreement across all earlier runs, by category; exact names/descriptions excluded</span></div>
    <svg className="stability-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Interactive line chart of annotation agreement across repeated runs" onPointerMove={(event) => { const bounds = event.currentTarget.getBoundingClientRect(); const position = ((event.clientX - bounds.left) / bounds.width) * width; const ratio = Math.min(1, Math.max(0, (position - left) / plotWidth)); onHover(Math.round(2 + ratio * Math.max(0, maxRepeat - 2))); }} onPointerLeave={() => onHover(null)}>
      {[0, 25, 50, 75, 100].map((value) => <g key={value}><line x1={left} x2={width - right} y1={yFor(value)} y2={yFor(value)} className="stability-grid-line" /><text x={left - 9} y={yFor(value) + 3} textAnchor="end" className="stability-axis-label">{value}%</text></g>)}
      {repetitions.map((repeat) => <g key={repeat}><line x1={xFor(repeat)} x2={xFor(repeat)} y1={top} y2={height - bottom} className={`stability-hover-line ${selectedRepeat === repeat ? "active" : ""}`} /><text x={xFor(repeat)} y={height - bottom + 20} textAnchor="middle" className="stability-axis-label">{repeat}</text></g>)}
      <text x={left + plotWidth / 2} y={height - 8} textAnchor="middle" className="stability-axis-label">Completed repetition</text>
      {STABILITY_CATEGORIES.filter((category) => visible.includes(category)).map((category) => {
        const points = series[category].filter((point): point is { repeat: number; value: number } => point.value != null);
        const path = points.map((point, index) => `${index ? "L" : "M"}${xFor(point.repeat)},${yFor(point.value)}`).join(" ");
        return <g key={category}><path d={path} fill="none" stroke={STABILITY_COLORS[category]} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />{points.map((point) => <circle key={point.repeat} cx={xFor(point.repeat)} cy={yFor(point.value)} r={selectedRepeat === point.repeat ? 5 : 3.5} fill={STABILITY_COLORS[category]} stroke="#fff" strokeWidth="2" />)}</g>;
      })}
    </svg>
    <div className="stability-chart-legend">{STABILITY_CATEGORIES.map((category) => <button type="button" key={category} className={visible.includes(category) ? "active" : ""} onClick={() => onToggle(category)}><i style={{ background: STABILITY_COLORS[category] }} />{category}</button>)}</div>
    <div className="stability-chart-readout" aria-live="polite"><b>{selectedRepeat >= 2 ? `Through repeat ${selectedRepeat}` : "Agreement"}</b>{STABILITY_CATEGORIES.filter((category) => visible.includes(category)).map((category) => { const value = series[category].find((point) => point.repeat === selectedRepeat)?.value ?? null; return <span key={category}><i style={{ background: STABILITY_COLORS[category] }} />{category}: {value == null ? "not enough successful runs" : `${value.toFixed(1)}%`}</span>; })}</div>
  </div>;
}
const DRIP_DOMAINS = ["Personal life", "Professional life and education", "Health and caregiving", "Legal and financial", "Public life and culture"];
const DRIP_REFERENTS = ["Fictional or hypothetical people", "Public figures", "Named others", "Unnamed others", "Human groups"];
const DRIP_IDENTIFIABILITY = ["Directly identifiable", "Indirectly identifiable", "No identifying cues"];
const DRIP_PURPOSES = ["Help the requester act", "Inquire about or analyse the CTP", "Transform CTP-related material", "Portray or simulate the CTP"];
const ANNOTATION_FILTER_GROUPS = [
  { key: "domains", label: "DOMAINS", values: DRIP_DOMAINS },
  { key: "referents", label: "REFERENT TYPES", values: DRIP_REFERENTS },
  { key: "identifiability", label: "IDENTIFIABILITY", values: DRIP_IDENTIFIABILITY },
  { key: "purposes", label: "PURPOSES", values: DRIP_PURPOSES },
] as const;
const DRIP_DEFINITIONS = [
  { title: "Domains", items: [["Personal life", "Requests concerning personal or family relationships and everyday interactions, including those with friends, neighbours, acquaintances, or romantic partners."], ["Professional life and education", "Requests concerning work or education, including employment, workplace or educational relationships, responsibilities, and assessment."], ["Health and caregiving", "Requests concerning health, medicine, wellness, physical or mental disability, medical treatment, or caregiving needs and work. Ordinary family relationships without a health or care focus belong under Personal life."], ["Legal and financial", "Requests concerning legal obligations, disputes, contracts, or finances."], ["Public life and culture", "Requests concerning politics, public affairs, journalism, sports, entertainment, culture, or related public topics."]] },
  { title: "Referent types", items: [["Fictional or hypothetical people", "Fictional characters (for example, Harry Potter) and people invented for an imagined or hypothetical scenario. A pseudonym for a real person remains a real-world referent and should be classified by that person's referent type."], ["Public figures", "Particular real-world individuals whose public prominence is apparent from context or broad public recognition of their name (for example, a senator, Bill Gates, Beyoncé, or Stephen King)."], ["Named others", "Specific real-world individuals, whether named or unnamed, known or unknown to the requester, who are not public figures (for example, a co-worker, a friend called John, or a sister's classmate)."], ["Unnamed others", "Classes of people rather than particular individuals, described without representing them as a collective group (for example, an employee or a New Yorker in a general statement)."], ["Human groups", "Collections of people represented collectively, rather than as separately individuated members or abstract organisations (for example, Germans, coastal communities, climate refugees, viewers, or professional footballers)."]] },
  { title: "Identifiability", items: [["Directly identifiable", "One or more direct personal identifiers are supplied, such as a full or contextually identifying name, username or social media handle, email address, IP address, or employee ID."], ["Indirectly identifiable", "Quasi-identifiers or contextual cues, alone or combined, could plausibly be used to re-identify a person."], ["No identifying cues", "A person is referred to, but no direct identifier or contextual cue that could plausibly help re-identify them is supplied. A group label alone does not identify its members."]] },
  { title: "Purpose", items: [["Help the requester act", "The model is asked to help the requester with a task, including recommending an action, planning, writing, summarising, or other requested work. The domain and person involved are coded separately."], ["Inquire about or analyse the CTP", "The model is asked to retrieve, interpret, infer, compare, or evaluate information about a person as a distinct, substantive requested deliverable. Do not add Analyse for work that only uses analysis as an intermediate step or includes a minor auxiliary field."], ["Transform CTP-related material", "The model is asked to transform supplied material involving a person, for example by translating, summarising, extracting, or reformatting it. Code this when changing supplied material is the primary requested task, rather than simply because the answer concerns a person. For example, extracting episode numbers from a source about people is Transform."], ["Portray or simulate the CTP", "The model is asked to portray or simulate a person by generating a response, viewpoint, product, or persona associated with them."]] },
];
const STORAGE = "wildchat-annotation-v1";
const ACTIVE_PROFILE_KEY = "wildchat-active-annotator-v1";
const VIEW_STATE_KEY = "wildchat-view-state-v1";
const DEFAULT_PROFILE_ID = "default";
const NO_EXCLUSIONS: string[] = [];
const POSSIBLE_HARM_FILTER = "Possible harm";
function normalizeProfileName(name: string) { return name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en"); }

function hasPossibleHarm(annotation?: Annotation) {
  return annotation?.referents?.some((referent) => referent.type === "Named others" && (referent.identifiability === "Directly identifiable" || referent.identifiability === "Indirectly identifiable")) ?? false;
}

function useAnnotations() {
  const [annotations, setAnnotations] = useState<Record<string, Annotation>>({});
  const [profiles, setProfiles] = useState<AnnotatorProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState(DEFAULT_PROFILE_ID);
  const [hydrated, setHydrated] = useState(false);
  const [saved, setSaved] = useState(true);
  const [profileSyncError, setProfileSyncError] = useState("");
  const [profilesSynced, setProfilesSynced] = useState(false);
  const database = useRef<IDBDatabase | null>(null);
  const annotationsRef = useRef<Record<string, Annotation>>({});
  const activeProfileRef = useRef(DEFAULT_PROFILE_ID);
  const profilesRef = useRef(profiles);
  profilesRef.current = profiles;
  const rosterSyncInFlight = useRef(false);
  const pendingWrites = useRef(0);

  const loadProfileAnnotations = useCallback((profileId: string) => {
    const db = database.current;
    if (!db) return;
    setHydrated(false);
    const request = db.transaction("annotations", "readonly").objectStore("annotations").index("profileId").getAll(profileId);
    request.onsuccess = () => {
      if (activeProfileRef.current !== profileId) return;
      const restored: Record<string, Annotation> = {};
      for (const item of request.result as StoredAnnotation[]) restored[item.recordId] = { ...item, relevance: item.relevance ?? item.decision };
      annotationsRef.current = restored;
      setAnnotations(restored);
      setHydrated(true);
    };
    request.onerror = () => { if (activeProfileRef.current === profileId) setHydrated(true); };
  }, []);

  const syncSharedProfiles = useCallback(async () => {
    const db = database.current;
    if (!db || rosterSyncInFlight.current) return;
    rosterSyncInFlight.current = true;
    try {
      const snapshot = await new Promise<{ profiles: AnnotatorProfile[]; annotations: StoredAnnotation[] }>((resolve, reject) => {
        const transaction = db.transaction(["profiles", "annotations"], "readonly");
        const profileRequest = transaction.objectStore("profiles").getAll();
        const annotationRequest = transaction.objectStore("annotations").getAll();
        transaction.oncomplete = () => resolve({ profiles: profileRequest.result as AnnotatorProfile[], annotations: annotationRequest.result as StoredAnnotation[] });
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      const localById = new Map(snapshot.profiles.map((profile) => [profile.id, profile]));
      for (const profile of profilesRef.current) if (!localById.has(profile.id)) localById.set(profile.id, profile);
      const local = [...localById.values()];
      const hasDefaultHumanAnnotations = snapshot.annotations.some((annotation) => annotation.profileId === DEFAULT_PROFILE_ID && !annotation.llmAnnotatedAt);
      const legacyProfiles = local.filter((profile) => !profile.shared && !profile.retired && (profile.id !== DEFAULT_PROFILE_ID || profile.name !== "Annotator 1" || hasDefaultHumanAnnotations));
      if (legacyProfiles.length) {
        const response = await fetch("/api/annotators", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ names: legacyProfiles.map((profile) => profile.name) }) });
        if (!response.ok) throw new Error("Could not sync local annotator profiles.");
      }
      const response = await fetch("/api/annotators", { cache: "no-store" });
      const result = await response.json() as { profiles?: unknown; error?: string };
      if (!response.ok || !Array.isArray(result.profiles) || !result.profiles.every((name) => typeof name === "string")) throw new Error(result.error || "Could not load shared annotator profiles.");
      const sharedNames = result.profiles as string[];
      const sharedByKey = new Map(sharedNames.map((name) => [normalizeProfileName(name), name]));
      const visible: AnnotatorProfile[] = [];
      const stored = new Map<string, AnnotatorProfile>();
      const represented = new Set<string>();
      for (const profile of local) {
        const key = normalizeProfileName(profile.name);
        const sharedName = sharedByKey.get(key);
        if (profile.id === DEFAULT_PROFILE_ID && profile.name === "Annotator 1" && !hasDefaultHumanAnnotations && !sharedName) {
          stored.set(profile.id, profile);
          continue;
        }
        if (sharedName) {
          const updated = { ...profile, name: sharedName, shared: true, retired: false };
          visible.push(updated); stored.set(updated.id, updated); represented.add(key);
        } else if (profile.shared) {
          const retired = { ...profile, retired: true };
          stored.set(retired.id, retired);
        } else if (!profile.retired) {
          visible.push(profile); stored.set(profile.id, profile);
        } else stored.set(profile.id, profile);
      }
      for (const name of sharedNames) {
        const key = normalizeProfileName(name);
        if (represented.has(key)) continue;
        const profile = { id: `shared:${encodeURIComponent(key)}`, name, createdAt: new Date().toISOString(), shared: true } satisfies AnnotatorProfile;
        visible.push(profile); stored.set(profile.id, profile); represented.add(key);
      }
      const transaction = db.transaction("profiles", "readwrite");
      for (const profile of stored.values()) transaction.objectStore("profiles").put(profile);
      await new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error); });
      setProfiles(visible);
      const selectedExists = visible.some((profile) => profile.id === activeProfileRef.current);
      if (!selectedExists && activeProfileRef.current !== DEFAULT_PROFILE_ID) {
        const fallback = visible.find((profile) => profile.id === DEFAULT_PROFILE_ID) ?? visible[0];
        if (fallback) {
          activeProfileRef.current = fallback.id;
          setActiveProfileId(fallback.id);
          try { localStorage.setItem(ACTIVE_PROFILE_KEY, fallback.id); } catch { /* selection remains active for this session */ }
          loadProfileAnnotations(fallback.id);
        }
      }
      setProfileSyncError("");
      setProfilesSynced(true);
    } catch (error) {
      setProfileSyncError(error instanceof Error ? error.message : "Could not sync annotator profiles.");
    } finally {
      rosterSyncInFlight.current = false;
    }
  }, [loadProfileAnnotations]);

  useEffect(() => {
    let cancelled = false;
    let rosterTimer = 0;
    const request = indexedDB.open(STORAGE, 2);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      const transaction = request.transaction!;
      const annotationsStore = db.objectStoreNames.contains("annotations") ? transaction.objectStore("annotations") : db.createObjectStore("annotations", { keyPath: "id" });
      if (!annotationsStore.indexNames.contains("profileId")) annotationsStore.createIndex("profileId", "profileId");
      if (event.oldVersion < 2) {
        const cursorRequest = annotationsStore.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const old = cursor.value as Annotation & { id: string; profileId?: string; recordId?: string };
          if (!old.profileId) {
            const recordId = old.id;
            const { id: _oldId, ...annotation } = old;
            cursor.delete();
            annotationsStore.put({ ...annotation, id: `${DEFAULT_PROFILE_ID}:${recordId}`, recordId, profileId: DEFAULT_PROFILE_ID });
          }
          cursor.continue();
        };
      }
      const profilesStore = db.objectStoreNames.contains("profiles") ? transaction.objectStore("profiles") : db.createObjectStore("profiles", { keyPath: "id" });
      profilesStore.put({ id: DEFAULT_PROFILE_ID, name: "Annotator 1", createdAt: new Date().toISOString() } satisfies AnnotatorProfile);
    };
    request.onsuccess = () => {
      if (cancelled) { request.result.close(); return; }
      database.current = request.result;
      const transaction = request.result.transaction("profiles", "readonly");
      const readProfiles = transaction.objectStore("profiles").getAll();
      readProfiles.onsuccess = () => {
        if (cancelled) return;
        const available = readProfiles.result as AnnotatorProfile[];
        const selected = available.some((profile) => profile.id === localStorage.getItem(ACTIVE_PROFILE_KEY)) ? localStorage.getItem(ACTIVE_PROFILE_KEY)! : available[0]?.id ?? DEFAULT_PROFILE_ID;
        setProfiles(available.filter((profile) => !(profile.id === DEFAULT_PROFILE_ID && profile.name === "Annotator 1")));
        activeProfileRef.current = selected;
        setActiveProfileId(selected);
        loadProfileAnnotations(selected);
        void syncSharedProfiles();
        rosterTimer = window.setInterval(() => void syncSharedProfiles(), 15_000);
      };
      readProfiles.onerror = () => { if (!cancelled) setHydrated(true); };
    };
    request.onerror = () => { if (!cancelled) setHydrated(true); };
    return () => { cancelled = true; window.clearInterval(rosterTimer); if (database.current === request.result) database.current = null; request.result?.close(); };
  }, [loadProfileAnnotations, syncSharedProfiles]);

  const switchProfile = useCallback((profileId: string) => {
    activeProfileRef.current = profileId;
    setActiveProfileId(profileId);
    annotationsRef.current = {};
    setAnnotations({});
    try { localStorage.setItem(ACTIVE_PROFILE_KEY, profileId); } catch { /* profile selection remains active for this session */ }
    loadProfileAnnotations(profileId);
  }, [loadProfileAnnotations]);

  const createProfile = useCallback(async (name: string) => {
    if (profiles.some((profile) => normalizeProfileName(profile.name) === normalizeProfileName(name))) throw new Error("An annotator with that name already exists.");
    const db = database.current;
    if (!db) return false;
    const response = await fetch("/api/annotators", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
    const result = await response.json() as { profile?: unknown; created?: boolean; error?: string };
    if (!response.ok || typeof result.profile !== "string" || !result.created) throw new Error(result.error || "An annotator with that name already exists.");
    const profile = { id: crypto.randomUUID(), name: result.profile, createdAt: new Date().toISOString(), shared: true } satisfies AnnotatorProfile;
    const transaction = db.transaction("profiles", "readwrite");
    transaction.objectStore("profiles").put(profile);
    await new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); });
    setProfiles((current) => [...current.filter((item) => normalizeProfileName(item.name) !== normalizeProfileName(profile.name)), profile]);
    switchProfile(profile.id);
    return true;
  }, [profiles, switchProfile]);

  const renameProfile = useCallback(async (name: string) => {
    const current = profiles.find((profile) => profile.id === activeProfileRef.current);
    const db = database.current;
    if (!current || !db) return false;
    const updated = { ...current, name };
    const transaction = db.transaction("profiles", "readwrite");
    transaction.objectStore("profiles").put(updated);
    await new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); });
    setProfiles((items) => items.map((profile) => profile.id === updated.id ? { ...updated, shared: true } : profile));
    return true;
  }, [profiles]);

  const deleteProfile = useCallback(async () => {
    const profileId = activeProfileRef.current;
    const remaining = profiles.filter((profile) => profile.id !== profileId);
    const db = database.current;
    if (!db || !remaining.length) return false;
    const response = await fetch("/api/annotators", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: profiles.find((profile) => profile.id === profileId)?.name }) });
    if (!response.ok) throw new Error("Could not remove this shared annotator profile.");
    const transaction = db.transaction(["profiles", "annotations"], "readwrite");
    transaction.objectStore("profiles").delete(profileId);
    const store = transaction.objectStore("annotations");
    const cursorRequest = store.index("profileId").openKeyCursor(IDBKeyRange.only(profileId));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      store.delete(cursor.primaryKey);
      cursor.continue();
    };
    await new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); });
    setProfiles(remaining);
    switchProfile(remaining[0].id);
    return true;
  }, [profiles, switchProfile]);

  const readForExport = useCallback(async (profileId: string | "all") => {
    const db = database.current;
    if (!db) return [];
    const rows = await new Promise<StoredAnnotation[]>((resolve, reject) => {
      const request = db.transaction("annotations", "readonly").objectStore("annotations").getAll();
      request.onsuccess = () => resolve(request.result as StoredAnnotation[]);
      request.onerror = () => reject(request.error);
    });
    const names = new Map(profiles.map((profile) => [profile.id, profile.name]));
    return rows.filter((row) => profileId === "all" || row.profileId === profileId).map((row) => {
      const relevance = row.relevance ?? row.decision;
      return {
        id: row.recordId,
        annotator: names.get(row.profileId) ?? row.profileId,
        taxonomy: "DRIP",
        relevance,
        domains: relevance === "yes" ? row.domains ?? [] : [],
        referents: relevance === "yes" ? row.referents ?? [] : [],
        purposes: relevance === "yes" ? row.purposes ?? [] : [],
        note: row.note ?? "",
        updatedAt: row.updatedAt,
      };
    });
  }, [profiles]);

  const readForBackup = useCallback(async () => {
    const db = database.current;
    if (!db) return null;
    const transaction = db.transaction(["profiles", "annotations"], "readonly");
    const profilesRequest = transaction.objectStore("profiles").getAll();
    const annotationsRequest = transaction.objectStore("annotations").getAll();
    return new Promise<{ profiles: AnnotatorProfile[]; annotations: StoredAnnotation[] }>((resolve, reject) => {
      transaction.oncomplete = () => resolve({ profiles: profilesRequest.result as AnnotatorProfile[], annotations: annotationsRequest.result as StoredAnnotation[] });
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }, []);

  const update = useCallback((id: string, patch: Partial<Annotation>) => {
    const annotation = { ...annotationsRef.current[id], ...patch, updatedAt: new Date().toISOString() };
    const next = { ...annotationsRef.current, [id]: annotation };
    annotationsRef.current = next;
    setAnnotations(next);
    if (!database.current) return;
    setSaved(false); pendingWrites.current += 1;
    const transaction = database.current.transaction("annotations", "readwrite");
    transaction.objectStore("annotations").put({ id: `${activeProfileRef.current}:${id}`, recordId: id, profileId: activeProfileRef.current, ...annotation });
    transaction.oncomplete = () => { pendingWrites.current -= 1; if (pendingWrites.current === 0) setSaved(true); };
    transaction.onerror = () => { pendingWrites.current = Math.max(0, pendingWrites.current - 1); };
  }, []);
  const replace = useCallback((id: string, annotation: Annotation) => {
    const replacement = { ...annotation, updatedAt: new Date().toISOString() };
    const next = { ...annotationsRef.current, [id]: replacement };
    annotationsRef.current = next;
    setAnnotations(next);
    if (!database.current) return;
    setSaved(false); pendingWrites.current += 1;
    const transaction = database.current.transaction("annotations", "readwrite");
    transaction.objectStore("annotations").put({ id: `${activeProfileRef.current}:${id}`, recordId: id, profileId: activeProfileRef.current, ...replacement });
    transaction.oncomplete = () => { pendingWrites.current -= 1; if (pendingWrites.current === 0) setSaved(true); };
    transaction.onerror = () => { pendingWrites.current = Math.max(0, pendingWrites.current - 1); };
  }, []);
  const remove = useCallback((id: string) => {
    const next = { ...annotationsRef.current };
    delete next[id];
    annotationsRef.current = next;
    setAnnotations(next);
    if (!database.current) return;
    setSaved(false); pendingWrites.current += 1;
    const transaction = database.current.transaction("annotations", "readwrite");
    transaction.objectStore("annotations").delete(`${activeProfileRef.current}:${id}`);
    transaction.oncomplete = () => { pendingWrites.current -= 1; if (pendingWrites.current === 0) setSaved(true); };
    transaction.onerror = () => { pendingWrites.current = Math.max(0, pendingWrites.current - 1); };
  }, []);
  const removeMany = useCallback((ids: string[]) => {
    if (!ids.length) return;
    const next = { ...annotationsRef.current };
    for (const id of ids) delete next[id];
    annotationsRef.current = next;
    setAnnotations(next);
    if (!database.current) return;
    setSaved(false); pendingWrites.current += 1;
    const transaction = database.current.transaction("annotations", "readwrite");
    const store = transaction.objectStore("annotations");
    for (const id of ids) store.delete(`${activeProfileRef.current}:${id}`);
    transaction.oncomplete = () => { pendingWrites.current -= 1; if (pendingWrites.current === 0) setSaved(true); };
    transaction.onerror = () => { pendingWrites.current = Math.max(0, pendingWrites.current - 1); };
  }, []);
  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ?? (activeProfileId === DEFAULT_PROFILE_ID
    ? { id: DEFAULT_PROFILE_ID, name: "Choose annotator", createdAt: "" }
    : profiles[0] ?? { id: DEFAULT_PROFILE_ID, name: "Choose annotator", createdAt: "" });
  return { annotations, update, replace, remove, removeMany, hydrated, saved, profiles, activeProfile, activeProfileId, profilesSynced, profileSyncError, switchProfile, createProfile, renameProfile, deleteProfile, readForExport, readForBackup };
}

function useSharedAnnotationStore(recordIds: string[], annotatorName: string) {
  const [llmAnnotations, setLlmAnnotations] = useState<Record<string, Annotation>>({});
  const [humanAnnotations, setHumanAnnotations] = useState<Record<string, Record<string, Annotation>>>({});
  const [allHumanAnnotations, setAllHumanAnnotations] = useState<Record<string, Record<string, Annotation>>>({});
  const [syncError, setSyncError] = useState("");
  const [indexLoadedFor, setIndexLoadedFor] = useState("");
  const indexRequestVersionRef = useRef(0);
  const requestVersionRef = useRef(0);
  const recordIdsKey = [...new Set(recordIds)].join(",");
  const refresh = useCallback(async (ids = recordIdsKey) => {
    const requestVersion = ++requestVersionRef.current;
    if (!ids) return;
    try {
      const response = await fetch(`/api/annotations?recordIds=${encodeURIComponent(ids)}&includeHumans=true`, { cache: "no-store" });
      if (!response.ok) return;
      const result = await response.json() as { llm?: Record<string, Annotation>; humans?: Record<string, Record<string, Annotation>> };
      if (requestVersion !== requestVersionRef.current) return;
      const requestedIds = ids.split(",");
      setLlmAnnotations((current) => mergeAnnotationSubset(current, result.llm ?? {}, requestedIds));
      setHumanAnnotations((current) => mergeHumanAnnotationSubset(current, result.humans ?? {}, requestedIds));
      setAllHumanAnnotations((current) => mergeHumanAnnotationSubset(current, result.humans ?? {}, requestedIds));
    } catch { /* local human annotations remain available if shared sync is temporarily offline */ }
  }, [recordIdsKey]);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 20_000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    ++indexRequestVersionRef.current;
    let cancelled = false;
    let requestInFlight = false;
    let activeController: AbortController | null = null;
    setIndexLoadedFor("");
    const loadIndex = async () => {
      if (cancelled || requestInFlight) return;
      requestInFlight = true;
      const currentRequestVersion = ++indexRequestVersionRef.current;
      const controller = new AbortController();
      activeController = controller;
      let timedOut = false;
      const requestTimeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 45_000);
      try {
        const response = await fetch(`/api/annotations?index=true&includeAllHumans=true&annotatorName=${encodeURIComponent(annotatorName)}&frame=english_ge_90`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Could not load shared annotations.");
        const result = await response.json() as { llm?: Record<string, Annotation>; humans?: Record<string, Record<string, Annotation>>; allHumans?: Record<string, Record<string, Annotation>> };
        if (cancelled || currentRequestVersion !== indexRequestVersionRef.current) return;
        setLlmAnnotations((current) => mergeAnnotationSnapshot(current, result.llm ?? {}));
        setHumanAnnotations((current) => mergeHumanAnnotationSnapshot(current, result.humans ?? {}));
        setAllHumanAnnotations((current) => mergeHumanAnnotationSnapshot(current, result.allHumans ?? {}));
        setSyncError("");
        setIndexLoadedFor(annotatorName);
      } catch (error) {
        if (cancelled || currentRequestVersion !== indexRequestVersionRef.current) return;
        setSyncError(timedOut ? "Shared annotations took too long to load. Retrying automatically." : error instanceof Error ? error.message : "Could not load shared annotations.");
      } finally {
        window.clearTimeout(requestTimeout);
        if (activeController === controller) activeController = null;
        requestInFlight = false;
      }
    };
    void loadIndex();
    const timer = window.setInterval(() => void loadIndex(), 30_000);
    return () => { cancelled = true; window.clearInterval(timer); activeController?.abort(); };
  }, [annotatorName]);
  const persist = useCallback(async (items: Array<{ source: AnnotationSource; recordId: string; annotatorName?: string; annotation: Annotation }>) => {
    if (!items.length) return;
    ++requestVersionRef.current;
    ++indexRequestVersionRef.current;
    try {
      const response = await fetch("/api/annotations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items }) });
      if (!response.ok) throw new Error("Could not save the shared annotation.");
      setSyncError("");
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : "Could not save the shared annotation.");
      throw error;
    }
  }, []);
  const updateLlm = useCallback((id: string, patch: Partial<Annotation>) => {
    const annotation = { ...llmAnnotations[id], ...patch, updatedAt: new Date().toISOString(), llmAnnotatedAt: llmAnnotations[id]?.llmAnnotatedAt ?? new Date().toISOString() };
    setLlmAnnotations((current) => ({ ...current, [id]: annotation }));
    void persist([{ source: "llm", recordId: id, annotation }]).catch(() => undefined);
  }, [llmAnnotations, persist]);
  const replaceLlm = useCallback((id: string, value: Annotation) => {
    const now = new Date().toISOString();
    const annotation = { ...value, updatedAt: now, llmAnnotatedAt: value.llmAnnotatedAt ?? now };
    setLlmAnnotations((current) => ({ ...current, [id]: annotation }));
    void persist([{ source: "llm", recordId: id, annotation }]).catch(() => undefined);
  }, [persist]);
  const updateHuman = useCallback((id: string, annotator: string, patch: Partial<Annotation>) => {
    if (!annotator.trim()) return;
    const annotation = { ...(humanAnnotations[id]?.[annotator] ?? {}), ...patch, updatedAt: new Date().toISOString() };
    setHumanAnnotations((current) => ({ ...current, [id]: { ...(current[id] ?? {}), [annotator]: annotation } }));
    setAllHumanAnnotations((current) => ({ ...current, [id]: { ...(current[id] ?? {}), [annotator]: annotation } }));
    void persist([{ source: "human", recordId: id, annotatorName: annotator, annotation }]).catch(() => undefined);
  }, [humanAnnotations, persist]);
  const replaceHuman = useCallback((id: string, annotator: string, value: Annotation) => {
    if (!annotator.trim()) return;
    const annotation = { ...value, updatedAt: new Date().toISOString() };
    setHumanAnnotations((current) => ({ ...current, [id]: { ...(current[id] ?? {}), [annotator]: annotation } }));
    setAllHumanAnnotations((current) => ({ ...current, [id]: { ...(current[id] ?? {}), [annotator]: annotation } }));
    void persist([{ source: "human", recordId: id, annotatorName: annotator, annotation }]).catch(() => undefined);
  }, [persist]);
  const importLegacy = useCallback(async (items: Array<{ source: AnnotationSource; recordId: string; annotatorName?: string; annotation: Annotation }>) => {
    for (let offset = 0; offset < items.length; offset += 500) await persist(items.slice(offset, offset + 500));
    await refresh(recordIdsKey);
  }, [persist, recordIdsKey, refresh]);
  const reset = useCallback(async (source: AnnotationSource, ids: string[], annotator?: string) => {
    if (!ids.length) return;
    ++requestVersionRef.current;
    ++indexRequestVersionRef.current;
    const response = await fetch("/api/annotations", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ source, recordIds: ids, annotatorName: annotator }) });
    if (!response.ok) { setSyncError("Could not reset the shared annotation."); throw new Error("Could not reset the shared annotation."); }
    setSyncError("");
    if (source === "llm") setLlmAnnotations((current) => { const next = { ...current }; ids.forEach((id) => delete next[id]); return next; });
    else setHumanAnnotations((current) => {
      const next = { ...current };
      for (const id of ids) { const records = { ...(next[id] ?? {}) }; delete records[annotator ?? ""]; if (Object.keys(records).length) next[id] = records; else delete next[id]; }
      return next;
    });
    if (source === "human") setAllHumanAnnotations((current) => {
      const next = { ...current };
      for (const id of ids) { const records = { ...(next[id] ?? {}) }; delete records[annotator ?? ""]; if (Object.keys(records).length) next[id] = records; else delete next[id]; }
      return next;
    });
  }, []);
  const resetAllLlm = useCallback(async () => {
    ++requestVersionRef.current;
    ++indexRequestVersionRef.current;
    const response = await fetch("/api/annotations", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "llm", all: true }) });
    if (!response.ok) { setSyncError("Could not reset all shared LLM annotations."); throw new Error("Could not reset all shared LLM annotations."); }
    setSyncError("");
    setLlmAnnotations({});
  }, []);
  return { llmAnnotations, humanAnnotations, allHumanAnnotations, indexLoadedFor, updateLlm, replaceLlm, updateHuman, replaceHuman, importLegacy, reset, resetAllLlm, syncError };
}

function revealTarget() {
  const container = document.querySelector<HTMLElement>(".conversation-content");
  const target = container?.querySelector<HTMLElement>(".target-row");
  if (!container || !target) return;
  const targetTop = target.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
  const targetHeight = target.getBoundingClientRect().height;
  const maxScroll = container.scrollHeight - container.clientHeight;
  const desiredTop = targetHeight > container.clientHeight - 160
    ? targetTop - 80
    : targetTop + targetHeight - container.clientHeight + 104;
  container.scrollTop = Math.min(maxScroll, Math.max(0, desiredTop));
}
function revealFirstSearchMatch(query: string) {
  const container = document.querySelector<HTMLElement>(".conversation-content");
  const match = container?.querySelector<HTMLElement>(".search-hit");
  if (!container || !match || !query.trim()) return false;
  const matchTop = match.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
  const desiredTop = matchTop - Math.min(110, container.clientHeight * 0.2);
  const maxScroll = container.scrollHeight - container.clientHeight;
  container.scrollTop = Math.min(maxScroll, Math.max(0, desiredTop));
  return true;
}
function parseSearchQuery(query: string) {
  const trimmed = query.trim();
  const exact = trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"');
  return { term: exact ? trimmed.slice(1, -1).trim() : trimmed, exact };
}
function roleName(role: string) { return ["user", "requester"].includes(role.toLowerCase()) ? "User" : role.toLowerCase() === "assistant" ? "Assistant" : role; }
function formatNumber(value: number) { return new Intl.NumberFormat("en-GB").format(value); }
type MarkdownNode = { type: string; value?: string; tagName?: string; properties?: { className?: string[] }; children?: MarkdownNode[] };
type TextMatch = { start: number; end: number; className: string; priority: number; referentIndex?: number; identifiability?: string; possibleHarm?: boolean };
const COMMON_PERSON_PRONOUNS = [
  "i", "me", "my", "mine", "myself", "we", "us", "our", "ours", "ourselves",
  "you", "your", "yours", "yourself", "yourselves", "he", "him", "his", "himself",
  "she", "her", "hers", "herself", "they", "them", "their", "theirs", "themself",
  "themselves", "who", "whom", "whose", "whoever", "whomever", "somebody", "someone",
  "anybody", "anyone", "everybody", "everyone", "nobody", "no one",
];
function textMatches(source: string, terms: string[], className: string, priority: number, wholeWord = false): TextMatch[] {
  const matches: TextMatch[] = [];
  const lowerSource = source.toLocaleLowerCase();
  for (const term of new Set(terms.map((value) => value.trim()).filter(Boolean))) {
    const lowerTerm = term.toLocaleLowerCase();
    let from = 0;
    while (from < source.length) {
      const start = lowerSource.indexOf(lowerTerm, from);
      if (start < 0) break;
      const end = start + lowerTerm.length;
      const isWord = (char: string | undefined) => !!char && /[\p{L}\p{N}_]/u.test(char);
      if (!wholeWord || (!isWord(source[start - 1]) && !isWord(source[end]))) matches.push({ start, end, className, priority });
      from = end;
    }
  }
  return matches;
}
function highlightPlugin(query: string, prescreenExamples: string[] = [], showHeuristicPronouns = false, annotatedReferents: DripReferent[] = [], highlightAnnotations = false) {
  const { term: normalizedQuery, exact } = parseSearchQuery(query);
  return () => (tree: MarkdownNode) => {
    const walk = (node: MarkdownNode) => {
      if (!node.children) return;
      const children: MarkdownNode[] = [];
      for (const child of node.children) {
        if (child.type === "text" && child.value) {
          const source = child.value;
          const candidates = [
            ...textMatches(source, prescreenExamples, "prescreen-hit", 3, true),
            ...(showHeuristicPronouns ? textMatches(source, COMMON_PERSON_PRONOUNS, "pronoun-hit", 2, true) : []),
            ...(normalizedQuery ? textMatches(source, [normalizedQuery], "search-hit", 4, exact) : []),
            ...annotatedReferents.flatMap((referent, index) => {
              const mention = referent.mention?.trim();
              const identifiability = referent.identifiability === "Directly identifiable" ? "D" : referent.identifiability === "Indirectly identifiable" ? "I" : referent.identifiability === "No identifying cues" ? "N" : "";
              const possibleHarm = referent.type === "Named others" && (referent.identifiability === "Directly identifiable" || referent.identifiability === "Indirectly identifiable");
              return mention ? textMatches(source, [mention], "annotation-hit", possibleHarm ? 6 : highlightAnnotations ? 5 : 1, true).map((match) => ({ ...match, referentIndex: index, identifiability, possibleHarm })) : [];
            }),
          ];
          const matches: TextMatch[] = [];
          for (const candidate of [...candidates].sort((a, b) => b.priority - a.priority || a.start - b.start || b.end - a.end)) {
            if (!matches.some((match) => candidate.start < match.end && candidate.end > match.start)) matches.push(candidate);
          }
          matches.sort((a, b) => a.start - b.start || b.priority - a.priority || b.end - a.end);
          let cursor = 0;
          for (const match of matches) {
            if (match.start < cursor) continue;
            if (match.start > cursor) children.push({ type: "text", value: source.slice(cursor, match.start) });
            const harmfulReferent = match.className === "annotation-hit" && match.possibleHarm;
            children.push({ type: "element", tagName: harmfulReferent ? "a" : match.className === "annotation-hit" ? "span" : "mark", properties: { className: [match.className], ...(match.className === "annotation-hit" ? { dataReferentIndex: String(match.referentIndex), ...(match.possibleHarm ? { dataPossibleHarm: "true" } : {}) } : {}), ...(harmfulReferent ? { href: `https://www.google.com/search?q=${encodeURIComponent(source.slice(match.start, match.end))}`, target: "_blank", rel: "noopener noreferrer", title: "Search this possible-harm referent on Google" } : {}) }, children: [{ type: "text", value: source.slice(match.start, match.end) }, ...(match.className === "annotation-hit" && highlightAnnotations && match.identifiability ? [{ type: "element", tagName: "span", properties: { className: ["annotation-identifiability-badge"] }, children: [{ type: "text", value: match.identifiability }] }] : [])] });
            cursor = match.end;
          }
          if (cursor < source.length) children.push({ type: "text", value: source.slice(cursor) });
        } else { walk(child); children.push(child); }
      }
      node.children = children;
    };
    walk(tree);
  };
}
function highlightPlainText(value: string, query: string) {
  const { term: normalizedQuery, exact } = parseSearchQuery(query);
  if (!normalizedQuery) return value;
  const matches = textMatches(value, [normalizedQuery], "search-hit", 1, exact);
  const result: ReactNode[] = [];
  let cursor = 0;
  matches.forEach((match, index) => {
    if (match.start > cursor) result.push(value.slice(cursor, match.start));
    result.push(<mark className="search-hit" key={`${match.start}-${index}`}>{value.slice(match.start, match.end)}</mark>);
    cursor = match.end;
  });
  if (cursor < value.length) result.push(value.slice(cursor));
  return result.length ? result : value;
}
function signalLabels(signals: Record<string, boolean | undefined>) {
  return [[signals.personName, "Person name"], [signals.personNoun, "Person noun"], [signals.personPronoun, "Pronoun"], [signals.coreference, "Coreference"], [signals.embeddedContent, "Embedded content"]].filter(([active]) => active).map(([, label]) => String(label));
}

export default function Home() {
  const { annotations: profileAnnotations, update: updateProfile, replace: replaceProfile, remove: removeProfile, removeMany: removeManyProfile, hydrated, saved, profiles, activeProfile, activeProfileId, profilesSynced, profileSyncError, switchProfile, createProfile, renameProfile, deleteProfile, readForExport, readForBackup } = useAnnotations();
  const [annotationSource, setAnnotationSource] = useState<AnnotationSource>("llm");
  const [selectedHumanAnnotator, setSelectedHumanAnnotator] = useState("");
  const [prescreenExpanded, setPrescreenExpanded] = useState(false);
  const [agreementExpanded, setAgreementExpanded] = useState(false);
  const [agreementSummary, setAgreementSummary] = useState<{ messages: number; comparisons: number; agreements: number; percent: number | null; updatedAt: string } | null>(null);
  const [llmHumanAgreement, setLlmHumanAgreement] = useState<{ messages: number; comparisons: number; agreements: number; percent: number | null; updatedAt: string } | null>(null);
  const [viewStateReady, setViewStateReady] = useState(false);
  const [query, setQuery] = useState("");
  const [stratum, setStratum] = useState("english_ge_90");
  const [ctpLabel, setCtpLabel] = useState<CtpLabel>("");
  const [ctpCounts, setCtpCounts] = useState<CtpScreeningCounts | null>(null);
  const [ctpCountsLoading, setCtpCountsLoading] = useState(false);
  const [ctpCountsError, setCtpCountsError] = useState("");
  const [signal, setSignal] = useState<string[]>([]);
  const [matchMode, setMatchMode] = useState<"any" | "all">("any");
  const [statusFilters, setStatusFilters] = useState<string[]>([]);
  const [sidebarSection, setSidebarSection] = useState<"browse" | "annotations">("browse");
  const [presidioOnly, setPresidioOnly] = useState(false);
  const [corefMinMentions, setCorefMinMentions] = useState("");
  const [corefMinRate, setCorefMinRate] = useState("");
  const [annotationFilters, setAnnotationFilters] = useState<Record<string, string[]>>({ domains: [], referents: [], identifiability: [], purposes: [], harm: [] });
  const [possibleHarmFilter, setPossibleHarmFilter] = useState(false);
  const [payload, setPayload] = useState<Payload | null>(null);
  const [searchError, setSearchError] = useState("");
  const [searchRetry, setSearchRetry] = useState(0);
  const sharedAnnotations = useSharedAnnotationStore(payload?.items.map((row) => row.id) ?? [], activeProfile.name);
  const humanLocalAnnotations = useMemo(() => Object.fromEntries(Object.entries(profileAnnotations).filter(([, annotation]) => !annotation.llmAnnotatedAt)), [profileAnnotations]);
  const frameAnnotationIds = useMemo(() => new Set([
    ...Object.keys(sharedAnnotations.llmAnnotations),
    ...Object.keys(sharedAnnotations.humanAnnotations),
    ...Object.keys(sharedAnnotations.allHumanAnnotations),
  ]), [sharedAnnotations.llmAnnotations, sharedAnnotations.humanAnnotations, sharedAnnotations.allHumanAnnotations]);
  const frameHumanLocalAnnotations = useMemo(() => Object.fromEntries(
    Object.entries(humanLocalAnnotations).filter(([id]) => frameAnnotationIds.has(id)),
  ), [humanLocalAnnotations, frameAnnotationIds]);
  const annotations = annotationSource === "llm"
    ? sharedAnnotations.llmAnnotations
    : Object.fromEntries([...new Set([...Object.keys(humanLocalAnnotations), ...Object.keys(sharedAnnotations.humanAnnotations)])].flatMap((id) => {
      const annotation = sharedAnnotations.humanAnnotations[id]?.[activeProfile.name] ?? humanLocalAnnotations[id];
      return annotation ? [[id, annotation]] : [];
    }));
  const unassignedProfile = activeProfileId === DEFAULT_PROFILE_ID && !profiles.some((profile) => profile.id === DEFAULT_PROFILE_ID);
  const update = useCallback((id: string, patch: Partial<Annotation>) => {
    if (annotationSource === "llm") sharedAnnotations.updateLlm(id, patch);
    else if (!unassignedProfile && (!selectedHumanAnnotator || selectedHumanAnnotator === activeProfile.name)) { updateProfile(id, patch); sharedAnnotations.updateHuman(id, activeProfile.name, patch); }
  }, [annotationSource, sharedAnnotations, updateProfile, activeProfile.name, selectedHumanAnnotator, unassignedProfile]);
  const replaceLlm = sharedAnnotations.replaceLlm;
  const replaceHumanAnnotation = useCallback((id: string, value: Annotation) => {
    if (unassignedProfile) return;
    replaceProfile(id, value);
    sharedAnnotations.replaceHuman(id, activeProfile.name, value);
  }, [replaceProfile, sharedAnnotations, activeProfile.name, unassignedProfile]);
  const remove = useCallback((id: string) => {
    if (annotationSource === "llm") void sharedAnnotations.reset("llm", [id]);
    else if (!unassignedProfile && (!selectedHumanAnnotator || selectedHumanAnnotator === activeProfile.name)) { removeProfile(id); void sharedAnnotations.reset("human", [id], activeProfile.name); }
  }, [annotationSource, sharedAnnotations, removeProfile, activeProfile.name, selectedHumanAnnotator, unassignedProfile]);
  const removeMany = useCallback((ids: string[]) => {
    if (annotationSource === "llm") void sharedAnnotations.reset("llm", ids);
    else if (!unassignedProfile && (!selectedHumanAnnotator || selectedHumanAnnotator === activeProfile.name)) { removeManyProfile(ids); void sharedAnnotations.reset("human", ids, activeProfile.name); }
  }, [annotationSource, sharedAnnotations, removeManyProfile, activeProfile.name, selectedHumanAnnotator, unassignedProfile]);
  const migratedLocalAnnotationsRef = useRef(false);
  useEffect(() => {
    if (!hydrated || !profilesSynced || migratedLocalAnnotationsRef.current) return;
    let cancelled = false;
    let retryTimer: number | undefined;
    const migrateLocalAnnotations = async () => {
      try {
        const snapshot = await readForBackup();
        if (!snapshot || cancelled) return;
        const profileNames = new Map(snapshot.profiles.map((profile) => [profile.id, profile.name]));
        const items = snapshot.annotations.map((annotation) => annotation.llmAnnotatedAt
          ? { source: "llm" as const, recordId: annotation.recordId, annotation }
          : { source: "human" as const, recordId: annotation.recordId, annotatorName: profileNames.get(annotation.profileId) ?? annotation.profileId, annotation });
        if (items.length) await sharedAnnotations.importLegacy(items);
        if (!cancelled) migratedLocalAnnotationsRef.current = true;
      } catch {
        if (!cancelled) retryTimer = window.setTimeout(() => void migrateLocalAnnotations(), 30_000);
      }
    };
    void migrateLocalAnnotations();
    return () => { cancelled = true; window.clearTimeout(retryTimer); };
  }, [hydrated, profilesSynced, readForBackup, sharedAnnotations.importLegacy]);
  const payloadRef = useRef<Payload | null>(null);
  const searchJobRef = useRef("");
  const [page, setPage] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);
  const [activeId, setActiveId] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const selectionAnchorRef = useRef("");
  const pendingQueueFocusRef = useRef(false);
  const [pinnedActive, setPinnedActive] = useState<RecordRow | null>(null);
  const [contextLoadingId, setContextLoadingId] = useState("");
  const [contextError, setContextError] = useState("");
  const [contextErrorId, setContextErrorId] = useState("");
  const [contextRetry, setContextRetry] = useState(0);
  const activeIdRef = useRef(activeId);
  const pinnedActiveRef = useRef(pinnedActive);
  activeIdRef.current = activeId;
  pinnedActiveRef.current = pinnedActive;
  const [pinnedQueueIndex, setPinnedQueueIndex] = useState(0);
  const [queueWidth, setQueueWidth] = useState(300);
  const [detailWidth, setDetailWidth] = useState(400);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const [searchFocused, setSearchFocused] = useState(false);
  const [prescreenHighlights, setPrescreenHighlights] = useState(false);
  const [heuristicHighlights, setHeuristicHighlights] = useState(false);
  const [annotationHighlights, setAnnotationHighlights] = useState(false);
  const [pendingReferentScroll, setPendingReferentScroll] = useState<{ index: number; request: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const [backupAt, setBackupAt] = useState("");
  const [backupFailed, setBackupFailed] = useState(false);
  const [mobileFilterOpen, setMobileFilterOpen] = useState(false);
  const [mobileReading, setMobileReading] = useState(false);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [profileDialog, setProfileDialog] = useState<"create" | "rename" | "remove" | null>(null);
  const [profileName, setProfileName] = useState("");
  const [profileDialogError, setProfileDialogError] = useState("");
  const [profileDialogBusy, setProfileDialogBusy] = useState(false);
  const [copyLlmConfirmOpen, setCopyLlmConfirmOpen] = useState(false);
  const [sampleDialogOpen, setSampleDialogOpen] = useState(false);
  const sampleUnit: SampleUnit = "english_ge_90";
  const batchSampleUnit: SampleUnit = "english_ge_90";
  const [sampleN, setSampleN] = useState("100");
  const [sampleCtpLabel, setSampleCtpLabel] = useState<CtpLabel>("");
  const [batchSampleN, setBatchSampleN] = useState("10");
  const [batchConcurrency, setBatchConcurrency] = useState<"1" | "2" | "5">("1");
  const [sampleSeed, setSampleSeed] = useState("wildchat-prescreen-v1");
  const [reasoningEffort, setReasoningEffort] = useState<"low" | "medium" | "high">("low");
  const [sampleLoading, setSampleLoading] = useState(false);
  const [sampleError, setSampleError] = useState("");
  const [batchDialogOpen, setBatchDialogOpen] = useState(false);
  const [conversationLists, setConversationLists] = useState<ConversationList[]>([]);
  const [conversationListsLoaded, setConversationListsLoaded] = useState(false);
  const [browseListId, setBrowseListId] = useState("");
  const [browseListLoading, setBrowseListLoading] = useState(false);
  const [browseListError, setBrowseListError] = useState("");
  const [browseListRecordIds, setBrowseListRecordIds] = useState<string[]>([]);
  const [historyList, setHistoryList] = useState<ConversationList | null>(null);
  const [historyRuns, setHistoryRuns] = useState<ListAnnotationRun[]>([]);
  const [historyCurrentAnnotations, setHistoryCurrentAnnotations] = useState<{ llm: Record<string, Annotation>; humans: Record<string, Record<string, Annotation>> }>({ llm: {}, humans: {} });
  const [historyMessages, setHistoryMessages] = useState<Record<string, HistoryMessage>>({});
  const [historyCompareFrom, setHistoryCompareFrom] = useState("");
  const [historyCompareTo, setHistoryCompareTo] = useState("");
  const [fullHistoryOpen, setFullHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [llmHistoryOpen, setLlmHistoryOpen] = useState(false);
  const [llmHistoryRecordId, setLlmHistoryRecordId] = useState("");
  const [llmHistoryVersions, setLlmHistoryVersions] = useState<LlmHistoryVersion[]>([]);
  const [llmHistoryLoading, setLlmHistoryLoading] = useState(false);
  const [llmHistoryError, setLlmHistoryError] = useState("");
  const [selectedLlmHistoryId, setSelectedLlmHistoryId] = useState("");
  const [llmResetMenuOpen, setLlmResetMenuOpen] = useState(false);
  const [expandedHistoryRun, setExpandedHistoryRun] = useState("");
  const [listsDialogOpen, setListsDialogOpen] = useState(false);
  const [evaluationDialogOpen, setEvaluationDialogOpen] = useState(false);
  const [listsLoading, setListsLoading] = useState(false);
  const [listsError, setListsError] = useState("");
  const [editingListId, setEditingListId] = useState("");
  const [editingListName, setEditingListName] = useState("");
  const [editingEntriesListId, setEditingEntriesListId] = useState("");
  const [editingListEntries, setEditingListEntries] = useState("");
  const [checkingListIds, setCheckingListIds] = useState(false);
  const [listIdMatches, setListIdMatches] = useState<ConversationListIdMatch[] | null>(null);
  const [listIdMissing, setListIdMissing] = useState<string[]>([]);
  const [newListName, setNewListName] = useState("");
  const [newListConversationIds, setNewListConversationIds] = useState("");
  const [listBatchTarget, setListBatchTarget] = useState<ConversationList | null>(null);
  const [listBatchRecordIds, setListBatchRecordIds] = useState<string[] | null>(null);
  const [stabilityDialogOpen, setStabilityDialogOpen] = useState(false);
  const [stabilityTarget, setStabilityTarget] = useState<ConversationList | null>(null);
  const [stabilityRepetitions, setStabilityRepetitions] = useState("10");
  const [stabilityProgress, setStabilityProgress] = useState<StabilityProgress>({ active: false, preparing: false, completed: 0, total: 0, repetition: 0, failed: 0, error: "", errors: [] });
  const [stabilityResult, setStabilityResult] = useState<StabilityResult | null>(null);
  const [stabilityVisibleCategories, setStabilityVisibleCategories] = useState<StabilityCategory[]>(STABILITY_CATEGORIES);
  const [stabilityHoveredRepeat, setStabilityHoveredRepeat] = useState<number | null>(null);
  const [skipAnnotated, setSkipAnnotated] = useState(true);
  const [batchAnnotationScope, setBatchAnnotationScope] = useState<BatchAnnotationScope>("paper_frame");
  const [batchCtpSelection, setBatchCtpSelection] = useState<"" | "yes">("");
  const [batchRun, setBatchRun] = useState<BatchProgress>({ active: false, sampling: false, completed: 0, total: 0, succeeded: 0, failed: 0, skipped: 0, current: 0, startedAt: 0, cancelled: false, error: "", errors: [] });
  const [llmUsage, setLlmUsage] = useState({ inputTokens: 0, outputTokens: 0, lastResetAt: "" });
  const [usageResetBusy, setUsageResetBusy] = useState(false);
  const [promptDialog, setPromptDialog] = useState<SharedPromptDimension | null>(null);
  const [personReferenceCriteria, setPersonReferenceCriteria] = useState(DEFAULT_PERSON_REFERENCE_CRITERIA);
  const [promptValues, setPromptValues] = useState(DEFAULT_ANNOTATION_PROMPTS);
  const [promptDraft, setPromptDraft] = useState("");
  const [promptLoaded, setPromptLoaded] = useState(false);
  const [promptStatus, setPromptStatus] = useState<"loading" | "saved" | "saving" | "error">("saved");
  const [promptError, setPromptError] = useState("");
  const [promptDownloadOpen, setPromptDownloadOpen] = useState(false);
  const [promptDownloadLoading, setPromptDownloadLoading] = useState(false);
  const [promptDownloadError, setPromptDownloadError] = useState("");
  const [promptDownloadCurrent, setPromptDownloadCurrent] = useState<{ prompts: Record<string, string>; personReferenceCriteria: string; personReferenceRule: string; promptVersion: string } | null>(null);
  const [promptDownloadVersions, setPromptDownloadVersions] = useState<PromptDownloadVersion[]>([]);
  const [promptDownloadSelected, setPromptDownloadSelected] = useState("current");
  const [promptDownloadSearch, setPromptDownloadSearch] = useState("");
  const [llmBusyId, setLlmBusyId] = useState<string | null>(null);
  const [redoComparison, setRedoComparison] = useState<RedoComparison | null>(null);
  const singleAnnotationAbortRef = useRef<AbortController | null>(null);
  const [llmErrors, setLlmErrors] = useState<Record<string, string>>({});
  const promptDraftRef = useRef("");
  const lastSavedPromptRef = useRef("");
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const profileMenuRef = useRef<HTMLDivElement>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const filterMenuRef = useRef<HTMLDivElement>(null);
  const llmResetMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => () => { resizeCleanupRef.current?.(); }, []);
  const loadingPageRef = useRef(false);
  const pendingNextRef = useRef(false);
  const batchAbortRef = useRef<AbortController | null>(null);
  const stabilityAbortRef = useRef<AbortController | null>(null);
  const referentScrollRequestRef = useRef(0);
  const browseListRequestRef = useRef(0);
  const viewRestoredRef = useRef(false);
  const restoreActiveIdRef = useRef("");

  const refreshLlmUsage = useCallback(async () => {
    try {
      const response = await fetch("/api/llm-usage", { cache: "no-store" });
      if (!response.ok) return;
      const result = await response.json() as { usage?: typeof llmUsage };
      if (result.usage) setLlmUsage(result.usage);
    } catch { /* Keep the last displayed usage total if the server is briefly unavailable. */ }
  }, []);

  useEffect(() => {
    if (!batchDialogOpen) return;
    void refreshLlmUsage();
    const timer = window.setInterval(() => void refreshLlmUsage(), 5000);
    return () => window.clearInterval(timer);
  }, [batchDialogOpen, refreshLlmUsage]);

  const resetLlmUsage = async () => {
    if (!window.confirm("Reset the GPT-6-Luna input and output token totals and start a new counter period now?")) return;
    setUsageResetBusy(true);
    try {
      const response = await fetch("/api/llm-usage", { method: "DELETE" });
      const result = await response.json() as { usage?: typeof llmUsage; error?: string };
      if (!response.ok || !result.usage) throw new Error(result.error || "Could not reset the usage counter.");
      setLlmUsage(result.usage);
    } catch (error) {
      setBatchRun((state) => ({ ...state, error: error instanceof Error ? error.message : "Could not reset the usage counter." }));
    } finally { setUsageResetBusy(false); }
  };

  useEffect(() => {
    const closeMenus = (event: MouseEvent) => {
      if (!profileMenuRef.current?.contains(event.target as Node)) setProfileMenuOpen(false);
      if (!exportMenuRef.current?.contains(event.target as Node)) setExportMenuOpen(false);
      if (!filterMenuRef.current?.contains(event.target as Node)) setFilterMenuOpen(false);
      if (!llmResetMenuRef.current?.contains(event.target as Node)) setLlmResetMenuOpen(false);
    };
    document.addEventListener("mousedown", closeMenus);
    return () => document.removeEventListener("mousedown", closeMenus);
  }, []);

  const reviewIds = useMemo(() => {
    const reviewed: string[] = [];
    const partial: string[] = [];
    const full: string[] = [];
    for (const [id, annotation] of Object.entries(annotations)) {
      if (hasAnnotation(annotation)) reviewed.push(id);
      if (isPartiallyAnnotated(annotation)) partial.push(id);
      if (isFullyAnnotated(annotation)) full.push(id);
    }
    return { reviewed, partial, full };
  }, [annotations]);
  const llmReviewIds = useMemo(() => {
    const partial: string[] = [];
    const full: string[] = [];
    for (const [id, annotation] of Object.entries(sharedAnnotations.llmAnnotations)) {
      if (isPartiallyAnnotated(annotation)) partial.push(id);
      if (isFullyAnnotated(annotation)) full.push(id);
    }
    return { partial, full };
  }, [sharedAnnotations.llmAnnotations]);
  const sharedAnnotationIndexReady = sharedAnnotations.indexLoadedFor === activeProfile.name;
  const activeProfileNames = useMemo(() => [...new Set([activeProfile.name, ...profiles.filter((profile) => !profile.retired).map((profile) => profile.name)])], [activeProfile.name, profiles]);
  const activeHumanAnnotations = useMemo(() => filterHumanAnnotationsToProfiles(sharedAnnotations.humanAnnotations, activeProfileNames), [sharedAnnotations.humanAnnotations, activeProfileNames]);
  const activeAllHumanAnnotations = useMemo(() => filterHumanAnnotationsToProfiles(sharedAnnotations.allHumanAnnotations, activeProfileNames), [sharedAnnotations.allHumanAnnotations, activeProfileNames]);
  const allHumanAnnotatorNames = useMemo(() => [...new Set(Object.values(activeAllHumanAnnotations).flatMap((byAnnotator) => Object.keys(byAnnotator)))].sort((left, right) => left.localeCompare(right)), [activeAllHumanAnnotations]);
  const humanAnnotatorNames = useMemo(() => [...new Set([activeProfile.name, ...activeProfileNames, ...allHumanAnnotatorNames])]
    .sort((left, right) => left === activeProfile.name ? -1 : right === activeProfile.name ? 1 : left.localeCompare(right)), [activeProfile.name, activeProfileNames, allHumanAnnotatorNames]);
  const humanAnnotationIdsByAnnotator = useMemo(() => {
    const localAnnotationsByProfile = Object.fromEntries(Object.entries(frameHumanLocalAnnotations).map(([id, annotation]) => [id, { [activeProfile.name]: annotation }]));
    const sources = [activeAllHumanAnnotations, activeHumanAnnotations, localAnnotationsByProfile];
    return Object.fromEntries(humanAnnotatorNames.map((name) => [name, idsAnnotatedByHuman(sources, name, hasAnnotation)]));
  }, [activeAllHumanAnnotations, activeHumanAnnotations, frameHumanLocalAnnotations, activeProfile.name, humanAnnotatorNames]);
  const llmAndHumanIdsByAnnotator = useMemo(() => {
    const result: Record<string, string[]> = Object.fromEntries(humanAnnotatorNames.map((name) => [name, []]));
    for (const [id, llmAnnotation] of Object.entries(sharedAnnotations.llmAnnotations)) {
      if (!isFullyAnnotated(llmAnnotation)) continue;
      for (const name of humanAnnotatorNames) {
        const human = name === activeProfile.name
          ? activeHumanAnnotations[id]?.[name] ?? frameHumanLocalAnnotations[id]
          : activeAllHumanAnnotations[id]?.[name];
        if (isFullyAnnotated(human)) result[name].push(id);
      }
    }
    return result;
  }, [sharedAnnotations.llmAnnotations, activeHumanAnnotations, activeAllHumanAnnotations, activeProfile.name, frameHumanLocalAnnotations, humanAnnotatorNames]);
  const msd1TestReviewers = useMemo(() => humanAnnotatorNames.flatMap((name) => {
    const records = (humanAnnotationIdsByAnnotator[name] ?? []).flatMap((recordId) => {
      const human = name === activeProfile.name
        ? activeHumanAnnotations[recordId]?.[name] ?? frameHumanLocalAnnotations[recordId] ?? activeAllHumanAnnotations[recordId]?.[name]
        : activeAllHumanAnnotations[recordId]?.[name] ?? activeHumanAnnotations[recordId]?.[name];
      const humanLabel = human?.relevance ?? human?.decision;
      return humanLabel === "yes" || humanLabel === "no" || humanLabel === "uncertain"
        ? [{ recordId, humanLabel, annotationCompleteness: isFullyAnnotated(human) ? "fully" as const : "partially" as const }]
        : [];
    });
    return records.length ? [{ name, records }] : [];
  }), [humanAnnotationIdsByAnnotator, humanAnnotatorNames, activeProfile.name, activeHumanAnnotations, activeAllHumanAnnotations, frameHumanLocalAnnotations]);
  const llmAndAllHumansIds = useMemo(() => {
    if (!allHumanAnnotatorNames.length) return [];
    return Object.entries(sharedAnnotations.llmAnnotations)
      .filter(([id, llmAnnotation]) => isFullyAnnotated(llmAnnotation) && allHumanAnnotatorNames.every((name) => isFullyAnnotated(activeAllHumanAnnotations[id]?.[name])))
      .map(([id]) => id);
  }, [sharedAnnotations.llmAnnotations, activeAllHumanAnnotations, allHumanAnnotatorNames]);
  const llmAndAnyHumanIds = useMemo(() => Object.entries(sharedAnnotations.llmAnnotations)
    .filter(([id, llmAnnotation]) => isFullyAnnotated(llmAnnotation) && (
      isFullyAnnotated(frameHumanLocalAnnotations[id])
      || Object.values(activeHumanAnnotations[id] ?? {}).some(isFullyAnnotated)
      || Object.values(activeAllHumanAnnotations[id] ?? {}).some(isFullyAnnotated)
    ))
    .map(([id]) => id), [sharedAnnotations.llmAnnotations, activeHumanAnnotations, activeAllHumanAnnotations, frameHumanLocalAnnotations]);
  const humanAtLeastTwoIds = useMemo(() => idsWithAtLeastTwoAnnotators([
    activeAllHumanAnnotations,
    activeHumanAnnotations,
    Object.fromEntries(Object.entries(frameHumanLocalAnnotations).map(([id, annotation]) => [id, { [activeProfile.name]: annotation }])),
  ], hasAnnotation), [activeAllHumanAnnotations, activeHumanAnnotations, frameHumanLocalAnnotations, activeProfile.name]);
  const allHumanAnnotatedIds = useMemo(() => [...new Set(Object.values(humanAnnotationIdsByAnnotator).flat())], [humanAnnotationIdsByAnnotator]);
  const batchHumanSampleIds = useMemo(() => {
    if (batchAnnotationScope === "all_humans") return allHumanAnnotatedIds;
    if (batchAnnotationScope === "two_or_more_humans") return humanAtLeastTwoIds;
    if (batchAnnotationScope.startsWith("annotator:")) return humanAnnotationIdsByAnnotator[batchAnnotationScope.slice("annotator:".length)] ?? [];
    return null;
  }, [batchAnnotationScope, allHumanAnnotatedIds, humanAtLeastTwoIds, humanAnnotationIdsByAnnotator]);
  const batchHumanScopeLabel = batchAnnotationScope === "all_humans" ? "Any human annotation"
    : batchAnnotationScope === "two_or_more_humans" ? "≥2 Humans Annotated"
      : batchAnnotationScope.startsWith("annotator:") ? `${batchAnnotationScope.slice("annotator:".length)} Annotated` : "Paper frame";
  // A selected list is an explicit browsing scope. Profile switches may select
  // the default "todo" mode, but must not silently filter list entries by it.
  const statusMode = browseListId ? "all" : statusFilters.length === 1 ? statusFilters[0] : "all";
  const exclusions = statusMode === "todo" ? reviewIds.reviewed : NO_EXCLUSIONS;
  const reviewFilterIds = statusMode === "partial" ? llmReviewIds.partial
    : statusMode === "full" ? llmReviewIds.full
      : statusMode === "llm_human" ? llmAndHumanIdsByAnnotator[activeProfile.name] ?? NO_EXCLUSIONS
        : statusMode.startsWith("llm_human:") ? llmAndHumanIdsByAnnotator[statusMode.slice("llm_human:".length)] ?? NO_EXCLUSIONS
          : statusMode.startsWith("human:") ? humanAnnotationIdsByAnnotator[statusMode.slice("human:".length)] ?? NO_EXCLUSIONS
            : statusMode === "llm_all_humans" ? llmAndAllHumansIds
              : statusMode === "human_2plus" ? humanAtLeastTwoIds : NO_EXCLUSIONS;
  const annotationFilterIndex = useMemo(() => {
    const index = new Map<string, Set<string>>();
    const add = (key: string, id: string) => {
      let ids = index.get(key);
      if (!ids) { ids = new Set(); index.set(key, ids); }
      ids.add(id);
    };
    for (const [id, annotation] of Object.entries(annotations)) {
      for (const value of annotation.domains ?? []) add(`domains\u0000${value}`, id);
      for (const referent of annotation.referents ?? []) {
        if (referent.type) add(`referents\u0000${referent.type}`, id);
        if (referent.identifiability) add(`identifiability\u0000${referent.identifiability}`, id);
      }
      for (const value of annotation.purposes ?? []) add(`purposes\u0000${value}`, id);
      if (hasPossibleHarm(annotation)) add(`harm\u0000${POSSIBLE_HARM_FILTER}`, id);
    }
    return index;
  }, [annotations]);
  const annotationFilterIds = useMemo(() => {
    const selected = ANNOTATION_FILTER_GROUPS.flatMap((group) => (annotationFilters[group.key] ?? []).map((value) => `${group.key}\u0000${value}`));
    if (possibleHarmFilter) selected.push(`harm\u0000${POSSIBLE_HARM_FILTER}`);
    if (!selected.length) return NO_EXCLUSIONS;
    const sets = selected.map((key) => annotationFilterIndex.get(key) ?? new Set<string>());
    if (matchMode === "all") {
      const smallest = sets.reduce((a, b) => a.size <= b.size ? a : b);
      return [...smallest].filter((id) => sets.every((ids) => ids.has(id)));
    }
    const result = new Set<string>();
    for (const ids of sets) for (const id of ids) result.add(id);
    return [...result];
  }, [annotationFilters, annotationFilterIndex, matchMode, possibleHarmFilter]);
  const annotationFiltersActive = ANNOTATION_FILTER_GROUPS.some((group) => (annotationFilters[group.key] ?? []).length > 0) || possibleHarmFilter;
  const includedIds = useMemo(() => combineReviewFilterIds(statusMode, reviewFilterIds, annotationFilterIds, annotationFiltersActive), [statusMode, annotationFiltersActive, annotationFilterIds, reviewFilterIds]);
  const includedIdsKey = recordIdsSignature(includedIds);
  const searchIncludedIds = useMemo(() => recordIdsFromSignature(includedIdsKey), [includedIdsKey]);
  const exclusionsKey = recordIdsSignature(exclusions);
  const searchExclusions = useMemo(() => recordIdsFromSignature(exclusionsKey), [exclusionsKey]);
  const reviewFilterSignature = reviewStatusFilterSignature(statusMode, includedIds);
  const annotationSnapshotRequired = searchNeedsAnnotationSnapshot(statusMode, annotationFiltersActive);
  const annotationSnapshotReady = !annotationSnapshotRequired || sharedAnnotations.indexLoadedFor === activeProfile.name;
  useEffect(() => {
    if (!hydrated || !viewStateReady || !annotationSnapshotReady) return;
    let cancelled = false;
    let timedOut = false;
    let requestTimeout = 0;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setSearchError("");
      requestTimeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 240_000);
      if (page === 1) searchJobRef.current = crypto.randomUUID().replace(/-/g, "");
      const activeStratum = isReviewStatusMode(statusMode) ? "english_ge_90" : stratum;
      const includeOnly = isReviewStatusMode(statusMode) || annotationFiltersActive || Boolean(browseListId);
      const params = new URLSearchParams({ q: query, stratum: activeStratum, signal: signal.join(",") || "all", presidio: presidioOnly ? "1" : "0", match: matchMode, corefMinMentions: corefMinMentions || "0", corefMinRate: corefMinRate || "0", context: includeOnly ? "0" : "1", page: String(page), limit: "24", jobId: searchJobRef.current });
      if (ctpLabel && sidebarSection === "browse" && statusMode === "all") params.set("ctpLabel", ctpLabel);
      let receivedTerminalEvent = false;
      let receivedTerminalPayload = false;
      try {
        const currentExclusions = searchExclusions;
        const currentIncludedIds = searchIncludedIds;
        const reviewStatusIds = isReviewStatusMode(statusMode)
          ? page > 1 && payloadRef.current?.reviewStatusIds
            ? payloadRef.current.reviewStatusIds
            : [...currentIncludedIds]
          : undefined;
        const usePost = currentExclusions.length > 0 || includeOnly;
        const response = await fetch(`/api/records?${params}`, usePost ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ exclude: currentExclusions, include: browseListRecordIds.length ? browseListRecordIds : reviewStatusIds ?? currentIncludedIds, includeOnly }), signal: controller.signal } : { signal: controller.signal });
        if (!response.ok || !response.body) throw new Error(`Search request failed (${response.status})`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        const applyEvent = (event: { event: string; jobId?: string; payload?: Payload; error?: string }) => {
          if (cancelled) return;
          if (event.event === "error") throw new Error(event.error || "Search failed");
          if (event.event === "complete" || event.event === "page") {
            receivedTerminalEvent = true;
            receivedTerminalPayload = Boolean(event.payload);
          }
          if (event.event === "cancelled") throw new Error("The search stopped before it returned results.");
          const next = event.payload ? { ...event.payload, items: uniqueRecordRows(event.payload.items), ...(reviewStatusIds ? { reviewStatusIds } : {}) } : undefined;
          if (event.jobId) searchJobRef.current = event.jobId;
          if (!next) return;
          if (event.event === "preview") {
            payloadRef.current = next;
            setPayload(next);
            const restoreId = restoreActiveIdRef.current;
            if (restoreId && next.items.some((row) => row.id === restoreId)) { setActiveId(restoreId); restoreActiveIdRef.current = ""; }
            else if (!restoreId && next.items[0] && !next.items.some((row) => row.id === activeIdRef.current) && pinnedActiveRef.current?.id !== activeIdRef.current) setActiveId(next.items[0].id);
          } else if (event.event === "complete" && next.page === 1) {
            const current = payloadRef.current;
            const selected = current?.items.find((row) => row.id === activeIdRef.current);
            if (selected && !next.items.some((row) => row.id === selected.id)) {
              pinnedActiveRef.current = selected;
              setPinnedActive(selected);
            }
            payloadRef.current = next;
            setPayload(next);
            const restoreId = restoreActiveIdRef.current;
            if (restoreId && next.items.some((row) => row.id === restoreId)) { setActiveId(restoreId); restoreActiveIdRef.current = ""; }
            else if (!restoreId && next.items[0] && !next.items.some((row) => row.id === activeIdRef.current) && !selected && pinnedActiveRef.current?.id !== activeIdRef.current) setActiveId(next.items[0].id);
          } else if ((event.event === "page" || event.event === "complete") && next.page > 1) {
            const current = payloadRef.current;
            const merged = current ? { ...next, items: mergeRecordRowsById(current.items, next.items) } : next;
            payloadRef.current = merged;
            setPayload(merged);
            if (pendingNextRef.current && next.items[0]) setActiveId(next.items[0].id);
            pendingNextRef.current = false;
          }
          if (event.event === "page" || event.event === "complete") {
            loadingPageRef.current = false;
            setLoadingMore(false);
          }
        };
        while (true) {
          const { value, done } = await reader.read();
          buffer += value ? decoder.decode(value, { stream: !done }) : decoder.decode();
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line) applyEvent(JSON.parse(line));
            newline = buffer.indexOf("\n");
          }
          if (done) break;
        }
        if (buffer.trim()) applyEvent(JSON.parse(buffer));
        if (!cancelled && (!receivedTerminalEvent || !receivedTerminalPayload)) throw new Error("The search ended before it returned complete results.");
        if (!cancelled) { loadingPageRef.current = false; setLoadingMore(false); }
      } catch (error) {
        if (!cancelled) {
          const message = timedOut ? "The search timed out. Retry to load the messages again." : error instanceof Error ? error.message : "The search failed. Retry to load the messages again.";
          if (!timedOut && (error as Error).name !== "AbortError") console.error(error);
          setSearchError(message);
          loadingPageRef.current = false;
          setLoadingMore(false);
        }
      } finally {
        window.clearTimeout(requestTimeout);
      }
    }, query ? 180 : 0);
    return () => { cancelled = true; controller.abort(); window.clearTimeout(timer); window.clearTimeout(requestTimeout); };
  }, [query, stratum, ctpLabel, sidebarSection, signal, presidioOnly, matchMode, corefMinMentions, corefMinRate, page, statusMode, statusFilters, annotationFilters, possibleHarmFilter, activeProfileId, activeProfile.name, annotationFiltersActive, annotationSnapshotReady, browseListId, browseListRecordIds, hydrated, viewStateReady, searchIncludedIds, searchExclusions, searchRetry, reviewFilterSignature]);

  const active = payload?.items.find((row) => row.id === activeId) ?? (pinnedActive?.id === activeId ? pinnedActive : payload?.items[0]);
  const messageLlmAnnotation = active ? sharedAnnotations.llmAnnotations[active.id] : undefined;
  const messageHumanAnnotation = active ? sharedAnnotations.humanAnnotations[active.id]?.[activeProfile.name] ?? humanLocalAnnotations[active.id] : undefined;
  const messageHumanAnnotations = useMemo(() => active ? {
    ...(activeAllHumanAnnotations[active.id] ?? {}),
    ...(activeHumanAnnotations[active.id] ?? {}),
    ...(humanLocalAnnotations[active.id] ? { [activeProfile.name]: humanLocalAnnotations[active.id] } : {}),
  } : {}, [active?.id, activeAllHumanAnnotations, activeHumanAnnotations, humanLocalAnnotations, activeProfile.name]);
  const messageHumanAnnotatorNames = useMemo(() => {
    const names = new Set(Object.entries(messageHumanAnnotations).filter(([, annotation]) => hasAnnotation(annotation)).map(([name]) => name));
    names.add(activeProfile.name);
    return [...names].sort((left, right) => left === activeProfile.name ? -1 : right === activeProfile.name ? 1 : left.localeCompare(right));
  }, [messageHumanAnnotations, activeProfile.name]);
  const displayedHumanAnnotator = messageHumanAnnotatorNames.includes(selectedHumanAnnotator) ? selectedHumanAnnotator : activeProfile.name;
  const displayedHumanAnnotation = messageHumanAnnotations[displayedHumanAnnotator];
  useEffect(() => { setSelectedHumanAnnotator(activeProfile.name); }, [activeProfileId, activeProfile.name]);
  useEffect(() => {
    if (!messageHumanAnnotatorNames.includes(selectedHumanAnnotator)) setSelectedHumanAnnotator(activeProfile.name);
  }, [messageHumanAnnotatorNames, selectedHumanAnnotator, activeProfile.name]);
  const messageAgreement = messageAnnotationAgreement(messageLlmAnnotation, messageHumanAnnotation);
  const messageHumanAgreement = pairwiseAnnotationAgreement(
    Object.values(messageHumanAnnotations).filter(hasAnnotation),
    messageAnnotationAgreement,
  );
  const visibleRows = useMemo(() => {
    // Status searches already constrain the server query to these indexed IDs.
    // Keep the request's ID snapshot so a concurrent annotation refresh cannot
    // hide rows returned by that request before its replacement search finishes.
    if (isReviewStatusMode(statusMode)) {
      return filterRowsByReviewSnapshot(payload?.items ?? [], statusMode, payload?.reviewStatusIds, reviewFilterIds);
    }
    return (payload?.items ?? []).filter((row) => statusMode === "todo" ? !hasAnnotation(annotations[row.id]) : true);
  }, [payload, annotations, statusMode, reviewFilterIds]);
  useEffect(() => {
    if (!activeId || !listRef.current) return;
    const selected = Array.from(listRef.current.querySelectorAll<HTMLElement>(".conversation-card"))
      .find((row) => row.dataset.recordId === activeId);
    selected?.scrollIntoView({ block: "nearest" });
    if (pendingQueueFocusRef.current && selected) {
      pendingQueueFocusRef.current = false;
      selected.focus({ preventScroll: true });
    }
  }, [activeId]);
  const activeContext = active?.context;
  useEffect(() => {
    if (pendingReferentScroll === null || !activeContext) return;
    let frame = 0;
    let attempts = 0;
    let cancelled = false;
    const findAndScroll = () => {
      if (cancelled) return;
      const content = document.querySelector<HTMLElement>(".conversation-content");
      const target = content?.querySelector<HTMLElement>(`[data-referent-index="${pendingReferentScroll.index}"][data-possible-harm="true"]`)
        ?? content?.querySelector<HTMLElement>("[data-possible-harm='true']");
      if (content && target) {
        const contentRect = content.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const top = content.scrollTop + targetRect.top - contentRect.top - (content.clientHeight - targetRect.height) / 2;
        content.scrollTo({ top, behavior: "smooth" });
        setPendingReferentScroll(null);
        return;
      }
      attempts += 1;
      if (attempts < 30) frame = window.requestAnimationFrame(findAndScroll);
      else setPendingReferentScroll(null);
    };
    frame = window.requestAnimationFrame(findAndScroll);
    return () => { cancelled = true; window.cancelAnimationFrame(frame); };
  }, [active?.id, activeContext, pendingReferentScroll]);
  useEffect(() => {
    if (!active || active.context) {
      setContextLoadingId("");
      setContextError("");
      setContextErrorId("");
      return;
    }
    const recordId = active.id;
    const controller = new AbortController();
    let cancelled = false;
    let timedOut = false;
    const requestTimeout = window.setTimeout(() => {
      timedOut = true;
      setContextErrorId(recordId);
      setContextError("Loading conversation timed out. Retry to load it again.");
      controller.abort();
    }, 45_000);
    setContextLoadingId(recordId);
    setContextError("");
    setContextErrorId(recordId);
    void fetch(`/api/context?recordId=${encodeURIComponent(recordId)}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const result = await response.json() as { context?: ContextTurn[]; error?: string };
        if (!response.ok || !Array.isArray(result.context)) throw new Error(result.error || "Could not load conversation context.");
        if (cancelled) return;
        setPayload((current) => current ? { ...current, items: current.items.map((row) => row.id === recordId ? { ...row, context: result.context } : row) } : current);
        setPinnedActive((current) => current?.id === recordId ? { ...current, context: result.context } : current);
      })
      .catch((error) => {
        if (!cancelled && ((error as Error).name !== "AbortError" || timedOut)) {
          setContextErrorId(recordId);
          setContextError(timedOut ? "Loading conversation timed out. Retry to load it again." : error instanceof Error ? error.message : "Could not load conversation context.");
        }
      })
      .finally(() => {
        window.clearTimeout(requestTimeout);
        if (!cancelled) setContextLoadingId("");
      });
    return () => { cancelled = true; window.clearTimeout(requestTimeout); controller.abort(); };
  }, [active?.id, active?.context, contextRetry]);
  const selectedLlmHistory = annotationSource === "llm" && llmHistoryRecordId === active?.id ? llmHistoryVersions.find((version) => version.id === selectedLlmHistoryId) : undefined;
  const currentAnnotation = active ? selectedLlmHistory?.annotation ?? (annotationSource === "human" ? displayedHumanAnnotation : annotations[active.id]) ?? {} : {};
  const readOnlyHumanView = annotationSource === "human" && displayedHumanAnnotator !== activeProfile.name;
  const currentLlmCreatedAt = annotationSource === "llm" ? selectedLlmHistory?.createdAt ?? currentAnnotation.llmAnnotatedAt ?? currentAnnotation.updatedAt : undefined;
  useEffect(() => { setLlmHistoryOpen(false); setLlmHistoryRecordId(""); setLlmHistoryVersions([]); setSelectedLlmHistoryId(""); setLlmHistoryError(""); }, [active?.id]);
  const currentRelevance = currentAnnotation.relevance ?? currentAnnotation.decision;
  const compareWithHuman = annotationSource === "llm" && Boolean(messageHumanAnnotation);
  const humanRelevance = messageHumanAnnotation?.relevance ?? messageHumanAnnotation?.decision;
  const relevanceDiffers = Boolean(compareWithHuman && currentRelevance && humanRelevance && currentRelevance !== humanRelevance);
  const domainsDiffer = Boolean(compareWithHuman && Array.isArray(currentAnnotation.domains) && Array.isArray(messageHumanAnnotation?.domains) && !sameStringSet(currentAnnotation.domains, messageHumanAnnotation.domains));
  const purposesDiffer = Boolean(compareWithHuman && Array.isArray(currentAnnotation.purposes) && Array.isArray(messageHumanAnnotation?.purposes) && !sameStringSet(currentAnnotation.purposes, messageHumanAnnotation.purposes));
  const domainDifference = domainsDiffer ? multisetDifference(currentAnnotation.domains!, messageHumanAnnotation!.domains!) : { leftOnly: [], rightOnly: [] };
  const purposeDifference = purposesDiffer ? multisetDifference(currentAnnotation.purposes!, messageHumanAnnotation!.purposes!) : { leftOnly: [], rightOnly: [] };
  const hasComparableReferents = Boolean(compareWithHuman && Array.isArray(currentAnnotation.referents) && Array.isArray(messageHumanAnnotation?.referents));
  const referentPairing = matchReferentsByMention(currentAnnotation.referents ?? [], messageHumanAnnotation?.referents ?? []);
  const llmReferents = currentAnnotation.referents ?? [];
  const humanReferents = messageHumanAnnotation?.referents ?? [];
  const referentTypeDifference = hasComparableReferents
    ? multisetDifference(llmReferents.map((item) => item.type || "Type not set"), humanReferents.map((item) => item.type || "Type not set"), normalizeAnnotationText)
    : { leftOnly: [], rightOnly: [] };
  const referentClassificationDifference = hasComparableReferents
    ? multisetDifference(
      llmReferents.map((item) => `${item.type || "Type not set"} · ${item.identifiability || "Identifiability not set"}`),
      humanReferents.map((item) => `${item.type || "Type not set"} · ${item.identifiability || "Identifiability not set"}`),
      normalizeAnnotationText,
    )
    : { leftOnly: [], rightOnly: [] };
  const referentsDiffer = Boolean(hasComparableReferents && !sameReferentClassifications(currentAnnotation.referents ?? [], messageHumanAnnotation?.referents ?? []));
  const conversationSignals = active ? signalLabels(active.screening.conversation) : [];
  const turnSignals = active ? [...signalLabels(active.screening.target), ...(active.screening.target.personReference ? ["Person-reference heuristic"] : [])] : [];
  const exampleGroups = active ? [
    { label: "Person names", items: active.screening.names },
    { label: "Person nouns", items: active.screening.nouns },
    { label: "Prescreen pronouns", items: active.screening.pronouns },
    { label: "Coreference mentions", items: active.screening.coreferenceMentions },
  ] : [];
  const targetPrescreenExamples = active ? [...active.screening.names, ...active.screening.nouns, ...active.screening.pronouns, ...active.screening.coreferenceMentions].map((item) => item.text) : [];
  const fullyAnnotatedCount = Object.values(annotations).filter((item) => isFullyAnnotated(item)).length;
  const partiallyAnnotatedCount = Object.values(annotations).filter((item) => isPartiallyAnnotated(item)).length;
  const reviewedCount = fullyAnnotatedCount + partiallyAnnotatedCount;
  const statusScopeDescription = statusMode === "todo" ? "not reviewed"
    : statusMode === "partial" ? "LLM annotated (partially)"
      : statusMode === "full" ? "LLM annotated (fully)"
        : statusMode === "llm_human" ? `LLM + ${activeProfile.name} annotated`
          : statusMode.startsWith("llm_human:") ? `LLM + ${statusMode.slice("llm_human:".length)} annotated`
            : statusMode.startsWith("human:") ? `${statusMode.slice("human:".length)} annotated (partial or full)`
              : statusMode === "llm_all_humans" ? "LLM + all humans annotated"
                : statusMode === "human_2plus" ? "at least two humans annotated" : "";
  const scopeDescription = isReviewStatusMode(statusMode)
    ? statusScopeDescription || "annotated messages"
    : "first messages with ≥90% English share";
  const index = active && payload ? payload.items.findIndex((row) => row.id === active.id) : 0;
  const hasMore = !!payload && payload.complete && payload.items.length > 0 && payload.items.length < payload.total;
  const historyVersions = useMemo<HistoryVersion[]>(() => {
    const versions: HistoryVersion[] = historyRuns.map((run) => ({ key: `llm-run:${run.id}`, label: `LLM · ${new Date(run.startedAt).toLocaleString()}`, source: "llm", annotations: Object.fromEntries(run.items.map((item) => [item.recordId, item.annotation])), prompts: run.prompts, startedAt: run.startedAt }));
    if (Object.keys(historyCurrentAnnotations.llm).length) versions.unshift({ key: "llm-current", label: "LLM · current annotations", source: "llm", annotations: historyCurrentAnnotations.llm });
    const humanNames = [...new Set(Object.values(historyCurrentAnnotations.humans).flatMap((byAnnotator) => Object.keys(byAnnotator)))].sort((left, right) => left.localeCompare(right));
    for (const name of humanNames) {
      const annotations = Object.fromEntries(Object.entries(historyCurrentAnnotations.humans).flatMap(([recordId, byAnnotator]) => byAnnotator[name] ? [[recordId, byAnnotator[name]] as const] : []));
      versions.push({ key: `human:${name}`, label: `Human · ${name} (${Object.keys(annotations).length})`, source: "human", annotations });
    }
    return versions;
  }, [historyRuns, historyCurrentAnnotations]);
  const compareFromVersion = historyVersions.find((version) => version.key === historyCompareFrom) ?? null;
  const compareToVersion = historyVersions.find((version) => version.key === historyCompareTo) ?? null;
  const comparedHistoryItems = useMemo<HistoryComparisonItem[]>(() => {
    if (!compareFromVersion || !compareToVersion || compareFromVersion.key === compareToVersion.key) return [];
    return Object.entries(historyMessages).map(([recordId, message]) => ({ recordId, ...message, previous: compareFromVersion.annotations[recordId] ?? null, annotation: compareToVersion.annotations[recordId] ?? null }));
  }, [compareFromVersion, compareToVersion, historyMessages]);
  const comparedScoredItems = comparedHistoryItems.filter((item) => comparableHistoryCategories(item).some((category) => category !== "Notes"));
  const comparedChangedItems = comparedScoredItems.filter((item) => changedAnnotationCategories(item).length > 0);
  const comparedPromptEdits = compareFromVersion?.prompts && compareToVersion?.prompts ? [...ANNOTATION_PROMPT_DIMENSIONS.filter((dimension) => compareFromVersion.prompts?.[dimension.key] !== compareToVersion.prompts?.[dimension.key]).map((dimension) => dimension.label), ...((compareFromVersion.prompts.personReferenceCriteria ?? compareFromVersion.prompts.personReferencePrompt ?? compareFromVersion.prompts.relevancePrompt) !== (compareToVersion.prompts.personReferenceCriteria ?? compareToVersion.prompts.personReferencePrompt ?? compareToVersion.prompts.relevancePrompt) ? ["Referent eligibility criteria"] : [])] : [];
  const downloadHistoryComparisonCsv = async () => {
    if (!historyList || !compareFromVersion || compareFromVersion.source !== "llm" || !compareToVersion || compareToVersion.source !== "human") return;
    const columns = ["row_type", "list_name", "llm_version", "llm_run_started_at", "human_reviewer", "conversation_id", "record_id", "requester_turn_index", "requester_message", "comparison_status", "different_categories", "notes_differ", "llm_contains_ctps", "human_contains_ctps", "llm_domains", "human_domains", "llm_referents", "human_referents", "llm_identifiability", "human_identifiability", "llm_purposes", "human_purposes", "llm_note", "human_note", "llm_updated_at", "human_updated_at", "llm_annotated_at", "human_annotated_at", "category", "statistic", "value", "prompt_version", "prompt_dimension", "prompt_base", "prompt_full"];
    const rows: string[][] = [columns];
    const addRow = (cells: Record<string, string | number | boolean | undefined>) => rows.push(columns.map((column) => String(cells[column] ?? "")));
    const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const json = (value: unknown) => value === undefined ? "" : JSON.stringify(value);
    const humanName = compareToVersion.label.replace(/^Human · /, "").replace(/ \(\d+\)$/, "");
    const metadata = { list_name: historyList.name, llm_version: compareFromVersion.label, llm_run_started_at: compareFromVersion.startedAt, human_reviewer: humanName };
    const promptVersion = compareFromVersion.prompts?.promptVersion ?? "legacy or unavailable";
    addRow({ ...metadata, row_type: "comparison_metadata", prompt_version: promptVersion, statistic: "Conversations in list", value: comparedHistoryItems.length });
    const comparable = comparedScoredItems;
    addRow({ ...metadata, row_type: "comparison_statistic", statistic: "Conversations with comparable fields", value: comparable.length });
    addRow({ ...metadata, row_type: "comparison_statistic", statistic: "Conversations with differences", value: comparedChangedItems.length });
    addRow({ ...metadata, row_type: "comparison_statistic", statistic: "Missing LLM annotations", value: comparedHistoryItems.filter((item) => !item.previous).length });
    addRow({ ...metadata, row_type: "comparison_statistic", statistic: "Missing human annotations", value: comparedHistoryItems.filter((item) => !item.annotation).length });
    addRow({ ...metadata, row_type: "comparison_statistic", statistic: "Conversations excluded for missing comparison fields", value: comparedHistoryItems.filter((item) => !comparableHistoryCategories(item).some((category) => category !== "Notes")).length });
    for (const category of HISTORY_COMPARISON_CATEGORIES) {
      const categoryComparable = comparedHistoryItems.filter((item) => comparableHistoryCategories(item).includes(category));
      const changed = categoryComparable.filter((item) => changedAnnotationCategories(item).includes(category)).length;
      addRow({ ...metadata, row_type: "category_statistic", category, statistic: "Conversations that differ", value: `${changed}/${categoryComparable.length}` });
      addRow({ ...metadata, row_type: "category_statistic", category, statistic: "Percent that differ", value: categoryComparable.length ? `${(changed / categoryComparable.length * 100).toFixed(1)}%` : "Not available" });
    }
    for (const item of comparedHistoryItems) {
      const llm = item.previous;
      const human = item.annotation;
      const changed = changedAnnotationCategories(item);
      const notesDiffer = changedHistoryCategories(item).includes("Notes");
      const fields = comparableHistoryCategories(item).filter((category) => category !== "Notes");
      addRow({ ...metadata, row_type: "conversation_comparison", conversation_id: item.conversationId, record_id: item.recordId, requester_turn_index: item.turnIndex + 1, requester_message: item.messageText, comparison_status: !llm && !human ? "no annotations" : !llm ? "missing LLM annotation" : !human ? "missing human annotation" : !fields.length ? "incomplete annotation; excluded from score" : changed.length ? "differs" : notesDiffer ? "notes differ" : "matches", different_categories: changed.join("; "), notes_differ: notesDiffer, llm_contains_ctps: llm?.relevance ?? llm?.decision, human_contains_ctps: human?.relevance ?? human?.decision, llm_domains: json(llm?.domains), human_domains: json(human?.domains), llm_referents: json(llm?.referents), human_referents: json(human?.referents), llm_identifiability: json(llm?.referents?.map((item) => ({ mention: item.mention, identifiability: item.identifiability }))), human_identifiability: json(human?.referents?.map((item) => ({ mention: item.mention, identifiability: item.identifiability }))), llm_purposes: json(llm?.purposes), human_purposes: json(human?.purposes), llm_note: llm?.note, human_note: human?.note, llm_updated_at: llm?.updatedAt, human_updated_at: human?.updatedAt, llm_annotated_at: llm?.llmAnnotatedAt, human_annotated_at: human?.llmAnnotatedAt });
    }
    const personReferenceCriteriaSnapshot = compareFromVersion.prompts?.personReferenceCriteria ?? compareFromVersion.prompts?.personReferencePrompt ?? compareFromVersion.prompts?.relevancePrompt;
    addRow({ ...metadata, prompt_version: promptVersion, row_type: "prompt", prompt_dimension: "Referent eligibility criteria", prompt_base: personReferenceCriteriaSnapshot || "Not stored for this LLM version", prompt_full: personReferenceCriteriaSnapshot || "Not stored for this LLM version" });
    for (const dimension of ANNOTATION_PROMPT_DIMENSIONS) {
      const promptBase = compareFromVersion.prompts?.[dimension.key] ?? "";
      addRow({ ...metadata, prompt_version: promptVersion, row_type: "prompt", prompt_dimension: dimension.label, prompt_base: promptBase || "Not stored for this LLM version", prompt_full: promptBase || "Not stored for this LLM version" });
    }
    const content = `\uFEFF${rows.map((row) => row.map(quote).join(",")).join("\r\n")}`;
    const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `comparison-${historyList.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };
  const stabilityMetrics = useMemo(() => stabilityResult ? stabilitySummary(stabilityResult) : null, [stabilityResult]);
  const stabilityDiagnosticMetrics = useMemo(() => stabilityResult ? stabilityDiagnosticSummary(stabilityResult) : null, [stabilityResult]);
  const clearQueueSearch = () => {
    setPage(1);
    setSelectedIds([]);
    selectionAnchorRef.current = "";
    searchJobRef.current = "";
    payloadRef.current = null;
    setPayload(null);
    setActiveId("");
    setPinnedActive(null);
    pinnedActiveRef.current = null;
    setPinnedQueueIndex(0);
    setSearchError("");
    setLoadingMore(false);
    loadingPageRef.current = false;
    pendingNextRef.current = false;
    listRef.current?.scrollTo({ top: 0 });
  };

  const retrySearch = () => {
    clearQueueSearch();
    setSearchRetry((current) => current + 1);
  };

  useEffect(() => {
    setPage(1);
    setSelectedIds([]);
    selectionAnchorRef.current = "";
    searchJobRef.current = "";
    payloadRef.current = null;
    setPayload(null);
    setSearchError("");
    if (pinnedActiveRef.current?.id !== activeIdRef.current) setActiveId("");
    setLoadingMore(false);
    loadingPageRef.current = false;
    pendingNextRef.current = false;
    listRef.current?.scrollTo({ top: 0 });
  }, [query, stratum, signal, statusFilters, presidioOnly, matchMode, corefMinMentions, corefMinRate, activeProfileId, annotationFilters, possibleHarmFilter, browseListRecordIds, includedIdsKey, exclusionsKey, reviewFilterSignature]);
  const loadNextPage = useCallback(() => {
    if (!hasMore || searchError || loadingPageRef.current) return;
    loadingPageRef.current = true;
    setLoadingMore(true);
    setPage((current) => current + 1);
  }, [hasMore, searchError]);
  useEffect(() => {
    const target = restoreActiveIdRef.current;
    if (!target || !payload) return;
    if (payload.items.some((row) => row.id === target)) { setActiveId(target); restoreActiveIdRef.current = ""; return; }
    if (payload.complete && hasMore) loadNextPage();
    else if (payload.complete && !hasMore) { restoreActiveIdRef.current = ""; if (payload.items[0]) setActiveId(payload.items[0].id); }
  }, [payload, hasMore, loadNextPage]);
  useEffect(() => {
    const root = listRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel || !hasMore) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadNextPage();
    }, { root, rootMargin: "360px 0px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadNextPage, loadingMore]);
  useEffect(() => { try { setPrescreenHighlights(localStorage.getItem("wildchat-prescreen-highlights-v1") === "on" && localStorage.getItem("wildchat-signal-highlights-v1") !== "off"); setHeuristicHighlights(localStorage.getItem("wildchat-heuristic-highlights-v1") === "on"); setAnnotationHighlights(localStorage.getItem("wildchat-annotation-highlights-v1") === "on"); } catch { /* the defaults remain disabled for this session */ } }, []);
  useEffect(() => {
    let cancelled = false;
    const loadAgreement = async () => {
      try {
        const [humanResponse, llmResponse] = await Promise.all([
          fetch("/api/annotations?agreement=true&frame=english_ge_90", { cache: "no-store" }),
          fetch("/api/annotations?agreement=llm-human&frame=english_ge_90", { cache: "no-store" }),
        ]);
        if (humanResponse.ok && !cancelled) setAgreementSummary(await humanResponse.json());
        if (llmResponse.ok && !cancelled) setLlmHumanAgreement(await llmResponse.json());
      } catch { /* Keep the latest known agreement visible during a temporary connection failure. */ }
    };
    void loadAgreement();
    const timer = window.setInterval(() => void loadAgreement(), 15_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);
  useLayoutEffect(() => {
    if (!active || (window.matchMedia("(max-width: 850px)").matches && !mobileReading)) return;
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        if (!revealFirstSearchMatch(query)) revealTarget();
      });
    });
    return () => { window.cancelAnimationFrame(firstFrame); window.cancelAnimationFrame(secondFrame); };
  }, [active?.id, mobileReading, query]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "s") { event.preventDefault(); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); searchRef.current?.focus(); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a" && !isTyping(event.target) && !document.querySelector("[role=dialog]")) { event.preventDefault(); const ids = visibleRows.map((row) => row.id); setSelectedIds(ids); selectionAnchorRef.current = ids[0] ?? ""; return; }
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && active) { event.preventDefault(); chooseRelevance("yes"); }
      if (!event.metaKey && !event.ctrlKey && !event.altKey && !isTyping(event.target)) {
        if (event.key === "1") { event.preventDefault(); chooseRelevance("yes"); }
        if (event.key === "2") { event.preventDefault(); chooseRelevance("no"); }
        if (event.key === "3") { event.preventDefault(); chooseRelevance("uncertain"); }
      }
      if (event.key === "ArrowDown" && !isTyping(event.target)) { event.preventDefault(); move(1); }
      if (event.key === "ArrowUp" && !isTyping(event.target)) { event.preventDefault(); move(-1); }
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
    // move is intentionally defined from current page state below.
  });

  const move = (direction: number) => {
    if (!visibleRows.length) return;
    const currentIndex = visibleRows.findIndex((row) => row.id === activeId);
    const next = currentIndex >= 0 ? currentIndex + direction : pinnedQueueIndex + (direction > 0 ? 0 : -1);
    if (next >= 0 && next < visibleRows.length) { setPinnedActive(null); selectionAnchorRef.current = visibleRows[next].id; pendingQueueFocusRef.current = true; setActiveId(visibleRows[next].id); }
    else if (next >= visibleRows.length && hasMore) { pendingNextRef.current = true; loadNextPage(); }
  };
  const startPanelResize = (panel: "queue" | "detail", event: ReactPointerEvent<HTMLDivElement>) => {
    if (window.innerWidth <= 1150) return;
    event.preventDefault();
    resizeCleanupRef.current?.();
    const startX = event.clientX;
    const startWidth = panel === "queue" ? queueWidth : detailWidth;
    const oldCursor = document.body.style.cursor;
    const oldSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX;
      const leftRailWidth = window.innerWidth > 1200 ? 248 : 0;
      if (panel === "queue") {
        const max = Math.max(230, Math.min(520, window.innerWidth - leftRailWidth - detailWidth - 400));
        setQueueWidth(Math.max(230, Math.min(max, startWidth + delta)));
      } else {
        const max = Math.max(240, Math.min(520, window.innerWidth - leftRailWidth - queueWidth - 400));
        setDetailWidth(Math.max(240, Math.min(max, startWidth - delta)));
      }
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
      document.body.style.cursor = oldCursor;
      document.body.style.userSelect = oldSelect;
      if (resizeCleanupRef.current === cleanup) resizeCleanupRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", cleanup);
    window.addEventListener("pointercancel", cleanup);
    resizeCleanupRef.current = cleanup;
  };
  const resizePanelByKeyboard = (panel: "queue" | "detail", delta: number) => {
    const leftRailWidth = typeof window !== "undefined" && window.innerWidth > 1200 ? 248 : 0;
    if (panel === "queue") {
      const max = Math.max(230, Math.min(520, window.innerWidth - leftRailWidth - detailWidth - 400));
      setQueueWidth((width) => Math.max(230, Math.min(max, width + delta)));
    } else {
      const max = Math.max(240, Math.min(520, window.innerWidth - leftRailWidth - queueWidth - 400));
      setDetailWidth((width) => Math.max(240, Math.min(max, width + delta)));
    }
  };
  const chooseRelevance = (decision: Label) => {
    if (!active || annotationSource === "llm" || (selectedHumanAnnotator && selectedHumanAnnotator !== activeProfile.name)) return;
    setPinnedActive(active);
    if (index >= 0) setPinnedQueueIndex(index);
    update(active.id, decision === "yes"
      ? { relevance: decision, referents: currentAnnotation.referents?.length ? currentAnnotation.referents : [{}] }
      : { relevance: decision });
  };
  const replaceHumanWithCurrentLlm = () => {
    if (!active || annotationSource !== "llm" || !hasAnnotation(currentAnnotation)) return;
    const { llmAnnotatedAt: _llmAnnotatedAt, ...llmFields } = currentAnnotation;
    replaceHumanAnnotation(active.id, { ...llmFields, updatedAt: new Date().toISOString() });
    setCopyLlmConfirmOpen(false);
  };
  const requestLlmToHumanCopy = () => {
    if (!active || annotationSource !== "llm" || !hasAnnotation(currentAnnotation)) return;
    if (messageHumanAnnotation) setCopyLlmConfirmOpen(true);
    else replaceHumanWithCurrentLlm();
  };
  const resetCurrentAnnotation = () => {
    if (!active) return;
    setPinnedActive(active);
    if (index >= 0) setPinnedQueueIndex(index);
    remove(active.id);
  };
  const resetSelectedAnnotations = () => {
    if (!selectedIds.length) return;
    removeMany(selectedIds);
    setSelectedIds([]);
    selectionAnchorRef.current = "";
  };
  const resetShownLlmAnnotations = async () => {
    const ids = visibleRows.map((row) => row.id).filter((id) => Boolean(sharedAnnotations.llmAnnotations[id]));
    setLlmResetMenuOpen(false);
    if (!ids.length || !window.confirm(`Reset the ${ids.length} LLM annotations currently shown in the message list? Saved annotation run history will be kept.`)) return;
    try { await sharedAnnotations.reset("llm", ids); } catch { /* The shared store displays its save error. */ }
  };
  const resetAllLlmAnnotations = async () => {
    setLlmResetMenuOpen(false);
    if (!window.confirm("Reset every shared LLM annotation across the corpus? Saved annotation run history will be kept.")) return;
    try { await sharedAnnotations.resetAllLlm(); } catch { /* The shared store displays its save error. */ }
  };
  const toggleLlmHistory = async () => {
    if (!active) return;
    if (llmHistoryOpen) { setLlmHistoryOpen(false); return; }
    setLlmHistoryOpen(true);
    if (llmHistoryRecordId === active.id) return;
    setLlmHistoryLoading(true);
    setLlmHistoryError("");
    try {
      const response = await fetch(`/api/conversation-lists/history?recordId=${encodeURIComponent(active.id)}`, { cache: "no-store" });
      const result = await response.json() as { versions?: LlmHistoryVersion[]; error?: string };
      if (!response.ok) throw new Error(result.error || "Could not load LLM annotation history.");
      const current = sharedAnnotations.llmAnnotations[active.id];
      const signature = (annotation: Annotation) => JSON.stringify(Object.fromEntries(Object.entries(annotation).filter(([key]) => key !== "updatedAt" && key !== "llmAnnotatedAt")));
      const currentSignature = current ? `${signature(current)}:${current.llmAnnotatedAt ?? current.updatedAt ?? ""}` : "";
      const seen = new Set<string>();
      const versions = (result.versions ?? []).filter((version) => {
        const key = `${signature(version.annotation)}:${version.createdAt}`;
        if (key === currentSignature || seen.has(key)) return false;
        seen.add(key);
        return true;
      }).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      setLlmHistoryVersions(versions);
      setLlmHistoryRecordId(active.id);
      setSelectedLlmHistoryId("");
    } catch (error) {
      setLlmHistoryError(error instanceof Error ? error.message : "Could not load LLM annotation history.");
      setLlmHistoryRecordId(active.id);
      setLlmHistoryVersions([]);
    } finally { setLlmHistoryLoading(false); }
  };
  const exportAnnotations = async (profileId: string | "all") => {
    setExportMenuOpen(false);
    const content = await readForExport(profileId);
    const blob = new Blob([JSON.stringify(content, null, 2)], { type: "application/json" });
    const exportProfile = profiles.find((profile) => profile.id === profileId);
    const name = profileId === "all" ? "all-annotators" : (exportProfile?.name ?? profileId).toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `wildchat-annotations-${name}.json`; link.click(); URL.revokeObjectURL(link.href);
  };
  const openPromptDownloads = async () => {
    setExportMenuOpen(false);
    setPromptDownloadOpen(true);
    setPromptDownloadLoading(true);
    setPromptDownloadError("");
    setPromptDownloadSelected("current");
    setPromptDownloadSearch("");
    try {
      const [currentResponse, historyResponse] = await Promise.all([
        fetch("/api/prompts", { cache: "no-store" }),
        fetch("/api/prompts/history", { cache: "no-store" }),
      ]);
      const [current, history] = await Promise.all([
        currentResponse.json() as Promise<{ prompts?: Record<string, string>; personReferenceCriteria?: string; personReferenceRule?: string; promptVersion?: string; error?: string }>,
        historyResponse.json() as Promise<{ versions?: PromptDownloadVersion[]; error?: string }>,
      ]);
      if (!currentResponse.ok) throw new Error(current.error || "Could not load the current prompts.");
      if (!historyResponse.ok) throw new Error(history.error || "Could not load saved prompt history.");
      setPromptDownloadCurrent({
        prompts: { ...DEFAULT_ANNOTATION_PROMPTS, ...current.prompts },
        personReferenceCriteria: current.personReferenceCriteria ?? DEFAULT_PERSON_REFERENCE_CRITERIA,
        personReferenceRule: current.personReferenceRule ?? PERSON_REFERENCE_RULE,
        promptVersion: current.promptVersion ?? ANNOTATION_PROMPT_VERSION,
      });
      setPromptDownloadVersions(history.versions ?? []);
    } catch (error) {
      setPromptDownloadError(error instanceof Error ? error.message : "Could not load prompt history.");
    } finally { setPromptDownloadLoading(false); }
  };
  const downloadPromptSet = () => {
    const version = promptDownloadVersions.find((item) => item.id === promptDownloadSelected);
    const promptSet = version ?? promptDownloadCurrent;
    if (!promptSet) return;
    const savedAt = version?.savedAt ? new Date(version.savedAt).toLocaleString() : "Current saved prompts";
    const labelRule = version?.personReferenceRule ?? promptSet.personReferenceRule ?? PERSON_REFERENCE_RULE;
    const usesMsd1Label = labelRule.includes("pinned MSD1");
    const lines = [
      "WILDCHAT ANNOTATION PROMPT SET",
      `Snapshot: ${version?.label ?? "Current prompts"}`,
      `Saved: ${savedAt}`,
      `Source: ${version?.source ?? "Current saved prompts"}`,
      `Prompt version: ${version?.promptVersion ?? promptSet.promptVersion ?? ANNOTATION_PROMPT_VERSION}`,
      "",
      usesMsd1Label ? "=== REFERENT ELIGIBILITY CRITERIA ===" : "=== LEGACY CONTAINS CTPS PROMPT ===",
      promptSet.personReferenceCriteria ?? "",
      "",
      usesMsd1Label ? "=== MSD1 CONTAINS CTPS LABEL SOURCE ===" : "=== LEGACY CONTAINS CTPS LABEL RULE ===",
      labelRule,
      ...ANNOTATION_PROMPT_DIMENSIONS.flatMap((dimension) => ["", `=== ${dimension.label.toUpperCase()} PROMPT ===`, promptSet.prompts[dimension.key] ?? ""]),
      "",
    ];
    const slug = (version?.label ?? "current-prompts").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const date = version?.savedAt ? `-${version.savedAt.slice(0, 10)}` : "";
    const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `wildchat-prompts-${slug || "snapshot"}${date}.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const openProfileDialog = (kind: "create" | "rename" | "remove") => {
    setProfileName(kind === "rename" ? activeProfile.name : "");
    setProfileDialogError("");
    setProfileDialog(kind);
    setProfileMenuOpen(false);
  };
  const submitProfileDialog = async () => {
    if (!profileDialog || profileDialogBusy) return;
    setProfileDialogBusy(true);
    setProfileDialogError("");
    try {
      if (profileDialog === "remove") {
        if (!await deleteProfile()) throw new Error("At least one annotator profile must remain.");
      } else {
        const name = profileName.trim();
        if (!name) return;
        if (profileDialog === "create") {
          if (!await createProfile(name)) throw new Error("Could not create the shared annotator profile.");
        }
        if (profileDialog === "rename") {
          const rosterResponse = await fetch("/api/annotators", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ oldName: activeProfile.name, newName: name }) });
          if (!rosterResponse.ok) {
            const result = await rosterResponse.json().catch(() => ({})) as { error?: string };
            throw new Error(result.error || "Could not rename this shared annotator profile.");
          }
          const annotationResponse = await fetch("/api/annotations", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "rename-human", oldName: activeProfile.name, newName: name }) });
          if (!annotationResponse.ok) {
            await fetch("/api/annotators", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ oldName: name, newName: activeProfile.name }) }).catch(() => undefined);
            throw new Error("The profile roster changed, but its annotations could not be renamed. The roster change was rolled back where possible.");
          }
          if (!await renameProfile(name)) throw new Error("Could not update this browser's annotator profile.");
        }
      }
      clearQueueSearch();
      setStatusFilters(browseListId ? [] : ["todo"]);
      setProfileDialog(null);
    } catch (error) {
      setProfileDialogError(error instanceof Error ? error.message : "Could not update the shared annotator profile.");
    } finally {
      setProfileDialogBusy(false);
    }
  };
  const updateReferent = (personIndex: number, patch: Partial<DripReferent>) => {
    if (!active) return;
    const referents = [...(currentAnnotation.referents ?? [])];
    referents[personIndex] = { ...referents[personIndex], ...patch };
    update(active.id, { referents });
  };
  const toggleDripValue = (field: "domains" | "purposes", value: string) => {
    if (!active) return;
    const current = currentAnnotation[field] ?? [];
    update(active.id, { [field]: current.includes(value) ? current.filter((item) => item !== value) : [...current, value] });
  };
  const toggleSignal = (value: string) => setSignal((current) => current.includes(value) ? current.filter((item) => item !== value) : [...current, value]);
  const selectReviewMode = (mode: string) => {
    setSidebarSection("annotations");
    setCtpLabel("");
    if (statusFilters.length === 1 && statusFilters[0] === mode) return;
    clearQueueSearch();
    browseListRequestRef.current += 1;
    setBrowseListId(""); setBrowseListRecordIds([]); setBrowseListError(""); setBrowseListLoading(false);
    setStatusFilters([mode]);
    setStratum("english_ge_90");
  };
  const selectBrowse = () => { setSidebarSection("browse"); clearQueueSearch(); browseListRequestRef.current += 1; setStatusFilters([]); setBrowseListId(""); setBrowseListRecordIds([]); setBrowseListError(""); setBrowseListLoading(false); setCtpLabel(""); setStratum("english_ge_90"); setPage(1); };
  const selectCtpLabel = (label: Exclude<CtpLabel, "">) => {
    setSidebarSection("browse");
    clearQueueSearch();
    browseListRequestRef.current += 1;
    setStatusFilters([]);
    setBrowseListId(""); setBrowseListRecordIds([]); setBrowseListError(""); setBrowseListLoading(false);
    setCtpLabel(label); setStratum("english_ge_90"); setPage(1);
    setPinnedActive(null); pinnedActiveRef.current = null; setActiveId(""); setPinnedQueueIndex(0);
    setAnnotationFilters({ domains: [], referents: [], identifiability: [], purposes: [], harm: [] });
    setPossibleHarmFilter(false);
  };
  const selectAnnotationsSection = () => { setSidebarSection("annotations"); setCtpLabel(""); };
  const toggleAnnotationFilter = (dimension: string, value: string) => {
    const adding = !(annotationFilters[dimension] ?? []).includes(value);
    setAnnotationFilters((current) => ({ ...current, [dimension]: current[dimension]?.includes(value) ? current[dimension].filter((item) => item !== value) : [...(current[dimension] ?? []), value] }));
    if (adding) setStatusFilters((current) => current.length === 1 && current[0] === "todo" ? ["all"] : current);
  };
  const togglePossibleHarmFilter = () => {
    const adding = !possibleHarmFilter;
    setPossibleHarmFilter(adding);
    if (adding) setStatusFilters((current) => current.length === 1 && current[0] === "todo" ? ["all"] : current);
  };
  const filterCount = signal.length + Number(presidioOnly) + Number(Boolean(corefMinMentions || corefMinRate)) + ANNOTATION_FILTER_GROUPS.reduce((total, group) => total + (annotationFilters[group.key]?.length ?? 0), 0) + Number(possibleHarmFilter);
  const signOut = async () => {
    await fetch("/api/auth", { method: "DELETE" });
    window.location.replace("/login");
  };

  const selectQueueRecord = (row: RecordRow, rowIndex: number, event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.shiftKey) {
      const anchorIndex = visibleRows.findIndex((item) => item.id === selectionAnchorRef.current);
      if (anchorIndex >= 0) {
        const start = Math.min(anchorIndex, rowIndex);
        const end = Math.max(anchorIndex, rowIndex);
        setSelectedIds(visibleRows.slice(start, end + 1).map((item) => item.id));
      } else {
        selectionAnchorRef.current = row.id;
        setSelectedIds([row.id]);
      }
      return;
    }
    if (event.metaKey || event.ctrlKey) {
      selectionAnchorRef.current = row.id;
      setSelectedIds((current) => current.includes(row.id) ? current.filter((id) => id !== row.id) : [...current, row.id]);
      return;
    }
    selectionAnchorRef.current = row.id;
    setSelectedIds([]);
    selectRecord(row);
  };
  const selectRecord = (row: RecordRow) => {
    setPinnedActive(row);
    const rowIndex = visibleRows.findIndex((item) => item.id === row.id);
    if (rowIndex >= 0) setPinnedQueueIndex(rowIndex);
    setActiveId(row.id);
    setMobileReading(true);
  };

  const navigateToReferent = (personIndex: number) => {
    setAnnotationHighlights(true);
    referentScrollRequestRef.current += 1;
    setPendingReferentScroll({ index: personIndex, request: referentScrollRequestRef.current });
    try { localStorage.setItem("wildchat-annotation-highlights-v1", "on"); } catch { /* setting remains active for this session */ }
  };

  const openPossibleHarmReferent = (row: RecordRow, event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    selectionAnchorRef.current = row.id;
    setSelectedIds([]);
    selectRecord(row);
    const referentIndex = (annotations[row.id]?.referents ?? []).findIndex((referent) => referent.type === "Named others" && (referent.identifiability === "Directly identifiable" || referent.identifiability === "Indirectly identifiable"));
    if (referentIndex >= 0) navigateToReferent(referentIndex);
  };

  const annotateWithLLM = async (row: RecordRow) => {
    if (singleAnnotationAbortRef.current || llmBusyId || batchRun.active) return;
    const controller = new AbortController();
    singleAnnotationAbortRef.current = controller;
    selectRecord(row);
    setLlmBusyId(row.id);
    setLlmErrors((current) => { const next = { ...current }; delete next[row.id]; return next; });
    try {
      let lastError: Error | null = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const response = await fetch("/api/llm-annotate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ recordId: row.id, reasoningEffort }), signal: controller.signal });
          const result = await readJsonResponse<{ annotation?: Annotation; skipped?: boolean; ctpLabel?: CtpScreeningLabel; error?: string; retryAfterSeconds?: number }>(response);
          if (controller.signal.aborted) return;
          if (response.status === 429) { await delayWithAbort(Math.max(1, result.retryAfterSeconds ?? (Number(response.headers.get("retry-after")) || 1)) * 1000, controller.signal); if (controller.signal.aborted) return; attempt -= 1; continue; }
          if (result.skipped && (result.ctpLabel === "no" || result.ctpLabel === "unclear")) {
            showCtpSkippedPopup({ no: result.ctpLabel === "no" ? 1 : 0, unclear: result.ctpLabel === "unclear" ? 1 : 0, unlabeled: 0 });
            return;
          }
          if (!response.ok || !result.annotation) throw new Error(result.error || "LLM annotation failed. Try again.");
          replaceLlm(row.id, result.annotation);
          return;
        } catch (error) {
          if (controller.signal.aborted) return;
          lastError = error instanceof Error ? error : new Error("LLM annotation failed. Check the connection and retry.");
          if (attempt === 2) throw lastError;
          await delayWithAbort(Math.min(8000, 500 * 2 ** attempt), controller.signal);
        }
      }
      throw lastError ?? new Error("LLM annotation failed. Try again.");
    } catch (error) {
      setLlmErrors((current) => ({ ...current, [row.id]: error instanceof Error ? error.message : "LLM annotation failed. Check the connection and retry." }));
    } finally {
      if (singleAnnotationAbortRef.current === controller) singleAnnotationAbortRef.current = null;
      setLlmBusyId(null);
    }
  };

  const openRedoComparison = (row: RecordRow) => {
    if (llmBusyId) return;
    const original = sharedAnnotations.llmAnnotations[row.id];
    if (!hasAnnotation(original)) { void annotateWithLLM(row); return; }
    const snapshot: Annotation = { ...original, domains: original.domains ? [...original.domains] : undefined, purposes: original.purposes ? [...original.purposes] : undefined, referents: original.referents?.map((referent) => ({ ...referent })) };
    setRedoComparison({ id: row.id, original: snapshot, proposed: null, loading: false, error: "" });
    selectRecord(row);
  };

  const generateRedoComparison = async () => {
    if (!redoComparison || singleAnnotationAbortRef.current || llmBusyId || batchRun.active) return;
    const recordId = redoComparison.id;
    const controller = new AbortController();
    singleAnnotationAbortRef.current = controller;
    setRedoComparison((current) => current?.id === recordId ? { ...current, proposed: null, loading: true, error: "" } : current);
    setLlmBusyId(recordId);
    try {
      let lastError: Error | null = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const response = await fetch("/api/llm-annotate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ recordId, reasoningEffort }), signal: controller.signal });
          const result = await readJsonResponse<{ annotation?: Annotation; skipped?: boolean; ctpLabel?: CtpScreeningLabel; error?: string; retryAfterSeconds?: number }>(response);
          if (controller.signal.aborted) return;
          if (response.status === 429) { await delayWithAbort(Math.max(1, result.retryAfterSeconds ?? (Number(response.headers.get("retry-after")) || 1)) * 1000, controller.signal); if (controller.signal.aborted) return; attempt -= 1; continue; }
          if (result.skipped && (result.ctpLabel === "no" || result.ctpLabel === "unclear")) {
            showCtpSkippedPopup({ no: result.ctpLabel === "no" ? 1 : 0, unclear: result.ctpLabel === "unclear" ? 1 : 0, unlabeled: 0 });
            setRedoComparison((current) => current?.id === recordId ? { ...current, proposed: null, loading: false, error: `MSD1 labeled this message ${result.ctpLabel === "no" ? "No" : "Unclear"}; it was not re-annotated.` } : current);
            return;
          }
          if (!response.ok || !result.annotation) throw new Error(result.error || "LLM annotation failed. Try again.");
          setRedoComparison((current) => current?.id === recordId ? { ...current, proposed: result.annotation!, loading: false, error: "" } : current);
          return;
        } catch (error) {
          if (controller.signal.aborted) return;
          lastError = error instanceof Error ? error : new Error("LLM annotation failed. Check the connection and retry.");
          if (attempt === 2) throw lastError;
          await delayWithAbort(Math.min(8000, 500 * 2 ** attempt), controller.signal);
        }
      }
      throw lastError ?? new Error("LLM annotation failed. Try again.");
    } catch (error) {
      setRedoComparison((current) => current?.id === recordId ? { ...current, loading: false, error: error instanceof Error ? error.message : "LLM annotation failed." } : current);
    } finally {
      if (singleAnnotationAbortRef.current === controller) singleAnnotationAbortRef.current = null;
      setLlmBusyId(null);
    }
  };

  const closeRedoComparison = () => {
    if (redoComparison?.loading) singleAnnotationAbortRef.current?.abort();
    setRedoComparison(null);
  };
  const acceptRedoAnnotation = () => {
    if (!redoComparison?.proposed) return;
    replaceLlm(redoComparison.id, redoComparison.proposed);
    setRedoComparison(null);
  };

  const cancelSingleAnnotation = () => singleAnnotationAbortRef.current?.abort();

  const loadSharedPrompts = async (dimension: SharedPromptDimension) => {
    setPromptDialog(dimension);
    setPromptLoaded(false);
    setPromptStatus("loading");
    setPromptError("");
    const initialDraft = dimension === "personReference" ? personReferenceCriteria : promptValues[dimension as AnnotationPromptDimension];
    setPromptDraft(initialDraft);
    promptDraftRef.current = initialDraft;
    try {
      const response = await fetch("/api/prompts", { cache: "no-store" });
      if (!response.ok) throw new Error("Could not load shared prompts.");
      const result = await response.json() as { prompts: typeof DEFAULT_ANNOTATION_PROMPTS; personReferenceCriteria?: string };
      const prompts = { ...DEFAULT_ANNOTATION_PROMPTS, ...result.prompts };
      setPromptValues(prompts);
      const referencePrompt = result.personReferenceCriteria ?? DEFAULT_PERSON_REFERENCE_CRITERIA;
      setPersonReferenceCriteria(referencePrompt);
      const loadedDraft = dimension === "personReference" ? referencePrompt : prompts[dimension];
      setPromptDraft(loadedDraft);
      promptDraftRef.current = loadedDraft;
      lastSavedPromptRef.current = loadedDraft;
      setPromptLoaded(true);
      setPromptStatus("saved");
    } catch (error) {
      setPromptStatus("error");
      setPromptError(error instanceof Error ? error.message : "Could not load shared prompts.");
    }
  };

  const persistSharedPrompt = useCallback(async (dimension: SharedPromptDimension, prompt: string) => {
    setPromptStatus("saving");
    setPromptError("");
    try {
      const response = await fetch("/api/prompts", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ dimension, prompt }) });
      const result = await response.json() as { prompts?: typeof DEFAULT_ANNOTATION_PROMPTS; personReferenceCriteria?: string; error?: string };
      if (!response.ok || !result.prompts) throw new Error(result.error ?? "Could not save the shared prompt.");
      const prompts = { ...DEFAULT_ANNOTATION_PROMPTS, ...result.prompts };
      setPromptValues(prompts);
      if (dimension === "personReference") setPersonReferenceCriteria(result.personReferenceCriteria ?? prompt);
      lastSavedPromptRef.current = prompt;
      if (promptDraftRef.current === prompt) setPromptStatus("saved");
      return true;
    } catch (error) {
      if (promptDraftRef.current === prompt) {
        setPromptStatus("error");
        setPromptError(error instanceof Error ? error.message : "Could not save the shared prompt.");
      }
      return false;
    }
  }, []);

  useEffect(() => {
    if (!promptDialog || !promptLoaded || promptDraft === lastSavedPromptRef.current) return;
    const timer = window.setTimeout(() => { void persistSharedPrompt(promptDialog, promptDraft); }, 550);
    return () => window.clearTimeout(timer);
  }, [promptDialog, promptDraft, promptLoaded, persistSharedPrompt]);

  const closePromptEditor = useCallback(async () => {
    if (promptDialog && promptLoaded && promptDraft !== lastSavedPromptRef.current) {
      const saved = await persistSharedPrompt(promptDialog, promptDraft);
      if (!saved) return;
    }
    setPromptDialog(null);
    setPromptLoaded(false);
  }, [promptDialog, promptLoaded, promptDraft, persistSharedPrompt]);

  useEffect(() => {
    if (!promptDialog) return;
    const handleKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); void closePromptEditor(); } };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [promptDialog, closePromptEditor]);

  const sampleSelection = async (unit: SampleUnit, amount: number, seed: string, idsOnly: boolean, requestSignal?: AbortSignal, skipExisting = false, fixedPersonSignalPool = false, selectedCtpLabel: CtpLabel = "") => {
    const includeOnly = !skipExisting && (isReviewStatusMode(statusMode) || annotationFiltersActive);
    const fixedFrame = unit === "embedding_sensitivity" || unit === "embedding_primary" || unit === "embedding_near_verbatim" || unit === "english_ge_90" || unit === "english_ge_80" || unit === "english_ge_50";
    const activeStratum = fixedFrame ? unit : !skipExisting && isReviewStatusMode(statusMode) ? "english_ge_90" : stratum;
    const batchStratum = fixedFrame ? unit : unit === "conversations" ? "conversation_positive" : unit === "paper_first_messages" ? "paper_candidate" : unit === "first_messages" ? "first_message_positive" : "message_positive";
    const params = new URLSearchParams({ action: "sample", q: fixedPersonSignalPool ? "" : query, stratum: fixedPersonSignalPool ? batchStratum : activeStratum, signal: fixedPersonSignalPool ? "all" : signal.join(",") || "all", presidio: fixedPersonSignalPool ? "0" : presidioOnly ? "1" : "0", match: fixedPersonSignalPool ? "all" : matchMode, corefMinMentions: fixedPersonSignalPool ? "0" : corefMinMentions || "0", corefMinRate: fixedPersonSignalPool ? "0" : corefMinRate || "0", unit, n: String(amount), seed });
    if (selectedCtpLabel) params.set("ctpLabel", selectedCtpLabel);
    if (idsOnly) params.set("idsOnly", "1");
    const response = await fetch(`/api/records?${params}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ exclude: skipExisting || fixedPersonSignalPool ? NO_EXCLUSIONS : exclusions, include: skipExisting || fixedPersonSignalPool ? NO_EXCLUSIONS : includedIds, includeOnly: fixedPersonSignalPool ? false : includeOnly }), signal: requestSignal });
    if (!response.ok || !response.body) throw new Error(`Sampling failed (${response.status})`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let result: SampleResult | undefined;
    while (true) {
      const { value, done } = await reader.read();
      buffer += value ? decoder.decode(value, { stream: !done }) : decoder.decode();
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          const event = JSON.parse(line) as { event: string; payload?: SampleResult; error?: string };
          if (event.event === "error") throw new Error(event.error || "Sampling failed");
          if (event.event === "sample") result = event.payload;
        }
        newline = buffer.indexOf("\n");
      }
      if (done) break;
    }
    if (buffer.trim()) {
      const event = JSON.parse(buffer) as { event: string; payload?: SampleResult; error?: string };
      if (event.event === "error") throw new Error(event.error || "Sampling failed");
      if (event.event === "sample") result = event.payload;
    }
    if (!result) throw new Error("The sample did not return any records.");
    return result;
  };

  const downloadSample = async () => {
    const amount = Math.min(5000, Math.max(1, Math.trunc(Number(sampleN) || 1)));
    setSampleLoading(true);
    setSampleError("");
    try {
      const result = await sampleSelection(sampleUnit, amount, sampleSeed, false, undefined, false, false, sampleCtpLabel);
      const blob = new Blob(["\\ufeff", result.csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `wildchat-${sampleUnit}${sampleCtpLabel ? `-ctp-${sampleCtpLabel}` : "-all-ctp-outcomes"}-${amount}-seed-${sampleSeed.trim().replace(/[^a-z0-9_-]+/gi, "-").slice(0, 48) || "sample"}.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setSampleDialogOpen(false);
    } catch (error) {
      setSampleError(error instanceof Error ? error.message : "Could not create the sample.");
    } finally { setSampleLoading(false); }
  };

  const loadConversationLists = async () => {
    setListsLoading(true);
    setListsError("");
    try {
      const response = await fetch("/api/conversation-lists", { cache: "no-store" });
      const result = await response.json() as { lists?: ConversationList[]; error?: string };
      if (!response.ok) throw new Error(result.error || "Could not load conversation lists.");
      setConversationLists(result.lists ?? []);
    } catch (error) { setListsError(error instanceof Error ? error.message : "Could not load conversation lists."); }
    finally { setListsLoading(false); setConversationListsLoaded(true); }
  };

  useEffect(() => { if (hydrated) void loadConversationLists(); }, [hydrated]);

  useEffect(() => {
    if (!hydrated || sidebarSection !== "browse" || ctpCounts) return;
    let cancelled = false;
    const controller = new AbortController();
    setCtpCountsLoading(true);
    setCtpCountsError("");
    void fetch("/api/ctp-screening", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const value = await response.json() as CtpScreeningCounts & { error?: string };
        if (!response.ok) throw new Error(value.error || "Could not load CTP screening counts.");
        if (!value.counts || ![value.counts.yes, value.counts.no, value.counts.unclear].every(Number.isInteger)
            || value.counts.yes + value.counts.no + value.counts.unclear !== value.frameRecords
            || value.frameId !== "english_ge_90" || value.frameRecords !== 308_962) {
          throw new Error("The CTP screening counts do not match the paper frame.");
        }
        if (!cancelled) setCtpCounts(value);
      })
      .catch((error: unknown) => {
        if (!cancelled && (error as Error).name !== "AbortError") setCtpCountsError(error instanceof Error ? error.message : "Could not load CTP screening counts.");
      })
      .finally(() => { if (!cancelled) setCtpCountsLoading(false); });
    return () => { cancelled = true; controller.abort(); };
  }, [hydrated, sidebarSection, ctpCounts]);

  const openConversationLists = () => {
    setListsDialogOpen(true);
    void loadConversationLists();
  };

  const openListEvaluation = () => {
    setEvaluationDialogOpen(true);
    void loadConversationLists();
  };

  const browseConversationList = async (listId: string, listOverride?: ConversationList) => {
    const requestId = ++browseListRequestRef.current;
    setSidebarSection("browse");
    setCtpLabel("");
    setBrowseListId(listId);
    setBrowseListError("");
    setPinnedActive(null); pinnedActiveRef.current = null; setActiveId(""); setPinnedQueueIndex(0);
    if (!listId) { setBrowseListRecordIds([]); setBrowseListLoading(false); return; }
    const list = listOverride ?? conversationLists.find((item) => item.id === listId);
    if (!list) { setBrowseListRecordIds([]); setBrowseListLoading(false); return; }
    setBrowseListRecordIds([]);
    setBrowseListLoading(true);
    setStatusFilters([]);
    setStratum("english_ge_90");
    setAnnotationFilters({ domains: [], referents: [], identifiability: [], purposes: [], harm: [] });
    setPossibleHarmFilter(false);
    try {
      const response = await fetch("/api/conversation-lists/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationIds: list.conversationIds }) });
      const result = await response.json() as { records?: Array<{ recordId: string }>; error?: string };
      if (requestId !== browseListRequestRef.current) return;
      if (!response.ok) throw new Error(result.error || "Could not load this list.");
      const ids = [...new Set((result.records ?? []).map((record) => record.recordId))];
      setBrowseListRecordIds(ids);
      setBrowseListLoading(false);
      if (!ids.length) setBrowseListError("No requester messages from this list are present in the active index.");
    } catch (error) { if (requestId === browseListRequestRef.current) { setBrowseListLoading(false); setBrowseListError(error instanceof Error ? error.message : "Could not load this list."); } }
  };

  useEffect(() => {
    if (!hydrated || !conversationListsLoaded || viewRestoredRef.current) return;
    viewRestoredRef.current = true;
    try {
      const saved = JSON.parse(localStorage.getItem(VIEW_STATE_KEY) || "null") as { query?: unknown; signal?: unknown; matchMode?: unknown; statusFilters?: unknown; sidebarSection?: unknown; ctpLabel?: unknown; presidioOnly?: unknown; corefMinMentions?: unknown; corefMinRate?: unknown; annotationFilters?: unknown; possibleHarmFilter?: unknown; annotationSource?: unknown; browseListId?: unknown; activeId?: unknown; queueWidth?: unknown; detailWidth?: unknown } | null;
      if (saved) {
        if (typeof saved.query === "string") setQuery(saved.query);
        const savedReviewMode = Array.isArray(saved.statusFilters) && typeof saved.statusFilters[0] === "string" && isReviewStatusMode(saved.statusFilters[0]);
        setStratum("english_ge_90");
        if (Array.isArray(saved.signal) && saved.signal.every((value) => typeof value === "string")) setSignal(saved.signal);
        if (saved.matchMode === "any" || saved.matchMode === "all") setMatchMode(saved.matchMode);
        if (Array.isArray(saved.statusFilters) && saved.statusFilters.every((value) => typeof value === "string")) setStatusFilters(saved.statusFilters);
        if (saved.sidebarSection === "browse" || saved.sidebarSection === "annotations") setSidebarSection(saved.sidebarSection);
        if (Array.isArray(saved.statusFilters) && typeof saved.statusFilters[0] === "string" && isReviewStatusMode(saved.statusFilters[0])) setSidebarSection("annotations");
        if (saved.sidebarSection === "browse" && (saved.ctpLabel === "yes" || saved.ctpLabel === "no" || saved.ctpLabel === "unclear")) setCtpLabel(saved.ctpLabel);
        if (typeof saved.presidioOnly === "boolean") setPresidioOnly(saved.presidioOnly);
        if (typeof saved.corefMinMentions === "string") setCorefMinMentions(saved.corefMinMentions);
        if (typeof saved.corefMinRate === "string") setCorefMinRate(saved.corefMinRate);
        if (saved.annotationFilters && typeof saved.annotationFilters === "object") setAnnotationFilters(saved.annotationFilters as Record<string, string[]>);
        if (typeof saved.possibleHarmFilter === "boolean") setPossibleHarmFilter(saved.possibleHarmFilter);
        if (saved.annotationSource === "llm" || saved.annotationSource === "human") setAnnotationSource(saved.annotationSource);
        if (typeof saved.activeId === "string") restoreActiveIdRef.current = saved.activeId;
        if (typeof saved.queueWidth === "number" && Number.isFinite(saved.queueWidth)) setQueueWidth(Math.max(230, Math.min(520, saved.queueWidth)));
        if (typeof saved.detailWidth === "number" && Number.isFinite(saved.detailWidth)) setDetailWidth(Math.max(240, Math.min(520, saved.detailWidth === 285 || saved.detailWidth === 360 ? 400 : saved.detailWidth)));
        const listId = typeof saved.browseListId === "string" ? saved.browseListId : "";
        const list = conversationLists.find((item) => item.id === listId);
        if (list) { void browseConversationList(listId, list).finally(() => setViewStateReady(true)); return; }
      }
    } catch { /* Ignore malformed or unavailable saved view state. */ }
    setViewStateReady(true);
  }, [hydrated, conversationListsLoaded, conversationLists]);

  useEffect(() => {
    if (!viewStateReady || !viewRestoredRef.current) return;
    try { localStorage.setItem(VIEW_STATE_KEY, JSON.stringify({ query, stratum, signal, matchMode, statusFilters, sidebarSection, ctpLabel, presidioOnly, corefMinMentions, corefMinRate, annotationFilters, possibleHarmFilter, annotationSource, browseListId, activeId, queueWidth, detailWidth })); } catch { /* The current view still works if browser storage is unavailable. */ }
  }, [viewStateReady, query, stratum, signal, matchMode, statusFilters, sidebarSection, ctpLabel, presidioOnly, corefMinMentions, corefMinRate, annotationFilters, possibleHarmFilter, annotationSource, browseListId, activeId, queueWidth, detailWidth]);

  const fetchIndexedMessages = async (recordIds: string[]) => {
    const chunks: string[][] = [];
    for (let offset = 0; offset < recordIds.length; offset += 50) chunks.push(recordIds.slice(offset, offset + 50));
    const loaded = await Promise.all(chunks.map(async (ids) => {
      const params = new URLSearchParams({ stratum: "all", signal: "all", page: "1", limit: "50", context: "0", jobId: crypto.randomUUID().replace(/-/g, "") });
      const response = await fetch(`/api/records?${params}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ include: ids, includeOnly: true }) });
      if (!response.ok) throw new Error(`Could not load messages for fully annotated records (${response.status}).`);
      const events = (await response.text()).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { event: string; error?: string; payload?: { items?: RecordRow[] } });
      const failure = events.find((event) => event.event === "error");
      if (failure) throw new Error(failure.error || "Could not load fully annotated messages.");
      const complete = events.find((event) => event.event === "complete");
      if (!complete?.payload?.items) throw new Error("The message index did not return a complete result.");
      return complete.payload.items.map((row) => [row.id, { conversationId: row.sourceConversationId, turnIndex: row.turnIndex, messageText: row.text }] as const);
    }));
    return Object.fromEntries(loaded.flat());
  };

  const openListHistory = async (list: ConversationList, messagesOverride?: Promise<Record<string, HistoryMessage>>) => {
    setEvaluationDialogOpen(false);
    setHistoryList(list);
    setHistoryRuns([]);
    setHistoryCurrentAnnotations({ llm: {}, humans: {} });
    setHistoryMessages({});
    setHistoryError("");
    setHistoryLoading(true);
    try {
      const messagesPromise = messagesOverride ?? (async () => {
        const response = await fetch("/api/conversation-lists/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationIds: list.conversationIds, includeText: true }) });
        if (!response.ok) throw new Error("Could not resolve this list to requester messages.");
        const resolved = await response.json() as { records?: Array<{ recordId: string; conversationId: string; turnIndex: number; messageText?: string }> };
        return Object.fromEntries((resolved.records ?? []).map((record) => [record.recordId, { conversationId: record.conversationId, turnIndex: record.turnIndex, messageText: record.messageText ?? "" }]));
      })();
      const [response, messages] = await Promise.all([
        fetch(`/api/conversation-lists/history?listId=${encodeURIComponent(list.id)}`, { cache: "no-store" }),
        messagesPromise,
      ]);
      const result = await response.json() as { runs?: ListAnnotationRun[]; error?: string };
      if (!response.ok) throw new Error(result.error || "Could not load annotation history.");
      const runs = result.runs ?? [];
      setHistoryRuns(runs);
      setHistoryMessages(messages);
      const ids = Object.keys(messages);
      const currentAnnotations: { llm: Record<string, Annotation>; humans: Record<string, Record<string, Annotation>> } = { llm: {}, humans: {} };
      for (let offset = 0; offset < ids.length; offset += 5000) {
        const annotationResponse = await fetch("/api/annotations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "read", recordIds: ids.slice(offset, offset + 5000), includeHumans: true }) });
        if (!annotationResponse.ok) throw new Error("Could not load current annotations for comparison.");
        const current = await annotationResponse.json() as { llm?: Record<string, Annotation>; humans?: Record<string, Record<string, Annotation>> };
        Object.assign(currentAnnotations.llm, current.llm ?? {});
        Object.assign(currentAnnotations.humans, current.humans ?? {});
      }
      setHistoryCurrentAnnotations(currentAnnotations);
      const humanNames = [...new Set(Object.values(currentAnnotations.humans).flatMap((byAnnotator) => Object.keys(byAnnotator)))].sort((left, right) => left.localeCompare(right));
      setHistoryCompareTo(humanNames.includes(activeProfile.name) ? `human:${activeProfile.name}` : humanNames[0] ? `human:${humanNames[0]}` : "");
      setHistoryCompareFrom(Object.keys(currentAnnotations.llm).length ? "llm-current" : runs.length ? `llm-run:${runs[runs.length - 1].id}` : "");
      setFullHistoryOpen(false);
    } catch (error) { setHistoryError(error instanceof Error ? error.message : "Could not load annotation history."); }
    finally { setHistoryLoading(false); }
  };

  const openFullyAnnotatedEvaluation = (scope: "llm" | "llm-human") => {
    const recordIds = scope === "llm" ? llmReviewIds.full : llmAndAnyHumanIds;
    const list: ConversationList = scope === "llm"
      ? { id: "aggregate-llm-fully-annotated", name: "All LLM Annotated (fully)", conversationIds: [], createdAt: "", updatedAt: "" }
      : { id: "aggregate-llm-and-human-fully-annotated", name: "All LLM + At Least One Human Annotated (fully)", conversationIds: [], createdAt: "", updatedAt: "" };
    void openListHistory(list, fetchIndexedMessages(recordIds));
  };

  const createConversationList = async () => {
    const conversationIds = [...new Set(newListConversationIds.split(/[\s,;]+/).map((id) => id.trim()).filter(Boolean))];
    setListsLoading(true);
    setListsError("");
    try {
      const response = await fetch("/api/conversation-lists", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: newListName, conversationIds }) });
      const result = await response.json() as { list?: ConversationList; error?: string };
      if (!response.ok || !result.list) throw new Error(result.error || "Could not create the conversation list.");
      setConversationLists((current) => [...current, result.list!]);
      setNewListName("");
      setNewListConversationIds("");
    } catch (error) { setListsError(error instanceof Error ? error.message : "Could not create the conversation list."); }
    finally { setListsLoading(false); }
  };

  const addSelectedConversationsToList = async (list: ConversationList) => {
    const selected = new Set(selectedIds);
    const conversationIds = [...new Set((payload?.items ?? []).filter((row) => selected.has(row.id)).map((row) => row.sourceConversationId))];
    if (!conversationIds.length) { setListsError("Select one or more messages in the queue first."); return; }
    setListsLoading(true);
    setListsError("");
    try {
      const response = await fetch("/api/conversation-lists", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: list.id, addConversationIds: conversationIds }) });
      const result = await response.json() as { list?: ConversationList; error?: string };
      if (!response.ok || !result.list) throw new Error(result.error || "Could not add the selected conversations.");
      setConversationLists((current) => current.map((item) => item.id === list.id ? result.list! : item));
      setListsError(`Added ${conversationIds.length} conversation${conversationIds.length === 1 ? "" : "s"} to “${list.name}”.`);
    } catch (error) { setListsError(error instanceof Error ? error.message : "Could not add the selected conversations."); }
    finally { setListsLoading(false); }
  };

  const deleteConversationList = async (list: ConversationList) => {
    setListsLoading(true);
    setListsError("");
    try {
      const response = await fetch(`/api/conversation-lists?id=${encodeURIComponent(list.id)}`, { method: "DELETE" });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "Could not delete the conversation list.");
      setConversationLists((current) => current.filter((item) => item.id !== list.id));
      if (browseListId === list.id) { browseListRequestRef.current += 1; setBrowseListId(""); setBrowseListRecordIds([]); setBrowseListLoading(false); }
    } catch (error) { setListsError(error instanceof Error ? error.message : "Could not delete the conversation list."); }
    finally { setListsLoading(false); }
  };

  const beginRenameList = (list: ConversationList) => { setEditingListId(list.id); setEditingListName(list.name); setListsError(""); };
  const saveConversationListName = async (list: ConversationList) => {
    const name = editingListName.trim();
    if (!name) { setListsError("Enter a name for this list."); return; }
    setListsLoading(true);
    setListsError("");
    try {
      const response = await fetch("/api/conversation-lists", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: list.id, name }) });
      const result = await response.json() as { list?: ConversationList; error?: string };
      if (!response.ok || !result.list) throw new Error(result.error || "Could not rename the conversation list.");
      setConversationLists((current) => current.map((item) => item.id === list.id ? result.list! : item));
      setEditingListId("");
      setEditingListName("");
    } catch (error) { setListsError(error instanceof Error ? error.message : "Could not rename the conversation list."); }
    finally { setListsLoading(false); }
  };

  const beginEditListEntries = (list: ConversationList) => {
    setEditingEntriesListId(list.id);
    setEditingListEntries(list.conversationIds.join("\n"));
    setListIdMatches(null);
    setListIdMissing([]);
    setListsError("");
  };

  const currentEditedListIds = () => [...new Set(editingListEntries.split(/[\s,;]+/).map((id) => id.trim()).filter(Boolean))];

  const inspectEditedListIds = async () => {
    const conversationIds = currentEditedListIds();
    if (!conversationIds.length) { setListsError("Add one or more conversation IDs before checking them."); return; }
    setCheckingListIds(true);
    setListsError("");
    try {
      const response = await fetch("/api/conversation-lists/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationIds, summaryOnly: true }) });
      const result = await response.json() as { matches?: ConversationListIdMatch[]; missingConversationIds?: string[]; error?: string };
      if (!response.ok) throw new Error(result.error || "Could not check these IDs.");
      setListIdMatches(result.matches ?? []);
      setListIdMissing(result.missingConversationIds ?? []);
    } catch (error) { setListsError(error instanceof Error ? error.message : "Could not check these IDs."); }
    finally { setCheckingListIds(false); }
  };

  const saveConversationListEntries = async (list: ConversationList) => {
    const conversationIds = currentEditedListIds();
    setListsLoading(true);
    setListsError("");
    try {
      const response = await fetch("/api/conversation-lists", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: list.id, conversationIds }) });
      const result = await response.json() as { list?: ConversationList; error?: string };
      if (!response.ok || !result.list) throw new Error(result.error || "Could not save the list entries.");
      setConversationLists((current) => current.map((item) => item.id === list.id ? result.list! : item));
      setEditingEntriesListId("");
      setEditingListEntries("");
      setListIdMatches(null);
      setListIdMissing([]);
      if (browseListId === list.id) {
        if (result.list.conversationIds.length) void browseConversationList(list.id, result.list);
        else { browseListRequestRef.current += 1; setBrowseListId(""); setBrowseListRecordIds([]); setBrowseListLoading(false); }
      }
      setListsError(`Saved ${result.list.conversationIds.length} unique conversation ID${result.list.conversationIds.length === 1 ? "" : "s"}.`);
    } catch (error) { setListsError(error instanceof Error ? error.message : "Could not save the list entries."); }
    finally { setListsLoading(false); }
  };

  const openStabilityTest = (list: ConversationList) => {
    setStabilityTarget(list);
    setStabilityRepetitions("10");
    setStabilityResult(null);
    setStabilityProgress({ active: false, preparing: false, completed: 0, total: 0, repetition: 0, failed: 0, error: "", errors: [] });
    setStabilityVisibleCategories(STABILITY_CATEGORIES);
    setStabilityHoveredRepeat(null);
    setListsDialogOpen(false);
    setEvaluationDialogOpen(false);
    setStabilityDialogOpen(true);
  };

  const cancelStabilityTest = () => stabilityAbortRef.current?.abort();

  const runStabilityTest = async () => {
    if (!stabilityTarget || stabilityProgress.active || llmBusyId || batchRun.active) return;
    const repetitions = Math.min(20, Math.max(2, Math.trunc(Number(stabilityRepetitions) || 10)));
    const controller = new AbortController();
    stabilityAbortRef.current = controller;
    const startedAt = new Date().toISOString();
    const runs: StabilityRepeat[] = [];
    const errors: string[] = [];
    let completed = 0;
    let failed = 0;
    setStabilityResult(null);
    setStabilityProgress({ active: true, preparing: true, completed: 0, total: 0, repetition: 0, failed: 0, error: "", errors: [] });
    try {
      const resolveResponse = await fetch("/api/conversation-lists/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationIds: stabilityTarget.conversationIds, includeText: true }), signal: controller.signal });
      const resolved = await resolveResponse.json() as { records?: StabilityRecord[]; error?: string };
      if (!resolveResponse.ok) throw new Error(resolved.error || "Could not resolve the list's conversations.");
      let records = [...new Map((resolved.records ?? []).map((record) => [record.recordId, record])).values()];
      let recordIds = records.map((record) => record.recordId);
      if (!recordIds.length) throw new Error("None of this list's conversation IDs appear in the active index.");
      const screened = await screenCtpRecordIds(recordIds, controller.signal);
      showCtpSkippedPopup(screened);
      recordIds = screened.yesRecordIds;
      const yesRecordIds = new Set(recordIds);
      records = records.filter((record) => yesRecordIds.has(record.recordId));
      if (!recordIds.length) throw new Error("No messages in this list have an MSD1 label of Yes, so GPT-6-Luna was not called.");

      const promptResponse = await fetch("/api/prompts", { cache: "no-store", signal: controller.signal });
      const promptData = await promptResponse.json() as { prompts?: Record<AnnotationPromptDimension, string>; personReferenceCriteria?: string; promptVersion?: string; personReferenceRule?: string; error?: string };
      if (!promptResponse.ok || !promptData.prompts || typeof promptData.personReferenceCriteria !== "string" || ANNOTATION_PROMPT_DIMENSIONS.some(({ key }) => typeof promptData.prompts?.[key] !== "string")) throw new Error(promptData.error || "Could not capture the current prompts.");

      // Freeze the selected reviewer's shared annotations in one snapshot before
      // the first model request. Local IndexedDB annotations fill shared gaps.
      const annotationResponse = await fetch("/api/annotations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "read", recordIds, includeHumans: true }), signal: controller.signal });
      const annotationData = await annotationResponse.json() as { humans?: Record<string, Record<string, Annotation>>; error?: string };
      if (!annotationResponse.ok) throw new Error(annotationData.error || "Could not freeze the human annotation snapshot.");
      records = records.map((record) => ({ ...record, humanAnnotation: annotationData.humans?.[record.recordId]?.[activeProfile.name] ?? profileAnnotations[record.recordId] ?? null }));
      const humanSnapshot = Object.fromEntries(records.map((record) => [record.recordId, record.humanAnnotation]));
      const total = recordIds.length * repetitions;
      setStabilityProgress((state) => ({ ...state, preparing: false, total }));

      for (let repetition = 0; repetition < repetitions && !controller.signal.aborted; repetition += 1) {
        const annotations: Record<string, Annotation> = {};
        const runErrors: Record<string, string> = {};
        const diagnosticAnnotations: Record<string, Annotation> = {};
        const diagnosticErrors: Record<string, string> = {};
        const traces: Record<string, StabilityTrace[]> = {};
        let runSucceeded = 0;
        let runFailed = 0;
        for (let offset = 0; offset < recordIds.length && !controller.signal.aborted; offset += 10) {
          const batch = records.slice(offset, offset + 10);
          const outcomes = await Promise.all(batch.map(async (record) => {
            const collected: StabilityTrace[] = [];
            const requestCondition = async (condition: "end_to_end" | "human_inventory", human?: Annotation) => {
              let attempts = 0;
              while (!controller.signal.aborted) {
                try {
                  const body = condition === "end_to_end"
                    ? { recordId: record.recordId, reasoningEffort, prompts: promptData.prompts, personReferenceCriteria: promptData.personReferenceCriteria, condition, includeDiagnostics: true }
                    : { recordId: record.recordId, reasoningEffort, prompts: promptData.prompts, personReferenceCriteria: promptData.personReferenceCriteria, condition, humanInventory: human?.referents, includeDiagnostics: true };
                  const response = await fetch("/api/llm-annotate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
                  const result = await readJsonResponse<{ annotation?: Annotation; skipped?: boolean; ctpLabel?: CtpScreeningLabel; error?: string; retryAfterSeconds?: number; diagnostics?: Record<string, unknown> }>(response);
                  if (response.status === 429) {
                    const retry = result.retryAfterSeconds ?? (Number(response.headers.get("retry-after")) || 1);
                    await delayWithAbort(Math.max(1, retry) * 1000, controller.signal);
                    continue;
                  }
                  if (result.skipped) return { annotation: undefined, diagnostics: result.diagnostics, error: `MSD1 label changed to ${result.ctpLabel ?? "unavailable"} before the annotation request.` };
                  if (!response.ok || !result.annotation) throw Object.assign(new Error(result.error || `Annotation failed (${response.status}).`), { diagnostics: result.diagnostics });
                  return { annotation: result.annotation, diagnostics: result.diagnostics, error: "" };
                } catch (error) {
                  if (controller.signal.aborted) return { annotation: undefined, diagnostics: undefined, error: "Cancelled." };
                  attempts += 1;
                  if (attempts < 3) { await delayWithAbort(Math.min(8000, 500 * 2 ** (attempts - 1)), controller.signal); continue; }
                  const failure = error instanceof Error ? error : new Error("Annotation failed.");
                  return { annotation: undefined, diagnostics: (failure as Error & { diagnostics?: Record<string, unknown> }).diagnostics, error: failure.message };
                }
              }
              return { annotation: undefined, diagnostics: undefined, error: "Cancelled." };
            };

            const endToEnd = await requestCondition("end_to_end");
            collected.push({ condition: "end_to_end", annotation: endToEnd.annotation, error: endToEnd.error || undefined, diagnostics: endToEnd.diagnostics });
            const human = record.humanAnnotation;
            const humanRelevance = human?.relevance ?? human?.decision;
            const hasHumanInventory = Boolean(humanRelevance === "yes" && Array.isArray(human?.referents) && human.referents.length > 0 && human.referents.every((item) => Boolean(item.mention?.trim() && item.type)));
            const diagnostic = hasHumanInventory
              ? await requestCondition("human_inventory", human!)
              : { annotation: undefined, diagnostics: undefined, error: human ? "Human annotation incomplete: frozen referent inventory unavailable." : "No frozen human annotation; diagnostic condition excluded." };
            if (hasHumanInventory) collected.push({ condition: "human_inventory", annotation: diagnostic.annotation, error: diagnostic.error || undefined, diagnostics: diagnostic.diagnostics });
            return { recordId: record.recordId, endToEnd: endToEnd.annotation, endError: endToEnd.error, diagnostic: diagnostic.annotation, diagnosticError: diagnostic.error, traces: collected };
          }));
          for (const outcome of outcomes) {
            if (!outcome) continue;
            completed += 1;
            traces[outcome.recordId] = outcome.traces;
            if (outcome.endToEnd) { annotations[outcome.recordId] = outcome.endToEnd; runSucceeded += 1; }
            else { failed += 1; runFailed += 1; runErrors[outcome.recordId] = outcome.endError; errors.push(`${outcome.recordId}: ${outcome.endError}`); }
            if (outcome.diagnostic) diagnosticAnnotations[outcome.recordId] = outcome.diagnostic;
            else if (outcome.diagnosticError) diagnosticErrors[outcome.recordId] = outcome.diagnosticError;
          }
          setStabilityProgress((state) => ({ ...state, completed, failed, repetition: repetition + 1, errors: errors.slice(0, 8) }));
        }
        if (runSucceeded || runFailed) runs.push({ annotations, errors: runErrors, diagnosticAnnotations, diagnosticErrors, traces, succeeded: runSucceeded, failed: runFailed });
      }
      if (runs.length) setStabilityResult({ startedAt, completedAt: new Date().toISOString(), repetitions, recordIds, records, reasoningEffort, prompts: promptData.prompts, personReferenceCriteria: promptData.personReferenceCriteria, promptVersion: promptData.promptVersion ?? ANNOTATION_PROMPT_VERSION, personReferenceRule: promptData.personReferenceRule ?? PERSON_REFERENCE_RULE, humanReviewer: activeProfile.name, model: "gpt-6-luna", humanSnapshot, runs, cancelled: controller.signal.aborted } as StabilityResult);
      if (!runs.length && !controller.signal.aborted) throw new Error("The stability run did not produce any annotations.");
      setStabilityProgress((state) => ({ ...state, active: false, preparing: false, completed, failed, repetition: runs.length, errors: errors.slice(0, 8) }));
    } catch (error) {
      setStabilityProgress((state) => ({ ...state, active: false, preparing: false, error: controller.signal.aborted ? "Run cancelled before any results were available." : error instanceof Error ? error.message : "Could not complete the stability run." }));
    } finally { stabilityAbortRef.current = null; }
  };

  const downloadStabilityCsv = () => {
    if (!stabilityResult || !stabilityMetrics) return;
    const columns = ["row_type", "run_started_at", "run_completed_at", "list_name", "repetitions_requested", "repetitions_completed", "model", "prompt_version", "reasoning_effort", "temperature_setting", "human_reviewer", "cancelled", "condition", "record_id", "conversation_id", "requester_turn_index", "requester_message", "source_context_json", "human_annotation_json", "repetition", "request_status", "error", "contains_ctps", "domains", "referents", "identifiability", "purposes", "annotation_json", "stage", "endpoint", "api", "http_status", "stage_error", "request_body_json", "response_json", "statistic", "value", "prompt_dimension", "prompt_text"];
    const rows: string[][] = [columns];
    const addRow = (cells: Record<string, unknown>) => rows.push(columns.map((column) => { const value = cells[column]; return value == null ? "" : typeof value === "string" ? value : JSON.stringify(value); }));
    const csv = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const stringify = (value: unknown) => value === undefined ? "" : JSON.stringify(value);
    const base = { run_started_at: stabilityResult.startedAt, run_completed_at: stabilityResult.completedAt, list_name: stabilityTarget?.name ?? "", repetitions_requested: stabilityResult.repetitions, repetitions_completed: stabilityResult.runs.length, model: stabilityResult.model, prompt_version: stabilityResult.promptVersion, reasoning_effort: stabilityResult.reasoningEffort, temperature_setting: "omitted from provider request", human_reviewer: stabilityResult.humanReviewer, cancelled: stabilityResult.cancelled };
    const pairScore = (annotations: Array<Annotation | undefined>, human: Annotation | null, downstreamOnly = false) => {
      if (!human) return null;
      let matches = 0; let total = 0;
      for (const annotation of annotations) {
        if (!annotation) continue;
        const score = downstreamOnly ? downstreamAnnotationAgreement(annotation, human) : messageAnnotationAgreement(annotation, human);
        if (score) { matches += score.matches; total += score.total; }
      }
      return total ? { matches, total, percent: matches / total * 100 } : null;
    };
    addRow({ ...base, row_type: "run_metadata", statistic: "MSD1 Contains CTPs label source", value: stabilityResult.personReferenceRule });
    addRow({ ...base, row_type: "statistic", condition: "end_to_end", statistic: "Overall pairwise agreement", value: stabilityMetrics.agreement === null ? "Not available" : `${stabilityMetrics.agreement.toFixed(1)}%` });
    addRow({ ...base, row_type: "statistic", condition: "end_to_end", statistic: "Fully stable messages", value: `${stabilityMetrics.stableEntries}/${stabilityMetrics.comparableEntries}` });
    addRow({ ...base, row_type: "statistic", condition: "end_to_end", statistic: "Successful annotations", value: stabilityResult.runs.reduce((sum, run) => sum + run.succeeded, 0) });
    addRow({ ...base, row_type: "statistic", condition: "end_to_end", statistic: "Failed requests", value: stabilityResult.runs.reduce((sum, run) => sum + run.failed, 0) });
    let diagnosticMatches = 0; let diagnosticTotal = 0; let diagnosticMessages = 0;
    for (const record of stabilityResult.records) {
      const score = pairScore(stabilityResult.runs.map((run) => run.diagnosticAnnotations[record.recordId]), record.humanAnnotation ?? null, true);
      if (score) { diagnosticMatches += score.matches; diagnosticTotal += score.total; diagnosticMessages += 1; }
    }
    addRow({ ...base, row_type: "statistic", condition: "human_inventory", statistic: "Downstream agreement against frozen human labels", value: diagnosticTotal ? `${(diagnosticMatches / diagnosticTotal * 100).toFixed(1)}%` : "Not available" });
    addRow({ ...base, row_type: "statistic", condition: "human_inventory", statistic: "Messages with comparable diagnostic outputs", value: diagnosticMessages });
    for (const [condition, categories] of [["end_to_end", STABILITY_CATEGORIES], ["human_inventory", ["Domains", "Identifiability", "Purposes"] as StabilityCategory[]]] as const) {
      for (const category of categories) {
        let matches = 0;
        let comparisons = 0;
        for (const record of stabilityResult.records) {
          const human = record.humanAnnotation;
          if (!human || !hasHistoryCategory(human, category)) continue;
          for (const run of stabilityResult.runs) {
            const annotation = condition === "end_to_end" ? run.annotations[record.recordId] : run.diagnosticAnnotations[record.recordId];
            if (!annotation || !hasHistoryCategory(annotation, category)) continue;
            comparisons += 1;
            if (JSON.stringify(historyCategoryValue(annotation, category)) === JSON.stringify(historyCategoryValue(human, category))) matches += 1;
          }
        }
        addRow({ ...base, row_type: "human_agreement_statistic", condition, category, statistic: `Field agreement with frozen human labels · ${category}`, value: comparisons ? `${(matches / comparisons * 100).toFixed(1)}% (${matches}/${comparisons})` : "No comparable completed fields" });
      }
    }
    for (let throughRepeat = 2; throughRepeat <= stabilityResult.runs.length; throughRepeat += 1) for (const category of STABILITY_CATEGORIES) {
      const value = stabilityAgreement(stabilityResult, category, throughRepeat);
      addRow({ ...base, row_type: "statistic", condition: "end_to_end", repetition: throughRepeat, statistic: `${category} pairwise exact agreement through repetition ${throughRepeat}`, value: value === null ? "Not available" : `${value.toFixed(1)}%` });
    }
    for (const record of stabilityResult.records) {
      const endScore = pairScore(stabilityResult.runs.map((run) => run.annotations[record.recordId]), record.humanAnnotation ?? null);
      const diagnosticScore = pairScore(stabilityResult.runs.map((run) => run.diagnosticAnnotations[record.recordId]), record.humanAnnotation ?? null, true);
      addRow({ ...base, row_type: "record_score", record_id: record.recordId, conversation_id: record.conversationId, requester_turn_index: record.turnIndex + 1, requester_message: record.messageText, human_annotation_json: stringify(record.humanAnnotation), condition: "end_to_end", statistic: "Overall field agreement versus frozen human annotation", value: endScore ? `${endScore.percent.toFixed(1)}% (${endScore.matches}/${endScore.total})` : "Incomplete human annotation; excluded" });
      addRow({ ...base, row_type: "record_score", record_id: record.recordId, conversation_id: record.conversationId, requester_turn_index: record.turnIndex + 1, requester_message: record.messageText, human_annotation_json: stringify(record.humanAnnotation), condition: "human_inventory", statistic: "Downstream field agreement versus frozen human annotation", value: diagnosticScore ? `${diagnosticScore.percent.toFixed(1)}% (${diagnosticScore.matches}/${diagnosticScore.total})` : "Incomplete human annotation; excluded" });
      for (let repetitionIndex = 0; repetitionIndex < stabilityResult.runs.length; repetitionIndex += 1) {
        const run = stabilityResult.runs[repetitionIndex];
        const end = run.annotations[record.recordId];
        const diagnostic = run.diagnosticAnnotations[record.recordId];
        addRow({ ...base, row_type: "annotation", condition: "end_to_end", record_id: record.recordId, conversation_id: record.conversationId, requester_turn_index: record.turnIndex + 1, requester_message: record.messageText, source_context_json: stringify(run.traces[record.recordId]?.find((trace) => trace.condition === "end_to_end")?.diagnostics?.sourceContext), human_annotation_json: stringify(record.humanAnnotation), repetition: repetitionIndex + 1, request_status: end ? "succeeded" : run.errors[record.recordId] ? "failed" : "not_run", error: run.errors[record.recordId], contains_ctps: end?.relevance ?? end?.decision, domains: stringify(end?.domains), referents: stringify(end?.referents), identifiability: stringify(end?.referents?.map((item) => item.identifiability)), purposes: stringify(end?.purposes), annotation_json: stringify(end) });
        addRow({ ...base, row_type: "annotation", condition: "human_inventory", record_id: record.recordId, conversation_id: record.conversationId, requester_turn_index: record.turnIndex + 1, requester_message: record.messageText, human_annotation_json: stringify(record.humanAnnotation), repetition: repetitionIndex + 1, request_status: diagnostic ? "succeeded" : run.diagnosticErrors[record.recordId] ? "excluded_or_failed" : "not_run", error: run.diagnosticErrors[record.recordId], contains_ctps: diagnostic?.relevance ?? diagnostic?.decision, domains: stringify(diagnostic?.domains), referents: stringify(diagnostic?.referents), identifiability: stringify(diagnostic?.referents?.map((item) => item.identifiability)), purposes: stringify(diagnostic?.purposes), annotation_json: stringify(diagnostic) });
        for (const trace of run.traces[record.recordId] ?? []) for (const stage of (trace.diagnostics?.stages as Array<Record<string, unknown>> | undefined) ?? []) addRow({ ...base, row_type: "stage_trace", condition: trace.condition, record_id: record.recordId, conversation_id: record.conversationId, repetition: repetitionIndex + 1, requester_message: record.messageText, source_context_json: stringify(trace.diagnostics?.sourceContext), human_annotation_json: stringify(record.humanAnnotation), stage: stage.stage, endpoint: stage.endpoint, api: stage.api, http_status: stage.httpStatus, stage_error: stage.error, request_body_json: stringify(stage.requestBody), response_json: stringify(stage.responseJson) });
      }
    }
    addRow({ ...base, row_type: "prompt", prompt_dimension: "Referent eligibility criteria", prompt_text: stabilityResult.personReferenceCriteria });
    for (const dimension of ANNOTATION_PROMPT_DIMENSIONS) addRow({ ...base, row_type: "prompt", prompt_dimension: dimension.label, prompt_text: stabilityResult.prompts[dimension.key] });
    const content = `\uFEFF${rows.map((row) => row.map(csv).join(",")).join("\r\n")}`;
    const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `stability-${(stabilityTarget?.name ?? "list").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${stabilityResult.startedAt.slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const openListBatch = (list: ConversationList) => {
    setListBatchTarget(list);
    setListBatchRecordIds(null);
    setBatchRun({ active: false, sampling: false, completed: 0, total: 0, succeeded: 0, failed: 0, skipped: 0, current: 0, startedAt: 0, cancelled: false, error: "", errors: [] });
    setListsDialogOpen(false);
    setEvaluationDialogOpen(false);
    setBatchDialogOpen(true);
  };

  const openAggregateBatch = (scope: "llm" | "llm-human") => {
    const recordIds = scope === "llm" ? llmReviewIds.full : llmAndAnyHumanIds;
    const list: ConversationList = scope === "llm"
      ? { id: "aggregate-llm-fully-annotated", name: "All LLM Annotated (fully)", conversationIds: [], createdAt: "", updatedAt: "" }
      : { id: "aggregate-llm-and-human-fully-annotated", name: "All LLM + At Least One Human Annotated (fully)", conversationIds: [], createdAt: "", updatedAt: "" };
    setListBatchTarget(list);
    setListBatchRecordIds(recordIds);
    setBatchRun({ active: false, sampling: false, completed: 0, total: 0, succeeded: 0, failed: 0, skipped: 0, current: 0, startedAt: 0, cancelled: false, error: "", errors: [] });
    setListsDialogOpen(false);
    setEvaluationDialogOpen(false);
    setBatchDialogOpen(true);
  };

  const runLlmBatch = async (ids: string[], controller: AbortController, warnings: string[] = [], historyRunId = "") => {
    if (!ids.length) throw new Error("This list contains no indexed requester messages.");
    const startedAt = Date.now();
    setBatchRun((state) => ({ ...state, sampling: false, total: ids.length, startedAt }));
    let succeeded = 0;
    let failed = 0;
    let skippedNo = 0;
    let skippedUnclear = 0;
    let skippedUnlabeled = 0;
    let completed = 0;
    let nextIndex = 0;
    const errors: string[] = [...warnings];
    const worker = async () => {
      while (!controller.signal.aborted) {
        const index = nextIndex++;
        if (index >= ids.length) return;
        const recordId = ids[index];
        setBatchRun((state) => ({ ...state, current: Math.max(state.current, index + 1) }));
        let finished = false;
        let attempts = 0;
        while (!finished && !controller.signal.aborted) {
          try {
            const response = await fetch("/api/llm-annotate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ recordId, reasoningEffort }), signal: controller.signal });
            const result = await readJsonResponse<{ annotation?: Annotation; skipped?: boolean; ctpLabel?: CtpScreeningLabel; error?: string; retryAfterSeconds?: number }>(response);
            if (response.status === 429) {
              await delayWithAbort(Math.max(1, (result.retryAfterSeconds ?? Number(response.headers.get("retry-after"))) || 1) * 1000, controller.signal);
              continue;
            }
            if (result.skipped) {
              if (result.ctpLabel === "no") skippedNo += 1;
              else if (result.ctpLabel === "unclear") skippedUnclear += 1;
              else skippedUnlabeled += 1;
              finished = true;
              break;
            }
            if (!response.ok || !result.annotation) throw new Error(result.error || `Annotation failed (${response.status}).`);
            const previous = sharedAnnotations.llmAnnotations[recordId] && Object.keys(sharedAnnotations.llmAnnotations[recordId]).length ? sharedAnnotations.llmAnnotations[recordId] : null;
            replaceLlm(recordId, result.annotation);
            if (historyRunId) {
              try {
                const historyResponse = await fetch("/api/conversation-lists/history", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "result", runId: historyRunId, recordId, previous, annotation: result.annotation }), signal: controller.signal });
                if (!historyResponse.ok) throw new Error("History save failed.");
              } catch (historyError) {
                if (controller.signal.aborted) break;
                errors.push(`${recordId}: annotation saved locally, but the shared history entry could not be saved (${historyError instanceof Error ? historyError.message : "history save failed"}).`);
              }
            }
            succeeded += 1;
            finished = true;
          } catch (error) {
            if (controller.signal.aborted) break;
            attempts += 1;
            if (attempts < 3) { await delayWithAbort(Math.min(8000, 500 * 2 ** (attempts - 1)), controller.signal); continue; }
            failed += 1;
            errors.push(`${recordId}: ${error instanceof Error ? error.message : "Annotation failed."}`);
            finished = true;
          }
        }
        if (finished) {
          completed += 1;
          setBatchRun((state) => ({ ...state, completed, succeeded, failed, skipped: skippedNo + skippedUnclear + skippedUnlabeled, errors: errors.slice(0, 8) }));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(Number(batchConcurrency), ids.length) }, () => worker()));
    if (historyRunId) {
      try {
        await fetch("/api/conversation-lists/history", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "finish", runId: historyRunId, failed, cancelled: controller.signal.aborted }) });
      } catch { errors.push("The run finished, but its shared history could not be marked complete."); }
    }
    setBatchRun((state) => ({ ...state, active: false, sampling: false, completed, succeeded, failed, skipped: skippedNo + skippedUnclear + skippedUnlabeled, cancelled: controller.signal.aborted, errors: errors.slice(0, 8) }));
    showCtpSkippedPopup({ no: skippedNo, unclear: skippedUnclear, unlabeled: skippedUnlabeled });
    if (!controller.signal.aborted && failed === 0) setBatchDialogOpen(false);
  };

  const annotateConversationList = async () => {
    if (!listBatchTarget) return;
    const controller = new AbortController();
    batchAbortRef.current = controller;
    setBatchRun({ active: true, sampling: true, completed: 0, total: 0, succeeded: 0, failed: 0, skipped: 0, current: 0, startedAt: 0, cancelled: false, error: "", errors: [] });
    try {
      let ids: string[];
      let warnings: string[] = [];
      if (listBatchRecordIds) {
        ids = [...listBatchRecordIds];
      } else {
        const response = await fetch("/api/conversation-lists/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationIds: listBatchTarget.conversationIds }), signal: controller.signal });
        const result = await response.json() as { records?: Array<{ recordId: string }>; missingConversationIds?: string[]; error?: string };
        if (!response.ok) throw new Error(result.error || "Could not resolve the list's conversations.");
        if (controller.signal.aborted) return;
        ids = result.records?.map((record) => record.recordId) ?? [];
        warnings = (result.missingConversationIds ?? []).map((id) => `Not found in index: ${id}`);
      }
      if (!ids.length) throw new Error(listBatchRecordIds ? "No matching fully annotated messages are available." : "None of this list's conversation IDs appear in the active index.");
      const screened = await screenCtpRecordIds(ids, controller.signal);
      showCtpSkippedPopup(screened);
      ids = screened.yesRecordIds;
      if (!ids.length) throw new Error("No messages in this selection have an MSD1 label of Yes, so GPT-6-Luna was not called.");
      const promptResponse = await fetch("/api/prompts", { cache: "no-store", signal: controller.signal });
      const promptResult = await promptResponse.json() as { prompts?: Record<string, string>; personReferenceCriteria?: string; promptVersion?: string; personReferenceRule?: string; error?: string };
      if (!promptResponse.ok || !promptResult.prompts || typeof promptResult.personReferenceCriteria !== "string") throw new Error(promptResult.error || "Could not capture the current prompts for history.");
      const historyPrompts = { ...promptResult.prompts, personReferenceCriteria: promptResult.personReferenceCriteria, promptVersion: promptResult.promptVersion ?? ANNOTATION_PROMPT_VERSION, personReferenceRule: promptResult.personReferenceRule ?? PERSON_REFERENCE_RULE };
      const historyResponse = await fetch("/api/conversation-lists/history", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "start", listId: listBatchTarget.id, reasoningEffort, prompts: historyPrompts, expected: ids.length }), signal: controller.signal });
      const historyResult = await historyResponse.json() as { run?: ListAnnotationRun; error?: string };
      if (!historyResponse.ok || !historyResult.run) throw new Error(historyResult.error || "Could not start shared annotation history.");
      await runLlmBatch(ids, controller, warnings, historyResult.run.id);
    } catch (error) {
      setBatchRun((state) => ({ ...state, active: false, sampling: false, cancelled: controller.signal.aborted, error: controller.signal.aborted ? "Cancelled." : error instanceof Error ? error.message : "Could not prepare this list for annotation." }));
    } finally { batchAbortRef.current = null; }
  };

  const annotateRandomSample = async () => {
    const amount = Math.min(5000, Math.max(1, Math.trunc(Number(batchSampleN) || 1)));
    const controller = new AbortController();
    batchAbortRef.current = controller;
    setBatchRun({ active: true, sampling: true, completed: 0, total: 0, succeeded: 0, failed: 0, skipped: 0, current: 0, startedAt: 0, cancelled: false, error: "", errors: [] });
    try {
      let ids: string[];
      if (batchAnnotationScope === "paper_frame") {
        let sample = await sampleSelection(batchSampleUnit, amount, sampleSeed, true, controller.signal, skipAnnotated, true, batchCtpSelection);
        ids = sample.recordIds ?? [];
        if (skipAnnotated) {
          const isUnannotated = (id: string) => !sharedAnnotations.llmAnnotations[id] || Object.keys(sharedAnnotations.llmAnnotations[id]).length === 0;
          while (true) {
            ids = ids.filter(isUnannotated);
            if (ids.length >= amount || sample.sampled >= sample.total || sample.sampled >= 5000) { ids = ids.slice(0, amount); break; }
            const nextSize = Math.min(5000, Math.max(sample.sampled + amount, sample.sampled * 2));
            if (nextSize <= sample.sampled) break;
            sample = await sampleSelection(batchSampleUnit, nextSize, sampleSeed, true, controller.signal, true, true, batchCtpSelection);
            ids = sample.recordIds ?? [];
          }
        }
      } else {
        if (!sharedAnnotationIndexReady) throw new Error("Human annotation queues are still loading. Please try again in a moment.");
        let candidates = skipAnnotated
          ? (batchHumanSampleIds ?? []).filter((id) => !sharedAnnotations.llmAnnotations[id] || Object.keys(sharedAnnotations.llmAnnotations[id]).length === 0)
          : batchHumanSampleIds ?? [];
        if (batchCtpSelection === "yes") {
          const screenedCandidates = await screenCtpRecordIds(candidates, controller.signal);
          candidates = screenedCandidates.yesRecordIds;
          if (screenedCandidates.unlabeled) showCtpSkippedPopup({ no: 0, unclear: 0, unlabeled: screenedCandidates.unlabeled });
        }
        ids = sampleRecordIds(candidates, amount, sampleSeed);
      }
      if (!ids.length) throw new Error(batchCtpSelection === "yes"
        ? "No MSD1 Yes messages are available in this selection."
        : batchAnnotationScope === "paper_frame"
        ? "No messages match the current selection and filters."
        : skipAnnotated ? "No unannotated messages are available in this human annotation queue." : "No messages are available in this human annotation queue.");
      const screened = await screenCtpRecordIds(ids, controller.signal);
      showCtpSkippedPopup(screened);
      ids = screened.yesRecordIds;
      if (!ids.length) throw new Error("No sampled messages have an MSD1 label of Yes, so GPT-6-Luna was not called.");
      await runLlmBatch(ids, controller);
    } catch (error) {
      setBatchRun((state) => ({ ...state, active: false, sampling: false, cancelled: controller.signal.aborted, error: controller.signal.aborted ? "Cancelled." : error instanceof Error ? error.message : "Could not prepare the annotation sample." }));
    } finally {
      batchAbortRef.current = null;
    }
  };

  const cancelBatchAnnotation = () => batchAbortRef.current?.abort();

  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    void fetch("/api/backups", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) return;
      const result = await response.json() as { capturedAt?: string | null };
      if (!cancelled && result.capturedAt) setBackupAt(result.capturedAt);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [hydrated]);

  useEffect(() => {
    if (!hydrated || !saved) return;
    let cancelled = false;
    let timer: number;
    const saveBackup = async () => {
      try {
        const snapshot = await readForBackup();
        if (!snapshot || cancelled) return;
        const response = await fetch("/api/backups", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(snapshot) });
        if (!response.ok) throw new Error("Backup request failed");
        const result = await response.json() as { capturedAt: string };
        if (!cancelled) { setBackupAt(result.capturedAt); setBackupFailed(false); }
      } catch {
        if (!cancelled) setBackupFailed(true);
      }
      if (!cancelled) timer = window.setTimeout(saveBackup, 5 * 60 * 1000);
    };
    timer = window.setTimeout(saveBackup, 30_000);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [hydrated, saved, annotations, profiles, readForBackup]);

  return <main className="app-shell">
    <aside className="left-rail">
        <div className="profile-switcher" ref={profileMenuRef}>
          <button className="profile-trigger" aria-haspopup="menu" aria-expanded={profileMenuOpen} onClick={() => setProfileMenuOpen((open) => !open)}><span className="profile-avatar"><UserRound size={16} /></span><span className="profile-trigger-copy"><small>ANNOTATOR</small><b>{activeProfile.name}</b></span><ChevronDown size={15} /></button>
          {profileMenuOpen && <div className="profile-menu" role="menu"><div className="dropdown-title">Annotator profiles</div>{unassignedProfile && <div className="dropdown-title">{profilesSynced ? "Select your profile before annotating." : "Loading shared profiles…"}</div>}{profiles.map((profile) => <button key={profile.id} role="menuitemradio" aria-checked={profile.id === activeProfileId} className="profile-option" onClick={() => { clearQueueSearch(); switchProfile(profile.id); setStatusFilters(browseListId ? [] : ["todo"]); setSidebarSection("browse"); setProfileMenuOpen(false); }}><span className="profile-option-avatar">{profile.name.slice(0, 1).toUpperCase()}</span><span>{profile.name}</span>{profile.id === activeProfileId && <Check size={14} />}</button>)}<div className="menu-rule" /><button className="menu-action" onClick={() => openProfileDialog("create")}><Plus size={15} /> Create profile</button><button className="menu-action" disabled={unassignedProfile} onClick={() => openProfileDialog("rename")}><Pencil size={14} /> Edit current profile</button><button className="menu-action danger" disabled={unassignedProfile || profiles.length < 2} onClick={() => openProfileDialog("remove")}><Trash2 size={14} /> Remove current profile</button></div>}
        </div>
        <div className="nav-status-group">
          <button className={`nav-item unique-browse-item ${sidebarSection === "browse" ? "active" : ""}`} onClick={selectBrowse}><MessageSquareText size={17} /><span>Browse Paper Frame</span></button>
          {sidebarSection === "browse" && <div className="browse-frame-summary" aria-label="Paper frame with at least 90 percent English share"><span>≥90% English</span><b>308,962 first messages</b></div>}
          {sidebarSection === "browse" && statusMode === "all" && !browseListId && <div className="browse-ctp-strata" aria-label="CTP screening decisions">
            {([
              ["yes", "Contains CTPs"],
              ["no", "No CTPs"],
              ["unclear", "CTPs Unclear"],
            ] as const).map(([label, title]) => <button key={label} className={`nav-item ctp-frame-item ${ctpLabel === label ? "active" : ""}`} aria-pressed={ctpLabel === label} onClick={() => selectCtpLabel(label)}>
              <span>{title}</span><span className="nav-count">{ctpCounts ? formatNumber(ctpCounts.counts[label]) : "—"}</span>
            </button>)}
            {ctpCountsLoading && <small className="browse-list-loading">Loading CTP screening counts…</small>}
            {ctpCountsError && <small className="browse-list-error">{ctpCountsError}</small>}
          </div>}
          {sidebarSection === "browse" && statusMode === "all" && <>
            <label className="browse-list-select"><span>Browse a list</span><select aria-label="Browse conversation list" value={browseListId} onChange={(event) => void browseConversationList(event.target.value)}><option value="">All frame entries</option>{conversationLists.map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}</select><ChevronDown size={13} /></label>
            {browseListLoading && <small className="browse-list-loading">Loading selected list…</small>}
            {browseListError && <small className="browse-list-error">{browseListError}</small>}
          </>}
          <button className={`nav-item ${sidebarSection === "annotations" ? "active" : ""}`} onClick={selectAnnotationsSection}><CheckCheck size={17} /><span>Annotations</span></button>
          {sidebarSection === "annotations" && <>
            <div className="browse-frame-summary annotation-frame-summary" aria-label="Annotation counts and queues are restricted to the at least 90 percent English paper frame"><span>Counts and queues</span><b>≥90% English · 308,962 messages</b></div>
            <button className={`nav-item review-queue-item ${statusMode === "partial" ? "active" : ""}`} onClick={() => selectReviewMode("partial")}><Check size={17} /><span>LLM Annotated (partially)</span><span className="nav-count">{formatNumber(llmReviewIds.partial.length)}</span></button>
            <button className={`nav-item review-queue-item ${statusMode === "full" ? "active" : ""}`} onClick={() => selectReviewMode("full")}><CheckCheck size={17} /><span>LLM Annotated (fully)</span><span className="nav-count">{formatNumber(llmReviewIds.full.length)}</span></button>
            <button className={`nav-item review-queue-item ${statusMode === "human_2plus" ? "active" : ""}`} onClick={() => selectReviewMode("human_2plus")}><CheckCheck size={17} /><span>≥2 Humans Annotated</span><span className="nav-count">{formatNumber(humanAtLeastTwoIds.length)}</span></button>
            {humanAnnotatorNames.map((annotatorName) => {
              const mode = humanAnnotationStatusMode(annotatorName);
              return <button key={`human-${annotatorName}`} title={`Messages ${annotatorName} has partially or fully annotated`} className={`nav-item review-queue-item ${statusMode === mode ? "active" : ""}`} onClick={() => selectReviewMode(mode)}><CheckCheck size={17} /><span>{annotatorName} Annotated</span><span className="nav-count">{formatNumber(humanAnnotationIdsByAnnotator[annotatorName]?.length ?? 0)}</span></button>;
            })}
            {humanAnnotatorNames.map((annotatorName) => {
              const mode = annotatorName === activeProfile.name ? "llm_human" : humanReviewStatusMode(annotatorName);
              return <button key={`llm-${annotatorName}`} className={`nav-item review-queue-item ${statusMode === mode ? "active" : ""}`} onClick={() => selectReviewMode(mode)}><CheckCheck size={17} /><span>LLM + {annotatorName} Annotated</span><span className="nav-count">{formatNumber(llmAndHumanIdsByAnnotator[annotatorName]?.length ?? 0)}</span></button>;
            })}
            <button className={`nav-item review-queue-item ${statusMode === "llm_all_humans" ? "active" : ""}`} onClick={() => selectReviewMode("llm_all_humans")}><CheckCheck size={17} /><span>LLM + All Humans Annotated</span><span className="nav-count">{formatNumber(llmAndAllHumansIds.length)}</span></button>
          </>}
        </div>
        <div className="side-bottom"><section className="agreement-disclosure"><button type="button" className="agreement-toggle" aria-expanded={agreementExpanded} aria-controls="agreement-details" onClick={() => setAgreementExpanded((expanded) => !expanded)}><span>Agreement</span><ChevronDown size={13} /></button><div id="agreement-details" className="agreement-details" hidden={!agreementExpanded}><section className="agreement-summary" aria-label="LLM-human agreement" title="Overall agreement across comparable Contains CTPs, Domains, Purposes, Referent Types, and Identifiability fields. Optional referent names are not scored, and missing or inapplicable fields are excluded."><div><span>LLM-human agreement</span><small>OVERALL</small></div><strong>{llmHumanAgreement?.percent == null ? "—" : `${llmHumanAgreement.percent.toFixed(1)}%`}</strong><small className="agreement-summary-scope">Excluding exact names/descriptions</small><p>{llmHumanAgreement ? `${llmHumanAgreement.messages.toLocaleString()} messages · ${llmHumanAgreement.comparisons.toLocaleString()} annotation pairs` : "Loading current agreement…"}</p></section><button type="button" className="agreement-summary agreement-summary-action" aria-label="Open messages with at least two human annotations" title="Open the queue of messages annotated by at least two distinct humans." onClick={() => selectReviewMode("human_2plus")}><div><span>Human agreement</span><small>OVERALL</small></div><strong>{agreementSummary?.percent == null ? "—" : `${agreementSummary.percent.toFixed(1)}%`}</strong><small className="agreement-summary-scope">Excluding exact names/descriptions</small><p>{agreementSummary ? `${agreementSummary.messages.toLocaleString()} messages · ${agreementSummary.comparisons.toLocaleString()} annotation pairs` : "Loading current agreement…"}</p></button></div></section><div className="prompt-shortcuts">{ANNOTATION_PROMPT_DIMENSIONS.map((dimension) => <button key={dimension.key} className={`prompt-shortcut prompt-shortcut-${dimension.key}`} onClick={() => void loadSharedPrompts(dimension.key)}><FileText size={14} /><span>{dimension.title}</span></button>)}</div><button disabled={llmBusyId !== null || batchRun.active} className="sample-trigger batch-annotate-trigger" onClick={() => { setListBatchTarget(null); setListBatchRecordIds(null); setSkipAnnotated(true); setBatchCtpSelection(""); setBatchRun({ active: false, sampling: false, completed: 0, total: 0, succeeded: 0, failed: 0, skipped: 0, current: 0, startedAt: 0, cancelled: false, error: "", errors: [] }); setBatchDialogOpen(true); }}><span>LLM Annotate</span></button><Msd1TestingTool reviewers={msd1TestReviewers} disabled={!sharedAnnotationIndexReady || batchRun.active || llmBusyId !== null} /><div className="list-tools-buttons"><button className="sample-trigger list-manager-trigger" disabled={batchRun.active} onClick={openConversationLists}><span>Lists</span></button><button className="sample-trigger batch-annotate-trigger evaluation-trigger" disabled={batchRun.active} onClick={openListEvaluation}><span>Evaluation</span></button></div><div className="sidebar-utility"><div className="sidebar-utility-status"><div className="save-indicator"><span className={`save-dot ${saved ? "" : "saving"}`} />{saved ? "All changes saved" : "Saving changes"}</div><div className={`backup-indicator ${backupFailed ? "backup-error" : ""}`} title={backupAt ? `Last backup ${new Date(backupAt).toLocaleString()}` : "A local backup is created automatically"}>{backupFailed ? "Backup retrying" : backupAt ? `Backup ${new Date(backupAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Backup pending"}</div></div><div className="sidebar-utility-actions"><div className="export-dropdown" ref={exportMenuRef}><button className="export-trigger" aria-label="Download annotations or a sample" aria-expanded={exportMenuOpen} onClick={() => setExportMenuOpen((open) => !open)}><Download size={16} /><ChevronDown size={12} /></button>{exportMenuOpen && <div className="export-menu" role="menu"><div className="dropdown-title">Annotations</div>{profiles.map((profile) => <button key={profile.id} role="menuitem" onClick={() => exportAnnotations(profile.id)}><span>{profile.name}</span>{profile.id === activeProfileId && <small>Current</small>}</button>)}<div className="menu-rule" /><button role="menuitem" onClick={() => exportAnnotations("all")}>All annotators</button><div className="menu-rule" /><div className="dropdown-title">Prompts</div><button role="menuitem" onClick={() => void openPromptDownloads()}><span>Download LLM prompts</span><small>TXT</small></button><div className="menu-rule" /><div className="dropdown-title">Sample</div><button role="menuitem" onClick={() => { setExportMenuOpen(false); setSampleError(""); setSampleCtpLabel(ctpLabel); setSampleDialogOpen(true); }}><span>Random sample for annotation</span><small>CSV</small></button></div>}</div><button className="icon-btn signout-button" title="Sign out" aria-label="Sign out" onClick={signOut}><LogOut size={15} /></button></div></div></div>
    </aside>

    <section className="main-column">
      <div className={`work-area ${mobileReading ? "mobile-reading" : ""}`}>
        <section className="queue-panel" style={{ width: `${queueWidth}px`, flex: `0 0 ${queueWidth}px`, minWidth: "230px" }}>
          <div className="queue-heading"><button className={`filter-button ${mobileFilterOpen ? "pressed" : ""}`} onClick={() => setMobileFilterOpen(!mobileFilterOpen)}><ListFilter size={15} /> Filters</button></div>
          <div className={`queue-controls ${mobileFilterOpen ? "show" : ""}`}><label className={`search-box ${searchFocused ? "focused" : ""}`}><Search size={16} /><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} onFocus={() => setSearchFocused(true)} onBlur={() => setSearchFocused(false)} placeholder="Search messages or IDs…" title={'Wrap a word or phrase in double quotes to match it exactly, e.g. "alex"'} /><kbd>⌘ K</kbd>{query && <button onClick={() => setQuery("")} aria-label="Clear search"><X size={14} /></button>}</label><div className="filter-top-row"><div className="filter-menu-anchor" ref={filterMenuRef}><button className="control-select filter-trigger" aria-expanded={filterMenuOpen} onClick={() => setFilterMenuOpen((open) => !open)}><Filter size={14} /><span>{filterCount ? `${filterCount} selected` : "Filters"}</span><ChevronDown size={13} /></button>{filterMenuOpen && <div className="filter-popover"><div className="match-mode"><span>Match</span><div><button className={matchMode === "any" ? "selected" : ""} onClick={() => setMatchMode("any")}>Any</button><button className={matchMode === "all" ? "selected" : ""} onClick={() => setMatchMode("all")}>All</button></div></div><div className="filter-group"><span>PERSON SIGNALS</span>{[["names", "Person names"], ["nouns", "Person nouns"], ["pronouns", "Pronouns"], ["coreference", "Coreference"], ["embedded", "Embedded content"]].map(([value, label]) => <label className="filter-check" key={value}><input type="checkbox" checked={signal.includes(value)} onChange={() => toggleSignal(value)} />{label}</label>)}</div><div className="filter-group annotation-entry-filters"><span>ANNOTATION ENTRIES</span>{ANNOTATION_FILTER_GROUPS.map((group) => <div className="annotation-entry-group" key={group.key}><span>{group.label}</span>{group.values.map((value) => <label className="filter-check" key={value}><input type="checkbox" checked={(annotationFilters[group.key] ?? []).includes(value)} onChange={() => toggleAnnotationFilter(group.key, value)} />{value}</label>)}</div>)}</div><div className="filter-group"><span>CONVERSATION</span><label className="filter-check"><input type="checkbox" checked={presidioOnly} onChange={(event) => setPresidioOnly(event.target.checked)} />Conversation contains PRESIDIO_</label></div><div className="filter-group coref-filter-group"><span>PERSON COREFERENCE</span><label className="filter-number"><span>At least</span><input aria-label="Minimum person-coreference mentions" type="number" min="2" step="1" placeholder="Any" value={corefMinMentions} onChange={(event) => setCorefMinMentions(event.target.value)} /><span>linked mentions</span></label><label className="filter-number"><span>At least</span><input aria-label="Minimum person-coreference mentions per 100 requester words" type="number" min="0.1" step="0.1" placeholder="Any" value={corefMinRate} onChange={(event) => setCorefMinRate(event.target.value)} /><span>per 100 requester words</span></label><small>Counts requester mentions in person-related clusters with at least two distinct mentions.</small></div><button className="filter-clear" onClick={() => { setSignal([]); setPresidioOnly(false); setCorefMinMentions(""); setCorefMinRate(""); setAnnotationFilters({ domains: [], referents: [], identifiability: [], purposes: [], harm: [] }); setPossibleHarmFilter(false); setMatchMode("any"); }}>Clear filters</button></div>}</div><label className="filter-check possible-harm-top-filter"><input type="checkbox" checked={possibleHarmFilter} onChange={togglePossibleHarmFilter} />Possible harm</label></div></div>
          <div className="list-meta"><span>{payload ? <><b>{formatNumber(visibleRows.length)}</b>{payload.totalKnown ? <> of {formatNumber(payload.total)} {scopeDescription}</> : <> {scopeDescription} · finding full results</>}</> : "Loading messages"}</span></div>
          <div className="conversation-list" ref={listRef}>
            {!payload ? searchError ? <div className="empty-state async-error" role="alert"><b>Could not load messages</b><span>{searchError}</span><button type="button" className="async-retry-button" onClick={retrySearch}>Retry search</button></div> : <div className="loading-state"><LoaderCircle size={19} className="spin" /> Loading the annotation frame…</div> : <>{searchError && <div className="list-error" role="alert"><span>{searchError}</span><button type="button" className="async-retry-button" onClick={retrySearch}>Retry search</button></div>}{visibleRows.length === 0 ? payload.complete ? <div className="empty-state"><Search size={21} /><b>No messages found</b><span>Try broadening your search or filters.</span></div> : searchError ? null : <div className="loading-state"><LoaderCircle size={19} className="spin" /> Searching the full index…</div> : visibleRows.map((row, rowIndex) => <div key={row.id} data-record-id={row.id} role="button" tabIndex={0} aria-pressed={activeId === row.id || selectedIds.includes(row.id)} className={`conversation-card ${activeId === row.id ? "current" : ""} ${selectedIds.includes(row.id) ? "multi-selected" : ""}`} onClick={(event) => selectQueueRecord(row, rowIndex, event)} onKeyDown={(event) => { if (event.target !== event.currentTarget) return; if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectionAnchorRef.current = row.id; setSelectedIds([]); selectRecord(row); } }}>
              <div className="card-top"><div className="card-top-leading">{hasPossibleHarm(annotations[row.id]) && <button type="button" className="candidate-pill harm-pill harm-pill-button" onClick={(event) => openPossibleHarmReferent(row, event)}><i />Harm?</button>}<span className="card-turn">Turn {row.requesterTurnIndex + 1} ({row.metadata.words} words)</span></div><button type="button" className={`llm-annotate-button ${llmBusyId === row.id ? "llm-cancel-button" : ""} ${hasAnnotation(sharedAnnotations.llmAnnotations[row.id]) ? "llm-redo-button" : ""}`} disabled={(llmBusyId !== null && llmBusyId !== row.id) || batchRun.active} onClick={(event) => { event.stopPropagation(); if (redoComparison?.id === row.id && redoComparison.loading) closeRedoComparison(); else if (llmBusyId === row.id) cancelSingleAnnotation(); else if (hasAnnotation(sharedAnnotations.llmAnnotations[row.id])) openRedoComparison(row); else void annotateWithLLM(row); }}>{llmBusyId === row.id ? "Cancel" : hasAnnotation(sharedAnnotations.llmAnnotations[row.id]) ? "LLM Redo + Compare" : "LLM Annotate"}</button></div><div className="card-text">{highlightPlainText((row.text ?? "").replace(/\s+/g, " ").slice(0, 180), query)}{(row.text?.length ?? 0) > 180 ? "…" : ""}</div>{(() => { const llmAnnotation = sharedAnnotations.llmAnnotations[row.id]; const humanAnnotation = sharedAnnotations.humanAnnotations[row.id]?.[activeProfile.name] ?? humanLocalAnnotations[row.id]; const hasDots = (annotations[row.id]?.referents?.length ?? 0) > 0; const llmComplete = isFullyAnnotated(llmAnnotation); const humanComplete = isFullyAnnotated(humanAnnotation); return (hasDots || llmComplete || humanComplete) ? <div className="card-bottom">{hasDots ? <span className="referent-dots" aria-label="Annotated referent identifiability">{(["Directly identifiable", "Indirectly identifiable", "No identifying cues"] as const).map((identifiability, index) => { const count = (annotations[row.id]?.referents ?? []).filter((referent) => referent.identifiability === identifiability).length; const label = (["D", "I", "N"] as const)[index]; return count ? <span key={label} className="referent-count-group" aria-label={`${count} ${identifiability.toLowerCase()} referent${count === 1 ? "" : "s"}`} title={`${count} ${identifiability.toLowerCase()} referent${count === 1 ? "" : "s"}`}><span className="referent-count">{count}×</span><span className="referent-dot">{label}</span></span> : null; })}</span> : <span /> }<span className="card-completion-statuses">{llmComplete && <span className="card-done" title="LLM annotation complete" aria-label="LLM annotation complete"><CheckCheck size={12} /></span>}{humanComplete && <span className="card-done" title={`${activeProfile.name} annotation complete`} aria-label={`${activeProfile.name} annotation complete`}><CheckCheck size={12} /></span>}</span></div> : null; })()}{llmErrors[row.id] && <div className="llm-row-error" role="alert">{llmErrors[row.id]}</div>}
            </div>)}</>}
            {payload && !payload.complete && !searchError && <div className="list-end searching-more" aria-live="polite"><LoaderCircle size={14} className="spin" /> Finding all matching messages</div>}
            {payload && hasMore && <div className="list-end" ref={sentinelRef} aria-live="polite">{loadingMore && <><LoaderCircle size={14} className="spin" /> Loading more</>}</div>}
          </div>
        </section>
        <div className="panel-resizer queue-resizer" role="separator" aria-orientation="vertical" aria-label="Resize message list" aria-valuemin={230} aria-valuemax={520} aria-valuenow={queueWidth} tabIndex={0} onPointerDown={(event) => startPanelResize("queue", event)} onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); resizePanelByKeyboard("queue", event.key === "ArrowLeft" ? -12 : 12); } }} />

        <section className="conversation-panel">
          {!active ? <div className="no-selection"><div className="no-selection-mark"><MessageSquareText size={21} /></div><h2>Select a message to review</h2><p>Choose a conversation from the queue to begin annotating.</p></div> : <>
            <div className="conversation-top"><button className="mobile-back" title="Back to message list" onClick={() => setMobileReading(false)}>Messages</button><div className="conv-title"><div className="eyebrow">CONVERSATION</div><div className="conv-id">{highlightPlainText(active.sourceConversationId, query)}<button title="Copy conversation ID" className="icon-btn copy-id" onClick={async () => { await navigator.clipboard.writeText(active.sourceConversationId); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>{copied ? <Check size={14} /> : <Copy size={14} />}</button></div></div></div>
            {activeContext ? <div className={`conversation-content ${annotationHighlights ? "annotation-highlights-enabled" : ""}`} key={active.id}><div className="context-banner"><span className="context-line" /><span className="context-marker"><button type="button" onClick={revealTarget}>TARGET MESSAGE</button><span>Requester turn {active.requesterTurnIndex + 1} · context ends here</span></span><span className="context-line" /></div>{activeContext.map((message, i) => { const target = i === activeContext.length - 1; const assistant = !["user", "requester"].includes(message.role.toLowerCase());  return <article key={`${message.turnIndex}-${i}`} className={`message-row ${assistant ? "assistant-row" : "user-row"} ${target ? "target-row" : ""}`}><div className={`message-avatar ${assistant ? "assistant-avatar" : "user-avatar-message"}`}>{assistant ? "A" : "U"}</div><div className="message-main"><div className="message-author">{roleName(message.role)}{target && <span className="target-label">ANNOTATE THIS MESSAGE</span>}</div><div className={`message-bubble ${assistant ? "assistant-bubble" : "user-bubble"}`}><div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[highlightPlugin(query, prescreenHighlights && target ? targetPrescreenExamples : [], heuristicHighlights, target ? currentAnnotation.referents ?? [] : [], annotationHighlights && target)]}>{message.text}</ReactMarkdown></div></div>{target && <div className="quick-annotation"><span className="quick-prompt">Does this message contain CTPs (people or human groups other than the requester or assistant/model) in supplied content or requested work?</span><div className="quick-actions"><button disabled={annotationSource === "llm" || unassignedProfile || readOnlyHumanView} className={`quick-choice choice-yes ${currentRelevance === "yes" ? "active" : ""}`} onClick={() => chooseRelevance("yes")}><Check size={14} /> Yes <kbd>1</kbd></button><button disabled={annotationSource === "llm" || unassignedProfile || readOnlyHumanView} className={`quick-choice choice-no ${currentRelevance === "no" ? "active" : ""}`} onClick={() => chooseRelevance("no")}><X size={14} /> No <kbd>2</kbd></button><button disabled={annotationSource === "llm" || unassignedProfile || readOnlyHumanView} className={`quick-choice choice-unsure ${currentRelevance === "uncertain" ? "active" : ""}`} onClick={() => chooseRelevance("uncertain")}><CircleHelp size={14} /> Unclear <kbd>3</kbd></button></div></div>}</div></article>; })}<div className="end-context"><span>END OF AVAILABLE CONTEXT</span></div></div> : contextErrorId === active.id && contextError ? <div className="context-loading-state context-error-state" role="alert"><span>{contextError}</span><button type="button" className="async-retry-button" onClick={() => setContextRetry((current) => current + 1)}>Retry conversation</button></div> : <div className="context-loading-state" aria-live="polite"><LoaderCircle size={16} className="spin" /> Loading conversation…</div>}
            <div className="conversation-footer"><div className="highlight-controls"><label className="highlight-toggle"><input type="checkbox" checked={prescreenHighlights} onChange={(event) => { const enabled = event.target.checked; setPrescreenHighlights(enabled); try { localStorage.setItem("wildchat-prescreen-highlights-v1", enabled ? "on" : "off"); } catch { /* setting remains active for this session */ } }} /><span className="highlight-toggle-box" /><span>Prescreen examples</span></label><label className="highlight-toggle"><input type="checkbox" checked={heuristicHighlights} onChange={(event) => { const enabled = event.target.checked; setHeuristicHighlights(enabled); try { localStorage.setItem("wildchat-heuristic-highlights-v1", enabled ? "on" : "off"); } catch { /* setting remains active for this session */ } }} /><span className="highlight-toggle-box heuristic-toggle-box" /><span>Pronoun heuristics</span></label><label className="highlight-toggle"><input type="checkbox" checked={annotationHighlights} onChange={(event) => { const enabled = event.target.checked; setAnnotationHighlights(enabled); try { localStorage.setItem("wildchat-annotation-highlights-v1", enabled ? "on" : "off"); } catch { /* setting remains active for this session */ } }} /><span className="highlight-toggle-box annotation-toggle-box" /><span>Annotations</span></label></div><button className="next-button" onClick={() => move(1)}>Next message <ArrowRight size={15} /></button></div>
          </>}
        </section>
        <div className="panel-resizer detail-resizer" role="separator" aria-orientation="vertical" aria-label="Resize annotation panel" aria-valuemin={240} aria-valuemax={520} aria-valuenow={detailWidth} tabIndex={0} onPointerDown={(event) => startPanelResize("detail", event)} onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); resizePanelByKeyboard("detail", event.key === "ArrowLeft" ? 12 : -12); } }} />

        <aside className={`detail-panel ${annotationSource === "llm" ? "llm-review" : ""}`} style={{ width: `${detailWidth}px`, flex: `0 0 ${detailWidth}px`, minWidth: "240px" }}>
          {profileSyncError && <div className="shared-annotation-error" role="alert">{profileSyncError}</div>}{sharedAnnotations.syncError && <div className="shared-annotation-error" role="alert">{sharedAnnotations.syncError}</div>}
          <div className="detail-header"><div className="annotation-header-main"><h2>Annotation</h2><div className="annotation-source-row"><div className={`segmented-control annotation-source-switch ${annotationSource === "llm" ? "llm-selected" : ""}`} role="tablist" aria-label="Annotation source"><button type="button" role="tab" aria-selected={annotationSource === "llm"} className={annotationSource === "llm" ? "is-selected" : ""} onClick={() => setAnnotationSource("llm")}>LLM</button>{messageHumanAnnotatorNames.map((annotatorName) => <button key={annotatorName} type="button" role="tab" aria-selected={annotationSource === "human" && displayedHumanAnnotator === annotatorName} className={annotationSource === "human" && displayedHumanAnnotator === annotatorName ? "is-selected" : ""} onClick={() => { setSelectedHumanAnnotator(annotatorName); setAnnotationSource("human"); }}>{annotatorName}</button>)}</div>{active && <span className={`message-agreement ${messageAgreement === null ? "pending" : messageAgreement.percent === 100 ? "agrees" : messageAgreement.percent === 0 ? "differs" : "partial-agreement"}`} title={messageAgreement ? `${messageAgreement.matches} of ${messageAgreement.total} comparable annotation checks match between the LLM and ${activeProfile.name}.` : "No annotation categories are available in both the LLM and human annotations for comparison."}><span>LLM-human</span><b>{messageAgreement ? `Agreement (${messageAgreement.matches}/${messageAgreement.total} · ${Math.round(messageAgreement.percent)}%)` : "Agreement (—)"}</b></span>}{messageHumanAgreement && <span className={`message-agreement ${messageHumanAgreement.percent == null ? "pending" : messageHumanAgreement.percent === 100 ? "agrees" : messageHumanAgreement.percent === 0 ? "differs" : "partial-agreement"}`} title={messageHumanAgreement.total ? `${messageHumanAgreement.comparablePairs} of ${messageHumanAgreement.pairs} human annotation pairs have comparable fields; ${messageHumanAgreement.matches} of ${messageHumanAgreement.total} checks match.` : `No comparable annotation fields among ${messageHumanAgreement.pairs} human annotation pairs.`}><span>Human-human</span><b>{messageHumanAgreement.total ? `Agreement (${messageHumanAgreement.matches}/${messageHumanAgreement.total} · ${Math.round(messageHumanAgreement.percent!)}%)` : "Agreement (—)"}</b></span>}</div></div>{annotationSource === "llm" ? <div className="annotation-header-actions"><div className="annotation-reset-menu-wrap" ref={llmResetMenuRef}><button className="annotation-reset" type="button" aria-expanded={llmResetMenuOpen} onClick={() => setLlmResetMenuOpen((open) => !open)}>Reset LLM <ChevronDown size={12} /></button>{llmResetMenuOpen && <div className="annotation-reset-menu" role="menu"><button type="button" role="menuitem" disabled={!visibleRows.some((row) => sharedAnnotations.llmAnnotations[row.id])} onClick={() => void resetShownLlmAnnotations()}>Reset LLM (shown)</button><button type="button" role="menuitem" onClick={() => void resetAllLlmAnnotations()}>Reset LLM (all)</button></div>}</div><button className="llm-to-human-button" type="button" disabled={!active || unassignedProfile || !hasAnnotation(currentAnnotation)} onClick={requestLlmToHumanCopy}>LLM → {activeProfile.name}</button></div> : readOnlyHumanView ? <span className="annotation-view-only">Viewing {displayedHumanAnnotator} · read only</span> : selectedIds.length ? <button className="annotation-reset bulk-reset-button" type="button" disabled={unassignedProfile || !selectedIds.some((id) => annotations[id])} onClick={resetSelectedAnnotations}>Reset {activeProfile.name} for selected</button> : <button className="annotation-reset" type="button" disabled={unassignedProfile || !active || !annotations[active.id]} onClick={resetCurrentAnnotation}>Reset {activeProfile.name}</button>}</div>
          {active ? <div className="detail-scroll">
            {annotationSource === "llm" && !hasAnnotation(active ? sharedAnnotations.llmAnnotations[active.id] : undefined) ? <div className="llm-empty-state"><strong>No LLM annotation saved</strong><span>Run an LLM annotation for this message to see its results here.</span></div> : <>
            {annotationSource === "llm" && <div className="llm-version-meta">{currentLlmCreatedAt ? <><b>{selectedLlmHistory ? "Historical annotation" : "LLM annotation created"}</b><span>{new Date(currentLlmCreatedAt).toLocaleString()}</span></> : null}</div>}{annotationSource === "llm" && <section className="llm-history-panel"><button type="button" className="llm-history-toggle" aria-expanded={llmHistoryOpen} onClick={() => void toggleLlmHistory()}>{llmHistoryLoading ? "Loading history…" : llmHistoryOpen ? "Hide previous annotations" : "View previous annotations"}<ChevronDown size={13} /></button>{llmHistoryOpen && <div className="llm-history-content">{llmHistoryError && <p className="sample-error" role="alert">{llmHistoryError}</p>}{!llmHistoryLoading && !llmHistoryError && llmHistoryVersions.length === 0 && <p>No previous saved LLM annotations for this message.</p>}{llmHistoryVersions.length > 0 && <><label>Version<select value={selectedLlmHistoryId} onChange={(event) => setSelectedLlmHistoryId(event.target.value)}><option value="">Current annotation</option>{llmHistoryVersions.map((version) => <option key={version.id} value={version.id}>{new Date(version.createdAt).toLocaleString()}</option>)}</select></label>{selectedLlmHistory && <button type="button" className="llm-history-current" onClick={() => setSelectedLlmHistoryId("")}>Return to current annotation</button>}</>}</div>}</section>}<fieldset className="annotation-edit-fields" disabled={annotationSource === "llm" || unassignedProfile || readOnlyHumanView}><div className="detail-section"><div className={`section-label ${relevanceDiffers ? "has-annotation-difference" : ""}`}><span>01</span><span className="taxonomy-title-pill taxonomy-neutral">Contains CTPs</span>{relevanceDiffers && <span className="annotation-difference-label">DIFFERS FROM HUMAN</span>}</div><p className="section-help">Does this requester message contain CTPs (people or human groups other than the requester or assistant/model) in supplied content or requested work?</p><div className="segmented-control three"><button className={`${currentRelevance === "yes" ? "is-selected" : ""} ${relevanceDiffers && currentRelevance === "yes" ? "annotation-value-diff" : ""}`} onClick={() => chooseRelevance("yes")}>Yes <kbd>1</kbd></button><button className={`${currentRelevance === "no" ? "is-selected" : ""} ${relevanceDiffers && currentRelevance === "no" ? "annotation-value-diff" : ""}`} onClick={() => chooseRelevance("no")}>No <kbd>2</kbd></button><button className={`${currentRelevance === "uncertain" ? "is-selected" : ""} ${relevanceDiffers && currentRelevance === "uncertain" ? "annotation-value-diff" : ""}`} onClick={() => chooseRelevance("uncertain")}>Unclear <kbd>3</kbd></button></div></div>{relevanceDiffers && <div className="annotation-difference-inline" role="note"><span><b>LLM:</b> {currentRelevance}</span><span><b>{activeProfile.name}:</b> {humanRelevance}</span></div>}
            {currentRelevance === "yes" && <>
              <details className="drip-definitions"><summary>DRIP taxonomy · definitions</summary><p>CTP is an acronym for “conversational third party”. It refers to another person or human group discussed or represented in the request. The requester and assistant/model, including “I” or “me” when the requester refers to themself, do not count as CTPs. Code the primary requested deliverable. Add another Purpose only when a distinct, substantive requested output independently fits it. Do not count an incidental auxiliary field or an intermediate analysis step.</p>{DRIP_DEFINITIONS.map((group) => <section key={group.title}><h3>{group.title}</h3>{group.title === "Domains" && <p>A request may fit more than one domain. Select all that apply. Code the substantive task, rather than an incidental topic in supplied source material.</p>}<dl>{group.items.map(([term, definition]) => <div key={term}><dt>{term}</dt><dd>{definition}</dd></div>)}</dl></section>)}</details>
              <div className={`detail-section drip-section-domain ${domainsDiffer ? "has-annotation-difference" : ""}`}><div className={`section-label ${domainsDiffer ? "has-annotation-difference" : ""}`}><span>02</span><span className="taxonomy-title-pill taxonomy-domain">DOMAINS</span>{domainsDiffer && <span className="annotation-difference-label">DIFFERS FROM HUMAN</span>}</div><p className="section-help">What areas of life does the request concern? Select all that apply.</p><div className="role-chips drip-options">{DRIP_DOMAINS.map((domain) => <button type="button" key={domain} aria-pressed={(currentAnnotation.domains ?? []).includes(domain)} className={`${(currentAnnotation.domains ?? []).includes(domain) ? "role-chip selected" : "role-chip"} ${compareWithHuman && Array.isArray(messageHumanAnnotation?.domains) && (currentAnnotation.domains ?? []).includes(domain) !== messageHumanAnnotation.domains.includes(domain) ? "annotation-value-diff" : ""}`} onClick={() => toggleDripValue("domains", domain)}>{domain}</button>)}</div></div>{domainsDiffer && <AnnotationDifferenceSummary category="Domains" llmOnly={domainDifference.leftOnly} humanOnly={domainDifference.rightOnly} humanName={activeProfile.name} />}
              <div className={`detail-section drip-section-referent ${referentsDiffer ? "has-annotation-difference" : ""}`}>
                <div className={`section-label ${referentsDiffer ? "has-annotation-difference" : ""}`}><span>03</span><span className="taxonomy-title-pill taxonomy-referent">REFERENTS</span><span className="optional">WHO IS DISCUSSED?</span>{referentsDiffer && <span className="annotation-difference-label">DIFFERS FROM HUMAN</span>}</div>
                <p className="section-help">Add each distinct person or human group discussed.</p>
                {hasComparableReferents && <div className="referent-difference-summaries">
                  <AnnotationDifferenceSummary category="Referent types" llmOnly={referentTypeDifference.leftOnly} humanOnly={referentTypeDifference.rightOnly} humanName={activeProfile.name} />
                  <AnnotationDifferenceSummary category="Type + identifiability" llmOnly={referentClassificationDifference.leftOnly} humanOnly={referentClassificationDifference.rightOnly} humanName={activeProfile.name} />
                </div>}
                {llmReferents.map((referent, personIndex) => {
                  const humanReferentIndex = referentPairing.pairs.find((pair) => pair.leftIndex === personIndex)?.rightIndex;
                  const humanReferent = humanReferentIndex === undefined ? undefined : humanReferents[humanReferentIndex];
                  const typeDiffers = Boolean(hasComparableReferents && humanReferent && normalizeAnnotationText(referent.type) !== normalizeAnnotationText(humanReferent.type));
                  const identifiabilityDiffers = Boolean(hasComparableReferents && humanReferent && normalizeAnnotationText(referent.identifiability) !== normalizeAnnotationText(humanReferent.identifiability));
                  const referentDiffers = typeDiffers || identifiabilityDiffers;
                  const unpaired = hasComparableReferents && !humanReferent;
                  return <div className={`person-card drip-referent ${referentDiffers ? "annotation-referent-diff" : ""} ${unpaired ? "annotation-referent-unmatched" : ""}`} key={personIndex} onClick={(event) => { if (event.target instanceof HTMLElement && event.target.closest("input,select,textarea,button")) return; navigateToReferent(personIndex); }}>
                    <div className="person-card-head" role="button" tabIndex={0} title="Highlight annotations and scroll to this referent" onClick={(event) => { if (event.target instanceof HTMLElement && event.target.closest("button")) return; navigateToReferent(personIndex); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); navigateToReferent(personIndex); } }}>
                      <span className="person-number">R{personIndex + 1}</span><b>{referent.mention || referent.type || "New referent"}</b>
                      {unpaired && <span className="referent-unmatched-label">UNPAIRED BY NAME</span>}
                      <button className="icon-btn tiny" title="Remove referent" onClick={(event) => { event.stopPropagation(); update(active.id, { referents: currentAnnotation.referents?.filter((_, itemIndex) => itemIndex !== personIndex) }); }}><X size={13} /></button>
                    </div>
                    <div className="field-stack">
                      <label><span className="referent-field-label">Referent type{typeDiffers && <small className="referent-human-value">{activeProfile.name}: {humanReferent?.type || "Not set"}</small>}</span><select className={typeDiffers ? "annotation-value-diff" : ""} value={referent.type ?? ""} onChange={(event) => updateReferent(personIndex, { type: event.target.value })}><option value="">Select a referent type…</option>{DRIP_REFERENTS.map((type) => <option key={type}>{type}</option>)}</select></label>
                      <label><span className="referent-field-label"><span className="taxonomy-title-pill taxonomy-identifiability">Identifiability</span>{identifiabilityDiffers && <small className="referent-human-value">{activeProfile.name}: {humanReferent?.identifiability || "Not set"}</small>}</span><select className={identifiabilityDiffers ? "annotation-value-diff" : ""} value={referent.identifiability ?? ""} onChange={(event) => updateReferent(personIndex, { identifiability: event.target.value })}><option value="">Select identifiability…</option>{DRIP_IDENTIFIABILITY.map((level) => <option key={level}>{level}</option>)}</select></label>
                      <label>Person, group, or description <span className="optional">OPTIONAL</span><input value={referent.mention ?? ""} onChange={(event) => updateReferent(personIndex, { mention: event.target.value })} placeholder="e.g. Alex, my daughter, doctors" /></label>
                    </div>
                    {unpaired && <p className="referent-pairing-note">No close mention match in {activeProfile.name}’s annotation. See the inventory differences above; mention text is not scored.</p>}
                  </div>;
                })}
                {hasComparableReferents && referentPairing.unmatchedRight.map((humanIndex) => {
                  const referent = humanReferents[humanIndex];
                  return <div className="person-card drip-referent human-only-referent" key={`human-${humanIndex}`}>
                    <div className="person-card-head"><span className="person-number">H{humanIndex + 1}</span><b>{referent.mention || referent.type || "Unnamed referent"}</b><span className="referent-unmatched-label">UNPAIRED BY NAME</span></div>
                    <div className="human-only-fields"><span><b>Referent type</b>{referent.type || "Not set"}</span><span><b>Identifiability</b>{referent.identifiability || "Not set"}</span></div>
                  </div>;
                })}
                <button className="add-person" onClick={() => update(active.id, { referents: [...(currentAnnotation.referents ?? []), {}] })}>+ Add referent</button>
              </div>
              <div className={`detail-section drip-section-purpose ${purposesDiffer ? "has-annotation-difference" : ""}`}><div className={`section-label ${purposesDiffer ? "has-annotation-difference" : ""}`}><span>04</span><span className="taxonomy-title-pill taxonomy-purpose">PURPOSE</span>{purposesDiffer && <span className="annotation-difference-label">DIFFERS FROM HUMAN</span>}</div><p className="section-help">Classify the primary requested deliverable. Add another purpose only for a distinct, substantive requested output. Do not count an incidental field or an intermediate analysis step.</p><div className="role-chips drip-options">{DRIP_PURPOSES.map((purpose) => <button type="button" key={purpose} aria-pressed={(currentAnnotation.purposes ?? []).includes(purpose)} className={`${(currentAnnotation.purposes ?? []).includes(purpose) ? "role-chip selected" : "role-chip"} ${compareWithHuman && Array.isArray(messageHumanAnnotation?.purposes) && (currentAnnotation.purposes ?? []).includes(purpose) !== messageHumanAnnotation.purposes.includes(purpose) ? "annotation-value-diff" : ""}`} onClick={() => toggleDripValue("purposes", purpose)}>{purpose}</button>)}</div></div>{purposesDiffer && <AnnotationDifferenceSummary category="Purpose" llmOnly={purposeDifference.leftOnly} humanOnly={purposeDifference.rightOnly} humanName={activeProfile.name} />}
            </>}
            <div className="detail-section note-section"><div className="section-label"><span>05</span><span className="taxonomy-title-pill taxonomy-neutral">ANNOTATOR NOTE</span><span className="optional">OPTIONAL</span></div><textarea value={currentAnnotation.note ?? ""} onChange={(event) => update(active.id, { note: event.target.value })} placeholder="Add a note for adjudication…" rows={3} /></div></fieldset></>}
            <div className="screening-card"><button type="button" className="screening-card-head prescreen-toggle" aria-expanded={prescreenExpanded} onClick={() => setPrescreenExpanded((expanded) => !expanded)}><span>Prescreen</span><span>{prescreenExpanded ? "Hide" : "Show"}</span><ChevronDown size={14} /></button>{prescreenExpanded && <div className="screening-card-body"><div className="signal-level"><span>WHOLE CONVERSATION</span><div className="signal-tags">{conversationSignals.length ? conversationSignals.map((label) => <span key={label}>{label}</span>) : <span className="no-signals">No person-reference signal</span>}</div></div><div className="signal-level"><span>THIS REQUESTER TURN</span><div className="signal-tags">{turnSignals.length ? turnSignals.map((label) => <span key={label}>{label}</span>) : <span className="no-signals">No person-reference signal on this turn</span>}</div></div>{active.metadata.personCoreferenceMentions !== undefined && <div className="signal-level"><span>WHOLE CONVERSATION · REQUESTER TEXT</span><div className="signal-tags"><span>{active.metadata.personCoreferenceMentions} linked mentions</span><span>{(active.metadata.personCoreferencePer100Words ?? 0).toFixed(2)} per 100 words</span><span>{active.metadata.personCoreferenceClusters ?? 0} clusters</span></div></div>}<div className="prescreen-evidence"><div className="evidence-heading"><span>EXACT SPANS</span><span>{exampleGroups.reduce((total, group) => total + group.items.length, 0)} found</span></div>{exampleGroups.map((group) => group.items.length > 0 && <div className="evidence-group" key={group.label}><span className="evidence-label">{group.label}</span><div className="evidence-chips">{group.items.map((item, index) => <span className="evidence-chip" key={`${group.label}-${item.start}-${item.end}-${index}`} title={`Characters ${item.start}–${item.end}${item.lemma ? ` · lemma: ${item.lemma}` : ""}${item.label ? ` · type: ${item.label}` : ""}${item.requester_reference ? " · requester reference" : ""}${item.cluster_index !== undefined ? ` · coreference cluster ${item.cluster_index + 1}` : ""}`}>{item.text}</span>)}</div></div>)}{exampleGroups.every((group) => group.items.length === 0) && <div className="evidence-empty">No exact spans on this turn</div>}</div></div>}</div>
            <div className="record-meta"><span>RECORD DETAILS</span><div><span>Message ID</span><b>{highlightPlainText(active.id, query)}</b></div><div><span>Source shard</span><b>{active.sourceShard}</b></div><div><span>Source row</span><b>{formatNumber(active.sourceRow)}</b></div><div><span>Sample key</span><b>{highlightPlainText(active.sampleKey, query)}</b></div></div>
          </div> : <div className="detail-empty">Select a message to see annotation details.</div>}
        </aside>
      </div>
      {redoComparison && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeRedoComparison(); }}><section className="profile-dialog redo-dialog" role="dialog" aria-modal="true" aria-labelledby="redo-dialog-title"><button className="icon-btn modal-close" aria-label="Close" onClick={closeRedoComparison}><X size={17} /></button><h2 id="redo-dialog-title">Redo LLM annotation</h2><p className="redo-description">The current annotation stays saved until you accept the new one.</p>{redoComparison.error && <div className="llm-row-error" role="alert">{redoComparison.error}</div>}<label className="redo-effort">Reasoning effort<select disabled={redoComparison.loading} value={reasoningEffort} onChange={(event) => setReasoningEffort(event.target.value as "low" | "medium" | "high")}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label><div className="redo-compare-table"><div className="redo-compare-heading"><span>Annotation field</span><span>Current annotation</span><span>{redoComparison.loading ? "New annotation · generating" : "New annotation"}</span></div>{COMPARE_FIELDS.map((field) => { const before = annotationFieldValues(redoComparison.original, field); const after = redoComparison.proposed ? annotationFieldValues(redoComparison.proposed, field) : []; const changed = Boolean(redoComparison.proposed) && JSON.stringify(before) !== JSON.stringify(after); return <div className={`redo-compare-field ${changed ? "has-difference" : ""}`} key={field}><strong>{field}{changed && <small>Changed</small>}</strong><div className="redo-compare-values">{before.map((value, index) => <span className={`redo-compare-value ${changed && !after.includes(value) ? "different" : ""}`} key={`${index}-${value}`}>{value}</span>)}</div><div className="redo-compare-values">{redoComparison.loading ? <span className="redo-loading-state"><LoaderCircle size={14} /> Generating…</span> : after.map((value, index) => <span className={`redo-compare-value ${changed && !before.includes(value) ? "different" : ""}`} key={`${index}-${value}`}>{value}</span>)}</div></div>; })}</div><div className="dialog-actions redo-dialog-actions">{redoComparison.loading ? <button className="dialog-secondary" onClick={closeRedoComparison}>Cancel</button> : redoComparison.proposed ? <><button className="dialog-secondary" onClick={closeRedoComparison}>Reject</button><button className="dialog-primary" onClick={acceptRedoAnnotation}>Accept new annotation</button></> : <><button className="dialog-secondary" onClick={closeRedoComparison}>Close</button><button className="dialog-primary" onClick={() => void generateRedoComparison()}>{redoComparison.error ? "Retry generation" : "Start generation"}</button></>}</div></section></div>}
      {copyLlmConfirmOpen && active && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCopyLlmConfirmOpen(false); }}><section className="profile-dialog" role="dialog" aria-modal="true" aria-labelledby="copy-llm-title"><button className="icon-btn modal-close" aria-label="Close confirmation" onClick={() => setCopyLlmConfirmOpen(false)}><X size={17} /></button><h2 id="copy-llm-title">Replace {activeProfile.name}’s annotation?</h2><p>This will replace {activeProfile.name}’s saved annotation for this message with the currently selected LLM annotation, including its note.</p><div className="dialog-actions"><button className="dialog-secondary" onClick={() => setCopyLlmConfirmOpen(false)}>Cancel</button><button className="dialog-primary" onClick={replaceHumanWithCurrentLlm}>Replace annotation</button></div></section></div>}
      {profileDialog && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setProfileDialog(null); }}><section className="profile-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-dialog-title"><button className="icon-btn modal-close" aria-label="Close" onClick={() => setProfileDialog(null)}><X size={17} /></button><h2 id="profile-dialog-title">{profileDialog === "create" ? "Create annotator profile" : profileDialog === "rename" ? "Edit annotator profile" : "Remove annotator profile"}</h2>{profileDialogError && <p className="sample-error" role="alert">{profileDialogError}</p>}{profileDialog === "remove" ? <><p>Remove <b>{activeProfile.name}</b> and its locally saved annotations?</p><p className="modal-warning">This cannot be undone.</p><div className="dialog-actions"><button className="dialog-secondary" disabled={profileDialogBusy} onClick={() => setProfileDialog(null)}>Cancel</button><button className="dialog-danger" disabled={profileDialogBusy} onClick={submitProfileDialog}>{profileDialogBusy ? "Removing…" : "Remove profile"}</button></div></> : <form onSubmit={(event) => { event.preventDefault(); void submitProfileDialog(); }}><label>Profile name<input autoFocus maxLength={48} disabled={profileDialogBusy} value={profileName} onChange={(event) => setProfileName(event.target.value)} placeholder="e.g. Annotator 2" /></label><div className="dialog-actions"><button type="button" className="dialog-secondary" disabled={profileDialogBusy} onClick={() => setProfileDialog(null)}>Cancel</button><button className="dialog-primary" disabled={profileDialogBusy || !profileName.trim()}>{profileDialogBusy ? "Saving…" : profileDialog === "create" ? "Create profile" : "Save changes"}</button></div></form>}</section></div>}
      {promptDialog && <div className="prompt-sheet-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) void closePromptEditor(); }}><section className="prompt-sheet" role="dialog" aria-modal="true" aria-labelledby="prompt-sheet-title"><header className="prompt-sheet-header"><h2 id="prompt-sheet-title">{promptDialog === "personReference" ? "Referent eligibility criteria" : ANNOTATION_PROMPT_DIMENSIONS.find((dimension) => dimension.key === promptDialog)?.title}</h2><button className="icon-btn" aria-label="Close prompt editor" onClick={() => void closePromptEditor()}><X size={18} /></button></header><label className="prompt-editor-label" htmlFor="annotation-prompt-editor">{promptDialog === "personReference" ? "Eligibility criteria" : "Prompt text"}</label>{promptDialog === "personReference" && <p className="prompt-editor-help">These criteria guide GPT-6-Luna’s referent inventory for messages labeled Yes by MSD1. MSD1 supplies the Contains CTPs label; GPT-6-Luna does not decide or change that label.</p>}<textarea id="annotation-prompt-editor" className="prompt-editor" autoFocus maxLength={50000} disabled={!promptLoaded} value={promptDraft} onChange={(event) => { promptDraftRef.current = event.target.value; setPromptDraft(event.target.value); setPromptStatus("saving"); setPromptError(""); }} placeholder={promptLoaded ? "Write the annotation prompt…" : "Loading shared prompt…"} />{promptError && <p className="prompt-editor-error" role="alert">{promptError}</p>}<footer className="prompt-sheet-footer"><span className={`prompt-save-status ${promptStatus === "error" ? "has-error" : ""}`} aria-live="polite">{promptStatus === "loading" ? "Loading shared prompt…" : promptStatus === "saving" ? "Saving changes…" : promptStatus === "error" ? promptError || "Could not save prompt." : "All changes saved"}</span>{promptStatus === "error" && <button className="prompt-retry" onClick={() => promptDialog && (promptLoaded ? void persistSharedPrompt(promptDialog, promptDraft) : void loadSharedPrompts(promptDialog))}>Retry</button>}<span className="prompt-char-count">{promptDraft.length.toLocaleString()} / 50,000</span></footer></section></div>}
      {promptDownloadOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPromptDownloadOpen(false); }}><section className="profile-dialog prompt-download-dialog" role="dialog" aria-modal="true" aria-labelledby="prompt-download-title"><button className="icon-btn modal-close" aria-label="Close prompt downloads" onClick={() => setPromptDownloadOpen(false)}><X size={17} /></button><h2 id="prompt-download-title">Download LLM prompts</h2><p className="sample-description">Download the current prompts or choose an older saved set. Prompt changes and LLM batch runs are kept as snapshots.</p>{promptDownloadLoading && <div className="loading-state"><LoaderCircle size={15} className="spin" /> Loading prompt history…</div>}{promptDownloadError && <p className="sample-error" role="alert">{promptDownloadError}</p>}{!promptDownloadLoading && promptDownloadCurrent && <><label>Filter saved versions<input type="search" value={promptDownloadSearch} onChange={(event) => setPromptDownloadSearch(event.target.value)} placeholder="Search date, name, or source…" /></label><label>Prompt set<select value={promptDownloadSelected} onChange={(event) => setPromptDownloadSelected(event.target.value)}><option value="current">Current saved prompts</option>{promptDownloadVersions.filter((version) => `${version.label} ${version.source} ${version.savedAt} ${version.promptVersion ?? ""}`.toLowerCase().includes(promptDownloadSearch.trim().toLowerCase())).map((version) => <option key={version.id} value={version.id}>{version.savedAt ? new Date(version.savedAt).toLocaleString() : "Date unavailable"} · {version.label} · {version.source}</option>)}</select></label>{promptDownloadSelected !== "current" && (() => { const version = promptDownloadVersions.find((item) => item.id === promptDownloadSelected); return version ? <div className="prompt-download-version"><b>{version.label}</b><span>{version.source}{version.savedAt ? ` · ${new Date(version.savedAt).toLocaleString()}` : ""}</span><small>{version.promptVersion ?? "Prompt version unavailable"}</small></div> : null; })()}</>}<div className="dialog-actions"><button type="button" className="dialog-secondary" onClick={() => setPromptDownloadOpen(false)}>Close</button><button type="button" className="dialog-primary" disabled={promptDownloadLoading || !promptDownloadCurrent} onClick={downloadPromptSet}><Download size={13} /> Download TXT</button></div></section></div>}
      {evaluationDialogOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !listsLoading && !stabilityProgress.active && !batchRun.active) setEvaluationDialogOpen(false); }}><section className="profile-dialog conversation-lists-dialog evaluation-dialog" role="dialog" aria-modal="true" aria-labelledby="list-evaluation-title"><button className="icon-btn modal-close" aria-label="Close list evaluation" disabled={stabilityProgress.active || batchRun.active} onClick={() => setEvaluationDialogOpen(false)}><X size={17} /></button><h2 id="list-evaluation-title">Evaluation</h2>{listsError && <p className="sample-error" role="status">{listsError}</p>}<div className="conversation-list-items"><article className="conversation-list-item evaluation-list-item"><div className="conversation-list-item-head"><div><b>All LLM Annotated (fully)</b><span>{sharedAnnotationIndexReady ? `${llmReviewIds.full.length.toLocaleString()} annotation records` : "Loading shared annotations…"}</span></div></div><div className="conversation-list-actions"><button className="dialog-secondary" disabled={!sharedAnnotationIndexReady || llmReviewIds.full.length === 0 || listsLoading} onClick={() => openFullyAnnotatedEvaluation("llm")}>Compare annotations</button><button className="dialog-primary" disabled={!sharedAnnotationIndexReady || !llmReviewIds.full.length || stabilityProgress.active || batchRun.active || llmBusyId !== null} onClick={() => openAggregateBatch("llm")}>LLM batch re-annotate</button></div></article><article className="conversation-list-item evaluation-list-item"><div className="conversation-list-item-head"><div><b>All LLM + At Least One Human Annotated (fully)</b><span>{sharedAnnotationIndexReady ? `${llmAndAnyHumanIds.length.toLocaleString()} annotation records` : "Loading shared annotations…"}</span></div></div><div className="conversation-list-actions"><button className="dialog-secondary" disabled={!sharedAnnotationIndexReady || llmAndAnyHumanIds.length === 0 || listsLoading} onClick={() => openFullyAnnotatedEvaluation("llm-human")}>Compare annotations</button><button className="dialog-primary" disabled={!sharedAnnotationIndexReady || !llmAndAnyHumanIds.length || stabilityProgress.active || batchRun.active || llmBusyId !== null} onClick={() => openAggregateBatch("llm-human")}>LLM batch re-annotate</button></div></article>{listsLoading ? <ConversationListsSkeleton /> : conversationLists.length ? conversationLists.map((list) => <article className="conversation-list-item evaluation-list-item" key={list.id}><div className="conversation-list-item-head"><div><b>{list.name}</b><span>{list.conversationIds.length} conversation{list.conversationIds.length === 1 ? "" : "s"}</span></div></div><div className="conversation-list-actions"><button className="dialog-secondary" disabled={!list.conversationIds.length || listsLoading} onClick={() => void openListHistory(list)}>Compare annotations</button><button className="dialog-secondary" disabled={!list.conversationIds.length || stabilityProgress.active || batchRun.active || llmBusyId !== null} onClick={() => openStabilityTest(list)}>Test stability</button><button className="dialog-primary" disabled={!list.conversationIds.length || stabilityProgress.active || batchRun.active || llmBusyId !== null} onClick={() => openListBatch(list)}>LLM batch re-annotate</button></div></article>) : !listsLoading && <div className="empty-state"><b>No lists to evaluate</b><span>Create a conversation list first, then return here to compare or test it.</span></div>}</div></section></div>}
      {listsDialogOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !listsLoading) setListsDialogOpen(false); }}><section className="profile-dialog conversation-lists-dialog" role="dialog" aria-modal="true" aria-labelledby="conversation-lists-title"><button className="icon-btn modal-close" aria-label="Close conversation lists" disabled={listsLoading} onClick={() => setListsDialogOpen(false)}><X size={17} /></button><h2 id="conversation-lists-title">Conversation lists</h2><div className="conversation-list-create"><label>List name<input value={newListName} maxLength={100} onChange={(event) => setNewListName(event.target.value)} placeholder="e.g. Co-author review" /></label><label>Conversation IDs<textarea value={newListConversationIds} onChange={(event) => setNewListConversationIds(event.target.value)} placeholder="Paste one or more conversation IDs, separated by spaces or new lines" rows={3} /></label><div className="list-create-actions"><button type="button" className="dialog-secondary" disabled={!selectedIds.length || listsLoading} onClick={() => { const chosen = new Set(selectedIds); const ids = [...new Set((payload?.items ?? []).filter((row) => chosen.has(row.id)).map((row) => row.sourceConversationId))]; setNewListConversationIds((current) => [...new Set([...current.split(/[\s,;]+/).filter(Boolean), ...ids])].join("\n")); }}>{selectedIds.length ? `Use ${selectedIds.length} selected message${selectedIds.length === 1 ? "" : "s"}` : "Use selected messages"}</button><button type="button" className="dialog-primary" disabled={listsLoading || !newListName.trim()} onClick={() => void createConversationList()}>Create list</button></div></div>{listsError && <p className="sample-error" role="status">{listsError}</p>}<div className="conversation-list-items">{listsLoading ? <ConversationListsSkeleton /> : conversationLists.length ? conversationLists.map((list) => { const editingEntries = editingEntriesListId === list.id; const editIds = editingEntries ? [...new Set(editingListEntries.split(/[\s,;]+/).map((id) => id.trim()).filter(Boolean))] : []; const rawEditIdCount = editingEntries ? editingListEntries.split(/[\s,;]+/).map((id) => id.trim()).filter(Boolean).length : 0; const matchesById = new Map((listIdMatches ?? []).map((match) => [match.conversationId, match])); return <article className="conversation-list-item" key={list.id}><div className="conversation-list-item-head">{editingListId === list.id ? <form className="conversation-list-rename" onSubmit={(event) => { event.preventDefault(); void saveConversationListName(list); }}><input aria-label={`New name for ${list.name}`} autoFocus maxLength={100} value={editingListName} onChange={(event) => setEditingListName(event.target.value)} /><button type="submit" className="dialog-primary" disabled={listsLoading || !editingListName.trim()}>Save</button><button type="button" className="dialog-secondary" disabled={listsLoading} onClick={() => { setEditingListId(""); setEditingListName(""); }}>Cancel</button></form> : <><div><b>{list.name}</b><span>{list.conversationIds.length} conversation{list.conversationIds.length === 1 ? "" : "s"}</span></div><button type="button" className="icon-btn tiny" aria-label={`Rename ${list.name}`} title="Rename list" disabled={listsLoading} onClick={() => beginRenameList(list)}><Pencil size={14} /></button><button type="button" className="icon-btn tiny" aria-label={`Delete ${list.name}`} disabled={listsLoading} onClick={() => void deleteConversationList(list)}><Trash2 size={14} /></button></>}</div><details><summary>Show conversation IDs</summary><code>{list.conversationIds.join("\n") || "This list is empty."}</code></details>{editingEntries && <div className="list-entries-editor"><label htmlFor={`list-entries-${list.id}`}>Conversation IDs <small>One ID per line. Repeated IDs are collapsed when saved.</small></label><textarea id={`list-entries-${list.id}`} value={editingListEntries} onChange={(event) => { setEditingListEntries(event.target.value); setListIdMatches(null); setListIdMissing([]); }} rows={Math.min(12, Math.max(4, editIds.length))} spellCheck={false} /><div className="list-editor-count">{editIds.length} unique ID{editIds.length === 1 ? "" : "s"}{rawEditIdCount > editIds.length ? ` · ${rawEditIdCount - editIds.length} duplicate entr${rawEditIdCount - editIds.length === 1 ? "y" : "ies"} will be removed` : ""}</div>{listIdMatches && <div className="list-id-inspection" aria-live="polite">{editIds.map((id) => { const match = matchesById.get(id); const ambiguous = Boolean(match && match.indexedConversations > 1); return <div className={`list-id-result ${ambiguous ? "ambiguous" : ""} ${!match ? "unmatched" : ""}`} key={id}><code title={id}>{id}</code><span>{!match ? "Not found in the active index" : <>{match.requesterMessages.toLocaleString()} requester message{match.requesterMessages === 1 ? "" : "s"} · {match.indexedConversations.toLocaleString()} indexed conversation{match.indexedConversations === 1 ? "" : "s"}{ambiguous ? " · ambiguous ID" : ""}</>}</span><button type="button" aria-label={`Remove ID ${id}`} title="Remove this ID" disabled={listsLoading} onClick={() => { setEditingListEntries((current) => current.split(/[\s,;]+/).filter((value) => value && value !== id).join("\n")); setListIdMatches(null); setListIdMissing([]); }}><X size={14} /></button></div>; })}{listIdMissing.length > 0 && <small>{listIdMissing.length} ID{listIdMissing.length === 1 ? " was" : "s were"} not found in the active index.</small>}</div>}<div className="list-editor-actions"><button type="button" className="dialog-secondary" disabled={checkingListIds || listsLoading || !editIds.length} onClick={() => void inspectEditedListIds()}>{checkingListIds ? "Checking…" : "Check IDs"}</button><button type="button" className="dialog-secondary" disabled={listsLoading} onClick={() => { setEditingEntriesListId(""); setEditingListEntries(""); setListIdMatches(null); setListIdMissing([]); }}>Cancel</button><button type="button" className="dialog-primary" disabled={listsLoading || editIds.length > 5000} onClick={() => void saveConversationListEntries(list)}>Save IDs</button></div></div>}<div className="conversation-list-actions"><button className="dialog-secondary" onClick={() => editingEntries ? (setEditingEntriesListId(""), setEditingListEntries(""), setListIdMatches(null), setListIdMissing([])) : beginEditListEntries(list)}>{editingEntries ? "Close editor" : "Edit IDs"}</button><button className="dialog-secondary" disabled={!selectedIds.length || listsLoading} onClick={() => void addSelectedConversationsToList(list)}>Add selected</button></div></article>; }) : !listsLoading && <div className="empty-state"><b>No conversation lists yet</b><span>Create one with IDs or add selected conversations.</span></div>}</div></section></div>}
      {stabilityDialogOpen && stabilityTarget && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !stabilityProgress.active) setStabilityDialogOpen(false); }}><section className="profile-dialog stability-dialog" role="dialog" aria-modal="true" aria-labelledby="stability-dialog-title"><button className="icon-btn modal-close" aria-label="Close stability test" disabled={stabilityProgress.active} onClick={() => setStabilityDialogOpen(false)}><X size={17} /></button><h2 id="stability-dialog-title">Test stability · {stabilityTarget.name}</h2><p className="sample-description">Each message is run 10 times by default with a frozen prompt and human-label snapshot. The paired diagnostic supplies the human referent inventory to downstream stages. Exports include exact stage payloads and responses.</p><div className="stability-settings"><label>Repetitions<input type="number" min="2" max="20" step="1" disabled={stabilityProgress.active} value={stabilityRepetitions} onChange={(event) => setStabilityRepetitions(event.target.value)} /><small>Choose 2–20 runs per message. Both conditions use the same prompts, model and effort.</small></label><label>Reasoning effort<select disabled={stabilityProgress.active} value={reasoningEffort} onChange={(event) => setReasoningEffort(event.target.value as "low" | "medium" | "high")}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label></div>{stabilityProgress.active && <div className="batch-progress"><div className="batch-progress-copy" aria-live="polite">{stabilityProgress.preparing ? "Preparing list and prompt snapshot…" : `Repetition ${Math.min(Math.max(1, stabilityProgress.repetition), Number(stabilityRepetitions))} of ${stabilityRepetitions} · ${stabilityProgress.completed} of ${stabilityProgress.total} messages · ${stabilityProgress.failed} failed`}</div><div className={`batch-progress-track ${stabilityProgress.preparing ? "indeterminate" : ""}`} role="progressbar" aria-label="Stability analysis progress" aria-valuemin={0} aria-valuemax={stabilityProgress.total || 100} aria-valuenow={stabilityProgress.preparing ? 0 : stabilityProgress.completed}><span style={{ width: stabilityProgress.preparing ? "32%" : `${stabilityProgress.total ? stabilityProgress.completed / stabilityProgress.total * 100 : 0}%` }} /></div></div>}{stabilityProgress.error && <p className="sample-error" role="alert">{stabilityProgress.error}</p>}{stabilityProgress.errors.length > 0 && <ul className="batch-errors" role="alert">{stabilityProgress.errors.map((error, index) => <li key={`${index}-${error}`}>{error}</li>)}</ul>}{stabilityResult && stabilityMetrics && <div className="stability-results"><div className="stability-result-meta"><span>{stabilityResult.runs.length} of {stabilityResult.repetitions} repetitions completed</span><span>{stabilityResult.recordIds.length} messages · {stabilityResult.reasoningEffort} effort</span></div><div className="stability-metric-grid"><div><span>Overall pairwise agreement</span><b>{stabilityMetrics.agreement == null ? "—" : `${stabilityMetrics.agreement.toFixed(1)}%`}</b><small>Across complete annotation outputs</small></div><div><span>Fully stable messages</span><b>{stabilityMetrics.comparableEntries ? `${stabilityMetrics.stableEntries} / ${stabilityMetrics.comparableEntries}` : "—"}</b><small>{stabilityMetrics.comparableEntries ? `${Math.round(stabilityMetrics.stableEntries / stabilityMetrics.comparableEntries * 100)}% identical on every category` : "Need two successful repetitions"}</small></div><div><span>Failed requests</span><b>{stabilityResult.runs.reduce((sum, run) => sum + run.failed, 0)}</b><small>{stabilityResult.runs.reduce((sum, run) => sum + run.succeeded, 0)} successful annotations</small></div><div><span>Human-inventory downstream agreement</span><b>{stabilityDiagnosticMetrics?.percent == null ? "—" : `${stabilityDiagnosticMetrics.percent.toFixed(1)}%`}</b><small>{stabilityDiagnosticMetrics?.comparableMessages ?? 0} messages scored · {stabilityDiagnosticMetrics?.excludedMessages ?? 0} incomplete human labels excluded</small></div></div>{stabilityResult.runs.length >= 2 ? <><StabilityChart result={stabilityResult} visible={stabilityVisibleCategories} hovered={stabilityHoveredRepeat} onHover={setStabilityHoveredRepeat} onToggle={(category) => setStabilityVisibleCategories((current) => current.includes(category) ? current.filter((item) => item !== category) : [...current, category])} /><div className="stability-category-results">{STABILITY_CATEGORIES.map((category) => { const value = stabilityAgreement(stabilityResult, category, stabilityResult.runs.length); return <div key={category}><i style={{ background: STABILITY_COLORS[category] }} /><span>{category}</span><b>{value == null ? "—" : `${value.toFixed(1)}%`}</b></div>; })}</div><small className="stability-method-note">Pairwise stability compares successful end-to-end outputs. The diagnostic holds the human referent inventory fixed and scores downstream labels only. Missing human fields are excluded. Optional names and descriptions are excluded.</small></> : <div className="empty-state"><b>More results are needed for comparison</b><span>At least two repetitions must complete successfully.</span></div>}</div>}<div className="dialog-actions">{stabilityProgress.active ? <button type="button" className="dialog-secondary" onClick={cancelStabilityTest}>Cancel run</button> : <button type="button" className="dialog-secondary" onClick={() => setStabilityDialogOpen(false)}>Close</button>}{!stabilityProgress.active && stabilityResult && <button type="button" className="dialog-secondary" onClick={downloadStabilityCsv}><Download size={13} /> Export CSV</button>}{!stabilityProgress.active && <button type="button" className="dialog-primary" disabled={!stabilityTarget.conversationIds.length || !Number(stabilityRepetitions) || stabilityProgress.preparing} onClick={() => void runStabilityTest()}>{stabilityResult ? "Run again" : "Start test"}</button>}</div></section></div>}
      {historyList && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setHistoryList(null); }}><section className="profile-dialog list-history-dialog" role="dialog" aria-modal="true" aria-labelledby="list-history-title"><button className="icon-btn modal-close" aria-label="Close list statistics" onClick={() => setHistoryList(null)}><X size={17} /></button><header className="list-history-heading"><h2 id="list-history-title">{historyList.name} · Annotation comparison</h2><div className="list-history-actions"><button className="dialog-secondary" disabled={!compareFromVersion || compareFromVersion.source !== "llm" || !compareToVersion || compareToVersion.source !== "human" || historyLoading} onClick={downloadHistoryComparisonCsv}><Download size={13} /> Export CSV</button><button className="dialog-secondary" disabled={!historyRuns.length} onClick={() => setFullHistoryOpen(true)}>Run history</button></div></header><p className="sample-description">Choose an LLM snapshot and a human reviewer. The list below shows the requester message and annotation differences for every conversation. Referent names and descriptions are shown for context but excluded from agreement scores, which compare unordered type and identifiability labels.</p>{historyLoading && <div className="loading-state"><LoaderCircle size={15} className="spin" /> Loading annotations and messages…</div>}{historyError && <p className="sample-error" role="alert">{historyError}</p>}{!historyLoading && !historyError && <><div className="history-version-selectors"><label>LLM annotation<select value={historyCompareFrom} onChange={(event) => setHistoryCompareFrom(event.target.value)}><option value="">Select an LLM version</option>{historyVersions.filter((version) => version.source === "llm").map((version) => <option key={version.key} value={version.key}>{version.label}</option>)}</select></label><ArrowRight size={16} /><label>Human reviewer<select value={historyCompareTo} onChange={(event) => setHistoryCompareTo(event.target.value)}><option value="">Select a human reviewer</option>{historyVersions.filter((version) => version.source === "human").map((version) => <option key={version.key} value={version.key}>{version.label}</option>)}</select></label></div>{historyVersions.filter((version) => version.source === "llm").length === 0 && <div className="empty-state"><b>No LLM annotations are available</b><span>Current or historical LLM annotations for this list will appear here.</span></div>}{historyVersions.filter((version) => version.source === "human").length === 0 && <div className="empty-state"><b>No human annotations are available</b><span>Human annotations for this list will appear here.</span></div>}{compareFromVersion?.source === "llm" && compareToVersion?.source === "human" && <><div className="history-run-overview"><span><b>{comparedChangedItems.length}</b> conversations differ</span><span>{comparedScoredItems.length} conversations scored · incomplete fields excluded</span><span>{comparedHistoryItems.length} conversations in this list</span></div><div className="history-category-grid">{HISTORY_COMPARISON_CATEGORIES.map((category) => { const comparable = comparedHistoryItems.filter((item) => comparableHistoryCategories(item).includes(category)); const changed = comparable.filter((item) => changedAnnotationCategories(item).includes(category)).length; return <div key={category}><span>{category}</span><b>{changed} / {comparable.length}</b><small>{comparable.length ? `${Math.round(changed / comparable.length * 100)}% differ` : "No comparable annotations"}</small></div>; })}</div><div className="history-conversation-list">{comparedHistoryItems.map((item) => { const allChanged = changedHistoryCategories(item); const changed = changedAnnotationCategories(item); const notesDiffer = allChanged.includes("Notes"); const missing = !item.previous || !item.annotation; const scoreEligible = comparableHistoryCategories(item).some((category) => category !== "Notes"); return <article className={`history-conversation-row ${missing || !scoreEligible ? "missing" : changed.length ? "differs" : "matches"}`} key={item.recordId}><header><div><b>{item.conversationId}</b><small>{item.recordId} · requester turn {item.turnIndex + 1}</small></div><strong>{missing ? `${item.previous ? "Missing human annotation" : item.annotation ? "Missing LLM annotation" : "No annotations"}` : !scoreEligible ? "Incomplete annotation · excluded from score" : changed.length ? `Differs · ${changed.length} categor${changed.length === 1 ? "y" : "ies"}` : notesDiffer ? "Matches · notes differ" : "Matches"}</strong></header><p className="history-message-preview">{item.messageText || "Requester message text is unavailable."}</p><details><summary>View full requester message</summary><p className="history-message-full">{item.messageText || "Requester message text is unavailable."}</p></details><details><summary>Compare annotation fields</summary>{allChanged.length ? allChanged.map((category) => <div className="history-conversation-diff" key={category}><b>{category}</b><span><strong>LLM</strong>{displayHistoryCategory(item.previous, category)}</span><span><strong>{compareToVersion.label.replace(/^Human · /, "").replace(/ \(\d+\)$/, "")}</strong>{displayHistoryCategory(item.annotation, category)}</span></div>) : <p className="history-conversation-no-diff">{missing ? "One annotation is missing, so this conversation cannot be compared." : !scoreEligible ? "Required annotation fields are missing, so this conversation is excluded from the score." : "No field differences."}</p>}</details></article>; })}</div></>}</>}</section></div>}{fullHistoryOpen && historyList && <div className="modal-backdrop history-timeline-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setFullHistoryOpen(false); }}><section className="profile-dialog list-history-dialog history-timeline-dialog" role="dialog" aria-modal="true" aria-labelledby="history-timeline-title"><button className="icon-btn modal-close" aria-label="Close full history" onClick={() => setFullHistoryOpen(false)}><X size={17} /></button><header className="list-history-heading"><h2 id="history-timeline-title">{historyList.name} · Full history</h2><button className="dialog-secondary" onClick={() => setFullHistoryOpen(false)}>Back to comparison</button></header><p className="sample-description">Chronological annotation runs, prompt edits, and the percentage of comparable entries that changed.</p><div className="history-timeline">{historyRuns.map((run, index) => { const prior = historyRuns[index - 1]; const comparable = run.items.filter((item) => item.previous); const changed = comparable.filter((item) => changedAnnotationCategories(item).length > 0).length; const percentage = comparable.length ? Math.round(changed / comparable.length * 100) : 0; const promptEdits = prior ? [...ANNOTATION_PROMPT_DIMENSIONS.filter((dimension) => run.prompts[dimension.key] !== prior.prompts[dimension.key]).map((dimension) => dimension.label), ...((run.prompts.personReferenceCriteria ?? run.prompts.personReferencePrompt ?? run.prompts.relevancePrompt) !== (prior.prompts.personReferenceCriteria ?? prior.prompts.personReferencePrompt ?? prior.prompts.relevancePrompt) ? ["Referent eligibility criteria"] : [])] : []; return <article className="history-timeline-event" key={run.id}><span className="history-timeline-marker" /><div className="history-timeline-card"><header><div><b>{new Date(run.startedAt).toLocaleString()}</b><small>{run.completedAt ? `Completed ${new Date(run.completedAt).toLocaleString()}` : "Completion time unavailable"} · {run.reasoningEffort} effort</small></div><strong>{changed} / {comparable.length} changed · {percentage}%</strong></header><div className="history-timeline-bar"><span style={{ width: `${percentage}%` }} /></div><p>{run.succeeded} annotated · {run.failed} failed{run.cancelled ? " · cancelled" : ""}</p><p><b>Prompt edits:</b> {prior ? promptEdits.length ? promptEdits.join(", ") : "None" : "Baseline run"}</p><details><summary>Changed categories</summary><div>{HISTORY_COMPARISON_CATEGORIES.map((category) => { const count = comparable.filter((item) => changedAnnotationCategories(item).includes(category)).length; return <span key={category}>{category}: {count}/{comparable.length}</span>; })}</div></details></div></article>; })}</div></section></div>}{batchDialogOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !batchRun.active) setBatchDialogOpen(false); }}><section className="profile-dialog sample-dialog batch-annotate-dialog" role="dialog" aria-modal="true" aria-label={listBatchTarget ? `LLM batch re-annotate ${listBatchTarget.name}` : "LLM random sample annotation"}><button className="icon-btn modal-close" aria-label="Close batch annotation" disabled={batchRun.active} onClick={() => { setBatchDialogOpen(false); setListBatchTarget(null); setListBatchRecordIds(null); }}><X size={17} /></button>{listBatchTarget ? <div className="sample-scope list-batch-scope"><b>{listBatchTarget.name}</b><span>{listBatchRecordIds ? `${listBatchRecordIds.length.toLocaleString()} exact requester messages will be checked against MSD1; only messages labeled Yes are re-annotated.` : `${listBatchTarget.conversationIds.length} conversation IDs. Only the first requester message from each conversation will be re-annotated.`}</span></div> : <><label>Sample from<select disabled={batchRun.active} value={batchAnnotationScope} onChange={(event) => setBatchAnnotationScope(event.target.value as BatchAnnotationScope)}><option value="paper_frame">Paper frame (≥90% English) · 308,962</option><option value="all_humans">Any human annotation · {sharedAnnotationIndexReady ? formatNumber(allHumanAnnotatedIds.length) : "loading"}</option><option value="two_or_more_humans">≥2 Humans Annotated · {sharedAnnotationIndexReady ? formatNumber(humanAtLeastTwoIds.length) : "loading"}</option>{humanAnnotatorNames.map((name) => <option key={name} value={`annotator:${name}`}>{name} Annotated · {sharedAnnotationIndexReady ? formatNumber(humanAnnotationIdsByAnnotator[name]?.length ?? 0) : "loading"}</option>)}</select></label><label>MSD1 CTP outcome<select disabled={batchRun.active} value={batchCtpSelection} onChange={(event) => setBatchCtpSelection(event.target.value as "" | "yes")}><option value="">All outcomes (No/Unclear skipped)</option><option value="yes">Contains CTPs only · 200,829 in paper frame</option></select></label><div className="sample-scope">{batchCtpSelection === "yes" ? "Only messages labeled Yes by MSD1 will be sampled." : "No and Unclear messages in the sample will be skipped and reported before annotation."}</div><div className="sample-scope">{batchAnnotationScope === "paper_frame" ? "Paper frame: ≥90% English · 308,962 first messages" : sharedAnnotationIndexReady ? `${batchHumanScopeLabel}: ${formatNumber(batchHumanSampleIds?.length ?? 0)} messages · same partial and full human queues as the sidebar` : "Loading saved human annotation queues…"}</div><label>Number to annotate<input disabled={batchRun.active} type="number" min="1" max="5000" step="1" value={batchSampleN} onChange={(event) => setBatchSampleN(event.target.value)} /></label><label>Seed<input disabled={batchRun.active} value={sampleSeed} maxLength={200} onChange={(event) => setSampleSeed(event.target.value)} /></label><label className="skip-annotations-toggle"><input type="checkbox" disabled={batchRun.active} checked={skipAnnotated} onChange={(event) => setSkipAnnotated(event.target.checked)} /><span>Skip messages with existing LLM annotations?</span></label></>}<label>Reasoning effort<select disabled={batchRun.active} value={reasoningEffort} onChange={(event) => setReasoningEffort(event.target.value as "low" | "medium" | "high")}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label><label>Parallel requests<select disabled={batchRun.active} value={batchConcurrency} onChange={(event) => setBatchConcurrency(event.target.value as "1" | "2" | "5")}><option value="1">1×</option><option value="2">2×</option><option value="5">5×</option></select></label>{batchRun.active && <div className="batch-progress"><div className="batch-progress-copy" aria-live="polite">{batchRun.sampling ? (listBatchTarget ? (listBatchRecordIds ? "Preparing fully annotated messages…" : "Resolving conversation list…") : "Selecting a reproducible sample…") : `Message ${Math.min(batchRun.current, batchRun.total)} of ${batchRun.total} · ${batchRun.succeeded} annotated · ${batchRun.failed} failed · ${batchRun.skipped} skipped`}</div><div className={`batch-progress-track ${batchRun.sampling ? "indeterminate" : ""}`} role="progressbar" aria-label="Batch annotation progress" aria-valuemin={0} aria-valuemax={batchRun.total || 100} aria-valuenow={batchRun.sampling ? 0 : batchRun.completed}><span style={{ width: batchRun.sampling ? "32%" : `${batchRun.total ? (batchRun.completed / batchRun.total) * 100 : 0}%` }} /></div>{!batchRun.sampling && batchRun.completed > 0 && <small>Estimated time remaining: {formatDuration(((Date.now() - batchRun.startedAt) / batchRun.completed) * Math.max(0, batchRun.total - batchRun.completed))}</small>}</div>}{batchRun.cancelled && <p className="batch-result-note">Cancelled after {batchRun.completed} of {batchRun.total} messages. Finished annotations have been saved.</p>}{!batchRun.active && batchRun.total > 0 && !batchRun.cancelled && <p className="batch-result-note">Complete: {batchRun.succeeded} annotated, {batchRun.failed} failed, {batchRun.skipped} skipped.</p>}{batchRun.error && <p className="sample-error" role="alert">{batchRun.error}</p>}{batchRun.errors.length > 0 && <ul className="batch-errors" role="alert">{batchRun.errors.map((error, index) => <li key={`${index}-${error}`}>{error}</li>)}</ul>}<section className="llm-usage-summary" aria-label="GPT-6-Luna token usage"><div><span>Input tokens</span><strong>{llmUsage.inputTokens.toLocaleString()}</strong></div><div><span>Output tokens</span><strong>{llmUsage.outputTokens.toLocaleString()}</strong></div><div><span>Estimated cost</span><strong>${((llmUsage.inputTokens * 0.10 + llmUsage.outputTokens * 0.50) / 1_000_000).toFixed(6)}</strong></div><small>GPT-6-Luna · last reset {llmUsage.lastResetAt ? new Date(llmUsage.lastResetAt).toLocaleString() : "loading…"}</small><button type="button" className="usage-reset-button" disabled={usageResetBusy || batchRun.active} onClick={() => void resetLlmUsage()}>{usageResetBusy ? "Resetting…" : "Reset counter"}</button></section><div className="dialog-actions">{batchRun.active ? <button type="button" className="dialog-secondary" onClick={cancelBatchAnnotation}>Cancel annotation</button> : <button type="button" className="dialog-secondary" onClick={() => { setBatchDialogOpen(false); setListBatchTarget(null); setListBatchRecordIds(null); }}>{batchRun.total || batchRun.error ? "Close" : "Cancel"}</button>}{!batchRun.active && <button type="button" className="dialog-primary" disabled={listBatchTarget ? !(listBatchRecordIds?.length ?? listBatchTarget.conversationIds.length) : !Number(batchSampleN) || !sampleSeed.trim() || (batchAnnotationScope !== "paper_frame" && !sharedAnnotationIndexReady)} onClick={() => void (listBatchTarget ? annotateConversationList() : annotateRandomSample())}>{listBatchTarget ? "LLM re-annotate list" : "Start LLM annotation"}</button>}</div></section></div>}
      {sampleDialogOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !sampleLoading) setSampleDialogOpen(false); }}><section className="profile-dialog sample-dialog" role="dialog" aria-modal="true" aria-labelledby="sample-dialog-title"><button className="icon-btn modal-close" aria-label="Close" disabled={sampleLoading} onClick={() => setSampleDialogOpen(false)}><X size={17} /></button><h2 id="sample-dialog-title">Random sample</h2><p className="sample-description">Sample from the current search, selection and filters. Choose one CTP outcome or pool all outcomes; the same seed and settings produce the same records.</p><div className="sample-scope">Paper frame: ≥90% English · 308,962 first messages</div><label>CTP outcome<select value={sampleCtpLabel} onChange={(event) => setSampleCtpLabel(event.target.value as CtpLabel)}><option value="">All outcomes ({formatNumber(ctpCounts?.frameRecords ?? 308962)})</option><option value="yes">Contains CTPs ({formatNumber(ctpCounts?.counts.yes ?? 200829)})</option><option value="no">No CTPs ({formatNumber(ctpCounts?.counts.no ?? 105868)})</option><option value="unclear">CTPs Unclear ({formatNumber(ctpCounts?.counts.unclear ?? 2265)})</option></select></label><label>Number to sample<input type="number" min="1" max="5000" step="1" value={sampleN} onChange={(event) => setSampleN(event.target.value)} /></label><label>Seed<input value={sampleSeed} maxLength={200} onChange={(event) => setSampleSeed(event.target.value)} /></label><div className="sample-scope">Current selection: ≥90% English paper frame{query.trim() ? ` · search “${query.trim()}”` : ""}{filterCount ? ` · ${filterCount} filter${filterCount === 1 ? "" : "s"}` : ""}{statusScopeDescription ? ` · ${statusScopeDescription}` : ""} · CTP outcome: {sampleCtpLabel === "yes" ? "Contains CTPs" : sampleCtpLabel === "no" ? "No CTPs" : sampleCtpLabel === "unclear" ? "CTPs Unclear" : "all outcomes"}</div>{sampleError && <p className="sample-error" role="alert">{sampleError}</p>}<div className="dialog-actions"><button type="button" className="dialog-secondary" disabled={sampleLoading} onClick={() => setSampleDialogOpen(false)}>Cancel</button><button type="button" className="dialog-primary" disabled={sampleLoading || !Number(sampleN) || !sampleSeed.trim()} onClick={() => void downloadSample()}>{sampleLoading ? "Preparing…" : "Download CSV"}</button></div></section></div>}
    </section>
  </main>;
}

function isTyping(target: EventTarget | null) { return target instanceof HTMLElement && (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable); }
