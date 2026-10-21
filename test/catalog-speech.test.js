import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { SPEECH_INSTRUCTIONS, speechBody, speechHash } from '../src/lib/catalogSpeech.js';

const b64 = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
const mp3 = new Uint8Array([0xff,0xfb,0x90,0,...new Array(124).fill(0)]); // signature fixture, not claimed playable/QA-approved
async function harness(options = {}) {
  const bindings = { ADMIN_ACCESS_ISSUER:'https://speech-test.cloudflareaccess.com', ADMIN_ACCESS_AUD:'speech-test', ADMIN_EMAILS:'admin@example.test', OPENAI_API_KEY:'test-secret-never-return', ...options.bindings };
  const pair = await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
  const jwk = {...await crypto.subtle.exportKey('jwk',pair.publicKey),kid:'speech-test',alg:'RS256'};
  const now = Math.floor(Date.now()/1000), message = `${b64({alg:'RS256',kid:jwk.kid})}.${b64({iss:bindings.ADMIN_ACCESS_ISSUER,aud:[bindings.ADMIN_ACCESS_AUD],email:bindings.ADMIN_EMAILS,iat:now,exp:now+600})}`;
  const jwt = `${message}.${Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,new TextEncoder().encode(message))).toString('base64url')}`;
  const bundle = await build({entryPoints:['src/index.js'],bundle:true,write:false,format:'esm',platform:'browser'});
  const calls = [];
  const mf = new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-09-04',bindings,d1Databases:['COMMUNITY_DB','LOGS_DB'],r2Buckets:['DECK_ASSETS'],outboundService:async request=>{
    if (request.url.endsWith('/cdn-cgi/access/certs')) return Response.json({keys:[jwk]});
    assert.equal(request.url,'https://api.openai.com/v1/audio/speech');
    const call = { body:await request.json(), authorization:request.headers.get('Authorization') }; calls.push(call);
    return options.upstream ? options.upstream(call) : new Response(mp3,{headers:{'Content-Type':'audio/mpeg','x-request-id':'req_test'}});
  }}));
  const db = await mf.getD1Database('COMMUNITY_DB'), logs = await mf.getD1Database('LOGS_DB');
  for (const file of (await readdir(new URL('../community-migrations/',import.meta.url))).sort()) {
    const sql = await readFile(new URL(`../community-migrations/${file}`,import.meta.url),'utf8'), triggers = sql.match(/CREATE TRIGGER[\s\S]*?END;/g)||[];
    for (const statement of sql.replace(/CREATE TRIGGER[\s\S]*?END;/g,'').split(';').map(s=>s.trim()).filter(Boolean)) await db.prepare(statement).run();
    for (const trigger of triggers) await db.prepare(trigger).run();
  }
  await logs.exec((await readFile(new URL('../migrations/0003_ai_limits.sql',import.meta.url),'utf8')).replace(/\n/g,' '));
  for (const id of ['spanish','korean']) await db.prepare("INSERT INTO managed_catalog(id,kind,title,draft_key,created_at,updated_at,updated_by) VALUES(?,'course',?,'existing-draft',1,1,'owner')").bind(id,id).run();
  const admin = (path,method='GET',body,headers={}) => mf.dispatchFetch(`https://api.example.test/v1/admin/catalog/${path}`,{method,headers:{'Cf-Access-Jwt-Assertion':jwt,Origin:'https://learnalertapp.com','Content-Type':'application/json',...headers},body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body)});
  const budget = (id='pilot',overrides={})=>admin('spanish/speech/budgets','POST',{id,maxRequests:3,reservationBudgetUsd:0.5,reservationPerRequestUsd:0.1,acknowledgeEstimatedCost:true,...overrides});
  const generate = (input='Hola.',budgetId='pilot')=>admin('spanish/speech','POST',{input,budgetId});
  return {mf,db,logs,admin,budget,generate,calls,bucket:await mf.getR2Bucket('DECK_ASSETS')};
}

