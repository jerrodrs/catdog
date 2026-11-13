# Deterministic borderless Commander cards

Card Studio can also run behind an authenticated Cloudflare Tunnel. See
[server deployment](docs/server-deployment.md) for the deployed service, login
configuration, generation credentials and maintenance commands. Server and local
libraries are independent.

## Local deck builder

**Card Studio** adds multiple decks, decklist import, folders, deck-specific art direction, a generation queue, card review, appearance controls, revision requests, version history, deck analysis and print-ready PDF exports. Start it from a normal terminal in this folder:

```bash
npm start
```

Open **http://127.0.0.1:4317**. Requires Node.js 22.13+ (Node 24 recommended), Python 3.10+ with `requirements.txt` installed (Pillow and ReportLab), and the Codex CLI signed in with `codex login`. No npm dependencies or API key are required by Studio. Your Codex session must have image generation and card research available. Generation uses your Codex account and its usage limits.

Choose **New deck**, paste a decklist, and submit. The eight example cards appear automatically in a sample deck. Open any card to request changes, edit copies/section/notes, approve it, download its PNG, or restore an older version. Use **Style guidelines** on the deck page to edit its art direction, naming and flavour rules. The sample deck’s full cat-and-dog brief is saved in its database record. Deck details lets you move decks between collections, duplicate them or archive them. Use the integrated analysis panel and list view to build the deck, then **Print** for exact-size PDF sheets, or export text/PNG ZIP files. [Studio guide and architecture](docs/card-studio.md).

Decks, job history and generated versions are saved in `library/`, separately from the existing example manifests. The server binds only to your machine. To use another port, run `PORT=4318 npm start`.

```bash
npm run test:studio
```

The application tests cover request handlers, local request protection, import, versioned jobs, the real renderer, rollback, export and interface templates. A synthetic Codex protocol fixture exercises the integration without spending account usage. Live Codex generation runs through the signed-in local CLI. Isolated headless Chrome checks cover deck controls and the full-page Frame Studio editor; automated generation tests use a synthetic protocol fixture.

Frame Studio manages reusable, versioned frame sets. **Bloomburrow inspired** is the default. Open a set for large previews of every colour and legendary combination, rename it, make it the default, or generate a revision. Controls cover borders, rules-panel sizing, metallic rails and text-bar padding, with real printed-card reference photos. The visual editor supports dragging bars, resizing padding, region annotations, undo/redo and live renderer previews; measurements and numbered notes accompany generated revisions. Decks select their own set independently.

**Styles** stores reusable art-technique prompts, with three editable starters. Deck guidelines can pin a Style revision, use structured sections, or retain a complete custom prompt. Upload references to Styles or deck guidelines and ask local Codex to extract editable prompt proposals; deck extraction lets you choose the features. Review and apply proposals explicitly. Card jobs retain exact prompt and reference snapshots.

## Card renderer

Current template: **borderless-v2.4**, revised against the user-provided Bloomburrow references. [Updated Delighted Halfling](output/delighted-halfling-v2.4/001-delighted-halfling.png) uses the latest gouache style from `card-style.txt`, capital-height centring, corrected inline symbols, Beleren2016 Bold, coloured bevelled rims and dark translucent panels. Title/type bars retain the approved padding and the subtitle remains an attached angled tab. No artwork credit, watermark, proxy label or collector/set/language footer is printed on the card. Previous card outputs remain available for comparison.

To create another card, give its name in this project. `AGENTS.md` routes the request to the [project-local card-making skill](skills/create-commander-card/SKILL.md), which researches the card, reads the latest style, generates art, composes the card and inspects the result.

The [eight-card style test](output/commander-style-test/contact-sheet.jpg) includes the regenerated Delighted Halfling and the seven requested cards. Its [manifest](decks/commander-style-test-complete.json) records the selected art and per-card sources. Rin and Seri uses the existing dense profile; other samples use standard geometry.

This repository builds custom Magic-style card fronts from **locked card data + saved artwork + a fixed typesetting template**. The artwork is the only generated visual. Fonts, names, rules, costs, frames and statistics are composed locally, never painted by an image model.

Start with the [four layout proofs](output/layout-proofs/contact-sheet.jpg). These use fictional test cards and a visibly marked art placeholder; they demonstrate structure, not finished art or verified Magic cards.

## Run it

Python 3.10+ and the pinned Pillow dependency are required. Font assets are included locally; the renderer never substitutes installed system fonts.

```bash
python3 -m pip install -r requirements.txt
python3 -m cardforge render examples/layout-proofs.json --proof --out output/layout-proofs
python3 -m unittest discover -s tests -v
```

For a real batch, set each card's `art` to a saved image path relative to its manifest, then run:

```bash
python3 -m cardforge check deck.json
python3 -m cardforge render deck.json --out output/deck
```

Each card produces a 1500 × 2100 PNG at 600 DPI, a transparent `.frame.png` containing its typeset structure, and a `.report.json` recording source/font/art/output hashes and layout measurements. A contact sheet makes deck-wide consistency easy to review. The full batch is preflighted before writing. `--guides` adds diagnostic safe-area and text-boundary guides; never use that output for printing.

## Fonts and placement

