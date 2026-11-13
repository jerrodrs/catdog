---
name: create-commander-card
description: Create a finished custom Magic card from an existing card name, using the selected deck’s art direction, generated artwork and deterministic local renderer. Use for bare card-name requests and requests to create or regenerate these cards.
---

# Create a Commander card

Treat a card name supplied in this project as an instruction to produce the finished card image. Make routine art, alternate-title and flavour decisions without seeking approval. Use the repository root containing `cardforge/` as the working directory.

For Studio jobs, read the provided request.json and its saved style_file; these are authoritative for this deck and override project defaults. Save every new artifact in the request’s output_directory. For direct requests outside Studio, read the latest [card-style.txt](../../card-style.txt); do not reuse a remembered style. A sample deck’s theme is not a global requirement. Follow [production-workflow.md](../../docs/production-workflow.md) for art composition and output preparation. The style file and explicit user requests take precedence over older examples.

## Lock card data

Look up the exact paper card on Scryfall/Gatherer and save a local snapshot under `data/`. Verify original name, mana cost, complete current Oracle text, type line, colours, layout and applicable stats. If those services are unavailable, verify against authoritative published information and a current corroborating listing, and record the actual sources and access limitation. Never present a manually transcribed snapshot as a live API response. Ask only if identity or gameplay details cannot be verified.

`python3 -m cardforge import SNAPSHOT.json --out decks/SLUG.json` imports a local Scryfall response. For other verified sources, create the same manifest shape using [the existing manifest](../../decks/delighted-halfling.json) as a schema example, preserving card data and source information. Do not copy its old art or cosmetic name.

Follow the selected deck’s naming requirements. Keep the original name by default; choose a thematic `display_name` only when the style or user requests alternate titles. Keep the exact Magic name beneath an alternate title and preserve names inside Oracle rules. Write a short original flavour line when appropriate. Creature types remain the researched types regardless of the artwork’s subject.

## Generate art, then compose

Use the available imagegen skill and built-in image tool for artwork. Pass verified card context plus the current style's illustration requirements. Generate a background painting only: no text, card frame, symbols, signatures or watermark. Let art fill every edge; place important faces/action between about 15–55% height, outside the title/subtitle and lower rules panels.

For Studio jobs, the saved `frame_set` configuration is applied by the trusted compositor. Preserve paired faces and their original gameplay. Token jobs use `card.token_spec` as their exact explicit definition; variant entries need genuinely new art, not reused copies. Read `card.scene_plan`, `card.customization` and `deck.art_references` in the request. Inspect relevant existing card images and vary pose, action, viewpoint, distance, subject placement and setting while retaining the deck's medium and world. Save a factual `scene.json` describing the actual artwork, using the schema in the job prompt; run `node studio/check-scene.mjs REQUEST_PATH SCENE_PATH` before generating and again after inspection. Rethink blocked near-matches rather than changing synonymous keywords. Cosmetic controls are applied by the app after composition; return the base manifest before those explicit overrides. Preserve the previous version's scene description when a revision keeps its artwork unchanged.

When request.art_prompt_contract.mode is verbatim-style-v1, assemble every new image prompt with `node studio/art-prompt.mjs REQUEST_JSON SCENE_TEXT OUTPUT_PROMPT_TEXT`. The saved style block stays verbatim; put scene and composition guidance in the separate scene file. Pass the assembled text unchanged to the selected provider's image tool and set each newly illustrated face's `art_prompt` to that file. Do not paraphrase or shorten the style block.

Save the selected source, full prompt and style snapshot/hash under `art/SLUG-vN.*`. Freeze the style when preparing the prompt, since the user may edit `card-style.txt` while images are generating. Create new versions rather than overwriting earlier art/card outputs. If the tool's source is below the renderer's minimum, preserve it and explicitly prepare a Lanczos upscale to at least 1500 × 2100; record native/prepared dimensions. Do not call upscaled detail native resolution.

Set `art` relative to the manifest. Put `art_prompt`, source snapshot and provenance in metadata. Reuse the renderer's existing colour/legendary templates, fonts, taller title/type bars, capital-T centring and connected angled original-name tab. Do not redraw the frame with image generation or change approved geometry for a new card. Use an explicit `dense` profile only when necessary. Planeswalkers now have dedicated loyalty rows and a starting-loyalty shield. Transform/modal double-faced cards use a parent manifest with exactly two complete faces and independent saved artwork; import the verified Scryfall snapshot to get that schema. The CLI renders and checks both faces. Tokens use `layout: token` and a Token type line with no mana cost. Adventure and preparation cards have dedicated same-side inset spell layouts: import Scryfall `adventure` or `prepare`; the root holds the permanent fields and single artwork, with the secondary name/cost/type/rules in `spell`. Adventure insets appear on the left; prepare spell insets appear on the right. Preserve both sets of characteristics without inventing a second physical face. Sagas have a dedicated chapter-track layout. Class enchantments have a dedicated level-band layout: import the Scryfall snapshot (layout `class`) and keep the exact Oracle text with its `{cost}: Level N` lines; never flatten levels into ordinary rules. Preserve the complete Oracle text, including Roman chapter prefixes, grouped labels such as I, II, reminder/static abilities and optional flavour. Single-face Saga cards use layout saga; transforming Saga faces remain inside their two-face container with independent artwork. Urabrask / The Great Work imports directly from its verified snapshot. Class, Battle and split structures still require additional dedicated templates.

**No on-card footer text:** omit AI-art labels, custom-proxy labels, collector numbers, set/language codes and art credits. Keep provenance outside the card in manifests and reports. Maintain the original-name subtitle and gameplay information.

```bash
python3 -m cardforge check decks/SLUG.json
python3 -m cardforge render decks/SLUG.json --out output/SLUG-vN --dpi 1200
```

Readability failures must be resolved without clipping/paraphrasing rules or reducing type below the renderer's floor. Preserve the approved rules/flavour typography, spacing and divider. Rendering is deterministic once saved art, manifest, fonts and renderer are fixed; art generation itself is not.

## Inspect and deliver

View the finished PNG, checking exact rules, cost/symbols, type/stats, title/original-name pair, flavour italics, art crop, correct frame family, capital centring and clean footer. For artifacts, verify the important object itself remains above the rules panel after composition. Run appropriate existing checks if implementation changed. Deliver the composed card (not just the background), with a clickable local PNG path and a brief source note outside the image. Link the saved art prompt and identify built-in imagegen as the art tool. Also retain the transparent frame, contact sheet and build report.

## Print resolution

Use the highest native artwork resolution the selected provider supports, without altering the verbatim style contract. Keep source and preparation dimensions distinct. Production card composition defaults to 1200 PPI (3000 × 4200), with fonts/symbols rasterized directly at output resolution; this does not make lower-resolution art natively 1200 PPI. For quality-only refreshes, use the final saved manifest, artwork and frame configuration without new art or gameplay changes, and retain earlier versions and each artwork set’s selections.
