/** @template {{ id: string }} T @param {readonly T[]} rows @returns {T[]} */
export function uniqueRecordRows(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    if (!row?.id || seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
}

/** Keep the first occurrence of each record when pages overlap. @template {{ id: string }} T @param {readonly T[]} current @param {readonly T[]} incoming @returns {T[]} */
export function mergeRecordRowsById(current, incoming) {
  return uniqueRecordRows([...current, ...incoming]);
}
