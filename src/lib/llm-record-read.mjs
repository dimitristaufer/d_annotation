/** @param {string} recordId */
export function buildLlmRecordReadRequest(recordId) {
  return { recordId, includeContext: true, includeCtpLabel: true };
}
