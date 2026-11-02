import { CommunityError } from './communityValidation.js';

const epoch = () => Math.floor(Date.now() / 1000);
export const DELETED_OBJECT_GRACE_SECONDS = 86400;
export const DELETED_DECK_RETRY_SECONDS = 30 * 86400;
export const CREATION_LEDGER_SECONDS = 86400;
const validAuditJSON="CASE WHEN json_valid(details) THEN details ELSE '{}' END";
const auditNote=path=>`CASE WHEN json_type(${validAuditJSON},'${path}')='text' THEN json_extract(${validAuditJSON},'${path}') END`;
// JSON Merge Patch omits absent/null notes, preserving only deliberate author
// moderation messages rather than arbitrary nested content snapshots.
const redactedAuditDetails=`json_patch('{"contentDeleted":true}',json_object(
  'adminNote',COALESCE(${auditNote('$.adminNote')},${auditNote('$.after.adminNote')}),
  'previousAdminNote',${auditNote('$.previousAdminNote')}))`;

function selectionStatements(db, predicate, values, timestamp, dismissNotice) {
  const selection = `SELECT id FROM community_decks WHERE ${predicate}`;
  const statements = [
    db.prepare(`INSERT INTO community_deleted_objects(object_key,created_at,retain_until,deck_id)
      SELECT object_key,?,?,deck_id FROM community_media WHERE deck_id IN (${selection})
      ON CONFLICT(object_key) DO UPDATE SET retain_until=MAX(community_deleted_objects.retain_until,excluded.retain_until),deck_id=excluded.deck_id`)
      .bind(timestamp,timestamp + DELETED_OBJECT_GRACE_SECONDS,...values),
    db.prepare(`INSERT INTO community_deleted_decks(deck_id,owner_id,deleted_at)
      SELECT id,owner_id,? FROM community_decks WHERE ${predicate}
      ON CONFLICT(deck_id) DO UPDATE SET owner_id=excluded.owner_id,deleted_at=excluded.deleted_at`)
      .bind(timestamp,...values),
    // Preserve the fact of a moderation action, but not a second copy of cards,
    // answers, descriptions or imported HTML after the shared deck is erased.
    db.prepare(`UPDATE community_admin_audit SET details=${redactedAuditDetails} WHERE target IN (${selection})`)
      .bind(...values)
  ];
  if (dismissNotice) statements.push(db.prepare(`DELETE FROM community_deck_notices WHERE deck_id IN (${selection})`).bind(...values));
  statements.push(db.prepare(`DELETE FROM community_decks WHERE ${predicate}`).bind(...values));
  return statements;
}

/** Append these to the caller's transaction before its final account DELETE. */
export function accountSharedDeckDeletionStatements(db, ownerID, timestamp = epoch(), {extraPredicate,extraValues=[]} = {}) {
  // extraPredicate is trusted, backend-owned SQL (e.g. Apple event freshness),
  // never a request-provided expression. Repeat it in every transaction write.
  return selectionStatements(db,`owner_id=?${extraPredicate ? ` AND (${extraPredicate})` : ''}`,[ownerID,...extraValues],timestamp,false);
}

/** The deck DELETE is last, so callers can inspect its revision/ownership guard. */
export function sharedDeckDeletionStatements(db, {deckID,ownerID,expectedRevision,timestamp=epoch(),dismissNotice=false}) {
  const predicates = ['id=?'], values = [deckID];
  if (ownerID !== undefined) { predicates.push('owner_id=?'); values.push(ownerID); }
  if (expectedRevision !== undefined) { predicates.push('revision=?'); values.push(expectedRevision); }
  return selectionStatements(db,predicates.join(' AND '),values,timestamp,dismissNotice);
}

