export class CommunityError extends Error {
  constructor(status, message) { super(message); this.status = status; }
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

export async function readCommunityJSON(request) {
  const bytes = await readLimitedBody(request, 1024 * 1024);
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

export function deckMetadata(body) {
  if (!body || typeof body !== 'object') throw new CommunityError(400, 'Invalid deck.');
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

export function validateCommunityDeck(body) {
  const metadata = deckMetadata(body);
  if (!Array.isArray(body.cards) || body.cards.length < 1 || body.cards.length > 500) {
    throw new CommunityError(400, 'Publish between 1 and 500 cards per deck.');
  }
  const ids = new Set();
  const media = new Map();
  const cards = body.cards.map(card => {
    if (!card || typeof card !== 'object') throw new CommunityError(400, 'Invalid card.');
    const id = text(card.id, 64, 'Card ID', true);
    if (ids.has(id)) throw new CommunityError(400, 'Card IDs must be unique.');
    ids.add(id);
    if (!['vocabulary','multiple_choice','tap_reveal','matching','fill_blank'].includes(card.cardType)) {
      throw new CommunityError(400, 'Invalid card type.');
    }
    const question = text(card.question, 5000, 'Question', true);
    const correctAnswer = text(card.correctAnswer ?? '', 10000, 'Answer', card.cardType !== 'matching');
    const options = strings(card.options ?? [], 4, 5000, 'answer choices');
    const left = strings(card.matchingLeftItems ?? [], 20, 5000, 'matching items');
    const right = strings(card.matchingRightItems ?? [], 20, 5000, 'matching items');
    if (card.cardType === 'multiple_choice' && (options.length < 2 || options.some(item => !item) || !options.includes(correctAnswer))) {
      throw new CommunityError(400, 'Quiz cards need 2–4 choices including the correct answer.');
    }
    if (card.cardType === 'matching' && (left.length < 2 || left.length !== right.length || [...left, ...right].some(item => !item))) {
      throw new CommunityError(400, 'Matching cards need at least two complete pairs.');
    }
    const promptImageID = mediaID(card.promptImageID);
    const promptAudioID = mediaID(card.promptAudioID);
    if (!Array.isArray(card.optionImageIDs ?? []) || (card.optionImageIDs ?? []).length > options.length) {
      throw new CommunityError(400, 'Invalid answer images.');
    }
    const optionImageIDs = (card.optionImageIDs ?? []).map(mediaID);
    for (const image of [promptImageID, ...optionImageIDs].filter(Boolean)) {
      if (media.get(image) === 'audio') throw new CommunityError(400, 'Invalid media type.');
      media.set(image, 'image');
    }
    if (promptAudioID) {
      if (media.get(promptAudioID) === 'image') throw new CommunityError(400, 'Invalid media type.');
      media.set(promptAudioID, 'audio');
    }
    return { id, question, correctAnswer, options, hint: text(card.hint ?? '', 2000, 'Hint'),
      cardType: card.cardType, matchingLeftItems: left, matchingRightItems: right,
      sectionName: text(card.sectionName ?? '', 120, 'Section'), promptImageID, optionImageIDs, promptAudioID };
  });
  return { metadata, cards, media };
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
