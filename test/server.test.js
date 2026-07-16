import assert from "node:assert/strict";
import http from "node:http";
import test, { before, after } from "node:test";
import { app } from "../src/server.js";

// In-process HTTP tests. We start the Express app on an ephemeral port and hit it with fetch.
// Every request here is FREE: it exercises only validation, the payment gate, rate limiting, and
// the read-only routes — never a path that calls the LLM or the image model. Paid routes are
// tested only for their 503 (x402 disabled, because tests run without OKX env vars), so no spend.

let server;
let base;

before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const get = (path) => fetch(`${base}${path}`);
const post = (path, body) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });

test("GET /health returns liveness + version", async () => {
  const res = await get("/health");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, "LifeComic");
  assert.ok(body.version, "version present");
});

test("GET /service advertises capabilities, input modes, and endpoints", async () => {
  const res = await get("/service");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.capabilities) && body.capabilities.length > 0);
  assert.ok(body.inputModes.raw && body.inputModes.structured, "both input modes documented");
  assert.ok(body.endpoints.comic && body.endpoints.book, "paid endpoints listed");
});

test("GET /x402/status reports payment config", async () => {
  const res = await get("/x402/status");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.enabled, "boolean");
  assert.ok(body.routePrices["POST /mcp/comic"], "comic price advertised");
});

test("POST /mcp/preview rejects empty input before any model call", async () => {
  const res = await post("/mcp/preview", {});
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /story.*storyboard/i);
});

test("POST /mcp/preview rejects an oversized story", async () => {
  const res = await post("/mcp/preview", { story: "x".repeat(4001) });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /too long/i);
});

for (const route of ["/mcp/storyboard", "/mcp/comic", "/mcp/book"]) {
  test(`POST ${route} is gated: 503 when x402 is disabled (no spend)`, async () => {
    const res = await post(route, { story: "a normal day" });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.match(body.error, /x402/i);
    assert.ok(Array.isArray(body.requiredEnv));
  });
}

test("GET /jobs/:jobId returns 404 for an unknown job", async () => {
  const res = await get("/jobs/job_doesnotexist");
  assert.equal(res.status, 404);
});

test("unknown route returns 404 JSON", async () => {
  const res = await get("/no/such/path");
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, "Not found");
});

test("free preview route is rate limited so it can't be spammed to drain credits", async () => {
  // Fire more requests than the preview limit (8/min). Each uses an empty body, so it 400s at
  // validation — never reaching the LLM. Once the limit trips, further requests must 429.
  // We assert order-independently (prior tests may have used part of the budget): at least one
  // 429 must appear, and every non-429 response must be a 400 (validation, not a paid call).
  const statuses = [];
  for (let i = 0; i < 12; i++) {
    const res = await post("/mcp/preview", {});
    statuses.push(res.status);
  }
  assert.ok(statuses.includes(429), "rate limit eventually returns 429");
  assert.ok(
    statuses.every((s) => s === 400 || s === 429),
    "no request slipped past validation into a paid path",
  );
});
