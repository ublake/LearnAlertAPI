import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { speechStudio } from '../src/routes/speechStudio.js';
import { speechBody, speechHash, SPEECH_INSTRUCTIONS } from '../src/lib/catalogSpeech.js';

// Unit-test the actual embedded client with a minimal in-memory DOM. No browser,
// network, credentials, OpenAI request, or live provider is used.
async function client(options = {}) {
  const html=await speechStudio().text(),script=html.match(/<script nonce="[a-f0-9]+">([\s\S]*?)<\/script>/)[1];
  const elements=new Map(),posts=[],storage=options.storage || new Map();
  const ids=[...html.matchAll(/id="([^"]+)"/g)].map(match=>match[1]);
  for(const id of ids)elements.set(id,{id,value:'',checked:false,hidden:['studio-controls','recovery','result','recover-media','download','audio'].includes(id),disabled:false,textContent:'',events:{},children:[],
    addEventListener(type,fn){this.events[type]=fn;},replaceChildren(...children){this.children=children;this.value='';},add(child){this.children.push(child);},
    removeAttribute(key){delete this[key];}});
  const el=id=>elements.get(id),buttons=ids.filter(id=>/button|status|recover-media|clear-recovery|refresh-budgets/.test(id)).map(el);
  const state={budgets:[],job:null,attached:true,...options},pending=[];
  const profile={configured:true,disabled:false,model:'gpt-4o-mini-tts',voice:'cedar',instructions:SPEECH_INSTRUCTIONS,responseFormat:'mp3'};
  const fetch=async(path,opts={})=>{
    assert.ok(path.startsWith('/admin/api/catalog'));
    assert.equal(opts.credentials,'same-origin');assert.equal(opts.redirect,'error');
    const json=body=>Response.json(body);
    if(path.endsWith('/speech/status'))return json({...profile,...state.profile});
    if(path==='/admin/api/catalog')return json({items:[{id:'spanish',title:'Spanish <tag>',status:'draft'}]});
    if(path.endsWith('/speech/budgets')){
      if(opts.method==='POST'){const body=JSON.parse(opts.body);posts.push({path,body});const budget={...body,requests:0,reservedUsd:0};state.budgets.push(budget);return json({budget});}
      return json({items:state.budgets});
    }
    if(path.endsWith('/speech')&&opts.method==='POST'){
      const body=JSON.parse(opts.body);posts.push({path,body});
      const hash=await speechHash(speechBody(body.input,{})),cached=state.job?.state==='ready';
      state.job ||= {requestHash:hash,state:state.uncertain?'uncertain':'ready'};
      if(state.uncertain)return Response.json({error:{message:'Outcome uncertain. Do not retry.'}},{status:503});
      return json({...state.job,id:'00000000-0000-5000-a000-000000000001',cached});
    }
    if(/\/speech\/[a-f0-9]{64}$/.test(path)){
      if(state.expired)return new Response('Sign in',{headers:{'Content-Type':'text/html'}});
      if(!state.job)return Response.json({error:{message:'Not found'}},{status:404});
      return json({...state.job,media:state.attached&&state.job.state==='ready'?{id:'00000000-0000-5000-a000-000000000001'}:null});
    }
    throw Error('Unexpected mock request: '+path);
  };
  const window={};window.self=window;window.top=options.framed?{}:window;
  const context=vm.createContext({document:{getElementById:el,querySelectorAll:()=>buttons},window,location:{origin:'https://learnalertapp.com'},
    sessionStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>{if(state.storageUnavailable)throw Error('Unavailable');storage.set(key,value);},removeItem:key=>storage.delete(key)},
    Option:class{constructor(text,value){this.text=text;this.value=value;}},fetch,crypto,TextEncoder,AbortController,
    setTimeout,clearTimeout,console});
  const settle=async()=>{for(let attempt=0;attempt<1000;attempt++){await new Promise(resolve=>setImmediate(resolve));if(!el('generate-button').disabled)return;}throw Error('Client did not settle');};
  if(options.framed)assert.throws(()=>vm.runInContext(script,context),/Framed speech studio/);
  else {vm.runInContext(script,context);await settle();}
  const act=async(id,type='click')=>{el(id).events[type]({preventDefault(){}});await settle();};
  const choose=async()=>{
    el('catalog').value='spanish';await act('catalog','change');
    el('budget-id').value='approved-pilot';el('budget-usd').value='5';el('max-requests').value='3';el('per-request-usd').value='1';el('cost-ack').checked=true;
    await act('create-budget','submit');
  };
  return {el,state,storage,posts,act,choose};
}

test('embedded studio script sends only explicit bounded actions and exact profile hash',async()=>{
  const h=await client();assert.equal(h.posts.length,0);assert.equal(h.el('budget-usd').value,'');
  assert.equal(h.el('catalog').children[0].text,'Spanish <tag> (spanish)');
  await h.choose();assert.equal(h.posts.length,1);assert.equal(h.posts[0].body.reservationBudgetUsd,5);
  h.el('input').value='¡Hola! ¿Cómo estás?';await h.act('generate-form','submit');
  assert.equal(h.posts.length,2);assert.equal(h.state.job.requestHash,'f99a87816d424cb2079daf5303adb591d63ab3a87f382e442b45e03d7cc8492a');
  assert.equal(h.el('download').href,'/admin/api/catalog/media/00000000-0000-5000-a000-000000000001');
  assert.equal(h.storage.size,0);
});

test('embedded studio preserves uncertain outcome across reload without an automatic POST',async()=>{
  const first=await client({uncertain:true,attached:false});await first.choose();first.el('input').value='Hola.';await first.act('generate-form','submit');
  assert.equal(first.posts.length,2);assert.equal(first.storage.size,1);
  const h=await client({storage:first.storage,job:first.state.job,attached:false});
  assert.equal(h.posts.length,0);assert.match(h.el('message').textContent,/previous request/);
  await h.act('check-status');await h.act('clear-recovery');
  assert.match(h.el('message').textContent,/still in progress or uncertain/);assert.equal(h.storage.size,1);
  h.state.job.state='ready';await h.act('check-status');await h.act('recover-media');
  assert.equal(h.posts.length,1);assert.equal(h.posts[0].body.cacheOnly,true);assert.equal(h.storage.size,0);
});

test('embedded studio blocks recovery after sign-in or full profile changes',async()=>{
  const first=await client({uncertain:true,attached:false});await first.choose();first.el('input').value='Hola.';await first.act('generate-form','submit');
  const h=await client({storage:first.storage,job:{...first.state.job,state:'ready'},attached:false,expired:true,profile:{instructions:'Changed instructions'}});
  await h.act('check-status');assert.match(h.el('message').textContent,/Sign-in may have expired/);assert.equal(h.posts.length,0);
  h.state.expired=false;await h.act('check-status');await h.act('recover-media');
  assert.match(h.el('message').textContent,/profile changed/);assert.equal(h.posts.length,0);
});

test('embedded studio fails closed before generation if recovery storage is unavailable',async()=>{
  const h=await client({storageUnavailable:true});await h.choose();h.el('input').value='Hola.';await h.act('generate-form','submit');
  assert.equal(h.posts.length,1);assert.match(h.el('message').textContent,/recovery storage is unavailable/);
});

test('embedded studio never exposes framed controls or loads data from a frame',async()=>{
  const h=await client({framed:true});assert.equal(h.el('studio-controls').hidden,true);assert.equal(h.posts.length,0);
  assert.match(h.el('message').textContent,/own tab/);assert.equal(Object.keys(h.el('generate-form').events).length,0);
});
