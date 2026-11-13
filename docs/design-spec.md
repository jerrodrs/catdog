# Borderless template v2.4

V2.4 removes all rendered footer lettering (art credit, AI-art label, proxy label, collector number and set/language details). Provenance remains in external metadata. Geometry and typography otherwise match v2.3. Rules/flavour regression checks exclude the intentionally removed footer.

V2.3 increases title height from 120 to 132 px and type height from 100 to 110 px. Title/type baselines now centre the visible capital T, rather than the whole string's bounding box. This gives T equal space above and below even when other letters have descenders or decorative strokes. Subtitle height stays 68 px and follows the title bar's new lower edge. The type bar again grows upwards, preserving every pixel of the approved lower panel.

V2.2 replaces the separate rounded subtitle bubble with a tapered trapezoidal nameplate, following `reference-example-style/sub-title-example.png`. Its top rim extends behind the title bar, which is painted over it to create a continuous attachment; its sides slope inwards toward the bottom. The 68 px visible height and centred original-name lettering retain the extra padding from v2.1. Cards without alternate titles omit this component entirely.

V2.1 increases the title, original-name and type bars by approximately 10% in height for extra vertical padding. Text sizes are unchanged. The title expands around its original centre, the subtitle follows immediately below it, and the type bar expands upwards so all rules/flavour content remains at the approved v2 positions. A regression check compares the entire lower card region pixel-for-pixel against the approved v2 card.

V2 supersedes the flat v1 panels. It follows the user's `reference-example-style/normal-red.png`, `legendary-green.png` and `multi-color-legendary.png`: curved title/type bars, coloured rims, inset keylines, directional bevel highlights/shadows, dark translucent lower panels and a raised legendary crest. These are original deterministic paths, not generated frame images or scans of the references.

## Research and interpretation