test('speech request preserves exact approved settings, Unicode and stable canonical hash',async()=>{
  const body=speechBody('¡Hola! ¿Cómo estás?',{});
  assert.deepEqual(body,{model:'gpt-4o-mini-tts',voice:'cedar',instructions:SPEECH_INSTRUCTIONS,response_format:'mp3',speed:1,input:'¡Hola! ¿Cómo estás?'});
  assert.equal(await speechHash(body),'f99a87816d424cb2079daf5303adb591d63ab3a87f382e442b45e03d7cc8492a');
  assert.equal(await speechHash(body),await speechHash({...body}));
  assert.notEqual(await speechHash(body),await speechHash({...body,input:'¡Hola! ¿Cómo estás? '}));
  assert.equal(speechBody('Hola',{TTS_MODEL:'gpt-4o-mini-tts-custom'}).model,'gpt-4o-mini-tts-custom');
  for (const input of ['', ' '.repeat(5), 'x'.repeat(1001), '界'.repeat(601), null]) assert.throws(()=>speechBody(input,{}));
});

test('speech requires signed existing admin and same origin; status only exposes binding presence',async()=>{
  const h=await harness();try{
    for (const headers of [{'Cf-Access-Jwt-Assertion':''},{'Cf-Access-Jwt-Assertion':'forged.jwt.value'},{Origin:'https://evil.example'}]) {
      const res=await h.admin('spanish/speech','POST',{input:'Hola.',budgetId:'pilot'},headers);
      assert.ok([401,403].includes(res.status));assert.equal(res.headers.get('Access-Control-Allow-Origin'),null);
    }
    const status=await (await h.admin('speech/status')).json();assert.equal(status.configured,true);assert.equal(status.model,'gpt-4o-mini-tts');assert.equal(status.requiresBudget,true);assert.ok(!JSON.stringify(status).includes('test-secret'));
    assert.equal(h.calls.length,0);
  }finally{await h.mf.dispose();}
});

test('speech fails closed without allowance/key and rejects overrides, malformed JSON and excessive text',async()=>{
  const h=await harness();try{
    assert.equal((await h.generate()).status,409);
    assert.equal((await h.admin('spanish/speech','POST','{bad')).status,400);
    assert.equal((await h.admin('spanish/speech','POST',{input:'Hola',budgetId:'pilot',model:'cheap'})).status,400);
    assert.equal((await h.generate('x'.repeat(1001))).status,400);
    assert.equal((await h.budget('bad',{reservationBudgetUsd:0})).status,400);
    assert.equal((await h.budget('bad',{acknowledgeEstimatedCost:false})).status,400);
    assert.equal((await h.budget()).status,201);assert.equal((await h.budget()).status,200);
    assert.equal((await h.budget('pilot',{maxRequests:4})).status,409);
    assert.equal(h.calls.length,0);
  }finally{await h.mf.dispose();}
  const missing=await harness({bindings:{OPENAI_API_KEY:''}});try{await missing.budget();assert.equal((await missing.generate()).status,503);assert.equal(missing.calls.length,0);}finally{await missing.mf.dispose();}
});

