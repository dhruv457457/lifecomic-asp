import fs from "fs-extra";
import path from "node:path";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { PAGE, panelArea, assignLayout } from "./lib/layout.js";
import { FONTS } from "./lib/fonts.js";

export async function renderComic(storyboard, outputDir) {
  // Ensure every panel has a layout rect (storyboards rendered without the pipeline, or older ones).
  if (!storyboard.pages?.[0]?.panels?.[0]?.layout) assignLayout(storyboard);

  const pagesDir = path.join(outputDir, "pages");
  await fs.ensureDir(pagesDir);

  // Multi-page books get a cover + a credits/back page; a single page carries its title in-header.
  const isBook = storyboard.pages.length > 1;

  const pageFiles = [];
  let coverPath = null;
  if (isBook) {
    coverPath = path.join(pagesDir, "page_000_cover.png");
    await renderCover(storyboard, coverPath);
    pageFiles.push(coverPath);
  }

  for (const page of storyboard.pages) {
    const pagePath = path.join(pagesDir, `page_${String(page.page).padStart(3, "0")}.png`);
    await renderPage(storyboard, page, pagePath);
    pageFiles.push(pagePath);
  }

  if (isBook) {
    const creditsPath = path.join(pagesDir, "page_999_credits.png");
    await renderCredits(storyboard, creditsPath);
    pageFiles.push(creditsPath);
  }

  const pdfPath = path.join(outputDir, "comic.pdf");
  await renderPdf(storyboard, pageFiles, pdfPath);

  return {
    pdf: pdfPath,
    pages: pageFiles, // reading order: [cover?, ...pages, credits?]
    cover: coverPath,
    storyboard: path.join(outputDir, "storyboard.json"),
  };
}

async function renderPage(storyboard, page, outPath) {
  const canvas = createCanvas(PAGE.width, PAGE.height);
  const ctx = canvas.getContext("2d");

  drawBackground(ctx);
  drawHeader(ctx, storyboard.title, page.page_title);

  // Fall back to a plain grid only if a panel is missing its assigned layout rect.
  const area = panelArea();
  for (let index = 0; index < page.panels.length; index += 1) {
    const panel = page.panels[index];
    const rect = panel.layout || gridFallback(area, index, page.panels.length);
    let image = null;
    if (panel.image_path) {
      image = await loadImage(panel.image_path).catch(() => null);
    }
    drawPanel(ctx, panel, image, rect.x, rect.y, rect.w, rect.h, index);
  }

  drawFooter(ctx, page.page);

  const buffer = canvas.toBuffer("image/png");
  await sharp(buffer).png().toFile(outPath);
}

function gridFallback(area, index, count) {
  const cols = 2;
  const rows = Math.ceil(count / cols);
  const g = PAGE.gutter;
  const w = (area.w - g * (cols - 1)) / cols;
  const h = (area.h - g * (rows - 1)) / rows;
  const col = index % cols;
  const row = Math.floor(index / cols);
  return { x: area.x + col * (w + g), y: area.y + row * (h + g), w, h };
}

function drawBackground(ctx) {
  ctx.fillStyle = "#fffaf0";
  ctx.fillRect(0, 0, PAGE.width, PAGE.height);
  ctx.fillStyle = "#1b1714";
  ctx.fillRect(34, 34, PAGE.width - 68, PAGE.height - 68);
  ctx.fillStyle = "#fffaf0";
  ctx.fillRect(48, 48, PAGE.width - 96, PAGE.height - 96);
}

function drawHeader(ctx, title, pageTitle) {
  ctx.fillStyle = "#1b1714";
  // Auto-shrink the title so long ones (e.g. "JAIPUR WEB-SLINGER VS. MBAPU THE UNDEAD") fit the width.
  const maxTitleWidth = PAGE.width - PAGE.margin * 2;
  let titleSize = 72;
  do {
    ctx.font = `bold ${titleSize}px ${FONTS.display}`;
    if (ctx.measureText(title).width <= maxTitleWidth) break;
    titleSize -= 2;
  } while (titleSize > 34);
  ctx.fillText(title, PAGE.margin, 135);
  ctx.font = "32px Georgia";
  ctx.fillText(pageTitle, PAGE.margin, 182);
  ctx.strokeStyle = "#1b1714";
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.moveTo(PAGE.margin, 215);
  ctx.lineTo(PAGE.width - PAGE.margin, 215);
  ctx.stroke();
}

