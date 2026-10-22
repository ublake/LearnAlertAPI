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
