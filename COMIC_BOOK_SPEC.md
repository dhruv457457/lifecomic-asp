# Comic Book Output Spec

LifeComic should produce real comic pages, not one image collage.

## Output Levels

### Level 1: Storyboard

No image generation.

- title
- logline
- character bible
- page plan
- panel list
- captions
- dialogue
- art prompts
- social caption

### Level 2: Page Draft

No paid image generation required.

- placeholder panel boxes
- real title typography
- real captions
- real speech bubbles
- PDF export
- page PNG export

### Level 3: Rendered Comic

Uses image generation.

- one generated image per panel
- panel crop and fit
- page composition
- captions and dialogue added by renderer
- PDF export
- page PNG export
- panel PNG export

## Recommended Formats

### Single Comic Page

- 1 page
- 4 panels
- good for cheap preview
- output: 1 page PNG + PDF

### Mini Comic Book

- cover page
- 4 story pages
- 12 to 16 panels total
- output: 5-page PDF + page PNGs + panel PNGs

### Life Chapter

- cover page
- 8 to 12 story pages
- 24 to 48 panels
- output: PDF book package

## Page Template

Each page should have:

- page title or chapter title
- panel grid
- captions
- speech bubbles
- page number
- consistent margins
- readable typography

Text must be rendered by the page renderer. Do not ask the image model to write dialogue, captions, or labels inside art panels.

## JSON Shape

```json
{
  "comic_id": "comic_deadline_arc",
  "title": "The Deadline Arc",
  "format": "mini_book_4_pages",
  "style": "slice_of_life_manga",
  "characters": [
    {
      "id": "char_dhruv",
      "name": "Dhruv",
      "visual_description": "young builder, black messy hair, hoodie, tired but expressive",
      "continuity_notes": "same hoodie, same workspace, warm desk lighting"
    }
  ],
  "pages": [
    {
      "page": 1,
      "page_title": "Too Many Tabs",
      "layout": "four_panel_grid",
      "panels": [
        {
          "panel": 1,
          "beat": "Dhruv wakes up late.",
          "caption": "The day opened with betrayal.",
          "dialogue": [
            {
              "speaker": "Dhruv",
              "text": "Not today."
            }
          ],
          "image_prompt": "A slice-of-life manga panel of a tired young builder waking up late in a messy room..."
        }
      ]
    }
  ]
}
```

## Renderer Responsibilities

- choose page size
- place panel images
- draw panel borders
- add caption boxes
- add speech bubbles
- add page numbers
- export PDF
- export page PNGs

## Image Provider Responsibilities

- generate clean art panels only
- avoid text inside images
- keep character style consistent
- return image file paths or URLs

## MVP Acceptance Criteria

- Creates at least a 4-page PDF.
- Has real text and readable typography.
- Uses separate panel slots.
- Can run without image API in placeholder mode.
- Can later swap in an image API without changing the API response shape.

