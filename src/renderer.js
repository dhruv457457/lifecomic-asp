import fs from "fs-extra";
import path from "node:path";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const PAGE = {
  width: 1600,
  height: 2200,
  margin: 90,
  titleHeight: 130,
  gap: 34,
  footerHeight: 70
};

export async function renderComic(storyboard, outputDir) {
  const pagesDir = path.join(outputDir, "pages");
  await fs.ensureDir(pagesDir);

  const pageFiles = [];
  for (const page of storyboard.pages) {
    const pagePath = path.join(pagesDir, `page_${String(page.page).padStart(3, "0")}.png`);
    await renderPage(storyboard, page, pagePath);
    pageFiles.push(pagePath);
  }

  const pdfPath = path.join(outputDir, "comic.pdf");
  await renderPdf(storyboard, pageFiles, pdfPath);

  return {
    pdf: pdfPath,
    pages: pageFiles,
    storyboard: path.join(outputDir, "storyboard.json")
  };
}

async function renderPage(storyboard, page, outPath) {
  const canvas = createCanvas(PAGE.width, PAGE.height);
  const ctx = canvas.getContext("2d");

  drawBackground(ctx);
  drawHeader(ctx, storyboard.title, page.page_title);

  const panelAreaTop = PAGE.margin + PAGE.titleHeight;
  const panelAreaHeight = PAGE.height - panelAreaTop - PAGE.margin - PAGE.footerHeight;
  const panelWidth = (PAGE.width - PAGE.margin * 2 - PAGE.gap) / 2;
  const panelHeight = (panelAreaHeight - PAGE.gap) / 2;

  for (let index = 0; index < page.panels.length; index += 1) {
    const panel = page.panels[index];
    const col = index % 2;
    const row = Math.floor(index / 2);
    const x = PAGE.margin + col * (panelWidth + PAGE.gap);
    const y = panelAreaTop + row * (panelHeight + PAGE.gap);
    let image = null;
    if (panel.image_path) {
      image = await loadImage(panel.image_path).catch(() => null);
    }
    drawPanel(ctx, panel, image, x, y, panelWidth, panelHeight, index);
  }

  drawFooter(ctx, page.page);

  const buffer = canvas.toBuffer("image/png");
  await sharp(buffer).png().toFile(outPath);
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
  ctx.font = "bold 72px Georgia";
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
    ctx.fillStyle = panelColor(index);
    ctx.fillRect(x, y, width, height);
    drawPlaceholderArt(ctx, x, y, width, height, index);
  }

  ctx.strokeStyle = "#17120f";
  ctx.lineWidth = 8;
  ctx.strokeRect(x, y, width, height);

  const caption = (panel.caption || "").trim();
  if (caption) drawCaption(ctx, caption, x + 24, y + 24, width - 48);
  const dialogue = (panel.dialogue?.[0]?.text || "").trim();
  if (dialogue) drawSpeechBubble(ctx, dialogue, x + 52, y + height - 170, width - 104, 110);

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
  ctx.font = "bold 28px Georgia";
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

function drawSpeechBubble(ctx, text, x, y, width, height) {
  ctx.fillStyle = "#ffffff";
  roundRect(ctx, x, y, width, height, 26);
  ctx.fill();
  ctx.strokeStyle = "#1b1714";
  ctx.lineWidth = 5;
  ctx.stroke();

  ctx.fillStyle = "#1b1714";
  ctx.font = "30px Arial";
  wrapText(ctx, text, x + 24, y + 42, width - 48, 36, 2);
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

function wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines = 3) {
  const words = text.split(/\s+/);
  let line = "";
  let lines = 0;

  for (const word of words) {
    const testLine = line ? `${line} ${word}` : word;
    if (ctx.measureText(testLine).width > maxWidth && line) {
      ctx.fillText(line, x, y);
      y += lineHeight;
      lines += 1;
      line = word;
      if (lines >= maxLines - 1) break;
    } else {
      line = testLine;
    }
  }
  if (line && lines < maxLines) ctx.fillText(line, x, y);
}

async function renderPdf(storyboard, pageFiles, pdfPath) {
  const doc = new PDFDocument({ size: [PAGE.width, PAGE.height], margin: 0 });
  const stream = fs.createWriteStream(pdfPath);
  doc.pipe(stream);

  pageFiles.forEach((pageFile, index) => {
    if (index > 0) doc.addPage({ size: [PAGE.width, PAGE.height], margin: 0 });
    doc.image(pageFile, 0, 0, { width: PAGE.width, height: PAGE.height });
  });

  doc.end();
  await new Promise((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
}

