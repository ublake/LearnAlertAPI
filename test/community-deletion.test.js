import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {community,cleanupCommunity} from '../src/routes/community.js';
import {sha256} from '../src/lib/communityAuth.js';
import {removeSharedDeck,drainDeletedObjects,accountSharedDeckDeletionStatements,DELETED_OBJECT_GRACE_SECONDS} from '../src/lib/communityDeletion.js';

const now=()=>Math.floor(Date.now()/1000);
const ownerToken='d'.repeat(64), otherToken='e'.repeat(64);
async function fixture() {
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-09-04',d1Databases:['COMMUNITY_DB'],r2Buckets:['DECK_ASSETS']}));
  const db=await mf.getD1Database('COMMUNITY_DB'), bucket=await mf.getR2Bucket('DECK_ASSETS');
  for(const file of(await readdir(new URL('../community-migrations/',import.meta.url))).sort()) {
    const sql=await readFile(new URL(`../community-migrations/${file}`,import.meta.url),'utf8');
    const triggers=sql.match(/CREATE TRIGGER[\s\S]*?END;/g)??[];
    for(const statement of sql.replace(/CREATE TRIGGER[\s\S]*?END;/g,'').split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(statement).run();
    for(const trigger of triggers)await db.prepare(trigger).run();
  }
  for(const [id,token]of[['owner',ownerToken],['other',otherToken]]) {
    await db.prepare('INSERT INTO community_users(id,handle,created_at,profile_completed) VALUES(?,?,?,1)').bind(id,`@${id}`,now()).run();
    await db.prepare('INSERT INTO community_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(await sha256(token),id,now()+3600).run();
  }
  const env={COMMUNITY_DB:db,DECK_ASSETS:bucket};
  const request=(path,method='GET',body,token=ownerToken,customEnv=env)=>community(new Request(`https://api.test/v1/community/${path}`,{method,headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}),customEnv,'test');
  async function deck({status='published',review='approved',admin=0,old=false}={}) {
    const id=crypto.randomUUID(),stamp=old?1:now();
    await db.prepare(`INSERT INTO community_decks(id,owner_id,name,category_tag,color_hex,deck_type,cards_json,card_count,status,review_status,admin_created,created_at,updated_at)
      VALUES(?,'owner','Private source content','Science','#123456','Quiz',?,2,?,?,?,?,?)`)
      .bind(id,JSON.stringify([{id:'one',cardType:'tap_reveal',question:'secret prompt',correctAnswer:'secret answer'},{id:'two',cardType:'tap_reveal',question:'other',correctAnswer:'answer'}]),status,review,admin,stamp,stamp).run();
    return id;
  }
  async function media(deckID,keyOverride) {
    const id=crypto.randomUUID(),key=keyOverride ?? `decks/${deckID}/${id}.wav`;
    await db.prepare('INSERT INTO community_media(id,deck_id,object_key,content_type,byte_size,uploaded,attached,created_at) VALUES(?,?,?,\'audio/wav\',4,1,1,?)').bind(id,deckID,key,now()).run();
    await bucket.put(key,new Uint8Array([1,2,3,4]));
    return key;
  }
  return {mf,db,bucket,env,request,deck,media};
}

test('owner deletion erases card content, reactions, reports and files; retries retain only ownership metadata',async()=>{
  const f=await fixture();
  try {
    const id=await f.deck(),key=await f.media(id);
    await f.db.prepare('INSERT INTO community_likes(deck_id,user_id,created_at) VALUES(?,\'other\',?)').bind(id,now()).run();
    await f.db.prepare('INSERT INTO community_reports(deck_id,user_id,reason,created_at) VALUES(?,\'other\',\'report\',?)').bind(id,now()).run();
    await f.db.prepare('INSERT INTO community_admin_audit(id,actor,action,target,details,created_at) VALUES(?,\'admin\',\'edit_deck\',?,?,?)').bind(crypto.randomUUID(),id,JSON.stringify({cards:['secret content'],description:'secret description',after:{adminNote:'Please follow the sharing rules'},previousAdminNote:'Earlier moderation note'}),now()).run();
    assert.equal((await f.request(`decks/${id}`,'DELETE',undefined,otherToken)).status,404);
    assert.equal((await f.request(`decks/${id}`,'DELETE')).status,200);
    for(const table of['community_decks','community_media','community_likes','community_reports'])assert.equal((await f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n,0,table);
    assert.equal(await f.bucket.get(key),null);
    assert.deepEqual(JSON.parse((await f.db.prepare('SELECT details FROM community_admin_audit WHERE target=?').bind(id).first()).details),{contentDeleted:true,adminNote:'Please follow the sharing rules',previousAdminNote:'Earlier moderation note'});
    assert.equal((await f.request(`decks/${id}`,'DELETE')).status,200);
    assert.equal((await f.request(`decks/${id}`,'DELETE',undefined,otherToken)).status,404);
    assert.equal((await f.request(`decks/${crypto.randomUUID()}`,'DELETE')).status,404);
    assert.deepEqual(Object.keys(await f.db.prepare('SELECT * FROM community_deleted_decks WHERE deck_id=?').bind(id).first()).sort(),['deck_id','deleted_at','owner_id']);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM community_deck_creations WHERE deck_id=?').bind(id).first()).n,1);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM community_deleted_objects').first()).n,1);
    await drainDeletedObjects(f.env,{timestamp:now()+DELETED_OBJECT_GRACE_SECONDS+1});
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM community_deleted_objects').first()).n,0);
  } finally {await f.mf.dispose();}
});

