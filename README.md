# LifeComic ASP

Turn a real-life moment into a finished comic. Send a short story (or a full storyboard you composed
yourself) and get back a titled, lettered comic page or multi-page PDF with consistent characters —
built for humans **and** for agents (diary, travel, wellness, coach bots).

LifeComic is a backend-only **A2MCP** service on OKX.AI: pay-per-call over **x402**. It is not "generate
one image" — it is a repeatable comic production pipeline: script → character continuity → per-panel art
→ dynamic page layout → captions, speech bubbles, typography → PDF export → agent-friendly JSON.

- **Live:** `https://lifecomic-asp-production.up.railway.app`
- **OKX.AI:** registered as **Agent #6103** (ASP)
- **Type:** A2MCP (pay-per-call, x402) · Category: Art / Lifestyle

## Why it's differentiated

Most Art/Lifestyle agents are thin wrappers (image generators, scanners, planners). LifeComic returns a
**visual, shareable artifact** with real structure:

- the output is instantly understandable and shareable (a comic page / PDF book)
- agents can call it as a stable rendering service with a predictable JSON schema
- recurring-character continuity turns daily moments into an ongoing personal series
- typography and layout are owned by the renderer, not the image model, so text is always clean

## Endpoints

| Method | Route | Auth | Price | Purpose |
| --- | --- | --- | --- | --- |
| POST | `/mcp` | x402 (`tools/call` only) | $0.15 / $0.20/pg | **MCP JSON-RPC endpoint — the A2MCP interface registered on OKX.AI.** `initialize` + `tools/list` are free discovery; `tools/call` (`make_comic`, `make_book`) is x402-gated and renders synchronously. |
| GET | `/health` | none | — | Liveness, version, and resolved `storage` / `limiter` / `baseUrl`. |
| GET | `/service` | none | — | Service manifest: capabilities, styles, formats, input modes, endpoints. |
| GET | `/x402/status` | none | — | Payment config: per-route prices, network, payTo. |
| POST | `/mcp/preview` | none | free | Placeholder comic page (no art) — try layout/quality with zero image cost. |
| POST | `/mcp/storyboard` | x402 | $0.02 | Text-only comic script: title, per-panel beats/captions/dialogue, art prompts. |
| POST | `/mcp/comic` | x402 | $0.15 | A finished single comic page (4 panels) with real art + PDF + PNG, delivered in the paid response (~15-30s). |
| POST | `/mcp/book` | x402 | $0.20/page | Multi-page comic book, any length via `pages` (2–12, default 4). Priced per page, delivered in the paid response (~30-90s). |
| GET | `/jobs/:jobId` | none | — | Recovery path: if a render outlives the sync window (`SYNC_DELIVERY_SECONDS`, default 240) the paid response returns a `jobId` to poll here instead. |

Prices are configurable via `X402_*` env vars. Payment settles on X Layer (`eip155:196`) via the official
OKX x402 seller middleware.

## Two input modes

Every generation route accepts either:

- **Mode A — raw story:** `{ "story": "...", "style?": "...", "tone?": "...", "characters?": [...] }`.
  Our LLM writes the storyboard. Simplest.
- **Mode B — structured storyboard:** `{ "storyboard": { title, style, characters, pages: [{ page_title,
  panels: [{ beat, caption, dialogue, image_prompt? }] }] } }`. The caller's own (stronger) model composed
  it; **we skip our LLM** and render it directly — higher quality, full control, and $0 of our LLM cost.

Panel count is always clamped to the paid tier, so cost is fixed no matter what a caller sends.

### Example (Mode A)

```bash
curl -s https://lifecomic-asp-production.up.railway.app/mcp/preview \
  -H "content-type: application/json" \
  -d '{"story":"I woke up late, argued with three AI agents, nearly quit, then found the idea.",
       "style":"slice-of-life manga","tone":"chaotic but hopeful",
       "characters":[{"name":"Dhruv","description":"tired builder, hoodie, determined eyes"}]}'
```

### Response shape

```json
{
  "paid": false,
  "id": "comic_1a2b3c4d",
  "title": "The Deadline Arc",
  "status": "rendered_placeholder",
  "storyboardSource": "llm",
  "storage": "cloudinary",
  "costUsd": 0.0,
  "files": {
    "pdf": ".../comic.pdf",
    "pages": [".../pages/page_000_cover.png", ".../pages/page_001.png"],
    "storyboard": ".../storyboard.json",
    "imagePrompts": ".../image_prompts.txt",
    "socialCaption": ".../social_caption.txt"
  }
}
```

## Features

- **Character consistency** — a character reference sheet is generated once, then passed back into every
  panel so the same face/hair/outfit holds across the whole comic.
