import fs from "fs-extra";
import path from "node:path";
import sharp from "sharp";
import { generateImage, isConfigured, toDataUrl } from "./openrouter.js";
import { artDirectionClause } from "./art-direction.js";
import { uploadCharacterReference } from "./storage.js";

/**
 * The image model sometimes letterboxes generated art with flat-color padding to hit an unusual
 * aspect ratio (especially tall "hero" panels), leaving dead blank space baked into the pixels —
 * cover-fit scaling in the renderer can't crop that away since it's real image content, not a
 * canvas positioning issue. Trims uniform-color borders so every panel is full-bleed art; on any
 * failure (or if trim would remove almost everything, signalling a false-positive on real
 * artwork) falls back to the untrimmed buffer, so this never damages a normal image.
 */
async function trimPadding(buffer) {
  try {
    const { width: ow, height: oh } = await sharp(buffer).metadata();
    const trimmed = await sharp(buffer).trim({ threshold: 24 }).toBuffer({ resolveWithObject: true });
    const areaRatio = (trimmed.info.width * trimmed.info.height) / (ow * oh);
    // Use the trim only when it removed a meaningful border (< 97% of original area survives —
    // trivial trims aren't worth the risk) but didn't collapse to almost nothing (> 10% survives —
    // near-total loss means the source was basically blank, and a sliver blown up to fill the panel
    // would look worse than just keeping the untrimmed, if disappointing, original).
    if (areaRatio < 0.97 && areaRatio > 0.1) return trimmed.data;
    return buffer;
  } catch {
    return buffer;
  }
}

