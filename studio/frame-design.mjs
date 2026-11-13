// Design-process inputs for Frame Studio: structured briefs, the three-option spread,
// real-art review cards and the designer's instructions.
import fs from 'node:fs';import path from 'node:path';
import {cleanText} from './store.mjs';

export const FLAVOUR_LEVELS=['classic','stylised','showcase'];
export const BRIEF_FIELDS={motif:'Motifs & imagery',materials:'Materials & finish',signature:'Signature element',palette:'Palette',avoid:'Avoid'};
export function briefFields(value={}){
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid brief fields.');
 return Object.fromEntries(Object.keys(BRIEF_FIELDS).map(key=>[key,cleanText(value[key]||'',1000)]).filter(([,v])=>v));
}

// Left to right: one step less flavour, the brief as written, one step more. With "designer's choice"
// the middle level is inferred by the designer and the sides are relative to it.
export function candidatePlan(level,count){
 const index=FLAVOUR_LEVELS.indexOf(level),at=step=>index<0?null:FLAVOUR_LEVELS[Math.max(0,Math.min(2,index+step))];
 if(count===1)return [{direction:'prompt',label:'Your brief',target:at(0)}];
 return [{direction:'simpler',label:'Simpler',target:at(-1)},{direction:'prompt',label:'Your brief',target:at(0)},{direction:'richer',label:'More flavour',target:at(1)}];
}
// Each option also takes a different construction route, so the three never collapse into one design.
const DIRECTION_TEXT={
 simpler:'You are the LEFT option of three: interpret the brief one step SIMPLER and more classic than its literal reading. Fewer motifs, calmer materials, closer to a printed Magic frame, while still clearly belonging to this brief and deck. If the target level is already classic, make this the most restrained, elegant classic version. Construction route: lead with silhouette and material (a considered bar shape or custom profile, rail treatment, rules-box shape, refined textures). Painting is optional and small.',
 prompt:'You are the MIDDLE option of three (or the only option): interpret the brief exactly as written, at the flavour level it asks for. Construction route: build the brief\'s signature idea into the frame itself: a distinctive bar silhouette plus painted components on the frame (bar end caps, crest, stats cartouche, panel-corner pieces) carrying the brief\'s motifs.',
 richer:'You are the RIGHT option of three: interpret the brief one step MORE flavourful and custom than its literal reading. Bolder materials, a stronger signature shape or material treatment, painted surfaces and trim where they help. If the target level is already showcase, push the showcase treatment further. Construction route: paint the frame surfaces themselves: nine-slice painted skins for the title bar and rules box (and stats/crest where they help), a custom bar profile that matches the painted edges, and textured rails. Still frame the art; never spill into it.'};

// Cards to show the frame on with real illustrations: the deck's commander and a spread of types, or random library art.
export function reviewArt(frames,deckContext){
 const picks=[],used=new Set();
 const add=(layout,card,legendary)=>{const art=card?.art?.[0]?.path;if(!art||used.has(art)||!fs.existsSync(art))return;used.add(art);picks.push({layout,legendary:!!legendary,colors:card.colors||[],name:card.name,path:art});};
 const cards=(deckContext?.cards||[]).filter(c=>c.art?.length);
 if(cards.length){
  const type=c=>(c.type_line||'').split(' — ')[0].split(' // ')[0];
  const layoutOf=t=>/Planeswalker/.test(t)?'planeswalker':/Creature/.test(t)?'creature':/Land/.test(t)?'land':/Instant/.test(t)?'instant':/Sorcery/.test(t)?'sorcery':/Artifact/.test(t)?'artifact':/Enchantment/.test(t)?'enchantment':'creature';
  const commander=cards.find(c=>c.commander);if(commander)add(layoutOf(type(commander)),commander,/Legendary/.test(type(commander)));
  for(const test of [t=>/Creature/.test(t)&&!/Legendary/.test(t),t=>/Instant|Sorcery/.test(t),t=>/Artifact/.test(t)&&!/Creature/.test(t),t=>/Land/.test(t),t=>/Legendary/.test(t),t=>/Enchantment/.test(t)]){
   const card=cards.find(c=>test(type(c))&&!used.has(c.art[0].path));if(card)add(layoutOf(type(card)),card,/Legendary/.test(type(card)));
  }
 }else{
  for(const [layout,legendary]of [['creature',true],['instant',false],['artifact',false],['land',false],['sorcery',false]]){
   try{const rows=frames.artCandidates(layout).rows;const row=rows[Math.floor(Math.random()*rows.length)];if(row)add(layout,{name:row.name,colors:(row.summary.faces?.[0]||row.summary).colors||[],art:[{path:row.art_path}]},legendary);}catch{}
  }
 }
 return picks.slice(0,6);
}