export async function queueObjectDeletion(db, key, timestamp = epoch()) {
  const deckID=key.match(/^decks\/([a-fA-F0-9-]{36})\//)?.[1] ?? null;
  await db.prepare(`INSERT INTO community_deleted_objects(object_key,created_at,retain_until,deck_id) VALUES(?,?,?,?)
    ON CONFLICT(object_key) DO UPDATE SET retain_until=MAX(community_deleted_objects.retain_until,excluded.retain_until),deck_id=COALESCE(community_deleted_objects.deck_id,excluded.deck_id)`)
    .bind(key,timestamp,timestamp + DELETED_OBJECT_GRACE_SECONDS,deckID).run();
}

/** Successful deletes retain just the key briefly, protecting delayed uploads. */
export async function drainDeletedObjects(env, {keys,timestamp=epoch(),limit=500} = {}) {
  const db = env.COMMUNITY_DB;
  if (!db) return {deleted:0,failed:0};
  let rows;
  if (keys) {
    rows = [];
    const unique = [...new Set(keys)];
    for (let start=0;start<unique.length;start+=90) {
      const chunk=unique.slice(start,start+90);
      const result=await db.prepare(`SELECT object_key,retain_until FROM community_deleted_objects WHERE object_key IN (${chunk.map(()=>'?').join(',')})`).bind(...chunk).all();
      rows.push(...result.results);
    }
  } else {
    rows=(await db.prepare('SELECT object_key,retain_until FROM community_deleted_objects ORDER BY created_at LIMIT ?').bind(limit).all()).results;
  }
  if (!env.DECK_ASSETS) return {deleted:0,failed:rows.length};
  let deleted=0,failed=0;
  for (let start=0;start<rows.length;start+=1000) {
    const chunk=rows.slice(start,start+1000), objectKeys=chunk.map(row=>row.object_key);
    try {
      await env.DECK_ASSETS.delete(objectKeys);
      deleted+=chunk.length;
      const expiredKeys=chunk.filter(row=>row.retain_until<=timestamp).map(row=>row.object_key);
      for (let offset=0;offset<expiredKeys.length;offset+=90) {
        const acknowledged=expiredKeys.slice(offset,offset+90);
        await db.prepare(`DELETE FROM community_deleted_objects WHERE object_key IN (${acknowledged.map(()=>'?').join(',')}) AND retain_until<=?`)
          .bind(...acknowledged,timestamp).run();
      }
    } catch {
      // Keep the durable queue record. One unavailable object must not prevent
      // cleanup of other decks or turn an already committed DELETE into failure.
      failed+=chunk.length;
    }
  }
  return {deleted,failed};
}

export async function removeSharedDeck(env, deckID, {ownerID,expectedRevision,timestamp=epoch(),dismissNotice=false} = {}) {
  const db=env.COMMUNITY_DB;
  const row=await db.prepare('SELECT owner_id,revision FROM community_decks WHERE id=?').bind(deckID).first();
  if (!row) {
    const deleted=ownerID === undefined ? null : await db.prepare('SELECT deck_id FROM community_deleted_decks WHERE deck_id=? AND owner_id=? AND deleted_at>=?')
      .bind(deckID,ownerID,timestamp-DELETED_DECK_RETRY_SECONDS).first();
    if (!deleted) throw new CommunityError(404,'Deck not found.');
    const files=await queuedDeckKeys(db,deckID);
    const cleanup=await drainDeletedObjects(env,{keys:files,timestamp});
    return {deleted:false,alreadyDeleted:true,filesPending:cleanup.failed>0};
  }
  if (ownerID !== undefined && row.owner_id !== ownerID) throw new CommunityError(404,'Deck not found.');
  if (expectedRevision !== undefined && row.revision !== expectedRevision) throw new CommunityError(409,'This deck changed. Refresh before deleting it.');
  const results=await db.batch(sharedDeckDeletionStatements(db,{deckID,ownerID,expectedRevision,timestamp,dismissNotice}));
  if (!results.at(-1).meta.changes) {
    if (expectedRevision !== undefined) throw new CommunityError(409,'This deck changed. Refresh before deleting it.');
    // A simultaneous request by this same owner can have completed the delete.
    return removeSharedDeck(env,deckID,{ownerID,expectedRevision,timestamp,dismissNotice});
  }
  const files=await queuedDeckKeys(db,deckID);
  const cleanup=await drainDeletedObjects(env,{keys:files,timestamp});
  return {deleted:true,alreadyDeleted:false,filesPending:cleanup.failed>0};
}

async function queuedDeckKeys(db, deckID) {
  return (await db.prepare("SELECT object_key FROM community_deleted_objects WHERE deck_id=? OR object_key LIKE ?").bind(deckID,`decks/${deckID}/%`).all()).results.map(row=>row.object_key);
}

export async function purgeExpiredSharedDecks(env, timestamp = epoch()) {
  const db=env.COMMUNITY_DB;
  const ids=(await db.prepare(`SELECT id FROM community_decks WHERE status='deleted'
    OR (status='draft' AND admin_created=0 AND COALESCE(review_status,'') NOT IN ('pending','rejected') AND updated_at<?)
    ORDER BY updated_at LIMIT 50`).bind(timestamp-86400).all()).results.map(row=>row.id);
  if (!ids.length) return 0;
  const eligibility="(status='deleted' OR (status='draft' AND admin_created=0 AND COALESCE(review_status,'') NOT IN ('pending','rejected') AND updated_at<?))";
  const result=await db.batch(selectionStatements(db,`${eligibility} AND id IN (${ids.map(()=>'?').join(',')})`,[timestamp-86400,...ids],timestamp,false));
  return result.at(-1).meta.changes;
}

export async function scrubOrphanedDeckAudits(db) {
  return db.prepare(`UPDATE community_admin_audit SET details=${redactedAuditDetails} WHERE action='edit_deck'
    AND json_type(CASE WHEN json_valid(details) THEN details ELSE '{}' END,'$.before.cards') IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM community_decks WHERE id=community_admin_audit.target)`)
    .run();
}
