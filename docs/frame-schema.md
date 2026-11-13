# Frame set schema (schema_version 3)

A frame set is declarative JSON rendered by `cardforge`. Lettering, mana symbols, panel geometry and text anchors are always deterministic. Everything below is the vocabulary a designer can use; validation lives in `cardforge/template_sets.py` (`validate_set`, `measured_contrast`) and `cardforge/decorations.py`.

Coordinates are on the logical 1500 × 2100 card. Load configs with `cardforge.decorations.load_set` so asset paths and hashes are verified.

## Top level

| Key | Meaning |
|---|---|
| `schema_version` | `3` |
| `name`, `description` | Set name (≤120 chars) and a short design statement. |
| `style` | Global style keys (below). |
| `layouts` | All 13 keys must exist: creature, artifact, enchantment, instant, sorcery, land, planeswalker, token, transform_front, transform_back, adventure, prepare, saga. Each may override any style key. Saga falls back to enchantment and adventure/prepare to creature when empty. |
| `palettes` | `W U B R G C M`, each `{rim, highlight, shadow, header}` as `#RRGGBB`. Two-colour cards blend rims; three or more use `M`. Header is the title/stats bar fill. |
| `textures` | Up to 8 named panel materials: `{"felt": {"image": "felt.png", "tint": true}}`. Seamless PNG tiles, 64–2048 px per side. `tint: true` recolours the texture toward the panel's fill, so a header texture follows each colour identity; `false` keeps its own colours. |
| `ornaments` | Up to 160 vector linework ornaments (lines, polygons, ellipses). |
| `decorations` | Up to 24 painted transparent PNGs (RGBA with real transparency). |
| `skins` | Up to 12 named painted panel surfaces (below). |
| `rarity_symbol` | The set's own rarity glyph (below). Required for new designs. |

## Style keys (global or per layout)

| Key | Values |
|---|---|
| `shape` | Bar outline for title, type and stats: `classic`, `angular`, `rounded`, `stepped` (art deco), `ticket` (notched voucher ends), `ribbon` (swallowtail), `pill`, `scalloped`, or `custom` (your own `shape_profile`). |
| `shape_profile` | For `custom`: the left bar end as 3–40 `[inset, t]` points from the bar's top (`t` 0) to its bottom (`t` 1); the right end mirrors it. Insets are 0–60 px, at most 40 px beside the lettering (`t` 0.25–0.75). Example bracket end: `[[28,0],[8,0.18],[20,0.5],[8,0.82],[28,1]]`. Lettering clearance is measured from the drawn outline. |
| `panel_bottom` | Rules-box lower edge: `arch` (default centre arch), `flat`, `notch` (shallow inverted V), `step` (raised centre step). The rules text area never moves. |
| `panel_corners`, `panel_corner_size` | Rules-box lower corners: `square` (default), `cut`, `rounded`, `notched` (concave), size 8–40 px. |
| `shape_cut` | 8–60: corner cut, step, notch or scallop size. Ticket notches, ribbon swallowtails and scallops cut in at mid-height (depth capped at 32 px); the title, type line, mana cost and rarity symbol move inward by the same depth so lettering keeps a plain bar's clearance. |
| `border_mode` | `borderless` (edge-to-edge art) or `bordered` (inset art window on a coloured card). |
| `rules_sizing` | `fit` (content-fitted rules panel) or `full`. |
| `legendary_style` | `crest` or `minimal`. |
| `rail_width` | 4–36 px. |
| `rail_finish` | `flat`, `metallic` (vertical sheen), `engraved` (adds a groove), `foil` (diagonal bands; needs `rail_color`). |
| `rail_style` | `single`, `double` (second inner rail), `pinstripe` (fine light inlay). |
| `rail_texture`, `rail_texture_strength` | A `textures` entry painted across the rail band (hammered metal, wood grain, braided leather), strength 0.05–1 (default 0.6). Tinted textures follow `rail_color` or the palette rim. |
| `title_skin`, `alias_skin`, `type_skin`, `rules_skin`, `stats_skin`, `crest_skin` | Name of a `skins` entry painted on that surface. |
| `rail_color`, `rail_highlight`, `rail_shadow` | A material rail shared by all colours (copper, gold, chrome…). Omit `rail_color` to use each palette's rim. |
| `panel_color`, `panel_alpha` | Rules/type panel fill and opacity 160–255. 255 gives a fully opaque printed panel. |
| `text_color` | Default lettering colour. |
| `title_text_color`, `type_text_color`, `rules_text_color` | Per-surface lettering. Title covers the title bar, original-name tab, stats and loyalty. Use dark rules/type text on light panels for a classic printed look. |
| `title_texture`, `type_texture`, `rules_texture`, `stats_texture` | Name of a `textures` entry painted inside that panel. |
| `texture_strength` | 0.05–1 opacity of the texture over the panel fill. |
| `texture_scale` | 0.25–4 tile scale. |
| Padding/position | `title_padding`, `type_padding`, `alias_padding` (8–60); `title_offset_y`, `rules_offset_y`, `stats_x/y/width/height`. Positions are the user's editor measurements only: verification removes any a generated design sets that the user did not choose, because an offset pins the rules box and overrides fitted sizing. |

