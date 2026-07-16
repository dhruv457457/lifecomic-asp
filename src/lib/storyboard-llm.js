import slugify from "slugify";
import { chatJSON, isConfigured } from "./openrouter.js";
import { buildStoryboard as buildTemplateStoryboard } from "../storyboard.js";

// format -> page/panel layout. All layouts are 4-panel grids for now (renderer assumption).
export const FORMATS = {
  single_page: { pages: 1, panelsPerPage: 4, label: "single comic page" },
  mini_book_4_pages: { pages: 4, panelsPerPage: 4, label: "mini comic book" },
  life_chapter_8_pages: { pages: 8, panelsPerPage: 4, label: "life chapter book" },
};

function resolveFormat(format) {
  return FORMATS[format] ? format : "mini_book_4_pages";
}

// Flexible page count: agents can request any book length 2–12 (each page is 4 panels). Returns a
// clamped integer, or null when no explicit count was given (falls back to the named format).
export const MIN_PAGES = 2;
export const MAX_PAGES = 12;
export function clampPages(n) {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) ? Math.max(MIN_PAGES, Math.min(MAX_PAGES, v)) : null;
}

/**
 * Builds the deterministic art prompt for a panel. Character sheet + style are reused verbatim in
 * every panel (the cheap, reliable path to character consistency), and text is explicitly banned so
 * the renderer — not the image model — owns all captions and dialogue.
 */
function buildPanelImagePrompt({ style, character, beat, tone }) {
  return [
    `Single ${style} comic panel, expressive comic art, clean composition, ${tone} mood.`,
    `Consistent recurring character: ${character.visual_description}. Keep the same face, hair, and outfit in every panel.`,
    `Scene: ${beat}`,
    "Wide panel framing. Absolutely no text, no captions, no speech bubbles, no letters, no signs, no watermark.",
  ].join(" ");
}

function normalizeStoryboard(request, llm) {
  const fmtKey = resolveFormat(request.format);
  const fmt = FORMATS[fmtKey];
  // An explicit numeric `pages` (2–12) overrides the named format's page count; panels stay at 4/page.
  const pageCount = clampPages(request.pages) ?? fmt.pages;
  const title = String(llm.title || request.title || "Untitled Day").slice(0, 80);
  const style = request.style || llm.style || "slice-of-life manga";
  const tone = request.tone || llm.tone || "warm and honest";

  const character = {
    id: "char_main",
    name: llm.characters?.[0]?.name || request.characters?.[0]?.name || "Main Character",
    visual_description:
      llm.characters?.[0]?.visual_description ||
      request.characters?.[0]?.description ||
      "expressive everyday person, relatable and cinematic",
    continuity_notes: "Keep the same outfit, face shape, hairstyle, and expressiveness across every panel.",
  };

  const llmPages = Array.isArray(llm.pages) ? llm.pages : [];
  const pages = [];
  for (let p = 0; p < pageCount; p += 1) {
    const src = llmPages[p] || {};
    const srcPanels = Array.isArray(src.panels) ? src.panels : [];
    const panels = [];
    for (let i = 0; i < fmt.panelsPerPage; i += 1) {
      const panel = srcPanels[i] || {};
      const beat = String(panel.beat || panel.scene || "A quiet beat in the story.").slice(0, 240);
      const caption = String(panel.caption || "").slice(0, 120);
      // Keep up to two dialogue lines so the renderer can show a two-speaker exchange. Accepts an
      // array of {speaker,text} (or bare strings) or a single string; empties are dropped.
      const rawDialogue = Array.isArray(panel.dialogue)
        ? panel.dialogue
        : typeof panel.dialogue === "string"
          ? [panel.dialogue]
          : [];
      const dialogue = rawDialogue
        .map((d) => ({
          speaker: String(d?.speaker || character.name).slice(0, 40),
          text: String(typeof d === "string" ? d : (d?.text ?? "")).slice(0, 120),
        }))
        .filter((d) => d.text)
        .slice(0, 2);
      panels.push({
        panel: i + 1,
        beat,
        caption,
        dialogue,
        // A caller (buyer agent) may supply its own richer art prompt; otherwise we build one.
        image_prompt: panel.image_prompt
          ? String(panel.image_prompt).slice(0, 1400)
          : buildPanelImagePrompt({ style, character, beat, tone }),
      });
    }
    pages.push({
      page: p + 1,
      page_title: String(src.page_title || `Page ${p + 1}`).slice(0, 60),
      layout: "four_panel_grid",
      panels,
    });
  }

  return {
    comic_id: `comic_${slugify(title, { lower: true, strict: true }) || "untitled"}`,
    title,
    format: clampPages(request.pages) ? `custom_${pageCount}_pages` : fmtKey,
    pageCount,
    style,
    tone,
    source_story: request.story,
    character_bible: {
      characters: [character],
      style_rules: [
        "Generate artwork without text inside the panels.",
        "Use consistent character appearance across panels.",
        "Keep backgrounds readable and not too busy.",
      ],
    },
    pages,
    social_caption: String(llm.social_caption || "Some days don't make sense until they become a story.").slice(0, 200),
    generated_by: "llm",
  };
}

