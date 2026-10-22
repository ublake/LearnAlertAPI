export class CommunityError extends Error {
  constructor(status, message, code = 'COMMUNITY_ERROR') { super(message); this.status = status; this.code = code; }
}

export async function readLimitedBody(request, maximum) {
  const declared = request.headers.get('Content-Length');
  if (declared !== null && (!Number.isFinite(Number(declared)) || Number(declared) > maximum)) {
    throw new CommunityError(413, 'This upload is too large.');
  }
  if (!request.body) throw new CommunityError(400, 'The upload is empty.');
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new CommunityError(413, 'This upload is too large.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function readCommunityJSON(request, allowEmpty = false, maximum = 1024 * 1024) {
  if(allowEmpty && !request.body)return {};
  const bytes = await readLimitedBody(request, maximum);
  if(allowEmpty && !bytes.length)return {};
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new CommunityError(400, 'Request body must be valid JSON.'); }
}

function text(value, maximum, label, required = false) {
  if (typeof value !== 'string' || value.length > maximum || (required && !value.trim())) {
    throw new CommunityError(400, `${label} is missing or too long.`);
  }
  return value.trim();
}
function strings(value, maximumCount, maximumLength, label) {
  if (!Array.isArray(value) || value.length > maximumCount) throw new CommunityError(400, `Invalid ${label}.`);
  return value.map(item => text(item, maximumLength, label));
}
function mediaID(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/i.test(value)) throw new CommunityError(400, 'Invalid media reference.');
  return value;
}