test('speech generation caches paid calls, owns private catalog media and leaves publication unchanged',async()=>{
  const h=await harness();try{
    await h.budget();const first=await h.generate(' ¡Hola! ');assert.equal(first.status,201,await first.clone().text());
    const result=await first.json();assert.equal(result.cached,false);assert.equal(result.qaStatus,'pending');assert.equal(result.published,false);assert.equal(result.actualCostUsd,null);
    assert.equal(h.calls[0].authorization,'Bearer test-secret-never-return');assert.deepEqual(h.calls[0].body,speechBody(' ¡Hola! ',{}));
    assert.equal((await h.admin(`media/${result.id}`)).status,200);
    assert.equal((await h.mf.dispatchFetch(`https://api.example.test/v1/catalog/media/${result.id}`)).status,404);
    const cached=await (await h.generate(' ¡Hola! ')).json();assert.equal(cached.id,result.id);assert.equal(cached.cached,true);assert.equal(h.calls.length,1);
    const other=await (await h.admin('korean/speech','POST',{input:' ¡Hola! '})).json();assert.notEqual(other.id,result.id);assert.equal(other.cached,true);assert.equal(h.calls.length,1);
    const rows=(await h.db.prepare('SELECT catalog_id FROM managed_catalog_media ORDER BY catalog_id').all()).results;assert.deepEqual(rows.map(x=>x.catalog_id),['korean','spanish']);
    assert.equal((await h.db.prepare("SELECT revision FROM managed_catalog WHERE id='spanish'").first()).revision,1);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM managed_catalog_public_media').first()).n,0);
    const budget=(await (await h.admin('spanish/speech/budgets')).json()).items[0];assert.equal(budget.requests,1);assert.equal(budget.reservedUsd,0.1);
    const status=await (await h.admin(`spanish/speech/${result.requestHash}`)).json();assert.equal(status.state,'ready');assert.equal(status.providerRequestId,'req_test');
  }finally{await h.mf.dispose();}
});

test('speech enforces both immutable run request and reservation caps; existing AI quotas remain active',async()=>{
  const h=await harness();try{
    await h.budget('pilot',{reservationBudgetUsd:0.1});assert.equal((await h.generate()).status,201);
    assert.equal((await h.generate('Adiós.')).status,429);assert.equal(h.calls.length,1);
    await h.budget('count',{maxRequests:1});assert.equal((await h.generate('Uno.','count')).status,201);assert.equal((await h.generate('Dos.','count')).status,429);
    assert.equal(h.calls.length,2);
  }finally{await h.mf.dispose();}
  const limited=await harness({bindings:{AI_REQUESTS_PER_DAY:'1',AI_LIMITS_DISABLED:'true'}});try{
    await limited.budget();assert.equal((await limited.generate()).status,201);
    const response=await limited.generate('Dos.');assert.equal(response.status,429);assert.ok(response.headers.get('Retry-After'));assert.equal(response.headers.get('Access-Control-Allow-Origin'),null);assert.equal(limited.calls.length,1);
  }finally{await limited.mf.dispose();}
});

