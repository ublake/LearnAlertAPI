import test from 'node:test';
import { composeDelivery, requireStableDeliveryIDs } from '../src/lib/catalogDelivery.js';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { validateCatalogContent } from '../src/lib/catalogValidation.js';

const bindings={ADMIN_ACCESS_ISSUER:'https://catalog-test.cloudflareaccess.com',ADMIN_ACCESS_AUD:'catalog-test',ADMIN_EMAILS:'admin@example.test'};
const b64=value=>Buffer.from(typeof value==='string'?value:JSON.stringify(value)).toString('base64url');
async function harness({through} = {}) {
  const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
  const jwk={...await crypto.subtle.exportKey('jwk',pair.publicKey),kid:'catalog-test',alg:'RS256'};
  const now=Math.floor(Date.now()/1000),message=`${b64({alg:'RS256',kid:jwk.kid})}.${b64({iss:bindings.ADMIN_ACCESS_ISSUER,aud:[bindings.ADMIN_ACCESS_AUD],email:bindings.ADMIN_EMAILS,iat:now,exp:now+600})}`;
  const jwt=`${message}.${Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,new TextEncoder().encode(message))).toString('base64url')}`;
  const bundle=await build({entryPoints:['src/index.js'],bundle:true,write:false,format:'esm',platform:'browser'});
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-09-04',bindings,d1Databases:['COMMUNITY_DB'],r2Buckets:['DECK_ASSETS'],outboundService:()=>new Response(JSON.stringify({keys:[jwk]}))}));
  const db=await mf.getD1Database('COMMUNITY_DB');
  for(const file of (await readdir(new URL('../community-migrations/',import.meta.url))).sort()) {
    if (through && file > through) continue;
    const sql=await readFile(new URL(`../community-migrations/${file}`,import.meta.url),'utf8'),triggers=sql.match(/CREATE TRIGGER[\s\S]*?END;/g)||[];
    for(const statement of sql.replace(/CREATE TRIGGER[\s\S]*?END;/g,'').split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
    for(const trigger of triggers)await db.prepare(trigger).run();
  }
  const admin=(path='',method='GET',body,headers={})=>mf.dispatchFetch(`https://api.example.test/v1/admin/catalog${path?'/'+path:''}`,{method,headers:{'Cf-Access-Jwt-Assertion':jwt,Origin:'https://learnalertapp.com','Content-Type':'application/json',...headers},body:body===undefined?undefined:body instanceof Uint8Array?body:JSON.stringify(body)});
  const publicCall=path=>mf.dispatchFetch(`https://api.example.test/v1/catalog${path?'/'+path:''}`);
  return {mf,db,admin,publicCall,communityAdmin:path=>mf.dispatchFetch(`https://api.example.test/v1/admin/${path}`,{headers:{'Cf-Access-Jwt-Assertion':jwt}}),bucket:await mf.getR2Bucket('DECK_ASSETS')};
}
const course=()=>({id:'korean-test',title:'Korean',language:'Korean',flagEmoji:'🇰🇷',levelTag:'Beginner',colorHex:'#3377aa',summary:'First steps',estimatedHours:2,outcomes:['Read syllables'],units:[{id:'u1',unitNumber:1,title:'Letters',subtitle:'Start here',colorHex:'#3377aa',badgeIcon:'book.fill',lessons:[{id:'l1',lessonNumber:1,title:'Vowels',subtitle:'Sounds',nodeType:'lesson',estimatedMinutes:5,cards:[{id:'c1',question:'Read 아',correctAnswer:'ah',options:['ah','oh'],hint:'A sound',cardType:'multipleChoice',matchingLeftItems:[],matchingRightItems:[],optionImageNames:[],activity:{kind:'listenChoose',sequence:1,layout:'inline',tokens:[],slots:[],slotLabels:[],optionHints:{},rule:'Read it'}}]}],checkpointQuiz:{id:'cp1',title:'Check',summary:'Try',passingScoreThreshold:0.8,questions:[{id:'cp1-q1',question:'Read 오',correctAnswer:'oh',options:['ah','oh'],hint:'',cardType:'multipleChoice',matchingLeftItems:[],matchingRightItems:[],optionImageNames:[]}],keyConcepts:['Vowels']}}],guides:{u1:[{title:'Blocks',rule:'Use a placeholder',examples:['아']}]},guidePresentation:{u1:{showsHangulDiagram:true,referenceTitle:'Reference',referenceURL:'https://example.test/reference'}},futureExtension:{keep:'all unknown data'}});
const exam=()=>({id:'exam-test',name:'Practice exam',category:'Exam Prep',subcategory:'Certification',description:'Skills',colorHex:'#22aa77',deckType:'Mixed',cards:[{id:'q1',question:'Choose the first item',correctAnswer:'first',options:['first','second'],hint:'',cardType:'multiple_choice',matchingLeftItems:[],matchingRightItems:[],optionImageNames:[],fieldMedia:{},correctOptionIndex:0}]});

test('catalog publishing validates full curriculum, guides, activities and identities without losing unknown fields',()=>{
  const good=course();
  const diagram=course();diagram.guidePresentation.u1.diagramExamples=[{syllable:'가',caption:'Read',initial:'ㄱ',vowel:'ㅏ',layout:'beside'}];diagram.guidePresentation.u1.diagramTitle='Build';diagram.guidePresentation.u1.diagramFooter='Try';assert.doesNotThrow(()=>validateCatalogContent('course',diagram,diagram.id,{publish:true}));
  diagram.guidePresentation.u1.diagramExamples[0].layout='invalid';assert.throws(()=>validateCatalogContent('course',diagram,diagram.id,{publish:true}),error=>error.status===400);
  const imageOnly=exam();imageOnly.cards[0]={...imageOnly.cards[0],question:'',promptImageName:'catalog:00000000-0000-0000-0000-000000000001',correctAnswer:'',options:['',''],correctOptionIndex:1,fieldMedia:{'option:0':{image:'catalog:00000000-0000-0000-0000-000000000002'},'option:1':{audio:'catalog:00000000-0000-0000-0000-000000000003'}}};assert.doesNotThrow(()=>validateCatalogContent('exam',imageOnly,imageOnly.id,{publish:true}));
  for (const cardType of ['hangulBuild','tokenPlacement','hangulTrace']) { const value=course();value.units[0].lessons[0].cards[0].cardType=cardType;assert.doesNotThrow(()=>validateCatalogContent('course',value,value.id,{publish:true})); }
  assert.equal(validateCatalogContent('course',good,good.id,{publish:true}).content,good);
  assert.equal(validateCatalogContent('exam',exam(),'exam-test',{publish:true}).summary.cardCount,1);
  for(const mutate of [value=>value.units[0].lessons.push(structuredClone(value.units[0].lessons[0])),value=>value.units[0].checkpointQuiz.passingScoreThreshold=2,value=>value.units[0].lessons[0].cards[0].activity.kind='unknown',value=>value.guides.missing=[],value=>value.guidePresentation.u1.referenceURL='javascript:alert(1)',value=>value.units[0].lessons[0].cards[0].correctOptionIndex=3,value=>{value.units[0].lessons[0].cards[0].activity=null;value.units[0].lessons[0].cards[0].correctAnswer='missing';},value=>{const card=value.units[0].lessons[0].cards[0];card.activity=null;card.cardType='matching';card.matchingLeftItems=['a'];card.matchingRightItems=[];}]) {
    const invalid=course();mutate(invalid);assert.throws(()=>validateCatalogContent('course',invalid,invalid.id,{publish:true}),error=>error.status===400);
  }
  assert.doesNotThrow(()=>validateCatalogContent('course',{id:'draft',title:'Draft',colorHex:'#123456',units:[{lessons:{}}]},'draft'));
  const many=exam();many.cards=Array.from({length:1200},(_,i)=>({...many.cards[0],id:'q'+i}));assert.equal(validateCatalogContent('exam',many,many.id,{publish:true}).summary.cardCount,1200);
});

test('catalog media-only answerability matches native key precedence and ignores unsupported top-level ID aliases',()=>{
  const references=['catalog:00000000-0000-0000-0000-000000000001','catalog:00000000-0000-0000-0000-000000000002'];
  for (const kind of ['course','exam']) {
    const document=kind==='course'?course():exam();
    const card=kind==='course'?document.units[0].lessons[0].cards[0]:document.cards[0];
    delete card.activity;
    Object.assign(card,{question:'',promptImageName:references[0],correctAnswer:'',options:['',''],correctOptionIndex:1,fieldMedia:{'option:0':{imageID:references[0]},'option:1':{audioID:references[1]}}});
    const validate=()=>validateCatalogContent(kind,document,document.id,{publish:true});
    assert.doesNotThrow(validate); // Absent native keys still decode their aliases.
    card.fieldMedia['option:0'].image='';assert.throws(validate,error=>error.status===400&&error.message.includes('options[0]'));
    card.fieldMedia['option:0'].image=null;assert.doesNotThrow(validate);
    card.fieldMedia['option:1'].audio='';assert.throws(validate,error=>error.status===400&&error.message.includes('options[1]'));
    delete card.fieldMedia['option:1'].audio;assert.doesNotThrow(validate);
    delete card.fieldMedia['option:0'];card.optionImageIDs=[references[0],''];assert.throws(validate,error=>error.status===400&&error.message.includes('options[0]'));
    card.optionImageNames=[references[0],''];assert.doesNotThrow(validate);
    card.fieldMedia.prompt={imageID:references[0]};card.promptImageName='';assert.throws(validate,error=>error.status===400&&error.message.includes('question'));
    delete card.promptImageName;assert.doesNotThrow(validate);
    delete card.fieldMedia.prompt;card.promptImageID=references[0];card.promptAudioID=references[1];assert.throws(validate,error=>error.status===400&&error.message.includes('question'));
    card.promptAudioName=references[1];assert.doesNotThrow(validate);
  }
});

test('catalog authenticates writes, publishes immutable snapshots, preserves live drafts, audits, archives and restores',async()=>{
  const {mf,db,admin,publicCall,bucket,communityAdmin}=await harness();
  try {
    await db.prepare("INSERT INTO community_users(id,handle,created_at) VALUES('catalog-owner','@catalog_owner',1)").run();
    for(const [id,status,review,hidden] of [['visible','published','approved',0],['draft','draft',null,0],['pending','draft','pending',0],['hidden','published','approved',1]]) {
      await db.prepare('INSERT INTO community_decks(id,owner_id,name,category_tag,color_hex,deck_type,status,review_status,admin_hidden,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,1,1)').bind(id,'catalog-owner','catalogFixture '+id,'General','#123456','Mixed',status,review,hidden).run();
    }
    assert.deepEqual((await (await communityAdmin('decks?publicOnly=true&q=catalogFixture')).json()).items.map(item=>item.id),['visible']);
    assert.equal((await (await communityAdmin('decks?q=catalogFixture')).json()).items.length,4);
    assert.equal((await admin('','POST',null)).status,400);
    let manifest=await (await publicCall()).json();assert.equal(manifest.initialized,false);assert.deepEqual(manifest.items,[]);
    assert.equal((await admin('','POST',{id:'korean-test',kind:'course',document:course()},{'Cf-Access-Jwt-Assertion':''})).status,401);
    assert.equal((await admin('','POST',{id:'korean-test',kind:'course',document:course()},{Origin:'https://attacker.test'})).status,403);
    const created=await admin('','POST',{id:'korean-test',kind:'course',document:course()});assert.equal(created.status,201);
    let item=(await created.json()).item;assert.equal(item.revision,1);assert.equal(item.status,'draft');assert.equal(item.document.futureExtension.keep,'all unknown data');
    assert.equal((await publicCall(item.id)).status,404);
    assert.equal((await admin('','POST',{id:item.id,kind:'course',document:course()})).status,409);
    assert.equal((await (await admin('?kind=course')).json()).items.length,1);
    assert.equal((await (await admin('?kind=exam')).json()).items.length,0);
    let published=await admin(item.id+'/publish','POST',{expectedRevision:1});assert.equal(published.status,200);item=(await published.json()).item;assert.equal(item.revision,2);assert.equal(item.publishedRevision,2);
    manifest=await (await publicCall()).json();assert.equal(manifest.initialized,true);assert.equal(manifest.items[0].revision,2);assert.equal(manifest.items[0].title,'Korean');
    const beforeState=(await (await publicCall()).json()).revision, beforeObjects=(await bucket.list()).objects.length;
    const validation=await admin('validate','POST',{kind:'course',document:course()});assert.equal(validation.status,200);assert.equal((await validation.json()).valid,true);
    assert.equal((await (await publicCall()).json()).revision,beforeState);assert.equal((await bucket.list()).objects.length,beforeObjects);
    assert.equal((await admin('validate','POST',{kind:'course',document:course()},{Origin:'https://attacker.test'})).status,403);
    const invalidCourse=course();invalidCourse.units[0].lessons[0].cards[0].correctAnswer='none';assert.equal((await admin('validate','POST',{id:invalidCourse.id,kind:'course',document:invalidCourse})).status,400);
    const before=await (await publicCall(item.id+'?revision=2')).json();assert.equal(before.document.title,'Korean');
    const historical=(await (await admin(item.id+'?revision=1')).json()).item;assert.equal(historical.viewedRevision,1);assert.equal(historical.revision,2);
    assert.equal((await admin(item.id+'?revision=999')).status,404);
    const draft={...course(),title:'Unpublished title'};
    let saved=await admin(item.id,'PUT',{expectedRevision:2,document:draft});assert.equal(saved.status,200);item=(await saved.json()).item;assert.equal(item.revision,3);assert.equal(item.publishedRevision,2);
    assert.equal((await (await publicCall()).json()).items[0].title,'Korean');assert.equal((await (await publicCall(item.id)).json()).document.title,'Korean');
    assert.equal((await publicCall(item.id+'?revision=3')).status,404);
    const objectCount=(await bucket.list()).objects.length;
    assert.equal((await admin(item.id,'PUT',{expectedRevision:2,document:{...draft,title:'Stale'}})).status,409);
    assert.equal((await bucket.list()).objects.length,objectCount);
    const results=await Promise.all([admin(item.id,'PUT',{expectedRevision:3,document:{...draft,title:'Edit A'}}),admin(item.id,'PUT',{expectedRevision:3,document:{...draft,title:'Edit B'}})]);
    assert.deepEqual(results.map(result=>result.status).sort(),[200,409]);
    item=(await (await admin(item.id)).json()).item;assert.equal(item.revision,4);
    assert.equal((await admin(item.id+'/archive','POST',{expectedRevision:3})).status,409);
    assert.equal((await admin(item.id+'/archive','POST',{expectedRevision:4})).status,200);
    manifest=await (await publicCall()).json();assert.equal(manifest.initialized,true);assert.equal(manifest.items.length,0);assert.equal((await publicCall(item.id+'?revision=2')).status,404);
    const restored=await admin(item.id+'/restore','POST',{expectedRevision:5,revision:1,note:'Restore original'});assert.equal(restored.status,200);item=(await restored.json()).item;assert.equal(item.status,'draft');assert.equal(item.revision,6);assert.equal(item.document.title,'Korean');
    assert.equal((await publicCall(item.id)).status,404);
    assert.equal((await admin(item.id+'/publish','POST',{expectedRevision:6})).status,200);
    assert.equal((await publicCall(item.id)).status,200);
    const history=(await (await admin(item.id+'/history')).json()).items;assert.equal(history.length,7);assert.equal(history[0].revision,7);assert.equal(history[0].published,true);assert.equal(history[1].note,'Restore original');
    const audit=(await db.prepare("SELECT action FROM community_admin_audit WHERE target='korean-test'").all()).results.map(row=>row.action);
    for(const action of ['catalog_create','catalog_save','catalog_publish','catalog_archive','catalog_restore'])assert.ok(audit.includes(action));
    assert.equal((await admin(item.id,'DELETE',{expectedRevision:7})).status,200);assert.equal((await publicCall(item.id)).status,404);
  } finally {await mf.dispose();}
});

test('catalog media stays private until referenced in a publication and is withdrawn on replacement or archive',async()=>{
  const {mf,admin,publicCall}=await harness();
  try {
    let item=(await (await admin('','POST',{id:'exam-test',kind:'exam',document:exam()})).json()).item;
    const png=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0,0,0,0,0]);
    assert.equal((await admin(item.id+'/media','POST',new Uint8Array(16),{'Content-Type':'image/png'})).status,400);
    const upload=await admin(item.id+'/media','POST',png,{'Content-Type':'image/png'});assert.equal(upload.status,201);
    const asset=await upload.json();assert.match(asset.reference,/^catalog:/);assert.equal((await admin('media/'+asset.id)).status,200);assert.equal((await publicCall('media/'+asset.id)).status,404);
    let document={...exam(),cards:[{...exam().cards[0],fieldMedia:{'option:0':{imageID:asset.reference}}}]};
    item=(await (await admin(item.id,'PUT',{expectedRevision:1,document})).json()).item;
    assert.equal((await admin(item.id+'/publish','POST',{expectedRevision:item.revision})).status,200);
    assert.equal((await publicCall('media/'+asset.id)).status,200);
    const manifest=await (await publicCall()).json();assert.equal(manifest.items[0].assets[0].reference,asset.reference);
    item=(await (await admin(item.id)).json()).item;
    document={...document,cards:[{...document.cards[0],fieldMedia:{}}]};
    item=(await (await admin(item.id,'PUT',{expectedRevision:item.revision,document})).json()).item;
    assert.equal((await publicCall('media/'+asset.id)).status,200); // drafts leave live media unchanged
    item=(await (await admin(item.id+'/publish','POST',{expectedRevision:item.revision})).json()).item;
    assert.equal((await publicCall('media/'+asset.id)).status,404);assert.equal((await admin('media/'+asset.id)).status,200);
    const wav=new Uint8Array([82,73,70,70,0,0,0,0,87,65,86,69]);
    const audio=await (await admin(item.id+'/media','POST',wav,{'Content-Type':'audio/wav'})).json();
    document.cards[0].fieldMedia={'option:1':{audio:audio.reference}};document.cards[0].options=['first',''];
    item=(await (await admin(item.id,'PUT',{expectedRevision:item.revision,document})).json()).item;
    item=(await (await admin(item.id+'/publish','POST',{expectedRevision:item.revision})).json()).item;
    const audioResponse=await publicCall('media/'+audio.id);assert.equal(audioResponse.status,200);assert.equal(audioResponse.headers.get('Content-Type'),'audio/wav');
    document.cards[0].fieldMedia={'option:0':{audio:asset.reference}};document.cards[0].options=['first','second'];
    item=(await (await admin(item.id,'PUT',{expectedRevision:item.revision,document})).json()).item;
    assert.equal((await admin(item.id+'/publish','POST',{expectedRevision:item.revision})).status,400);
    document.cards[0].fieldMedia={'option:0':{imageID:'catalog:00000000-0000-0000-0000-000000000000'}};
    item=(await (await admin(item.id,'PUT',{expectedRevision:item.revision,document})).json()).item;
    assert.equal((await admin(item.id+'/publish','POST',{expectedRevision:item.revision})).status,400);
    assert.equal((await admin('validate','POST',{id:item.id,kind:'exam',document})).status,400);
    assert.equal((await publicCall('media/not-a-real-uuid')).status,404);
  }finally{await mf.dispose();}
});

