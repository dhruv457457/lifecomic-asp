import slugify from "slugify";
import { chatJSON, isConfigured } from "./openrouter.js";
import { buildStoryboard as buildTemplateStoryboard } from "../storyboard.js";
import { normalizeArtDirection, artDirectionClause } from "./art-direction.js";

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
 * the renderer — not the image model — owns all captions and dialogue. `characters` always has at
 * least one entry; a closed cast list is spelled out so the model doesn't improvise extra bystanders.
 */
function buildPanelImagePrompt({ style, characters, beat, tone, artDirection, styleRules }) {
  const castLine = characters.length > 1
    ? `Consistent recurring characters — ${characters.map((c) => `${c.name}: ${c.visual_description}`).join("; ")}. Keep each character's face, hair, and outfit identical in every panel; never blend or swap their features.`
    : `Consistent recurring character: ${characters[0].visual_description}. Keep the same face, hair, and outfit in every panel. ${characters[0].continuity_notes || ""}`.trim();
  return [
    `Single ${style} comic panel, expressive comic art, clean composition, ${tone} mood.${artDirectionClause(artDirection)}`,
    castLine,
    `Scene: ${beat}`,
    styleRules?.length ? styleRules.join(" ") : null,
    "Wide panel framing. Absolutely no text, no captions, no speech bubbles, no letters, no signs, no watermark.",
    characters.length > 1
      ? `Only these ${characters.length} named characters appear as people in this panel — no extra unnamed bystanders unless the scene explicitly calls for a background crowd.`
      : null,
  ].filter(Boolean).join(" ");
}

