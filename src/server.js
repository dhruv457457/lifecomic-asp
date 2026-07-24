import express from "express";
import http from "node:http";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { createComic } from "./comic.js";
import { generateStoryboard } from "./lib/storyboard-llm.js";
import { createX402Middleware, getX402Config, clampBookPages } from "./lib/x402.js";
import { handleMcpRequest, handlePaidMcpRequest, validateToolCall } from "./lib/mcp.js";
import { uploadComic, storageEnabled } from "./lib/storage.js";
import { createRateLimiter, createSpendBudget, redisEnabled } from "./lib/limiter.js";
import { loadSeries, saveSeries, applySeriesDefaults } from "./lib/series.js";
import { recordComic, getComic, listPublicComics } from "./lib/comic-registry.js";
import { buildReceipt, commercialLicense } from "./lib/receipt.js";
import { reviseComicPage } from "./lib/revise.js";

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
  mcp: { path: "/mcp", method: "POST", auth: "x402 (tools/call only)", purpose: "MCP JSON-RPC endpoint (the A2MCP interface). initialize + tools/list are free discovery; tools/call (make_comic, make_book) is x402-gated and renders synchronously. This is the endpoint registered on OKX.AI.", input: "JSON-RPC 2.0 — tools: make_comic { story, style?, tone?, characters?, artDirection?, storyboard? }, make_book { story, pages?: 2-12, style?, tone?, characters?, artDirection?, storyboard? }. artDirection = { style?, tone?, medium?, palette?, lineWeight?, lighting?, referenceImages?: string[] } pins one visual identity across the whole book. A Mode-B storyboard panel may carry its own finished art via image_url (hosted, preferred) or image_data (base64) — those panels skip generation (bring-your-own-art)." },
  health: { path: "/health", method: "GET", auth: "none", purpose: "Liveness + version." },
  x402Status: { path: "/x402/status", method: "GET", auth: "none", purpose: "Payment config: per-route prices, network, payTo." },
  preview: { path: "/mcp/preview", method: "POST", auth: "none", purpose: "Free placeholder comic page (no art) — try the layout before paying.", input: "{ story, style?, tone?, characters? }" },
  storyboard: { path: "/mcp/storyboard", method: "POST", auth: "x402", purpose: "Text-only comic script: title, per-panel beats/captions/dialogue, art prompts, social caption.", input: "{ story, style?, tone?, format?, characters? }" },
  comic: { path: "/mcp/comic", method: "POST", auth: "x402", purpose: "A finished single comic page (4 panels) with real art + PDF + PNG, delivered in the paid response (typically 15-30s). Send a raw 'story' (we write it) OR a full 'storyboard' you composed with your own LLM (higher quality, full control).", input: "{ story, style?, tone?, characters?, artDirection?, seriesId? }  OR  { storyboard: {title, style, characters:[...], pages:[{page_title, panels:[{beat, caption, dialogue, image_prompt?, image_url?, image_data?}]}]} }. artDirection = { style?, tone?, medium?, palette?, lineWeight?, lighting?, referenceImages?: string[] } enforces one visual identity across all panels. Per-panel image_url (hosted, preferred) / image_data (base64) supplies your own art and skips generation. seriesId ties this page to a multi-chapter story — see /mcp/book." },
  book: { path: "/mcp/book", method: "POST", auth: "x402", purpose: "A multi-page comic book. Choose any length via 'pages' (2-12, default 4); price is per page. Delivered in the paid response (typically 30-90s); if a render runs unusually long you get a jobId to poll at /jobs/:jobId instead. Accepts 'story' or a full 'storyboard' (same as /mcp/comic).", input: "{ story | storyboard, pages?: 2-12, style?, tone?, characters?, artDirection?, seriesId? }. Supply per-panel image_url on every panel for a fully bring-your-own-art book (story + lettering + layout + PDF only; use image_url, not base64, for books). seriesId (any string you choose) continues a multi-chapter story: pass the SAME seriesId on later calls and the cast/style/tone/artDirection (and the actual reference art, once generated) carry over automatically — only send the new chapter's story/beats. The response echoes seriesId + chapterNumber so you can track it. Before calling, ask your user how many pages this chapter should be and whether they want just this chapter now or the whole story — each chapter is a separate paid call." },
  revise: { path: "/mcp/revise", method: "POST", auth: "x402", purpose: "Regenerate ONE page of an existing comic without repaying for the whole book. Fixed price (cheaper than a fresh page). Reuses the unchanged pages and re-renders only the target page with your revision note, keeping the original cast + style. Rebuilds the PDF + CBZ.", input: "{ comicId, page, instructions }. `page` is the 1-based STORY page to fix (a book's cover/credits aren't separately revised). `instructions` is a short note like 'make it night time' or 'the character should look scared'. If the comic's registry record has expired you may instead pass { storyboard, pages: [hosted page URLs], page, instructions }." },
  gallery: { path: "/gallery", method: "GET", auth: "none", purpose: "Free public gallery of comics whose creators opted in (public:true at creation), newest first. Comics are opt-in only since they're often personal stories.", input: "?limit=30 (max 100)" },
  jobStatus: { path: "/jobs/:jobId", method: "GET", auth: "none", purpose: "Poll an async book job for status + finished file URLs." },
};

