# LifeComic ASP Project Plan

## Goal

Build an ASP that converts life moments into multi-page comic pages and PDF comic books.

## Core Differentiator

The product must provide production structure that a general-purpose agent does not reliably provide:

- stable API
- repeatable storyboard schema
- character continuity
- comic layout templates
- generated images
- captions, speech bubbles, typography, and PDF export
- hosted output files

## Phase 1: Planning Prototype

Status: planned

- Define request/response schema.
- Define style presets.
- Define four-panel storyboard schema.
- Generate one sample comic image using the built-in image tool.
- Define the real multi-page comic book output spec.
- Use the sample only to judge art direction.

## Phase 2: Local MVP

Status: planned

- Node.js API server.
- `POST /v1/comics`.
- Storyboard generator.
- Placeholder page renderer.
- PDF export.
- Multi-page page renderer with captions and dialogue.
- Local file output.
- Example request files.

## Phase 3: Render MVP

Status: planned

- Image provider interface.
- Provider: built-in local/manual sample for dev.
- Provider: API adapter for OpenRouter, fal.ai, Replicate, or OpenAI Images.
- Panel retry rules.
- Basic quality checks.
- Separate image generation per panel.

## Phase 4: ASP MVP

Status: planned

- x402 payment gate.
- Public service metadata.
- Health endpoint.
- Delivery response with URLs.
- README with deployment and pricing.
- Demo video script.

## Phase 5: Premium

Status: planned

- Multi-page comic book.
- Character memory.
- Style packs.
- Reference image support.
- Agent-to-agent workflow support.
- Batch generation for diary/travel/wellness agents.

## Recommended First Stack

- Runtime: Node.js
- API: Express or Fastify
- PDF: PDFKit or React PDF
- Image processing: Sharp
- Storage: local filesystem for MVP, then Cloudflare R2 or S3
- Planning model: cheap LLM through OpenRouter or existing provider
- Image model: start with built-in sample, then fal.ai/OpenRouter/Replicate

## First Demo Story

```text
Today I woke up late, argued with three AI agents, almost gave up on the hackathon, then found a strange but exciting idea: turning life into comic pages.
```

Style:

```text
slice-of-life manga, warm comedy, expressive character acting, clean panel composition
```

Expected output:

- title: `The Deadline Arc`
- format: 4-page mini comic book
- tone: chaotic but hopeful
- artifact: finished PDF with cover, story pages, captions, dialogue, and page PNGs

## Corrected Product Requirement

The final product must not be one generated image containing four panels. It should generate or render:

- separate panel images
- real captions
- real speech bubbles
- real fonts
- multiple pages
- PDF export
- page PNG export

Image generation should create artwork only. The LifeComic renderer should own layout and text.
