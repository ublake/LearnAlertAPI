import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { validateCatalogContent } from '../src/lib/catalogValidation.js';

const bindings={ADMIN_ACCESS_ISSUER:'https://catalog-test.cloudflareaccess.com',ADMIN_ACCESS_AUD:'catalog-test',ADMIN_EMAILS:'admin@example.test'};
const b64=value=>Buffer.from(typeof value==='string'?value:JSON.stringify(value)).toString('base64url');
async function harness() {
  const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
  const jwk={...await crypto.subtle.exportKey('jwk',pair.publicKey),kid:'catalog-test',alg:'RS256'};
  const now=Math.floor(Date.now()/1000),message=`${b64({alg:'RS256',kid:jwk.kid})}.${b64({iss:bindings.ADMIN_ACCESS_ISSUER,aud:[bindings.ADMIN_ACCESS_AUD],email:bindings.ADMIN_EMAILS,iat:now,exp:now+600})}`;
  const jwt=`${message}.${Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,new TextEncoder().encode(message))).toString('base64url')}`;
  const bundle=await build({entryPoints:['src/index.js'],bundle:true,write:false,format:'esm',platform:'browser'});
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-09-04',bindings,d1Databases:['COMMUNITY_DB'],r2Buckets:['DECK_ASSETS'],outboundService:()=>new Response(JSON.stringify({keys:[jwk]}))}));
  const db=await mf.getD1Database('COMMUNITY_DB');
  for(const file of (await readdir(new URL('../community-migrations/',import.meta.url))).sort()) {
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
