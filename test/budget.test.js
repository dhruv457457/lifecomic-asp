import assert from "node:assert/strict";
import http from "node:http";
import test, { before, after } from "node:test";

// Set the free-preview daily budget to $0 BEFORE importing the server, so the circuit-breaker is
// tripped from the start. A valid story then gets refused with 429 *before* runComic is called —
// proving no LLM/image spend can happen once the cap is hit. node --test runs each file in its own
// process, so this env override does not affect the other test file.
process.env.FREE_DAILY_BUDGET_USD = "0";
const { app } = await import("../src/server.js");

let server;
let base;

before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test("free preview refuses (429) once the daily budget is exhausted — no paid call", async () => {
  const res = await fetch(`${base}/mcp/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ story: "a perfectly valid story that would otherwise cost an LLM call" }),
  });
  assert.equal(res.status, 429);
  const body = await res.json();
  assert.match(body.error, /budget/i);
});
