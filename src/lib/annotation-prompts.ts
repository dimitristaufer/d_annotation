export const ANNOTATION_PROMPT_DIMENSIONS = [
  { key: "domain", label: "Domain", title: "Domain Annotation Prompt" },
  { key: "referent", label: "Referent", title: "Referent Annotation Prompt" },
  { key: "identifiability", label: "Identifiability", title: "Identifiability Annotation Prompt" },
  { key: "purpose", label: "Purpose", title: "Purpose Annotation Prompt" },
] as const;

export const ANNOTATION_PROMPT_VERSION = "msd1-gated-referent-inventory-v8";
export const PERSON_REFERENCE_RULE = "The Contains CTPs label comes from the pinned MSD1 ≥90% English screening frame. GPT-6-Luna only builds a referent inventory for records labeled Yes; it does not derive or change the label.";

const REFERENT_INVENTORY_PREFIX = "The verified MSD1 frame has already assigned this message the Contains CTPs label Yes. Do not decide, re-evaluate, or return a Contains CTPs label. Use the supplied referent eligibility criteria only to build the referent inventory.";
const REFERENT_INVENTORY_OUTPUT_CONTRACT = `Return exactly this JSON shape: {"referents":[{"mention":"","type":""}]}. Include only definite qualifying people or groups. The list may be empty. Do not add rationale or other fields.`;

export function buildMsd1ReferentInventoryPrompt(prompt: string) {
  let inventoryInstructions = prompt.trim();
  if (inventoryInstructions.startsWith(REFERENT_INVENTORY_PREFIX)) inventoryInstructions = inventoryInstructions.slice(REFERENT_INVENTORY_PREFIX.length).trim();
  if (inventoryInstructions.endsWith(REFERENT_INVENTORY_OUTPUT_CONTRACT)) {
    inventoryInstructions = inventoryInstructions.slice(0, -REFERENT_INVENTORY_OUTPUT_CONTRACT.length).trim();
  }
  inventoryInstructions = inventoryInstructions.replace(/\bDetermine whether the target contains third-party people or human groups that meet the supplied Contains CTPs criteria\.[\s\S]*$/i, "");
  inventoryInstructions = inventoryInstructions.replace(/\bReturn "yes" when at least one definitely qualifies,[\s\S]*$/i, "");
  const outputMarkers = [
    /\bReturn one JSON object with exactly (?:one|two) fields\b/i,
    /\bReturn exactly this JSON shape\s*:/i,
    /\bReturn exactly this JSON object\b/i,
    /\bReturn only one (?:valid )?JSON object\b/i,
    /\bReturn (?:exactly )?JSON object\b/i,
    /\bReturn (?:exactly )?JSON\b/i,
  ];
  const outputIndexes = outputMarkers.map((marker) => marker.exec(inventoryInstructions)?.index ?? -1).filter((index) => index >= 0);
  if (outputIndexes.length) inventoryInstructions = inventoryInstructions.slice(0, Math.min(...outputIndexes)).trimEnd();
  inventoryInstructions = inventoryInstructions.replace(/\bpersonReferencePrompt\b/gi, "referent eligibility criteria");
  inventoryInstructions = inventoryInstructions.replace(/\bPerson Reference\b/gi, "referent");
  inventoryInstructions = inventoryInstructions.replace(/\bContains CTPs inclusion criteria\b/gi, "Contains CTPs eligibility criteria");
  inventoryInstructions = inventoryInstructions.replace(/\bContains CTPs criteria\s+as inclusion criteria/gi, "Contains CTPs eligibility criteria");
  if (!/referent eligibility criteria|eligibility criteria/i.test(inventoryInstructions)) {
    inventoryInstructions = `Apply the supplied Contains CTPs eligibility criteria when deciding which people and groups belong in the referent inventory.\n\n${inventoryInstructions}`;
  }
  return `${REFERENT_INVENTORY_PREFIX}\n\n${inventoryInstructions.trim()}\n\n${REFERENT_INVENTORY_OUTPUT_CONTRACT}`;
}

export type AnnotationPromptDimension = typeof ANNOTATION_PROMPT_DIMENSIONS[number]["key"];
export type SharedPromptDimension = AnnotationPromptDimension | "personReference";

export const DEFAULT_PERSON_REFERENCE_CRITERIA = `Count third-party people and human groups that are subjects, represented people, or otherwise part of the work requested. Do not count the requester, the assistant/model, activities, abstract topics, or organizations without a human referent.`;

export function normalizePersonReferenceCriteria(prompt: string) {
  const responseSchemaStart = prompt.search(/\n\s*Return only one (?:valid )?JSON object\b/u);
  return (responseSchemaStart >= 0 ? prompt.slice(0, responseSchemaStart) : prompt).trim();
}

type StoredPromptSet = { promptVersion?: unknown; prompts?: unknown; personReferenceCriteria?: unknown; personReferencePrompt?: unknown; relevancePrompt?: unknown };

