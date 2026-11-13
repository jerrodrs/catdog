import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {compareScenes} from '../public/scenes.js';
import {analyzeDeck,cardData,manaValue,cardRoles} from '../public/analysis.js';

function interfaceHarness(){
  const elements=new Map();
  const element=selector=>{if(!elements.has(selector))elements.set(selector,{innerHTML:'',showModal(){},close(){},addEventListener(){}});return elements.get(selector);};
  const context=vm.createContext({document:{querySelector:element,addEventListener(){}},window:{addEventListener(){}},location:{hash:'#library'},setTimeout:()=>0,clearTimeout(){},console,URL,Set,Map,Date,analyzeDeck,cardData,manaValue,cardRoles,compareScenes});
  const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8').replace(/boot\(\);\s*$/,'').replace(/^import .*;\n/gm,'');
  vm.runInContext(source+'\nglobalThis.ui={state,renderShell,renderLibrary,renderDeck,renderQueue,renderDrawer,newDeck,deckStyle,appearanceControls,visibleCards,stackedCards,renderFrames,generationDialog,frameDeckSourceForm,downloadPrint,restorePrintHistory,showPrintDownload,setFramePreviewImage};',context);
  const ui=context.ui;ui.state.bootstrap={codex:{signed_in:true},paused:false};
  return {ui,context,html:selector=>element(selector).innerHTML};
}
const card={id:'card-1',deck_id:'deck-1',name:'Sol Ring',quantity:2,section:'commander',approval:'unreviewed',active_version_id:'version-1',version_number:1,summary:{display_name:'Hearthlight',type_line:'Artifact',oracle_text:'{T}: Add {C}{C}.'}};

test('print dialog offers separate physical faces while retaining a single library card',async()=>{
 const {ui,context}=interfaceHarness();
 ui.state.deck={id:'deck-1',name:'Two faces',cards:[card]};
 vm.runInContext("modal=(title,body)=>{globalThis.printDialog=body;};updatePrintPreview=()=>{};restorePrintHistory=()=>{};",context);
 await vm.runInContext('printDeck()',context);
 assert.match(context.printDialog,/<option value="separate">Each face as a separate card<\/option>/);
 assert.match(context.printDialog,/Print those sheets single-sided/);
 assert.equal(ui.state.deck.cards.length,1);
});

test('print downloads reject stale servers and stream completed exports without buffering a Blob',async()=>{
 const {ui,context,html}=interfaceHarness();ui.state.deck={id:'deck-1',name:'Print test'};
 vm.runInContext("printSettings=()=>({packaging:'per_page'});api=async()=>mockPreview;toast=()=>{};",context);
 let fetched=0,buffered=0,cancelled=0,clicked=0;
 context.mockPreview={};context.fetch=async()=>{fetched++;return {ok:true,headers:{get:()=>context.mockType},body:{cancel:async()=>cancelled++},blob:async()=>{buffered++;return {};},json:async()=>context.mockResult};};
 await assert.rejects(ui.downloadPrint(),/server needs a restart/);assert.equal(fetched,0);
 context.mockPreview={print_download_links:true,print_page_links:true};context.mockType='application/pdf';
 await assert.rejects(ui.downloadPrint(),/unexpected print format/);assert.equal(buffered,0);assert.equal(cancelled,1);
 const link={click(){clicked++;},remove(){}};context.document.createElement=()=>link;context.document.body={appendChild(){}};
 context.mockResult={download_url:'/api/print-exports/1234',pages_url:'/api/print-exports/1234/view',filename:'Print test-print-pages.zip',pages:[{name:'page-001.pdf',size:1024,view_url:'/api/print-exports/1234/pages/1?view=1',download_url:'/api/print-exports/1234/pages/1'}]};
 context.mockType='application/json';await ui.downloadPrint();assert.equal(buffered,0);assert.equal(clicked,0);assert.match(html('#print-download'),/Open &amp; print/);assert.match(html('#print-download'),/pages\/1\?view=1/);
 vm.runInContext("printSettings=()=>({packaging:'combined'});",context);context.mockResult={download_url:'/api/print-exports/1234',filename:'Print test-print.pdf'};
 await ui.downloadPrint();assert.equal(buffered,0);assert.equal(clicked,1);assert.equal(link.download,'Print test-print.pdf');assert.equal(link.href,'/api/print-exports/1234');
});