function drawPanel(ctx, panel, image, x, y, width, height, index) {
  ctx.save();

  if (image) {
    // Cover-fit the art into the panel rect, clipped to the panel bounds.
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, width, height);
    ctx.clip();
    const scale = Math.max(width / image.width, height / image.height);
    const drawW = image.width * scale;
    const drawH = image.height * scale;
    ctx.drawImage(image, x + (width - drawW) / 2, y + (height - drawH) / 2, drawW, drawH);
    ctx.restore();
  } else {
    // Clip so the placeholder motif can't bleed past the panel into the gutter/neighbours.
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, width, height);
    ctx.clip();
    ctx.fillStyle = panelColor(index);
    ctx.fillRect(x, y, width, height);
    drawPlaceholderArt(ctx, x, y, width, height, index);
    ctx.restore();
  }

  // Kinetic speed lines for action panels, clipped inside the frame, under the border + lettering.
  if (panel.is_action) drawSpeedLines(ctx, x, y, width, height);

  ctx.strokeStyle = "#17120f";
  ctx.lineWidth = 8;
  ctx.strokeRect(x, y, width, height);

  const caption = (panel.caption || "").trim();
  if (caption) drawCaption(ctx, caption, x + 24, y + 24, width - 48);
  drawDialogue(ctx, panel.dialogue, x, y, width, height);

  ctx.restore();
}

function drawPlaceholderArt(ctx, x, y, width, height, index) {
  const centerX = x + width / 2;
  const centerY = y + height / 2;
  ctx.strokeStyle = "rgba(27, 23, 20, 0.22)";
  ctx.lineWidth = 5;
  for (let i = 0; i < 7; i += 1) {
    ctx.beginPath();
    ctx.arc(centerX, centerY, 55 + i * 42, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.fillStyle = "rgba(27, 23, 20, 0.78)";
  ctx.beginPath();
  ctx.arc(centerX, centerY - 50, 58, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(centerX - 85, centerY + 20, 170, 190);
  ctx.fillStyle = "rgba(255, 250, 240, 0.88)";
  ctx.font = "bold 58px Georgia";
  ctx.fillText(String(index + 1), x + width - 96, y + 86);
}

function drawCaption(ctx, text, x, y, width) {
  ctx.font = `bold 28px ${FONTS.comic}`;
  const lineHeight = 34;
  const lines = computeWrappedLines(ctx, text, width - 36, 3);
  const boxHeight = 18 + lines.length * lineHeight + 6;

  ctx.fillStyle = "rgba(255, 250, 240, 0.94)";
  roundRect(ctx, x, y, width, boxHeight, 16);
  ctx.fill();
  ctx.strokeStyle = "#1b1714";
  ctx.lineWidth = 4;
  ctx.stroke();

  ctx.fillStyle = "#1b1714";
  lines.forEach((line, i) => ctx.fillText(line, x + 18, y + 36 + i * lineHeight));
}

/** Wraps text into at most maxLines lines; the last line gets an ellipsis if text overflows. */
function computeWrappedLines(ctx, text, maxWidth, maxLines) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
      if (lines.length === maxLines - 1) break;
    } else {
      line = test;
    }
  }
  if (lines.length < maxLines) {
    if (line) lines.push(line);
  } else {
    // Hit the line cap: ellipsize whatever remains so it never cuts mid-word.
    let last = line;
    while (ctx.measureText(`${last}…`).width > maxWidth && last.includes(" ")) {
      last = last.slice(0, last.lastIndexOf(" "));
    }
    lines.push(`${last}…`);
  }
  return lines;
}

