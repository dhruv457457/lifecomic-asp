import fs from "fs-extra";
import path from "node:path";
import { generateImage, isConfigured } from "./openrouter.js";

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
export async function generatePanels(storyboard, outputDir, { concurrency = 4, retries = 1 } = {}) {
  if (!isConfigured()) return { generated: 0, failed: 0, cost: 0, skipped: "no_api_key" };

  const panelsDir = path.join(outputDir, "panels");
  await fs.ensureDir(panelsDir);

  const flat = [];
  for (const page of storyboard.pages) {
    for (const panel of page.panels) flat.push({ page: page.page, panel });
  }

  let generated = 0;
  let failed = 0;
  let cost = 0;

  await mapLimit(flat, concurrency, async ({ page, panel }) => {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const img = await generateImage(panel.image_prompt, { aspectRatio: panel.aspect_ratio });
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
