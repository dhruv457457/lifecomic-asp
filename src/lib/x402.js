import { paymentMiddleware, x402ResourceServer } from "@okxweb3/x402-express";
import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";

const REQUIRED_ENV_KEYS = ["OKX_API_KEY", "OKX_SECRET_KEY", "OKX_PASSPHRASE", "PAY_TO_ADDRESS"];

// Book page limits + per-page rate, kept here so the dynamic price and the server clamp agree.
export const BOOK_MIN_PAGES = 2;
export const BOOK_MAX_PAGES = 12;
export const BOOK_DEFAULT_PAGES = 4;
export function clampBookPages(n) {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) ? Math.max(BOOK_MIN_PAGES, Math.min(BOOK_MAX_PAGES, v)) : BOOK_DEFAULT_PAGES;
}
function perPageRate() {
  return Number(String(process.env.X402_PER_PAGE_PRICE || "$0.20").replace(/[^0-9.]/g, "")) || 0.2;
}
/** Price for the book route = requested pages (clamped) × per-page rate, so cost is always covered. */
export function bookPrice(pages) {
  return `$${(clampBookPages(pages) * perPageRate()).toFixed(2)}`;
}

export function getX402Config() {
  const missingEnv = REQUIRED_ENV_KEYS.filter((key) => !process.env[key]);

  const routePrices = {
    "POST /mcp/storyboard": process.env.X402_STORYBOARD_PRICE || "$0.02",
    "POST /mcp/comic": process.env.X402_COMIC_PRICE || "$0.15",
    "POST /mcp/book": `$${perPageRate().toFixed(2)}/page (${BOOK_MIN_PAGES}-${BOOK_MAX_PAGES} pages, default ${BOOK_DEFAULT_PAGES})`,
    "POST /mcp/revise": process.env.X402_REVISE_PRICE || "$0.10",
  };

  return {
    enabled: missingEnv.length === 0,
    missingEnv,
    network: process.env.X402_NETWORK || "eip155:196",
    payTo: process.env.PAY_TO_ADDRESS || null,
    routePrices,
    perPagePrice: `$${perPageRate().toFixed(2)}`,
    syncSettle: process.env.OKX_SYNC_SETTLE !== "false",
    baseUrl: process.env.OKX_BASE_URL || "https://web3.okx.com",
    protectedRoutes: Object.keys(routePrices),
  };
}

export async function createX402Middleware() {
  const config = getX402Config();
  if (!config.enabled) return { enabled: false, config, middleware: null };

  const facilitatorClient = new OKXFacilitatorClient({
    apiKey: process.env.OKX_API_KEY,
    secretKey: process.env.OKX_SECRET_KEY,
    passphrase: process.env.OKX_PASSPHRASE,
    baseUrl: config.baseUrl,
    syncSettle: config.syncSettle,
  });

  const resourceServer = new x402ResourceServer(facilitatorClient).register(config.network, new ExactEvmScheme());

  const routeDescriptions = {
    "POST /mcp/storyboard": "LifeComic storyboard (text-only script + prompts)",
    "POST /mcp/comic": "LifeComic single comic page (art + PDF)",
    "POST /mcp/book": "LifeComic multi-page comic book (art + PDF)",
    "POST /mcp/revise": "LifeComic per-page revision (regenerate one page of an existing comic)",
  };

  // The book route is priced per page: x402 supports a DynamicPrice function that reads the request
  // body, so we charge (requested pages × per-page rate). Other routes keep their fixed price.
  const bookDynamicPrice = (context) => bookPrice(context?.adapter?.getBody?.()?.pages);
  const priceFor = (route) => (route === "POST /mcp/book" ? bookDynamicPrice : config.routePrices[route]);

  const routes = Object.fromEntries(
    config.protectedRoutes.map((route) => [
      route,
      {
        accepts: {
          scheme: "exact",
          network: config.network,
          payTo: config.payTo,
          price: priceFor(route),
        },
        description: routeDescriptions[route] ?? "LifeComic paid route",
        mimeType: "application/json",
      },
    ]),
  );

  const middleware = paymentMiddleware(routes, resourceServer, undefined, undefined, true);

  // Separate gate for the MCP JSON-RPC endpoint (POST /mcp). Only tools/call reaches this middleware
  // (the server lets initialize/tools-list through free), and the price is derived from the tool call
  // body: make_book is per-page, everything else is the single-page comic price.
  const mcpPrice = (context) => {
    const params = context?.adapter?.getBody?.()?.params || {};
    if (params?.name === "make_book") return bookPrice(params?.arguments?.pages);
    return config.routePrices["POST /mcp/comic"];
  };
  // GET /mcp is ALSO gated (same price) — some x402 validators probe with a plain GET expecting a
  // 402, and the underlying payment middleware keys on "METHOD /path" internally, so GET needs its
  // own registered entry or it's silently treated as an unprotected route and passed through free.
  const mcpRoutes = {
    "POST /mcp": {
      accepts: { scheme: "exact", network: config.network, payTo: config.payTo, price: mcpPrice },
      description: "LifeComic MCP tool call (make_comic / make_book)",
      mimeType: "application/json",
    },
    "GET /mcp": {
      accepts: { scheme: "exact", network: config.network, payTo: config.payTo, price: config.routePrices["POST /mcp/comic"] },
      description: "LifeComic MCP tool call (make_comic / make_book)",
      mimeType: "application/json",
    },
  };
  const mcpMiddleware = paymentMiddleware(mcpRoutes, resourceServer, undefined, undefined, true);

  return { enabled: true, config, middleware, mcpMiddleware };
}
