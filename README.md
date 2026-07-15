# LifeComic ASP

LifeComic ASP turns real life moments into finished multi-page comic pages and mini comic books for humans and other agents.

The core product is not "write a story with AI" or "generate one collage image." The core product is a repeatable comic production pipeline: script, character continuity, panel prompts, separate panel art, page layout, captions, speech bubbles, typography, PDF export, and agent-friendly structured outputs.

## One-Line Pitch

Turn a journal entry, memory, trip, milestone, or daily log into a polished multi-page comic or PDF comic book.

## Why This Can Win

Most Art and Lifestyle agents on OKX.AI are simple wrappers: food scanners, tarot reports, image generators, NFT minters, travel planners, and content writers. LifeComic sits between Art and Lifestyle with a clearer emotional artifact:

- a user can instantly understand the output
- the result is visual and shareable
- agents can call it as a rendering service
- the PDF/book output feels more complete than a chat response
- recurring character memory can turn daily moments into an ongoing personal series

## What It Generates

For one input story, LifeComic can return:

- `comic.pdf`: finished printable/shareable comic PDF
- `page_001.png`, `page_002.png`: finished comic page images
- `panels/*.png`: separate generated art panels
- `storyboard.json`: machine-readable panels, captions, dialogue, and art directions
- `character_bible.json`: reusable character/style description for continuity
- `image_prompts.txt`: prompts used for each panel
- `social_caption.txt`: short caption for X, Instagram, or a community post

## Example Input

```json
{
  "story": "Today I woke up late, argued with three AI agents, nearly gave up on the hackathon, then finally found the LifeComic idea.",
  "format": "mini_book_4_pages",
  "style": "slice_of_life_manga",
  "tone": "chaotic_but_hopeful",
  "characters": [
    {
      "name": "Dhruv",
      "description": "young builder, tired eyes, hoodie, determined expression"
    }
  ],
  "outputs": ["pdf", "page_pngs", "panel_pngs", "storyboard_json"]
}
```

## Example Output Shape

```json
{
  "title": "The Deadline Arc",
  "format": "mini_book_4_pages",
  "files": {
    "pdf": "https://example.com/comics/the-deadline-arc.pdf",
    "pages": [
      "https://example.com/comics/the-deadline-arc-page-001.png",
      "https://example.com/comics/the-deadline-arc-page-002.png"
    ],
    "panels": [
      "https://example.com/comics/panels/panel-001.png"
    ]
  },
  "storyboard": {
    "panels": [
      {
        "panel": 1,
        "caption": "The day began with too many tabs.",
        "dialogue": "Wait, why are there four hackathons open?",
        "art_direction": "A tired builder staring at a glowing laptop, browser tabs filling the room like paper notes."
      }
    ]
  }
}
```

## Product Modes

### Draft Mode

No paid image API required.

- generates title, comic script, storyboard, page plan, panel prompts, and PDF with placeholder panels
- useful for testing, ASP review, and cheap previews
- agents can inspect the storyboard before paying for final render

### Render Mode

Uses image generation.

- generates one separate image per panel
- crops/resizes each panel into the chosen page template
- adds captions, dialogue, narration, and page numbers using the layout engine
- exports page PNGs and a PDF comic book

### Book Mode

Premium version.

- cover page
- 4 to 12 comic pages
- character bible
- episode/chapter structure
- print-ready PDF

## Why Agents Need This

Claude, Codex, and other agents can write scripts and prompts, but a real ASP gives them a stable service:

- fixed API endpoint
- predictable JSON schema
- style presets
- layout templates
- hosted output files
- PDF generation
- image retries and quality checks
- reusable character continuity
- readable typography controlled by the renderer instead of the image model

## Recommended API Strategy

Start with two providers behind one internal interface:

- `mock`: no cost, creates storyboard and placeholder PDF
- `openrouter_image` or `fal`: paid render mode

Keep the provider swappable:

```text
POST /v1/comics
  -> Story planner
  -> Character bible
  -> Panel prompt builder
  -> Image provider
  -> Comic page renderer
  -> PDF exporter
  -> Storage
```

## API Options

