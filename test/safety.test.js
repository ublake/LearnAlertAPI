import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {sha256} from '../src/lib/communityAuth.js';
import {cleanupCommunity} from '../src/routes/community.js';
import {readCommunityJSON} from '../src/lib/communityValidation.js';
import {decryptAppleToken} from '../src/lib/appleLifecycle.js';
const epoch=()=>Math.floor(Date.now()/1000), nonce='a'.repeat(64), b64=v=>Buffer.from(typeof v==='string'?v:JSON.stringify(v)).toString('base64url');
async function setup(apple=false) {
 const rsa=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
 const jwk={...await crypto.subtle.exportKey('jwk',rsa.publicKey),kid:'safety-test',alg:'RS256'};
 const sign=async claims=>{const input=b64({alg:'RS256',kid:jwk.kid})+'.'+b64(claims);return input+'.'+Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',rsa.privateKey,new TextEncoder().encode(input))).toString('base64url');};
 const identity=async sub=>sign({iss:'https://appleid.apple.com',aud:'com.learnalert.app',sub,nonce:await sha256(nonce),iat:epoch(),exp:epoch()+600});
 const env={APPLE_CLIENT_ID:'com.learnalert.app',ADMIN_ACCESS_ISSUER:'https://test.cloudflareaccess.com',ADMIN_ACCESS_AUD:'admin',ADMIN_EMAILS:'owner@example.test'};
 let ec,revocations=0,failRevoke=false;
 if(apple){ec=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);env.APPLE_PRIVATE_KEY='-----BEGIN PRIVATE KEY-----\n'+Buffer.from(await crypto.subtle.exportKey('pkcs8',ec.privateKey)).toString('base64')+'\n-----END PRIVATE KEY-----';env.APPLE_KEY_ID='TESTKEY123';env.APPLE_TEAM_ID='TESTTEAM12';env.APPLE_TOKEN_ENCRYPTION_KEY=Buffer.alloc(32,7).toString('base64');}
 const bundle=await build({entryPoints:['src/index.js'],bundle:true,write:false,format:'esm',platform:'browser'});
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-09-04',bindings:env,d1Databases:['COMMUNITY_DB'],r2Buckets:['DECK_ASSETS'],outboundService:async request=>{
  const path=new URL(request.url).pathname;
  if(path.endsWith('/keys')||path.endsWith('/certs'))return new Response(JSON.stringify({keys:[jwk]}));
  if(path==='/auth/token'||path==='/auth/revoke') {
   const form=new URLSearchParams(await request.text()), secret=form.get('client_secret').split('.');
   assert.equal(JSON.parse(Buffer.from(secret[1],'base64url')).iss,env.APPLE_TEAM_ID);
   assert.ok(await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},ec.publicKey,Buffer.from(secret[2],'base64url'),new TextEncoder().encode(secret.slice(0,2).join('.'))));
   if(path==='/auth/revoke'){assert.ok(form.get('token').startsWith('refresh-'));revocations++;return new Response('',{status:failRevoke?503:200});}
   if(form.get('code')==='bad')return new Response('{}',{status:400});
   const subject=form.get('code')==='mismatch'?'another-apple':'apple-'+form.get('code');
   return new Response(JSON.stringify({id_token:await identity(subject),refresh_token:'refresh-'+subject}));
  }
  return new Response('',{status:404});
 }}));
 const db=await mf.getD1Database('COMMUNITY_DB');
 for(const file of (await readdir(new URL('../community-migrations/',import.meta.url))).sort()) {
  const sql=await readFile(new URL('../community-migrations/'+file,import.meta.url),'utf8'),triggers=sql.match(/CREATE TRIGGER[\s\S]*?END;/g)||[];
  for(const statement of sql.replace(/CREATE TRIGGER[\s\S]*?END;/g,'').split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
  for(const trigger of triggers)await db.prepare(trigger).run();
 }
 const request=(path,method='GET',body,token)=>mf.dispatchFetch('https://api.example.test/v1/community/'+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
 const adminJWT=await sign({iss:env.ADMIN_ACCESS_ISSUER,aud:[env.ADMIN_ACCESS_AUD],email:env.ADMIN_EMAILS,iat:epoch(),exp:epoch()+600});
 const admin=(path,method='GET',body)=>mf.dispatchFetch('https://api.example.test/v1/admin/'+path,{method,headers:{'Cf-Access-Jwt-Assertion':adminJWT,Origin:'https://learnalertapp.com','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
 const seed=async id=>{const token=crypto.randomUUID().replaceAll('-','')+'f'.repeat(32);await db.prepare('INSERT INTO community_users(id,handle,created_at) VALUES(?,?,1)').bind(id,'@'+id.replaceAll('-','_')).run();await db.prepare('INSERT INTO community_sessions VALUES(?,?,?)').bind(await sha256(token),id,epoch()+600).run();return {token,authorID:(await db.prepare('SELECT public_id FROM community_users WHERE id=?').bind(id).first()).public_id};};
 return {mf,db,env,sign,identity,request,admin,seed,revocations:()=>revocations,setFail:value=>{failRevoke=value;}};
}
test('viewer blocking covers lists, details, previews and media, while permanent bans survive account deletion',async()=>{
 const h=await setup();const {mf,db,request,admin,seed}=h;
 try {
  const author=await seed('apple_author'),viewer=await seed('viewer'),other=await seed('other');const id=crypto.randomUUID(),media=crypto.randomUUID();
  await db.prepare("INSERT INTO community_decks(id,owner_id,name,category_tag,color_hex,deck_type,status,created_at,updated_at,cards_json,card_count) VALUES(?,'apple_author','Visible','General','#123456','Mixed','published',1,1,?,1)").bind(id,JSON.stringify([{id:'c',question:'Q',correctAnswer:'A',cardType:'tap_reveal',promptImageID:media}])).run();
  await db.prepare("INSERT INTO community_media(id,deck_id,object_key,content_type,byte_size,uploaded,attached,created_at) VALUES(?,?,'safety-media','image/png',3,1,1,1)").bind(media,id).run();await (await mf.getR2Bucket('DECK_ASSETS')).put('safety-media',new Uint8Array([1,2,3]));
  const list=await (await request('decks')).json();assert.equal(list.decks[0].authorID,author.authorID);assert.match(author.authorID,/^[a-f0-9]{32}$/);assert.notEqual(author.authorID,'apple_author');
  assert.equal((await request('account/blocks','POST',{authorID:author.authorID})).status,401);
  assert.equal((await request('account/blocks','POST',{authorID:viewer.authorID},viewer.token)).status,400);
  assert.equal((await request('account/blocks','POST',{authorID:author.authorID},viewer.token)).status,200);
  assert.equal((await request('account/blocks','POST',{authorID:author.authorID},viewer.token)).status,200);
  assert.deepEqual((await (await request('account/blocks','GET',undefined,viewer.token)).json()).users,[{id:author.authorID,handle:'@apple_author'}]);
  assert.equal((await (await request('decks','GET',undefined,viewer.token)).json()).totalCount,0);
  for(const path of ['decks/'+id,'decks/'+id+'/preview','media/'+media]) {const r=await request(path,'GET',undefined,viewer.token);assert.equal(r.status,403);assert.equal((await r.json()).error.code,'AUTHOR_BLOCKED');assert.equal((await request(path)).status,200);assert.equal((await request(path,'GET',undefined,other.token)).status,200);}
  assert.equal((await request('media/'+media,'HEAD',undefined,viewer.token)).status,403);
  assert.equal((await request('decks','GET',undefined,'f'.repeat(64))).status,401);
  assert.equal((await request('account/blocks/'+author.authorID,'DELETE',undefined,other.token)).status,200);assert.equal((await (await request('decks','GET',undefined,viewer.token)).json()).totalCount,0);
  assert.equal((await request('account/blocks/'+author.authorID,'DELETE',undefined,viewer.token)).status,200);assert.equal((await request('decks/'+id,'GET',undefined,viewer.token)).status,200);
  assert.equal((await request('account/blocks','POST',{authorID:author.authorID},viewer.token)).status,200);
  let decision={authorID:author.authorID,action:'suspend',reason:'Abusive upload',until:epoch()+3600,expectedRevision:0};
  assert.equal((await admin('profiles/restrict','POST',{...decision,until:epoch()-1})).status,400);
  assert.equal((await admin('profiles/restrict','POST',decision)).status,200);
  assert.equal((await (await request('decks')).json()).totalCount,0);assert.equal((await request('decks/'+id)).status,404);assert.equal((await request('media/'+media)).status,404);
  let denied=await request('account','GET',undefined,author.token);assert.equal(denied.status,200);assert.equal((await denied.json()).accountStatus,'suspended');assert.equal((await request('decks/drafts','POST',{name:'Blocked'},author.token)).status,403);
  assert.equal((await admin('profiles/restrict','POST',{...decision,action:'ban'})).status,409);
  assert.equal((await admin('profiles/restrict','POST',{...decision,action:'ban',expectedRevision:1})).status,200);
  const management=await request('auth/apple','POST',{identityToken:await h.identity('apple_author'),nonce});assert.equal(management.status,201);const managed=await management.json();assert.equal(managed.profile.accountStatus,'banned');assert.equal(managed.profile.restrictionMessage,'Abusive upload');assert.equal((await request('account/decks','GET',undefined,managed.token)).status,200);assert.equal((await request('account','PUT',{username:'bypass',avatar:{hair:0,eyes:0,mouth:0}},managed.token)).status,403);
  assert.equal((await request('account','DELETE',undefined,managed.token)).status,200);assert.equal((await db.prepare('SELECT status FROM community_account_restrictions WHERE account_id=?').bind('apple_author').first()).status,'banned');
  const signin=await request('auth/apple','POST',{identityToken:await h.identity('apple_author'),nonce});assert.equal(signin.status,403);assert.equal((await signin.json()).error.code,'ACCOUNT_BANNED');
  assert.equal((await admin('restrictions')).status,200);assert.equal((await admin('profiles/restrict','POST',{authorID:author.authorID,action:'restore',expectedRevision:2})).status,200);
  const restored=await request('auth/apple','POST',{identityToken:await h.identity('apple_author'),nonce});assert.equal(restored.status,201);const fresh=await restored.json();
  const blocked=(await (await request('account/blocks','GET',undefined,viewer.token)).json()).users;assert.equal(blocked[0].id,fresh.profile.authorID);assert.equal((await request('account/blocks/'+fresh.profile.authorID,'DELETE',undefined,viewer.token)).status,200);assert.equal((await (await request('account/blocks','GET',undefined,viewer.token)).json()).users.length,0);
  assert.ok((await (await admin('audit')).json()).items.some(r=>r.action==='restrict_profile'));
 }finally{await mf.dispose();}
});
test('Apple code exchange encrypts tokens, binds reauthentication identity, revokes on deletion and retries temporary failure',async()=>{
 const h=await setup(true);const {mf,db,request}=h;
 try {
  const body={identityToken:await h.identity('apple-owner'),nonce,authorizationCode:'owner'};
  const signed=await request('auth/apple','POST',body);assert.equal(signed.status,201);const session=await signed.json();assert.equal(session.appleRevocationAvailable,true);assert.match(session.profile.authorID,/^[a-f0-9]{32}$/);
  const stored=await db.prepare('SELECT encrypted_token FROM community_apple_tokens WHERE user_id=?').bind('apple-owner').first();assert.ok(!stored.encrypted_token.includes('refresh'));assert.equal(await decryptAppleToken(h.env,stored.encrypted_token),'refresh-apple-owner');
  assert.equal((await request('account','DELETE',{...body,identityToken:await h.identity('another-apple')},session.token)).status,401);assert.ok(await db.prepare("SELECT id FROM community_users WHERE id='apple-owner'").first());
  assert.equal((await request('account','DELETE',{...body,authorizationCode:'mismatch'},session.token)).status,401);assert.equal(h.revocations(),0);
  const removed=await request('account','DELETE',undefined,session.token);assert.equal(removed.status,200);assert.equal((await removed.json()).appleRevocation,'revoked');assert.equal(h.revocations(),1);assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM community_apple_tokens').first()).n,0);
  const legacy=await (await request('auth/apple','POST',{identityToken:await h.identity('apple-legacy'),nonce})).json();assert.equal(legacy.appleRevocationAvailable,false);
  const needs=await request('account','DELETE',undefined,legacy.token);assert.equal(needs.status,409);assert.equal((await needs.json()).error.code,'APPLE_REAUTH_REQUIRED');
  h.setFail(true);const deleted=await request('account','DELETE',{identityToken:await h.identity('apple-legacy'),nonce,authorizationCode:'legacy'},legacy.token);assert.equal(deleted.status,200);assert.equal((await deleted.json()).appleRevocation,'pending');assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM community_apple_revocations').first()).n,1);assert.equal((await request('account','GET',undefined,legacy.token)).status,401);
  h.setFail(false);await cleanupCommunity({...h.env,COMMUNITY_DB:db,DECK_ASSETS:await mf.getR2Bucket('DECK_ASSETS')});assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM community_apple_revocations').first()).n,0);
  assert.equal((await request('auth/apple','POST',{identityToken:await h.identity('apple-bad'),nonce,authorizationCode:'bad'})).status,401);
 }finally{await mf.dispose();}
});
test('Apple notifications verify signatures and audience, delete matching old accounts and ignore duplicate/stale identity events',async()=>{
 const h=await setup();const {mf,db,request,seed}=h;
 try {
  const subject='event_user',user=await seed(subject), jti=crypto.randomUUID(), claims={iss:'https://appleid.apple.com',aud:'com.learnalert.app',iat:epoch(),jti,events:{type:'account-deleted',sub:subject,event_time:epoch()-1}};
  const valid=await h.sign(claims);
  assert.equal((await request('auth/apple/notifications','POST',{payload:await h.sign({...claims,aud:'wrong'})})).status,401);
  assert.equal((await request('auth/apple/notifications','POST',{payload:valid.slice(0,-30)+'a'.repeat(30)})).status,401);
  assert.equal((await request('auth/apple/notifications','POST',{payload:valid})).status,200);assert.equal((await request('account','GET',undefined,user.token)).status,401);
  await seed(subject);await db.prepare('UPDATE community_users SET created_at=? WHERE id=?').bind(epoch(),subject).run();
  assert.equal((await request('auth/apple/notifications','POST',{payload:valid})).status,200);assert.ok(await db.prepare('SELECT id FROM community_users WHERE id=?').bind(subject).first());
  const stale=await h.sign({...claims,jti:crypto.randomUUID()});assert.equal((await request('auth/apple/notifications','POST',{payload:stale})).status,200);assert.ok(await db.prepare('SELECT id FROM community_users WHERE id=?').bind(subject).first());
  const revoked=await h.sign({...claims,jti:crypto.randomUUID(),events:JSON.stringify({type:'consent-revoked',sub:subject,event_time:epoch()})});assert.equal((await request('auth/apple/notifications','POST',{payload:revoked})).status,200);assert.equal(await db.prepare('SELECT id FROM community_users WHERE id=?').bind(subject).first(),null);
 }finally{await mf.dispose();}
});

test('optional account-deletion JSON accepts an empty stream without weakening required JSON limits',async()=>{
 const request=()=>new Request('https://example.test/account',{method:'DELETE',body:new ReadableStream({start(controller){controller.close();}}),duplex:'half'});
 assert.deepEqual(await readCommunityJSON(request(),true),{});
 await assert.rejects(readCommunityJSON(request()),e=>e.status===400);
 await assert.rejects(readCommunityJSON(new Request('https://example.test/account',{method:'DELETE',body:'{'}),true),e=>e.status===400);
});