export const ankiUploadMessage = 'Uploading decks imported from Anki are not supported yet';
export function deckMetadata(body, developer = false) {
  if (!body || typeof body !== 'object') throw new CommunityError(400, 'Invalid deck.');
  if ((body.origin === 'anki' || body.sourceAnkiDeckID || String(body.deckType).toLowerCase() === 'anki') && !developer) throw new CommunityError(403, ankiUploadMessage);
  if ((body.origin !== undefined && !['personal','anki'].includes(body.origin)) || body.sourceCommunityID || body.sourcePremadeID || String(body.deckType).toLowerCase() === 'course') {
    throw new CommunityError(403, 'Share a deck you created. Built-in and downloaded community decks can’t be republished.');
  }
  const colorHex = text(body.colorHex ?? '#5B70E0', 7, 'Deck color');
  if (!/^#[0-9a-f]{6}$/i.test(colorHex)) throw new CommunityError(400, 'Invalid deck color.');
  return {
    name: text(body.name, 120, 'Deck title', true),
    description: text(body.description ?? '', 2000, 'Description'),
    categoryTag: text(body.categoryTag ?? 'General', 60, 'Category', true),
    colorHex,
    deckType: text(body.deckType ?? 'Mixed', 40, 'Deck type', true)
  };
}

export function validateCommunityDeck(body, developer = false) {
  const metadata = deckMetadata(body, developer);
  const publisherHandle = body.publisherHandle ? text(body.publisherHandle, 80, 'Creator name', true) : null;
  if (publisherHandle && !developer) throw new CommunityError(403, 'Custom publishing names require developer access.');
  const ankiMedia = {};
  const rawAnkiMedia = body.ankiMedia ?? {};
  if (!rawAnkiMedia || typeof rawAnkiMedia !== 'object' || Array.isArray(rawAnkiMedia)) throw new CommunityError(400, 'Invalid Anki media.');
  if (Object.keys(rawAnkiMedia).length && !developer) throw new CommunityError(403, ankiUploadMessage);
  if (!Array.isArray(body.cards) || body.cards.length < 1 || body.cards.length > 500) {
    throw new CommunityError(400, 'Publish between 1 and 500 cards per deck.');
  }
  const ids = new Set();
  const media = new Map();
  for (const [folder, files] of Object.entries(rawAnkiMedia)) {
    if (!/^[a-f0-9-]{36}$/i.test(folder) || !files || typeof files !== 'object' || Array.isArray(files)) throw new CommunityError(400, 'Invalid Anki media folder.');
    const clean = {};
    for (const [name, value] of Object.entries(files)) {
      if (!name || name.length > 255 || name === '.' || name === '..' || /[/\\\x00-\x1f]/.test(name) || ['__proto__','constructor','prototype'].includes(name)) throw new CommunityError(400, 'Invalid Anki media name.');
      const id = mediaID(value);
      if (!id) throw new CommunityError(400, 'Missing Anki media reference.');
      clean[name] = id; media.set(id, 'anki');
      if (media.size > 1000) throw new CommunityError(413, 'Anki decks support up to 1,000 attachments.');
    }
    ankiMedia[folder] = clean;
  }
  const cards = body.cards.map(card => {
    if (!card || typeof card !== 'object') throw new CommunityError(400, 'Invalid card.');
    const id = text(card.id, 64, 'Card ID', true);
    if (ids.has(id)) throw new CommunityError(400, 'Card IDs must be unique.');
    ids.add(id);
    if (card.cardType === 'anki' || card.ankiContent) {
      if (!developer) throw new CommunityError(403, ankiUploadMessage);
      if (card.cardType !== 'anki') throw new CommunityError(400, 'Anki templates require the Anki card type.');
      const content = card.ankiContent;
      if (!content || typeof content !== 'object' || !/^[a-f0-9-]{36}$/i.test(content.mediaFolder) || !Number.isInteger(content.templateOrdinal) || content.templateOrdinal < 0 || content.templateOrdinal > 1000) throw new CommunityError(400, 'Invalid Anki template.');
      return { id, cardType: 'anki', question: text(card.question ?? '', 5000, 'Question'), correctAnswer: text(card.correctAnswer ?? '', 10000, 'Answer'),
        options: [], hint: '', matchingLeftItems: [], matchingRightItems: [], optionImageIDs: [], sectionName: text(card.sectionName ?? '',120,'Section'),
        ankiContent: { frontHTML: text(content.frontHTML, 200000, 'Anki front'), backHTML: text(content.backHTML, 200000, 'Anki back'), css: text(content.css ?? '',100000,'Anki styles'),
          mediaFolder: content.mediaFolder, templateOrdinal: content.templateOrdinal, noteType: text(content.noteType ?? '',120,'Anki note type'), tags: strings(content.tags ?? [],100,120,'Anki tags') } };
    }
    if (!['vocabulary','multiple_choice','tap_reveal','matching','fill_blank','images'].includes(card.cardType)) {
      throw new CommunityError(400, 'Invalid card type.');
    }
    const imageOnly = card.cardType === 'images';
    const question = text(card.question ?? '', 5000, 'Question');
    const correctAnswer = text(card.correctAnswer ?? '', 10000, 'Answer');
    const hint = text(card.hint ?? '', 2000, 'Hint');
    const options = strings(card.options ?? [], 4, 5000, 'answer choices');
    const left = strings(card.matchingLeftItems ?? [], 20, 5000, 'matching items');
    const right = strings(card.matchingRightItems ?? [], 20, 5000, 'matching items');
    if (!Array.isArray(card.optionImageIDs ?? []) || (card.optionImageIDs ?? []).length > options.length) throw new CommunityError(400, 'Invalid answer images.');
    const fieldMedia = {};
    const raw = card.fieldMedia ?? {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length > 47) throw new CommunityError(400, 'Invalid field attachments.');
    const validKeys = new Set(['prompt', 'answer', 'hint', ...options.map((_, i) => `option:${i}`), ...left.map((_, i) => `left:${i}`), ...right.map((_, i) => `right:${i}`)]);
    for (const [key, item] of Object.entries(raw)) {
      if (!validKeys.has(key) || !item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(k => !['imageID','audioID'].includes(k))) throw new CommunityError(400, 'Invalid field attachments.');
      fieldMedia[key] = { imageID: mediaID(item.imageID), audioID: mediaID(item.audioID) };
    }
    function legacy(key, kind, value) {
      const id = mediaID(value);
      if (!id) return;
      fieldMedia[key] ??= { imageID: null, audioID: null };
      if (fieldMedia[key][kind] && fieldMedia[key][kind] !== id) throw new CommunityError(400, 'Conflicting media references.');
      fieldMedia[key][kind] = id;
    }
    legacy('prompt', 'imageID', card.promptImageID);
    legacy('prompt', 'audioID', card.promptAudioID);
    legacy('answer', 'imageID', card.answerImageID);
    (card.optionImageIDs ?? []).forEach((value, i) => legacy(`option:${i}`, 'imageID', value));
    const content = (key, value = '') => Boolean(value || fieldMedia[key]?.imageID || fieldMedia[key]?.audioID);
    let correctOptionIndex = null;
    if (card.cardType === 'multiple_choice' || card.cardType === 'fill_blank' && options.length) {
      if (card.cardType === 'fill_blank' && !/_{2,}|\{blank\}|\[blank\]/.test(question)) throw new CommunityError(400, 'Choice blanks need a ___ in the sentence.');
      correctOptionIndex = card.correctOptionIndex ?? options.indexOf(correctAnswer);
      if (options.length < 2 || options.some((value, i) => !content(`option:${i}`, value)) || !Number.isInteger(correctOptionIndex) || correctOptionIndex < 0 || correctOptionIndex >= options.length) throw new CommunityError(400, 'Quiz cards need 2–4 text, image or audio choices and a correct choice index.');
      if (card.correctOptionIndex == null && (!correctAnswer || options.filter(value => value === correctAnswer).length !== 1)) throw new CommunityError(400, 'Use correctOptionIndex for media-only or duplicate answer text.');
    }
    if (card.cardType === 'matching' && (left.length < 2 || left.length !== right.length || left.some((value, i) => !content(`left:${i}`, value)) || right.some((value, i) => !content(`right:${i}`, value)))) throw new CommunityError(400, 'Matching cards need at least two complete text, image or audio pairs.');
    if (!imageOnly && card.cardType !== 'matching' && !content('prompt', question)) throw new CommunityError(400, 'Add text, an image or audio to the question.');
    if (!imageOnly && !['matching','multiple_choice'].includes(card.cardType) && !(card.cardType === 'fill_blank' && options.length) && !content('answer', correctAnswer)) throw new CommunityError(400, 'Add text, an image or audio to the answer.');
    if (imageOnly && (!fieldMedia.prompt?.imageID || question || correctAnswer || hint || options.length || left.length || right.length || Object.entries(fieldMedia).some(([key, value]) => !['prompt','answer'].includes(key) || value.audioID))) throw new CommunityError(400, 'Image cards need a front image, an optional back image, and no question, answer, hint, choices, matching pairs, or audio.');
    // Reject attachments for fields that the selected card type does not present.
    for (const [key, item] of Object.entries(fieldMedia)) {
      if (key.startsWith('option:') && !['multiple_choice','fill_blank'].includes(card.cardType) || /^(left|right):/.test(key) && card.cardType !== 'matching' || key === 'answer' && ['multiple_choice','matching'].includes(card.cardType)) {
        if (item.imageID || item.audioID) throw new CommunityError(400, 'Attachment field does not belong to this card type.');
      }
      for (const [kind, id] of [['image', item.imageID], ['audio', item.audioID]]) {
        if (!id) continue;
        if (media.has(id) && media.get(id) !== kind) throw new CommunityError(400, 'Invalid media type.');
        media.set(id, kind);
      }
      if (!item.imageID && !item.audioID) delete fieldMedia[key];
    }
    return { id, question, correctAnswer: correctOptionIndex != null ? options[correctOptionIndex] : correctAnswer,
      options, hint, correctOptionIndex, cardType: card.cardType, matchingLeftItems: left, matchingRightItems: right,
      sectionName: text(card.sectionName ?? '', 120, 'Section'), fieldMedia,
      promptImageID: fieldMedia.prompt?.imageID ?? null, answerImageID: fieldMedia.answer?.imageID ?? null,
      optionImageIDs: options.map((_, i) => fieldMedia[`option:${i}`]?.imageID ?? null), promptAudioID: fieldMedia.prompt?.audioID ?? null };
  });
  const usedFolders = new Set(cards.flatMap(card => card.ankiContent ? [card.ankiContent.mediaFolder] : []));
  for (const folder of Object.keys(ankiMedia)) if (!usedFolders.has(folder)) delete ankiMedia[folder];
  const usedAnkiMedia = new Set(Object.values(ankiMedia).flatMap(files => Object.values(files)));
  for (const [id, kind] of media) if (kind === 'anki' && !usedAnkiMedia.has(id)) media.delete(id);
  return { metadata, cards, media, ankiMedia, publisherHandle };
}

export const MEDIA_TYPES = {
  'image/jpeg': { extension: 'jpg', maximum: 10 * 1024 * 1024 },
  'image/png': { extension: 'png', maximum: 10 * 1024 * 1024 },
  'audio/mpeg': { extension: 'mp3', maximum: 20 * 1024 * 1024 },
  'audio/mp4': { extension: 'm4a', maximum: 20 * 1024 * 1024 },
  'audio/wav': { extension: 'wav', maximum: 20 * 1024 * 1024 }
};

export function validateMedia(bytes, contentType) {
  const ascii = (start, end) => String.fromCharCode(...bytes.slice(start, end));
  const valid = bytes.length >= 12 && (
    contentType === 'image/jpeg' && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ||
    contentType === 'image/png' && bytes[0] === 0x89 && ascii(1, 8) === 'PNG\r\n\x1a\n' ||
    contentType === 'audio/mpeg' && (ascii(0, 3) === 'ID3' || bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) ||
    contentType === 'audio/mp4' && ascii(4, 8) === 'ftyp' && ['M4A ', 'M4B ', 'isom', 'mp42'].includes(ascii(8, 12)) ||
    contentType === 'audio/wav' && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE'
  );
  if (!valid) throw new CommunityError(400, 'The file does not match its image or audio format.');
}

export function validateCommunityProfile(body) {
  if (!body || typeof body !== 'object' || typeof body.username !== 'string') {
    throw new CommunityError(400, 'Choose a username.');
  }
  const username = body.username.trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z][a-z0-9_]{2,23}$/.test(username)) {
    throw new CommunityError(400, 'Use 3–24 letters, numbers or underscores, starting with a letter.');
  }
  const avatar = {};
  for (const part of ['hair', 'eyes', 'mouth']) {
    const value = body.avatar?.[part];
    if (!Number.isInteger(value) || value < 0 || value > 15) {
      throw new CommunityError(400, 'Choose a valid character.');
    }
    avatar[part] = value;
  }
  const skinTone = body.avatar?.skinTone === undefined ? 3 : body.avatar.skinTone;
  if (!Number.isInteger(skinTone) || skinTone < 0 || skinTone > 6) {
    throw new CommunityError(400, 'Choose a valid skin tone.');
  }
  avatar.skinTone = skinTone;
  return { handle: `@${username}`, avatar };
}

