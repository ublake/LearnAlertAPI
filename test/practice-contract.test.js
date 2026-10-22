import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { validateCatalogContent } from '../src/lib/catalogValidation.js';
const image=n=>`catalog:00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const fixture=()=>({id:'practice',title:'Spanish (SP)',language:'Spanish',flagEmoji:'🇪🇸',levelTag:'Beginner',colorHex:'#42685A',summary:'Local contract fixture',estimatedHours:1,outcomes:[],learning:{vocabulary:{'es.libro.object':{lemma:'libro',article:'el',meaning:'book',locale:'es-ES',image:image(1)}},concepts:{recognize:{title:'Recognize',vocabularyIDs:['es.libro.object'],prerequisiteIDs:[]},construct:{title:'Construct',vocabularyIDs:['es.libro.object'],prerequisiteIDs:['recognize']}}},units:[{id:'u',unitNumber:1,title:'First words',subtitle:'',colorHex:'#42685A',badgeIcon:'book',lessons:[{id:'l',lessonNumber:1,title:'Look and build',subtitle:'',nodeType:'lesson',estimatedMinutes:3,cards:[{id:'picture',question:'Find el libro',options:['A closed book','A backpack'],correctAnswer:'A closed book',correctOptionIndex:0,cardType:'multipleChoice',fieldMedia:{'option:0':{image:image(1)},'option:1':{image:image(2)}},activity:{kind:'situation',sequence:1,exercise:{format:'pictureChoice',vocabularyIDs:['es.libro.object'],conceptIDs:['recognize'],pictures:[{id:'book',image:image(1),description:'A closed book'},{id:'bag',image:image(2),description:'A backpack'}],correctChoiceID:'book'}}},{id:'bank',question:'Build: I see a book.',correctAnswer:'Veo un libro',cardType:'tokenPlacement',activity:{kind:'placeTokens',sequence:2,tokens:['Veo','un','libro'],slots:['Veo','un','libro'],exercise:{format:'wordBank',vocabularyIDs:['es.libro.object'],conceptIDs:['construct'],tiles:[{id:'see',text:'Veo'},{id:'a',text:'un'},{id:'book',text:'libro'}],acceptedOrders:[['Veo','un','libro']]}}}]}]}]});
const validate=c=>validateCatalogContent('course',c,c.id,{publish:true});
test('practice graph and real typed picture refs retain legacy representations and unknown metadata',()=>{
 const c=fixture();c.future={preserved:true};assert.equal(validate(c).content,c);
 const old=structuredClone(c);delete old.learning;for(const card of old.units[0].lessons[0].cards)delete card.activity.exercise;
 assert.equal(validate(old).content,old);
});
test('publication rejects dangling and cyclic learning references',()=>{
 for(const mutate of [c=>c.learning.concepts.recognize.prerequisiteIDs.push('construct'),c=>c.learning.concepts.recognize.vocabularyIDs.push('missing'),c=>c.units[0].lessons[0].cards[0].activity.exercise.conceptIDs.push('missing')]){
  const c=fixture();mutate(c);assert.throws(()=>validate(c));
 }
});
test('picture IDs, reading alternatives, real media and correctness remain aligned',()=>{
 for(const mutate of [e=>e.pictures[0].id='bag',e=>e.pictures[0].image='catalog:placeholder',e=>e.pictures[0].description='',e=>e.correctChoiceID='bag']){
  const c=fixture();mutate(c.units[0].lessons[0].cards[0].activity.exercise);assert.throws(()=>validate(c));
 }
});
test('finite inventory rejects impossible answers, duplicate IDs and downlevel-incompatible duplicates',()=>{
 for(const mutate of [e=>e.acceptedOrders.push(['un','un','libro']),e=>e.tiles[1].id='see',e=>e.acceptedOrders=[],e=>e.tiles[0].text='incompatible']){
  const c=fixture();mutate(c.units[0].lessons[0].cards[1].activity.exercise);assert.throws(()=>validate(c));
 }
});


test('every present known optional exercise field must decode even when inactive',()=>{
 for(const [cardIndex,key,value] of [[1,'pictures','invalid'],[0,'tiles',[{id:1,text:false}]],[0,'acceptedOrders','invalid'],[1,'correctChoiceID',42],[1,'pictures',[{id:'x',image:false,description:3}]]]){
  const c=fixture();c.units[0].lessons[0].cards[cardIndex].activity.exercise[key]=value;
  assert.throws(()=>validate(c), `native Codable would reject inactive ${key}`);
 }
});


test('shared native fixture accepts typed inactive fields and preserves unknown properties',()=>{
 const c=JSON.parse(readFileSync(new URL('./fixtures/practice-contract-valid.json',import.meta.url),'utf8'));
 assert.equal(validate(c).content,c);assert.deepEqual(c.futureMetadata,{preserved:true});
});

test('label/meaning choices preserve native types, explicit identity and playable legacy options',()=>{
 const c=fixture(),card=c.units[0].lessons[0].cards[0];
 card.options=['el libro','la mochila'];card.correctAnswer='el libro';card.optionImageNames=[];card.fieldMedia={};
 card.question='Choose the label for this book.';card.activity.exercise={format:'choice',vocabularyIDs:['es.libro.object'],conceptIDs:['recognize'],choices:[{id:'book',text:'el libro'},{id:'bag',text:'la mochila'}],correctChoiceID:'book',prerequisiteIDs:[],stimulusText:'book'};
 assert.equal(validate(c).content,c);
 for(const mutate of [e=>e.choices[0].text=7,e=>e.pairs={},e=>e.prerequisiteIDs=[4],e=>e.stimulusText=5,e=>e.stimulusCount=3,e=>e.correctChoiceID='bag']){const bad=structuredClone(c);mutate(bad.units[0].lessons[0].cards[0].activity.exercise);assert.throws(()=>validate(bad));}
});
test('explicit two-pair matching links independent targets without crediting support and aligns fallback media',()=>{
 const c=fixture(),card=c.units[0].lessons[0].cards[0];card.cardType='matching';card.options=[];delete card.correctOptionIndex;card.correctAnswer='Matches';card.matchingLeftItems=['el libro','la mochila'];card.matchingRightItems=['book','backpack'];card.fieldMedia={'right:0':{image:image(1)},'right:1':{image:image(2)}};
 card.activity.kind='matchPairs';card.activity.exercise={format:'matching',vocabularyIDs:['es.libro.object'],conceptIDs:['recognize'],pairs:[{id:'p1',label:'el libro',description:'book',image:image(1),vocabularyIDs:['es.libro.object'],conceptIDs:['recognize']},{id:'p2',label:'la mochila',description:'backpack',image:image(2),vocabularyIDs:['es.libro.object'],conceptIDs:['recognize']}]};
 assert.equal(validate(c).content,c);
 for(const mutate of [e=>e.pairs[0].conceptIDs=['support-only'],e=>e.pairs[0].image='placeholder',e=>e.pairs[0].description='different',e=>e.pairs[0].vocabularyIDs=3]){const bad=structuredClone(c);mutate(bad.units[0].lessons[0].cards[0].activity.exercise);assert.throws(()=>validate(bad));}
});
test('starter route and assessment drafts round-trip but cannot publish before capability rollout',()=>{
 const c=fixture();c.learning.starter={id:'pf-sp-starter-v1',revision:'pilot-1',lessonIDs:['pf-sp-l01','pf-sp-l02'],assessment:{futureAuthoringMetadata:true}};
 assert.equal(validateCatalogContent('course',c,c.id).content,c);
 assert.throws(()=>validate(c),/capability release gate/);
});

test('course prerequisites resolve earlier lesson cards and reject missing, cyclic or unsupported sequencing',()=>{
 const valid=fixture(), first=valid.units[0].lessons[0].cards[0], second=valid.units[0].lessons[0].cards[1];
 first.activity.exercise.prerequisiteIDs=[];second.activity.exercise.prerequisiteIDs=[first.id];
 assert.equal(validate(valid).content,valid);
 for(const mutate of [c=>c.units[0].lessons[0].cards[1].activity.exercise.prerequisiteIDs=['never-declared-card'],c=>c.units[0].lessons[0].cards[0].activity.exercise.prerequisiteIDs=['picture'],c=>{c.units[0].lessons[0].cards[0].activity.exercise.prerequisiteIDs=['bank'];},c=>{c.units[0].lessons[0].cards[0].activity.exercise.prerequisiteIDs=['bank'];c.units[0].lessons[0].cards[1].activity.exercise.prerequisiteIDs=[];}]) {
  const bad=structuredClone(valid);mutate(bad);assert.throws(()=>validate(bad));
 }
 const cross=structuredClone(valid),lesson=cross.units[0].lessons[0];
 cross.units[0].lessons.push({...structuredClone(lesson),id:'next-lesson',lessonNumber:2,cards:[lesson.cards.pop()]});
 cross.futureMetadata={retained:true};assert.equal(validate(cross).content,cross);assert.deepEqual(cross.futureMetadata,{retained:true});
 const cloned=structuredClone(cross);for(const l of cloned.units[0].lessons)for(const card of l.cards){const old=card.id;card.id='clone-'+old;card.activity.exercise.prerequisiteIDs=card.activity.exercise.prerequisiteIDs.map(id=>'clone-'+id);}
 assert.equal(validate(cloned).content,cloned);
});

test('prerequisites follow stable sequence order, allow prior exposures and reject checkpoint teaching edges',()=>{
 const c=fixture(),lesson=c.units[0].lessons[0],picture=lesson.cards[0],bank=lesson.cards[1];
 const exposure=structuredClone(picture);exposure.id='reveal';exposure.activity.kind='teach';exposure.activity.example='el libro';exposure.activity.sequence=0;exposure.activity.exercise={format:'exposure',vocabularyIDs:['es.libro.object'],conceptIDs:['recognize']};
 lesson.cards.push(exposure);picture.activity.exercise.prerequisiteIDs=['reveal'];bank.activity.exercise.prerequisiteIDs=['picture'];
 assert.equal(validate(c).content,c);assert.equal(lesson.cards[2].id,'reveal');
 const sameSequence=structuredClone(c);sameSequence.units[0].lessons[0].cards[2].activity.sequence=1;assert.throws(()=>validate(sameSequence),/earlier/);
 const duplicate=structuredClone(c);duplicate.units[0].lessons[0].cards[0].activity.exercise.prerequisiteIDs=['reveal','reveal'];assert.throws(()=>validate(duplicate),/unique/);
 c.units[0].checkpointQuiz={id:'cp',title:'Check',summary:'',passingScoreThreshold:0.8,keyConcepts:[],questions:[{...structuredClone(picture),id:'cp-q'}]};
 assert.equal(validate(c).content,c);
 const checkpointSource=structuredClone(c);checkpointSource.units[0].lessons[0].cards[1].activity.exercise.prerequisiteIDs=['cp-q'];assert.throws(()=>validate(checkpointSource),/checkpoint/);
 const cpSibling=structuredClone(c);cpSibling.units[0].checkpointQuiz.questions.push({...structuredClone(picture),id:'cp-q2'});cpSibling.units[0].checkpointQuiz.questions[1].activity.exercise.prerequisiteIDs=['cp-q'];assert.throws(()=>validate(cpSibling),/checkpoint/);
 const noGraph=structuredClone(c);delete noGraph.learning;for(const card of [...noGraph.units[0].lessons[0].cards,...noGraph.units[0].checkpointQuiz.questions])delete card.activity.exercise;
 assert.equal(validate(noGraph).content,noGraph);
});