const app = express();
// Trust exactly ONE proxy hop (Railway's edge). This makes req.ip the real client IP so the
// per-IP rate limiter works per-user in production, while still ignoring attacker-supplied
// X-Forwarded-For entries to the left of Railway's — so the limit can't be spoofed away.
// Do NOT change this to `true`: that trusts the whole XFF chain and lets an attacker mint
// unlimited rate-limit buckets to bypass the drain protection.
app.set("trust proxy", 1);
// CORS: PAYMENT-REQUIRED is a custom response header, so without explicit exposure a browser/JS-based
// caller (buyer agent, validator) can't read it cross-origin even though curl sees it fine — CORS is a
// browser-only restriction. A currently-listed x402 service on this marketplace flags exactly this in
// its own source ("wildcard breaks x402 validator" without the explicit expose/allow headers below).
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, PAYMENT-SIGNATURE, X-Payment");
  res.header("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
// 12mb (was 1mb) so a Mode-B storyboard carrying a few base64 `image_data` panels can be parsed. This
// is a parse-size ceiling only — the real per-image memory bound is enforced in panels.js (8mb decoded).
// Books/large comics should use per-panel `image_url` instead: base64 for 48 panels can't fit any body.
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || "12mb" }));
app.use("/files", express.static(OUTPUT_ROOT));
// Landing page, served same-origin so its demo box can call /mcp/preview without CORS.
app.use(express.static(path.join(ROOT, "web/landing")));

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
    cbz: files.cbz ? `${baseUrl}/files/${id}/${path.basename(files.cbz)}` : undefined,
    pages: (files.pages || []).map((p) => `${baseUrl}/files/${id}/pages/${path.basename(p)}`),
    storyboard: `${baseUrl}/files/${id}/storyboard.json`,
    imagePrompts: `${baseUrl}/files/${id}/image_prompts.txt`,
    socialCaption: `${baseUrl}/files/${id}/social_caption.txt`,
  };
}

