import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCommunityDeck, communityContentSignature } from '../src/lib/communityValidation.js';
const image = crypto.randomUUID(), audio = crypto.randomUUID();
const validate = card => validateCommunityDeck({ name: 'Media', cards: [{ id: 'card', ...card }] });
test('quiz choices with empty/duplicate text retain explicit identities and media kinds', () => {
  const card = { cardType: 'multiple_choice', question: '', options: ['', '', 'same', 'same'], correctOptionIndex: 1,
    fieldMedia: { prompt: { audioID: audio }, 'option:0': { imageID: image }, 'option:1': { audioID: audio }, hint: { audioID: audio, imageID: image } } };
  const result = validate(card);
  assert.equal(communityContentSignature(Array.from({ length: 3 }, () => ({ ...result.cards[0], question: 'Which sound?' }))), null);
  assert.equal(result.cards[0].correctOptionIndex, 1);
  assert.equal(result.cards[0].correctAnswer, '');
  assert.deepEqual([...result.media].sort(), [[audio, 'audio'], [image, 'image']].sort());
  for (const patch of [{ correctOptionIndex: undefined }, { correctOptionIndex: 4 }, { correctOptionIndex: 1.5 }, { fieldMedia: { ...card.fieldMedia, 'option:1': {} } }]) assert.throws(() => validate({ ...card, ...patch }), error => error.status === 400);
  assert.equal(validate({ cardType: 'multiple_choice', question: 'Q', options: ['A','B'], correctAnswer: 'B' }).cards[0].correctOptionIndex, 1);
});
test('reveal, vocabulary and blank cards accept media on either side without fabricated text', () => {
  for (const cardType of ['tap_reveal','vocabulary','fill_blank']) {
    const result = validate({ cardType, fieldMedia: { prompt: { imageID: image }, answer: { audioID: audio } } });
    assert.equal(result.cards[0].question, ''); assert.equal(result.cards[0].correctAnswer, '');
    assert.equal(result.cards[0].fieldMedia.answer.audioID, audio);
    assert.throws(() => validate({ cardType, question: '', correctAnswer: '' }), error => error.status === 400);
  }
});
test('matching pairs use positional identities when every text field is empty', () => {
  const card = { cardType: 'matching', matchingLeftItems: ['', ''], matchingRightItems: ['', ''], fieldMedia: {
    'left:0': { audioID: audio }, 'left:1': { imageID: image }, 'right:0': { imageID: image }, 'right:1': { audioID: audio }
  } };
  assert.equal(validate(card).cards[0].matchingLeftItems.length, 2);
  assert.throws(() => validate({ ...card, fieldMedia: { ...card.fieldMedia, 'right:1': {} } }), error => error.status === 400);
  assert.equal(communityContentSignature(Array.from({ length: 3 }, () => card)), null);
});
test('attachments reject bad slots, hidden fields, malformed IDs, conflicting aliases and mixed media types', () => {
  const base = { cardType: 'tap_reveal', question: 'Q', correctAnswer: 'A' };
  for (const fieldMedia of [[], { junk: { imageID: image } }, { 'option:0': { audioID: audio } }, { answer: { audioID: 'file.wav' } }, { answer: { audioID: audio, url: 'https://example.test' } }, { prompt: { imageID: image }, answer: { audioID: image } }]) assert.throws(() => validate({ ...base, fieldMedia }), error => error.status === 400);
  assert.throws(() => validate({ ...base, promptImageID: image, fieldMedia: { prompt: { imageID: crypto.randomUUID() } } }), error => error.status === 400);
});