/**
 * Draws up to two speech bubbles for a panel, each auto-sized to its text and given a tail that
 * points down toward the speaker. Two speakers alternate sides so the exchange reads as back-and-
 * forth. Bubbles stack upward from the panel's bottom so they never collide with the caption on top.
 */
function drawDialogue(ctx, dialogue, px, py, pw, ph) {
  const texts = (Array.isArray(dialogue) ? dialogue : [])
    .map((d) => (d?.text || "").trim())
    .filter(Boolean)
    .slice(0, 2);
  if (!texts.length) return;

  const pad = 22;
  const maxBubbleW = Math.max(160, Math.min(pw - 92, 540));
  let cursorBottom = py + ph - 30;

  texts.forEach((text, i) => {
    const fit = fitText(ctx, text, maxBubbleW - pad * 2, 3, 30, 20);
    const bw = Math.min(maxBubbleW, Math.max(150, fit.maxLineWidth + pad * 2));
    const bh = pad * 2 + fit.lines.length * fit.lineHeight;
    const side = i % 2 === 0 ? "left" : "right";
    const bx = side === "left" ? px + 46 : px + pw - 46 - bw;
    const by = cursorBottom - bh;
    drawBubble(ctx, fit, bx, by, bw, bh, pad, side);
    cursorBottom = by - 20; // next bubble sits above with a small gap
  });
}

function drawBubble(ctx, fit, x, y, w, h, pad, side) {
  ctx.save();
  // Bubble body.
  ctx.fillStyle = "#ffffff";
  roundRect(ctx, x, y, w, h, 24);
  ctx.fill();

  // Tail: filled triangle hanging below the bubble, offset toward the speaker's side.
  const t = side === "left" ? x + w * 0.3 : x + w * 0.7;
  const tip = t + (side === "left" ? -14 : 14);
  ctx.beginPath();
  ctx.moveTo(t - 17, y + h - 4);
  ctx.lineTo(tip, y + h + 30);
  ctx.lineTo(t + 17, y + h - 4);
  ctx.closePath();
  ctx.fillStyle = "#ffffff";
  ctx.fill();

  // Outline the body, then the tail's two slanted edges only (so it merges into the bubble bottom).
  ctx.strokeStyle = "#1b1714";
  ctx.lineWidth = 5;
  roundRect(ctx, x, y, w, h, 24);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(t - 17, y + h - 4);
  ctx.lineTo(tip, y + h + 30);
  ctx.lineTo(t + 17, y + h - 4);
  ctx.stroke();

  // Text.
  ctx.fillStyle = "#1b1714";
  ctx.font = `${fit.fontSize}px ${FONTS.comic}`;
  fit.lines.forEach((line, i) => {
    ctx.fillText(line, x + pad, y + pad + i * fit.lineHeight + fit.fontSize * 0.82);
  });
  ctx.restore();
}

/**
 * Finds the largest font size (between startSize and minSize) at which `text` fits in `maxWidth`
 * within `maxLines` without needing an ellipsis. Returns the chosen lines, size, line height, and
 * the widest line — so the bubble can be sized snugly to the text.
 */
function fitText(ctx, text, maxWidth, maxLines, startSize, minSize) {
  let chosen;
  for (let size = startSize; size >= minSize; size -= 2) {
    ctx.font = `${size}px ${FONTS.comic}`;
    const lines = computeWrappedLines(ctx, text, maxWidth, maxLines);
    const maxLineWidth = Math.max(...lines.map((l) => ctx.measureText(l).width));
    chosen = { lines, fontSize: size, lineHeight: Math.round(size * 1.2), maxLineWidth };
    if (!lines[lines.length - 1].endsWith("…")) break; // fits without truncation
  }
  return chosen;
}

