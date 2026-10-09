// The ignored local credential or environment supplies the token; never print it.
import { readFile } from 'node:fs/promises';
let localToken;
try { localToken = (await readFile(new URL('../.env.moderation.local', import.meta.url), 'utf8')).trim(); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const [action, deckID] = process.argv.slice(2);
const token = process.env.COMMUNITY_MODERATION_TOKEN || localToken;
const base = process.env.COMMUNITY_API_URL || 'https://api.learnalertapp.com';
if (!token || !['reports', 'remove'].includes(action) || action === 'remove' && !/^[a-f0-9-]{36}$/i.test(deckID || '')) {
  console.error('Set COMMUNITY_MODERATION_TOKEN, then run: node scripts/moderate.mjs reports | remove <deck-id>');
  process.exitCode = 1;
} else {
  try {
    let offset = 0;
    do {
      const path = action === 'reports' ? `reports?offset=${offset}` : `decks/${deckID}`;
      const response = await fetch(`${base}/v1/community/moderation/${path}`, {
        method: action === 'reports' ? 'GET' : 'DELETE', headers: { Authorization: `Bearer ${token}` }
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || `HTTP ${response.status}`);
      if (action === 'reports') console.table(data.reports); else console.log('Public deck removed.');
      offset = data.nextOffset;
    } while (action === 'reports' && offset != null);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
