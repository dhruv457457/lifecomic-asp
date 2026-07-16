import express from "express";
import http from "node:http";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { createComic } from "./comic.js";
import { generateStoryboard } from "./lib/storyboard-llm.js";
import { createX402Middleware, getX402Config, clampBookPages } from "./lib/x402.js";
import { uploadComic, storageEnabled } from "./lib/storage.js";
import { createRateLimiter, createSpendBudget, redisEnabled } from "./lib/limiter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUTPUT_ROOT = path.join(ROOT, "output");
const PORT = Number(process.env.PORT || 4020);
// Strip any trailing slash so we never build links with a double slash (e.g. `.../app//jobs/...`,
// which 404s). Railway's BASE_URL is often set with a trailing slash.
const stripTrailingSlash = (u) => String(u).replace(/\/+$/, "");
const BASE_URL = stripTrailingSlash(process.env.BASE_URL || `http://localhost:${PORT}`);
const PACKAGE_VERSION = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

// The public base URL for building file/poll links. Prefer an explicit BASE_URL env, but when it's
// unset fall back to the request's own protocol+host so links are correct on any host (e.g. Railway)
// without needing the env var. `trust proxy` (set below) makes req.protocol/host reflect the edge.
function resolveBaseUrl(req) {
  if (process.env.BASE_URL) return stripTrailingSlash(process.env.BASE_URL);
  const host = req?.get?.("host");
  return host ? stripTrailingSlash(`${req.protocol}://${host}`) : BASE_URL;
}

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
  comic: { path: "/mcp/comic", method: "POST", auth: "x402", purpose: "A finished single comic page (4 panels) with real art + PDF + PNG. Returns a jobId immediately; poll /jobs/:jobId for the finished files (~15-30s). Send a raw 'story' (we write it) OR a full 'storyboard' you composed with your own LLM (higher quality, full control).", input: "{ story, style?, tone?, characters? }  OR  { storyboard: {title, style, characters:[...], pages:[{page_title, panels:[{beat, caption, dialogue, image_prompt?}]}]} }" },
  book: { path: "/mcp/book", method: "POST", auth: "x402", purpose: "A multi-page comic book. Choose any length via 'pages' (2-12, default 4); price is per page. Returns a jobId immediately; poll /jobs/:jobId for the finished PDF. Accepts 'story' or a full 'storyboard' (same as /mcp/comic).", input: "{ story | storyboard, pages?: 2-12, style?, tone?, characters? }" },
  jobStatus: { path: "/jobs/:jobId", method: "GET", auth: "none", purpose: "Poll an async book job for status + finished file URLs." },
};

const app = express();
// Trust exactly ONE proxy hop (Railway's edge). This makes req.ip the real client IP so the
// per-IP rate limiter works per-user in production, while still ignoring attacker-supplied
// X-Forwarded-For entries to the left of Railway's — so the limit can't be spoofed away.
// Do NOT change this to `true`: that trusts the whole XFF chain and lets an attacker mint
// unlimited rate-limit buckets to bypass the drain protection.
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use("/files", express.static(OUTPUT_ROOT));

// Per-IP rate limiter so no one can hammer the free routes (which call the paid LLM) and drain
// credits. Redis-backed when REDIS_URL is set (survives restarts + shared across instances), else
// in-memory. See src/lib/limiter.js.
// Hard backstop against credit drain: the free preview is the ONLY unauthenticated path that can
// spend money (one cheap LLM call — images always require payment). Even with per-IP rate limiting,
// a distributed / IP-rotating attacker could trickle calls, so we also cap total *free* spend per
// day. Past the cap the free route stops making paid calls until tomorrow (UTC). Pair it with a hard
// credit limit in the OpenRouter dashboard as the ultimate provider-side ceiling.
const FREE_DAILY_BUDGET_USD = Number(process.env.FREE_DAILY_BUDGET_USD || 2);
const freeBudget = createSpendBudget(FREE_DAILY_BUDGET_USD);

const globalLimiter = createRateLimiter({ windowMs: 60_000, max: 60, prefix: "global" });
// The free preview calls the LLM, so it gets a tighter limit than the read-only routes.
const previewLimiter = createRateLimiter({ windowMs: 60_000, max: 8, prefix: "preview" });
app.use(globalLimiter);

const MAX_STORY_CHARS = 4000;
// Accepts either Mode A (a raw `story` we expand with our LLM) or Mode B (a full `storyboard` the
// buyer's own agent composed — we render it directly). Rejects oversized/empty input before any
// paid model call. Panel count is clamped to the paid format downstream, so Mode B can't inflate cost.
function validStory(req, res) {
  const sb = req.body?.storyboard;
  if (sb && typeof sb === "object" && Array.isArray(sb.pages) && sb.pages.length > 0) return true;

  const story = String(req.body?.story ?? "");
  if (!story.trim()) {
    res.status(400).json({ error: "provide either 'story' (we write it) or 'storyboard' (you wrote it)" });
    return false;
  }
  if (story.length > MAX_STORY_CHARS) {
    res.status(400).json({ error: `story too long (max ${MAX_STORY_CHARS} chars)` });
    return false;
  }
  return true;
}

function fileUrls(id, files, baseUrl = BASE_URL) {
  return {
    pdf: `${baseUrl}/files/${id}/${path.basename(files.pdf)}`,
    pages: (files.pages || []).map((p) => `${baseUrl}/files/${id}/pages/${path.basename(p)}`),
    storyboard: `${baseUrl}/files/${id}/storyboard.json`,
    imagePrompts: `${baseUrl}/files/${id}/image_prompts.txt`,
    socialCaption: `${baseUrl}/files/${id}/social_caption.txt`,
  };
}