test('duplicating an entry clones only its owned media into a private draft and cleans failed copies',async()=>{
  const {mf,db,admin,publicCall,bucket}=await harness();
  try {
    const source=(await (await admin('','POST',{id:'exam-test',kind:'exam',document:exam()})).json()).item;
    const png=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0,0,0,0,0]),wav=new Uint8Array([82,73,70,70,0,0,0,0,87,65,86,69]);
    const image=await (await admin(source.id+'/media','POST',png,{'Content-Type':'image/png'})).json();
    const audio=await (await admin(source.id+'/media','POST',wav,{'Content-Type':'audio/wav'})).json();
    const document={...exam(),id:'exam-copy',name:'Copied practice',cards:[{...exam().cards[0],promptImageName:image.reference,answerImageName:image.reference,promptAudioName:audio.reference,fieldMedia:{'option:0':{image:image.reference},'option:1':{audio:audio.reference}}}],futureAttachment:image.reference};
    const clone=await admin('','POST',{id:document.id,kind:'exam',document,sourceCatalogID:source.id,sortOrder:17});assert.equal(clone.status,201);
    const item=(await clone.json()).item;assert.equal(item.status,'draft');assert.equal(item.sortOrder,17);assert.equal(item.revision,1);
    const newImage=item.document.cards[0].promptImageName,newAudio=item.document.cards[0].promptAudioName;
    assert.notEqual(newImage,image.reference);assert.notEqual(newAudio,audio.reference);
    assert.equal(item.document.cards[0].answerImageName,newImage);assert.equal(item.document.cards[0].fieldMedia['option:0'].image,newImage);assert.equal(item.document.futureAttachment,newImage);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM managed_catalog_media WHERE catalog_id=?').bind(item.id).first()).n,2);
    const clonedRows=(await db.prepare('SELECT * FROM managed_catalog_media WHERE catalog_id=?').bind(item.id).all()).results;
    for(const row of clonedRows) assert.deepEqual(new Uint8Array(await (await bucket.get(row.object_key)).arrayBuffer()),row.content_type==='image/png'?png:wav);
    for(const reference of [image.reference,audio.reference,newImage,newAudio])assert.equal((await publicCall('media/'+reference.slice(8))).status,404);
    assert.equal((await admin(item.id+'/publish','POST',{expectedRevision:1})).status,200);
    assert.equal((await publicCall('media/'+newImage.slice(8))).status,200);assert.equal((await publicCall('media/'+newAudio.slice(8))).status,200);
    assert.equal((await publicCall('media/'+image.id)).status,404);assert.equal((await publicCall('media/'+audio.id)).status,404);
    let count=(await bucket.list()).objects.length;
    assert.equal((await admin('','POST',{id:document.id,kind:'exam',document,sourceCatalogID:source.id})).status,409);assert.equal((await bucket.list()).objects.length,count);
    const racing={...document,id:'racing-copy'};
    const raced=await Promise.all([admin('','POST',{id:racing.id,kind:'exam',document:racing,sourceCatalogID:source.id}),admin('','POST',{id:racing.id,kind:'exam',document:racing,sourceCatalogID:source.id})]);
    assert.deepEqual(raced.map(response=>response.status).sort(),[201,409]);assert.equal((await bucket.list()).objects.length,count+3);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM managed_catalog_media WHERE catalog_id=?').bind(racing.id).first()).n,2);
    const other={...exam(),id:'other-exam'};await admin('','POST',{id:other.id,kind:'exam',document:other});count=(await bucket.list()).objects.length;
    const bad={...document,id:'foreign-copy'};
    assert.equal((await admin('','POST',{id:bad.id,kind:'exam',document:bad,sourceCatalogID:other.id})).status,400);
    assert.equal((await bucket.list()).objects.length,count);assert.equal(await db.prepare('SELECT id FROM managed_catalog WHERE id=?').bind(bad.id).first(),null);
    const missing=await db.prepare('SELECT object_key FROM managed_catalog_media WHERE id=?').bind(audio.id).first();await bucket.delete(missing.object_key);count=(await bucket.list()).objects.length;
    const incomplete={...document,id:'failed-copy'};
    assert.equal((await admin('','POST',{id:incomplete.id,kind:'exam',document:incomplete,sourceCatalogID:source.id})).status,503);
    assert.equal((await bucket.list()).objects.length,count);assert.equal(await db.prepare('SELECT id FROM managed_catalog WHERE id=?').bind(incomplete.id).first(),null);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM managed_catalog_media WHERE catalog_id=?').bind(incomplete.id).first()).n,0);
    const audit=await db.prepare("SELECT details FROM community_admin_audit WHERE target=? AND action='catalog_create'").bind(item.id).first();assert.equal(JSON.parse(audit.details).clonedMediaCount,2);
  }finally{await mf.dispose();}
});

