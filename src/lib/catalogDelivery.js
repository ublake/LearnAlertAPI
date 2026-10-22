import { CommunityError } from './communityValidation.js';
export const PRACTICE_PROFILE='practice-v1';
export const PRACTICE_CONTRACTS=Object.freeze(['exercise-v1','matching-evidence-v1','finite-bank-v1','route-v1','assessment-v1']);
export const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',typeof bytes==='string'?new TextEncoder().encode(bytes):bytes))).map(x=>x.toString(16).padStart(2,'0')).join('');
export function acceptsPractice(request) {
 const url=new URL(request.url),caps=new Set((request.headers.get('X-LearnAlert-Contracts') ?? '').split(',').map(x=>x.trim()).filter(Boolean));
 return url.searchParams.get('profile')===PRACTICE_PROFILE && PRACTICE_CONTRACTS.every(x=>caps.has(x));
}
export function composeDelivery(base, additions) {
 if(!additions || typeof additions!=='object' || Array.isArray(additions) || Object.keys(additions).some(x=>!['units','learning'].includes(x)) || !Array.isArray(additions.units) || !additions.units.length || !additions.learning || !additions.learning.starter) throw new CommunityError(400,'Provide only new units and a reviewed learning graph with a starter route.');
 const oldIDs=new Set(base.units.flatMap(u=>[u.id,...u.lessons.flatMap(l=>[l.id,...l.cards.map(c=>c.id)])]));
 for(const unit of additions.units) {
  if(!unit || !Array.isArray(unit.lessons) || oldIDs.has(unit.id))throw new CommunityError(400,'Delivery additions must use new unit and lesson IDs.');
  for(const lesson of unit.lessons)if(!lesson || !Array.isArray(lesson.cards) || oldIDs.has(lesson.id) || lesson.cards.some(c=>oldIDs.has(c.id)))throw new CommunityError(400,'Delivery additions cannot replace legacy IDs.');
 }
 const newLessons=new Set(additions.units.flatMap(u=>u.lessons.map(l=>l.id)));if(!Array.isArray(additions.learning.starter.lessonIDs)||newLessons.size!==new Set(additions.learning.starter.lessonIDs).size||additions.learning.starter.lessonIDs.some(id=>!newLessons.has(id)))throw new CommunityError(400,'The visual starter route references its additive lessons, not legacy gates.');
 const graph=base.learning ?? {vocabulary:{},concepts:{}};
 requireStableLearningSemantics({learning:graph},{learning:{vocabulary:{...graph.vocabulary,...additions.learning.vocabulary},concepts:{...graph.concepts,...additions.learning.concepts}}});
 return {...base,units:[...base.units,...additions.units],learning:{...graph,...additions.learning,vocabulary:{...graph.vocabulary,...additions.learning.vocabulary},concepts:{...graph.concepts,...additions.learning.concepts}}};
}
export function validateStarterDelivery(document) {
 const s=document.learning?.starter, ids=new Set(document.units.flatMap(u=>u.lessons.map(l=>l.id))), cards=new Set(document.units.flatMap(u=>u.lessons.flatMap(l=>l.cards.map(c=>c.id))));
 const fail=()=>{throw new CommunityError(400,'Invalid starter route or bounded starter assessment contract.');};
 if(!s || typeof s.id!=='string' || !s.id || typeof s.revision!=='string' || !s.revision || !Array.isArray(s.lessonIDs) || !s.lessonIDs.length || new Set(s.lessonIDs).size!==s.lessonIDs.length || s.lessonIDs.some(id=>!ids.has(id)))fail();
 if(document.units.some(u=>u.checkpointQuiz && u.lessons.some(l=>s.lessonIDs.includes(l.id))))fail();
 const ordered=document.units.flatMap(u=>u.lessons.map(l=>l.id)).filter(id=>s.lessonIDs.includes(id));if(JSON.stringify(ordered)!==JSON.stringify(s.lessonIDs))fail();
 const a=s.assessment;
 if(!a || a.id!=='pf-sp-a01' || typeof a.title!=='string' || !a.title.trim() || typeof a.revision!=='string' || !a.revision || JSON.stringify(a.lessonIDs)!==JSON.stringify(['pf-sp-l01','pf-sp-l02']) || a.lessonIDs.some(id=>!s.lessonIDs.includes(id)) || !Array.isArray(a.objectiveIDs) || a.objectiveIDs.length!==4 || a.objectiveIDs.some(x=>typeof x!=='string'||!x.trim()) || new Set(a.objectiveIDs).size!==4 || a.passingTotal!==10 || a.passingPerObjective!==2 || !a.forms || Object.keys(a.forms).sort().join(',')!=='a,b')fail();
 const itemIDs=new Set();
 for(const items of Object.values(a.forms)) {
  if(!Array.isArray(items)||items.length!==12)fail();
  for(const item of items) {
   if(!item || typeof item.card?.id!=='string' || !item.card.id || itemIDs.has(item.card.id) || cards.has(item.card?.id) || !a.objectiveIDs.includes(item.objectiveID) || !Array.isArray(item.remediationLessonIDs) || !item.remediationLessonIDs.length || item.remediationLessonIDs.some(id=>!a.lessonIDs.includes(id)) || !item.card?.activity?.exercise || item.card.activity.exercise.format==='exposure')fail();
   itemIDs.add(item.card.id);
  }
  for(const objective of a.objectiveIDs)if(items.filter(x=>x.objectiveID===objective).length!==3)fail();
  const assessed=new Set(items.flatMap(x=>x.card.activity.exercise.conceptIDs ?? []));
  for(const lesson of document.units.flatMap(x=>x.lessons).filter(x=>a.lessonIDs.includes(x.id)))for(const card of lesson.cards) {
   const targets=card.activity?.exercise?.conceptIDs;
   if(!Array.isArray(targets) || !targets.length || targets.some(x=>!assessed.has(x)))fail();
  }
 }
 return a;
}

