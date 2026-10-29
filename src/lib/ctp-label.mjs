/** @typedef {"yes" | "no" | "unclear"} CtpScreeningLabel */

/** @param {unknown} value @returns {value is CtpScreeningLabel} */
export function isCtpLabel(value) {
  return value === "yes" || value === "no" || value === "unclear";
}

/**
 * Keep the saved MSD1 labels in a stable form for deterministic queue filtering.
 * @param {string[]} recordIds
 * @param {Record<string, CtpScreeningLabel>} labels
 * @returns {{ yesRecordIds: string[]; no: number; unclear: number; unlabeled: number }}
 */
export function partitionCtpRecordIds(recordIds, labels) {
  const uniqueIds = [...new Set(recordIds)];
  const yesRecordIds = [];
  let no = 0;
  let unclear = 0;
  let unlabeled = 0;
  for (const id of uniqueIds) {
    const label = labels[id];
    if (label === "yes") yesRecordIds.push(id);
    else if (label === "no") no += 1;
    else if (label === "unclear") unclear += 1;
    else unlabeled += 1;
  }
  return { yesRecordIds, no, unclear, unlabeled };
}
