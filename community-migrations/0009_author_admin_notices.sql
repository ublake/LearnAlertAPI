ALTER TABLE community_decks ADD COLUMN admin_note TEXT;
ALTER TABLE community_decks ADD COLUMN admin_action TEXT CHECK(admin_action IN ('edited','hidden','restored'));
ALTER TABLE community_decks ADD COLUMN admin_updated_at INTEGER;

-- Minimal author notice survives hard deletion, with no card/media snapshot.
CREATE TABLE community_deck_notices (
  deck_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES community_users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  card_count INTEGER NOT NULL,
  admin_note TEXT,
  admin_updated_at INTEGER NOT NULL
);
CREATE INDEX community_deck_notices_owner ON community_deck_notices(owner_id,admin_updated_at DESC,deck_id);
