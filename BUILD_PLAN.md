# LifeComic ASP — Build Plan

> Turn a messy real-life moment into a real comic page / PDF book. An A2MCP ASP on OKX.AI,
> callable by humans and by other agents (diary / travel / wellness / coach agents).

## Product in one sentence

**"Turn your day into a comic episode."** Not "AI comic generator" (too generic) — a *structured
comic production service*: it owns the story structure, character continuity, page layout, real
lettering, and multi-page PDF export. The reliability and structure are the moat a raw image model
can't match.

## Current state (already built)

- ✅ **Layout engine + PDF export** (`src/renderer.js`) — title, 4-panel grid, caption boxes, speech
  bubbles, page numbers, borders, PDF + page PNGs. Text is rendered by our code, never baked into
  art. This is the hard part, and it works.
- ⚠️ **Storyboard is hardcoded** (`src/storyboard.js`) — always outputs "The Deadline Arc" regardless
  of input. Needs to become real generation from an arbitrary story.
- ❌ **No real panel art** — placeholder silhouettes only.
- ❌ **No ASP layer** — it's a CLI. (Lift x402/service/health/deploy patterns from DejaVu.)

## Staging decision

- **V1 (now, no image API):** real LLM storyboard from any story + placeholder-rendered pages +
  x402 ASP + OKX listing. Always works, cheap to serve, demoable as a structured comic service.
- **V2 (after an image key is available):** real generated panel art dropped into the same pipeline.

Providers: **OpenRouter / Anthropic** for the storyboard LLM (V1). Image provider is stubbed behind
an interface now so V2 is a drop-in with zero API-shape changes.

---

## Architecture decisions (design for these now)

1. **Latency vs. synchronous x402.** A2MCP is pay-per-call and synchronous. Image-heavy books take
   30–120s and can time out.
   - `POST /mcp/comic` → **single page** (≤4 panels), runs synchronously, images generated in
     parallel (~15–25s in V2; instant in V1 placeholder).
   - `POST /mcp/book` → **multi-page** returns a `jobId` immediately; `GET /mcp/comic/:jobId` polls
     for status + final file URLs. (Async so long renders never block a paid request.)
2. **Cost-aware pricing** (image cost ≈ $0.02–0.04/panel in V2, so price above it):

   | Tier | Route | V1 price | V2 price | Output |
   |---|---|---|---|---|
   | Preview | free | free | free | placeholder page PNG, watermarked |
   | Storyboard | `/mcp/storyboard` | $0.02 | $0.02 | storyboard.json + image_prompts.txt + caption |
   | Single page | `/mcp/comic` | $0.05 | $0.15 | 1 page PDF + PNG |
   | Mini book | `/mcp/book` | $0.20 | $0.60 | 4–5 page PDF + page PNGs |
   | Life chapter | `/mcp/book` | $0.80 | $2–5 | 8–12 page PDF book package |

3. **Character consistency** (the hard AI problem — mitigate, don't pretend to solve): one detailed
   character-sheet string reused verbatim in every panel prompt + a fixed style string + a fixed
   per-comic seed. Panel retry on failure. Accept some drift; never let art carry text.
4. **File delivery.** Outputs must return as URLs. V1: an Express `/files/*` static route serving the
   output dir. Later: Cloudflare R2 / S3 for multi-instance.
5. **Graceful degradation** (reuse DejaVu's philosophy): no LLM key → fall back to the current
   deterministic templated storyboard; no image key → placeholder art. The service never hard-fails.

---

## V1 work breakdown

### 1. LLM storyboard generator — `src/lib/storyboard-llm.js`
- Input: `{ story, style, tone, format, characters }`. Output: storyboard JSON matching
  `COMIC_BOOK_SPEC.md` (title, character_bible, pages[].panels[] with beat/caption/dialogue/image_prompt,
  social_caption).
- Prompt instructs the model to return **strict JSON only**; parse defensively, validate/normalize
  shape, clamp panel/page counts to the requested format.
- Provider abstraction reading `OPENROUTER_API_KEY` or `ANTHROPIC_API_KEY` from env (cheap model:
  gpt-4o-mini / claude-haiku). On missing key or bad output → fall back to `buildStoryboard`
  (the existing deterministic one, kept as `storyboard-template.js`).

### 2. Image provider interface — `src/lib/image-provider.js`
- `generatePanel({ prompt, seed, index }) => { path } | null`.
- V1 default: `placeholderProvider` (returns `null`; renderer draws the placeholder).
- V2: `falProvider` / `openaiProvider` etc., selected by env. No renderer/API changes needed to swap.

### 3. Renderer update — `src/renderer.js`
- Accept an optional resolved panel image per panel; `drawImage` (cover-fit into the panel rect the
  layout already computes) when present, else current placeholder. Small, additive change.

### 4. ASP server — `src/server.js` (lift from DejaVu)
- Express + `express.json`. Routes: `/health`, `/service` (self-describing), `/x402/status`,
  `POST /mcp/storyboard`, `POST /mcp/comic`, `POST /mcp/book` + `GET /mcp/comic/:jobId`, static `/files/*`.
- x402 seller middleware + per-route pricing (copy `src/lib/x402.js` shape from DejaVu).
- Free `POST /mcp/preview` → placeholder page for the landing/demo (no payment).

### 5. Packaging
- `service.json`, `LISTING.md`, `README.md` (rewrite from CLI-doc to ASP-doc), Dockerfile,
  `.env.example` (`OPENROUTER_API_KEY`/`ANTHROPIC_API_KEY`, x402 vars, `PAY_TO_ADDRESS`, `BASE_URL`).

### 6. Tests
- storyboard-llm: validates/normalizes model output + falls back cleanly with no key.
- renderer: renders with and without a panel image.
- http: `/service`, `/health`, x402-disabled 503s, `/mcp/storyboard` shape.

### 7. Deploy + list
- Railway deploy, then `onchainos agent create --role asp` (reuse the DejaVu flow: avatar upload,
  activate, submit for review).

## V2 work (after image key)
- Implement the real image provider, wire the consistent-character + seed strategy, parallelize
  single-page generation, flip `/mcp/book` to real async rendering, raise prices to the V2 column,
  regenerate-bad-panel loop, optional cover-page generation.

## Reused from DejaVu (big head start)
x402 seller integration, `/service` + `/health` self-description, graceful-degradation pattern,
Railway deploy, `onchainos agent create/activate` listing flow, `/preview`-style free demo route,
and (later) the same Next.js landing-page approach.

## Open items to confirm before V1 build
- LLM: OpenRouter vs Anthropic direct (both supported by the abstraction — which key will you set?).
- Payment wallet: reuse the same Agentic Wallet / `PAY_TO_ADDRESS` as DejaVu, or a separate one?
- ASP name for the listing: "LifeComic" (recommended), "DayToComic", or "Memory Manga".
