# From deck list to finished cards

## 1. Lock the card information

Resolve the user's card list to exact original card identities. Save current card objects in `data/` before creating the production manifest. Preserve Oracle text, mana cost, type, power/toughness, colours and original name. Import from that local snapshot; do not rely on remembered card wording. Store the snapshot and card IDs with the deck. Distinguish frame colours from Commander colour identity.

Read the list for structures requiring more than the normal template. Implement the necessary dedicated layouts before composing those cards; never squeeze Saga chapters or planeswalker loyalty abilities into an ordinary creature panel. A double-faced card needs both faces and face indicators.

## 2. Lock the deck's visual direction

The user supplies the theme and art description. Record the palette, mood, rendering medium, recurring characters and their consistent appearance. Give each card an independent art brief and custom `display_name` where requested. The original Magic name remains immediately below it. Custom flavour belongs only in `flavor_text`; it never replaces rules.

Choose one default layout profile for the deck. Rules panels fit content by default and the type/rules section never exceeds 40% of card height. Body text fits from 64px to a hard 36px floor. `dense` cannot bypass this cap; overflow still fails without truncating rules. The v2 frame family is selected automatically from the card's colours and legendary supertype. Reuse `cardforge/frames.py` and its palette configuration; do not design individual borders per card. Finalise type/rules geometry before prompting art, because it determines which parts of an image remain unobscured.

For Studio jobs with a verbatim art-prompt contract, keep the saved style text intact. Write scene/composition guidance separately and use `node studio/art-prompt.mjs REQUEST_JSON SCENE_TEXT OUTPUT_PROMPT_TEXT` to assemble the image input. Pass the complete assembled prompt unchanged and retain it in each new face's `art_prompt`. Never summarize the style block to fit a scene idea.

## 3. Generate only the artwork

Use the image generation skill/tool when actual art is requested. It is unnecessary for renderer implementation or layout proofs. Each generated source is saved independently; do not ask the model to paint the complete finished card.

When designing a reusable frame set, detailed materials such as fluid drops or carved filigree may instead be generated as isolated transparent PNG components. Keep geometry, panels, all lettering and symbols in the deterministic renderer. Save components, prompts and provenance with the new frame version; `decorations` places them in fixed boxes and masks gameplay areas. Card jobs copy the chosen assets and hashes into their own frame snapshot. Do not generate new frame details independently for every card.

Use this composition contract in addition to the user's art brief:

> Portrait illustration for a borderless Magic-style card, 5:7 trim composition. The image fills the entire canvas, including behind future UI panels. No card frame, border, letters, numbers, text, mana symbols, logos or watermarks. Place the principal face/action in the central upper artwork area, roughly x=12–88% and y=15–58% of the card. Avoid vital details in the top 12%, lower rules-panel region and lower-right statistics region. Continue natural scene detail to every edge. Follow the deck's recorded palette, medium and character descriptions.

For `dense`, keep important details above 52% height. Request the highest native resolution the provider supports and keep its original bytes. Prefer native artwork at least 3000 × 4200 for 1200 PPI output; 1500 × 2100 remains the minimum accepted preparation size. Native resolution, prepared resolution and final lettering resolution are distinct. If the image tool cannot produce that size natively, explicitly create and review a high-quality upscale as an art-preparation step; the renderer itself rejects undersized art. Never claim upscaled artwork contains native detail at the export resolution.

Art generation is stochastic. Determinism begins once a chosen art file is saved. Retain its prompt and filename; do not regenerate it during rebuilds.

## 4. Compose locally

Display titles stay on one line in the fixed title box at 80→56 px. Shorten alternate names or omit epithets whenever needed; title fit overrides naming instructions in style prompts. Preserve the exact original Magic name, and check each face against the selected frame before completing a job. Never wrap titles, enlarge the box or shrink below the floor.

Assign `art` and `art_focus` to every card; retain accurate art provenance in metadata. Do not draw artwork credits, AI-art labels, proxy labels, collector numbers, or set/language codes on the card. Add `italic_phrases` for any ability words requiring italic styling. Run `check`, resolve every failure, then `render`. The saved art stays behind the deterministic structure. The `.frame.png` is also a reusable transparent overlay at the same resolution.

Review representative cards first: commander, longest name, longest rules, short spell, artifact and land. Inspect full-size outputs and actual-size previews. Once the treatment is established, render the remaining deck from the same assets and versioned renderer.

## 5. Review and export

Compare each card's mechanics to its saved snapshot. Check costs and stats separately. Verify alias/original-name pairing, reminder italics, ability words, flavour separator, no punctuation stranded on a separate line, readable contrast and consistent framing. Check label centring against visible glyph bounds and inline symbols against the rules font's capital height; the build report records both. Inspect the contact sheet for deck-wide consistency and art crops. Re-render only after changing the manifest, chosen art or versioned template.

Deliver trim-size PNG masters, overlay PNGs, contact sheets and build reports. Add bleed, print sheets/PDF or printer-specific colour conversion only after the printing specification is known. Preserve the original RGB masters.

## Print-quality refresh

Studio production composition defaults to 1200 PPI, drawing fonts and symbols at native output size on the frozen logical layout. `python3 -m cardforge render MANIFEST --dpi 1200` produces the same masters. Library quality refreshes reuse the final saved manifest and artwork, keep earlier versions, preserve active and inactive artwork-set selections, and skip official scans. Artwork is not regenerated or reinterpreted. Save a report and transparent frame for every new version. Full-resolution PDFs retain native image pixels rather than imposing a 600 PPI ceiling; manual 300/600/1200 PPI export options are deliberate resampling choices.
