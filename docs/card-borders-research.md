# Magic outer borders and lower-frame treatments

Research for the Studio outer-border feature, 31 October 2026. Published explanations are separated below from visual observations and our implementation choices. The cached printed-card references retain their source URLs and artist attribution in `assets/frame-references/index.json`.

## What the official descriptions establish

- **Border and frame are different components.** The outer edge is usually black on conventional modern printings; the coloured frame contains the title, art window, type line, rules and statistics. Historical white borders are also real. Wizards' [Anatomy of a Magic Card](https://magic.wizards.com/en/news/feature/anatomy-magic-card-2006-10-21) explicitly distinguishes these components and describes black, white, silver and gold border cases.
- **M15 changed both components.** Wizards' [Magic 2015 release notes](https://magic.wizards.com/en/news/feature/magic-2015-core-set-release-notes-2014-07-07) describe a narrower outer black border and reorganized lower information on a black background. [Aaron Forsythe's original explanation](https://magic.wizards.com/en/news/making-magic/directors-chair-2013-2014-01-06) discusses the frame revision. These changes do not mean every later treatment has a uniform black rectangle around its artwork.
- **Extended art is not borderless.** [Wizards' Project Booster Fun explanation](https://wpn.wizards.com/en/news/mark-rosewater-project-booster-fun) distinguishes art reaching the left/right edges from the borderless planeswalker treatment, and identifies showcase frames as set-specific designs. A card can have wide/full artwork and still retain black areas above and below it.
- **Modern releases use several treatments together.** [Collecting Bloomburrow](https://magic.wizards.com/en/news/feature/collecting-bloomburrow) separately identifies seasonal full-art lands, woodland showcase frames, borderless field notes, other borderless cards and extended-art cards. These labels are not interchangeable. [Collecting Wilds of Eldraine](https://magic.wizards.com/en/news/feature/collecting-wilds-of-eldraine) likewise shows borderless and extended-art versions separately.
- **Legendary decoration is not the outer border.** The [Dominaria frame explanation](https://magic.wizards.com/en/news/announcements/dominaria-frame-template-and-rules-changes-2018-03-21) documents legendary title decoration. That decoration, planeswalker loyalty components, Saga chapter rails and adventure insets still need their own geometry; a border should not substitute for those structures.

## Observations from actual card images

These are visual interpretations, not manufacturer specifications:

| Treatment | Outer edge | Lower-frame behaviour |
| --- | --- | --- |
| Modern normal frame — Counterspell, MH2 267 | Continuous black margin, rounded physical corners | Coloured side rails curve inward near the lower rules panel, exposing more of the black lower area. The text box remains rectangular; the statistics badge, when present, can project into the black base. |
| Retro frame | Continuous, visually heavier black surround | The older interior frame and information area differ from M15; simply widening a modern border does not reproduce a complete retro frame. |
| Legendary normal frame — Thalia reference | Black perimeter | Title decoration is contained by the surrounding frame. The power/toughness badge is a separate foreground component. |
| Full-art basic lands | Treatment-dependent; many retain black edges | Removing a conventional rules panel does not necessarily remove the perimeter or lower black area. |
| Extended art | Art may reach the left/right edge | Upper/lower black frame components can remain. This is not a four-sided borderless treatment. |
| Borderless / showcase | Can reach the physical edge, or use a decorative edge | A dark footer or translucent rules panel can remain without becoming a conventional all-around border. “Showcase” alone does not specify an outer-edge shape. |
| Planeswalkers and paired faces | Treatment-dependent | Preserve the loyalty badge and both faces independently. The outer treatment must not cover gameplay information. |

The bottom taper the user identified is primarily the coloured inner frame narrowing into the black lower area. It is not a change in card size, and not the same thing as printer bleed. Rounded physical die-cut corners are also separate from rounded inner frame openings. Print masters remain rectangular so a printer can trim them.

## Deterministic implementation

Studio offers a separate outer-edge finish: no added border, a thin black perimeter, a thicker classic-inspired perimeter, a black perimeter with a curved lower taper, and historical white/silver/gold colour treatments. Preset widths are adjustable project settings measured at a 63.5 mm-wide card; they are not claims about unpublished Wizards manufacturing measurements.

Borders are applied after deterministic composition, without AI, new text, or a second artwork pass. The central typography, rules panel and original source PNG remain unchanged. The modern finish protects the statistics/loyalty badge while forming its lower black area. Its curve is an approximation compatible with the existing full-art template, not a replacement for a complete M15 inner frame. Historical colour finishes do not imply an official printing or any rules status.

Deck defaults belong to the selected artwork set. Per-card overrides can inherit or explicitly select zero. Existing base versions stay immutable. The same cached, pixel-based result is used in the viewer, PNG/frame downloads, ZIP export and print PDFs; this is not a browser-only CSS border. A cache report records source/output hashes, settings, dimensions and finisher code hash.

Official scans retain their baked-in frames and lettering. All added finishes are bypassed for official versions, including borderless printings and per-card overrides. Viewer, downloads and printing return the original scan exactly. Custom-card borders are drawn inside the existing canvas and never increase its dimensions. Removing such a printed border would require a distinct crop/reconstruction operation and is not silently performed here.
