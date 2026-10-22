-- A separate publication pointer replaces course UX without rewriting retained
-- legacy/practice releases or relaxing their immutable publication guards.
CREATE TABLE managed_catalog_collections (
 catalog_id TEXT PRIMARY KEY REFERENCES managed_catalog(id),
 revision INTEGER NOT NULL,
 content_key TEXT NOT NULL,
 title TEXT NOT NULL,
 published_at INTEGER NOT NULL,
 FOREIGN KEY(catalog_id,revision) REFERENCES managed_catalog_revisions(catalog_id,revision)
);