test('delivery profiles preserve published r9 and private r10 through prepare, activation and rollback',async()=>{
 const {mf,db,admin,publicCall,bucket}=await harness();
 try {
  const base={...course(),id:'spanish-course',title:'Spanish (SP) Foundations',language:'Spanish'};
  assert.equal((await admin('','POST',{id:base.id,kind:'course',document:base})).status,201);
  assert.equal((await admin(base.id+'/publish','POST',{expectedRevision:1})).status,200);
  const published=await db.prepare('SELECT * FROM managed_catalog WHERE id=?').bind(base.id).first();
  const paused={...base,title:'Paused r10 expansion',futureExpansion:{mustStayPrivate:true}};
  assert.equal((await admin(base.id,'PUT',{expectedRevision:2,document:paused})).status,200);
  const draft=await db.prepare('SELECT * FROM managed_catalog WHERE id=?').bind(base.id).first();
  await db.prepare("INSERT INTO managed_catalog_revisions(catalog_id,revision,action,content_key,actor,created_at,published) VALUES(?,9,'publish',?,'fixture',9,1),(?,10,'save',?,'fixture',10,0)").bind(base.id,published.published_key,base.id,draft.draft_key).run();
  // Synthetic r9 aliases the exact approved bytes; normalise its test-only pin too.
  await db.prepare('UPDATE managed_catalog_legacy_pins SET revision=9 WHERE catalog_id=?').bind(base.id).run();
  await db.prepare('UPDATE managed_catalog SET revision=10,published_revision=9 WHERE id=?').bind(base.id).run();
  const pausedBytes=await (await bucket.get(draft.draft_key)).text();
  const fixture=JSON.parse(await readFile(new URL('./fixtures/visual-starter-delivery.json',import.meta.url),'utf8'));
  for(let i=1;i<=4;i++) {const id='00000000-0000-4000-8000-'+String(i).padStart(12,'0'),key='fixture/'+id;await bucket.put(key,'fixture-image');await db.prepare('INSERT INTO managed_catalog_media(id,catalog_id,object_key,content_type,byte_size,created_at,actor) VALUES(?,?,?,?,?,1,?)').bind(id,base.id,key,'image/png',13,'fixture').run();}
  const additions={units:[fixture.unit],learning:fixture.learning};
  const release=(operation,expectedRevision,extra={})=>admin(base.id+'/delivery','POST',{operation,profile:'practice-v1',expectedRevision,...extra});
  assert.equal((await release('prepare',10,{sourceRevision:10,additions})).status,409);
  for(const mutate of [x=>x.learning.starter.assessment.title=7,x=>{const sense=x.learning.vocabulary['pf-sp-lex-un-one-item'];sense.lemma='';sense.article=null;},x=>x.learning.starter.assessment.forms.a[0].card.activity.exercise.conceptIDs=['unassessed']]) {const bad=structuredClone(additions);mutate(bad);assert.equal((await release('prepare',10,{sourceRevision:9,additions:bad})).status,400);}
  assert.equal((await publicCall('media/00000000-0000-4000-8000-000000000001')).status,404);
  let response=await release('prepare',10,{sourceRevision:9,additions});assert.equal(response.status,200,await response.clone().text());
  let item=(await response.json()).item;assert.equal(item.revision,11);assert.deepEqual(item.document,paused);assert.equal(item.publishedRevision,9);
  assert.equal((await publicCall(base.id+'?revision=11')).status,404);
  assert.equal((await publicCall('media/00000000-0000-4000-8000-000000000001')).status,404);
  await assert.rejects(()=>db.prepare('DELETE FROM managed_catalog_revisions WHERE catalog_id=? AND revision=11').bind(base.id).run());
  await assert.rejects(()=>db.prepare('DELETE FROM managed_catalog_media WHERE id=?').bind('00000000-0000-4000-8000-000000000001').run());
  const preview=(await (await admin(base.id+'?revision=11')).json()).item;assert.equal(preview.document.futureExpansion,undefined);assert.equal(preview.document.units.length,2);
  const caps={'X-LearnAlert-Contracts':'exercise-v1,matching-evidence-v1,finite-bank-v1,route-v1,assessment-v1'};
  const modern=path=>mf.dispatchFetch('https://api.example.test/v1/catalog'+path,{headers:caps});
  assert.equal((await modern('/'+base.id+'?profile=practice-v1&revision=11')).status,404);
  assert.equal((await admin(base.id+'/publish','POST',{expectedRevision:11})).status,409);
  response=await release('activate',11,{deliveryRevision:11});assert.equal(response.status,200,await response.clone().text());
  assert.deepEqual((await response.json()).item.document,paused);
  for(const [path,headers] of [['?profile=practice-v1',{}],['?profile=practice-v1',{'X-LearnAlert-Contracts':'exercise-v1'}],['?profile=unknown',caps]]) {
   const old=await (await mf.dispatchFetch('https://api.example.test/v1/catalog'+path,{headers})).json();assert.equal(old.schemaVersion,1);assert.equal(old.items[0].revision,9);
  }
  const mr=await modern('?profile=practice-v1'),manifest=await mr.json();assert.equal(mr.headers.get('cache-control'),'no-store');assert.equal(manifest.schemaVersion,2);assert.equal(manifest.items[0].revision,11);assert.equal(manifest.items[0].assets.length,4);
  const envelope=await (await modern('/'+base.id+'?profile=practice-v1&revision=11')).json(),document=JSON.parse(Buffer.from(envelope.payload,'base64').toString('utf8'));
  assert.equal(document.id,base.id);assert.equal(document.units[0].id,base.units[0].id);assert.equal(document.units.length,2);assert.equal(document.futureExpansion,undefined);assert.equal(envelope.contentDigest,manifest.items[0].contentDigest);
  const old=await (await publicCall()).json();assert.equal(old.items[0].revision,9);assert.equal(old.items[0].assets.length,0);assert.deepEqual((await (await publicCall(base.id)).json()).document,base);
  await assert.rejects(()=>db.batch([db.prepare('DELETE FROM managed_catalog_public_media WHERE catalog_id=?').bind(base.id),db.prepare("UPDATE managed_catalog SET published_key=draft_key,published_revision=revision+1 WHERE id=?").bind(base.id)]));
  assert.equal((await publicCall('media/00000000-0000-4000-8000-000000000001')).status,200);
  assert.equal((await release('activate',11,{deliveryRevision:11})).status,409);
  assert.equal((await release('withdraw',12)).status,200);const fallback=await (await modern('?profile=practice-v1')).json();assert.equal(fallback.items[0].deliveryProfile,'legacy-v1');assert.notEqual(fallback.revision,manifest.revision);
  assert.equal((await publicCall('media/00000000-0000-4000-8000-000000000001')).status,200);
  assert.equal((await release('rollback',13,{deliveryRevision:11})).status,200);assert.equal((await (await modern('?profile=practice-v1')).json()).items[0].revision,11);
  assert.equal((await admin(base.id+'/archive','POST',{expectedRevision:14})).status,200);
  assert.equal((await publicCall('media/00000000-0000-4000-8000-000000000001')).status,404);
  response=await release('restoreApproved',15);assert.equal(response.status,200,await response.clone().text());
  const inserted=structuredClone(additions),extraCard=structuredClone(inserted.units[0].lessons[0].cards[0]);extraCard.id='test-extra-variant';inserted.units[0].lessons[0].cards.push(extraCard);assert.equal((await release('prepare',16,{sourceRevision:9,additions:inserted})).status,400);
  const newCheckpoint=structuredClone(additions);newCheckpoint.units[0].checkpointQuiz=structuredClone(base.units[0].checkpointQuiz);newCheckpoint.units[0].checkpointQuiz.id='test-new-checkpoint';newCheckpoint.units[0].checkpointQuiz.questions.forEach(c=>c.id='test-starter-'+c.id);assert.equal((await release('prepare',16,{sourceRevision:9,additions:newCheckpoint})).status,400);
  const removed=structuredClone(additions);removed.units[0].lessons[0].cards.pop();assert.equal((await release('prepare',16,{sourceRevision:9,additions:removed})).status,400);
  const expanded=structuredClone(additions),nextLesson=structuredClone(expanded.units[0].lessons[0]);nextLesson.id='test-only-l03';nextLesson.title='Synthetic route contract fixture';nextLesson.lessonNumber=3;nextLesson.cards.forEach(c=>c.id='test-next-'+c.id);expanded.units[0].lessons.push(nextLesson);assert.equal((await release('prepare',16,{sourceRevision:9,additions:expanded})).status,400);expanded.learning.starter.lessonIDs.push(nextLesson.id);assert.equal((await release('prepare',16,{sourceRevision:9,additions:expanded})).status,400);expanded.learning.starter.revision='test-route-2';response=await release('prepare',16,{sourceRevision:9,additions:expanded});assert.equal(response.status,200,await response.clone().text());
  const final=await db.prepare('SELECT * FROM managed_catalog WHERE id=?').bind(base.id).first();assert.equal(final.draft_key,draft.draft_key);assert.equal(final.published_key,published.published_key);assert.equal(final.published_revision,9);assert.equal(await (await bucket.get(draft.draft_key)).text(),pausedBytes);
 } finally {await mf.dispose();}
});


