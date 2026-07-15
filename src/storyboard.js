import slugify from "slugify";

const defaultCharacter = {
  name: "Main Character",
  description: "expressive everyday person, relatable and cinematic"
};

const pageTitles = ["The Wake-Up", "The Spiral", "The Almost-Quit", "The Spark"];

const beats = [
  [
    ["The day starts late.", "The morning did not ask permission.", "Wait, what time is it?"],
    ["The room is already chaos.", "The evidence was everywhere.", "Why are there notes on the floor?"],
    ["The laptop waits like a trial.", "The screen had opinions.", "Okay. We can still fix this."],
    ["The deadline appears.", "Then the countdown became real.", "Five days is basically tomorrow."]
  ],
  [
    ["Three AI chats argue at once.", "Every answer opened two more questions.", "One at a time, please."],
    ["The builder tries to compare ideas.", "Finance, art, lifestyle, memory, all shouting.", "Is this genius or nonsense?"],
    ["Marketplace agents blur together.", "The options multiplied like browser tabs.", "I need one clear thing."],
    ["The notebook fills with crossed-out plans.", "Even the bad ideas left footprints.", "No, not another scanner."]
  ],
  [
    ["The chair leans back.", "For a minute, quitting sounded peaceful.", "Maybe I sleep and become someone else."],
    ["The wall of notes looks impossible.", "Ambition had terrible handwriting.", "This is too much."],
    ["A tiny sentence survives the mess.", "Then one phrase refused to leave.", "Turn life into comics..."],
    ["The idea starts drawing itself.", "The room got quieter around it.", "Wait. That actually works."]
  ],
  [
    ["A comic page sketch appears.", "The mess became panels.", "Four boxes. One story."],
    ["The character finally smiles.", "The day had not been wasted.", "This is the product."],
    ["The first page gets a title.", "Every chaotic day deserves a frame.", "The Deadline Arc."],
    ["The builder keeps going.", "Some wins arrive as a rough sketch.", "Let's build it."]
  ]
];

export function buildStoryboard(request) {
  const title = request.title || "The Deadline Arc";
  const comicId = `comic_${slugify(title, { lower: true, strict: true })}`;
  const character = request.characters?.[0] || defaultCharacter;

  return {
    comic_id: comicId,
    title,
    format: request.format || "mini_book_4_pages",
    style: request.style || "slice_of_life_manga",
    tone: request.tone || "warm_funny",
    source_story: request.story,
    character_bible: {
      characters: [
        {
          id: "char_main",
          name: character.name || defaultCharacter.name,
          visual_description: character.description || defaultCharacter.description,
          continuity_notes: "Keep the same outfit, face shape, hairstyle, and emotional expressiveness across every panel."
        }
      ],
      style_rules: [
        "Generate artwork without text inside the panels.",
        "Use consistent character appearance across panels.",
        "Keep backgrounds readable and not too busy."
      ]
    },
    pages: pageTitles.map((pageTitle, pageIndex) => ({
      page: pageIndex + 1,
      page_title: pageTitle,
      layout: "four_panel_grid",
      panels: beats[pageIndex].map(([beat, caption, dialogue], panelIndex) => ({
        panel: panelIndex + 1,
        beat,
        caption,
        dialogue: [{ speaker: character.name || defaultCharacter.name, text: dialogue }],
        image_prompt: makeImagePrompt(request, character, beat)
      }))
    })),
    social_caption: "Some days do not make sense until they become a story."
  };
}

function makeImagePrompt(request, character, beat) {
  return [
    `Style: ${request.style || "slice-of-life manga"}, expressive comic art, clean composition.`,
    `Character: ${character.description || defaultCharacter.description}.`,
    `Scene beat: ${beat}`,
    "No text, no captions, no speech bubbles, no watermarks."
  ].join(" ");
}

