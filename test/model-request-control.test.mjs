import test from "node:test";
import assert from "node:assert/strict";
import { fetchWithModelRetry, retryAfterSeconds, waitForRequestSlot } from "../src/lib/model-request-control.mjs";

test("waits for a shared request slot and reserves again after the wait", async () => {
  const reservations = [3, 0];
  const waits = [];
  await waitForRequestSlot(async () => reservations.shift(), new AbortController().signal, async (ms) => waits.push(ms));
  assert.deepEqual(waits, [3000]);
  assert.equal(reservations.length, 0);
});

test("stops waiting when the annotation request is cancelled", async () => {
  const controller = new AbortController();
  await assert.rejects(waitForRequestSlot(async () => 5, controller.signal, async (_ms, signal) => {
    controller.abort();
    if (signal.aborted) throw new Error("Annotation cancelled.");
  }), /cancelled/);
});

test("parses provider retry-after headers in milliseconds, seconds, and dates", () => {
  assert.equal(retryAfterSeconds(new Headers({ "retry-after-ms": "1500" })), 2);
  assert.equal(retryAfterSeconds(new Headers({ "retry-after": "4" })), 4);
  assert.equal(retryAfterSeconds(new Headers({ "retry-after": new Date(5000).toUTCString() }), 0), 5);
  assert.equal(retryAfterSeconds(new Headers(), 0), 2);
});

test("reserves a slot for each provider retry and recovers from throttling", async () => {
  let sends = 0;
  let reservations = 0;
  const response = await fetchWithModelRetry(async () => {
    sends += 1;
    return sends === 1 ? new Response("busy", { status: 429, headers: { "retry-after": "1" } }) : new Response("ok", { status: 200 });
  }, async () => { reservations += 1; return 0; }, new AbortController().signal, "referent", async () => {});
  assert.equal(response.status, 200);
  assert.equal(sends, 2);
  assert.equal(reservations, 2);
});

test("stops after four provider throttling responses", async () => {
  let sends = 0;
  await assert.rejects(fetchWithModelRetry(async () => {
    sends += 1;
    return new Response("busy", { status: 429 });
  }, async () => 0, new AbortController().signal, "referent", async () => {}), /rate-limited after four attempts/);
  assert.equal(sends, 4);
});

test("completes a 14-message, five-repeat stability workload with intermittent provider throttling", async () => {
  let modelCalls = 0;
  let reservations = 0;
  let recovered429s = 0;
  const reserve = async () => { reservations += 1; return 0; };
  const modelRequest = async (dimension) => {
    let retried = false;
    const response = await fetchWithModelRetry(async () => {
      modelCalls += 1;
      if (!retried && modelCalls % 37 === 0) {
        retried = true;
        recovered429s += 1;
        return new Response("busy", { status: 429 });
      }
      return new Response(JSON.stringify({ dimension }), { status: 200, headers: { "content-type": "application/json" } });
    }, reserve, new AbortController().signal, dimension, async () => {});
    assert.equal(response.status, 200);
  };
  let completed = 0;
  for (let repetition = 0; repetition < 5; repetition += 1) {
    for (let offset = 0; offset < 14; offset += 10) {
      const messageBatch = Array.from({ length: Math.min(10, 14 - offset) });
      await Promise.all(messageBatch.map(async () => {
        await modelRequest("referent");
        await Promise.all([modelRequest("domain"), modelRequest("identifiability"), modelRequest("purpose")]);
        completed += 1;
      }));
    }
  }
  assert.equal(completed, 70);
  assert.equal(modelCalls, 280 + recovered429s);
  assert.equal(reservations, modelCalls);
  assert.ok(recovered429s > 0);
});