// A `seriesId` on the request continues a multi-chapter story: prior chapters' cast/style/tone/
// artDirection (and, once storage is configured, the actual reference art) fill in whatever the
// caller didn't explicitly send, so chapter 2+ only needs the new beat. Best-effort throughout — a
// Redis outage just means the chapter renders standalone instead of continuing the series.
async function runComic(request, { withArt = true, baseUrl = BASE_URL } = {}) {
  const seriesId = typeof request.seriesId === "string" ? request.seriesId.trim().slice(0, 100) : null;
  const priorSeries = seriesId ? await loadSeries(seriesId) : null;
  const resolvedRequest = priorSeries ? applySeriesDefaults(request, priorSeries) : request;

  const id = `comic_${randomUUID().slice(0, 8)}`;
  const outputDir = path.join(OUTPUT_ROOT, id);
  const result = await createComic(resolvedRequest, { outputDir, withArt, seriesId });
  // Receipt is hashed from the LOCAL pdf before upload/cleanup (paid deliveries only — a free preview
  // has no art and doesn't need a delivery hash).
  const receipt = withArt ? await buildReceipt(result.files.pdf, { id, title: result.title }) : null;
  // Upload to durable storage (Cloudinary) when configured so files survive redeploys; on any
  // failure or when disabled, fall back to serving from local disk.
  let hosted = null;
  try {
    hosted = await uploadComic(id, result.files);
  } catch (error) {
    console.warn("[storage] upload failed, serving locally:", error instanceof Error ? error.message : error);
  }
  const chapterNumber = seriesId ? await saveSeries(seriesId, result.storyboard) : null;
  const out = {
    id,
    title: result.title,
    status: result.status,
    storyboardSource: result.storyboardSource,
    art: result.art,
    costUsd: result.cost,
    storage: hosted ? "cloudinary" : "local",
    social_caption: result.storyboard.social_caption,
    style: result.storyboard.style,
    files: hosted ?? fileUrls(id, result.files, baseUrl),
    ...(seriesId ? { seriesId, chapterNumber } : {}),
    ...(receipt ? { receipt } : {}),
    ...(withArt ? { license: commercialLicense() } : {}),
  };
  // Opt-in public gallery: only records when the caller explicitly set public:true, since comics are
  // often personal stories. Best-effort; never blocks delivery. Only real (with-art) comics are listed.
  if (withArt) {
    await recordComic(out, { isPublic: request.public === true || request.publish === true });
  }
  return out;
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
      raw: "Send { story } and OUR model writes the storyboard for you. Simplest. Add { artDirection } to pin one visual identity (style, medium, palette, line weight, lighting, reference images) across the whole book.",
      structured:
        "Recommended for agent callers: send { storyboard } that YOU composed with your own (stronger) model — title, characters, per-panel beats, captions, dialogue, and optional per-panel image_prompt. We skip our LLM and render your vision directly. Bring your own art: give a panel image_url (hosted, preferred) or image_data (base64) and we skip generation for it — supply it on every panel for a story+lettering+PDF-only book. Add { artDirection } to enforce consistency. Panel count is clamped to the paid tier, so cost is fixed regardless of what you send.",
      series:
        "Multi-chapter stories: pass the same { seriesId } (any string) on /mcp/book calls for each chapter. Cast, style/tone, and art direction — including the actual reference art once generated — carry over automatically; only send that chapter's new story. Each chapter is its own paid call. Ask the user how many pages this chapter should be, and whether they want the whole arc now or just chapter 1.",
    },
    endpoints: ENDPOINTS,
  }),
);