test('migration pins approved Spanish before preparation, failed preparation and worker rollback',async()=>{
 const {mf,db,admin,publicCall,bucket}=await harness({through:'0014_managed_catalog.sql'});
 try {
  const base={...course(),id:'spanish-course',title:'Approved Spanish',language:'Spanish'};base.units[0].lessons[0].cards[0].promptImageName='catalog:00000000-0000-4000-8000-000000000001';const paused={...base,privateMarker:'must-not-leak'};
  await bucket.put('approved-r9',JSON.stringify(base));await bucket.put('paused-r10',JSON.stringify(paused));
  await db.prepare("INSERT INTO managed_catalog(id,kind,title,language,status,revision,draft_key,published_key,published_revision,published_title,published_at,created_at,updated_at,updated_by) VALUES('spanish-course','course','Spanish','Spanish','published',10,'paused-r10','approved-r9',9,'Approved Spanish',9,1,10,'fixture')").run();
  await db.prepare("INSERT INTO managed_catalog_revisions(catalog_id,revision,action,content_key,actor,created_at,published) VALUES('spanish-course',9,'publish','approved-r9','fixture',9,1),('spanish-course',10,'save','paused-r10','fixture',10,0)").run();
  await bucket.put('approved-media','fixture-image');
  await db.prepare("INSERT INTO managed_catalog_media(id,catalog_id,object_key,content_type,byte_size,created_at,actor) VALUES('00000000-0000-4000-8000-000000000001','spanish-course','approved-media','image/png',13,1,'fixture')").run();
  await db.prepare("INSERT INTO managed_catalog_public_media(catalog_id,media_id) VALUES('spanish-course','00000000-0000-4000-8000-000000000001')").run();
  const sql=await readFile(new URL('../community-migrations/0015_catalog_deliveries.sql',import.meta.url),'utf8'),triggers=sql.match(/CREATE TRIGGER[\s\S]*?END;/g)||[];
  const statements=sql.replace(/CREATE TRIGGER[\s\S]*?END;/g,'').split(';').map(s=>s.trim()).filter(Boolean);
  await db.batch([...statements,...triggers].map(s=>db.prepare(s)));
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM managed_catalog_deliveries').first()).n,0);
  const oldPublish=()=>db.batch([db.prepare("INSERT INTO managed_catalog_revisions(catalog_id,revision,action,content_key,actor,created_at,published) VALUES('spanish-course',11,'publish','paused-r10','old-writer',11,1)"),db.prepare("DELETE FROM managed_catalog_public_media WHERE catalog_id='spanish-course'"),db.prepare("UPDATE managed_catalog SET published_key=draft_key,published_revision=11,revision=11 WHERE id='spanish-course'")]);
  for(const state of ['initial','failed-prepare','archived']) {
   if(state==='failed-prepare')assert.equal((await admin('spanish-course/delivery','POST',{operation:'prepare',profile:'practice-v1',expectedRevision:10,sourceRevision:9,additions:{}})).status,400);
   if(state==='archived')await db.prepare("UPDATE managed_catalog SET status='archived',published_key=NULL,published_revision=NULL WHERE id='spanish-course'").run();
   await assert.rejects(oldPublish,/pinned/);
   assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM managed_catalog_public_media WHERE catalog_id='spanish-course'").first()).n,1);
   assert.equal(await db.prepare("SELECT revision FROM managed_catalog_revisions WHERE catalog_id='spanish-course' AND revision=11").first(),null);
  }
  await db.prepare("UPDATE managed_catalog SET status='published',published_key='approved-r9',published_revision=9 WHERE id='spanish-course'").run();
  assert.deepEqual((await (await publicCall('spanish-course')).json()).document,base);
  assert.equal(await (await bucket.get('paused-r10')).text(),JSON.stringify(paused));
  assert.equal((await admin('spanish-course/archive','POST',{expectedRevision:10})).status,200);
  await assert.rejects(()=>db.prepare("DELETE FROM managed_catalog_media WHERE id='00000000-0000-4000-8000-000000000001'").run());
  const restored=await admin('spanish-course/delivery','POST',{operation:'restoreApproved',profile:'practice-v1',expectedRevision:11});
  assert.equal(restored.status,200,await restored.clone().text());
  assert.equal((await publicCall('media/00000000-0000-4000-8000-000000000001')).status,200);
  assert.deepEqual((await (await publicCall('spanish-course')).json()).document,base);

 } finally {await mf.dispose();}
});

