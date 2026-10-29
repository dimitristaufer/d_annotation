const STATUS_MODES = new Set(["partial", "full", "llm_human", "llm_all_humans", "human_2plus"]);
const HUMAN_REVIEW_STATUS_PREFIX = "llm_human:";
const HUMAN_ANNOTATION_STATUS_PREFIX = "human:";

function normalizeAnnotatorName(name) {
  return name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en");
}

/**
 * @template TAnnotation
 * @param {Record<string, Record<string, TAnnotation>>} annotationsByRecord
 * @param {string[]} profileNames
 * @returns {Record<string, Record<string, TAnnotation>>}
 */
export function filterHumanAnnotationsToProfiles(annotationsByRecord, profileNames) {
  const activeNames = new Set(profileNames.map(normalizeAnnotatorName));
  const filtered = {};
  for (const [recordId, annotations] of Object.entries(annotationsByRecord)) {
    const activeAnnotations = {};
    for (const [name, annotation] of Object.entries(annotations ?? {})) {
      if (activeNames.has(normalizeAnnotatorName(name))) activeAnnotations[name] = annotation;
    }
    if (Object.keys(activeAnnotations).length) filtered[recordId] = activeAnnotations;
  }
  return filtered;
}

export function humanReviewStatusMode(annotatorName) {
  return `${HUMAN_REVIEW_STATUS_PREFIX}${annotatorName}`;
}

export function humanAnnotationStatusMode(annotatorName) {
  return `${HUMAN_ANNOTATION_STATUS_PREFIX}${annotatorName}`;
}

export function isReviewStatusMode(mode) {
  return STATUS_MODES.has(mode) || mode.startsWith(HUMAN_REVIEW_STATUS_PREFIX) || mode.startsWith(HUMAN_ANNOTATION_STATUS_PREFIX);
}

export function searchNeedsAnnotationSnapshot(mode, annotationFiltersActive) {
  return mode === "todo" || isReviewStatusMode(mode) || annotationFiltersActive;
}

/**
 * @template TAnnotation
 * @param {Record<string, Record<string, TAnnotation>>[]} annotationSources
 * @param {string} annotatorName
 * @param {(annotation: TAnnotation) => boolean} isAnnotated
 * @returns {string[]}
 */
export function idsAnnotatedByHuman(annotationSources, annotatorName, isAnnotated) {
  const targetName = normalizeAnnotatorName(annotatorName);
  const ids = new Set();
  for (const source of annotationSources) {
    for (const [id, byAnnotator] of Object.entries(source)) {
      const matchingAnnotation = Object.entries(byAnnotator ?? {}).find(([name]) => normalizeAnnotatorName(name) === targetName)?.[1];
      if (matchingAnnotation !== undefined && isAnnotated(matchingAnnotation)) ids.add(id);
    }
  }
  return [...ids];
}

export function idsWithAtLeastTwoAnnotators(annotationSources, isAnnotated) {
  const annotatorsById = new Map();
  for (const source of annotationSources) {
    for (const [id, annotations] of Object.entries(source)) {
      for (const [name, annotation] of Object.entries(annotations ?? {})) {
        if (!isAnnotated(annotation)) continue;
        let annotators = annotatorsById.get(id);
        if (!annotators) {
          annotators = new Set();
          annotatorsById.set(id, annotators);
        }
        annotators.add(name);
      }
    }
  }
  return [...annotatorsById].filter(([, annotators]) => annotators.size >= 2).map(([id]) => id);
}

/**
 * Select a reproducible sample from record IDs without depending on their
 * incoming order. IDs are sorted before a seeded shuffle so background
 * snapshot refreshes do not change the sample.
 * @param {string[]} recordIds
 * @param {number} amount
 * @param {string} seed
 * @returns {string[]}
 */
export function sampleRecordIds(recordIds, amount, seed) {
  const ids = [...new Set(recordIds.filter((id) => typeof id === "string" && id.length > 0))].sort();
  const limit = Math.max(0, Math.min(ids.length, Math.trunc(Number(amount) || 0)));
  if (!limit) return [];

  let state = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    state = Math.imul(state ^ seed.charCodeAt(index), 0x01000193);
  }
  const random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };

  for (let index = ids.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [ids[index], ids[swapIndex]] = [ids[swapIndex], ids[index]];
  }
  return ids.slice(0, limit);
}

export function reviewStatusFilterSignature(mode, ids) {
  if (!isReviewStatusMode(mode)) return "";
  return [...new Set(ids)].sort().join("\u0000");
}

export function recordIdsSignature(ids) {
  return [...new Set(ids)].sort().join("\u0000");
}

export function recordIdsFromSignature(signature) {
  return signature ? signature.split("\u0000") : [];
}

/**
 * @param {string} mode
 * @param {string[]} reviewIds
 * @param {string[]} annotationIds
 * @param {boolean} annotationFiltersActive
 * @returns {string[]}
 */
export function combineReviewFilterIds(mode, reviewIds, annotationIds, annotationFiltersActive) {
  if (!annotationFiltersActive) return reviewIds;
  if (!isReviewStatusMode(mode)) return annotationIds;
  const reviewSet = new Set(reviewIds);
  return annotationIds.filter((id) => reviewSet.has(id));
}

/**
 * @template {{ id: string }} Row
 * @param {Row[]} rows
 * @param {string} mode
 * @param {string[] | undefined} snapshot
 * @param {string[]} currentIds
 * @returns {Row[]}
 */
export function filterRowsByReviewSnapshot(rows, mode, snapshot, currentIds) {
  if (!isReviewStatusMode(mode)) return rows;
  const included = new Set(snapshot ?? currentIds);
  return rows.filter((row) => included.has(row.id));
}
