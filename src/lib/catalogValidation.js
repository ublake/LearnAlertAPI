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
function fieldHasMedia(card, field, legacy = []) {
  const media = card.fieldMedia?.[field];
  return ['image','audio','imageID','audioID'].some(key => typeof media?.[key] === 'string' && media[key].trim()) || legacy.some(value => typeof value === 'string' && value.trim());
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
    if (!card.question.trim() && !fieldHasMedia(card,'prompt',[card.promptImageName,card.promptAudioName,card.promptImageID,card.promptAudioID]) && !(card.cardType === 'listening' || activity === 'listenChoose') ) fail(`${path}.question`,'add text, an image or audio for the question.');
    options.forEach((value,index) => {
      if (!value.trim() && !fieldHasMedia(card,`option:${index}`,[card.optionImageNames?.[index],card.optionImageIDs?.[index]])) fail(`${path}.options[${index}]`,'add text, an image or audio for this answer choice.');
    });
    const answers = [card.correctAnswer,...(card.acceptedAnswers ?? [])];
    const matches = value => course ? answers.some(answer => normalizedAnswer(answer) && normalizedAnswer(answer) === normalizedAnswer(value)) : card.correctAnswer === value;
    const mediaChoices = options.some((_,index) => fieldHasMedia(card,`option:${index}`,[card.optionImageNames?.[index],card.optionImageIDs?.[index]]));
    const answerMatches = course && !mediaChoices ? options.some(matches) : options.includes(card.correctAnswer);
    if (card.correctOptionIndex == null && !answerMatches || course && !mediaChoices && !answerMatches) fail(`${path}.correctAnswer`,'the correct answer must match an available choice, or set correctOptionIndex for a media choice.');
    if (card.correctOptionIndex != null && options.includes(card.correctAnswer) && options[card.correctOptionIndex] !== card.correctAnswer) fail(`${path}.correctOptionIndex`,'the selected correct option contradicts correctAnswer.');
    if (!mediaChoices && new Set(options).size !== options.length) fail(`${path}.options`,'text answer choices must be distinct.');
  }
}
function validateCard(card, path, course) {
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
export function validateCatalogContent(kind, content, id, { publish = false } = {}) {
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
        identifiers(cards, `${lp}.cards`, cardIDs); cards.forEach((card,c) => validateCard(card, `${lp}.cards[${c}]`, true));
      });
      if (unit.checkpointQuiz != null) {
        const checkpoint = object(unit.checkpointQuiz, `${path}.checkpointQuiz`); string(checkpoint.id, `${path}.checkpointQuiz.id`, true);
        if (checkpointIDs.has(checkpoint.id)) fail(`${path}.checkpointQuiz.id`, 'duplicate checkpoint ID.'); checkpointIDs.add(checkpoint.id);
        string(checkpoint.title, `${path}.checkpointQuiz.title`, true); string(checkpoint.summary, `${path}.checkpointQuiz.summary`);
        if (typeof checkpoint.passingScoreThreshold !== 'number' || checkpoint.passingScoreThreshold < 0 || checkpoint.passingScoreThreshold > 1) fail(`${path}.checkpointQuiz.passingScoreThreshold`, 'use a value between 0 and 1.');
        strings(checkpoint.keyConcepts, `${path}.checkpointQuiz.keyConcepts`);
        const questions = array(checkpoint.questions, `${path}.checkpointQuiz.questions`);
        if (!questions.length) fail(`${path}.checkpointQuiz.questions`, 'a checkpoint needs at least one question.');
        identifiers(questions, `${path}.checkpointQuiz.questions`, cardIDs); questions.forEach((card,c) => validateCard(card, `${path}.checkpointQuiz.questions[${c}]`, true));
      }
    });
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