function storyboardPrompt(request) {
  const fmt = FORMATS[resolveFormat(request.format)];
  const pageCount = clampPages(request.pages) ?? fmt.pages;
  const totalPanels = pageCount * fmt.panelsPerPage;
  const label = clampPages(request.pages) ? `${pageCount}-page` : fmt.label;
  return [
    `Turn this real-life moment into a ${label} comic storyboard.`,
    "",
    `STORY: ${request.story}`,
    `STYLE: ${request.style || "slice-of-life manga"}`,
    `MOOD: ${request.tone || "warm and honest"}`,
    request.characters?.[0]?.name ? `MAIN CHARACTER: ${request.characters[0].name} — ${request.characters[0].description || ""}` : "",
    "",
    `Produce exactly ${pageCount} page(s), each with exactly ${fmt.panelsPerPage} panels (${totalPanels} panels total).`,
    "Give the comic an evocative TITLE. For each panel provide a visual 'beat' (what we see), a short",
    "narration 'caption' (<= 12 words), and one line of 'dialogue' (<= 12 words). Keep the emotional arc",
    "coherent and end on a satisfying beat. Also give one shareable 'social_caption'.",
    "",
    "Return STRICT JSON only, this exact shape:",
    `{"title":"...","characters":[{"name":"...","visual_description":"..."}],`,
    `"pages":[{"page_title":"...","panels":[{"beat":"...","caption":"...","dialogue":"..."}]}],`,
    `"social_caption":"..."}`,
  ].join("\n");
}

/**
 * Turns a request into a storyboard. Uses the LLM when configured; on any failure (no key, timeout,
 * bad JSON) falls back to the deterministic template so the service never hard-fails.
 */
export async function generateStoryboard(request, { retries = 2 } = {}) {
  // Mode B — the buyer's own agent (Claude Code / Codex / OpenClaw) already did the creative
  // "thinking" and handed us a full storyboard. Render it directly: no LLM call, higher quality
  // (frontier model), full caller control. Still normalized + clamped to the paid format so the
  // panel count (and therefore the image cost) can never exceed what the tier charges for.
  if (request.storyboard && typeof request.storyboard === "object" && Array.isArray(request.storyboard.pages)) {
    return { storyboard: normalizeStoryboard(request, request.storyboard), cost: 0, source: "caller" };
  }

  if (!isConfigured()) {
    return { storyboard: buildTemplateStoryboard(request), cost: 0, source: "template" };
  }
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const { data, cost } = await chatJSON(storyboardPrompt(request), {
        system: "You are a comic story editor. You output only valid JSON, no prose.",
      });
      return { storyboard: normalizeStoryboard(request, data), cost: cost ?? 0, source: "llm" };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  // Every LLM attempt failed — degrade to the deterministic template so the service never hard-fails.
  const storyboard = buildTemplateStoryboard(request);
  storyboard.generated_by = "template_fallback";
  return { storyboard, cost: 0, source: "template_fallback", error: lastError };
}
