import fs from "fs-extra";
import path from "node:path";
import { generateStoryboard } from "./lib/storyboard-llm.js";
import { generatePanels } from "./lib/panels.js";
import { assignLayout } from "./lib/layout.js";
import { renderComic } from "./renderer.js";

/**
 * Full pipeline: story -> LLM storyboard -> per-panel art -> rendered pages + PDF.
 * `withArt: false` skips image generation (placeholder pages) for the free/preview tier.
 */
export async function createComic(request, options = {}) {
  const outputDir = options.outputDir || "output/comic";
  const withArt = options.withArt !== false;
  await fs.ensureDir(outputDir);

  const { storyboard, cost: storyboardCost, source } = await generateStoryboard(request);
  assignLayout(storyboard); // varied panel rects + per-panel aspect ratio, before any art is generated
  await fs.writeJson(path.join(outputDir, "storyboard.json"), storyboard, { spaces: 2 });

  let art = { generated: 0, failed: 0, cost: 0, skipped: withArt ? undefined : "art_disabled" };
  if (withArt) {
    art = await generatePanels(storyboard, outputDir, { concurrency: options.concurrency ?? 4, characterReference: options.characterReference !== false });
    await fs.writeJson(path.join(outputDir, "storyboard.json"), storyboard, { spaces: 2 });
  }

  const files = await renderComic(storyboard, outputDir);
  const sidecars = await writeSidecars(storyboard, outputDir);
  Object.assign(files, sidecars); // add imagePrompts + socialCaption paths for storage upload

  return {
    id: storyboard.comic_id,
    status: withArt ? (art.failed ? "rendered_partial_art" : "rendered") : "rendered_placeholder",
    title: storyboard.title,
    storyboardSource: source,
    art: { generated: art.generated, failed: art.failed },
    cost: Number((Number(storyboardCost || 0) + Number(art.cost || 0)).toFixed(6)),
    files,
    storyboard,
  };
}

/** Writes the plain-text deliverables of the output package and returns their paths. */
async function writeSidecars(storyboard, outputDir) {
  const prompts = storyboard.pages
    .flatMap((page) => page.panels.map((p) => `P${page.page}.${p.panel}: ${p.image_prompt}`))
    .join("\n");
  const imagePrompts = path.join(outputDir, "image_prompts.txt");
  const socialCaption = path.join(outputDir, "social_caption.txt");
  await fs.writeFile(imagePrompts, prompts);
  await fs.writeFile(socialCaption, storyboard.social_caption ?? "");
  return { imagePrompts, socialCaption };
}
