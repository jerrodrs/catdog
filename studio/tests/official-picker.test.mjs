import test from 'node:test';
import assert from 'node:assert/strict';
import {OfficialPrintingPicker} from '../public/official-printings.js';

function harness(){
 const elements=new Map(),element=selector=>{if(!elements.has(selector))elements.set(selector,{innerHTML:'',textContent:'',value:'',hidden:false,disabled:false,classList:{toggle(){}},querySelector:element,addEventListener(){}});return elements.get(selector);};
 const root={innerHTML:'',querySelector:element,addEventListener(){},removeEventListener(){},contains:()=>true};
 const calls=[],card={id:'printing',name:'Card',set:'TST',set_name:'Test',collector_number:'1',frame_effects:[],highres_image:true,faces:[{name:'Card',image:'/scan/png',format:'png',preview:'/scan/normal',images:{png:'/scan/png',large:'/scan/large',normal:'/scan/normal'}}]};
 const picker=new OfficialPrintingPicker(root,{cardId:'card',deckId:'deck',toast(){},api:async(url,options)=>{calls.push({url,options});return {cards:[card],page:1,has_more:false,total:1};}});
 return {root,picker,calls,element};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('printing preferences reach Scryfall lookup and maximum-quality download stays available',async()=>{
 const {root,picker,calls,element}=harness();await tick();
 assert.match(root.innerHTML,/Maximum available \(PNG preferred\)/);
 assert.match(root.innerHTML,/Original printing \(oldest\)/);
 picker.change({target:{dataset:{official:'prefer'},value:'oldest'}});await tick();
 const url=new URL(calls.at(-1).url,'http://localhost');
 assert.equal(url.searchParams.get('unique'),'cards');assert.equal(url.searchParams.get('prefer'),'oldest');
 picker.change({target:{dataset:{official:'quality'},value:'normal'}});
 assert.match(element('.official-preview').innerHTML,/src="\/scan\/normal"/);
 assert.match(element('.official-preview').innerHTML,/href="\/scan\/png\?download=1" download/);
 picker.dispose();
});

test('saving a selected scan sends its explicit quality',async t=>{
 const original=globalThis.location;globalThis.location={hash:''};t.after(()=>{if(original===undefined)delete globalThis.location;else globalThis.location=original;});
 const {picker,calls}=harness();await tick();picker.quality='large';await picker.save();
 assert.deepEqual(calls.at(-1).options.body,{printing_id:'printing',quality:'large'});
 assert.equal(globalThis.location.hash,'deck/deck');picker.dispose();
});
