-- First-party curriculum is separate from user submissions and their moderation.
-- Content lives in immutable R2 objects. D1 contains only indexes and revisions.
CREATE TABLE managed_catalog (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('course','exam')),
  title TEXT NOT NULL,
  subtitle TEXT NOT NULL DEFAULT '',
  language TEXT,
  color_hex TEXT NOT NULL DEFAULT '#5B70E0',
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','archived')),
  revision INTEGER NOT NULL DEFAULT 1,
  draft_key TEXT NOT NULL,
  published_key TEXT,
  published_revision INTEGER,
  published_at INTEGER,
  archived_at INTEGER,
  sort_order REAL NOT NULL DEFAULT 0,
  summary_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE INDEX managed_catalog_browse ON managed_catalog(kind,status,sort_order,id);
CREATE TABLE managed_catalog_revisions (
  catalog_id TEXT NOT NULL REFERENCES managed_catalog(id),
  revision INTEGER NOT NULL,
  action TEXT NOT NULL,
  content_key TEXT NOT NULL,
  actor TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY(catalog_id,revision)
);
CREATE TABLE managed_catalog_media (
  id TEXT PRIMARY KEY,
  catalog_id TEXT NOT NULL REFERENCES managed_catalog(id),
  object_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  actor TEXT NOT NULL
);
CREATE INDEX managed_catalog_media_content ON managed_catalog_media(catalog_id,created_at);
ALTER TABLE managed_catalog ADD COLUMN published_title TEXT;
ALTER TABLE managed_catalog_revisions ADD COLUMN published INTEGER NOT NULL DEFAULT 0;
CREATE TABLE managed_catalog_public_media (
  catalog_id TEXT NOT NULL REFERENCES managed_catalog(id),
  media_id TEXT NOT NULL REFERENCES managed_catalog_media(id),
  PRIMARY KEY(catalog_id,media_id)
);
CREATE TABLE managed_catalog_state (
  id INTEGER PRIMARY KEY CHECK(id=1),
  revision INTEGER NOT NULL DEFAULT 0,
  initialized INTEGER NOT NULL DEFAULT 0
);
INSERT INTO managed_catalog_state(id) VALUES(1);