// Free public gallery — comics whose creator opted in (public:true at creation), newest first. Free
// by design: gating discovery behind payment would kill the network-effect value. Rate-limited by the
// global limiter. Empty until callers start publishing (and Redis is configured).
app.get("/gallery", asyncRoute(async (req, res) => {
  const comics = await listPublicComics({ limit: req.query.limit });
  res.json({ count: comics.length, comics });
}));

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
let mcpPaymentMiddleware = null;
try {
  const x402 = await createX402Middleware();
  if (x402.enabled && x402.middleware) {
    app.use(x402.middleware);
    mcpPaymentMiddleware = x402.mcpMiddleware;
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

// Paid render routes are HYBRID-synchronous. OKX's A2MCP contract replays the request after payment
// and expects the deliverable IN that response (docs: "the request is replayed to fetch the result"),
// so we hold the reply open until the render finishes (single page ~15-20s, book ~30-60s — well inside
// the 300s x402 window). Only if a render exceeds SYNC_DELIVERY_SECONDS do we fall back to a jobId +
// poll URL, and /jobs/:jobId always works as a recovery path if the client disconnects mid-wait.
const jobs = new Map();
const SYNC_DELIVERY_MS = Number(process.env.SYNC_DELIVERY_SECONDS || 240) * 1000;

function startRenderJob(req, request) {
  const jobId = `job_${randomUUID().slice(0, 8)}`;
  jobs.set(jobId, { status: "running", createdAt: Date.now() });
  const baseUrl = resolveBaseUrl(req); // captured now; the background render has no request
  runComic(request, { withArt: true, baseUrl })
    .then((out) => jobs.set(jobId, { status: "done", result: out, finishedAt: Date.now() }))
    .catch((error) => jobs.set(jobId, { status: "failed", error: error instanceof Error ? error.message : String(error) }));
  return { jobId, baseUrl };
}

/** Waits until the job leaves "running" or the deadline passes; returns the latest job record. */
async function waitForJob(jobId, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const job = jobs.get(jobId);
    if (job && job.status !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return jobs.get(jobId);
}

/** Renders, waits for completion, and replies with the deliverable (or the poll fallback). */
async function deliverRender(req, res, request, extra = {}) {
  const { jobId, baseUrl } = startRenderJob(req, request);
  const job = await waitForJob(jobId, SYNC_DELIVERY_MS);
  if (job?.status === "done") return res.json({ paid: true, ...extra, ...job.result });
  if (job?.status === "failed") return res.status(500).json({ paid: true, ...extra, jobId, error: job.error });
  // Still running past the sync window: hand back the poll URL so nothing paid is ever lost.
  res.json({ paid: true, status: "running", ...extra, jobId, poll: `${baseUrl}/jobs/${jobId}` });
}

app.post("/mcp/comic", asyncRoute(async (req, res) => {
  if (!gateOr503(res)) return;
  if (!validStory(req, res)) return;
  // format forced AFTER the spread so the caller can't request more panels than they paid for.
  await deliverRender(req, res, { ...req.body, format: "single_page" });
}));

app.post("/mcp/book", asyncRoute(async (req, res) => {
  if (!gateOr503(res)) return;
  if (!validStory(req, res)) return;
  // Pages clamped to the same 2–12 range the x402 dynamic price used, so the render can never
  // exceed what the caller paid for (pages × per-page rate).
  const pages = clampBookPages(req.body?.pages);
  await deliverRender(req, res, { ...req.body, format: "mini_book_4_pages", pages }, { pages });
}));

// Regenerates ONE page of an existing comic (identified by comicId, or by supplying storyboard+pages)
// without repaying for the whole book. Fixed price — it reuses the unchanged pages and only regenerates
// the target page's art.
async function runRevise(body, { baseUrl = BASE_URL } = {}) {
  const id = typeof body?.comicId === "string" ? body.comicId : null;
  const outputDir = path.join(OUTPUT_ROOT, id || `revise_${randomUUID().slice(0, 8)}`);
  const result = await reviseComicPage(
    { comicId: id, page: body?.page, instructions: body?.instructions, storyboard: body?.storyboard, pages: body?.pages },
    { outputDir },
  );
  const receipt = await buildReceipt(result.files.pdf, { id: result.id, title: result.title });
  let hosted = null;
  try {
    hosted = await uploadComic(result.id, result.files);
  } catch (error) {
    console.warn("[storage] revise upload failed, serving locally:", error instanceof Error ? error.message : error);
  }
  const out = {
    id: result.id,
    revisedPage: result.page,
    title: result.title,
    art: result.art,
    costUsd: result.cost,
    storage: hosted ? "cloudinary" : "local",
    files: hosted ?? fileUrls(result.id, result.files, baseUrl),
    ...(receipt ? { receipt } : {}),
    license: commercialLicense(),
  };
  // Refresh the registry record so a subsequent revision (or the gallery) sees the new page set.
  const prior = await getComic(result.id);
  await recordComic({ ...out, style: prior?.style, seriesId: prior?.seriesId }, { isPublic: prior?.public === true });
  return out;
}

app.post("/mcp/revise", asyncRoute(async (req, res) => {
  if (!gateOr503(res)) return;
  if (req.body?.page === undefined) {
    return res.status(400).json({ error: "provide { comicId, page, instructions } — 'page' is the 1-based story page to regenerate" });
  }
  try {
    const out = await runRevise(req.body, { baseUrl: resolveBaseUrl(req) });
    res.json({ paid: true, ...out });
  } catch (error) {
    res.status(400).json({ paid: true, error: error instanceof Error ? error.message : String(error) });
  }
}));

// MCP JSON-RPC endpoint — the A2MCP interface. EVERY unpaid request returns a 402 challenge: GET,
// empty POST, malformed body, AND the MCP discovery methods (initialize/tools-list). OKX's x402
// validator probes with various unpaid requests (including a tools/list-shaped body) and flags ANY
// unpaid 200 as "not a valid x402 service" — that single 200 on free discovery was the last thing
// failing review even after GET/empty-POST already 402'd. So unlike a generic MCP server we do NOT
// expose free discovery; this matches the plain-x402 pattern of services that pass review (e.g.
// DejaVu, verified end-to-end). The paid tools/call flow is unaffected: buyers build the call from
// the task's service-params (and our tolerant arg mapping), not from a free tools/list.
app.post("/mcp", asyncRoute(async (req, res, next) => {
  if (!mcpPaymentMiddleware) {
    return res.status(503).json({ jsonrpc: "2.0", id: req.body?.id ?? null, error: { code: -32000, message: "payments not configured" } });
  }
  // Reject a malformed tools/call (unknown tool) BEFORE charging; every other shape hits the gate.
  if (req.body?.method === "tools/call") {
    const invalid = validateToolCall(req.body);
    if (invalid) return res.json(invalid);
  }
  // Gate payment; the middleware 402s an unpaid request itself, and calls our callback once paid+settled.
  // Post-payment we use handlePaidMcpRequest, which ALWAYS returns a comic deliverable (never `{}`) —
  // a buyer who paid but sent a non-tools/call body still gets their comic.
  return mcpPaymentMiddleware(req, res, (err) => {
    if (err) return next(err);
    handlePaidMcpRequest(req.body, { runComic, baseUrl: resolveBaseUrl(req) })
      .then((out) => res.json(out))
      .catch(next);
  });
}));

// GET /mcp — some x402 validators/reviewers probe with a plain GET (a real, currently-listed
// service on this marketplace does this: it 402s on GET too, not 404). MCP's JSON-RPC discovery
// methods are POST-only per spec, so a GET here can't carry a method/params body anyway — treat it
// the same as an unauthenticated tools/call attempt and gate it on payment rather than 404ing.
app.get("/mcp", asyncRoute(async (req, res, next) => {
  if (!mcpPaymentMiddleware) {
    return res.status(503).json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "payments not configured" } });
  }
  return mcpPaymentMiddleware(req, res, (err) => {
    if (err) return next(err);
    // A GET has no JSON-RPC body to act on; once paid, point the caller at the real POST call.
    res.json({ jsonrpc: "2.0", id: null, result: { message: "Payment verified. POST a tools/call request to this same URL to generate your comic." } });
  });
}));

app.get("/jobs/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "job not found" });
  res.json({ jobId: req.params.jobId, ...job });
});

app.use((_req, res) => res.status(404).json({ error: "Not found" }));
app.use((error, _req, res, _next) => {
  // Oversized body — almost always a caller stuffing base64 `image_data` for many panels. Point them
  // at the field that scales (per-panel `image_url`) instead of an opaque parse failure.
  if (error?.type === "entity.too.large" || error?.status === 413) {
    return res.status(413).json({ error: "Request body too large. For bring-your-own-art, use per-panel 'image_url' (a hosted URL) instead of base64 'image_data', especially for multi-page books." });
  }
  res.status(400).json({ error: error instanceof Error ? error.message : "Unexpected error" });
});

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  http.createServer(app).listen(PORT, () => {
    console.log(`LifeComic ASP listening on ${BASE_URL}`);
    const c = getX402Config();
    console.log(x402Enabled ? `[x402] enabled for ${c.network} on ${c.protectedRoutes.join(", ")}` : `[x402] disabled; missing: ${c.missingEnv.join(", ") || "none"}`);
  });
}

export { app };
