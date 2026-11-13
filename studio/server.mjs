import {BorderFinish} from './borders.mjs';
import {CardQuality} from './card-quality.mjs';
import {Reconstruction} from './reconstruction.mjs';
import {PrintStudio} from './print-studio.mjs';
import {PrintHistory} from './print-history.mjs';
import {OfficialPrintings} from './official-printings.mjs';
import {imageProviderStatus} from './image-providers.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store, id } from './store.mjs';
import { JobQueue, inside, codexStatus } from './runner.mjs';
import { parseDecklist, exportDecklist } from './decklist.mjs';
import {MetadataLookup} from './metadata.mjs';
import {planPrint,printEntries,printCount} from './printing.mjs';
import {ArtworkLibrary} from './artwork-library.mjs';
import {ArtStyles} from './art-styles.mjs';
import {FrameStudio,FRAME_LAYOUTS} from './frame-studio.mjs';
import {StudioChat} from './chat.mjs';
import {DeckFramePreview} from './frame-preview.mjs';
import {remoteAccess} from './remote-access.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);
const MIME = { '.pdf':'application/pdf','.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.json':'application/json','.zip':'application/zip' };
class HttpError extends Error { constructor(status,message,details){super(message);this.status=status;this.details=details;} }

export function createStudio(options = {}) {
  const access=remoteAccess(options.accessEnvironment||process.env);
  const root = options.root || ROOT;
  const store = options.store || new Store(options.library || process.env.CARD_STUDIO_LIBRARY || path.join(root,'library'),{recover:false});
  if(options.seed !== false&&process.env.CARD_STUDIO_SEED!=='0')store.seed(root);
  const queue = new JobQueue(store,root,options.runner || {});
  const token = randomBytes(32).toString('hex');
  const status = options.status || codexStatus(options.runner?.binary);
  const clients = new Set();
  let official;
  const notify = () => { official?.schedule(); for(const client of clients){if(client.writableEnded||client.destroyed){clients.delete(client);continue;}try{client.write('event: change\ndata: {}\n\n');}catch{clients.delete(client);}} };
  queue.listeners.add(notify);
  const metadata=new MetadataLookup(store,{fetcher:options.metadataFetcher,notify});
  const frames=new FrameStudio(store,root,queue,notify,options.runner||{});
  queue.frameSnapshot=setId=>frames.snapshot(setId);
  const artStyles=new ArtStyles(store,root,queue,notify,options.runner||{});queue.styleSnapshot=(deck,directory,previous)=>artStyles.resolveDeck(deck,directory,previous);
  official=new OfficialPrintings(store,{fetcher:options.officialFetcher,notify,python:options.runner?.python||'python3'});
  store.artSets.externalBusy=deckId=>[...official.locks].some(cardId=>store.get('SELECT deck_id FROM cards WHERE id=?',cardId)?.deck_id===deckId)?'Wait for this deck’s artwork download to finish before switching artwork sets.':'';
  const artworkLibrary=new ArtworkLibrary(store,root,queue,frames,artStyles,notify);
  const borders=new BorderFinish(store,root,{python:options.runner?.python||process.env.CARDFORGE_PYTHON||'python3'});
  const quality=new CardQuality(store,root,{notify,python:options.runner?.python||'python3'});
  const reconstruction=new Reconstruction(store,official,root,{notify,python:options.runner?.python||'python3'});
  official.reconstruction=reconstruction;
  const printing=new PrintStudio(store,official,borders);
  const printHistory=new PrintHistory(store,borders);
  const framePreview=new DeckFramePreview(store,root,frames,borders,{python:options.runner?.python||process.env.CARDFORGE_PYTHON||'python3'});
  const chat=new StudioChat(store,root,{queue,frames,artStyles},notify,options.runner||{});
  const send = (res,status,data) => { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data)); };
  function file(res,filename,attachment,member=null,range=null) {
    if(!fs.existsSync(filename) || !fs.statSync(filename).isFile())throw new HttpError(404,'File not found.');
    const length=member?member.size:fs.statSync(filename).size,offset=member?.offset||0;let first=0,last=length-1;
    if(range){
      const match=range.match(/^bytes=(\d*)-(\d*)$/);
      if(match&&(match[1]||match[2])){
        if(match[1]){first=Number(match[1]);last=match[2]?Math.min(Number(match[2]),last):last;}
        else {first=Math.max(0,length-Number(match[2]));if(Number(match[2])===0)first=length;}
      }else first=length;
      if(!Number.isSafeInteger(first)||!Number.isSafeInteger(last)||first<0||first>=length||last<first){res.writeHead(416,{'Content-Range':`bytes */${length}`});return res.end();}
    }
    res.writeHead(range?206:200,{'Content-Type':member?'application/pdf':MIME[path.extname(filename)] || 'application/octet-stream','Content-Length':last-first+1,
      ...(range!==null?{'Accept-Ranges':'bytes'}:{}),...(range?{'Content-Range':`bytes ${first}-${last}/${length}`}:{ }),
      ...(attachment ? {'Content-Disposition':`attachment; filename="${attachment.replace(/[^a-zA-Z0-9._-]/g,'-')}"`} : {}), 'Cache-Control':'private, max-age=60'});
    if(!length)return res.end();
    const stream=fs.createReadStream(filename,{start:offset+first,end:offset+last});
    stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
  }
  function printDownloadInfo(exportId,saved){
    const base='/api/print-exports/'+exportId,split=saved.plan?.packaging==='per_page';
    return {download_url:base,pages_url:base+'/view',filename:saved.download_name||saved.deck_name+(split?'-print-pages.zip':'-print.pdf'),
      pages:(saved.pages||[]).map(page=>({number:page.number,name:page.name,size:page.size,view_url:base+'/pages/'+page.number+'?view=1',download_url:base+'/pages/'+page.number}))};
  }
  async function savedPrintExport(exportId){
    if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(exportId))throw new HttpError(404,'Print export not found.');
    const directory=path.join(store.directory,'exports'),input=path.join(directory,exportId+'.json');
    if(!fs.existsSync(input))throw new HttpError(404,'Print export not found.');
    const saved=JSON.parse(fs.readFileSync(input,'utf8')),filename=path.join(directory,exportId+(saved.plan?.packaging==='per_page'?'.zip':'.pdf'));
    if(!fs.existsSync(filename))throw new HttpError(404,'Print export not found.');
    if(saved.plan?.packaging==='per_page'&&!Array.isArray(saved.pages)){
      const {stdout}=await run(options.runner?.python||process.env.CARDFORGE_PYTHON||'python3',[path.join(root,'studio/print_deck.py'),'--list-pages',filename],{timeout:30000,maxBuffer:1000000});
      saved.pages=JSON.parse(stdout);fs.writeFileSync(input,JSON.stringify(saved));
    }
    return {saved,filename};
  }
  async function cachedPrintInfo(record){
    if(!record)return null;
    const {saved}=await savedPrintExport(record.export_id);
    return {...printDownloadInfo(record.export_id,saved),completed_at:record.completed_at,reused:true};
  }
  async function printPreview(settings,resolved){
    const plan=planPrint(settings,printCount(resolved.entries,settings));
    return {...plan,missing:resolved.missing,saved_export:await cachedPrintInfo(printHistory.match(resolved,settings,plan))};
  }
  async function printHistoryResponse(settings,resolved,label,resolve){
    printHistory.adoptLegacy(resolved.print_scope,label,settings,resolve,planPrint);
    const last=printHistory.latest(resolved.print_scope);
    if(!last)return {settings:null,saved_export:null};
    const effective={...settings,...last.settings},current=resolve(effective),plan=planPrint(effective,printCount(current.entries,effective));
    const cached=printHistory.match(current,effective,plan);
    return {settings:last.settings,saved_export:await cachedPrintInfo(cached),changed:!cached};
  }
  async function body(req,limit=1000000) {
    if(!String(req.headers['content-type'] || '').startsWith('application/json'))throw new HttpError(415,'Send JSON data.');
    let value='';for await(const chunk of req){value+=chunk;if(Buffer.byteLength(value)>limit)throw new HttpError(413,'Request is too large.');}
    try {const data=JSON.parse(value || '{}');if(!data || Array.isArray(data) || typeof data!=='object')throw new Error();return data;}catch{throw new HttpError(400,'Invalid JSON request.');}
  }
  function parsed(text) { const result=parseDecklist(text);if(result.errors.length)throw new HttpError(400,'Some decklist lines could not be imported.',result.errors);return result.cards; }
  function getDeck(deckId) { const deck=store.deck(deckId);if(!deck)throw new HttpError(404,'Deck not found.');return deck; }
  function getCard(cardId) { const card=store.get('SELECT * FROM cards WHERE id=?',cardId);if(!card)throw new HttpError(404,'Card not found.');return card; }
  async function printPDF(res,settings,resolved,label,{finished=false}={}){
    const {missing,title}=resolved;let entries=resolved.entries;
    const plan=planPrint(settings,printCount(entries,settings));
    if(missing.length&&!settings.skip_missing)throw new HttpError(400,'Generate the missing cards or enable “Skip cards without images”.',missing.map(message=>({line:0,message})));
    if(!entries.length)throw new HttpError(400,'No card images are selected to print.');
    for(const entry of entries)for(const filename of [entry.image_path,entry.back_path].filter(Boolean))if(!inside(root,filename)&&!inside(store.directory,filename))throw new HttpError(400,'A card image is outside the library.');
    const cached=printHistory.match(resolved,settings,plan);
    if(cached){
      const {saved,filename}=await savedPrintExport(cached.export_id);
      if(settings.download_mode==='link')return send(res,200,await cachedPrintInfo(cached));
      return file(res,filename,printDownloadInfo(cached.export_id,saved).filename);
    }
    const fingerprint=printHistory.fingerprint(resolved,plan);
    if(!finished)entries=await borders.entries(entries);
    const directory=path.join(store.directory,'exports');fs.mkdirSync(directory,{recursive:true});const exportId=id();
    const split=plan.packaging==='per_page',extension=split?'.zip':'.pdf';
    const input=path.join(directory,exportId+'.json'),output=path.join(directory,exportId+extension);
    const downloadName=title+(split?'-print-pages':'-print')+extension;
    const saved={deck_name:label,download_name:downloadName,print_scope:resolved.print_scope,settings,entries,plan};fs.writeFileSync(input,JSON.stringify(saved));
    const {stdout}=await run(options.runner?.python||process.env.CARDFORGE_PYTHON||'python3',[path.join(root,'studio/print_deck.py'),input,output],{timeout:180000,maxBuffer:1000000});
    if(split){saved.pages=JSON.parse(stdout).pages;fs.writeFileSync(input,JSON.stringify(saved));}
    printHistory.remember(resolved,settings,plan,exportId,fingerprint);
    if(settings.download_mode==='link')return send(res,200,printDownloadInfo(exportId,saved));
    return file(res,output,downloadName);
  }
  const server = http.createServer(async(req,res)=>{
    try {
      const origin=access.origin(req.headers.host,server.address()?.port||4317);
      if(!origin)throw new HttpError(403,'This app only accepts its configured address.');
      const client=String(req.headers['cf-connecting-ip']||req.socket?.remoteAddress||'local').slice(0,80);
      const authentication=access.attempt(req.headers.authorization,client);
      if(authentication.retryAfter){
        res.writeHead(429,{'Retry-After':String(authentication.retryAfter),'Cache-Control':'no-store'});
        return res.end('Too many failed sign-in attempts. Try again later.');
      }
      if(!authentication.authorized){
        res.writeHead(401,{'WWW-Authenticate':'Basic realm="Card Studio", charset="UTF-8"','Cache-Control':'no-store'});
        return res.end('Sign in to Card Studio.');
      }
      res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','same-origin');
      res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' blob:; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'");
      const url=new URL(req.url,origin), parts=url.pathname.split('/').filter(Boolean);
      if(parts[0]==='api'&&parts[1]==='print-exports'&&req.method==='GET'){
        if(![3,4,5].includes(parts.length))throw new HttpError(404,'Print export not found.');
        const {saved,filename}=await savedPrintExport(parts[2]),info=printDownloadInfo(parts[2],saved);
        if(parts.length===3)return file(res,filename,info.filename,null,req.headers.range||'');
        if(parts[3]==='pages'&&parts.length===4)return send(res,200,info);
        if(parts[3]==='pages'&&parts.length===5){
          const page=saved.pages?.find(page=>String(page.number)===parts[4]);
          if(!page)throw new HttpError(404,'Print page not found.');
          return file(res,filename,url.searchParams.get('view')==='1'?null:page.name,page,req.headers.range||'');
        }
        if(parts[3]==='view'&&parts.length===4){
          const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
          res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
          return res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Print pages · ${esc(saved.deck_name)}</title><link rel="stylesheet" href="/style.css"></head><body><main class="print-export-page"><h1>${esc(saved.deck_name)}</h1><p>Open a sheet, then press Ctrl+P to print. Choose Actual size / 100% and disable Fit to page. Download a sheet to use another PDF reader.</p><ol class="print-page-links">${info.pages.map(page=>`<li><span>${esc(page.name)} · ${(page.size/1024**2).toFixed(1)} MB</span><a href="${page.view_url}" target="_blank" rel="noopener">Open &amp; print</a><a href="${page.download_url}" download="${esc(page.name)}">Download</a></li>`).join('')}</ol><p><a href="${info.download_url}">Download all print files</a></p><p>For automatic duplex printing, export one combined PDF. Individual front and back files require manual pairing.</p></main></body></html>`);
        }
        throw new HttpError(404,'Print export not found.');
      }
      if(!['GET','HEAD'].includes(req.method)) {
        if(req.headers['x-studio-token']!==token || (req.headers.origin && req.headers.origin!==url.origin))throw new HttpError(403,'Refresh the app before making changes.');
      }
      if(url.pathname==='/api/bootstrap' && req.method==='GET')return send(res,200,{token,thumbnail_assets:true,print_download_links:true,print_page_links:true,frame_queue:true,border_revision:Number(store.get("SELECT value FROM settings WHERE key='border_revision'")?.value||1),codex:status,paused:queue.paused,concurrency:queue.concurrency,provider_concurrency:queue.providerConcurrency,cooldown_until:null,provider_cooldowns:queue.cooldownStatus(),styles_enabled:true,artwork_library_enabled:true,image_providers:imageProviderStatus(),default_style:fs.readFileSync(path.join(root,'studio/default-style.txt'),'utf8')});
      if(parts[0]==='api'&&parts[1]==='quality-refresh'&&parts[3]==='retry'&&req.method==='POST'){await body(req);return send(res,200,quality.retry(parts[2]));}
      if(url.pathname==='/api/quality-refresh'){
        if(req.method==='GET')return send(res,200,quality.list());
        if(req.method==='POST'){const data=await body(req);if(data.deck_id)getDeck(data.deck_id);return send(res,202,quality.enqueue(data));}
      }
      if(parts[0]==='api'&&parts[1]==='versions'&&parts[3]==='quality'&&req.method==='GET'){
        const version=store.get('SELECT * FROM versions WHERE id=?',parts[2]);if(!version)throw new HttpError(404,'Version not found.');
        const directory=path.join(store.directory,'quality-probes');fs.mkdirSync(directory,{recursive:true});const input=path.join(directory,id()+'.json');
        const faces=[{label:'front',image_path:version.image_path},...JSON.parse(version.faces_json||'[]').filter(f=>f.label==='back')];
        fs.writeFileSync(input,JSON.stringify({faces,report_path:version.report_path}));
        try{const {stdout}=await run(options.runner?.python||'python3',[path.join(root,'studio/quality_probe.py'),input],{timeout:20000,maxBuffer:1000000});return send(res,200,JSON.parse(stdout));}finally{fs.rmSync(input,{force:true});}
      }
      if(url.pathname==='/api/print-imports'&&req.method==='POST'){const result=await printing.importImages(await body(req,45*1024*1024));notify();return send(res,201,result);}
      if(parts[0]==='print-import-assets'&&parts.length===3&&req.method==='GET')return file(res,printing.importAsset(parts[1],parts[2]));
      if(parts[0]==='api'&&parts[1]==='print-tray'){
        if(parts.length===2&&req.method==='GET')return send(res,200,printing.list());
        if(parts.length===2&&req.method==='POST'){const result=await printing.add(await body(req));notify();return send(res,201,result);}
        if(parts.length===3&&req.method==='PATCH'){const result=printing.update(parts[2],await body(req));notify();return send(res,200,result);}
        if(parts.length<=3&&req.method==='DELETE'){const result=printing.remove(parts[2]);notify();return send(res,200,result);}
      }
      if(url.pathname==='/api/print-library'&&req.method==='GET')return send(res,200,printing.library(Object.fromEntries(url.searchParams)));
      if(url.pathname==='/api/print-official'&&req.method==='GET')return send(res,200,await printing.search(Object.fromEntries(url.searchParams)));
      if(parts[0]==='print-tray-assets'&&parts.length===3&&req.method==='GET')return file(res,printing.asset(parts[1],parts[2]));
      if(parts[0]==='api'&&parts[1]==='print'&&['preview','pdf','history'].includes(parts[2])&&req.method==='POST'){
        const settings=await body(req),resolved=printing.entries(settings);
        if(parts[2]==='preview')return send(res,200,await printPreview(settings,resolved));
        if(parts[2]==='history')return send(res,200,await printHistoryResponse(settings,resolved,'Print tray',values=>printing.entries(values)));
        return await printPDF(res,settings,resolved,'Print tray',{finished:true});
      }
      if(parts[0]==='api'&&parts[1]==='chats'){
        if(parts.length===2&&req.method==='GET')return send(res,200,chat.list());
        if(parts.length===2&&req.method==='POST')return send(res,201,chat.create(await body(req)));
        if(parts.length===3&&req.method==='GET')return send(res,200,chat.detail(parts[2]));
        if(parts.length===4&&parts[3]==='messages'&&req.method==='POST'){const data=await body(req);return send(res,202,chat.send(parts[2],data.message,data.generation_options));}
        if(parts.length===4&&parts[3]==='cancel'&&req.method==='POST'){await body(req);chat.cancel(parts[2]);return send(res,200,{ok:true});}
      }
      if(url.pathname==='/api/events' && req.method==='GET'){
        res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});res.write(': connected\n\n');clients.add(res);
        const heartbeat=setInterval(()=>res.write(': heartbeat\n\n'),15000);heartbeat.unref();req.on('close',()=>{clients.delete(res);clearInterval(heartbeat);});return;
      }
      if(url.pathname==='/api/queue' && req.method==='POST'){
        const data=await body(req);
        if(data.paused===undefined&&data.concurrency===undefined)throw new HttpError(400,'Specify paused or concurrency.');
        if(data.paused!==undefined&&typeof data.paused!=='boolean')throw new HttpError(400,'Specify paused as true or false.');
        if(data.concurrency!==undefined&&(!Number.isInteger(data.concurrency)||data.concurrency<1||data.concurrency>4))throw new HttpError(400,'Choose 1–4 parallel cards per provider.');
        if(data.provider!==undefined&&!['codex','grok-cli'].includes(data.provider))throw new HttpError(400,'Choose Codex or Grok for this worker limit.');
        if(data.provider!==undefined&&data.concurrency===undefined)throw new HttpError(400,'Specify a concurrency for this provider.');
        if(data.concurrency!==undefined)queue.setConcurrency(data.concurrency,data.provider??null);
        if(data.paused!==undefined)queue.setPaused(data.paused);
        return send(res,200,{paused:queue.paused,concurrency:queue.concurrency,provider_concurrency:queue.providerConcurrency});
      }
      if(parts[0]==='api'&&parts[1]==='styles'){
        if(!parts[2]&&req.method==='GET')return send(res,200,artStyles.list());
        if(!parts[2]&&req.method==='POST')return send(res,201,artStyles.create(await body(req)));
        if(parts[3]==='duplicate'&&req.method==='POST')return send(res,201,artStyles.duplicate(parts[2]));
        if(parts[3]==='activate'&&req.method==='POST')return send(res,200,artStyles.activate(parts[2],(await body(req)).revision_id));
        if(parts[3]==='apply-to-decks'&&req.method==='POST')return send(res,200,artStyles.applyToDecks(parts[2],await body(req)));
        if(!parts[3]&&req.method==='PATCH')return send(res,200,artStyles.update(parts[2],await body(req)));
        if(!parts[3]&&req.method==='GET')return send(res,200,artStyles.detail(parts[2]));
      }
      if(parts[0]==='api'&&parts[1]==='art-references'){
        if(!parts[2]&&req.method==='POST')return send(res,201,await artStyles.upload(await body(req,20*1024*1024)));
        if(parts[2]&&req.method==='DELETE'){artStyles.removeReference(parts[2]);return send(res,200,{ok:true});}
      }
      if(parts[0]==='art-reference-assets'&&parts.length===3&&req.method==='GET'){
        const reference=store.get('SELECT * FROM art_references WHERE id=?',parts[1]),field={thumb:'thumb_path',image:'image_path',original:'original_path'}[parts[2]];
        if(!reference||!field)throw new HttpError(404,'Reference image not found.');if(!inside(store.directory,reference[field]))throw new HttpError(403,'Invalid reference path.');return file(res,reference[field],parts[2]==='original'?path.basename(reference.original_path):undefined);
      }
      if(parts[0]==='api'&&parts[1]==='style-extractions'){
        if(!parts[2]&&req.method==='POST')return send(res,202,artStyles.extract(await body(req)));
        if(parts[3]==='apply'&&req.method==='POST')return send(res,200,artStyles.apply(parts[2],await body(req)));
        if(parts[3]==='retry'&&req.method==='POST')return send(res,202,artStyles.retry(parts[2]));
        if(parts[3]==='cancel'&&req.method==='POST'){artStyles.cancel(parts[2]);return send(res,200,{ok:true});}
        if(parts[2]&&req.method==='GET')return send(res,200,artStyles.job(parts[2]));
      }
      if(url.pathname==='/api/frame-deck-sources'&&req.method==='GET')return send(res,200,store.listDecks().map(deck=>({id:deck.id,name:deck.name,archived:!!deck.archived,art_sets:store.artSets.list(deck.id)})));
      if(parts[0]==='api'&&parts[1]==='frame-jobs'&&req.method==='GET')return send(res,200,parts[2]?frames.taskDetail(parts[2]):frames.tasks());
      if(url.pathname==='/api/frame-references'&&req.method==='GET')return send(res,200,JSON.parse(fs.readFileSync(path.join(root,'assets/frame-references/index.json'),'utf8')));
      if(parts[0]==='frame-references'&&parts.length===2&&req.method==='GET'&&/^[a-z-]+-(thumb|normal)\.jpg$/.test(parts[1]))return file(res,path.join(root,'assets/frame-references',parts[1]));
      if(parts[0]==='api'&&parts[1]==='frame-templates'&&!parts[2]&&req.method==='GET')return send(res,200,await frames.templateCatalog());
      if(parts[0]==='frame-template-previews'&&parts.length===2&&req.method==='GET'){try{return file(res,await frames.templatePreview(decodeURIComponent(parts[1]).replace(/\.jpg$/,'')));}catch(e){throw new HttpError(404,e.message);}}
      if(parts[0]==='api'&&parts[1]==='frame-sets'){
        if(parts[2]==='import-template'&&!parts[3]&&req.method==='POST'){const result=await frames.importTemplate(await body(req));return send(res,201,result);}
        if(!parts[2]&&req.method==='GET')return send(res,200,frames.list());
        if(!parts[2]&&req.method==='POST')return send(res,201,frames.create(await body(req)));
        if(parts[2]&&!parts[3]&&req.method==='PATCH')return send(res,200,frames.update(parts[2],await body(req)));
        if(parts[2]&&!parts[3]&&req.method==='DELETE'){const result=frames.remove(parts[2]);notify();return send(res,200,result);}
        if(parts[3]==='default'&&req.method==='POST')return send(res,200,frames.makeDefault(parts[2]));
        if(parts[3]==='preview'&&req.method==='POST')return send(res,200,await frames.preview(parts[2],await body(req)));
        if(parts[3]==='sample-art'&&req.method==='GET')return send(res,200,frames.sampleArt(url.searchParams.get('layout')||'creature',url.searchParams.get('exclude')||'',url.searchParams.get('art_set')||''));
        if(parts[3]==='generate'&&req.method==='POST')return send(res,202,frames.generate(parts[2],await body(req)));
        if(parts[3]==='activate'&&req.method==='POST'){frames.activate(parts[2]);return send(res,200,{ok:true});}
        if(req.method==='GET')return send(res,200,frames.detail(parts[2]));
      }
      if(parts[0]==='frame-assets'&&parts.length===3&&req.method==='GET'){
        const version=store.get("SELECT * FROM frame_versions WHERE id=? AND status='ready'",parts[1]);if(!version)throw new HttpError(404,'Frame preview not found.');
        if(version.id==='included-v1')await frames.ensureIncludedPreviews();
        const variant=/^(?:colour-matrix\.jpg|colour-(?:W|U|B|R|G|C|M|WU|UB|BR|RG|GW|WB|UR|BG|RW|GU)-(?:normal|legendary)\.jpg|[a-z_]+\.(?:W|U|B|R|G|C|M|WU|UB|BR|RG|GW|WB|UR|BG|RW|GU)\.(?:normal|legendary)\.(?:plain|alias)\.png)$/.test(parts[2]);
        if(/^(adventure|prepare|saga)(\.frame)?\.png$/.test(parts[2])&&!fs.existsSync(path.join(version.directory,'previews',parts[2])))await frames.ensureVariant(version,parts[2]);
        if(variant)await frames.ensureVariant(version,parts[2]);
        if(!variant&&!/^real-art-(?:proofs|\d)\.jpg$/.test(parts[2])&&!['contact-sheet.jpg',...FRAME_LAYOUTS.flatMap(k=>[k+'.png',k+'.frame.png'])].includes(parts[2]))throw new HttpError(404,'Unknown frame preview.');
        const filename=path.join(version.directory,'previews',parts[2]);if(!inside(version.directory,filename))throw new HttpError(403,'Invalid frame preview path.');return file(res,filename);
      }
      if(parts[0]==='api' && parts[1]==='decks'){
        const deckId=parts[2],action=parts[3];
        if(!deckId && req.method==='GET')return send(res,200,store.listDecks());
        if(!deckId && req.method==='POST'){
          const data=await body(req),cards=parsed(data.decklist || '');if(data.style_revision_id)artStyles.revision(data.style_revision_id);if(data.guidelines_mode&&!['custom','structured'].includes(data.guidelines_mode))throw new HttpError(400,'Invalid guideline mode.');data.frame_set_id=data.frame_set_id||frames.defaultId();frames.snapshot(data.frame_set_id);const deck=store.createDeck(data,cards);
          const jobs=data.generate ? queue.enqueue(deck.id,{mode:'missing',include_history:data.include_history,use_reference_images:data.use_reference_images,isolate_generation:data.isolate_generation}) : [];
          notify();return send(res,201,{...store.deck(deck.id),queued:jobs.length});
        }
        const deck=getDeck(deckId);
        if(action==='art-sets'){
          if(!parts[4]&&req.method==='GET')return send(res,200,{sets:store.artSets.list(deckId),busy:store.artSets.busyReason(deckId)});
          if(!parts[4]&&req.method==='POST'){const set=store.artSets.create(deckId,await body(req));notify();return send(res,201,set);}
          if(parts[4]&&parts[5]==='activate'&&req.method==='POST'){await body(req);store.artSets.activate(deckId,parts[4]);notify();return send(res,200,store.deck(deckId));}
          if(parts[4]&&!parts[5]&&req.method==='PATCH'){const set=store.artSets.rename(deckId,parts[4],(await body(req)).name);notify();return send(res,200,set);}
        }
        if(action==='clear-automatic-artwork'&&req.method==='POST'){const result=store.clearAutomaticArtwork(deckId);notify();return send(res,200,result);}
        if(action==='guidelines'&&req.method==='GET')return send(res,200,artStyles.deckGuidelines(deckId));
        if(action==='guidelines'&&req.method==='PATCH')return send(res,200,artStyles.updateDeck(deckId,await body(req)));
        if(action==='populate-mtg-art'&&req.method==='POST')return send(res,202,official.populate(deckId,await body(req)));
        if(action==='swap-mtg-art'&&req.method==='POST')return send(res,202,official.swap(deckId,await body(req)));
        if(action==='frame-preview'&&req.method==='GET'){
          const frameSetId=url.searchParams.get('frame_set_id')||deck.frame_set_id;
          if(!parts[4])return send(res,200,framePreview.list(deck,frameSetId,url.searchParams.get('preview_session')||'',url.searchParams.get('preview_generation')||0));
          try{return file(res,await framePreview.image(deck,frameSetId,parts[4],{session:url.searchParams.get('preview_session')||'',expectedKey:url.searchParams.get('preview_key')}));}catch(e){throw e instanceof HttpError?e:new HttpError(400,e.message);}
        }
        if(action==='reframe'&&req.method==='POST'){
          const data=await body(req),selection=Array.isArray(data.card_ids)?data.card_ids:null;
          if(selection&&selection.some(cardId=>!deck.cards.some(c=>c.id===cardId)))throw new HttpError(400,'A selected card does not belong to this deck.');
          const jobs=[];for(const card of deck.cards.filter(c=>c.art_mode!=='official'&&c.active_version_id&&(!selection||selection.includes(c.id))))jobs.push(...queue.enqueue(deckId,{card_ids:[card.id],mode:'selected',type:'compose',instructions:'Apply the deck’s selected frame template set using existing artwork.'}));
          return send(res,202,{jobs,queued:jobs.length});
        }
        if(action==='variants' && req.method==='POST'){
          const data=await body(req),result=store.createVariants(deckId,data);
          const missing=result.ids.filter(cardId=>!store.get('SELECT active_version_id FROM cards WHERE id=?',cardId).active_version_id);
          const jobs=data.generate&&missing.length?queue.enqueue(deckId,{card_ids:missing,mode:'selected',include_history:data.include_history,use_reference_images:data.use_reference_images,isolate_generation:data.isolate_generation}):[];
          notify();return send(res,201,{...result,queued:jobs.length});
        }
        if(action==='cancel-generation' && req.method==='POST'){await body(req);return send(res,200,queue.cancelDeck(deckId));}
        if(action==='resolve' && req.method==='POST'){const data=await body(req);return send(res,200,await metadata.resolve(deckId,data.force===true));}
        if(['print-preview','print.pdf','print-history'].includes(action) && req.method==='POST'){
          const settings=await body(req),resolved=printEntries(store,deck,settings);
          if(action==='print-preview')return send(res,200,await printPreview(settings,resolved));
          if(action==='print-history')return send(res,200,await printHistoryResponse(settings,resolved,resolved.title+' — '+deck.art_set.name,values=>printEntries(store,deck,values)));
          return await printPDF(res,settings,resolved,resolved.title+' — '+deck.art_set.name);
        }
        if(!action && req.method==='GET')return send(res,200,deck);
        if(!action && req.method==='PATCH'){const data=await body(req);if(data.frame_set_id!==undefined)frames.snapshot(data.frame_set_id);const result=store.updateDeck(deckId,data);notify();return send(res,200,result);}
        if(action==='duplicate' && req.method==='POST'){const result=store.duplicate(deckId);artStyles.copyDeckReferences(deckId,result.id);notify();return send(res,201,result);}
        if(action==='cards' && req.method==='POST'){
          const data=await body(req),cards=data.decklist!=null?parsed(data.decklist):[data];
          const result=store.transaction(()=>store.importCards(deckId,cards,{deduplicate:data.deduplicate!==false}));
          notify();return send(res,201,result);
        }
        if(action==='replace-cards' && req.method==='POST'){
          const data=await body(req),cards=parsed(data.decklist??''),options={keepTokens:data.keep_tokens!==false};
          if(!data.apply)return send(res,200,store.planReplacement(deckId,cards,options));
          if(deck.archived)throw new HttpError(400,'Restore this deck before replacing its card list.');
          const busy=store.planReplacement(deckId,cards,options).removed.filter(c=>queue.isCardActive(c.id));
          if(busy.length)throw new HttpError(409,`Wait for ${busy.map(c=>c.name).join(', ')} to stop generating before removing ${busy.length===1?'it':'them'}.`);
          const result=store.replaceCards(deckId,cards,options);notify();return send(res,200,result);
        }
        if(action==='generate' && req.method==='POST'){const jobs=queue.enqueue(deckId,await body(req));return send(res,202,{jobs,queued:jobs.length});}
        if(action==='decklist.txt' && req.method==='GET'){
          res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Content-Disposition':'attachment; filename="decklist.txt"'});return res.end(exportDecklist(deck.cards));
        }
        if(action==='export.zip' && req.method==='GET'){
          const originals=deck.cards.filter(c=>c.active_version_id).map(c=>store.get('SELECT * FROM versions WHERE id=?',c.active_version_id));
          const versions=await Promise.all(originals.map(version=>borders.version(version)));
          for(const version of versions)if(!inside(root,version.image_path) && !inside(store.directory,version.image_path))throw new HttpError(400,'An image is outside the project library.');
          const directory=path.join(store.directory,'exports');fs.mkdirSync(directory,{recursive:true});const exportId=id();
          const input=path.join(directory,exportId+'.json'),output=path.join(directory,exportId+'.zip');
          fs.writeFileSync(input,JSON.stringify({deck,decklist:exportDecklist(deck.cards),versions}));
          await run(options.runner?.python || process.env.CARDFORGE_PYTHON || 'python3',[path.join(root,'studio/export_deck.py'),input,output],{timeout:120000});
          return file(res,output,deck.name+'-'+deck.art_set.name+'.zip');
        }
      }
      if(parts[0]==='api' && parts[1]==='cards' && parts[2]){
        const card=getCard(parts[2]);
        if(parts[3]==='official-printings'&&req.method==='GET')return send(res,200,await official.catalog(card.id,{page:url.searchParams.get('page')||1,unique:url.searchParams.get('unique')||'prints',language:url.searchParams.get('language')||'en',prefer:url.searchParams.get('prefer')||'',treatment:url.searchParams.get('treatment')||'any'}));
        if(parts[3]==='reconstruct'&&req.method==='POST')return send(res,201,await reconstruction.create(card.id,await body(req,45*1024*1024)));
        if(parts[3]==='official-printing'&&req.method==='POST'){const data=await body(req);return send(res,201,await official.select(card.id,data.printing_id,{quality:data.quality}));}
        if(parts[3]==='retry-official-import'&&req.method==='POST'){await body(req);return send(res,200,official.retryImport(card.id));}
        if(parts[3]==='cancel-mtg-art-swap'&&req.method==='POST'){await body(req);return send(res,200,official.cancelSwap(card.id));}
        if(parts[3]==='use-custom-art'&&req.method==='POST'){await body(req);return send(res,200,official.useCustom(card.id));}
        if(parts[3]==='artwork-sources'&&req.method==='GET')return send(res,200,artworkLibrary.sources(card.id));
        if(parts[3]==='reuse-artwork'&&req.method==='POST')return send(res,201,await artworkLibrary.reuse(card.id,(await body(req)).source_version_id));
        if(parts.length===3 && req.method==='GET')return send(res,200,{...card,token_spec:JSON.parse(card.token_spec),customization:JSON.parse(card.customization),metadata:JSON.parse(card.metadata),roles:JSON.parse(card.roles),versions:store.versions(card.id),active_art_set_id:store.deck(card.deck_id).active_art_set_id,jobs:store.jobs(card.deck_id).filter(j=>j.card_id===card.id&&(!j.art_set_id||j.art_set_id===store.deck(card.deck_id).active_art_set_id))});
        if(parts[3]==='customize' && req.method==='POST'){
          const data=await body(req);
          if(data.apply){
            if(!card.active_version_id)throw new HttpError(400,'Generate this card before applying appearance changes.');
            if(store.get("SELECT id FROM jobs WHERE card_id=? AND status IN ('queued','running')",card.id))throw new HttpError(409,'Wait for this card’s current job to finish, or save the controls for a later version.');
            if(getDeck(card.deck_id).archived)throw new HttpError(400,'Restore this deck before creating a new version.');
          }
          store.updateCard(card.id,{customization:data.customization});
          const jobs=data.apply?queue.enqueue(card.deck_id,{card_ids:[card.id],mode:'selected',type:'compose',instructions:'Apply saved appearance controls using current artwork.'}):[];
          notify();return send(res,200,{ok:true,queued:jobs.length,jobs});
        }
        if(parts.length===3 && req.method==='PATCH'){store.updateCard(card.id,await body(req));notify();return send(res,200,{ok:true});}
        if(parts.length===3 && req.method==='DELETE'){
          if(queue.isCardActive(card.id))throw new HttpError(409,'Wait for this card’s cancelled process to stop before removing it.');
          store.removeCard(card.id);notify();return send(res,200,{ok:true});
        }
        if(parts[3]==='swap' && req.method==='POST'){
          const data=await body(req);if(getDeck(card.deck_id).archived)throw new HttpError(400,'Restore this deck before swapping cards.');
          const result=store.swapCard(card.id,data);
          const jobs=data.generate&&!result.has_art?queue.enqueue(card.deck_id,{card_ids:[result.id],mode:'selected',include_history:data.include_history===true,use_reference_images:data.use_reference_images!==false,isolate_generation:data.isolate_generation!==false}):[];
          notify();return send(res,200,{...result,queued:jobs.length});
        }
        if(parts[3]==='revise' && req.method==='POST'){
          const data=await body(req);const jobs=queue.enqueue(card.deck_id,{card_ids:[card.id],mode:'selected',type:'revise',instructions:data.instructions,include_history:data.include_history,use_reference_images:data.use_reference_images,isolate_generation:data.isolate_generation});return send(res,202,{jobs,queued:jobs.length});
        }
      }
      if(parts[0]==='api' && parts[1]==='versions' && parts[2] && parts[3]==='activate' && req.method==='POST'){
        const version=store.get('SELECT * FROM versions WHERE id=?',parts[2]);if(!version)throw new HttpError(404,'Version not found.');
        if(version.source_type==='official')official.writable(version.card_id);
        store.activate(version.card_id,version.id);notify();return send(res,200,{ok:true});
      }
      if(parts[0]==='api' && parts[1]==='jobs'){
        if(!parts[2] && req.method==='GET')return send(res,200,store.jobs(url.searchParams.get('deck') || undefined));
        const job=store.get('SELECT * FROM jobs WHERE id=?',parts[2]);if(!job)throw new HttpError(404,'Job not found.');
        if(parts[3]==='events' && req.method==='GET')return send(res,200,store.events(job.id,Math.max(0,Number(url.searchParams.get('after')) || 0)));
        if(parts[3]==='cancel' && req.method==='POST'){queue.cancel(job.id);return send(res,200,{ok:true});}
        if(!parts[3]&&req.method==='GET'){let saved={};try{saved=JSON.parse(fs.readFileSync(path.join(job.directory,'request.json'),'utf8'));}catch{}return send(res,200,{...job,generation_options:{include_history:saved.include_history!==false,use_reference_images:saved.use_reference_images!==false,isolate_generation:saved.isolate_generation===true}});}
        if(parts[3]==='retry' && req.method==='POST')return send(res,202,{jobs:queue.retry(job.id,await body(req))});
      }
      if(parts[0]==='official-printing-images'&&parts.length===4&&req.method==='GET')return file(res,await official.image(parts[1],parts[2],parts[3]),url.searchParams.has('download')?`scryfall-${parts[1]}-${parts[2]}.${parts[3]==='png'?'png':'jpg'}`:undefined);
      if(parts[0]==='assets' && parts.length===3 && req.method==='GET'){
        const version=store.get('SELECT * FROM versions WHERE id=?',parts[1]);if(!version)throw new HttpError(404,'Card version not found.');
        const field={image:'image_path',thumb:'image_path',frame:'frame_path',report:'report_path'}[parts[2]];
        const back=JSON.parse(version.faces_json||'[]').find(f=>f.label==='back');
        let filename=field?version[field]:['back-image','back-thumb'].includes(parts[2])?back?.image_path:parts[2]==='back-frame'?back?.frame_path:null;
        if(!filename || !fs.existsSync(filename))throw new HttpError(404,'Artifact not found.');
        if(!inside(root,filename) && !inside(store.directory,filename))throw new HttpError(403,'Artifact is outside the library.');
        const originalName=path.basename(filename);if(['image','frame','back-image','back-frame','thumb','back-thumb'].includes(parts[2]))filename=await borders.image(version,{back:parts[2].startsWith('back-'),frame:parts[2].endsWith('frame'),thumbnail:parts[2].endsWith('thumb')});
        return file(res,filename,url.searchParams.has('download') ? originalName : undefined);
      }
      if(req.method==='GET' && ['/','/app.js','/official-printings.js','/print-studio.js','/analysis.js','/scenes.js','/frame-editor.js','/style-studio.js','/chat.js','/chat.css','/style.css'].includes(url.pathname))return file(res,path.join(root,'studio/public',url.pathname==='/'?'index.html':url.pathname.slice(1)));
      throw new HttpError(404,'Not found.');
    } catch(e){if(!res.headersSent)send(res,e.status || 400,{error:e.message || 'Request failed.',...(e.details?{details:e.details}:{})});else res.end();}
  });
  return {server,store,queue,quality,frames,artStyles,chat,async listen(port=Number(process.env.PORT || 4317)){
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});store.recoverRunning();frames.recoverRunning();artStyles.recoverRunning();chat.recover();official.schedule();queue.schedule();frames.schedule();artStyles.schedule();return `http://127.0.0.1:${(server.address()?.port || 4317)}`;
  },async close(){await quality.close();await official.close();for(const client of clients)client.end();clients.clear();queue.close();frames.close();artStyles.close();chat.close();while(queue.active||frames.active||artStyles.active||chat.active.size)await new Promise(r=>setTimeout(r,20));await new Promise(resolve=>{const timeout=setTimeout(()=>{server.closeAllConnections();resolve();},5000);server.close(()=>{clearTimeout(timeout);resolve();});server.closeIdleConnections?.();});server.closeAllConnections();store.close();}};
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const app=createStudio();
  try {const url=await app.listen();console.log(`\n  Card Studio\n  ${url}\n\n  Decks and job history: ${app.store.directory}\n  Press Ctrl+C to stop.\n`);}
  catch(e){console.error(`Cannot start Studio: ${e.message}`);process.exitCode=1;app.store.close();}
  let stopping=false;for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(stopping)return;stopping=true;await app.close();process.exit(0);});
}