Wizards distinguishes borderless treatments from extended art. Its [Modern Horizons 3 collecting guide](https://magic.wizards.com/en/news/feature/collecting-modern-horizons-3) shows both borderless lands and borderless profile commanders. The [Wilds of Eldraine guide](https://magic.wizards.com/en/news/feature/collecting-wilds-of-eldraine) provides another borderless reference. The visual principle adopted here is an image spanning the whole front, with legible information panels over it. Borderless does not mean textless.

The [Ikoria guide](https://magic.wizards.com/en/news/card-preview/collecting-ikoria-2020-04-02) and [Crimson Vow guide](https://magic.wizards.com/en/news/feature/collecting-innistrad-crimson-vow-2021-10-28) establish the Godzilla and Dracula alternate-title precedent. Wizards' [2022 comprehensive-rules explanation](https://magic.wizards.com/en/news/announcements/comprehensive-rules-changes-4-20-22) distinguishes alternate display names from interchangeable card names: the original name in the secondary bar remains the card's reference identity. Our data model preserves that distinction and leaves Oracle self-references unchanged.

Wizards' [M15 frame explanation](https://magic.wizards.com/en/news/making-magic/directors-chair-2013-2014-01-06) identifies Beleren as the new display typeface and describes the frame's information hierarchy. [The typeface designer's account](https://dribbble.com/shots/2060807-Beleren-typeface-for-Magic-The-Gathering) confirms its display purpose. [Proxyshop's font documentation](https://docs.hexproof.io/proxyshop/user-guide/fonts/) identifies its Beleren recreation, Plantin body family, nickname typography and credit fonts. [Mana's documentation](https://mana.andrewgioia.com/) supplies the symbol font and notation mapping.

The dimensions below are our frozen template design, not claimed to be unpublished Wizards production measurements. They reproduce the familiar hierarchy while leaving a large uninterrupted artwork area. The frame is original code; this is not a scan of an official frame.

## Geometry

Coordinates refer to a 1500 × 2100 canvas, origin at upper left. Physical trim is 2.5 × 3.5 inches. Production masters are 3000 × 4200 at 1200 PPI; the approved 1500 × 2100 layout coordinate system remains fixed. A scaled drawing surface rasterizes fonts directly at twice their logical size and uses native 3000 × 4200 frame paths, preserving positions and physical type sizes. The 600 PPI render option remains available for regression proofs. The complete art layer extends to all four canvas edges. Corners remain square in the master for the printer to cut.

| Region | Bounds / anchor in pixels | Behaviour |
| --- | --- | --- |
| Header | (58, 54)–(1442, 186) | Always present; 132 px tall |
| Display-title area | x=94, y=54–186 | Capital T centred at y=120; fitted 80→56 px |
| Mana symbols | centre y=120, diameter=68, pitch=76 | Right boundary anchored at x=1406 |
| Secondary name tab | top corners (96,178)/(1404,178), bottom corners (138,254)/(1362,254) | Top 8 px tuck behind header; visible height 68 px; only for alternate titles |
| Original-name area | x=152–1348, y=186–254 | Visible ink centred at (750, 220); semibold italic, 45→34 px; width respects taper |
| Standard type bar | (58, 1260)–(1442, 1370) | Same vertical location across standard cards; 110 px tall |
| Dense type bar | (58, 1080)–(1442, 1190) | Explicit exception for text-heavy cards |
| Type area | x=94–1322, y=profile-boundary−20 to profile-boundary+90 | Capital T centred at profile-boundary+35; fits before expansion mark |
| Rules left / right | 106 / 1394 | Width=1288 |
| Rules top | profile-boundary+118 | Unchanged: 1398 standard / 1218 dense |
| Text bottom, creatures | 1900 | Reserves statistics clearance |
| Text bottom, other cards | 1940 | Reserves panel padding |
| Lower panel bottom | 1974, rising to 1934 at centre | Dark translucent panel with coloured rim and centre arch |
| Statistics box | (1176, 1916)–(1442, 2018) | Only for power/toughness |
| Collector / artist lines | (76, 2019) / (76, 2060) | Footer with contrast shadow |
| Diagnostic safe area | (60, 60)–(1440, 2040) | Guides only; not a bleed specification |

## Layer order

1. Saved full-card art, oriented by EXIF, cropped with a recorded focal point.
2. Footer contrast gradient.
3. Header and optional legendary crest / secondary-name panel.
4. Type and rules panels, mostly opaque with subtle art transmission.
5. Measured names, costs, type, rules, reminder and flavour text.
6. Statistics panel and values.
7. No footer lettering; keep provenance outside the image.
8. Optional diagnostic guides.

The body panel alpha is 198/255 (~78% opacity), with warm-white lettering. It allows the art to show through a dark contrast layer, as in the supplied references. The panel is inset inside the colour rim; it does not require the art model to leave empty boxes. Header faces have restrained vertical colour gradients, while rim highlights come from an upper-left light source. Shapes are rendered at 2× resolution and reduced with Lanczos filtering.

## Typesetting

Display titles must fit on a single line at the existing 80→56 px sizes, within the title box and clear of mana symbols. If an alternate title is too long, choose a shorter display_name. Title fit takes priority over naming style prompts, including requested long epithets; never wrap, truncate, distort lettering, or shrink below the floor. Preserve the original Magic name and gameplay data.

Rules are left aligned. Explicit newlines remain; wrapping occurs at whitespace, never inside a mana symbol or between adjacent punctuation and its symbol. Every text run uses a common baseline. Parenthetical reminder text becomes italic, and explicit `italic_phrases` can style ability words such as `Landfall` without editing Oracle wording. Flavour text uses a separate italic block after the rules; attribution may be on a new line. A 38 px gap and hairline separate the blocks.

The 64→56 px body-size ladder corresponds to 7.68→6.72 pt at 600 DPI. It is a project readability floor, not a universal official Magic font size. Line advance is ceil(font-size × 1.13). The compositor checks the combined rules/flavour height against the reserved text rectangle. It does not delete flavour or select a dense layout without a manifest edit.

Title, type and statistic text use **Beleren2016 Bold** from the user-specified [Saeris repository](https://github.com/Saeris/typeface-beleren-bold), whose README states the fonts were extracted from Wizards' website. The secondary title uses Plantin semibold italic. Plantin regular/italic keep rules and flavour visually distinct from headings. Costs use the Mana font rather than literal W/U/B/R/G letters; hybrid costs use split colour discs and component glyphs. Monocolour costs, colourless, generic, snow, Phyrexian and tap/untap symbols are typeset from the same mapping. The asset list records the exact font files.

Label placement uses raster glyph bounds from `getmask2`, rather than Pillow's ascender-based `m` anchor. Title/type labels use the capital T's vertical bounds as their reference; x placement still respects the actual string's bearings. This avoids descenders and Beleren's decorative below-baseline strokes moving capitals upwards. Alias/stat labels retain whole-string visible-ink centring. Inline symbols have diameter round(body-size × 0.82); their disc centres align with the midpoint of the rules font's visible capital H at the shared text baseline. Each symbol glyph is itself centred by visible bounds inside its disc. Header mana discs centre at y=120. Capital-reference bounds are recorded in each build report and checked with actual raster T padding within one pixel.

## Frame families and reuse

`cardforge/frames.py` defines one set of shared paths and bevel operations. `assets/frame-palettes.json` supplies the colours. The 34 exported base variants cover five monocolours, colourless, ten canonical colour pairs and a gold multicolour family, each normal or legendary. Dual-colour rails blend left-to-right between the two colours; headers use gold. Three-or-more-colour cards use the gold family. Colour selection is based on card colours, not Commander identity, and does not depend on array order.

The renderer caches the frame by family, profile and optional components, then composites it beneath locally typeset text. `python3 -m cardforge frames` exports transparent base PNGs and their index under `assets/templates/borderless-v2`, and a labelled visual matrix under `output/frame-templates-v2`. Production hides absent alias/stat panels instead of leaving empty badges. Dense geometry reuses the same paths with a raised type/rules boundary.

## Release checks

Automated checks cover repeatability, text retention, overflow rejection, missing statistics, invalid symbols, special-layout rejection, artwork resolution and artwork composition. Human review compares a sample with reference cards at actual size, checks the original name and Oracle snapshot, confirms flavour separation and inspects the focal point under overlays. A successful render is labelled composed, not automatically human-approved.

## Planeswalkers and paired faces

Planeswalkers use a dedicated type/rules boundary at y=950 (explicit dense: 780), rules top boundary+118 and bottom 1870. Loyalty abilities retain their Oracle prefixes in the manifest; the compositor draws separate cost shields at x=75–211, wraps their text from x=240, and adds measured dividers. Static abilities retain full width. Starting loyalty uses a dedicated shield at (1220,1906)–(1442,2040). All body fonts retain the 64→56px ladder; overflow fails. Shared title/type fonts and ordinary card geometry remain unchanged.

Transform/modal_dfc cards contain exactly two independent complete face objects, with their own names, costs, types, Oracle text, statistics, art and optional cosmetics. Both are preflighted and rendered, with distinct front/back indicators and a colour indicator on coloured back faces. Ajani’s current snapshot is retained in `data/ajani-nacatl-pariah.scryfall.json`; its planeswalker back informed the loyalty-row test. Proofs remain labelled artwork placeholders.

## Template sets

`cardforge/template_sets.py` validates declarative frame definitions generated by Codex. Required structures are creature, artifact, enchantment, instant, sorcery, land, planeswalker, token, transform_front, transform_back, adventure and prepare. W/U/B/R/G/C/M palettes, derived two-colour rims, legendary crests, shape, rails, panel opacity/text colour and bounded vector ornaments are supported. Fonts and text anchors stay fixed. Every required layout is rendered before readiness; missing palettes/templates, weak contrast or ornaments crossing protected text regions are rejected. The included Bloomburrow inspired frame bypasses custom drawing and preserves its approved geometry. Generated sets with thick or double rails get measured clearance instead of fixed anchors: bars grow and lettering moves inward until every element keeps 8 px from the rails' inner edge (see `docs/frame-schema.md`, Readability rules).


## Optional Frame Studio geometry

The included family keeps the frozen geometry above. Declarative custom sets can opt into measured title, type and alias padding, rules panels that fit their content, and bordered inset illustration windows. `cardforge/geometry.py` derives these bounds from the same real-font ink measurements; it preserves minimum mana-disc clearance and the text readability floor. A full-height rules panel retains its blank area. A fitted panel moves its type line down without discarding rules or flavour. Bordered artwork is cropped into the inset window; borderless artwork covers the canvas.

Frame material is separate from card colour. Global metallic/engraved rail colours retain copper, gold or silver across the complete palette; inner coloured accents distinguish card colours. Frame proofs cover 17 colour families × normal/legendary plus twelve supported structures. These are original vector compositions, with real printed cards used only as reference photos.

Visual editing adds optional `title_offset_y` (−10…100 px) and `rules_offset_y` (−150…600 px). Header text, cost symbols, face indicators and legendary crowns move together; the original-name tab stays attached. The type/rules boundary moves with its text, including planeswalker rows. A downward move is limited by measured text height and the fixed bottom boundary. The title must retain at least 18 px of outer clearance. Normal cards without these options retain their approved pixels.

Power/toughness bounds default to `(1176,1916)–(1442,2018)`. Optional `stats_x`, `stats_y`, `stats_width` and `stats_height` adjust the frame and lettering together. Width is 180–480 px, height 80–160 px; the box stays between x=40…1460 and y=1906…2070. The default 78 px Beleren statistics size and 48 px fitting floor remain; ink-bound centring follows the edited bounds. Spells and lands do not gain a statistics box. Planeswalker loyalty shields retain their dedicated geometry.


## Adventure and preparation layouts

Adventure and prepare cards have one physical face. The manifest root carries the permanent's exact characteristics, statistics and artwork; `spell` carries the secondary name, cost, type, Oracle text and optional cosmetics. The shared root title, mana, alias, type and statistics anchors keep the normal fonts. Dedicated lower columns begin below a type boundary of 900 px (explicit dense: 740 px), with all body text retaining the 64→56 px ladder. Adventure spells occupy the left inset; prepare spells occupy the right. The inset box and the permanent's text column split the rules text area evenly with a 44 px gutter. The box is measured from the frame's own panel (`cardforge/subsets.py columns()`): its outer side, its top (below the type bar) and its bottom keep the same margin as the gap between the panel rail and the rules text. The bottom follows the panel's real lower edge across the box's width (flat, arched, notched or rounded corners), so the box extends to the foot of the panel rather than stopping at a fixed line. On the power/toughness side, a box stops one margin above the stats box. Name, mana and spell type are measured separately, with bounded two-line fallback for long secondary names. Both sets of rules and optional flavour are independently fitted; overflow fails rather than truncating. Prepared layout follows [Wizards' Secrets of Strixhaven mechanics](https://magic.wizards.com/en/news/feature/secrets-of-strixhaven-mechanics); the distinct Adventure characteristics follow [Wizards' Wilds of Eldraine mechanics](https://magic.wizards.com/en/news/feature/wilds-of-eldraine-mechanics).

Schema version 2 introduced the twelve structures predating Saga support; new sets now use schema version 3 as described below. Schema version 1 remains usable: Adventure and prepare inherit its creature styling while using the dedicated inset geometry. Saved version data remains unchanged; the new structures can be previewed on demand.


## Bounded, content-fitted rules panels

The current default fits the rules/flavour panel to measured content, moving its type bar downward for short text. The entire section, including the type bar, is capped at 840px (40% of the 2100px card). All supported layouts, including planeswalker loyalty rows and Adventure/prepare insets, measure text against this cap before composition. The body-size ladder is now 64→36px (7.68→4.32pt at 600 DPI); 36px is the hard readability floor. All Oracle text and requested flavour are retained; overflow at the floor fails explicitly. Full-height and visual-position controls remain available inside the same cap. Custom type padding participates in the height calculation. This supersedes the earlier fixed type/rules positions and 56px floor above.

New card-job frame snapshots default to fitted panels even when an older generated frame declared full height. An explicit Full height selection in the set controls is retained. Existing queued jobs without an explicit sizing policy also fit by default in trusted composition. Original frame files and existing rendered card versions are not modified. Reports record rules_panel bounds and text size/capacity.


Planeswalker compaction now prefers 56px body text and measures down to 36px in 2px steps. The loyalty-cost shields, minimum row heights, row gaps and flavour divider spacing scale with the selected body font. Starting loyalty and the main type/header typography keep their dedicated sizes. Ajani, Nacatl Avenger's complete rules plus the saved back-face flavour fit at 46px inside the existing 40% cap; neither the rules nor flavour is removed.


## Saga chapter layout

Saga enchantments and Saga creatures use a dedicated lower chapter track, including when either face of a transforming card is a Saga. Each Roman numeral has a measured hexagonal shield linked by a vertical track. Grouped labels share one rules block; reminders/read ahead and static abilities keep full width, and bullet choices stay attached to their chapter. Exact Oracle text stays in the manifest. Plantin, real-font chapter numerals and capital-aligned mana symbols remain deterministic. Body text fits 64→36px; grouped marker heights, line wraps and optional flavour participate in measurement under the existing 840px cap. Creature Sagas retain power/toughness clearance.

New frame sets use schema_version 3 and require a saga layout in addition to the previous twelve structures. Schema 1/2 versions retain their original requirements; missing Saga styles inherit their enchantment material/palette while still using the dedicated chapter layout. Transform face indicators and independent front/back illustrations remain intact. Urabrask's current Scryfall snapshot is saved in data/urabrask.scryfall.json; layout proofs are visibly marked placeholders.

## Class level layout

Class enchantments (Scryfall layout `class`) use a dedicated level track in `cardforge/class_layout.py`. The reminder and Level 1 abilities keep full width at the top. Each `{cost}: Level N` header becomes a level band across the panel: a faint rim-tinted bar between two highlight rails, the real mana symbols and colon on the left, and a `LEVEL N` cartouche (panel fill, rim outline, Beleren) on the right; the level's ability follows below. Exact Oracle text stays in the manifest, and levels must run in order from Level 2, each with its ability. Body text fits 64→36px with bands, wraps and optional flavour measured under the existing 840px cap. Class is not a required frame-set layout: it inherits each set's enchantment material/palette, and Magic Set Editor sets fall back to the native renderer for it. Battles remain unsupported.

## Optional outer-edge delivery finish

Studio’s `cardforge/borders.py` pass is separate from the approved frame geometry and typography. Saved 1500 × 2100 composition masters, anchor measurements, font metrics and text remain immutable. The finish is applied consistently at delivery for previews/downloads/print, using a cached PNG and source-hash report. Deck and per-card settings select zero, a solid perimeter, or a modern lower flare. These are original project presets inspired by real printed references; the modern flare is not a wholesale recreation of the M15 inner frame. Supersampled masks protect power/toughness and loyalty badges. Print masters stay rectangular for physical trimming. See `docs/card-borders-research.md` and `tests/test_borders.py`.