test('reopening print settings restores saved controls and links, while late responses preserve user edits',async()=>{
 const {ui,context,html}=interfaceHarness();ui.state.deck={id:'deck-1',name:'Restore'};
 const form=context.document.querySelector('#print-form');form.elements={quality:{value:'full'},calibration:{type:'checkbox',checked:false}};
 vm.runInContext("printSettings=()=>({quality:document.querySelector('#print-form').elements.quality.value});api=async()=>mockHistory;toast=()=>{};",context);
 context.mockHistory={settings:{quality:'compact',calibration:true},saved_export:{download_url:'/api/print-exports/1234',filename:'Saved.pdf',pages:[]}};
 await ui.restorePrintHistory();assert.equal(form.elements.quality.value,'compact');assert.equal(form.elements.calibration.checked,true);assert.match(html('#print-download'),/Saved.pdf/);
 let release;context.waitForHistory=()=>new Promise(resolve=>{release=resolve;});vm.runInContext('api=()=>waitForHistory();',context);
 const pending=ui.restorePrintHistory();form.elements.quality.value='1200';release(context.mockHistory);await pending;assert.equal(form.elements.quality.value,'1200');
 ui.showPrintDownload(null);assert.equal(html('#print-download'),'');assert.equal(context.document.querySelector('#print-download').hidden,true);
});

test('frame switching keeps the current artwork visible and ignores images from an older selection',()=>{
 const {ui,context}=interfaceHarness(),loaders=[];context.Image=class{constructor(){loaders.push(this);}};
 const classes=new Set(),figure={classList:{add(...names){names.forEach(name=>classes.add(name));},remove(...names){names.forEach(name=>classes.delete(name));}}};
 const img={src:'current-art.png',closest:()=>figure};
 ui.setFramePreviewImage(img,'slow-frame.png');assert.equal(img.src,'current-art.png');assert.ok(classes.has('loading'));
 ui.setFramePreviewImage(img,'new-frame.png');loaders[0].onload();assert.equal(img.src,'current-art.png');
 loaders[1].onload();assert.equal(img.src,'new-frame.png');assert.equal(classes.has('loading'),false);
});

