import assert from "node:assert/strict";
import test from "node:test";
import { resolveExternalPanelArt } from "../src/lib/panels.js";
import { generateStoryboard } from "../src/lib/storyboard-llm.js";

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("resolveExternalPanelArt decodes a valid base64 PNG via image_data", async () => {
  const { buffer, mime } = await resolveExternalPanelArt({ image_data: PNG_SIG.toString("base64") });
  assert.equal(mime, "image/png");
  assert.ok(buffer.equals(PNG_SIG));
});

test("resolveExternalPanelArt rejects non-image bytes", async () => {
  await assert.rejects(
    () => resolveExternalPanelArt({ image_data: Buffer.from("not an image").toString("base64") }),
    /unrecognized or disallowed/,
  );
});

test("resolveExternalPanelArt rejects a non-http(s) image_url", async () => {
  await assert.rejects(() => resolveExternalPanelArt({ image_url: "file:///etc/passwd" }), /http\(s\)/);
});

test("Mode B: artDirection clause is appended exactly once to a caller-supplied image_prompt", async () => {
  const { storyboard } = await generateStoryboard({
    format: "single_page",
    artDirection: { medium: "gouache" },
    storyboard: {
      title: "T",
      characters: [{ name: "A", visual_description: "a person" }],
      pages: [{ page_title: "P1", panels: [{ beat: "b", image_prompt: "my custom prompt" }] }],
    },
  });
  const prompt = storyboard.pages[0].panels[0].image_prompt;
  const occurrences = prompt.split("Medium: gouache.").length - 1;
  assert.equal(occurrences, 1);
  assert.ok(prompt.startsWith("my custom prompt"));
});
