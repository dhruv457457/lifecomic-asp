import { paymentMiddleware, x402ResourceServer } from "@okxweb3/x402-express";
import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";

const REQUIRED_ENV_KEYS = ["OKX_API_KEY", "OKX_SECRET_KEY", "OKX_PASSPHRASE", "PAY_TO_ADDRESS"];

export function getX402Config() {
  const missingEnv = REQUIRED_ENV_KEYS.filter((key) => !process.env[key]);

  const routePrices = {
    "POST /mcp/storyboard": process.env.X402_STORYBOARD_PRICE || "$0.02",
    "POST /mcp/comic": process.env.X402_COMIC_PRICE || "$0.15",
    "POST /mcp/book": process.env.X402_BOOK_PRICE || "$0.80",
  };

  return {
    enabled: missingEnv.length === 0,
    missingEnv,
    network: process.env.X402_NETWORK || "eip155:196",
    payTo: process.env.PAY_TO_ADDRESS || null,
    routePrices,
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
  };

  const routes = Object.fromEntries(
    config.protectedRoutes.map((route) => [
      route,
      {
        accepts: {
          scheme: "exact",
          network: config.network,
          payTo: config.payTo,
          price: config.routePrices[route],
        },
        description: routeDescriptions[route] ?? "LifeComic paid route",
        mimeType: "application/json",
      },
    ]),
  );

  const middleware = paymentMiddleware(routes, resourceServer, undefined, undefined, true);
  return { enabled: true, config, middleware };
}
