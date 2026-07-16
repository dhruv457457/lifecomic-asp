import fs from "fs-extra";
import path from "node:path";
import { generateImage, isConfigured, toDataUrl } from "./openrouter.js";

/** Prompt for a one-off character sheet reused as a reference for every panel (consistency anchor). */
function characterRefPrompt(character, style) {
  return [
    `Character reference sheet in ${style} comic style.`,
    `One single character, front-facing full body plus a face close-up, on a plain neutral background.`,
    `Character: ${character.visual_description}.`,
    "Clear, consistent design meant to be reused across many comic panels.",
    "No text, no captions, no speech bubbles, no letters, no watermark.",
  ].join(" ");
}

/**
 * Generates a character reference sheet once and returns { dataUrl, cost } (or null on failure/no
 * character). Passing it back into every panel is the reliable, cheap path to keeping the same
 * face/hair/outfit across the comic. Best-effort: a failure just means panels fall back to text-only
 * consistency, so it never fails the comic.
 */
// Paid routes hold the HTTP response open until the render finishes (OKX's A2MCP contract expects the
// deliverable inline, not a poll link), so a stuck image call must fail fast rather than sit on the
// default 90s timeout — real calls finish in 3-10s, so 25s is generous headroom, not a tight cutoff.
const IMAGE_TIMEOUT_MS = 25_000;

async function generateCharacterReference(storyboard, panelsDir) {
  const character = storyboard.character_bible?.characters?.[0];
  if (!character?.visual_description) return null;
  try {
    const img = await generateImage(characterRefPrompt(character, storyboard.style), { aspectRatio: "3:4", timeoutMs: IMAGE_TIMEOUT_MS });
    await fs.writeFile(path.join(panelsDir, "_character_ref.png"), img.buffer);
    return { dataUrl: toDataUrl(img), cost: img.cost ?? 0 };
  } catch {
    return null;
  }
}

/** Runs async tasks with a max concurrency so a big book doesn't fire 32 requests at once. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

/**
 * Generates one art image per panel and writes it to <outputDir>/panels/. Attaches `image_path` to
 * each panel in place. Fully best-effort: a panel that fails after retries is left without an image
 * (the renderer falls back to placeholder art for it), so a single bad panel never fails the comic.
 * Returns { generated, failed, cost }.
 */
export async function generatePanels(storyboard, outputDir, { concurrency = 4, retries = 1, characterReference = true } = {}) {
  if (!isConfigured()) return { generated: 0, failed: 0, cost: 0, skipped: "no_api_key" };

  const panelsDir = path.join(outputDir, "panels");
  await fs.ensureDir(panelsDir);

  let generated = 0;
  let failed = 0;
  let cost = 0;

  // Generate the character sheet first, then condition every panel on it for consistency. Costs one
  // extra image per comic; disable with characterReference:false. Falls back to text-only on failure.
  let references = [];
  if (characterReference) {
    const ref = await generateCharacterReference(storyboard, panelsDir);
    if (ref) {
      references = [ref.dataUrl];
      cost += ref.cost;
      storyboard.character_bible.reference_generated = true;
    }
  }
  const refSuffix = references.length
    ? " Match the character in the provided reference image exactly — same face, hair, and outfit."
    : "";

  const flat = [];
  for (const page of storyboard.pages) {
    for (const panel of page.panels) flat.push({ page: page.page, panel });
  }

  await mapLimit(flat, concurrency, async ({ page, panel }) => {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const img = await generateImage(panel.image_prompt + refSuffix, { aspectRatio: panel.aspect_ratio, references, timeoutMs: IMAGE_TIMEOUT_MS });
        const ext = img.mime === "image/png" ? "png" : "jpg";
        const file = path.join(panelsDir, `p${page}_${panel.panel}.${ext}`);
        await fs.writeFile(file, img.buffer);
        panel.image_path = file;
        generated += 1;
        cost += img.cost ?? 0;
        return;
      } catch (error) {
        if (attempt === retries) {
          failed += 1;
          panel.image_error = error instanceof Error ? error.message : String(error);
        }
      }
    }
  });

  return { generated, failed, cost: Number(cost.toFixed(6)) };
}
