import { GlobalFonts } from "@napi-rs/canvas";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Register any fonts bundled in assets/fonts so pages render identically on every OS (local Windows
// and the Linux container both use the same files, instead of falling back to whatever the OS has).
// Drop .ttf/.otf files in that folder; they're picked up automatically under their real family name.
const FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "fonts");

function registerBundledFonts() {
  try {
    for (const file of fs.readdirSync(FONT_DIR)) {
      if (/\.(ttf|otf)$/i.test(file)) GlobalFonts.registerFromPath(path.join(FONT_DIR, file));
    }
  } catch {
    // No bundled fonts yet — the fallbacks below keep rendering working.
  }
}
registerBundledFonts();

const available = new Set((GlobalFonts.families || []).map((f) => f.family));
const pick = (preferred, fallback) => (available.has(preferred) ? preferred : fallback);

// Roles used by the renderer. `display` = big comic title lettering; `comic` = in-panel captions and
// dialogue. Fall back to a serif that exists everywhere (DejaVu on Linux, Georgia on Windows) so the
// service still renders cleanly before the comic fonts are bundled.
export const FONTS = {
  display: pick("Bangers", "Georgia"),
  comic: pick("Comic Neue", "Georgia"),
};