| Provider | Best Use | Rough Cost |
| --- | --- | --- |
| Built-in Codex image tool | local prototype and demo samples | no separate API key in this session |
| OpenRouter image models | simple unified API for many models | commonly around $0.04 per image for some models |
| fal.ai | fast production image/video model access | often around $0.03 to $0.05 per image for common models |
| Replicate | easy model switching and broad model catalog | often around $0.025 to $0.04 per image for popular image models |
| OpenAI Images API | strong quality and prompt following | pricing varies by model and size |

Always re-check provider prices before launch because image model prices change quickly.

## Cost Model

Assume a 4-page mini comic with 4 panels per page:

- image cost: 16 panels x $0.03-$0.05 = $0.48-$0.80
- planning LLM cost: usually less than $0.01-$0.03 with a small/cheap model
- storage/PDF cost: near-zero at MVP scale
- retry budget: add 25%-50% if allowing image regeneration

Practical internal cost:

- draft-only request: under $0.01
- 4-panel render: about $0.15-$0.30
- 8-panel render: about $0.30-$0.60
- 4-page mini book: about $0.60-$1.20 if fully rendered

## Suggested User Pricing

Use packages, not unlimited generation:

- `Draft Comic`: free or $0.01-$0.03
- `4-Panel Comic Page`: $0.49-$0.99
- `8-Panel Comic Page`: $0.99-$1.99
- `4-Page Mini Comic Book`: $4.99-$9.99
- `Character Memory Add-On`: $0.25-$0.50 per update

For OKX.AI, a simple launch price could be:

- `0.1 USDT`: storyboard and prompts
- `0.5 USDT`: 4-panel rendered comic page
- `1 USDT`: 8-panel rendered comic page
- `5 USDT`: 4-page mini comic book

## Cost Controls

- generate storyboard first, then images only after confirmation
- use cheap model for planning and expensive model only for final art
- limit panel count per paid tier
- cache character bibles and style prompts
- store output URLs and avoid regenerating identical requests
- allow one retry per page, then charge for more
- render text in the PDF layout, not inside image generation
- use lower-cost drafts before final generation
- generate panels separately so bad panels can be retried without regenerating the whole book

## MVP Endpoint

```http
POST /v1/comics
Content-Type: application/json
```

Request:

```json
{
  "story": "string",
  "format": "mini_book_4_pages",
  "style": "slice_of_life_manga",
  "tone": "warm_funny",
  "characters": [],
  "render": false
}
```

Response:

```json
{
  "id": "comic_...",
  "status": "draft",
  "title": "string",
  "storyboard": {},
  "character_bible": {},
  "image_prompts": [],
  "files": {}
}
```

## MVP Build Order

1. Build story-to-storyboard planner.
2. Add style presets and character bible generation.
3. Add deterministic page layout templates.
4. Add placeholder PDF/PNG export.
5. Add image provider interface.
6. Add one real image provider.
7. Add storage for generated outputs.
8. Add ASP/x402 payment wrapper.
9. Add examples and demo script.

## Local MVP Usage

Install dependencies:

```bash
npm install
```

Generate the demo comic:

```bash
npm run demo
```

This writes:

```text
output/deadline-arc/comic.pdf
output/deadline-arc/storyboard.json
output/deadline-arc/pages/page_001.png
output/deadline-arc/pages/page_002.png
output/deadline-arc/pages/page_003.png
output/deadline-arc/pages/page_004.png
```

Generate from a custom request:

```bash
npm run generate -- --input examples/deadline-arc.json --out output/my-comic
```

Run tests:

```bash
npm test
```

Current MVP status:

- creates a 4-page comic plan
- renders real captions and dialogue
- exports page PNGs
- exports a PDF
- uses placeholder panel art until an image API is connected

## Demo Script

1. Paste one messy life moment.
2. Select `four_panel_page` and a style.
3. Show storyboard JSON and page plan.
4. Generate panel images.
5. Render pages with captions and dialogue.
6. Open PDF.
7. Show how another agent can call the endpoint.

## Current Prototype Decision

We will first create a sample comic page with the built-in Codex image generation tool. If the output quality feels good, the ASP can later integrate a production image API. If it feels weak, we will still keep the storyboard/PDF pipeline and swap the image provider.

## Prototype Sample

First visual sample:

```text
assets/samples/deadline-arc-sample.png
```

Generated with the built-in Codex image generation tool from the first demo story in `PROJECT_PLAN.md`. This is only a visual direction test. The real product should generate separate panel images, then use LifeComic's own renderer for page layout, captions, dialogue, fonts, and PDF/book output.
