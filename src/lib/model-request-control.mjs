/** @param {Headers} headers @param {number} [now] */
export function retryAfterSeconds(headers, now = Date.now()) {
  const milliseconds = Number(headers.get("retry-after-ms"));
  if (Number.isFinite(milliseconds) && milliseconds > 0) return Math.ceil(milliseconds / 1000);
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(1, Math.ceil((date - now) / 1000));
  }
  return 2;
}

/** @param {() => Promise<number>} reserve @param {AbortSignal} signal @param {(ms: number, signal: AbortSignal) => Promise<void>} [delay] */
export async function waitForRequestSlot(reserve, signal, delay = abortableDelay) {
  while (!signal.aborted) {
    const wait = await reserve();
    if (!wait) return;
    await delay(wait * 1000, signal);
  }
  throw new Error("Annotation cancelled.");
}

/** @param {() => Promise<Response>} send @param {() => Promise<number>} reserve @param {AbortSignal} signal @param {string} label @param {(ms: number, signal: AbortSignal) => Promise<void>} [delay] */
export async function fetchWithModelRetry(send, reserve, signal, label, delay = abortableDelay) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await waitForRequestSlot(reserve, signal, delay);
    const response = await send();
    if (response.status !== 429) return response;
    if (attempt === 3) throw new Error(`The ${label} model call was rate-limited after four attempts.`);
    await delay(retryAfterSeconds(response.headers) * 1000, signal);
  }
  throw new Error(`The ${label} model call did not receive a response.`);
}

/** @param {number} milliseconds @param {AbortSignal} signal */
function abortableDelay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("Annotation cancelled."));
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
    const abort = () => { clearTimeout(timer); reject(new Error("Annotation cancelled.")); };
    signal.addEventListener("abort", abort, { once: true });
  });
}
