-- Content-free records preserve retry ownership and the rolling creation limit
-- after a shared deck's content and child rows are permanently deleted.
CREATE TABLE community_deleted_decks (
  deck_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES community_users(id) ON DELETE CASCADE,
  deleted_at INTEGER NOT NULL
);
CREATE INDEX community_deleted_decks_expiry ON community_deleted_decks(deleted_at);

CREATE TABLE community_deck_creations (
  deck_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES community_users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE INDEX community_deck_creations_owner_date ON community_deck_creations(owner_id,created_at);
INSERT INTO community_deck_creations(deck_id,owner_id,created_at)
  SELECT id,owner_id,created_at FROM community_decks WHERE created_at>unixepoch()-86400;

CREATE TRIGGER community_record_deck_creation AFTER INSERT ON community_decks
BEGIN
  INSERT INTO community_deck_creations(deck_id,owner_id,created_at) VALUES(NEW.id,NEW.owner_id,NEW.created_at);
END;

-- Keep successful object-key tombstones for one day. A file upload that was
-- already running when its deck was deleted must not leave an orphaned object.
ALTER TABLE community_deleted_objects ADD COLUMN retain_until INTEGER NOT NULL DEFAULT 0;
