import { validateStarterDelivery, validateDialogues, MODERN_PROFILES, CAFE_PROFILE } from './catalogDelivery.js';
import { CommunityError, readCommunityJSON } from './communityValidation.js';

// A transport budget, not a curriculum/card-count limit. R2 keeps large courses
// outside D1's per-row limit. Unknown fields survive round trips and revisions.
export const CATALOG_JSON_MAXIMUM = 16 * 1024 * 1024;
export const catalogIDPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const courseTypes = new Set(['multipleChoice','vocabulary','tapReveal','matching','fillBlank','listening','listeningWrite','images','hangulBuild','tokenPlacement','hangulTrace']);
const deckTypes = new Set(['multiple_choice','vocabulary','tap_reveal','matching','fill_blank','images','anki']);
const activityKinds = new Set(['teach','trace','buildBlock','placeTokens','listenChoose','situation','matchPairs']);
const nodeTypes = new Set(['lesson','practice','checkpoint','cultural_tip']);
function fail(path, message) { throw new CommunityError(400, `${path}: ${message}`, 'CATALOG_VALIDATION'); }
function object(value, path) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected an object.'); return value; }
function string(value, path, required = false) { if (typeof value !== 'string' || (required && !value.trim())) fail(path, required ? 'enter a nonempty text value.' : 'expected text.'); return value; }
function array(value, path) { if (!Array.isArray(value)) fail(path, 'expected a list.'); return value; }
function strings(value, path) { array(value, path).forEach((entry, index) => string(entry, `${path}[${index}]`)); }
function numeric(value, path, min = 0) { if (!Number.isSafeInteger(value) || value < min) fail(path, `expected a whole number of at least ${min}.`); }
function identifiers(values, path, globallySeen) {
  const local = new Set();
  values.forEach((entry, index) => {
    object(entry, `${path}[${index}]`); string(entry.id, `${path}[${index}].id`, true);
    if (local.has(entry.id) || globallySeen?.has(entry.id)) fail(`${path}[${index}].id`, 'duplicate ID. Keep IDs stable and unique.');
    local.add(entry.id); globallySeen?.add(entry.id);
  });
}
function color(value, path) { if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) fail(path, 'use a six-digit hex color.'); }
function optionalStrings(value, fields, path) { for (const key of fields) if (value[key] !== undefined && value[key] !== null) string(value[key], `${path}.${key}`); }
function fieldHasMedia(card, field) {
  const media = card.fieldMedia?.[field];
  // Match CardFieldMedia's native-key precedence, including explicit empties,
  // then the same top-level Name overrides used by resolvedFieldMedia in-app.
  let image = media?.image ?? media?.imageID, audio = media?.audio ?? media?.audioID;
  if (field === 'prompt') {
    if (card.promptImageName != null) image = card.promptImageName;
    if (card.promptAudioName != null) audio = card.promptAudioName;
  } else if (field === 'answer' && card.answerImageName != null) image = card.answerImageName;
  else if (/^option:\d+$/.test(field)) {
    const optionImage = card.optionImageNames?.[Number(field.slice(7))];
    if (typeof optionImage === 'string' && optionImage.length) image = optionImage;
  }
  return [image,audio].some(value => typeof value === 'string' && value.trim());
}
function normalizedAnswer(value) { return value.normalize('NFC').toLowerCase().replace(/[\p{White_Space}\p{P}]/gu, ''); }
function validateAnswerability(card, path, course) {
  const activity = card.activity?.kind;
  const matching = activity === 'matchPairs' || !activity && card.cardType === 'matching';
  if (matching) {
    const left = card.matchingLeftItems ?? [], right = card.matchingRightItems ?? [];
    if (!left.length || left.length !== right.length) fail(path, 'matching cards need the same nonzero number of left and right items.');
    for (const [side,items] of [['left',left],['right',right]]) items.forEach((value,index) => {
      if (!value.trim() && !fieldHasMedia(card,`${side}:${index}`)) fail(`${path}.matching${side === 'left' ? 'Left' : 'Right'}Items[${index}]`,'add text, an image or audio for this matching item.');
    });
  }
  const quiz = activity === 'listenChoose' || activity === 'situation' || !activity && ['multipleChoice','multiple_choice','listening'].includes(card.cardType);
  if (quiz) {
    const options = card.options ?? [];
    if (options.length < 2) fail(`${path}.options`, 'quiz cards need at least two answer choices.');
    if (!card.question.trim() && !fieldHasMedia(card,'prompt') && !(card.cardType === 'listening' || activity === 'listenChoose') ) fail(`${path}.question`,'add text, an image or audio for the question.');
    options.forEach((value,index) => {
      if (!value.trim() && !fieldHasMedia(card,`option:${index}`)) fail(`${path}.options[${index}]`,'add text, an image or audio for this answer choice.');
    });
    const answers = [card.correctAnswer,...(card.acceptedAnswers ?? [])];
    const matches = value => course ? answers.some(answer => normalizedAnswer(answer) && normalizedAnswer(answer) === normalizedAnswer(value)) : card.correctAnswer === value;
    const mediaChoices = options.some((_,index) => fieldHasMedia(card,`option:${index}`));
    const answerMatches = course && !mediaChoices ? options.some(matches) : options.includes(card.correctAnswer);
    if (card.correctOptionIndex == null && !answerMatches || course && !mediaChoices && !answerMatches) fail(`${path}.correctAnswer`,'the correct answer must match an available choice, or set correctOptionIndex for a media choice.');
    if (card.correctOptionIndex != null && options.includes(card.correctAnswer) && options[card.correctOptionIndex] !== card.correctAnswer) fail(`${path}.correctOptionIndex`,'the selected correct option contradicts correctAnswer.');
    if (!mediaChoices && new Set(options).size !== options.length) fail(`${path}.options`,'text answer choices must be distinct.');
  }
}
function validateCard(card, path, course, learning, modern = false) {
  object(card, path); string(card.id, `${path}.id`, true);
  string(card.question, `${path}.question`); string(card.correctAnswer, `${path}.correctAnswer`);
  const types = course ? courseTypes : deckTypes;
  if (!types.has(card.cardType)) fail(`${path}.cardType`, 'unsupported card type for the app.');
  for (const field of ['options','matchingLeftItems','matchingRightItems','optionImageNames','optionImageIDs','acceptedAnswers']) if (card[field] != null) strings(card[field], `${path}.${field}`);
  optionalStrings(card, ['hint','promptImageName','answerImageName','promptImageID','answerImageID','promptAudioName','promptAudioID','grammarNote','speechText','conceptTag','explanation','readingPrompt','previousQuestion','sectionName'], path);
  if (card.correctOptionIndex != null && (!Number.isInteger(card.correctOptionIndex) || card.correctOptionIndex < 0 || card.correctOptionIndex >= (card.options?.length || 0))) fail(`${path}.correctOptionIndex`, 'choose an existing answer.');
  if (card.fieldMedia != null) {
    object(card.fieldMedia, `${path}.fieldMedia`);
    for (const [key, media] of Object.entries(card.fieldMedia)) {
      object(media, `${path}.fieldMedia.${key}`); optionalStrings(media, ['imageID','audioID','image','audio'], `${path}.fieldMedia.${key}`);
    }
  }
  if (card.activity != null) {
    const activity = object(card.activity, `${path}.activity`);
    if (!activityKinds.has(activity.kind)) fail(`${path}.activity.kind`, 'unsupported activity.');
    numeric(activity.sequence, `${path}.activity.sequence`);
    if (activity.layout != null && !['beside','below','besideWithFinal','belowWithFinal','inline'].includes(activity.layout)) fail(`${path}.activity.layout`, 'unsupported block layout.');
    for (const field of ['tokens','slots','slotLabels']) if (activity[field] != null) strings(activity[field], `${path}.activity.${field}`);
    if (activity.optionHints != null) { object(activity.optionHints, `${path}.activity.optionHints`); Object.entries(activity.optionHints).forEach(([key,value]) => string(value, `${path}.activity.optionHints.${key}`)); }
    optionalStrings(activity, ['rule','example','symbol','readingCue','practiceGroup'], `${path}.activity`);
  }
  if (card.vocabularyItem != null) {
    const vocab = object(card.vocabularyItem, `${path}.vocabularyItem`);
    for (const field of ['surface','dictionaryForm','romanization','partOfSpeech','contextualMeaning']) string(vocab[field], `${path}.vocabularyItem.${field}`);
    optionalStrings(vocab, ['breakdownNote','exampleKorean','exampleEnglish','audioText'], `${path}.vocabularyItem`);
  }
  validateAnswerability(card, path, course);
  if (card.activity?.exercise != null) validatePracticeExercise(card, path, learning, modern);
  if (card.cardType === 'anki') {
    const anki = object(card.ankiContent, `${path}.ankiContent`);
    for (const field of ['frontHTML','backHTML','css','mediaFolder','noteType']) string(anki[field], `${path}.ankiContent.${field}`);
    numeric(anki.templateOrdinal, `${path}.ankiContent.templateOrdinal`); strings(anki.tags ?? [], `${path}.ankiContent.tags`);
  }
}