test('library, gallery, list and queue render saved decks and card versions',()=>{
  const {ui,html}=interfaceHarness();
  ui.state.decks=[{id:'deck-1',name:'Forest companions',description:'A woodland adventure.',folder:'Commander',archived:0,unique_cards:1,total_cards:2,generated:1,cover_version_id:'version-1',updated_at:'2026-10-29'}];
  ui.renderShell();ui.renderLibrary();assert.match(html('#sidebar'),/Commander/);assert.match(html('#content'),/Forest companions/);assert.match(html('#content'),/\/assets\/version-1\/image/);
  ui.state.deck={...ui.state.decks[0],cards:[card]};ui.renderDeck();assert.match(html('#content'),/Hearthlight/);assert.match(html('#content'),/Sol Ring/);assert.match(html('#content'),/value="1" max="1"/);assert.doesNotMatch(html('#content'),/style=/);
  ui.state.layout='list';ui.renderDeck();assert.match(html('#content'),/builder-table/);
  ui.state.jobs=[{id:'job-1',deck_id:'deck-1',card_name:'Sol Ring',type:'revise',status:'failed',error:'Tool unavailable',created_at:'2026-10-29'}];ui.renderQueue();assert.match(html('#content'),/Tool unavailable/);assert.match(html('#content'),/retry-job/);
});
test('card workshop exposes revisions, version selection, notes and correct source rules',()=>{
  const {ui,html}=interfaceHarness();ui.state.detail={...card,notes:'Keep the amber glow.',versions:[{id:'version-1',number:1,summary:card.summary,note:'Original style'}],jobs:[]};ui.state.detailVersion='version-1';ui.renderDrawer(true);
  const output=html('#drawer-root');assert.match(output,/revision-form/);assert.match(output,/Version history/);assert.match(output,/Keep the amber glow/);assert.match(output,/\{T\}: Add \{C\}\{C\}\./);assert.match(output,/approve-card/);
  const revision=output.match(/<form id="revision-form">([\s\S]*?)<\/form>/)[1];assert.doesNotMatch(revision,/<textarea[^>]*\brequired\b/);assert.match(revision,/Optional/);
  assert.match(output,/<input id="include-generation-history"[^>]*checked/);assert.match(output,/Turn off to start from scratch/);
  ui.state.generationHistory={'card-1':false};ui.renderDrawer(true);assert.doesNotMatch(html('#drawer-root'),/<input id="include-generation-history"[^>]*checked/);
  assert.match(output,/appearance-form/);assert.match(output,/Keep original Magic name/);assert.match(output,/Apply as new version/);
});
test('deck guidelines editor loads the selected deck brief with safe escaping',()=>{
  const {ui,html}=interfaceHarness();ui.state.deck={name:'Sci-fi deck',style:'Use <silver> armour.\nNo alternate titles.'};ui.deckStyle();
  assert.match(html('#modal-root'),/deck-style-form/);assert.match(html('#modal-root'),/Use &lt;silver&gt; armour/);assert.match(html('#modal-root'),/No alternate titles/);
});
test('user-supplied names, notes and errors are escaped in HTML',()=>{
  const {ui,html}=interfaceHarness();ui.state.deck={name:'<img src=x onerror=alert(1)>',folder:'<script>evil()</script>',description:'<b>Bad</b>',cards:[{...card,name:'<iframe>',summary:{},notes:''}]};ui.renderDeck();
  assert.doesNotMatch(html('#content'),/<script>|<iframe>|onerror=alert\(1\)>/);assert.match(html('#content'),/&lt;img/);assert.match(html('#content'),/&lt;script/);
  ui.newDeck();assert.match(html('#modal-root'),/new-deck-form/);assert.match(html('#modal-root'),/Start generating after import/);
});
test('independent builder filters and type stacks retain quantities and token grouping',()=>{
  const {ui,html}=interfaceHarness();
  ui.state.deck={name:'Stacked builder',cards:[card,{...card,id:'forest',name:'Forest',quantity:8,section:'main',metadata:{type_line:'Basic Land — Forest',mana_cost:'',colors:[],cmc:0},summary:{}},{...card,id:'cat-token',name:'Cat',section:'tokens',entry_kind:'token',metadata:{type_line:'Token Creature — Cat',colors:['G']},summary:{}}]};
  ui.state.typeFilter='Land';assert.equal(ui.visibleCards().length,1);
  ui.state.typeFilter='all';ui.state.colorFilter='G';assert.equal(ui.visibleCards()[0].name,'Cat');
  ui.state.colorFilter='all';ui.state.layout='stacked';ui.renderDeck();assert.match(html('#content'),/stacked-grid/);assert.match(html('#content'),/Tokens/);assert.match(html('#content'),/×8/);assert.match(html('#content'),/filter-color/);
  ui.state.frameSets=[{id:'builtin-v2.4',name:'Classic Borderless',builtin:true,status:'ready',brief:'Built in'}];ui.renderFrames();assert.match(html('#content'),/FRAME STUDIO/);assert.match(html('#content'),/Planeswalkers/);
});

