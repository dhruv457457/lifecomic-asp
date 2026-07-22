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
// dialogue; `pixel`/`horror` = title lettering for genre-specific themes (see themeDisplayFont below).
// Fall back to a serif that exists everywhere (DejaVu on Linux, Georgia on Windows) so the service
// still renders cleanly before the comic fonts are bundled.
export const FONTS = {
  display: pick("Bangers", "Georgia"),
  comic: pick("Comic Neue", "Georgia"),
  pixel: pick("Press Start 2P", pick("Bangers", "Georgia")),
  horror: pick("UnifrakturMaguntia", pick("Bangers", "Georgia")),
};

// Picks the title/header font based on the comic's own style/tone/medium text, so genre-specific
// comics don't all get the same swooshy Bangers lettering as a default slice-of-life manga one. Body
// text (captions, dialogue) intentionally always stays on FONTS.comic — neither pixel nor blackletter
// lettering is readable at small sizes. Order matters: pixel is checked first since a retro-horror
// game comic should read as "retro game", not "horror".
const PIXEL_THEME = /\b(pixel|8-?bit|16-?bit|voxel|minecraft|retro game|arcade|nes|game ?boy|blocky)\b/i;
const HORROR_THEME = /\b(horror|curse|cursed|haunt(ed|ing)?|gothic|dread|ghost|ghostly|eerie|creepy|monster|nightmare|possess(ed|ion)?|occult)\b/i;
export function themeDisplayFont(storyboard) {
  const text = `${storyboard?.style || ""} ${storyboard?.tone || ""} ${storyboard?.art_direction?.medium || ""}`;
  if (PIXEL_THEME.test(text)) return FONTS.pixel;
  if (HORROR_THEME.test(text)) return FONTS.horror;
  return FONTS.display;
}
