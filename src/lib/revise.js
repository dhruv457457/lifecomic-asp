import fs from "fs-extra";
import path from "node:path";
import { generatePanels } from "./panels.js";
import { renderOnePage, buildDeliverables } from "../renderer.js";
import { getComic } from "./comic-registry.js";

const FETCH_TIMEOUT_MS = 20_000;

/** Downloads a hosted page image to a local path. Throws on any non-OK response so a broken rebuild
 * never ships silently. */
async function download(url, destPath) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`download failed (${res.status}) for ${url}`);
    await fs.writeFile(destPath, Buffer.from(await res.arrayBuffer()));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Regenerates ONE page of an existing comic without redoing the whole book. Reuses the already-rendered
 * pages (downloaded from their hosted URLs) and re-renders only the target page from freshly generated
 * art, then rebuilds the PDF + CBZ. Preserves the original cast, style, and art direction (they live in
 * the stored storyboard), so the revised page stays consistent with the rest.
 *
 * Resolves the source comic from the Redis registry by `comicId`; if that's unavailable (Redis down /
 * expired / never recorded), the caller may instead pass `storyboard` + `pages` (ordered hosted URLs)
 * directly. Returns { id, page, files, art } ready for the server to upload + respond.
 *
 * `page` is the 1-based STORY page number (a book's cover/credits are not separately revisable).
 */
export async function reviseComicPage({ comicId, page, instructions, storyboard: suppliedStoryboard, pages: suppliedPages }, { outputDir }) {
  const record = comicId ? await getComic(comicId) : null;
  const storyboard = suppliedStoryboard || (record?.storyboardUrl ? await fetchJson(record.storyboardUrl) : null);
  const pageUrls = suppliedPages || record?.pages || null;
  if (!storyboard || !Array.isArray(pageUrls) || !pageUrls.length) {
    throw new Error("could not resolve the source comic — pass a known comicId, or supply { storyboard, pages }");
  }

  const storyPageCount = storyboard.pages.length;
  const k = Math.floor(Number(page));
  if (!Number.isFinite(k) || k < 1 || k > storyPageCount) {
    throw new Error(`page ${page} out of range — this comic has ${storyPageCount} story page(s)`);
  }

  // Map the story page number to its index in the ordered page-URL list. A book carries a cover at
  // index 0, so story page k sits at index k; a single page sits at index 0.
  const isBook = storyPageCount > 1;
  const targetIndex = isBook ? k : 0;
  if (targetIndex >= pageUrls.length) throw new Error("page index out of range for the stored page set");

  const pagesDir = path.join(outputDir, "pages");
  await fs.ensureDir(pagesDir);

  // Preserve the original filenames (from the hosted URLs) so a re-upload overwrites the same public
  // ids and the page set stays coherent.
  const basenames = pageUrls.map((u) => path.basename(new URL(u).pathname));

  // Download every page EXCEPT the one we're regenerating.
  await Promise.all(
    pageUrls.map((url, i) => (i === targetIndex ? null : download(url, path.join(pagesDir, basenames[i])))),
  );

  // Apply the revision to the target story page's panels, then regenerate ONLY that page. Anchoring on
  // an already-delivered page keeps the new art consistent with the established look.
  const targetPage = storyboard.pages[k - 1];
  const instruction = String(instructions || "").slice(0, 400).trim();
  if (instruction) {
    for (const panel of targetPage.panels) {
      panel.image_prompt = `${panel.image_prompt} Revision requested: ${instruction}`.slice(0, 1600);
    }
  }
  const anchor = pageUrls.find((_, i) => i !== targetIndex && /page_\d/.test(basenames[i]));
  const slice = {
    ...storyboard,
    art_direction: {
      ...storyboard.art_direction,
      referenceImages: storyboard.art_direction?.referenceImages?.length
        ? storyboard.art_direction.referenceImages
        : (anchor ? [anchor] : undefined),
    },
    pages: [targetPage],
  };
  const art = await generatePanels(slice, outputDir, { concurrency: 4, characterReference: true });

  // Re-render the target page from its new panels, then rebuild the deliverables from the full set.
  await renderOnePage(storyboard, targetPage, path.join(pagesDir, basenames[targetIndex]));
  const pageFiles = basenames.map((b) => path.join(pagesDir, b));
  const { pdf, cbz } = await buildDeliverables(storyboard, pageFiles, outputDir);

  const storyboardPath = path.join(outputDir, "storyboard.json");
  await fs.writeJson(storyboardPath, storyboard, { spaces: 2 });

  return {
    id: comicId || storyboard.comic_id,
    page: k,
    art: { generated: art.generated, external: art.external ?? 0, failed: art.failed },
    cost: Number(art.cost || 0),
    title: storyboard.title,
    storyboard,
    files: { pages: pageFiles, pdf, cbz, storyboard: storyboardPath },
  };
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`storyboard fetch failed (${res.status})`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