export function designerPrompt(directory,layouts){
 const file=name=>JSON.stringify(path.join(directory,name));
 return `Create a reusable Magic card FRAME TEMPLATE SET for Card Studio. This is a frame-design task, not a card illustration task.

INPUTS
Read ${file('request.json')}. The brief, request.brief_fields and explicit request.controls are authoritative. request.candidate tells you which of the three options you are and its target flavour level; request.candidate.instructions is binding.
When request.deck_context exists, read its saved style guide and style_context (including reference images), then inspect its cards using the image viewing tool: prioritize every illustrated commander first, followed by representative colours and card types. Combine the deck's visual theme, medium, palette, materials and motifs with the frame brief; explicit frame instructions take priority over conflicting deck instructions. Use underlying illustrations as visual references, not their existing frame designs. Do not apply deck naming/flavour instructions to frame text. If no card artwork exists, use the saved style guide and say the design was guided by style only. Without deck_context, use the standalone brief and do not inherit any deck theme.
Read request.visual_edits and inspect request.review_images when present: numbered rectangles are user change requests with normalized x/y/width/height. Preserve explicit drag/resize measurements in controls. Card positions (title_offset_y, rules_offset_y, stats_x/y/width/height) are the user's measurements only: do not set them yourself; the verifier removes any the user did not choose. The rules box height comes from rules_sizing (fit hugs the text, so short cards show more art); never try to force a fixed box height, even if the brief names one. If request.decoration_inputs exists, those are chosen transparent ornament assets: inspect and reuse them as real components, preserving alpha. Inspect local reference photos in request.references. If a previous set version is provided, read it before applying the brief.

RECREATING A PRINTED FRAME
When request.reference exists, you are recreating the printed Magic frame treatment named in request.reference.title (see its notes). Inspect every card image in request.reference.images with the image viewing tool before designing, and again when reviewing your proofs side by side with them. Match the treatment as faithfully as the renderer's fixed text anchors allow: border mode, bar silhouettes and corner cuts, rail widths and finishes, panel colours and opacity, paper/stone/metal textures, edge trim and the legendary treatment. Recreate surface patterns (filigree, scales, carved geometry, paper grain, halftone, pipes, brushed ink) as tinted textures or abstract painted decorations on the frame, never over the illustration. Do not reproduce logos, set symbols, names, the reference artwork or standalone icons and emblems. Design an original rarity_symbol in the treatment's spirit, never the set's real expansion symbol.

DESIGN PHILOSOPHY
The illustration is the hero. The frame's job is to box the art in beautifully and complement it, like the frame of a printed Magic card: a title bar at the top, the type bar and rules box at the bottom, the power/toughness box, and (for bordered frames) the border. Keep that structure and keep the art window clear. Within it you have real freedom over how every piece looks: silhouettes, materials, painted surfaces, rails, colour and finish. Aim for a frame people would be excited to print: cohesive, crafted and distinctive, never a generic recoloured bar. Restraint and quality beat clutter; one memorable material idea executed well beats many small ones.

VOCABULARY
Read docs/frame-schema.md: it lists every option and the enforced readability rules. Beyond the preset bar shapes, rail styles and tiled textures you can:
- Draw your own bar silhouette: shape "custom" with shape_profile, the left end as [inset, t] points from top to bottom (mirrored on the right). Brackets, ogee curves, arrow points, double notches, clipped scroll ends.
- Reshape the rules box's lower edge and corners: panel_bottom (arch, flat, notch, step) and panel_corners (square, cut, rounded, notched) with panel_corner_size.
- Paint whole surfaces: skins are painted, non-repeating images fitted to a panel (title, alias, type, rules, stats, crest), with nine-slice "slice" edges so a burned parchment border, stitched leather edge or carved stone lip keeps its painted size at any panel height. covers_rails lets a skin replace the vector rails entirely.
- Texture the rails themselves (rail_texture): hammered metal, wood grain, braided leather, bone.
- Place painted decorations on the frame: bar end caps, crest pieces, stats-box cartouches, panel-corner pieces, edge trim.
The three files in examples/frame-sets/ illustrate vocabulary only: do NOT copy their palettes, shapes or values.

MOTIFS AND THE ART WINDOW
Themed objects are welcome when they are physically part of the frame: a wax seal pressed onto the stats box, a ribbon wrapped around a bar end, gems set in a rail, rivets, stitching, a carved crest on the title bar, thorned vines along a rail. They must sit on the frame surfaces or hang within a few pixels of their edges, never float over the illustration. The verifier rejects any ornament or decoration more than 10% off the frame zone (run frame_tools.py anchors to see it). Never paint lettering, legible text, numbers, mana or tap symbols, set symbols or logos. Do not use vector ornament "symbol" shapes; motifs are painted. The rarity_symbol is a separate vector glyph and may be pictorial.

FLAVOUR LEVELS
- classic: a printed-Magic look. Restraint, coloured or material rims, clean bars; the art carries the card. Light parchment-style panels with dark rules text are allowed.
- stylised: the theme is recognisable from the frame alone. Use at least two distinct themed elements: a custom or non-default bar silhouette, rules-box shape, textured or styled rails, panel textures or skins, linework or painted pieces.
- showcase: a flavourful custom frame with genuinely painted material: skins on at least two surfaces or at least three painted decorations, a strong signature silhouette or material, readable lettering.
Your effective level is request.candidate.target when set; otherwise choose the level the brief implies.

TOOLS
Image generation: use the built-in image generation tool for skins, textures and decorations. Ask for a single isolated piece, front-on and evenly lit, matching the deck's medium (for example traditional paint, ink or engraving rather than glossy 3D). If the tool does not return real transparency, paint the piece on a flat chroma background in a colour absent from it (pure #00ff00 or #ff00ff) and key it out. Paint skins at the target surface's proportions with an even, low-contrast centre where text sits.
Helper scripts (python3 studio/frame_tools.py ...; all write files you choose inside this version directory):
- anchors CONFIG [--layout L] [--legendary] [--alias]: exact boxes (card units and print px) of the title bar, original-name tab, type bar, rules panel, stats box and art window, plus the decoration zone. Use it before drawing any piece to a box.
- cutout SRC DEST [--key auto|#RRGGBB] [--trim]: chroma-key a flat background into clean RGBA with spill removed.
- seamless SRC DEST [--axis x|y|both]: make a texture tile, trim segment or skin centre repeat without a seam.
- proof CONFIG [--layout L] [--colors R] [--legendary] [--alias]: print-resolution card with real review art plus actual-size crops of the bar ends and lower panel. Iterate with this; it takes seconds.
- check CONFIG: fast schema, measured-contrast, print-quality and art-clearance pre-flight.
Web research is available. Look at printed Magic showcase, borderless and retro frame treatments and other well-crafted card frames for inspiration on materials and construction, then design something original: never copy a frame, logo or set symbol.

PROCESS
1. Concepts first. Read request.siblings: the other options are being designed in parallel in those directories. If a sibling's concept.json already exists, read it and choose a clearly different concept (different name, silhouette and signature element). Write ${file('concept.json')} early: {"concepts":[{"name","motif","materials","signature_element","flavour_level","shape","rails"} x 2-3 genuinely different ideas],"chosen":INDEX,"rationale"}. The chosen concept's flavour_level must equal your effective level. Each concept needs one signature element someone would recognise at thumbnail size, made of silhouette, material or a painted frame surface. The verifier fails a design that looks too similar to a sibling that verified first.
2. Build config.json (schema_version 3, all thirteen layouts: ${layouts.join(', ')}; W/U/B/R/G/C/M palettes). Design a unique rarity_symbol for the set: a vector glyph styled to match the frame and deck theme (it may be pictorial) (the renderer colours it black/silver/gold/orange-red per rarity). It must be original, not a real Magic expansion symbol. Painted decorations and textures are PNG files saved in this directory with their prompts and provenance. Never AI-paint lettering, mana symbols or stats. Organic fluid, filigree and carved material belong in painted skins and decorations, not jagged polygons. Skins and textures are PNG files in this directory with their prompts and provenance, like decorations.
   PRINT QUALITY: cards render at 2 px per card unit (3000x4200). A decoration's painted pixels must cover its box at that size with at most 1.25x enlargement, and never be distorted: a stretch-fit image must already have its box's proportions (within 6%). Long border and rail trim uses fit "tile": generate a short seamless segment and it repeats along the box at true proportions, scaled to the box's short side. Large pieces (full-card overlays, perimeter frames, body materials) must be assembled at full print resolution, e.g. composited on a 3000x4200 canvas from tiled segments, corner pieces and high-resolution textures, never generated small and enlarged. Repeating surfaces belong in textures rather than overlays. Pieces must meet cleanly: matching widths and line weights where a side trim meets a corner or bar end, no gaps, seams or overlapping mismatched ends. Each surface reads as one colour and material: a tinted texture or overlay must cover the whole coloured body or exactly match the flat palette colour it meets, never leave a band in a second shade. An image drawn at exactly its box's size at print resolution is placed exactly as drawn, so draw rim-aligned rings that way.
3. Iterate: after each change run frame_tools.py check, then frame_tools.py proof on a creature (legendary, with --alias) and a land, and look at the crops at actual size. Verify: run python3 studio/verify_template.py CONFIG_PATH ${JSON.stringify(directory)} ${file('request.json')}. It validates every layout and colour, measures lettering contrast on the rendered pixels, checks your flavour level is actually delivered, and renders previews/real-art-proofs.jpg with real card illustrations.
4. Review with the image viewing tool: previews/real-art-proofs.jpg first, then previews/detail-crops.jpg (actual-size corners, bar end, side border and stats box at print resolution), contact-sheet.jpg, colour-matrix.jpg and representative creature/land/planeswalker/token proofs. Checklist: Does the frame box the art in and complement it, with the art still the clear focus? Is every painted piece crisp at actual size, unstretched, and joined seamlessly to its neighbours? Are motifs attached to the frame, with no lettering or game-like symbols? Is the illustration completely free of ornaments? Does the rarity symbol suit the frame and read at card size? Would someone recognise the theme with the art covered? Is the signature element visible at thumbnail size? Is every word readable on busy art? Does it look different from a generic gold-rail frame? Iterate until all are yes.
5. Fix every verifier failure. Save all files in ${JSON.stringify(directory)}. Do not edit app or renderer code or prior versions. Images stay footer-free.

Return completed with config_path and a one-sentence message naming the chosen concept, or blocked with an actionable reason.`;
}
export function candidateRequest(plan){return {...plan,instructions:DIRECTION_TEXT[plan.direction]};}