test('approved modern lexical/concept semantics cannot be reassigned under existing credit IDs',async()=>{
 const fixture=JSON.parse(await readFile(new URL('./fixtures/visual-starter-delivery.json',import.meta.url),'utf8'));
 const base={...course(),id:'spanish-course',language:'Spanish'}, additions={units:[fixture.unit],learning:fixture.learning};
 const previous=composeDelivery(base,additions);validateCatalogContent('course',previous,base.id,{publish:true,deliveryProfile:'practice-v1'});
 const vocabularyID=Object.keys(fixture.learning.vocabulary).find(id=>id.includes('dos-cardinal')),conceptID=Object.keys(fixture.learning.concepts)[0];
 for(const mutate of [
  d=>{d.learning.vocabulary[vocabularyID].lemma='perro';d.learning.vocabulary[vocabularyID].meaning='dog';},
  d=>d.learning.vocabulary[vocabularyID].locale='es-MX',
  d=>d.learning.vocabulary[vocabularyID].article='la',
  d=>d.learning.concepts[conceptID].vocabularyIDs=[],
  d=>d.learning.concepts[conceptID].prerequisiteIDs=[Object.keys(d.learning.concepts).find(id=>id!==conceptID)]
 ]) {
  const changed=structuredClone(additions);mutate(changed);const candidate=composeDelivery(base,changed);
  assert.throws(()=>requireStableDeliveryIDs(previous,candidate),error=>error.status===400);
 }
 const cosmetic=structuredClone(additions);cosmetic.learning.vocabulary[vocabularyID].image='catalog:00000000-0000-4000-8000-000000000001';cosmetic.learning.vocabulary[vocabularyID].meaning='  TWO  ';cosmetic.learning.concepts[conceptID].title='A clearer display title';
 assert.doesNotThrow(()=>requireStableDeliveryIDs(previous,composeDelivery(base,cosmetic)));
});

