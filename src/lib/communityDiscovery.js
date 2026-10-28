import { CommunityError } from './communityValidation.js';

// Fixed clauses only: a query value is never interpolated into SQL.
const orders = Object.freeze({
  popular: 'd.download_count DESC, d.published_at DESC, d.id DESC',
  downloads: 'd.download_count DESC, d.published_at DESC, d.id DESC',
  likes: 'like_count DESC, d.published_at DESC, d.id DESC',
  recent: 'd.published_at DESC, d.id DESC',
  newest: 'd.published_at DESC, d.id DESC',
  oldest: 'd.published_at ASC, d.id ASC'
});

export function communityDiscoveryOrder(value) {
  return Object.hasOwn(orders, value) ? orders[value] : orders.recent;
}

const languages = Object.freeze({
  en: { words: ['english'] },
  es: { words: ['spanish', 'español', 'espanol', 'castellano'] },
  fr: { words: ['french', 'français', 'francais'] },
  de: { words: ['german', 'deutsch'] },
  it: { words: ['italian', 'italiano', 'italiana'] },
  pt: { words: ['portuguese', 'português', 'portugues'] },
  ko: { words: ['korean', 'hangul', 'hangeul'], native: ['한국어', '한글', '조선말'] },
  ja: { words: ['japanese', 'nihongo'], native: ['日本語', 'にほんご'] },
  zh: { words: ['chinese', 'mandarin'], native: ['中文', '汉语', '漢語', '普通话', '普通話'] },
  ar: { words: ['arabic'], native: ['العربية', 'عربي'] }
});

// SQLite's lower() handles ASCII; explicitly fold the accented capitals used by
// these native language names. GLOB boundaries avoid matches such as Englishman.
const metadataSQL = `replace(replace(replace(replace(lower(' ' || COALESCE(d.name,'') || ' ' ||
  COALESCE(d.description,'') || ' ' || COALESCE(d.category_tag,'') || ' '),
  'Ñ','ñ'),'Ç','ç'),'Ê','ê'),'É','é')`;

export function communityLanguageFilter(value) {
  const code = (value || '').trim().toLowerCase();
  if (!code) return { sql: '', parameters: [] };
  if (!Object.hasOwn(languages, code)) {
    throw new CommunityError(400, 'Choose a supported language filter.');
  }
  const language = languages[code];
  const clauses = language.words.map(() => `${metadataSQL} GLOB ?`);
  const parameters = language.words.map(word => `*[^a-zà-ɏ]${word}[^a-zà-ɏ]*`);
  for (const native of language.native || []) {
    // These languages do not consistently separate language names with spaces.
    clauses.push(`instr(${metadataSQL}, ?) > 0`);
    parameters.push(native);
  }
  return { sql: ` AND (${clauses.join(' OR ')})`, parameters };
}
