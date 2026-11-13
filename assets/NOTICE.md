# Font and symbol sources

Font binaries are local assets so rendering cannot silently depend on a machine's installed fonts. Git blob IDs and source URLs are in `provenance.json`; each output report records SHA-256 hashes of every font.

- **Beleren2016 Bold and Beleren2016 Small Caps Bold (active v2):** obtained from the [Saeris repository specified by the user](https://github.com/Saeris/typeface-beleren-bold). Internal families: Beleren2016 and Beleren2016 Small Caps. The upstream README states the fonts were extracted from Wizards' official website and identifies Wizards as the copyright owner; it describes the library as unofficial and for non-commercial use. Its MIT licence applies to the CSS, not to ownership of the fonts. The upstream README and licence are preserved as `fonts/Saeris-README.md` and `fonts/Saeris-LICENSE.md`.
- **Beleren Proxy Bold (historical v1):** community recreation distributed by [Proxyshop](https://github.com/Investigamer/Proxyshop/tree/main/fonts). Retained for provenance; no longer the default title font.
- **Plantin MT Pro Regular, Italic and Semibold Italic:** files distributed in the same Proxyshop font directory. Internal family: Plantin MT Pro. Regular and italic serve body text; semibold italic serves the secondary title bar.
- **Gotham Medium and Beleren Small Caps Bold:** from the same font directory, used for collector information and artist credit respectively.
- **Mana font and CSS:** [Andrew Gioia's Mana](https://github.com/andrewgioia/mana), version 1.18.0 as identified by its bundled stylesheet. Font: SIL OFL 1.1; CSS: MIT, per the [maintainer's documentation](https://mana.andrewgioia.com/). Mana/card symbol designs belong to Wizards of the Coast.

Proxyshop documents the families and their origins in its [font guide](https://docs.hexproof.io/proxyshop/user-guide/fonts/). Inclusion in that repository does not establish commercial redistribution rights for every font. Preserve attribution/source information with this personal custom-card project; no broader font licence is asserted here. Custom artwork should carry an accurate credit and must not attribute generated art to the original card's illustrator.