function canonical(value) {
 if(Array.isArray(value))return value.map(canonical);
 if(value && typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
 return value;
}
// Display titles, artwork and unknown extension metadata may be corrected.
// These fields define the credited lexical sense/concept and cannot be reused
// for a different meaning. Normalise cosmetic case/spacing only, never accents.
const semanticText=value=>typeof value==='string'?value.trim().replace(/\s+/gu,' ').toLocaleLowerCase('en-US'):value ?? null;
const semanticSet=value=>[...new Set(value ?? [])].sort();
function learningSemantics(kind,value) {
 return kind==='vocabulary'
  ? {lemma:semanticText(value.lemma),meaning:semanticText(value.meaning),locale:semanticText(value.locale),article:semanticText(value.article)}
  : {prerequisiteIDs:semanticSet(value.prerequisiteIDs),vocabularyIDs:semanticSet(value.vocabularyIDs)};
}
export function requireStableLearningSemantics(previous,candidate) {
 for(const kind of ['vocabulary','concepts'])for(const [id,value] of Object.entries(previous.learning?.[kind] ?? {})) {
  const next=candidate.learning?.[kind]?.[id];
  if(!next || JSON.stringify(learningSemantics(kind,value))!==JSON.stringify(learningSemantics(kind,next)))throw new CommunityError(400,'Published lexical meanings and concept dependencies keep their identity; new meanings need new IDs.');
 }
}
export function requireStableDeliveryIDs(previous, candidate) {
 requireStableLearningSemantics(previous,candidate);
 const ids=document=>document.units.flatMap(u=>[u.id,...u.lessons.flatMap(l=>[l.id,...l.cards.map(c=>c.id)]),...(u.checkpointQuiz?[u.checkpointQuiz.id,...u.checkpointQuiz.questions.map(c=>c.id)]:[])]);
 const available=new Set(ids(candidate));
 const oldRoute=previous.learning?.starter,nextRoute=candidate.learning?.starter;
 if(oldRoute && (!nextRoute || oldRoute.id!==nextRoute.id || (JSON.stringify(oldRoute.lessonIDs)!==JSON.stringify(nextRoute.lessonIDs) && oldRoute.revision===nextRoute.revision)))throw new CommunityError(400,'A changed route keeps its identity and needs an explicit new route revision.');
 const nextUnits=new Map(candidate.units.map(u=>[u.id,u])),nextLessons=new Map(candidate.units.flatMap(u=>u.lessons).map(l=>[l.id,l]));
 for(const unit of previous.units) {
  const next=nextUnits.get(unit.id);
  if(!next || JSON.stringify(canonical(unit.checkpointQuiz ?? null))!==JSON.stringify(canonical(next.checkpointQuiz ?? null)) || (unit.checkpointQuiz && JSON.stringify(unit.lessons.map(l=>l.id).sort())!==JSON.stringify(next.lessons.map(l=>l.id).sort())))throw new CommunityError(400,'Assigned checkpoints stay unchanged; extend checkpoint-bearing material in new units.');
  for(const lesson of unit.lessons) {
   const nextLesson=nextLessons.get(lesson.id);
   if(!nextLesson || JSON.stringify(lesson.cards.map(c=>c.id).sort())!==JSON.stringify(nextLesson.cards.map(c=>c.id).sort()))throw new CommunityError(400,'Existing lesson membership stays pinned; add retrieval variants in new lessons.');
  }
 }
 const oldCards=previous.units.flatMap(u=>u.lessons.flatMap(l=>l.cards)),newCards=new Map(candidate.units.flatMap(u=>u.lessons.flatMap(l=>l.cards)).map(c=>[c.id,c]));
 for(const card of oldCards)if(card.activity?.exercise) {const next=newCards.get(card.id)?.activity?.exercise;if(!next || ['vocabularyIDs','conceptIDs','prerequisiteIDs'].some(key=>JSON.stringify([...(card.activity.exercise[key] ?? [])].sort())!==JSON.stringify([...(next[key] ?? [])].sort())))throw new CommunityError(400,'Published exercise targets keep their stable identity; new meanings need new IDs.');}
 const scope=doc=>{const a=doc.learning?.starter?.assessment;if(!a)return null;const cards=doc.units.flatMap(u=>u.lessons).filter(l=>a.lessonIDs.includes(l.id)).flatMap(l=>l.cards);return JSON.stringify({vocabulary:[...new Set(cards.flatMap(c=>c.activity?.exercise?.vocabularyIDs ?? []))].sort(),concepts:[...new Set(cards.flatMap(c=>c.activity?.exercise?.conceptIDs ?? []))].sort()});};
 if(previous.learning?.starter?.assessment?.revision === candidate.learning?.starter?.assessment?.revision && scope(previous)!==scope(candidate))throw new CommunityError(400,'Changed assessment scope needs an explicitly reviewed assessment revision.');
 if(ids(previous).some(id=>!available.has(id)))throw new CommunityError(400,'A new delivery must retain previously published stable unit, lesson and card IDs. Use an explicit approved rollback for an older snapshot.');
}