/** Subtle radial speed lines from the panel center — sells motion on action beats. */
function drawSpeedLines(ctx, x, y, width, height) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, width, height);
  ctx.clip();
  const cx = x + width / 2;
  const cy = y + height * 0.45;
  const reach = Math.hypot(width, height);
  ctx.strokeStyle = "rgba(20, 16, 12, 0.16)";
  ctx.lineWidth = 3;
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 18) {
    const inner = 90;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
    ctx.lineTo(cx + Math.cos(a) * reach, cy + Math.sin(a) * reach);
    ctx.stroke();
  }
  ctx.restore();
}

function drawFooter(ctx, pageNumber) {
  ctx.fillStyle = "#1b1714";
  ctx.font = "24px Georgia";
  ctx.fillText(`Page ${pageNumber}`, PAGE.width - PAGE.margin - 90, PAGE.height - 72);
}

function panelColor(index) {
  return ["#f3c96d", "#7eb6b2", "#d9856b", "#97a979"][index % 4];
}

function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

/** Loads the first panel that actually has generated art, for use as a cover backdrop. Null if none. */
async function firstPanelImage(storyboard) {
  for (const page of storyboard.pages) {
    for (const panel of page.panels) {
      if (panel.image_path) {
        const img = await loadImage(panel.image_path).catch(() => null);
        if (img) return img;
      }
    }
  }
  return null;
}