## Ornaments

```json
{"kind": "polygon", "points": [[620, 40], [880, 40], [850, 56], [650, 56]],
 "fill_tint": "rim", "tint": "highlight", "width": 3, "opacity": 0.9, "layer": "over",
 "layouts": ["creature"], "legendary": false}
```

- `kind`: `line`, `polygon` or `ellipse` (two corners). The renderer also supports `symbol` (one centre point, `size` 8–600, optional `rotation`) for older sets, but new designs may not use it. Themed motifs (wax seals, ribbons, gems, crest carvings) are painted decorations or skins attached to the frame, never vector clip-art and never over the illustration. No lettering, numbers or game-like symbols anywhere on the frame.
- Symbols: spade, heart, diamond, club, star, sparkle, chip, coin, crown, die, moon, leaf, gear.
- Colour: `color`/`fill` as hex, or `tint`/`fill_tint` as a palette role (`rim`, `highlight`, `shadow`, `header`) so motifs follow colour identity. A symbol is filled with `fill` (or the stroke colour). With both a fill and a stroke, it gets an outline `width` px wide.
- `width` 1–24, `opacity` 0.05–1, `layer` `under` (beneath panels) or `over`.
- Optional `layouts` and `legendary` filters.

Ornaments and decorations sit on the frame, as on printed Magic cards: bar ends and edges, panel rails, the stats box, the legendary crest, or the border of bordered cards. They may overhang a frame edge by up to 24 px, and a thin decorative edge may run around the card's outer 72 px (as on printed showcase frames), but nothing floats in the illustration. New designs are rejected when more than 10% of an item's painted pixels are off the frame on any structure where it applies (`art_intrusions`). Ornament positions are absolute while the type bar moves with each card's text, so the title bar, its ends and the stats box are the dependable anchors. At render time items are also masked away from each card's lettering and statistics regions.

## Rarity symbol

```json
"rarity_symbol": {"name": "House chip", "shapes": [
  {"shape": "symbol", "symbol": "chip", "center": [0, 0], "size": 2},
  {"shape": "symbol", "symbol": "spade", "center": [0, 0.02], "size": 0.85, "cut": true}]}
```

A vector glyph on a unit square from -1 to 1, drawn 50 px wide beside the type line. Shapes add in order; `"cut": true` subtracts. Shapes: `polygon` (`points`, 3–64), `circle` (`center`, `r` 0.04–1.2) and `symbol` (any ornament symbol, `size` 0.1–2.4, optional `rotation`). Coordinates stay within -1.2 to 1.2 and the glyph must cover 12–85% of its box. The renderer colours it per rarity with a diagonal sheen and outline (black, silver, gold, orange-red), so do not set colours. It must be original, not a real expansion symbol. Without one, the classic diamond is used.

## Skins (painted panel surfaces)

```json
"skins": {"vellum": {"image": "vellum.png", "slice": [90, 70, 90, 70], "fill": "tile", "tint": false}}
```
A skin is a painted, non-repeating image fitted to one panel's bounds and clipped to its outline, drawn inside the rails (or over them with `covers_rails: true`). With `slice` `[left, top, right, bottom]` (source px) it is nine-sliced: corners keep their painted size, edges run along the sides and the centre fills the rest, so a burned edge, stitched border or carved lip survives any panel height. `fill` `stretch` scales the centre and edges; `tile` repeats them at native size (make them seamless with `frame_tools.py seamless`). Without `slice` the image is scaled to cover the panel. `scale` 0.25–2 resizes the source first; `tint: true` recolours it toward the panel's colour like a tinted texture. Skins are RGB or RGBA PNGs of at least 64 px and at most 36 megapixels. Lettering contrast is measured on the rendered skin, so keep the area under text even and low in contrast. Print quality: a cover-fit skin, or a sliced skin with a stretched centre, may be enlarged at most 1.25x at the largest size its surface reaches (title bar about 2768 x 300 px, rules box about 2688 x 1600 px at print size).