// Ignore names, card IDs, ordering, and formatting so renaming a public deck does not make it original.
export function communityContentSignature(cards) {
  // Image uploads have no stable content hash in the media schema. Their empty
  // text must not make unrelated photo decks look like copies of each other.
  // Provenance and attachment ownership checks still apply to every image card.
  const textCards = cards.filter(card => card.cardType === 'matching'
    ? card.matchingLeftItems?.length && card.matchingLeftItems.every(value => value.trim()) && card.matchingRightItems?.every(value => value.trim())
    : card.cardType !== 'images' && card.question?.trim() && card.correctAnswer?.trim());
  if (textCards.length < 3) return null;
  const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
  return JSON.stringify(textCards.map(card => JSON.stringify([
    normalize(card.question), normalize(card.correctAnswer),
    (card.matchingLeftItems ?? []).map((left, index) => [normalize(left), normalize(card.matchingRightItems?.[index])]).sort()
  ])).sort());
}

export async function rejectCommunityRepublication(db, cards, ownerID) {
  // A single common fact is not enough evidence of copying; tracked downloads are blocked by provenance.
  if (cards.length < 3) return;
  const signature = communityContentSignature(cards);
  if (!signature) return;
  let afterID = '';
  while (true) {
    const { results } = await db.prepare(`SELECT id,cards_json FROM community_decks
      WHERE status='published' AND owner_id!=? AND card_count=? AND id>? ORDER BY id LIMIT 50`)
      .bind(ownerID, cards.length, afterID).all();
    for (const row of results) {
      if (communityContentSignature(JSON.parse(row.cards_json)) === signature) {
        throw new CommunityError(409, 'This matches an existing community deck. Downloaded decks can’t be republished.');
      }
    }
    if (results.length < 50) return;
    afterID = results.at(-1).id;
  }
}
