ALTER TABLE community_decks ADD COLUMN admin_hidden INTEGER NOT NULL DEFAULT 0;
ALTER TABLE community_reports ADD COLUMN resolved_at INTEGER;
ALTER TABLE community_reports ADD COLUMN resolved_by TEXT;
CREATE TABLE community_admin_audit (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  details TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX community_admin_audit_date ON community_admin_audit(created_at DESC);