async function runComic(request, { withArt = true, baseUrl = BASE_URL } = {}) {
  const id = `comic_${randomUUID().slice(0, 8)}`;
  const outputDir = path.join(OUTPUT_ROOT, id);
  const result = await createComic(request, { outputDir, withArt });
  // Upload to durable storage (Cloudinary) when configured so files survive redeploys; on any
  // failure or when disabled, fall back to serving from local disk.
  let hosted = null;
  try {
    hosted = await uploadComic(id, result.files);
  } catch (error) {
    console.warn("[storage] upload failed, serving locally:", error instanceof Error ? error.message : error);
  }
  return {
    id,
    title: result.title,
    status: result.status,
    storyboardSource: result.storyboardSource,
    art: result.art,
    costUsd: result.cost,
    storage: hosted ? "cloudinary" : "local",
    social_caption: result.storyboard.social_caption,
    files: hosted ?? fileUrls(id, result.files, baseUrl),
  };
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

app.get("/health", (req, res) => res.json({ ok: true, service: SERVICE.name, version: PACKAGE_VERSION, baseUrl: resolveBaseUrl(req), storage: storageEnabled() ? "cloudinary" : "local", limiter: redisEnabled() ? "redis" : "memory" }));

app.get("/service", (_req, res) =>
  res.json({
    ...SERVICE,
    hook: LISTING.hook ?? null,
    examplePrompts: LISTING.examplePrompts ?? [],
    pricing: LISTING.pricing ?? null,
    styles: ["slice-of-life manga", "pixar-style 3d", "noir ink", "cyberpunk", "watercolor", "newspaper strip"],
    formats: ["single_page", "mini_book_4_pages", "life_chapter_8_pages"],
    inputModes: {
      raw: "Send { story } and OUR model writes the storyboard for you. Simplest.",
      structured:
        "Recommended for agent callers: send { storyboard } that YOU composed with your own (stronger) model — title, characters, per-panel beats, captions, dialogue, and optional per-panel image_prompt. We skip our LLM and render your vision directly. Panel count is clamped to the paid tier, so cost is fixed regardless of what you send.",
    },
    endpoints: ENDPOINTS,
  }),
);

app.get("/x402/status", (_req, res) => {
  const c = getX402Config();
  res.json({ enabled: c.enabled, missingEnv: c.missingEnv, network: c.network, payTo: c.payTo, routePrices: c.routePrices, protectedRoutes: c.protectedRoutes });
});

// Free placeholder page — lets a caller see the layout/quality with zero image cost. Tighter
// rate limit than the read-only routes since it still triggers a (cheap) LLM call.
app.post("/mcp/preview", previewLimiter, asyncRoute(async (req, res) => {
  if (!validStory(req, res)) return;
  // Refuse before spending if the day's free budget is used up (a Mode-B storyboard costs $0, but
  // we gate uniformly — the cap only matters when a paid LLM call would happen).
  if ((await freeBudget.remaining()) <= 0) {
    res.status(429).json({ error: "daily free-preview budget exhausted; try a paid route or come back tomorrow" });
    return;
  }
  const out = await runComic({ ...req.body, format: "single_page" }, { withArt: false, baseUrl: resolveBaseUrl(req) });
  await freeBudget.record(out.costUsd);
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
  if (!validStory(req, res)) return;
  // Force single_page so the paid tier can't be upgraded to a bigger (more expensive) storyboard.
  const { storyboard, source, cost } = await generateStoryboard({ ...req.body, format: "single_page" });
  res.json({ paid: true, storyboardSource: source, costUsd: cost, storyboard });
}));

// Both paid render routes are ASYNC: pay once, get a jobId immediately, then poll /jobs/:jobId.
// Real art takes ~15-90s to render (single page) or 60-120s (book) — a synchronous response would
// exceed x402/agent client timeouts, so we return fast and render in the background.
const jobs = new Map();

function startRenderJob(req, request) {
  const jobId = `job_${randomUUID().slice(0, 8)}`;
  jobs.set(jobId, { status: "running", createdAt: Date.now() });
  const baseUrl = resolveBaseUrl(req); // captured now; the background render has no request
  runComic(request, { withArt: true, baseUrl })
    .then((out) => jobs.set(jobId, { status: "done", result: out, finishedAt: Date.now() }))
    .catch((error) => jobs.set(jobId, { status: "failed", error: error instanceof Error ? error.message : String(error) }));
  return { jobId, baseUrl };
}

app.post("/mcp/comic", asyncRoute(async (req, res) => {
  if (!gateOr503(res)) return;
  if (!validStory(req, res)) return;
  // format forced AFTER the spread so the caller can't request more panels than they paid for.
  const { jobId, baseUrl } = startRenderJob(req, { ...req.body, format: "single_page" });
  res.json({ paid: true, status: "running", jobId, poll: `${baseUrl}/jobs/${jobId}` });
}));

app.post("/mcp/book", asyncRoute(async (req, res) => {
  if (!gateOr503(res)) return;
  if (!validStory(req, res)) return;
  // Pages clamped to the same 2–12 range the x402 dynamic price used, so the render can never
  // exceed what the caller paid for (pages × per-page rate).
  const pages = clampBookPages(req.body?.pages);
  const { jobId, baseUrl } = startRenderJob(req, { ...req.body, format: "mini_book_4_pages", pages });
  res.json({ paid: true, status: "running", jobId, pages, poll: `${baseUrl}/jobs/${jobId}` });
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