/** Decorative concentric motif for covers when there's no art yet (free/preview tier). */
function drawCoverMotif(ctx, x, y, w, h) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.strokeStyle = "rgba(27, 23, 20, 0.12)";
  ctx.lineWidth = 6;
  for (let i = 0; i < 22; i += 1) {
    ctx.beginPath();
    ctx.arc(cx, cy, 70 + i * 60, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

async function renderCover(storyboard, outPath) {
  const canvas = createCanvas(PAGE.width, PAGE.height);
  const ctx = canvas.getContext("2d");
  drawBackground(ctx);

  const bx = 90;
  const by = 90;
  const bw = PAGE.width - 180;
  const bh = PAGE.height - 180;

  const hero = await firstPanelImage(storyboard);
  const light = Boolean(hero); // dark art backdrop -> light text
  if (hero) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(bx, by, bw, bh);
    ctx.clip();
    const scale = Math.max(bw / hero.width, bh / hero.height);
    ctx.drawImage(hero, bx + (bw - hero.width * scale) / 2, by + (bh - hero.height * scale) / 2, hero.width * scale, hero.height * scale);
    ctx.fillStyle = "rgba(18, 14, 10, 0.46)"; // scrim for legibility
    ctx.fillRect(bx, by, bw, bh);
    ctx.restore();
  } else {
    drawCoverMotif(ctx, bx, by, bw, bh);
  }

  const cx = PAGE.width / 2;
  ctx.textAlign = "center";

  ctx.font = "bold 30px Arial";
  ctx.fillStyle = light ? "rgba(255,250,240,0.9)" : "#1b1714";
  ctx.fillText("A LIFECOMIC ORIGINAL", cx, by + 96);

  // Title: pick the largest size that fits, then wrap up to 3 centered lines.
  let size = 132;
  do {
    ctx.font = `bold ${size}px ${FONTS.display}`;
    if (ctx.measureText(storyboard.title).width <= (bw - 160) * 2.4) break;
    size -= 4;
  } while (size > 52);
  const titleLines = computeWrappedLines(ctx, String(storyboard.title).toUpperCase(), bw - 160, 3);
  const titleTop = PAGE.height * 0.4;
  ctx.fillStyle = light ? "#fffaf0" : "#1b1714";
  titleLines.forEach((line, i) => ctx.fillText(line, cx, titleTop + i * (size + 10)));

  ctx.font = "italic 40px Georgia";
  ctx.fillStyle = light ? "rgba(255,250,240,0.92)" : "#5a4f47";
  ctx.fillText(`${storyboard.style} · ${storyboard.tone}`, cx, titleTop + titleLines.length * (size + 10) + 26);

  const name = storyboard.character_bible?.characters?.[0]?.name;
  if (name) {
    ctx.font = "36px Georgia";
    ctx.fillStyle = light ? "rgba(255,250,240,0.95)" : "#1b1714";
    ctx.fillText(`featuring ${name}`, cx, PAGE.height - 230);
  }
  ctx.font = "26px Arial";
  ctx.fillStyle = light ? "rgba(255,250,240,0.82)" : "#7a6f66";
  ctx.fillText(new Date().toISOString().slice(0, 10), cx, PAGE.height - 156);

  ctx.textAlign = "left";
  const buffer = canvas.toBuffer("image/png");
  await sharp(buffer).png().toFile(outPath);
}

async function renderCredits(storyboard, outPath) {
  const canvas = createCanvas(PAGE.width, PAGE.height);
  const ctx = canvas.getContext("2d");
  drawBackground(ctx);

  const cx = PAGE.width / 2;
  ctx.textAlign = "center";

  ctx.fillStyle = "#1b1714";
  ctx.font = `bold 72px ${FONTS.display}`;
  ctx.fillText("THE END", cx, PAGE.height * 0.28);

  // Shareable caption, wrapped and centered.
  ctx.font = "italic 38px Georgia";
  ctx.fillStyle = "#5a4f47";
  const capLines = computeWrappedLines(ctx, storyboard.social_caption || "", PAGE.width - 400, 3);
  capLines.forEach((line, i) => ctx.fillText(line, cx, PAGE.height * 0.38 + i * 50));

  // Credits block.
  const name = storyboard.character_bible?.characters?.[0]?.name || "—";
  const rows = [
    ["Title", storyboard.title],
    ["Featuring", name],
    ["Style", storyboard.style],
    ["Mood", storyboard.tone],
    ["Pages", String(storyboard.pages.length)],
  ];
  ctx.font = "28px Arial";
  let ry = PAGE.height * 0.56;
  for (const [k, v] of rows) {
    ctx.textAlign = "right";
    ctx.fillStyle = "#9a8f86";
    ctx.fillText(`${k}`, cx - 24, ry);
    ctx.textAlign = "left";
    ctx.fillStyle = "#1b1714";
    ctx.fillText(String(v), cx + 24, ry);
    ry += 46;
  }

  ctx.textAlign = "center";
  ctx.font = "bold 30px Arial";
  ctx.fillStyle = "#1b1714";
  ctx.fillText("Created with LifeComic", cx, PAGE.height - 200);
  ctx.font = "24px Arial";
  ctx.fillStyle = "#7a6f66";
  ctx.fillText("Turn your day into a comic · LifeComic", cx, PAGE.height - 156);

  ctx.textAlign = "left";
  const buffer = canvas.toBuffer("image/png");
  await sharp(buffer).png().toFile(outPath);
}

// PDF width used for embedded pages. Full-res PNGs would make a multi-page book's PDF 30MB+ and blow
// past object-storage upload limits (Cloudinary free tier = 10MB/file), so each page is downscaled
// and JPEG-compressed for the shareable PDF. Individual page PNGs are still delivered at full res.
const PDF_PAGE_WIDTH = 1240;
const PDF_PAGE_HEIGHT = Math.round((PAGE.height / PAGE.width) * PDF_PAGE_WIDTH);

async function renderPdf(storyboard, pageFiles, pdfPath) {
  const doc = new PDFDocument({ size: [PDF_PAGE_WIDTH, PDF_PAGE_HEIGHT], margin: 0 });
  const stream = fs.createWriteStream(pdfPath);
  doc.pipe(stream);

  for (let index = 0; index < pageFiles.length; index += 1) {
    const jpg = await sharp(pageFiles[index]).resize(PDF_PAGE_WIDTH, PDF_PAGE_HEIGHT).jpeg({ quality: 82 }).toBuffer();
    if (index > 0) doc.addPage({ size: [PDF_PAGE_WIDTH, PDF_PAGE_HEIGHT], margin: 0 });
    doc.image(jpg, 0, 0, { width: PDF_PAGE_WIDTH, height: PDF_PAGE_HEIGHT });
  }

  doc.end();
  await new Promise((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
}