test('deck header offers cancellation only for its own live generation jobs',()=>{
 const {ui,html}=interfaceHarness();ui.state.deck={id:'deck-1',name:'Current deck',cards:[card]};
 ui.state.jobs=[{id:'other',deck_id:'deck-2',status:'running'}];ui.renderDeck();assert.doesNotMatch(html('#content'),/data-action="cancel-deck-generation"/);assert.match(html('#content'),/data-action="regenerate-all"[^>]*>.*Regenerate all cards \(1\)/);
 ui.state.jobs.push({id:'queued',deck_id:'deck-1',status:'queued'},{id:'active',deck_id:'deck-1',status:'running'},{id:'done',deck_id:'deck-1',status:'succeeded'});
 ui.renderDeck();assert.match(html('#content'),/data-action="cancel-deck-generation"[^>]*>.*Cancel generation \(2\)/);
});

test('each deck exposes its own GPT or Grok subscription image selector',()=>{
 const {ui,html}=interfaceHarness();ui.state.deck={id:'deck-1',name:'Grok world',cards:[card],image_provider:'grok-cli'};ui.state.bootstrap.image_providers=[{id:'codex',name:'GPT · via Codex',available:true},{id:'grok-cli',name:'Grok · subscription CLI',available:true}];
 ui.renderDeck();assert.match(html('#content'),/data-action="set-provider"[^>]*data-provider="grok-cli"[^>]*aria-checked="true"/);assert.match(html('#content'),/GPT · via Codex/);
});

test('queue cooldown notices name each affected provider rather than a global pause',()=>{
 const {ui,html}=interfaceHarness();ui.state.bootstrap.provider_cooldowns={'grok-cli':'2026-11-01T12:00:00Z'};ui.renderQueue();const output=html('#content');assert.match(output,/Grok is rate limited/);assert.match(output,/Other providers can continue/);assert.doesNotMatch(output,/Codex is rate limited/);
});

test('generation queue exposes separate Codex and Grok worker controls',()=>{
 const {ui,html}=interfaceHarness();ui.state.bootstrap.provider_concurrency={codex:2,'grok-cli':3};ui.renderQueue();const output=html('#content');assert.match(output,/data-provider-concurrency="codex"/);assert.match(output,/data-provider-concurrency="grok-cli"/);assert.match(output,/Grok workers<\/label>|Grok workers/);assert.doesNotMatch(output,/id="queue-concurrency"/);
});


test('all-card regeneration asks for generation inputs and defaults to a fresh isolated run',()=>{const {ui,html}=interfaceHarness();ui.state.deck={id:'deck-1',name:'A deck',cards:[card]};ui.generationDialog({mode:'all'});const output=html('#modal-root');assert.match(output,/Regenerate all cards/);assert.match(output,/name="generation_type" value="fresh" checked/);assert.doesNotMatch(output,/<input[^>]*name="include_history"[^>]*checked/);assert.doesNotMatch(output,/<input[^>]*name="use_reference_images"[^>]*checked/);assert.match(output,/<input[^>]*name="isolate_generation"[^>]*checked/);ui.generationDialog({mode:'missing'});assert.match(html('#modal-root'),/<input[^>]*name="use_reference_images"[^>]*checked/);ui.newDeck();assert.match(html('#modal-root'),/name="isolate_generation"/);assert.match(html('#modal-root'),/name="use_reference_images"/);});

test('frame inspiration picker supports standalone prompts and named deck artwork sets',()=>{
 const {ui}=interfaceHarness();ui.state.frameDeckSources=[{id:'d',name:'Moon & glass',art_sets:[{id:'a',name:'Original art',ready:1,total:5},{id:'b',name:'Silver edition',ready:0,total:5}]}];
 const html=ui.frameDeckSourceForm('b');assert.match(html,/Standalone prompt/);assert.match(html,/Moon &amp; glass/);assert.match(html,/<option value="b" selected>Moon &amp; glass · Silver edition · 0\/5 illustrated/);assert.match(html,/commander first/);
});
