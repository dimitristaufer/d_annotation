/**
 * Aggregate field agreement across every unordered pair in a set of annotations.
 * Pairs without any comparable fields are counted as possible but not scored.
 * @template TAnnotation
 * @param {TAnnotation[]} annotations
 * @param {(left: TAnnotation, right: TAnnotation) => { matches: number; total: number } | null} compare
 * @returns {{ pairs: number; comparablePairs: number; matches: number; total: number; percent: number | null } | null}
 */
export function pairwiseAnnotationAgreement(annotations, compare) {
  const pairs = annotations.length * (annotations.length - 1) / 2;
  if (!pairs) return null;

  let comparablePairs = 0;
  let matches = 0;
  let total = 0;
  for (let left = 0; left < annotations.length; left += 1) {
    for (let right = left + 1; right < annotations.length; right += 1) {
      const score = compare(annotations[left], annotations[right]);
      if (!score || !score.total) continue;
      comparablePairs += 1;
      matches += score.matches;
      total += score.total;
    }
  }
  return { pairs, comparablePairs, matches, total, percent: total ? matches / total * 100 : null };
}
