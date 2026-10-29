function sameAnnotation(left, right) {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

function sameAnnotatorMap(left, right) {
  const leftNames = Object.keys(left ?? {});
  const rightNames = Object.keys(right ?? {});
  return leftNames.length === rightNames.length
    && leftNames.every((name) => Object.hasOwn(right, name) && sameAnnotation(left[name], right[name]));
}

function mergeByIds(current, incoming, ids, equal) {
  let next = current;
  for (const id of ids) {
    const hasIncoming = Object.hasOwn(incoming, id);
    const hasCurrent = Object.hasOwn(current, id);
    if (hasIncoming && hasCurrent && equal(current[id], incoming[id])) continue;
    if (!hasIncoming && !hasCurrent) continue;
    if (next === current) next = { ...current };
    if (hasIncoming) next[id] = incoming[id];
    else delete next[id];
  }
  return next;
}

function snapshotIds(current, incoming) {
  return new Set([...Object.keys(current), ...Object.keys(incoming)]);
}

export function mergeAnnotationSnapshot(current, incoming) {
  return mergeByIds(current, incoming, snapshotIds(current, incoming), sameAnnotation);
}

export function mergeAnnotationSubset(current, incoming, ids) {
  return mergeByIds(current, incoming, ids, sameAnnotation);
}

export function mergeHumanAnnotationSnapshot(current, incoming) {
  return mergeByIds(current, incoming, snapshotIds(current, incoming), sameAnnotatorMap);
}

export function mergeHumanAnnotationSubset(current, incoming, ids) {
  return mergeByIds(current, incoming, ids, sameAnnotatorMap);
}
