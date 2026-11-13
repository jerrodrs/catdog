# Custom Commander card workflow

This project builds custom borderless Magic cards for multiple independently themed decks. Use the local `cardforge` renderer for every final card; image generation is for the underlying artwork only.

- The local deck builder starts with `npm start`; see `docs/card-studio.md`. In a Studio generation job, its `request.json` and saved `style.txt` are authoritative for the selected deck/card. They override root style defaults. Save all new artifacts under that job's `output_directory`, create a one-card manifest there, and never overwrite earlier versions or edit application code as part of a card job.
- When the user gives a Magic card name or asks to create/regenerate a card, read and apply `skills/create-commander-card/SKILL.md`. A bare card name is enough to begin the complete workflow.
- Do not draw footer text: no AI-art labels, CUSTOM PROXY labels, collector numbers, set/language codes or art credits. Preserve provenance in manifests/reports outside the image.

- Read `card-style.txt` for the user's authoritative art, naming and flavour-text requirements before creating any card.

- Read `docs/production-workflow.md` before producing art or final cards, and `docs/design-spec.md` before changing geometry or typography.
- Preserve original Magic names, current saved Oracle text, costs, types and stats. Put alternate names in `display_name` and custom flavour only in `flavor_text`. Retain a card-data snapshot and provenance.
- Use the bundled Beleren2016 Bold from the user-specified Saeris repository for titles, types and stats, and Plantin for rules/aliases. No silent font substitution or AI-painted lettering/symbols. Older Beleren Proxy assets are retained only for historical provenance.
- Reuse the v2 frame library in `cardforge/frames.py` and `assets/frame-palettes.json`: colour rims, bevels, dark translucent panels, and legendary crests. `python3 -m cardforge frames` exports the 34 template variants and proof matrix.
- Centre title/type labels by the visible capital T's top and baseline, so capitals have equal padding above and below regardless of descenders in the full string. Centre aliases/stats by their visible ink bounds. Align inline symbol discs to the rules text's capital height. Do not restore font-metric midpoint anchors.
- Preserve the v2.3 taller title/type bars and attached, angled original-name tab. The rules and flavour panel is approved as-is; header edits must not shift or restyle it.
- Save chosen art and prompts. Keep art generation separate from deterministic composition. Read the image generation skill when generating/editing artwork.
- Display titles must fit on one line. Choose a shorter alternate name when needed, overriding naming style prompts and omitting epithets as necessary; preserve the exact original Magic name. Never wrap titles or reduce the fixed font floor.
- Keep anchors, panel geometry and symbol sizing fixed across the deck. Use explicit `dense` exceptions for long text. Never truncate rules or shrink below the readability floor.
- Use dedicated templates for special card structures; the normal-face renderer intentionally rejects them.
- Frame sets with `"renderer": "mse"` are drawn by Magic Set Editor from the Full Magic Pack (`docs/mse-templates.md`) with the pack's own fonts, installed per Windows user. Never edit `vendor/Full-Magic-Pack`; the footer is disabled only in the Windows cache copy. Templates whose fonts are missing are refused, not substituted.
- Run `python3 -m cardforge check MANIFEST` and renderer tests after relevant changes. Inspect actual-size outputs and the contact sheet before presenting cards as finished.
- Export composed PNGs, transparent frame PNGs and build reports. Layout proofs must remain visibly identified as placeholders.