- **Dynamic, genre-aware layouts** — panels vary in size (banner / splash / cascade / quad) and the
  template rotation adapts to style/tone (action styles get kinetic layouts; calm styles get steady grids).
  Each panel's art is generated at its slot's aspect ratio so nothing is cropped.
- **Speech bubbles with tails** — auto-fit text, up to two speakers per panel that alternate sides.
- **Cover + credits pages** for multi-page books; **speed lines** on action panels.
- **Draft/preview tier** — placeholder pages with zero image cost, so agents can inspect a storyboard
  before paying for final art.

## Cost & credit-drain protection

- Every paid route is **x402 prepaid per call** for a fixed amount of work — a payment can never buy more
  art than it covers.
- Image generation (the expensive part) is **impossible without payment**: the free `/mcp/preview` route
  hardcodes `withArt:false`, so it can only ever make one cheap LLM call.
- The free route is **rate-limited per IP** and capped by a **daily free-spend budget**
  (`FREE_DAILY_BUDGET_USD`, default $2); `trust proxy` is set so limits work behind Railway and can't be
  spoofed. Pair with a hard credit limit in the OpenRouter dashboard for a provider-side ceiling.

Internal cost per comic: single page ≈ $0.15–0.20 (5 images incl. the character sheet), 4-page book
≈ $0.55–0.80. Positive margin at the listed prices.

## Running locally

```bash
npm install
cp .env.example .env   # fill in the keys you have (see below)
npm start              # http://localhost:4020
npm test               # node --test — all checks are free (no LLM/image calls)
npm run demo           # render the bundled example to output/
```

Check config: `curl http://localhost:4020/x402/status`

## Environment variables

| Var | Required | Notes |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | for art/LLM | OpenRouter key for the LLM + image models. |
| `LIFECOMIC_LLM_MODEL` | no | Default `google/gemini-2.5-flash`. |
| `LIFECOMIC_IMAGE_MODEL` | no | Default `google/gemini-3.1-flash-lite-image`. |
| `OKX_API_KEY` / `OKX_SECRET_KEY` / `OKX_PASSPHRASE` | for payments | OKX x402 seller creds. Missing → paid routes return 503. |
| `PAY_TO_ADDRESS` | for payments | Wallet that receives settlement. |
| `X402_NETWORK` | no | Default `eip155:196` (X Layer). |
| `X402_STORYBOARD_PRICE` / `X402_COMIC_PRICE` | no | Defaults `$0.02` / `$0.15`. |
| `X402_PER_PAGE_PRICE` | no | Book price per page (`/mcp/book` charges pages × this). Default `$0.20` (so 4 pages = $0.80). |
| `CLOUDINARY_URL` | no | `cloudinary://key:secret@cloud`. Set → files upload to Cloudinary CDN (durable). Unset → served from local disk. |
| `REDIS_URL` | no | Set → rate limiter + spend budget are Redis-backed (survive restarts, shared across instances). Unset → in-memory. |
| `FREE_DAILY_BUDGET_USD` | no | Daily cap on free-preview spend. Default `2`. |
| `SYNC_DELIVERY_SECONDS` | no | How long a paid route waits to deliver the finished comic in the same response before falling back to a `jobId` + `/jobs/:jobId` poll. Default `240`. |
| `BASE_URL` | no | Public base for file links. If unset, derived from the request host automatically. |
| `PORT` | no | Default `4020`. Railway injects this. |

## Deployment (Railway)

The repo ships a `Dockerfile` (node:22-slim + fonts for canvas lettering); Railway auto-builds it. Set the
env vars above in the Railway dashboard. `PORT` is injected by Railway; `BASE_URL` is optional (auto-derived).
After deploy, `GET /health` should report `storage:"cloudinary"` and `limiter:"redis"` once those are configured.

## Architecture

```text
story | storyboard
  -> generateStoryboard   (Mode A: LLM writes it · Mode B: caller-supplied, $0)
  -> assignLayout         (genre-aware templates + per-panel aspect ratios)
  -> generatePanels       (character reference sheet -> per-panel art, paid tiers only)
  -> renderComic          (canvas pages: cover, panels, bubbles, credits -> PNG + PDF)
  -> storage              (Cloudinary CDN, or local disk fallback)
```

Key files: `src/server.js` (routes, x402, rate limiting), `src/comic.js` (pipeline), `src/lib/storyboard-llm.js`
(storyboard + Mode B), `src/lib/layout.js` (templates), `src/renderer.js` (page rendering), `src/lib/panels.js`
(art + character reference), `src/lib/storage.js` (Cloudinary), `src/lib/limiter.js` (rate limit + budget),
`src/lib/x402.js` (payments).
