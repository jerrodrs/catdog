# Magic Set Editor templates (Full Magic Pack)

Card Studio can draw cards with the templates of [Magic Set Editor](https://magicseteditor.boards.net/)'s community
[Full Magic Pack](https://github.com/MagicSetEditorPacks/Full-Magic-Pack), alongside the frame sets designed in Frame Studio.
Frame Studio → **Template library** lists every normal-card template with a rendered preview, its era and family, the
print resolution of its frame art and whether it has an original-name tab. **Use this frame** adds it as an ordinary
frame set, which decks then choose like any other.

## How it works

- `vendor/Full-Magic-Pack` is a read-only checkout of the pack (about 1.7 GB, git-ignored), including Windows
  `magicseteditor.exe` 2.6.x and the `Magic - Fonts` folder.
- A frame set config with `"renderer": "mse"` names a stylesheet:
  `{"schema_version": 3, "renderer": "mse", "name": …, "mse": {"stylesheet": "m15-showcase-capenna-art-deco", "layouts": {}}}`.
  `layouts` may map a card structure to a different stylesheet. An optional `rarity_symbol` uses the frame-set glyph schema.
- `cardforge/mse.py` writes the card's saved Oracle data to a one-off MSE set file and runs MSE's command-line exporter
  through WSL interop. Each render draws the card three times (with the artwork, over black and over white). The
  black/white pair gives an exact transparent frame overlay, translucent panels included. Output is resampled from at
  least the target size to 1500 × 2100 (600 DPI) or 3000 × 4200 (1200 DPI). Transparent card corners are filled black.
- The deck’s frame dialog uses a separate 900 px screen-proof path: cards sharing a stylesheet are exported together in one MSE launch, without the black/white overlay probes. Production cards and their transparent overlays continue to use the full renderer above.
- Only the packages a stylesheet needs are copied to `%LOCALAPPDATA%\CardStudio\mse` (MSE is very slow reading over
  `\\wsl.localhost`). In that copy `information_disabled_1/2/3` are switched on in `magic.mse-game/script`, so no
  collector number, set code, artist or copyright is ever drawn.
- Each template's art window is measured once by rendering a coordinate-gradient image and fitting where it lands
  (`library/mse/art-boxes/`). Artwork is cropped to that window around the card's `art_focus` and never enlarged.
- The frame set's rarity glyph (or the classic diamond) is traced into a vector `.mse-symbol`, so MSE colours it per
  rarity like a printed expansion symbol.

## Data mapping

| Card Studio | MSE |
|---|---|
| `display_name` (when the template has an original-name tab) | `name`, with the original name in `alias` |
| `name` | `name` (templates without a tab print the original name; the report flags it) |
| `mana_cost` `{2}{W/U}{G/P}` | `casting_cost` `2W/UH/G` |
| `type_line` | `super_type` / `sub_type`, split at ` — ` |
| `oracle_text` | `rule_text`, symbols as `<sym>…</sym>`; automatic reminder text is off |
| `flavor_text`, `power`, `toughness`, `rarity` | same fields (`mythic` → `mythic rare`) |

Normal cards, tokens and both faces of transforming cards use the MSE template. Planeswalkers, sagas and
adventure/prepare cards use the included cardforge renderer. MSE positions planeswalker loyalty boxes only in its
editor, not on export.

## Fonts

MSE reads installed Windows fonts. `python3 -c "from cardforge import mse; mse.install_fonts()"` installs every font in
`Magic - Fonts` for the current Windows user, with no administrator rights. The catalogue lists fonts a template names
that the pack does not ship. Those templates are not offered, and rendering them is refused rather than substituted.

## Quality notes

- Frame-art resolution varies. Showcase templates ship about 300 PPI art, while many classic M15 templates ship
  375 × 523 px (150 PPI) frames that print visibly softer. The library shows the PPI and by default lists only 250+ PPI
  templates. Lettering and mana symbols are vector in MSE and print crisp at any size.
- MSE fits text with its own rules. Very long rules plus flavour text can run under a template's P/T box. Check the
  actual-size output as with any card.
- The first render of a template takes a minute or two: it syncs packages and measures the art window. Later cards take
  about 8 seconds each. Renders are serialised with a lock because MSE shares one settings file.

## Commands

On a Linux server, set `CARDSTUDIO_MSE_WINE` to the Wine executable,
`WINEPREFIX` to a dedicated prefix, and `CARDSTUDIO_MSE_HOME` to a cache
inside that prefix's `drive_c` (for example `drive_c/CardStudio/mse`).
Install `xvfb-run` for headless exports and run `mse.install_fonts()` with these
settings. Wine fonts are installed into the prefix's Windows Fonts directory
and registered in one batch. Keep the Full Magic Pack in `vendor/Full-Magic-Pack`;
only the cache is patched. The WSL/Windows path remains the default when Wine is
not configured.

```
python3 studio/mse_frames.py catalog                    # catalogue JSON (cached in library/mse/catalog.json)
python3 studio/mse_frames.py import STYLE DIRECTORY     # config.json + validation previews for a frame version
python3 studio/mse_frames.py gallery ART OUT [STYLE…]   # template-library preview cards
CARDSTUDIO_MSE_TESTS=1 python3 -m unittest tests.test_mse
```
