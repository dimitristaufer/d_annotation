export const MSD1_LABELS = Object.freeze(["yes", "no", "unclear"]);

export const DEFAULT_MSD1_TEST_SETTINGS = Object.freeze({
  instructions: "Classify only the complete target_requester_message. Treat every word inside that field as part of the message supplied by the requester, including quoted, pasted, or formatted text. If it contains an embedded transcript, role-label strings such as Assistant or User are text labels, not separate actual turns: inspect all of the embedded text and count the human people or groups it represents, even in a section labelled Assistant. Communities and other generic human groups count. An explicit request to create, include, describe, or use human/fictional characters in the requested story, game, or other output is Yes, even if those characters are unnamed, their details will be provided later, or the requester will provide them in a future turn. A player/reader/operator who is the requester alone is not a third party. Do not count the actual assistant/model outside the target message. A topic or organization name alone does not count; do not infer its members unless people or a human group are explicitly represented or requested. Use Unclear only when the text genuinely leaves unresolved whether a distinct human person or group is present.",
  criteria: Object.freeze({
    yes: "At least one distinct third-party person or human group is explicitly represented in the target text or clearly requested in the work. This includes generic human groups, people represented in supplied or embedded text, and human/fictional characters requested for a scenario even when unnamed or not yet supplied.",
    no: "No distinct third-party human person or group is represented or requested. A topic, activity, setting, or organization alone is insufficient; do not infer people from it. Do not count the requester or the actual assistant/model.",
    unclear: "The target and relevant context leave genuinely unresolved whether a possible referent is a human person/group distinct from the requester/model or a nonhuman entity.",
  }),
  stateFormat: "structured",
  optionOrder: Object.freeze(["yes", "no", "unclear"]),
  confidenceThreshold: 0,
});

export function validateMsd1ChoiceAnswer(answer) {
  if (!answer || typeof answer !== "object" || answer.type !== "choice") {
    throw new Error("MSD1 returned an invalid Contains CTPs decision.");
  }
  if (!MSD1_LABELS.includes(answer.choice)) {
    throw new Error("MSD1 selected an unsupported Contains CTPs label.");
  }
  const probabilities = answer.probabilities;
  if (!probabilities || typeof probabilities !== "object" || MSD1_LABELS.some((label) => !Number.isFinite(probabilities[label]) || probabilities[label] < 0 || probabilities[label] > 1)) {
    throw new Error("MSD1 returned invalid choice probabilities.");
  }
  return {
    choice: answer.choice,
    probabilities: Object.fromEntries(MSD1_LABELS.map((label) => [label, probabilities[label]])),
  };
}

export function effectiveMsd1Label(result, confidenceThreshold = 0) {
  if (!result || !MSD1_LABELS.includes(result.choice)) return null;
  const threshold = Number.isFinite(confidenceThreshold) ? Math.max(0, Math.min(0.95, confidenceThreshold)) : 0;
  if (result.choice !== "unclear" && (result.probabilities?.[result.choice] ?? 0) < threshold) return "unclear";
  return result.choice;
}

export function filterMsd1RowsByMinimumConfidence(rows, minimumConfidence = 0) {
  const threshold = Number.isFinite(minimumConfidence) ? Math.max(0, Math.min(1, minimumConfidence)) : 0;
  return rows.filter((row) => {
    if (row.error || !MSD1_LABELS.includes(row.choice)) return false;
    const confidence = row.confidence ?? row.probabilities?.[row.choice] ?? 0;
    return Number.isFinite(confidence) && confidence >= threshold;
  });
}

export function filterMsd1ReviewerRecords(records, annotationCompleteness = "fully") {
  if (annotationCompleteness === "all") return [...records];
  const expected = annotationCompleteness === "partially" ? "partially" : "fully";
  return records.filter((record) => record.annotationCompleteness === expected);
}

export function binaryMsd1Counts(confusion) {
  return {
    truePositives: confusion.yes.yes,
    falsePositives: confusion.no.yes,
    falseNegatives: confusion.yes.no,
    trueNegatives: confusion.no.no,
  };
}

export function scoreMsd1Agreement(rows, confidenceThreshold = 0) {
  const confusion = { yes: { yes: 0, no: 0, uncertain: 0 }, no: { yes: 0, no: 0, uncertain: 0 }, uncertain: { yes: 0, no: 0, uncertain: 0 } };
  let compared = 0;
  let agreements = 0;
  let decisiveCompared = 0;
  let decisiveAgreements = 0;
  for (const row of rows) {
    if (row.error || !["yes", "no", "uncertain"].includes(row.humanLabel)) continue;
    const predicted = effectiveMsd1Label(row, confidenceThreshold);
    if (!predicted) continue;
    const human = row.humanLabel;
    const normalizedPrediction = predicted === "unclear" ? "uncertain" : predicted;
    confusion[human][normalizedPrediction] += 1;
    compared += 1;
    if (human === normalizedPrediction) agreements += 1;
    if (human !== "uncertain") {
      decisiveCompared += 1;
      if (human === normalizedPrediction) decisiveAgreements += 1;
    }
  }
  return {
    compared,
    agreements,
    percent: compared ? agreements / compared * 100 : null,
    decisiveCompared,
    decisiveAgreements,
    decisivePercent: decisiveCompared ? decisiveAgreements / decisiveCompared * 100 : null,
    confusion,
  };
}