export async function readCatalogJSON(request) { return object(await readCommunityJSON(request, false, CATALOG_JSON_MAXIMUM), 'request'); }
export function expectedCatalogRevision(body) {
  if (!body || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1) fail('expectedRevision', 'reload the latest revision before changing content.');
  return body.expectedRevision;
}
export function validateCatalogContent(kind, content, id, { publish = false, deliveryProfile = null } = {}) {
  if (!['course','exam'].includes(kind)) fail('kind', 'choose course or exam.');
  if (typeof id !== 'string' || !catalogIDPattern.test(id)) fail('id', 'use 1–128 letters, numbers, dots, underscores or hyphens.');
  object(content, 'content');
  if (content.id !== id) fail('content.id', 'must match the catalog ID.');
  const title = content.title ?? content.name;
  string(title, 'content.title', true);
  color(content.colorHex, 'content.colorHex');
  if (!publish) return { content, title, summary: summarize(kind, content) };
  if (kind === 'course') {
    for (const field of ['title','language','flagEmoji','levelTag','summary']) string(content[field], `content.${field}`, field === 'title' || field === 'language');
    numeric(content.estimatedHours, 'content.estimatedHours'); strings(content.outcomes, 'content.outcomes');
    const learning = validateLearningGraph(content.learning);
    if (learning?.starter != null && !MODERN_PROFILES.includes(deliveryProfile)) fail('content.learning.starter', 'starter routes and assessments are draft/preview only until a supported-client capability release gate is deployed.');
    const units = array(content.units, 'content.units'); if (!units.length) fail('content.units', 'a published course needs at least one unit.');
    identifiers(units, 'content.units');
    const lessonIDs = new Set(), cardIDs = new Set(), checkpointIDs = new Set();
    units.forEach((unit, u) => {
      const path = `content.units[${u}]`; string(unit.title, `${path}.title`, true); string(unit.subtitle, `${path}.subtitle`);
      numeric(unit.unitNumber, `${path}.unitNumber`, 1); color(unit.colorHex, `${path}.colorHex`); string(unit.badgeIcon, `${path}.badgeIcon`);
      const lessons = array(unit.lessons, `${path}.lessons`); identifiers(lessons, `${path}.lessons`, lessonIDs);
      if (!lessons.length) fail(`${path}.lessons`, 'a published unit needs at least one lesson.');
      lessons.forEach((lesson, l) => {
        const lp = `${path}.lessons[${l}]`; string(lesson.title, `${lp}.title`, true); string(lesson.subtitle, `${lp}.subtitle`);
        numeric(lesson.lessonNumber, `${lp}.lessonNumber`, 1); numeric(lesson.estimatedMinutes, `${lp}.estimatedMinutes`);
        if (!nodeTypes.has(lesson.nodeType)) fail(`${lp}.nodeType`, 'unsupported lesson type.');
        optionalStrings(lesson, ['tipNote'], lp); const cards = array(lesson.cards, `${lp}.cards`);
        if (!cards.length) fail(`${lp}.cards`, 'a published lesson needs at least one card.');
        identifiers(cards, `${lp}.cards`, cardIDs); cards.forEach((card,c) => validateCard(card, `${lp}.cards[${c}]`, true, learning, deliveryProfile));
      });
      if (unit.checkpointQuiz != null) {
        const checkpoint = object(unit.checkpointQuiz, `${path}.checkpointQuiz`); string(checkpoint.id, `${path}.checkpointQuiz.id`, true);
        if (checkpointIDs.has(checkpoint.id)) fail(`${path}.checkpointQuiz.id`, 'duplicate checkpoint ID.'); checkpointIDs.add(checkpoint.id);
        string(checkpoint.title, `${path}.checkpointQuiz.title`, true); string(checkpoint.summary, `${path}.checkpointQuiz.summary`);
        if (typeof checkpoint.passingScoreThreshold !== 'number' || checkpoint.passingScoreThreshold < 0 || checkpoint.passingScoreThreshold > 1) fail(`${path}.checkpointQuiz.passingScoreThreshold`, 'use a value between 0 and 1.');
        strings(checkpoint.keyConcepts, `${path}.checkpointQuiz.keyConcepts`);
        const questions = array(checkpoint.questions, `${path}.checkpointQuiz.questions`);
        if (!questions.length) fail(`${path}.checkpointQuiz.questions`, 'a checkpoint needs at least one question.');
        identifiers(questions, `${path}.checkpointQuiz.questions`, cardIDs); questions.forEach((card,c) => validateCard(card, `${path}.checkpointQuiz.questions[${c}]`, true, learning, deliveryProfile));
      }
    });
    validateCoursePrerequisites(units);
    if (MODERN_PROFILES.includes(deliveryProfile)) {
      validateDialogues(content,deliveryProfile);
      const assessment = validateStarterDelivery(content);
      for (const [form,items] of Object.entries(assessment.forms)) for (const item of items) {
        validateCard(item.card, `content.learning.starter.assessment.forms.${form}`, true, learning, deliveryProfile);
        if(item.card.activity.exercise.context!=null || item.card.activity.exercise.models!=null || !['choice','pictureChoice','wordBank'].includes(item.card.activity.exercise.format))fail('content.learning.starter.assessment','The scoped starter check uses only unassisted choices and finite banks, never dialogue or reveal semantics.');
        if ((item.card.activity.exercise.prerequisiteIDs ?? []).some(id=>!cardIDs.has(id))) fail('content.learning.starter.assessment', 'assessment teaching references must belong to the course.');
      }
    }
    if (content.guides != null) {
      object(content.guides, 'content.guides');
      for (const [unitID, topics] of Object.entries(content.guides)) {
        if (!units.some(unit => unit.id === unitID)) fail(`content.guides.${unitID}`, 'guide must belong to an existing unit.');
        array(topics, `content.guides.${unitID}`).forEach((topic,t) => {
          const path = `content.guides.${unitID}[${t}]`; object(topic,path);
          string(topic.title,`${path}.title`,true); string(topic.rule,`${path}.rule`); strings(topic.examples,`${path}.examples`);
        });
      }
    }
    if (content.guidePresentation != null) {
      object(content.guidePresentation,'content.guidePresentation');
      for (const [unitID, value] of Object.entries(content.guidePresentation)) {
        if (!units.some(unit => unit.id === unitID)) fail(`content.guidePresentation.${unitID}`, 'presentation must belong to an existing unit.');
        object(value,`content.guidePresentation.${unitID}`);
        if (typeof value.showsHangulDiagram !== 'boolean') fail(`content.guidePresentation.${unitID}.showsHangulDiagram`,'expected true or false.');
        optionalStrings(value,['referenceTitle','referenceURL','diagramTitle','diagramFooter'],`content.guidePresentation.${unitID}`);
        if (value.diagramExamples != null) array(value.diagramExamples,`content.guidePresentation.${unitID}.diagramExamples`).forEach((example,index) => {
          const path = `content.guidePresentation.${unitID}.diagramExamples[${index}]`; object(example,path);
          for (const field of ['syllable','caption','initial','vowel']) string(example[field],`${path}.${field}`);
          optionalStrings(example,['finalLetter'],path);
          if (example.layout != null && !['beside','below'].includes(example.layout)) fail(`${path}.layout`,'use beside or below.');
        });
        if (value.referenceURL && !/^https:\/\//i.test(value.referenceURL)) fail(`content.guidePresentation.${unitID}.referenceURL`,'use an HTTPS reference URL.');
      }
    }
  } else {
    for (const field of ['name','category','subcategory','description','deckType']) string(content[field], `content.${field}`, field === 'name');
    const cards = array(content.cards, 'content.cards'); if (!cards.length) fail('content.cards', 'a published deck needs at least one card.');
    identifiers(cards, 'content.cards'); cards.forEach((card,c) => validateCard(card, `content.cards[${c}]`, false));
  }
  return { content, title, summary: summarize(kind, content) };
}
export function summarize(kind, content) {
  if (kind === 'exam') return { cardCount: Array.isArray(content.cards) ? content.cards.length : 0, category: content.category || '', subcategory: content.subcategory || '' };
  const units = Array.isArray(content.units) ? content.units.filter(unit => unit && typeof unit === 'object') : [];
  return { unitCount: units.length, lessonCount: units.reduce((n,u) => n + (Array.isArray(u.lessons) ? u.lessons.length : 0),0), cardCount: units.reduce((n,u) => n + (Array.isArray(u.lessons) ? u.lessons : []).reduce((m,l) => m + (Array.isArray(l?.cards) ? l.cards.length : 0),0) + (u.checkpointQuiz?.questions?.length || 0),0), guideCount: content.guides && typeof content.guides === 'object' ? Object.keys(content.guides).length : 0 };
}


// Additive practice metadata always carries a fully playable legacy representation.
function validateLearningGraph(learning) {
  if (learning == null) return null;
  object(learning, 'content.learning');
  const vocabulary = object(learning.vocabulary, 'content.learning.vocabulary');
  const concepts = object(learning.concepts, 'content.learning.concepts');
  for (const [id, sense] of Object.entries(vocabulary)) {
    if (!catalogIDPattern.test(id)) fail('content.learning.vocabulary', 'invalid stable lexical-sense ID.');
    object(sense, `vocabulary.${id}`);
    for (const field of ['lemma','meaning','locale']) string(sense[field], `vocabulary.${id}.${field}`, field !== 'lemma');
    if (!sense.lemma.trim() && !(typeof sense.article === 'string' && sense.article.trim())) fail(`vocabulary.${id}`, 'provide a lemma or functional article surface.');
    optionalStrings(sense, ['article','image'], `vocabulary.${id}`);
  }
  for (const [id, concept] of Object.entries(concepts)) {
    if (!catalogIDPattern.test(id)) fail('content.learning.concepts', 'invalid stable concept ID.');
    object(concept, `concepts.${id}`); string(concept.title, `concepts.${id}.title`, true);
    strings(concept.prerequisiteIDs, `concepts.${id}.prerequisiteIDs`); strings(concept.vocabularyIDs, `concepts.${id}.vocabularyIDs`);
    if (concept.prerequisiteIDs.some(key => !Object.hasOwn(concepts, key)) || concept.vocabularyIDs.some(key => !Object.hasOwn(vocabulary, key))) fail(`concepts.${id}`, 'dangling prerequisite or vocabulary reference.');
  }
  const visited = new Set();
  function visit(id, stack = new Set()) {
    if (stack.has(id) || stack.size > 128) fail('content.learning.concepts', 'prerequisites must be acyclic and bounded.');
    if (visited.has(id)) return;
    const next = new Set(stack); next.add(id);
    concepts[id].prerequisiteIDs.forEach(key => visit(key, next)); visited.add(id);
  }
  Object.keys(concepts).forEach(id => visit(id));
  return learning;
}
function validatePracticeExercise(card, path, learning, modern = false) {
  const exercise = object(card.activity.exercise, `${path}.activity.exercise`);
  const ep = `${path}.activity.exercise`;
  if (!['pictureChoice','choice','matching','textMatching','wordBank','exposure'].includes(exercise.format)) fail(ep, 'unsupported practice format.');
  for (const field of ['vocabularyIDs','conceptIDs']) {
    strings(exercise[field], `${ep}.${field}`);
    const dictionary = field === 'vocabularyIDs' ? learning?.vocabulary : learning?.concepts;
    if (exercise[field].some(id => !dictionary || !Object.hasOwn(dictionary, id))) fail(`${ep}.${field}`, 'reference a declared lexical sense or concept.');
  }
  if (!exercise.vocabularyIDs.length || !exercise.conceptIDs.length) fail(ep, 'link at least one lexical sense and concept.');
  if ((exercise.format==='textMatching'||exercise.context!=null||exercise.models!=null||exercise.showsMeaningLabels!=null) && modern!==CAFE_PROFILE) fail(ep,'Contextual practice needs practice-v2 capability delivery.');
  if (exercise.showsMeaningLabels!=null && typeof exercise.showsMeaningLabels!=='boolean') fail(ep,'showsMeaningLabels must be boolean.');
  if (exercise.models!=null) array(exercise.models,`${ep}.models`).forEach((model,i)=>{
    object(model,`${ep}.models[${i}]`);for(const key of ['spanish','meaning'])string(model[key],`${ep}.models[${i}].${key}`,true);
  });
  if (exercise.context!=null) {
    const context=object(exercise.context,`${ep}.context`);
    for(const key of ['cashierText','goalText','goalFeedback','dialogueID','dialogueStepID','audioReference']) if(context[key]!=null)string(context[key],`${ep}.context.${key}`,true);
    if((context.dialogueID==null)!==(context.dialogueStepID==null))fail(ep,'Dialogue and step identity must be provided together.');
    if(context.goalMismatchChoiceIDs!=null)strings(context.goalMismatchChoiceIDs,`${ep}.context.goalMismatchChoiceIDs`);
    if(context.goalMismatchOrders!=null)array(context.goalMismatchOrders,`${ep}.context.goalMismatchOrders`).forEach((order,i)=>strings(order,`${ep}.context.goalMismatchOrders[${i}]`));
    if(context.audioReference!=null) {
      if(!/^catalog:[0-9a-f-]{36}$/i.test(context.audioReference)||learning?.audioQA?.status!=='owner-approved'||typeof learning.audioQA.reviewNote!=='string'||!learning.audioQA.reviewNote.trim())fail(ep,'Stored cashier audio requires explicit owner QA approval metadata before publication.');
    }
  }
  // Codable decodes every known optional property, even when this format
  // does not render it. Validate all present shapes before semantic branches.
  if (exercise.correctChoiceID != null) string(exercise.correctChoiceID, `${ep}.correctChoiceID`);
  if (exercise.pictures != null) array(exercise.pictures, `${ep}.pictures`).forEach((picture, index) => {
    object(picture, `${ep}.pictures[${index}]`);
    for (const field of ['id','image','description']) string(picture[field], `${ep}.pictures[${index}].${field}`);
  });
  if (exercise.tiles != null) array(exercise.tiles, `${ep}.tiles`).forEach((tile, index) => {
    object(tile, `${ep}.tiles[${index}]`);
    for (const field of ['id','text']) string(tile[field], `${ep}.tiles[${index}].${field}`);
  });
  if (exercise.acceptedOrders != null) array(exercise.acceptedOrders, `${ep}.acceptedOrders`).forEach((order, index) => strings(order, `${ep}.acceptedOrders[${index}]`));
  if (exercise.prerequisiteIDs != null) strings(exercise.prerequisiteIDs, `${ep}.prerequisiteIDs`);
  if (exercise.stimulusText != null) string(exercise.stimulusText, `${ep}.stimulusText`);
  if (exercise.stimulusCount != null) { numeric(exercise.stimulusCount, `${ep}.stimulusCount`, 1); if (exercise.stimulusCount > 2) fail(ep, 'this stimulus supports one or two objects.'); }
  if (exercise.choices != null) array(exercise.choices, `${ep}.choices`).forEach((choice,index) => {
    object(choice, `${ep}.choices[${index}]`); for (const key of ['id','text']) string(choice[key], `${ep}.choices[${index}].${key}`);
  });
  if (exercise.pairs != null) array(exercise.pairs, `${ep}.pairs`).forEach((pair,index) => {
    object(pair, `${ep}.pairs[${index}]`);
    for (const key of ['id','label','image','description']) string(pair[key], `${ep}.pairs[${index}].${key}`);
    for (const key of ['vocabularyIDs','conceptIDs']) strings(pair[key], `${ep}.pairs[${index}].${key}`);
  });
  if(exercise.context!=null) { const context=exercise.context;
    if(context.goalMismatchChoiceIDs?.some(id=>id===exercise.correctChoiceID||!exercise.choices?.some(c=>c.id===id)))fail(ep,'Goal-mismatch choices must be offered non-target replies.');
    if(context.goalMismatchOrders?.some(order=>!order.length||order.some(word=>order.filter(x=>x===word).length>(exercise.tiles ?? []).filter(x=>x.text===word).length)||exercise.acceptedOrders?.some(x=>JSON.stringify(x)===JSON.stringify(order))))fail(ep,'Goal-mismatch orders must be constructible non-target variants.');
  }
  if (exercise.format === 'choice') {
    const choices = array(exercise.choices, `${ep}.choices`); identifiers(choices, `${ep}.choices`);
    if (card.activity.kind !== 'situation' || choices.length < 2 || choices.length > 6 || JSON.stringify(choices.map(x=>x.text)) !== JSON.stringify(card.options)) fail(ep, 'choices need two to six legacy-aligned situation options.');
    choices.forEach(x=>string(x.text, ep, true));
    if (exercise.stimulusText && !card.question.toLocaleLowerCase().includes(exercise.stimulusText.toLocaleLowerCase())) fail(ep, 'the legacy prompt must retain the complete reading stimulus.');
    const correct = choices.findIndex(x=>x.id === exercise.correctChoiceID);
    if (correct < 0 || correct !== card.correctOptionIndex || card.correctAnswer !== card.options[correct]) fail(ep, 'choice correctness must match its legacy fallback.');
    return;
  }
  if (['matching','textMatching'].includes(exercise.format)) {
    const pairs = array(exercise.pairs, `${ep}.pairs`); identifiers(pairs, `${ep}.pairs`);
    if (card.activity.kind !== 'matchPairs' || pairs.length !== 2 || JSON.stringify(pairs.map(x=>x.label)) !== JSON.stringify(card.matchingLeftItems) || JSON.stringify(pairs.map(x=>x.description)) !== JSON.stringify(card.matchingRightItems)) fail(ep, 'two explicit pairs must match the complete legacy matching board.');
    pairs.forEach((pair,index)=>{
      for (const key of ['label','description']) string(pair[key], ep, true);
      if (exercise.format==='textMatching') { if(pair.image!==''||card.fieldMedia?.[`right:${index}`]?.image)fail(ep,'Text matching has readable meanings, not invented image references.'); }
      else if (!/^catalog:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pair.image) || card.fieldMedia?.[`right:${index}`]?.image !== pair.image) fail(ep, 'matching needs real catalog images and aligned legacy right-side media.');
      for (const key of ['vocabularyIDs','conceptIDs']) {
        if (!pair[key].length || pair[key].some(id=>!exercise[key].includes(id))) fail(ep, 'pair evidence must target declared exercise concepts and senses only.');
      }
    });
    return;
  }
  if (exercise.format === 'exposure') {
    if (card.activity.kind !== 'teach' || !card.activity.example?.trim()) fail(ep, 'exposure needs a teach fallback with its short example.');
    return;
  }
  if (exercise.format === 'pictureChoice') {
    if (card.activity.kind !== 'situation') fail(ep, 'picture choices need a situation fallback.');
    const pictures = array(exercise.pictures, `${ep}.pictures`); identifiers(pictures, `${ep}.pictures`);
    if (pictures.length < 2 || pictures.length > 4 || pictures.length !== card.options?.length) fail(ep, 'use two to four pictures aligned with legacy options.');
    pictures.forEach((picture, index) => {
      string(picture.description, `${ep}.pictures[${index}].description`, true);
      string(picture.image, `${ep}.pictures[${index}].image`, true);
      if (!/^catalog:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(picture.image)) fail(ep, 'picture choices require actual typed catalog media references.');
      const legacy = card.optionImageNames?.[index] || (card.fieldMedia?.[`option:${index}`]?.image ?? card.fieldMedia?.[`option:${index}`]?.imageID);
      if (legacy !== picture.image) fail(ep, 'legacy choice media must match the picture identity.');
      if (card.options[index] !== picture.description) fail(ep, 'legacy options must provide the complete reading alternatives.');
    });
    const correct = pictures.findIndex(picture => picture.id === exercise.correctChoiceID);
    if (correct < 0 || correct !== card.correctOptionIndex || card.correctAnswer !== card.options[correct]) fail(ep, 'picture correctness must agree with the legacy fallback.');
    return;
  }
  if (card.activity.kind !== 'placeTokens') fail(ep, 'finite banks need a placeTokens fallback.');
  const tiles = array(exercise.tiles, `${ep}.tiles`); identifiers(tiles, `${ep}.tiles`);
  if (!tiles.length || tiles.length > 40) fail(ep, 'use one to forty finite tile instances.');
  tiles.forEach((tile, index) => string(tile.text, `${ep}.tiles[${index}].text`, true));
  const orders = array(exercise.acceptedOrders, `${ep}.acceptedOrders`);
  if (!orders.length || orders.length > 20) fail(ep, 'provide one to twenty reviewed accepted orders.');
  if (!modern && orders.length > 1) fail(ep, 'multiple accepted orders require a client capability gate before publication.');
  orders.forEach((order, index) => {
    strings(order, `${ep}.acceptedOrders[${index}]`); if (!order.length) fail(ep, 'answers cannot be empty.');
    const inventory = tiles.map(tile => tile.text);
    for (const word of order) { const at = inventory.indexOf(word); if (at < 0) fail(ep, 'accepted answer exceeds finite token inventory.'); inventory.splice(at, 1); }
  });
  if (JSON.stringify(card.activity.slots) !== JSON.stringify(orders[0]) || JSON.stringify([...(card.activity.tokens || [])].sort()) !== JSON.stringify(tiles.map(tile => tile.text).sort())) fail(ep, 'legacy tokens and slots must match the finite bank.');
  // Legacy string-identity banks cannot express duplicate required words safely.
  // Such content needs a later capability gate; keep this first rollout playable.
  if (!modern && new Set(card.activity.tokens).size !== card.activity.tokens.length) fail(ep, 'repeated bank words require a client capability gate before publication.');
}

