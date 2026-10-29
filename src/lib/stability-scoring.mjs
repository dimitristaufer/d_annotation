/** @typedef {{ relevance?: string, decision?: string, domains?: string[], purposes?: string[], referents?: Array<{ mention?: string, description?: string, type?: string, identifiability?: string }> }} StabilityAnnotation */

/** @param {string | undefined} value */
function normalize(value) {
  return (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/** @param {StabilityAnnotation} annotation @param {string} category */
export function stabilityCategoryValue(annotation, category) {
  if (category === "Contains CTPs") return annotation.relevance ?? annotation.decision ?? null;
  if (category === "Domains") return [...(annotation.domains ?? [])].sort();
  if (category === "Purposes") return [...(annotation.purposes ?? [])].sort();
  const referents = annotation.referents ?? [];
  if (category === "Referents") return referents.map((item) => normalize(item.type)).sort();
  if (category === "Identifiability") return referents.map((item) => JSON.stringify([normalize(item.type), normalize(item.identifiability)])).sort();
  throw new Error(`Unknown stability category: ${category}`);
}

/** @param {StabilityAnnotation} left @param {StabilityAnnotation} right @param {string[]} categories */
export function sameStabilityOutput(left, right, categories) {
  return categories.every((category) => JSON.stringify(stabilityCategoryValue(left, category)) === JSON.stringify(stabilityCategoryValue(right, category)));
}