test('prepare and activate both reject reassigning approved modern senses',async()=>{
 const {mf,db,admin,bucket}=await harness();
 try {
  const base={...course(),id:'spanish-course',title:'Spanish',language:'Spanish'};
  assert.equal((await admin('','POST',{id:base.id,kind:'course',document:base})).status,201);
  assert.equal((await admin(base.id+'/publish','POST',{expectedRevision:1})).status,200);
  const fixture=JSON.parse(await readFile(new URL('./fixtures/visual-starter-delivery.json',import.meta.url),'utf8'));
  for(let i=1;i<=4;i++) {const id='00000000-0000-4000-8000-'+String(i).padStart(12,'0'),key='fixture/'+id;await bucket.put(key,'fixture-image');await db.prepare('INSERT INTO managed_catalog_media(id,catalog_id,object_key,content_type,byte_size,created_at,actor) VALUES(?,?,?,?,?,1,?)').bind(id,base.id,key,'image/png',13,'fixture').run();}
  const additions={units:[fixture.unit],learning:fixture.learning},changed=structuredClone(additions);
  changed.learning.vocabulary['pf-sp-lex-dos-cardinal-two'].lemma='perro';changed.learning.vocabulary['pf-sp-lex-dos-cardinal-two'].meaning='dog';
  const release=(operation,expectedRevision,extra={})=>admin(base.id+'/delivery','POST',{operation,profile:'practice-v1',expectedRevision,...extra});
  for(const [expectedRevision,data] of [[2,additions],[3,changed]]) {const response=await release('prepare',expectedRevision,{sourceRevision:2,additions:data});assert.equal(response.status,200,await response.clone().text());}
  assert.equal((await release('activate',4,{deliveryRevision:3})).status,200);
  for(const [operation,extra] of [['activate',{deliveryRevision:4}],['prepare',{sourceRevision:2,additions:changed}]]) {
   const response=await release(operation,5,extra);assert.equal(response.status,400,await response.clone().text());
  }
  assert.equal((await db.prepare("SELECT revision FROM managed_catalog_deliveries WHERE profile='practice-v1' AND state='active'").first()).revision,3);
 } finally {await mf.dispose();}
});
