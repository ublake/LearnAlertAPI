import { restrictedSQL } from './communityAuth.js';

export function avatarResponse(row) {
  let stored;
  try { stored = JSON.parse(row.avatar_json || '{}'); } catch { stored = {}; }
  const avatar = {};
  for (const [part, maximum] of Object.entries({ hair: 15, eyes: 15, mouth: 15, skinTone: 6 })) {
    const value = stored?.[part];
    avatar[part] = Number.isInteger(value) && value >= 0 && value <= maximum ? value : part === 'skinTone' ? 3 : 0;
  }
  return avatar;
}

export const publicDeckSQL = `d.status='published' AND d.review_status='approved' AND d.admin_hidden=0
  AND NOT EXISTS(SELECT 1 FROM community_account_restrictions r WHERE r.account_id=d.owner_id AND ${restrictedSQL})`;

// A blocked/restricted/deleted actor contributes neither an identity nor a count.
// Both sides of an owner/liker block hide that relationship without deleting it.
export const validLikeSQL = `liker.profile_completed=1 AND NOT EXISTS(SELECT 1 FROM community_account_restrictions r WHERE r.account_id=l.user_id AND ${restrictedSQL})
  AND NOT EXISTS(SELECT 1 FROM community_blocks b
    WHERE (b.viewer_id=l.user_id AND b.blocked_account_id=d.owner_id)
      OR (b.viewer_id=d.owner_id AND b.blocked_account_id=l.user_id))`;

export const reactionColumnsSQL = `(SELECT COUNT(*) FROM community_likes l JOIN community_users liker ON liker.id=l.user_id
  WHERE l.deck_id=d.id AND ${publicDeckSQL} AND ${validLikeSQL}) AS like_count,
  EXISTS(SELECT 1 FROM community_likes l JOIN community_users liker ON liker.id=l.user_id
    WHERE l.deck_id=d.id AND l.user_id=? AND ${publicDeckSQL} AND ${validLikeSQL}) AS viewer_has_liked`;

export function profileCreatedAt(row) { return row.profile_created_at ?? row.created_at; }

export async function creatorStats(db, row) {
  const counts = await db.prepare(`SELECT
    (SELECT COUNT(*) FROM community_decks WHERE owner_id=? AND status!='deleted') AS createdDeckCount,
    COUNT(*) AS publishedDeckCount, COALESCE(SUM(d.download_count),0) AS downloadCount,
    COALESCE(SUM((SELECT COUNT(*) FROM community_likes l JOIN community_users liker ON liker.id=l.user_id
      WHERE l.deck_id=d.id AND ${validLikeSQL})),0) AS receivedLikeCount
    FROM community_decks d WHERE d.owner_id=? AND ${publicDeckSQL}`).bind(row.id,row.id).first();
  return { profileCreatedAt: profileCreatedAt(row), ...counts, hasReceivedLikes: row.first_like_received_at != null || counts.receivedLikeCount > 0 };
}

export function pageParameters(url, defaultLimit = 20) {
  return {
    limit: Math.min(50, Math.max(1, Number.parseInt(url.searchParams.get('limit') || String(defaultLimit),10) || defaultLimit)),
    offset: Math.min(100000, Math.max(0, Number.parseInt(url.searchParams.get('offset') || '0',10) || 0))
  };
}
