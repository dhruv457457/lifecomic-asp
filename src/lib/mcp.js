// MCP (Model Context Protocol) JSON-RPC server for LifeComic — the interface OKX.AI's A2MCP layer
// speaks. Discovery (`initialize`, `tools/list`) is FREE; the actual work (`tools/call`) is x402-gated
// at the HTTP layer (see server.js). Mirrors the shape of listed services like PixStudio: a single
// endpoint, JSON-RPC 2.0, tools with input schemas, synchronous execution.
import { clampBookPages, BOOK_MIN_PAGES, BOOK_MAX_PAGES, BOOK_DEFAULT_PAGES, bookPrice } from "./x402.js";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "lifecomic", version: "1.0.0" };

const characterSchema = {
  type: "array",
  description: "Optional main character(s) so the same face/outfit stays consistent across panels.",
  items: {
    type: "object",
    properties: {
      name: { type: "string" },
      description: { type: "string", description: "Visual description (hair, clothes, vibe)." },
    },
  },
};

// Tool definitions advertised by tools/list. `execution.taskSupport: "forbidden"` marks these as
// synchronous MCP calls (not A2A tasks), matching how listed A2MCP generators declare themselves.
export const MCP_TOOLS = [
  {
    name: "make_comic",
    title: "Make a comic page",
    description:
      "Turn a short real-life moment into a finished single comic page (4 panels) with character-consistent art, real speech bubbles, and a print-ready PDF. Call with ONE argument: `story` — a plain-text sentence or two describing the moment (e.g. \"I missed my train, spilled coffee, still got the job\"). Returns the comic's PDF and page-image URLs. Generation is synchronous and typically takes ~15-30 seconds. Priced per call in USDT.",
    inputSchema: {
      type: "object",
      properties: {
        story: { type: "string", minLength: 1, description: "REQUIRED. The real-life moment / story to turn into a comic, as plain text. Just pass the user's request here." },
        style: { type: "string", description: "Optional art style — e.g. manga, pixar, noir, cyberpunk. Defaults to manga." },
        tone: { type: "string", description: "Optional mood — e.g. funny, dramatic, hopeful, chaotic." },
        characters: characterSchema,
      },
      required: ["story"],
    },
    execution: { taskSupport: "forbidden" },
  },
  {
    name: "make_book",
    title: "Make a comic book",
    description:
      `Turn a story into a multi-page comic book (${BOOK_MIN_PAGES}-${BOOK_MAX_PAGES} pages, default ${BOOK_DEFAULT_PAGES}) with a cover, one consistent hero from cover to cliffhanger, and a print-ready PDF. Call with a plain-text 'story' argument and an optional 'pages' number. Returns the book's PDF and page-image URLs. Priced per page in USDT. Generation is synchronous and typically takes ~30-90 seconds depending on page count.`,
    inputSchema: {
      type: "object",
      properties: {
        story: { type: "string", minLength: 1, description: "REQUIRED. The story to turn into a comic book, as plain text. Just pass the user's request here." },
        pages: { type: "integer", minimum: BOOK_MIN_PAGES, maximum: BOOK_MAX_PAGES, description: `Optional number of pages (${BOOK_MIN_PAGES}-${BOOK_MAX_PAGES}, default ${BOOK_DEFAULT_PAGES}). Priced per page.` },
        style: { type: "string", description: "Optional art style — e.g. manga, pixar, noir, cyberpunk. Defaults to manga." },
        tone: { type: "string", description: "Optional mood — e.g. funny, dramatic, hopeful, chaotic." },
        characters: characterSchema,
      },
      required: ["story"],
    },
    execution: { taskSupport: "forbidden" },
  },
];

const TOOL_NAMES = new Set(MCP_TOOLS.map((t) => t.name));

