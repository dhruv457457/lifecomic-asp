import express from "express";
import http from "node:http";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { createComic } from "./comic.js";
import { generateStoryboard } from "./lib/storyboard-llm.js";
import { createX402Middleware, getX402Config } from "./lib/x402.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUTPUT_ROOT = path.join(ROOT, "output");
const PORT = Number(process.env.PORT || 4020);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const PACKAGE_VERSION = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

let LISTING = {};
try {
  LISTING = JSON.parse(readFileSync(path.join(ROOT, "service.json"), "utf8"));
} catch {
  // service.json optional; /service still works.
}

const SERVICE = {
  name: "LifeComic",
  type: "A2MCP",
  category: "Art",
  description:
    "Turn a real-life moment into a comic. Send a short story; get back a titled, lettered comic page or multi-page PDF with consistent characters. For humans and for agents (diary, travel, wellness, coach).",
  capabilities: ["story_to_comic_page", "story_to_comic_book", "storyboard_only", "consistent_characters", "pdf_export"],
};

const ENDPOINTS = {
  health: { path: "/health", method: "GET", auth: "none", purpose: "Liveness + version." },
  x402Status: { path: "/x402/status", method: "GET", auth: "none", purpose: "Payment config: per-route prices, network, payTo." },
  preview: { path: "/mcp/preview", method: "POST", auth: "none", purpose: "Free placeholder comic page (no art) — try the layout before paying.", input: "{ story, style?, tone?, characters? }" },
  storyboard: { path: "/mcp/storyboard", method: "POST", auth: "x402", purpose: "Text-only comic script: title, per-panel beats/captions/dialogue, art prompts, social caption.", input: "{ story, style?, tone?, format?, characters? }" },
  comic: { path: "/mcp/comic", method: "POST", auth: "x402", purpose: "A finished single comic page (4 panels) with real art + PDF + PNG. Synchronous.", input: "{ story, style?, tone?, characters? }" },
  book: { path: "/mcp/book", method: "POST", auth: "x402", purpose: "A multi-page comic book. Returns a jobId immediately; poll /jobs/:jobId for the finished PDF.", input: "{ story, style?, tone?, format?, characters? }" },
  jobStatus: { path: "/jobs/:jobId", method: "GET", auth: "none", purpose: "Poll an async book job for status + finished file URLs." },
};

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use("/files", express.static(OUTPUT_ROOT));

function fileUrls(id, files) {
  const rel = (p) => `${BASE_URL}/files/${id}/${path.basename(p)}`;
  return {
    pdf: rel(files.pdf),
    pages: (files.pages || []).map((p) => `${BASE_URL}/files/${id}/pages/${path.basename(p)}`),
    storyboard: `${BASE_URL}/files/${id}/storyboard.json`,
    imagePrompts: `${BASE_URL}/files/${id}/image_prompts.txt`,
    socialCaption: `${BASE_URL}/files/${id}/social_caption.txt`,
  };
}

