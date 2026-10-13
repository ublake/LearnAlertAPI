import { CommunityError } from './communityValidation.js';

const adjectives = ['cozy', 'sunny', 'sleepy', 'curious', 'happy', 'tiny', 'bouncy', 'brave', 'mellow', 'jolly', 'dreamy', 'peppy', 'fluffy', 'silly', 'lucky', 'snappy', 'gentle', 'clever', 'chill', 'dizzy', 'starry', 'bright', 'fuzzy', 'zippy', 'minty', 'bubbly', 'jazzy', 'smiley', 'cosmic', 'wiggly', 'quiet', 'spry'];
const nouns = ['otter', 'panda', 'mango', 'mochi', 'bunny', 'kiwi', 'penguin', 'noodle', 'waffle', 'fox', 'peach', 'toast', 'koala', 'puffin', 'pickle', 'turtle', 'jelly', 'cocoa', 'duck', 'melon', 'acorn', 'badger', 'cookie', 'squid', 'llama', 'sprout', 'cloud', 'comet', 'bean', 'owl', 'muffin', 'taco'];

export function generatedCommunityHandle(attempt = 0) {
  const random = crypto.getRandomValues(new Uint32Array(3));
  const words = `${adjectives[random[0] % adjectives.length]}_${nouns[random[1] % nouns.length]}`;
  // Expand the namespace only after several word-only collisions; keep the suffix short.
  return `@${words}${attempt < 16 ? '' : 10 + random[2] % 90}`;
}

export function isLegacyGeneratedHandle(handle) {
  return /^@[a-z]{1,7}_[a-f0-9]{16}$/.test(handle);
}

export async function ensureCommunityUser(db, id, timestamp, candidate = generatedCommunityHandle) {
  const existing = await db.prepare('SELECT id,handle,profile_completed FROM community_users WHERE id=?').bind(id).first();
  if (existing && (existing.profile_completed || !isLegacyGeneratedHandle(existing.handle))) return existing;
  for (let attempt = 0; attempt < 32; attempt++) {
    const handle = candidate(attempt);
    try {
      if (existing) {
        // A simultaneous profile save or another sign-in wins; never rename a completed profile.
        await db.prepare('UPDATE community_users SET handle=? WHERE id=? AND handle=? AND profile_completed=0')
          .bind(handle, id, existing.handle).run();
      } else {
        await db.prepare(`INSERT INTO community_users(id,handle,created_at) SELECT ?,?,?
          WHERE NOT EXISTS (SELECT 1 FROM community_users WHERE id=?) ON CONFLICT(id) DO NOTHING`)
          .bind(id, handle, timestamp, id).run();
      }
      const saved = await db.prepare('SELECT id,handle,profile_completed FROM community_users WHERE id=?').bind(id).first();
      if (saved) return saved;
    } catch (error) {
      if (!String(error.message).includes('UNIQUE constraint failed')) throw error;
      // The unique index resolves collisions atomically, including concurrent sign-ins.
    }
  }
  throw new CommunityError(503, 'Couldn’t choose a username just now. Please try again.');
}
