-- Apply this migration atomically. Preserve every immutable release and pin.
CREATE TABLE cafe_delivery_rows AS SELECT * FROM managed_catalog_deliveries;
CREATE TABLE cafe_delivery_media_rows AS SELECT * FROM managed_catalog_delivery_media;
DROP TRIGGER managed_catalog_legacy_delivery_guard;
DROP TABLE managed_catalog_delivery_media;
DROP TABLE managed_catalog_deliveries;
-- Content remains in managed_catalog_revisions and immutable R2 snapshots.
CREATE TABLE managed_catalog_deliveries (
 catalog_id TEXT NOT NULL,
 profile TEXT NOT NULL CHECK(profile IN ('legacy-v1','practice-v1','practice-v2')),
 revision INTEGER NOT NULL,
 source_revision INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('candidate','active','retained')),
 digest TEXT NOT NULL,
 contracts_json TEXT NOT NULL,
 media_ids_json TEXT NOT NULL,
 title TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 activated_at INTEGER,
 PRIMARY KEY(catalog_id,profile,revision),
 FOREIGN KEY(catalog_id,revision) REFERENCES managed_catalog_revisions(catalog_id,revision)
);
CREATE UNIQUE INDEX managed_catalog_active_delivery ON managed_catalog_deliveries(catalog_id,profile) WHERE state='active';
-- Pin media for private candidates as well as published/retained releases.
CREATE TABLE managed_catalog_delivery_media (
 catalog_id TEXT NOT NULL,
 profile TEXT NOT NULL,
 revision INTEGER NOT NULL,
 media_id TEXT NOT NULL REFERENCES managed_catalog_media(id),
 PRIMARY KEY(catalog_id,profile,revision,media_id),
 FOREIGN KEY(catalog_id,profile,revision) REFERENCES managed_catalog_deliveries(catalog_id,profile,revision)
);

INSERT INTO managed_catalog_deliveries SELECT * FROM cafe_delivery_rows;
INSERT INTO managed_catalog_delivery_media SELECT * FROM cafe_delivery_media_rows;
CREATE TRIGGER managed_catalog_legacy_delivery_guard
BEFORE UPDATE OF published_key,published_revision ON managed_catalog
WHEN NEW.published_key IS NOT NULL
 AND EXISTS(SELECT 1 FROM managed_catalog_deliveries d WHERE d.catalog_id=OLD.id AND d.profile='legacy-v1')
 AND NOT EXISTS(
  SELECT 1 FROM managed_catalog_deliveries d
  JOIN managed_catalog_revisions r ON r.catalog_id=d.catalog_id AND r.revision=d.revision
  WHERE d.catalog_id=OLD.id AND d.profile='legacy-v1' AND d.state='active'
   AND r.content_key=NEW.published_key AND d.revision=NEW.published_revision
 )
BEGIN
 -- A rolled-back writer cannot publish the paused draft.
 -- Archive can clear publication; restore uses the approved legacy pointer.
 SELECT RAISE(ABORT,'legacy publication is pinned to its approved delivery');
END;
DROP TABLE cafe_delivery_media_rows;
DROP TABLE cafe_delivery_rows;
