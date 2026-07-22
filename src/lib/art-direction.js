// A caller-supplied "design chart" that pins one visual identity for a whole comic/book: medium,
// palette, line weight, lighting, plus optional reference images. Threaded into every panel prompt so
// character and style hold from the first panel to the last, instead of drifting on loose free-text.

const TEXT_FIELDS = ["medium", "palette", "lineWeight", "lighting"];

const REF_MAX = 3;

export function normalizeArtDirection(input) {
  if (!input || typeof input !== "object") return null;
  const out = {};
  for (const key of TEXT_FIELDS) {
    const v = input[key];
    if (typeof v === "string" && v.trim()) out[key] = v.trim().slice(0, 200);
  }
  if (typeof input.style === "string" && input.style.trim()) out.style = input.style.trim().slice(0, 120);
  if (typeof input.tone === "string" && input.tone.trim()) out.tone = input.tone.trim().slice(0, 120);
  const refs = Array.isArray(input.referenceImages) ? input.referenceImages : [];
  const referenceImages = refs
    .filter((u) => typeof u === "string" && /^(https?:|data:image\/)/.test(u.trim()))
    .map((u) => u.trim())
    .slice(0, REF_MAX);
  if (referenceImages.length) out.referenceImages = referenceImages;
  return Object.keys(out).length ? out : null;
}

// The design-chart clause appended to a panel/reference prompt. `style` and `tone` are deliberately
// excluded — they override request.style/request.tone at resolution time, so folding them in here too
// would double them in the prompt text.
export function artDirectionClause(artDirection) {
  if (!artDirection) return "";
  const parts = [];
  if (artDirection.medium) parts.push(`Medium: ${artDirection.medium}.`);
  if (artDirection.palette) parts.push(`Palette: ${artDirection.palette}.`);
  if (artDirection.lineWeight) parts.push(`Line weight: ${artDirection.lineWeight}.`);
  if (artDirection.lighting) parts.push(`Lighting: ${artDirection.lighting}.`);
  return parts.length ? ` ${parts.join(" ")}` : "";
}