test('concurrent same and different requests have one global producer and one reservation',async()=>{
  let release,started;const start=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);
  const h=await harness({upstream:async()=>{started();await gate;return new Response(mp3,{headers:{'Content-Type':'audio/mpeg'}});}});try{
    await h.budget();const pending=h.generate();await Promise.race([start,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Mock provider never started')),5000);timer.unref();})]);
    const duplicate=await h.generate();assert.equal(duplicate.status,409);assert.equal((await duplicate.json()).error.code,'TTS_IN_PROGRESS');
    const different=await h.generate('Adiós.');assert.equal(different.status,409);assert.equal((await different.json()).error.code,'TTS_BUSY');
    release();assert.equal((await pending).status,201);assert.equal(h.calls.length,1);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM catalog_speech_jobs').first()).n,1);
  }finally{release();await h.mf.dispose();}
});

test('provider rejection and uncertain/malformed output never retry or return upstream data',async()=>{
  const h=await harness({upstream:()=>Response.json({error:{message:'test-secret-never-return'}},{status:403})});try{
    await h.budget();const rejected=await h.generate();assert.equal(rejected.status,502);assert.ok(!(await rejected.text()).includes('test-secret'));
    assert.equal((await h.generate()).status,409);assert.equal(h.calls.length,1);
    const row=await h.db.prepare('SELECT * FROM catalog_speech_jobs').first();assert.equal(row.state,'failed');assert.equal(row.reservation_microusd,100000);
  }finally{await h.mf.dispose();}
  const uncertain=await harness({upstream:()=>new Response('not audio',{headers:{'Content-Type':'audio/mpeg'}})});try{
    await uncertain.budget();assert.equal((await uncertain.generate()).status,503);assert.equal((await uncertain.generate()).status,409);
    assert.equal((await uncertain.generate('Another')).status,409);assert.equal(uncertain.calls.length,1);
    assert.equal((await uncertain.db.prepare('SELECT state FROM catalog_speech_jobs').first()).state,'uncertain');
  }finally{await uncertain.mf.dispose();}
});

test('missing or corrupt cached bytes block regeneration and preserve durable provenance',async()=>{
  const h=await harness();try{
    await h.budget();const result=await (await h.generate()).json();
    const media=await h.db.prepare('SELECT object_key FROM managed_catalog_media WHERE id=?').bind(result.id).first();
    await h.bucket.put(media.object_key,'corrupted');assert.equal((await h.generate()).status,503);assert.equal(h.calls.length,1);
    await h.bucket.delete(media.object_key);assert.equal((await h.generate()).status,503);assert.equal(h.calls.length,1);
  }finally{await h.mf.dispose();}
});

test('paid bytes survive a final database failure; uncertain jobs never expire into retries',async()=>{
  const h=await harness();try{
    await h.budget();
    await h.db.prepare("CREATE TRIGGER mock_finalize_failure BEFORE UPDATE ON catalog_speech_jobs WHEN NEW.state='ready' BEGIN SELECT RAISE(FAIL,'simulated finalization failure'); END;").run();
    const response=await h.generate();assert.equal(response.status,503);assert.equal((await response.json()).error.code,'TTS_OUTCOME_UNCERTAIN');
    const row=await h.db.prepare('SELECT * FROM catalog_speech_jobs').first();assert.equal(row.state,'uncertain');assert.equal(row.reservation_microusd,100000);
    const saved=await h.bucket.get(`catalog/speech/${row.request_hash}.mp3`);assert.ok(saved);assert.equal((await saved.arrayBuffer()).byteLength,mp3.length);
    await h.db.prepare('UPDATE catalog_speech_jobs SET created_at=1,updated_at=1').run();
    assert.equal((await h.generate()).status,409);assert.equal((await h.generate('Adiós.')).status,409);assert.equal(h.calls.length,1);
  }finally{await h.mf.dispose();}
});

test('upstream redirects never forward credentials and no model fallback is attempted',async()=>{
  const h=await harness({upstream:()=>new Response(null,{status:302,headers:{Location:'https://untrusted.example/speech'}})});try{
    await h.budget();assert.equal((await h.generate()).status,502);assert.equal(h.calls.length,1);assert.equal(h.calls[0].body.model,'gpt-4o-mini-tts');
  }finally{await h.mf.dispose();}
});

test('emergency disable and missing existing quota schema fail before upstream work',async()=>{
  const h=await harness({bindings:{TTS_DISABLED:'true'}});try{
    await h.budget();assert.equal((await h.generate()).status,503);assert.equal(h.calls.length,0);
  }finally{await h.mf.dispose();}
  const missing=await harness();try{
    await missing.budget();await missing.logs.prepare('DROP TABLE ai_request_limits').run();
    assert.equal((await missing.generate()).status,503);assert.equal(missing.calls.length,0);
  }finally{await missing.mf.dispose();}
});

test('published cache reports its true status and archived jobs remain inspectable',async()=>{
  const h=await harness();try{
    await h.budget();const first=await (await h.generate()).json();
    await h.db.prepare("UPDATE managed_catalog SET status='published',published_key='existing-publication' WHERE id='spanish'").run();
    await h.db.prepare("INSERT INTO managed_catalog_public_media(catalog_id,media_id) VALUES('spanish',?)").bind(first.id).run();
    const reused=await (await h.generate()).json();assert.equal(reused.published,true);assert.equal(reused.publicationChanged,false);assert.equal(reused.id,first.id);assert.equal(h.calls.length,1);
    await h.db.prepare("UPDATE managed_catalog SET status='archived' WHERE id='spanish'").run();
    assert.equal((await h.admin(`spanish/speech/${first.requestHash}`)).status,200);
    assert.equal((await h.admin('spanish/speech/budgets')).status,200);
    assert.equal((await h.generate()).status,409);assert.equal((await h.budget('new')).status,409);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM managed_catalog_public_media').first()).n,1);
    assert.equal(h.calls.length,1);
  }finally{await h.mf.dispose();}
});

test('speech readiness does not shadow a catalog item named speech',async()=>{
  const h=await harness();try{
    await h.db.prepare("INSERT INTO managed_catalog(id,kind,title,draft_key,created_at,updated_at,updated_by) VALUES('speech','course','Speech','speech-draft',1,1,'owner')").run();
    await h.bucket.put('speech-draft',JSON.stringify({id:'speech'}));
    const response=await h.admin('speech');assert.equal(response.status,200);assert.equal((await response.json()).item.id,'speech');
    const readiness=await h.admin('speech/status');assert.equal(readiness.status,200);assert.equal((await readiness.json()).requiresBudget,true);
  }finally{await h.mf.dispose();}
});


test('speech studio stays behind existing admin auth and carries nonce CSP through the proxy',async()=>{
  const h=await harness();try{
    const unauthenticated=await h.admin('speech/studio','GET',undefined,{'Cf-Access-Jwt-Assertion':''});
    assert.ok([401,403].includes(unauthenticated.status));assert.ok(!(await unauthenticated.text()).includes('<html'));
    const response=await h.admin('speech/studio');assert.equal(response.status,200);
    assert.match(response.headers.get('Content-Type'),/^text\/html/);assert.equal(response.headers.get('Cache-Control'),'no-store');
    assert.equal(response.headers.get('Access-Control-Allow-Origin'),null);
    const html=await response.text(),nonce=html.match(/<script nonce="([a-f0-9]+)">/)?.[1];assert.ok(nonce);
    assert.ok(response.headers.get('Content-Security-Policy').includes("script-src 'nonce-"+nonce+"'"));
    assert.ok(response.headers.get('Content-Security-Policy').includes("frame-ancestors 'none'"));
    assert.match(html,/<meta http-equiv="Content-Security-Policy"/);
    assert.match(html,/window\.top !== window\.self/);assert.match(html,/<main id="studio-controls" hidden>/);
    assert.ok(!/<script[^>]+src=/.test(html));assert.ok(!html.includes('test-secret-never-return'));
    assert.equal((await h.admin('speech/studio','POST',{}, {Origin:'https://evil.example'})).status,403);
    assert.equal(h.calls.length,0);
  }finally{await h.mf.dispose();}
});

test('cache-only recovery cannot generate and job status returns only the selected catalog media',async()=>{
  const h=await harness();try{
    const missing=await h.admin('spanish/speech','POST',{input:'Hola.',cacheOnly:true});
    assert.equal(missing.status,404);assert.equal((await missing.json()).error.code,'TTS_CACHE_MISS');
    for(const cacheOnly of ['true',1,null]) assert.equal((await h.admin('spanish/speech','POST',{input:'Hola.',cacheOnly})).status,400);
    assert.equal(h.calls.length,0);
    assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM catalog_speech_jobs').first()).n,0);
    await h.budget();const generated=await (await h.generate()).json();
    const source=await (await h.admin('spanish/speech/'+generated.requestHash)).json();
    assert.equal(source.budgetId,'pilot');assert.equal(source.media.id,generated.id);
    const foreign=await (await h.admin('korean/speech/'+generated.requestHash)).json();assert.equal(foreign.media,null);
    const reused=await (await h.admin('korean/speech','POST',{input:'Hola.',cacheOnly:true})).json();
    assert.equal(reused.cached,true);assert.notEqual(reused.id,generated.id);
    const owned=await (await h.admin('korean/speech/'+generated.requestHash)).json();assert.equal(owned.media.id,reused.id);
    assert.equal(h.calls.length,1);
  }finally{await h.mf.dispose();}
});
