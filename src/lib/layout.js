// Page geometry (shared by the layout assigner and the renderer).
export const PAGE = {
  width: 1600,
  height: 2200,
  margin: 80,
  titleHeight: 128,
  footerHeight: 64,
  gutter: 22,
};

export function panelArea() {
  const x = PAGE.margin;
  const y = PAGE.margin + PAGE.titleHeight;
  const w = PAGE.width - PAGE.margin * 2;
  const h = PAGE.height - y - PAGE.margin - PAGE.footerHeight;
  return { x, y, w, h };
}

// Dynamic 4-panel manga/comic page templates. Each slot is a fraction {xf,yf,wf,hf} of the panel
// area; templates rotate per page so a book has visual variety instead of a dead 2x2 grid. Every
// template tiles the area cleanly (fractions sum to 1 across rows/cols) — gutters are inset later.
const LAYOUTS_4 = [
  // 1 — banner / two / banner
  [
    { xf: 0, yf: 0, wf: 1, hf: 0.3 },
    { xf: 0, yf: 0.3, wf: 0.5, hf: 0.42 },
    { xf: 0.5, yf: 0.3, wf: 0.5, hf: 0.42 },
    { xf: 0, yf: 0.72, wf: 1, hf: 0.28 },
  ],
  // 2 — tall left splash + three stacked right
  [
    { xf: 0, yf: 0, wf: 0.58, hf: 1 },
    { xf: 0.58, yf: 0, wf: 0.42, hf: 0.34 },
    { xf: 0.58, yf: 0.34, wf: 0.42, hf: 0.33 },
    { xf: 0.58, yf: 0.67, wf: 0.42, hf: 0.33 },
  ],
  // 3 — two top + wide mid + wide bottom
  [
    { xf: 0, yf: 0, wf: 0.52, hf: 0.44 },
    { xf: 0.52, yf: 0, wf: 0.48, hf: 0.44 },
    { xf: 0, yf: 0.44, wf: 1, hf: 0.28 },
    { xf: 0, yf: 0.72, wf: 1, hf: 0.28 },
  ],
  // 4 — offset quad (staggered widths for a dynamic feel)
  [
    { xf: 0, yf: 0, wf: 0.56, hf: 0.5 },
    { xf: 0.56, yf: 0, wf: 0.44, hf: 0.5 },
    { xf: 0, yf: 0.5, wf: 0.44, hf: 0.5 },
    { xf: 0.44, yf: 0.5, wf: 0.56, hf: 0.5 },
  ],
];

const SUPPORTED_ASPECTS = [
  ["9:16", 9 / 16],
  ["2:3", 2 / 3],
  ["3:4", 3 / 4],
  ["4:5", 4 / 5],
  ["1:1", 1],
  ["5:4", 5 / 4],
  ["4:3", 4 / 3],
  ["3:2", 3 / 2],
  ["16:9", 16 / 9],
];

/** Nearest model-supported aspect ratio for a given width/height, so generated art fits the panel. */
export function nearestAspect(ratio) {
  let best = SUPPORTED_ASPECTS[0];
  let bestDiff = Infinity;
  for (const entry of SUPPORTED_ASPECTS) {
    const diff = Math.abs(Math.log(ratio) - Math.log(entry[1]));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = entry;
    }
  }
  return best[0];
}

/**
 * Assigns a varied page layout to every page and attaches each panel's pixel rect (`panel.layout`)
 * and the model aspect ratio (`panel.aspect_ratio`) to generate art at. Mutates and returns the
 * storyboard. Must run BEFORE image generation so each panel's art is shaped to its slot.
 */
export function assignLayout(storyboard) {
  const area = panelArea();
  const g = PAGE.gutter / 2;
  storyboard.pages.forEach((page, pageIndex) => {
    const template = LAYOUTS_4[pageIndex % LAYOUTS_4.length];
    page.layout_template = pageIndex % LAYOUTS_4.length;
    page.panels.forEach((panel, i) => {
      const slot = template[i] || template[template.length - 1];
      const rect = {
        x: Math.round(area.x + slot.xf * area.w + g),
        y: Math.round(area.y + slot.yf * area.h + g),
        w: Math.round(slot.wf * area.w - PAGE.gutter),
        h: Math.round(slot.hf * area.h - PAGE.gutter),
      };
      panel.layout = rect;
      panel.aspect_ratio = nearestAspect(rect.w / rect.h);
    });
  });
  return storyboard;
}
