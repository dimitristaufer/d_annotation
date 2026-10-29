import test from "node:test";
import assert from "node:assert/strict";
import { readJsonResponse } from "../src/lib/annotation-response.mjs";

test("reads a JSON annotation response", async () => {
  const response = new Response(JSON.stringify({ annotation: { relevance: "no" } }), { headers: { "content-type": "application/json" } });
  assert.deepEqual(await readJsonResponse(response), { annotation: { relevance: "no" } });
});

test("reports a gateway HTML response without Safari's opaque JSON parse error", async () => {
  const response = new Response("<html>Gateway timeout</html>", { status: 524, headers: { "content-type": "text/html" } });
  await assert.rejects(readJsonResponse(response), /non-JSON response \(HTTP 524, text\/html\).*timed out at the gateway/);
});

test("reports an empty gateway response with its HTTP status", async () => {
  const response = new Response("", { status: 502 });
  await assert.rejects(readJsonResponse(response), /non-JSON response \(HTTP 502, text\/plain/);
});