| Area | Font asset | Placement |
| --- | --- | --- |
| Display title | Beleren2016 Bold | Upper left; visible ink centred vertically and measured against mana |
| Mana cost | Mana symbol font | Upper right; right edge and symbol size fixed |
| Original Magic name | Plantin MT Pro Semibold Italic | Secondary title bar immediately below display title |
| Type line | Beleren2016 Bold | Directly above rules box; visible ink centred |
| Rules | Plantin MT Pro Regular | Left aligned in lower panel |
| Reminder text | Plantin MT Pro Italic | Inline; parentheses retained |
| Ability words | Plantin MT Pro Italic | Explicit `italic_phrases`; wording retained |
| Flavour text and attribution | Plantin MT Pro Italic | Below rules, separated by a hairline |
| Power/toughness | Beleren2016 Bold | Independent lower-right panel; visible ink centred |
| Production provenance | Manifest and report metadata | Outside the card image |

**V2 uses Beleren2016 Bold from the [user-specified Saeris repository](https://github.com/Saeris/typeface-beleren-bold).** Its internal family name is Beleren2016; the repository states that its files were extracted from Wizards' official website. Plantin files identify internally as Plantin MT Pro. The bundled files, their sources and Git blob identities are recorded in [asset provenance](assets/provenance.json). Older Beleren Proxy files remain for v1 provenance. See [asset notes](assets/NOTICE.md).

## Reusable frame templates

```bash
python3 -m cardforge frames
```

This exports 34 transparent base frames to `assets/templates/borderless-v2`, an `index.json`, and a [labelled proof matrix](output/frame-templates-v2/template-matrix.jpg). Families cover W/U/B/R/G, colourless, all ten colour pairs, and gold for three-or-more colours. Every family has normal and legendary versions. Dual-colour rims blend between the two colours, with a gold header; legendary cards use a raised crest. Selection uses the card's colours and legendary supertype, independently of input colour order.

The shared geometry is drawn from reusable paths, coloured rails, inner keylines and directional bevel highlights/shadows. Production frames are cached by family, layout profile, alias-bar presence and statistics presence, so lands and spells do not inherit unused creature badges. Exported base proofs include both optional components for inspection. The same code generates the production frames, so there is no second set of hand-maintained card borders.

## Card data

`name` is always the original Magic name. `display_name` is optional. Changing the latter never changes Oracle text, costs, type or statistics.

```json
{
  "cards": [
    {
      "id": "001-sol-ring",
      "name": "Sol Ring",
      "display_name": "The Hearthstone",
      "mana_cost": "{1}",
      "type_line": "Artifact",
      "oracle_text": "{T}: Add {C}{C}.",
      "flavor_text": "A little warmth can change everything.",
      "colors": [],
      "art": "art/001-sol-ring.png",
      "art_focus": [0.5, 0.5],
      "art_credit": "AI-generated artwork",
      "collector_number": "001"
    }
  ]
}
```

This snippet illustrates the format; actual deck production starts from a fresh card-data snapshot. `art_focus` controls cropping (0=left/top, 1=right/bottom). `colors` controls frame colour; `color_identity` is stored separately and does not determine the frame. Multicolour uses gold. Colourless/artifact/land examples use a neutral treatment.

Save card data from Scryfall and import the local JSON. This command accepts an individual card, a card array, or a list response; it preserves Oracle text and stores the snapshot hash and card IDs.

```bash
python3 -m cardforge import data/scryfall-snapshot.json --out deck.json
```

Add the custom names, flavour text, art prompts and art paths to that manifest. Keep the original snapshot for comparison. Rendering never fetches live data, so an Oracle update cannot silently change an existing deck.

## Quality rules

- Fixed canvas, frame paths, font assets, symbol sizing, line spacing and layer order.
- Title/type labels are centred using the capital T's rendered bounds, allowing descenders to extend below the baseline without shifting the capitals upwards. Aliases and stats use their whole visible ink bounds. Inline symbol discs share the rules text's capital-height centre; each symbol glyph is also centred inside its disc.
- Text is measured before drawing. No clipping, ellipses, horizontal distortion or dropped rules.
- Title fitting respects the mana cost. Long original names are fitted independently.
- Rules and flavour fit together above the reserved statistics area. Body sizes use the fixed ladder 64, 62, 60, 58, 56 px; no further shrinking is allowed.
- `standard` and explicit `dense` profiles are available. The latter raises the rules panel by 180 px. It is never selected silently.
- Symbols use vector font glyphs, including inline costs and tap symbols. Unsupported symbols fail.
- No-art builds require `--proof`. Artwork below 1500 × 2100 fails instead of being silently enlarged.
- Identical inputs and renderer/font/runtime versions produce identical outputs. Hashes record the exact inputs; generated art itself is not deterministic and must be saved.

## Scope

Version 1 implements the normal single-face structure used by creatures, artifacts, enchantments, instants, sorceries and lands, including alternate display names. Planeswalkers, Sagas, Classes, Battles, split, Adventure and double-faced structures are rejected until a dedicated template is added. The deck list will identify which additional templates are necessary.

Final card fronts have no footer lettering; art provenance and collector metadata remain outside the image. The renderer uses an original expansion mark and validates composition rather than Commander deck legality. Output is an RGB trim-size master, with no printer-specific bleed or CMYK conversion; prepare those against the chosen printer's specification.

The [design specification](docs/design-spec.md) records geometry and research. The [production workflow](docs/production-workflow.md) explains how future prompts and art become finished cards.