async function runComic(request, { withArt = true } = {}) {
  const id = `comic_${randomUUID().slice(0, 8)}`;
  const outputDir = path.join(OUTPUT_ROOT, id);
  const result = await createComic(request, { outputDir, withArt });
  return {
    id,
    title: result.title,
    status: result.status,
    storyboardSource: result.storyboardSource,
    art: result.art,
    costUsd: result.cost,
    social_caption: result.storyboard.social_caption,
    files: fileUrls(id, result.files),
  };
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

app.get("/health", (_req, res) => res.json({ ok: true, service: SERVICE.name, version: PACKAGE_VERSION, baseUrl: BASE_URL }));

app.get("/service", (_req, res) =>
  res.json({
    ...SERVICE,
    hook: LISTING.hook ?? null,
    examplePrompts: LISTING.examplePrompts ?? [],
    pricing: LISTING.pricing ?? null,
    styles: ["slice-of-life manga", "pixar-style 3d", "noir ink", "cyberpunk", "watercolor", "newspaper strip"],
    formats: ["single_page", "mini_book_4_pages", "life_chapter_8_pages"],
    endpoints: ENDPOINTS,
  }),
);

app.get("/x402/status", (_req, res) => {
  const c = getX402Config();
  res.json({ enabled: c.enabled, missingEnv: c.missingEnv, network: c.network, payTo: c.payTo, routePrices: c.routePrices, protectedRoutes: c.protectedRoutes });
});

// Free placeholder page — lets a caller see the layout/quality with zero image cost.
app.post("/mcp/preview", asyncRoute(async (req, res) => {
  if (!req.body?.story) return res.status(400).json({ error: "story is required" });
  const out = await runComic({ ...req.body, format: "single_page" }, { withArt: false });
  res.json({ paid: false, ...out });
}));

// x402 gate (paid routes 402 → pay → retry). Disabled → those routes 503 with the missing env list.
let x402Enabled = false;
try {
  const x402 = await createX402Middleware();
  if (x402.enabled && x402.middleware) {
    app.use(x402.middleware);
    x402Enabled = true;
  }
} catch (error) {
  console.warn("[x402] disabled:", error instanceof Error ? error.message : error);
}

function gateOr503(res) {
  if (x402Enabled) return true;
  const c = getX402Config();
  res.status(503).json({ error: "x402 seller route is not enabled", missingEnv: c.missingEnv, requiredEnv: ["OKX_API_KEY", "OKX_SECRET_KEY", "OKX_PASSPHRASE", "PAY_TO_ADDRESS"] });
  return false;
}

app.post("/mcp/storyboard", asyncRoute(async (req, res) => {
  if (!gateOr503(res)) return;
  if (!req.body?.story) return res.status(400).json({ error: "story is required" });
  const { storyboard, source, cost } = await generateStoryboard(req.body);
  res.json({ paid: true, storyboardSource: source, costUsd: cost, storyboard });
}));

app.post("/mcp/comic", asyncRoute(async (req, res) => {
  if (!gateOr503(res)) return;
  if (!req.body?.story) return res.status(400).json({ error: "story is required" });
  const out = await runComic({ ...req.body, format: "single_page" }, { withArt: true });
  res.json({ paid: true, ...out });
}));

// Async book jobs: pay once, get a jobId, poll /jobs/:jobId (books take 60-120s to render).
const jobs = new Map();

app.post("/mcp/book", asyncRoute(async (req, res) => {
  if (!gateOr503(res)) return;
  if (!req.body?.story) return res.status(400).json({ error: "story is required" });
  const jobId = `job_${randomUUID().slice(0, 8)}`;
  jobs.set(jobId, { status: "running", createdAt: Date.now() });
  runComic({ format: "mini_book_4_pages", ...req.body }, { withArt: true })
    .then((out) => jobs.set(jobId, { status: "done", result: out, finishedAt: Date.now() }))
    .catch((error) => jobs.set(jobId, { status: "failed", error: error instanceof Error ? error.message : String(error) }));
  res.json({ paid: true, jobId, poll: `${BASE_URL}/jobs/${jobId}` });
}));

app.get("/jobs/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "job not found" });
  res.json({ jobId: req.params.jobId, ...job });
});

app.use((_req, res) => res.status(404).json({ error: "Not found" }));
app.use((error, _req, res, _next) => res.status(400).json({ error: error instanceof Error ? error.message : "Unexpected error" }));

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  http.createServer(app).listen(PORT, () => {
    console.log(`LifeComic ASP listening on ${BASE_URL}`);
    const c = getX402Config();
    console.log(x402Enabled ? `[x402] enabled for ${c.network} on ${c.protectedRoutes.join(", ")}` : `[x402] disabled; missing: ${c.missingEnv.join(", ") || "none"}`);
  });
}

export { app };