// A comic still gets made even if a buyer's agent doesn't fill in a story — better to deliver a
// generic comic than to fail a call they already paid for.
const FALLBACK_STORY = "An ordinary day that turned into a small, unexpected adventure.";
// Keys a well-behaved agent uses for the story, plus common near-misses we accept so an autonomous
// buyer's argument-mapping doesn't have to be perfect to get a deliverable.
const STORY_KEYS = ["story", "prompt", "text", "description", "message", "input", "content", "task", "moment"];
const NON_STORY_KEYS = new Set(["style", "tone", "pages", "characters", "format", "name", "title"]);

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** Pulls the story text out of a tool call's arguments, tolerating alternate key names. */
function extractStory(args = {}) {
  for (const k of STORY_KEYS) {
    const v = args[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  // Last resort: the longest free-text value that isn't a known non-story field (e.g. style/tone).
  let best = "";
  for (const [k, v] of Object.entries(args)) {
    if (NON_STORY_KEYS.has(k)) continue;
    if (typeof v === "string" && v.trim().length > best.length) best = v.trim();
  }
  return best || null;
}

/**
 * Pre-payment check for a tools/call. Only rejects an UNKNOWN tool (so we never charge for a call to
 * something that doesn't exist). A missing/oddly-named story is NOT rejected — we extract or fall back
 * at render time so a paid call always yields a comic. Returns a JSON-RPC error, or null to proceed.
 */
export function validateToolCall(body) {
  const { id, params } = body || {};
  const name = params?.name;
  if (!TOOL_NAMES.has(name)) return rpcError(id ?? null, -32602, `unknown tool '${name}'. Available: ${[...TOOL_NAMES].join(", ")}`);
  return null;
}

/** Maps a tool call to the createComic request shape, tolerant of imperfect agent argument mapping. */
function toRenderRequest(name, args = {}) {
  const base = { style: args.style, tone: args.tone, characters: args.characters };
  if (args.storyboard && typeof args.storyboard === "object") base.storyboard = args.storyboard;
  else base.story = extractStory(args) || FALLBACK_STORY;
  if (name === "make_book") return { ...base, format: "mini_book_4_pages", pages: clampBookPages(args.pages) };
  return { ...base, format: "single_page" };
}

function toolResultContent(name, out) {
  const pages = out.files?.pages || [];
  const lines = [
    `Your comic "${out.title}" is ready.`,
    out.files?.pdf ? `PDF: ${out.files.pdf}` : null,
    pages.length ? `Pages: ${pages.join("  ·  ")}` : null,
    out.social_caption ? `Caption: ${out.social_caption}` : null,
  ].filter(Boolean);
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: { title: out.title, pdf: out.files?.pdf, pages, storage: out.storage },
  };
}

/**
 * Dispatches one JSON-RPC message. Returns a response object, or null for notifications (no reply).
 * `runComic` is injected from the server (has the createComic pipeline + storage); by the time a
 * tools/call reaches here, the x402 payment has already been verified + settled by the HTTP gate.
 */
export async function handleMcpRequest(body, { runComic, baseUrl }) {
  if (Array.isArray(body)) {
    const out = [];
    for (const msg of body) {
      const r = await handleMcpRequest(msg, { runComic, baseUrl });
      if (r !== null) out.push(r);
    }
    return out.length ? out : null;
  }

  const { id, method, params } = body || {};

  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });

    case "notifications/initialized":
    case "initialized":
      return null; // notification — no response

    case "ping":
      return rpcResult(id, {});

    case "tools/list":
      return rpcResult(id, { tools: MCP_TOOLS });

    case "tools/call": {
      const invalid = validateToolCall(body);
      if (invalid) return invalid;
      const { name, arguments: args = {} } = params;
      try {
        const request = toRenderRequest(name, args);
        const out = await runComic(request, { withArt: true, baseUrl });
        return rpcResult(id, toolResultContent(name, out));
      } catch (error) {
        return rpcError(id, -32000, `generation failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    default:
      if (id === undefined) return null; // unknown notification
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

const KNOWN_MCP_METHODS = new Set(["initialize", "tools/list", "ping", "tools/call", "notifications/initialized", "initialized"]);

/**
 * Post-payment dispatch — the buyer HAS ALREADY PAID, so this must never return an empty result. If
 * the body is a recognized MCP call, dispatch it normally. Otherwise (empty body, no method, or a
 * non-JSON-RPC shape like `{"prompt":"..."}` — common when a buyer's "direct use" flow pays and
 * replays WITHOUT first discovering our tools/call schema, especially now that tools/list is gated)
 * we STILL render a comic, extracting the story from wherever it is in the raw body and falling back
 * to a generic one. This mirrors how tolerant plain-x402 services (e.g. DejaVu) always deliver after
 * payment instead of returning `{}`.
 */
export async function handlePaidMcpRequest(body, { runComic, baseUrl }) {
  if (KNOWN_MCP_METHODS.has(body?.method)) {
    const out = await handleMcpRequest(body, { runComic, baseUrl });
    if (out !== null) return out; // notification (null) falls through to deliver a comic anyway
  }
  // Paid, but not a content-producing MCP call → deliver a comic from whatever's in the body.
  try {
    const request = toRenderRequest("make_comic", body || {});
    const rendered = await runComic(request, { withArt: true, baseUrl });
    return rpcResult(body?.id ?? null, toolResultContent("make_comic", rendered));
  } catch (error) {
    return rpcError(body?.id ?? null, -32000, `generation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