/** Prompt for a one-off character sheet reused as a reference for every panel (consistency anchor). */
function characterRefPrompt(characters, style, artDirection) {
  const castDesc = characters.map((c) => `${c.name}: ${c.visual_description}`).join("; ");
  return [
    `Character reference sheet in ${style} comic style.${artDirectionClause(artDirection)}`,
    characters.length > 1
      ? `Show all ${characters.length} distinct named characters together on one plain neutral background sheet, each clearly separate: a front-facing full body plus a face close-up for each.`
      : "Three views of ONE single character on a plain neutral background: front-facing full body, a 3/4 turn, and a face close-up with a clear expression.",
    `Character${characters.length > 1 ? "s" : ""}: ${castDesc}.`,
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

const EXTERNAL_FETCH_TIMEOUT_MS = 15_000;
const MAX_EXTERNAL_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);

async function generateCharacterReference(storyboard, panelsDir) {
  const characters = (storyboard.character_bible?.characters || []).filter((c) => c?.visual_description);
  if (!characters.length) return null;
  try {
    const img = await generateImage(characterRefPrompt(characters, storyboard.style, storyboard.art_direction), { aspectRatio: "3:4", timeoutMs: IMAGE_TIMEOUT_MS });
    const buffer = await trimPadding(img.buffer);
    await fs.writeFile(path.join(panelsDir, "_character_ref.png"), buffer);
    return { dataUrl: toDataUrl({ ...img, buffer }), cost: img.cost ?? 0 };
  } catch {
    return null;
  }
}

/** Sniffs the image type from magic bytes — a caller fully controls the image field, so the declared
 * content-type / data: prefix is not trusted. Returns a supported mime or null. */
function sniffMime(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

/** Materializes caller-supplied panel art (a hosted URL or base64) into a buffer + sniffed mime.
 * SSRF scope is deliberately basic: non-http(s) URLs are rejected and every fetch is time-bounded, but
 * private/link-local IP ranges are NOT blocked (single-container deployment, low blast radius). */
export async function resolveExternalPanelArt(panel) {
  let buffer;
  if (panel.image_url) {
    if (!/^https?:\/\//.test(panel.image_url)) throw new Error("image_url must be http(s)");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EXTERNAL_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(panel.image_url, { signal: controller.signal });
      if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
      const contentType = (res.headers.get("content-type") || "").split(";")[0].trim();
      if (contentType && !ALLOWED_MIME.has(contentType)) throw new Error(`unsupported content-type: ${contentType}`);
      buffer = Buffer.from(await res.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }
  } else {
    const raw = panel.image_data.replace(/^data:image\/\w+;base64,/, "");
    buffer = Buffer.from(raw, "base64");
  }
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_EXTERNAL_IMAGE_BYTES) throw new Error("image empty or too large");
  const mime = sniffMime(buffer);
  if (!mime) throw new Error("unrecognized or disallowed image format");
  return { buffer, mime };
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
 * each panel in place. A panel carrying caller-supplied art (`image_url`/`image_data`) skips generation
 * entirely — the art is fetched/decoded and dropped in. Fully best-effort: a panel that fails after
 * retries (or a bad external image) is left without an image (the renderer falls back to placeholder
 * art for it), so a single bad panel never fails the comic. Returns { generated, external, failed, cost }.
 */
export async function generatePanels(storyboard, outputDir, { concurrency = 4, retries = 1, characterReference = true, persistReference = false } = {}) {
  const panelsDir = path.join(outputDir, "panels");
  await fs.ensureDir(panelsDir);

  const flat = [];
  for (const page of storyboard.pages) {
    for (const panel of page.panels) flat.push({ page: page.page, panel });
  }
  const hasExternal = flat.some(({ panel }) => panel.image_url || panel.image_data);

  // Externally-illustrated panels don't need the image model, so a missing API key only blocks the
  // panels that actually need generation — a fully-BYO-art comic still renders without a key.
  if (!isConfigured() && !hasExternal) return { generated: 0, external: 0, failed: 0, cost: 0, skipped: "no_api_key" };

  let generated = 0;
  let external = 0;
  let failed = 0;
  let cost = 0;

  // Consistency anchor: caller-supplied reference images win (their own character/style, and it saves a
  // generation call); otherwise generate one multi-pose sheet and condition every panel on it. Falls
  // back to text-only on failure. Disable generation with characterReference:false.
  let references = [];
  const externalRefs = isConfigured() ? (storyboard.art_direction?.referenceImages || []) : [];
  if (externalRefs.length) {
    references = externalRefs;
    storyboard.character_bible.reference_source = "caller";
  } else if (characterReference && isConfigured()) {
    const ref = await generateCharacterReference(storyboard, panelsDir);
    if (ref) {
      references = [ref.dataUrl];
      cost += ref.cost;
      storyboard.character_bible.reference_generated = true;
      storyboard.character_bible.reference_source = "generated";
      // Series continuity needs a durable URL for THIS chapter's reference art (not just the base64
      // dataUrl, which never leaves this process) so the next chapter can lock onto the same faces.
      // Only bothered with for series chapters — a one-off comic never needs this extra upload.
      if (persistReference) {
        const url = await uploadCharacterReference(storyboard.comic_id, path.join(panelsDir, "_character_ref.png"));
        if (url) storyboard.character_bible.reference_url = url;
      }
    }
  }
  const castSize = storyboard.character_bible?.characters?.length || 1;
  const refSuffix = references.length
    ? (castSize > 1
        ? " Match each named character to their appearance in the reference sheet exactly — identical faces, hair, and outfits, correctly matched to each name — but pose and frame them naturally for THIS scene; do not copy the reference's pose, layout, or plain background."
        : " Keep the same character as the reference — identical face, hair, and outfit — but pose and frame them naturally for THIS scene; do not copy the reference's pose, layout, or plain background.")
    : "";

  await mapLimit(flat, concurrency, async ({ page, panel }) => {
    if (panel.image_url || panel.image_data) {
      try {
        const { buffer, mime } = await resolveExternalPanelArt(panel);
        const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
        const file = path.join(panelsDir, `p${page}_${panel.panel}.${ext}`);
        await fs.writeFile(file, buffer);
        panel.image_path = file;
        external += 1;
      } catch (error) {
        failed += 1;
        panel.image_error = error instanceof Error ? error.message : String(error);
      }
      return;
    }

    if (!isConfigured()) {
      failed += 1;
      panel.image_error = "no_api_key";
      return;
    }

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const img = await generateImage(panel.image_prompt + refSuffix, { aspectRatio: panel.aspect_ratio, references, timeoutMs: IMAGE_TIMEOUT_MS });
        const ext = img.mime === "image/png" ? "png" : "jpg";
        const file = path.join(panelsDir, `p${page}_${panel.panel}.${ext}`);
        await fs.writeFile(file, await trimPadding(img.buffer));
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

  return { generated, external, failed, cost: Number(cost.toFixed(6)) };
}
