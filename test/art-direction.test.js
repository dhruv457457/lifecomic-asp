import assert from "node:assert/strict";
import test from "node:test";
import { normalizeArtDirection, artDirectionClause } from "../src/lib/art-direction.js";
import { buildStoryboard } from "../src/storyboard.js";

test("normalizeArtDirection returns null on empty / non-object input", () => {
  assert.equal(normalizeArtDirection(null), null);
  assert.equal(normalizeArtDirection("nope"), null);
  assert.equal(normalizeArtDirection({}), null);
  assert.equal(normalizeArtDirection({ medium: "   " }), null);
});

test("normalizeArtDirection keeps known fields, caps length, filters refs", () => {
  const ad = normalizeArtDirection({
    style: "ghibli",
    tone: "wistful",
    medium: "watercolor",
    palette: "soft pastels",
    lineWeight: "x".repeat(500),
    lighting: "golden hour",
    referenceImages: [
      "https://example.com/a.png",
      "data:image/png;base64,AAAA",
      "ftp://bad/nope.png",
      "https://example.com/b.png",
      "https://example.com/c.png",
      "https://example.com/d.png",
    ],
    junk: "ignored",
  });
  assert.equal(ad.style, "ghibli");
  assert.equal(ad.medium, "watercolor");
  assert.equal(ad.lineWeight.length, 200);
  assert.equal(ad.junk, undefined);
  assert.equal(ad.referenceImages.length, 3);
  assert.ok(!ad.referenceImages.some((u) => u.startsWith("ftp")));
});

test("artDirectionClause excludes style/tone, includes design-chart fields", () => {
  const clause = artDirectionClause(normalizeArtDirection({ style: "manga", medium: "ink", palette: "neon" }));
  assert.ok(clause.includes("Medium: ink."));
  assert.ok(clause.includes("Palette: neon."));
  assert.ok(!clause.toLowerCase().includes("manga"));
  assert.equal(artDirectionClause(null), "");
});

test("buildStoryboard threads artDirection into every panel prompt (no dead style_rules/continuity)", () => {
  const sb = buildStoryboard({
    story: "test",
    artDirection: { style: "noir", medium: "ink wash", palette: "monochrome" },
  });
  assert.equal(sb.style, "noir");
  assert.ok(sb.art_direction);
  for (const page of sb.pages) {
    for (const panel of page.panels) {
      assert.ok(panel.image_prompt.includes("Medium: ink wash."));
      assert.ok(panel.image_prompt.includes("Palette: monochrome."));
      assert.ok(panel.image_prompt.includes("consistent character appearance"));
    }
  }
});
