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
      "Turn a short real-life moment into a finished single comic page (4 panels) with character-consistent art, real speech bubbles, and a print-ready PDF. Generation is synchronous and typically takes ~15-30 seconds. Priced per call in USDT.",
    inputSchema: {
      type: "object",
      properties: {
        story: { type: "string", minLength: 1, description: "The real-life moment / story to turn into a comic." },
        style: { type: "string", description: "Art style — e.g. manga, pixar, noir, cyberpunk. Defaults to manga." },
        tone: { type: "string", description: "Mood — e.g. funny, dramatic, hopeful, chaotic." },
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
      `Turn a story into a multi-page comic book (${BOOK_MIN_PAGES}-${BOOK_MAX_PAGES} pages, default ${BOOK_DEFAULT_PAGES}) with a cover, one consistent hero from cover to cliffhanger, and a print-ready PDF. Priced per page in USDT. Generation is synchronous and typically takes ~30-90 seconds depending on page count.`,
    inputSchema: {
      type: "object",
      properties: {
        story: { type: "string", minLength: 1, description: "The story to turn into a comic book." },
        pages: { type: "integer", minimum: BOOK_MIN_PAGES, maximum: BOOK_MAX_PAGES, description: `Number of pages (${BOOK_MIN_PAGES}-${BOOK_MAX_PAGES}, default ${BOOK_DEFAULT_PAGES}). Priced per page.` },
        style: { type: "string", description: "Art style — e.g. manga, pixar, noir, cyberpunk. Defaults to manga." },
        tone: { type: "string", description: "Mood — e.g. funny, dramatic, hopeful, chaotic." },
        characters: characterSchema,
      },
      required: ["story"],
    },
    execution: { taskSupport: "forbidden" },
  },
];

const TOOL_NAMES = new Set(MCP_TOOLS.map((t) => t.name));

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * Pre-payment validation for a tools/call request. Returns a JSON-RPC error object when the call is
 * malformed (unknown tool, missing story) so the server can reject it WITHOUT charging, or null when
 * the call is valid and should proceed to the x402 payment gate.
 */
export function validateToolCall(body) {
  const { id, params } = body || {};
  const name = params?.name;
  if (!TOOL_NAMES.has(name)) return rpcError(id ?? null, -32602, `unknown tool '${name}'. Available: ${[...TOOL_NAMES].join(", ")}`);
  const args = params?.arguments || {};
  const hasStory = typeof args.story === "string" && args.story.trim().length > 0;
  const hasStoryboard = args.storyboard && typeof args.storyboard === "object";
  if (!hasStory && !hasStoryboard) return rpcError(id ?? null, -32602, "missing required 'story' argument");
  return null;
}

/** Maps a validated tool call to the createComic request shape used by the REST pipeline. */
function toRenderRequest(name, args) {
  const base = { story: args.story, storyboard: args.storyboard, style: args.style, tone: args.tone, characters: args.characters };
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