function normalizeStoryboard(request, llm) {
  const fmtKey = resolveFormat(request.format);
  const fmt = FORMATS[fmtKey];
  // An explicit numeric `pages` (2–12) overrides the named format's page count; panels stay at 4/page.
  const pageCount = clampPages(request.pages) ?? fmt.pages;
  const title = String(llm.title || request.title || "Untitled Day").slice(0, 80);
  const artDirection = normalizeArtDirection(request.artDirection);
  const style = artDirection?.style || request.style || llm.style || "slice-of-life manga";
  const tone = artDirection?.tone || request.tone || llm.tone || "warm and honest";

  // Build the FULL cast, not just character 0 — a request with 2 characters used to silently drop
  // the second one, leaving it with no locked visual identity (the model then improvised a different-
  // looking "extra" for it every panel, and the story LLM sometimes invented yet another name for it).
  const requestChars = Array.isArray(request.characters) ? request.characters : [];
  const llmChars = Array.isArray(llm.characters) ? llm.characters : [];
  const castSize = Math.max(requestChars.length, llmChars.length, 1);
  const characters = [];
  for (let i = 0; i < castSize; i += 1) {
    const rc = requestChars[i];
    const lc = llmChars[i];
    characters.push({
      id: i === 0 ? "char_main" : `char_${i + 1}`,
      name: lc?.name || rc?.name || (i === 0 ? "Main Character" : `Character ${i + 1}`),
      visual_description:
        lc?.visual_description || rc?.description || "expressive everyday person, relatable and cinematic",
      continuity_notes:
        lc?.continuity_notes || rc?.continuity_notes ||
        "Keep the same outfit, face shape, hairstyle, and expressiveness across every panel.",
    });
  }

  const styleRules = [
    "Generate artwork without text inside the panels.",
    "Use consistent character appearance across panels.",
    "Keep backgrounds readable and not too busy.",
  ];

  const llmPages = Array.isArray(llm.pages) ? llm.pages : [];
  const pages = [];
  for (let p = 0; p < pageCount; p += 1) {
    const src = llmPages[p] || {};
    const srcPanels = Array.isArray(src.panels) ? src.panels : [];
    const panels = [];
    for (let i = 0; i < fmt.panelsPerPage; i += 1) {
      const panel = srcPanels[i] || {};
      const beat = String(panel.beat || panel.scene || "A quiet beat in the story.").slice(0, 240);
      const caption = String(panel.caption || "").slice(0, 150);
      // Keep up to two dialogue lines so the renderer can show a two-speaker exchange. Accepts an
      // array of {speaker,text} (or bare strings) or a single string; empties are dropped.
      const rawDialogue = Array.isArray(panel.dialogue)
        ? panel.dialogue
        : typeof panel.dialogue === "string"
          ? [panel.dialogue]
          : [];
      // Clamp speaker to a known cast member (case-insensitive) so the LLM can't attribute a line to
      // an invented name it never established a visual identity for — falls back to the lead.
      const dialogue = rawDialogue
        .map((d) => {
          const rawSpeaker = String(d?.speaker || characters[0].name).slice(0, 40);
          const speaker = characters.find((c) => c.name.toLowerCase() === rawSpeaker.toLowerCase())?.name || characters[0].name;
          return { speaker, text: String(typeof d === "string" ? d : (d?.text ?? "")).slice(0, 120) };
        })
        .filter((d) => d.text)
        .slice(0, 2);
      // A caller (buyer agent) may supply its own richer art prompt; otherwise we build one. When the
      // caller wrote the prompt AND set artDirection, append the design-chart clause so the visual
      // identity is enforced regardless of who authored the prompt. The freshly-built path already
      // includes the clause inside buildPanelImagePrompt, so it must NOT be appended again there.
      const image_prompt = panel.image_prompt
        ? String(panel.image_prompt).slice(0, 1400) + artDirectionClause(artDirection)
        : buildPanelImagePrompt({ style, characters, beat, tone, artDirection, styleRules });
      const built = {
        panel: i + 1,
        beat,
        caption,
        dialogue,
        image_prompt,
      };
      // Bring-your-own-art: a caller can supply finished panel art (a hosted URL, or base64 for small
      // submissions) instead of triggering generation. Materialized in generatePanels; renderer-agnostic.
      if (typeof panel.image_url === "string" && /^https?:\/\//.test(panel.image_url.trim())) {
        built.image_url = panel.image_url.trim().slice(0, 2000);
      } else if (typeof panel.image_data === "string" && panel.image_data.trim()) {
        built.image_data = panel.image_data.trim();
      }
      panels.push(built);
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
    art_direction: artDirection,
    character_bible: {
      characters,
      style_rules: styleRules,
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
  const chars = Array.isArray(request.characters) ? request.characters : [];
  return [
    `Turn this real-life moment into a ${label} comic storyboard.`,
    "",
    `STORY: ${request.story}`,
    `STYLE: ${request.style || "slice-of-life manga"}`,
    `MOOD: ${request.tone || "warm and honest"}`,
    chars.length
      ? [
          `CAST (exactly ${chars.length} character${chars.length > 1 ? "s" : ""} — use ONLY these names for dialogue speakers`,
          "and the story; do not invent any additional named characters):",
          ...chars.map((c, i) => `${i + 1}. ${c.name || `Character ${i + 1}`} — ${c.description || ""}`),
        ].join("\n")
      : "",
    "",
    `Produce exactly ${pageCount} page(s), each with exactly ${fmt.panelsPerPage} panels (${totalPanels} panels total).`,
    "Give the comic an evocative TITLE. For each panel provide a visual 'beat' (what we see) and a",
    "narration 'caption' (<= 18 words). Write the caption as vivid, atmospheric PROSE that carries the",
    "scene's mood in its word choice — never a flat plot summary ('He ran, then he was gone' is weak;",
    "something that makes the reader FEEL the moment is strong). Optionally add one line of 'dialogue'",
    "(<= 14 words, natural spoken words a person would actually say) attributed to one of the cast above",
    "via a 'speaker' field — OMIT dialogue entirely for a panel rather than writing a bare ellipsis or",
    "wordless filler; a strong caption alone can carry a silent beat. Keep the emotional arc coherent and",
    "end on a satisfying beat. Also give one shareable 'social_caption'.",
    "",
    "Return STRICT JSON only, this exact shape:",
    `{"title":"...","characters":[{"name":"...","visual_description":"..."}${chars.length > 1 ? ",{...}" : ""}],`,
    `"pages":[{"page_title":"...","panels":[{"beat":"...","caption":"...","dialogue":[{"speaker":"...","text":"..."}]}]}],`,
    `"social_caption":"..."}`,
    chars.length > 1
      ? `The "characters" array must have exactly ${chars.length} entries, one per cast member above, in the same order, each with a distinct "visual_description" a comic artist could draw consistently.`
      : "",
  ].filter(Boolean).join("\n");
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
