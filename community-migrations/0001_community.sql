PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS community_users (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS community_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES community_users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS community_sessions_expiry ON community_sessions(expires_at);
CREATE TABLE IF NOT EXISTS community_decks (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES community_users(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category_tag TEXT NOT NULL,
  color_hex TEXT NOT NULL,
  deck_type TEXT NOT NULL,
  cards_json TEXT NOT NULL DEFAULT '[]',
  card_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','deleted')),
  download_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  published_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS community_decks_browse ON community_decks(status, published_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS community_decks_owner ON community_decks(owner_id, created_at);
CREATE TABLE IF NOT EXISTS community_media (
  id TEXT PRIMARY KEY,
  deck_id TEXT NOT NULL REFERENCES community_decks(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  uploaded INTEGER NOT NULL DEFAULT 0,
  attached INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS community_media_deck ON community_media(deck_id);
CREATE TABLE IF NOT EXISTS community_reports (
  deck_id TEXT NOT NULL REFERENCES community_decks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES community_users(id),
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(deck_id, user_id)
);