test('legacy attachment keys are removed immediately on a same-owner retry after storage recovers',async()=>{
  const f=await fixture();
  try {
    const id=await f.deck(),key=await f.media(id,'legacy/old-attachment.wav');
    const failed=await removeSharedDeck({...f.env,DECK_ASSETS:{async delete(){throw new Error('offline');}}},id,{ownerID:'owner'});
    assert.equal(failed.filesPending,true);
    assert.equal((await f.db.prepare('SELECT deck_id FROM community_deleted_objects WHERE object_key=?').bind(key).first()).deck_id,id);
    const retried=await removeSharedDeck(f.env,id,{ownerID:'owner'});
    assert.equal(retried.alreadyDeleted,true);
    assert.equal(retried.filesPending,false);
    assert.equal(await f.bucket.head(key),null);
  } finally {await f.mf.dispose();}
});

test('storage failure keeps a retry queue while SQL content is erased, and a late upload is removed on retry',async()=>{
  const f=await fixture();
  try {
    const id=await f.deck(),key=await f.media(id);
    const result=await removeSharedDeck({...f.env,DECK_ASSETS:{async delete(){throw new Error('storage unavailable');}}},id,{ownerID:'owner'});
    assert.equal(result.filesPending,true);
    assert.equal(await f.db.prepare('SELECT id FROM community_decks WHERE id=?').bind(id).first(),null);
    assert.ok(await f.bucket.get(key));
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM community_deleted_objects').first()).n,1);
    await drainDeletedObjects(f.env);
    assert.equal(await f.bucket.get(key),null);
    // The already-running upload can finish after an immediate successful delete.
    await f.bucket.put(key,new Uint8Array([9,9]));
    await drainDeletedObjects(f.env,{timestamp:now()+DELETED_OBJECT_GRACE_SECONDS+1});
    assert.equal(await f.bucket.get(key),null);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM community_deleted_objects').first()).n,0);
  } finally {await f.mf.dispose();}
});

test('a reserved upload finishing after deck deletion stays queued if its rollback cannot reach R2',async()=>{
  const f=await fixture();
  try {
    const id=await f.deck({status:'draft',review:null});
    let release,entered,key,putFinished=false;
    const started=new Promise(resolve=>{entered=resolve;});
    const blocked=new Promise(resolve=>{release=resolve;});
    const storage={async put(name,bytes,options){key=name;entered();await blocked;await f.bucket.put(name,bytes,options);putFinished=true;},async delete(name){if(putFinished)throw new Error('rollback unavailable');await f.bucket.delete(name);}};
    const env={...f.env,DECK_ASSETS:storage};
    const upload=community(new Request(`https://api.test/v1/community/decks/${id}/media`,{method:'POST',headers:{Authorization:`Bearer ${ownerToken}`,'Content-Type':'audio/wav'},body:new TextEncoder().encode('RIFF1234WAVEfmt test data')}),env,'upload-race');
    await started;
    assert.equal((await f.request(`decks/${id}`,'DELETE',undefined,ownerToken,env)).status,200);
    release();
    assert.equal((await upload).status,409);
    assert.ok(await f.bucket.get(key));
    assert.ok(await f.db.prepare('SELECT object_key FROM community_deleted_objects WHERE object_key=?').bind(key).first());
    await drainDeletedObjects(f.env,{timestamp:now()+DELETED_OBJECT_GRACE_SECONDS+1});
    assert.equal(await f.bucket.get(key),null);
  } finally {await f.mf.dispose();}
});

