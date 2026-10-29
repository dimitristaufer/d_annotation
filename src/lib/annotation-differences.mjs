/** @typedef {{ mention?: string; type?: string; identifiability?: string }} Referent */

function normalizeMention(value) {
  return (value ?? "")
    .trim()
    .replace(/\s+/gu, " ")
    .toLowerCase()
    .replace(/^[\s"'“”‘’([{]*(?:a|an|the)\s+/u, "")
    .replace(/[\s"'“”‘’)}\] }.,;:!?]+$/gu, "")
    .trim();
}

function mentionTokens(value) {
  return normalizeMention(value)
    .replace(/[’']/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
}

function areReferentAliases(left, right) {
  const a = mentionTokens(left.mention);
  const b = mentionTokens(right.mention);
  if (!a.length || !b.length) return false;
  if (a.join(" ") === b.join(" ")) return true;
  // Treat a multiword name as an alias when its full token sequence appears
  // in the longer mention. Avoid matching generic one-word labels.
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length < 2 || shorter.length > longer.length) return false;
  return longer.some((_, index) => shorter.every((token, offset) => longer[index + offset] === token));
}

/**
 * Pair references by their person/group mention for display. Classification
 * labels are deliberately not used as identity evidence.
 * @param {Referent[]} left
 * @param {Referent[]} right
 * @returns {{ pairs: Array<{ leftIndex: number; rightIndex: number }>; unmatchedLeft: number[]; unmatchedRight: number[] }}
 */
export function matchReferentsByMention(left, right) {
  const matches = new Map();
  const rightOwner = new Map();
  const visit = (leftIndex, seen) => {
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      if (seen.has(rightIndex) || !areReferentAliases(left[leftIndex], right[rightIndex])) continue;
      seen.add(rightIndex);
      const currentOwner = rightOwner.get(rightIndex);
      if (currentOwner === undefined || visit(currentOwner, seen)) {
        rightOwner.set(rightIndex, leftIndex);
        matches.set(leftIndex, rightIndex);
        return true;
      }
    }
    return false;
  };
  for (let index = 0; index < left.length; index += 1) visit(index, new Set());
  return {
    pairs: [...matches.entries()].map(([leftIndex, rightIndex]) => ({ leftIndex, rightIndex })),
    unmatchedLeft: left.map((_, index) => index).filter((index) => !matches.has(index)),
    unmatchedRight: right.map((_, index) => index).filter((index) => !rightOwner.has(index)),
  };
}

/**
 * Return values left over after subtracting a multiset from another multiset.
 * @template T
 * @param {T[]} left
 * @param {T[]} right
 * @param {(value: T) => string} [keyOf]
 * @returns {{ leftOnly: T[]; rightOnly: T[] }}
 */
export function multisetDifference(left, right, keyOf = (value) => String(value)) {
  const rightCounts = new Map();
  for (const value of right) {
    const key = keyOf(value);
    rightCounts.set(key, (rightCounts.get(key) ?? 0) + 1);
  }
  const leftOnly = [];
  for (const value of left) {
    const key = keyOf(value);
    const count = rightCounts.get(key) ?? 0;
    if (count > 0) rightCounts.set(key, count - 1);
    else leftOnly.push(value);
  }

  const leftCounts = new Map();
  for (const value of left) {
    const key = keyOf(value);
    leftCounts.set(key, (leftCounts.get(key) ?? 0) + 1);
  }
  const rightOnly = [];
  for (const value of right) {
    const key = keyOf(value);
    const count = leftCounts.get(key) ?? 0;
    if (count > 0) leftCounts.set(key, count - 1);
    else rightOnly.push(value);
  }
  return { leftOnly, rightOnly };
}