// The managed planner orders declared prerequisites by lesson sequence, while
// checkpoints are shuffled and cannot teach a prerequisite for another card.
function validateCoursePrerequisites(units) {
  const nodes = new Map(); let rank = 0;
  units.forEach((unit,u) => {
    unit.lessons.forEach((lesson,l) => {
      const cards = lesson.cards.map((card,index)=>({card,index}));
      if (cards.some(({card})=>card.activity?.exercise?.prerequisiteIDs != null))
        cards.sort((a,b)=>(a.card.activity?.sequence ?? 0)-(b.card.activity?.sequence ?? 0) || a.index-b.index);
      cards.forEach(({card,index})=>nodes.set(card.id,{card,rank:rank++,checkpoint:false,path:`content.units[${u}].lessons[${l}].cards[${index}].activity.exercise.prerequisiteIDs`}));
    });
    for (const [index,card] of (unit.checkpointQuiz?.questions ?? []).entries())
      nodes.set(card.id,{card,rank:rank++,checkpoint:true,path:`content.units[${u}].checkpointQuiz.questions[${index}].activity.exercise.prerequisiteIDs`});
  });
  const incoming = new Map(), dependents = new Map();
  for (const [id,node] of nodes) {
    const refs=node.card.activity?.exercise?.prerequisiteIDs ?? [];
    if (new Set(refs).size !== refs.length) fail(node.path,'prerequisites must be unique.');
    incoming.set(id,refs.length);
    for (const ref of refs) {
      if (!nodes.has(ref)) fail(node.path,'prerequisite must reference an existing course card.');
      if (ref === id) fail(node.path,'a card cannot depend on itself.');
      const list=dependents.get(ref) ?? [];list.push(id);dependents.set(ref,list);
    }
  }
  const queue=[...incoming].filter(([,count])=>count===0).map(([id])=>id);let visited=0;
  for (let index=0;index<queue.length;index++) {
    const id=queue[index];visited++;
    for (const child of dependents.get(id) ?? []) { const count=incoming.get(child)-1;incoming.set(child,count);if(count===0)queue.push(child); }
  }
  if (visited !== nodes.size) fail('content.units','card prerequisites must not contain cycles.');
  for (const node of nodes.values()) for (const ref of node.card.activity?.exercise?.prerequisiteIDs ?? []) {
    const target=nodes.get(ref);
    if (target.checkpoint) fail(node.path,'checkpoint questions cannot teach a persistent prerequisite.');
    if (target.rank >= node.rank) fail(node.path,'prerequisites must be taught earlier in the supported lesson order.');
  }
}
