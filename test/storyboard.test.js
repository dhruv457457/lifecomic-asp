import assert from "node:assert/strict";
import test from "node:test";
import { buildStoryboard } from "../src/storyboard.js";

test("builds a four-page comic storyboard", () => {
  const storyboard = buildStoryboard({
    story: "A chaotic day becomes a comic idea.",
    characters: [{ name: "Dhruv", description: "builder" }]
  });

  assert.equal(storyboard.pages.length, 4);
  assert.equal(storyboard.pages[0].panels.length, 4);
  assert.equal(storyboard.character_bible.characters[0].name, "Dhruv");
});