## Decorations (painted PNG components)

`image` (PNG relative to the config), `box` [x0,y0,x1,y1], `fit` `contain`/`stretch`/`tile`, `mirror_x`, `opacity`, `layer` `under`/`over`, `layouts`, `legendary`, plus:

- `tint`: palette role, so one painted asset follows each colour identity.
- `tint_mode`: `colorize` (default; maps shading onto shadow → role → highlight) or `multiply`.
- `tint_strength`: 0–1.

- An image drawn at exactly its box's size, at card units or at print resolution (2 px per unit), is placed exactly as drawn, transparent margins included, so rings and edge bands can line up with the card's rim. Other images are trimmed to their painted pixels and then fitted.
- `fit: "tile"` repeats a seamless segment along the box's long axis at its true proportions, scaled to the box's short side: use it for border and rail trim.

Print quality (enforced for new designs by the design review): cards render at 2 px per card unit, so a decoration's painted pixels must cover its box at that size with at most 1.25× enlargement, and a `stretch` image must already have its box's proportions (within 6%). `texture_scale` may not exceed 1.25. The review also writes `previews/detail-crops.jpg`, actual-size crops of the corners, a bar end, the side border and the stats box, to check that pieces are crisp and meet cleanly.

A full-card overlay is a decoration with box `[0,0,1500,2100]` and needs a 3000 × 4200 source, assembled from tiled segments and corner pieces rather than enlarged. It can paint an entire flavourful frame layer (filigree, carved wood, neon tubing) while the real-font panels stay on top.

## Designer tools

`python3 studio/frame_tools.py` helps build a set: `anchors` prints exact surface boxes and the decoration zone for a structure; `cutout` keys a flat chroma background into clean RGBA; `seamless` makes tiles, trim segments and skin centres repeat without seams; `proof` renders one print-resolution card with real art plus actual-size crops; `check` runs a fast schema, contrast, print-quality and art-clearance pre-flight. `studio/verify_template.py` remains the full gate.

## Recreating printed treatments

A frame set may carry a `reference` (title, set, treatment, notes and up to six local reference card images). Each version copies the images into `references/` and the designer recreates that treatment faithfully, without logos, set symbols or the reference artwork. Similarity to other frame sets is then only a note.

## Magic Set Editor templates

A config with `"renderer": "mse"` and `mse.stylesheet` is drawn by Magic Set Editor from the Full Magic Pack instead of the vocabulary above; see `docs/mse-templates.md`.

## Readability rules (enforced)

- Header colours need 4:1 contrast with title lettering; rules and type panels need 4:1 with their lettering over both black and white art.
- `measured_contrast` samples the rendered panels, including textures and under-layers. Rules text needs 4:1 at the 10th percentile; title and type bars need 3.5:1.
- Rules text never shrinks below the readability floor. Lettering, symbols and stats are never AI-painted.
- Lettering never touches a bar's rails. The renderer measures each panel's open interior (its shape minus the rail and a double rail's inner ring) and keeps 8 px clear around the title, mana cost, original name, type line, rarity symbol, statistics and rules text. A bar too short for its contents grows: title bars evenly (downwards near the card's top edge), type bars upwards (the rules panel stays put), the original-name tab downwards, the power/toughness box evenly and, for wide statistics, leftwards. Lettering moves inward past thick rails and cut-in ends, and rules text gets matching side margins and stays above the rails of the panel's bottom arch. Frames with the default 12 px single rail are unchanged apart from descender clearance.

## Examples

`examples/frame-sets/` has three deliberately different sets: `classic.json` (classic level), `art-deco.json` (stylised) and `showcase-observatory.json` (showcase, with tinted textures and motif symbols). They illustrate vocabulary, not palettes to copy. `examples/frame-set.json` is the minimal valid skeleton.