export function migrateStoredPromptSet(value: unknown) {
  const stored = value && typeof value === "object" && !Array.isArray(value) ? value as StoredPromptSet : {};
  const rawPrompts = stored.prompts && typeof stored.prompts === "object" && !Array.isArray(stored.prompts) ? stored.prompts as Record<string, unknown> : {};
  const prompts = { ...DEFAULT_ANNOTATION_PROMPTS };
  for (const { key } of ANNOTATION_PROMPT_DIMENSIONS) {
    const candidate = rawPrompts[key];
    if (typeof candidate === "string" && candidate.length <= 50_000) prompts[key] = candidate;
  }
  const rawCriteria = [stored.personReferenceCriteria, stored.personReferencePrompt, stored.relevancePrompt].find((candidate) => typeof candidate === "string" && candidate.length <= 50_000);
  let personReferenceCriteria = typeof rawCriteria === "string" ? rawCriteria : DEFAULT_PERSON_REFERENCE_CRITERIA;
  personReferenceCriteria = personReferenceCriteria.replace(/\bPerson Reference\b/gi, "Contains CTPs");
  const legacyCriteria = /referentsToAssess|\{\s*["']relevance["']\s*:|Return only one (?:valid )?JSON object|\bDetermine whether\b|\bReturn\s+["']?(?:yes|no|uncertain)\b/i.test(personReferenceCriteria);
  if (legacyCriteria) personReferenceCriteria = DEFAULT_PERSON_REFERENCE_CRITERIA;
  for (const { key } of ANNOTATION_PROMPT_DIMENSIONS) {
    let prompt = prompts[key];
    prompt = prompt.replace(/\breferentsToAssess\b/g, "the supplied referent list");
    prompt = prompt.replace(/\bPerson Reference\b/gi, "Contains CTPs");
    if (key === "referent") prompt = buildMsd1ReferentInventoryPrompt(prompt);
    prompts[key] = prompt;
  }
  const promptsChanged = ANNOTATION_PROMPT_DIMENSIONS.some(({ key }) => prompts[key] !== rawPrompts[key]);
  return {
    promptVersion: ANNOTATION_PROMPT_VERSION,
    prompts,
    personReferenceCriteria,
    needsMigration: stored.promptVersion !== ANNOTATION_PROMPT_VERSION || typeof stored.personReferenceCriteria !== "string" || rawCriteria !== personReferenceCriteria || promptsChanged,
    previousPromptVersion: typeof stored.promptVersion === "string" ? stored.promptVersion : "unknown",
  };
}

export const DEFAULT_ANNOTATION_PROMPTS: Record<AnnotationPromptDimension, string> = {
  referent: buildMsd1ReferentInventoryPrompt(`Read the target requester message together with the full conversation context. Create the complete list of distinct third-party people and human groups discussed, represented, or invoked in the target message or its requested work. Apply the supplied referent eligibility criteria when deciding what belongs in the list. Use earlier conversation only to interpret the target message; exclude people mentioned only in unrelated earlier turns. A third party is someone other than the requester and assistant/model. Do not count activities, abstract topics, or organizations without a human referent. Use one concise canonical mention for each person or group. Assign exactly one type from: "Fictional or hypothetical people", "Public figures", "Named others", "Unnamed others", "Human groups".`),
  domain: `Classify the requester’s task and its substantive focus using the target requester message and full conversation context. Use the supplied referent list as the complete person inventory. Do not extract, add, merge, or remove people. Select every supported domain from: "Personal life", "Professional life and education", "Health and caregiving", "Legal and financial", "Public life and culture". Classify the requested work, not merely a topic in source material. Do not infer a domain from a person’s presence alone. Return exactly this JSON shape: {"domains":[]}. The list may be empty. Do not add rationale or other fields.`,
  identifiability: `For each entry in the supplied referent list, assess identifiability using the target requester message and full conversation context. The list is complete and ordered. Return exactly one item for each entry, in the same order, and copy its mention exactly. Do not add, remove, merge, split, or reword entries. Choose exactly one label: "Directly identifiable", "Indirectly identifiable", or "No identifying cues". Assess all available context even when the canonical mention is shorter than a fuller name elsewhere. Return exactly this JSON shape: {"referents":[{"mention":"","identifiability":""}]}. Return an empty list for an empty referent list. Do not add rationale or other fields.`,
  purpose: `Classify the requested work using the target requester message, full conversation context, and the supplied referent list as the complete person inventory. First identify the primary requested deliverable and classify its main operation. Add another purpose only when a distinct, substantive requested deliverable independently fits it. Do not count an incidental auxiliary field or analysis used only as an intermediate step. Extracting or transforming material is Transform even when the source discusses people. The labels are: "Help the requester act", "Inquire about or analyse the CTP", "Transform CTP-related material", and "Portray or simulate the CTP". Return exactly this JSON shape: {"purposes":[]}. The list may be empty. Do not add rationale or other fields.`,
};