test('cleanup purges old removed/abandoned content but preserves active, pending, rejected and admin decks',async()=>{
  const f=await fixture();
  try {
    const removed=await f.deck({status:'deleted',old:true}),abandoned=await f.deck({status:'draft',review:null,old:true});
    const protectedIDs=await Promise.all([f.deck({old:true}),f.deck({status:'draft',review:'pending',old:true}),f.deck({status:'draft',review:'rejected',old:true}),f.deck({status:'draft',review:null,admin:1,old:true})]);
    const removedKey=await f.media(removed),abandonedKey=await f.media(abandoned);
    const orphan=crypto.randomUUID();
    await f.db.prepare('INSERT INTO community_admin_audit(id,actor,action,target,details,created_at) VALUES(?,\'admin\',\'edit_deck\',?,?,?)')
      .bind(crypto.randomUUID(),orphan,JSON.stringify({before:{cards:['old deleted content'],description:'secret'},adminNote:'Removal reason'}),1).run();
    await f.db.prepare('INSERT INTO community_admin_audit(id,actor,action,target,details,created_at) VALUES(?,\'admin\',\'edit_deck\',?,?,?)')
      .bind(crypto.randomUUID(),protectedIDs[0],JSON.stringify({before:{cards:['active content']}}),1).run();
    await cleanupCommunity(f.env);
    assert.equal(await f.db.prepare('SELECT id FROM community_decks WHERE id IN (?,?)').bind(removed,abandoned).first(),null);
    assert.equal(await f.bucket.get(removedKey),null);assert.equal(await f.bucket.get(abandonedKey),null);
    for(const id of protectedIDs)assert.ok(await f.db.prepare('SELECT id FROM community_decks WHERE id=?').bind(id).first());
    assert.deepEqual(JSON.parse((await f.db.prepare('SELECT details FROM community_admin_audit WHERE target=?').bind(orphan).first()).details),{contentDeleted:true,adminNote:'Removal reason'});
    assert.deepEqual(JSON.parse((await f.db.prepare('SELECT details FROM community_admin_audit WHERE target=?').bind(protectedIDs[0]).first()).details),{before:{cards:['active content']}});
    const raced=await f.deck({status:'draft',review:null,old:true});
    let batches=0;
    const db={prepare:sql=>f.db.prepare(sql),async batch(statements){if(++batches===2)await f.db.prepare("UPDATE community_decks SET review_status='pending' WHERE id=?").bind(raced).run();return f.db.batch(statements);}};
    await cleanupCommunity({...f.env,COMMUNITY_DB:db});
    assert.ok(await f.db.prepare('SELECT id FROM community_decks WHERE id=?').bind(raced).first());
  } finally {await f.mf.dispose();}
});

test('bulk file cleanup stays within R2 and D1 limits and retains failed chunks',async()=>{
  const f=await fixture();
  try {
    await f.db.prepare(`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<1050)
      INSERT INTO community_deleted_objects(object_key,created_at,retain_until) SELECT 'bulk/'||n,1,0 FROM numbers`).run();
    const sizes=[];
    let fail=true;
    const env={...f.env,DECK_ASSETS:{async delete(keys){assert.ok(Array.isArray(keys));assert.ok(keys.length<=1000);sizes.push(keys.length);if(fail){fail=false;throw new Error('retry this chunk');}}}};
    const first=await drainDeletedObjects(env,{limit:2000});
    assert.deepEqual(sizes,[1000,50]);
    assert.deepEqual(first,{deleted:50,failed:1000});
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM community_deleted_objects').first()).n,1000);
    await drainDeletedObjects(env,{limit:2000});
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM community_deleted_objects').first()).n,0);
  } finally {await f.mf.dispose();}
});

test('account deletion repeats its freshness guard on every content and queue write',async()=>{
  const f=await fixture();
  try {
    const id=await f.deck(),key=await f.media(id);
    await f.db.batch(accountSharedDeckDeletionStatements(f.db,'owner',now(),{extraPredicate:'created_at<?',extraValues:[0]}));
    assert.ok(await f.db.prepare('SELECT id FROM community_decks WHERE id=?').bind(id).first());
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM community_deleted_objects').first()).n,0);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM community_deleted_decks').first()).n,0);
    assert.ok(await f.bucket.get(key));
  } finally {await f.mf.dispose();}
});

test('deleting drafts cannot reset the twenty-per-day creation budget',async()=>{
  const f=await fixture();
  try {
    for(let index=0;index<20;index++) {
      const response=await f.request('decks/drafts','POST',{name:`Deck ${index}`});
      assert.equal(response.status,201,await response.clone().text());
      const {id}=await response.json();
      assert.equal((await f.request(`decks/${id}`,'DELETE')).status,200);
    }
    assert.equal((await f.request('decks/drafts','POST',{name:'Over budget'})).status,429);
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM community_decks').first()).n,0);
  } finally {await f.mf.dispose();}
});
