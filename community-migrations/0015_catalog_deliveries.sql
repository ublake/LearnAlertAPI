-- Content remains in managed_catalog_revisions and immutable R2 snapshots.
CREATE TABLE managed_catalog_deliveries (
 catalog_id TEXT NOT NULL,
 profile TEXT NOT NULL CHECK(profile IN ('legacy-v1','practice-v1')),
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

-- Pin the already-approved Spanish representation during cutover itself, not
-- during the first worker prepare. The paused draft is never a pin source.
CREATE TABLE managed_catalog_legacy_pins (
 catalog_id TEXT PRIMARY KEY REFERENCES managed_catalog(id),
 revision INTEGER NOT NULL,
 content_key TEXT NOT NULL,
 FOREIGN KEY(catalog_id,revision) REFERENCES managed_catalog_revisions(catalog_id,revision)
);
INSERT INTO managed_catalog_legacy_pins(catalog_id,revision,content_key)
 SELECT c.id,r.revision,r.content_key FROM managed_catalog c
 JOIN managed_catalog_revisions r ON r.catalog_id=c.id
 WHERE c.id='spanish-course' AND r.published=1
 AND r.revision=COALESCE(c.published_revision,
  (SELECT MAX(last.revision) FROM managed_catalog_revisions last WHERE last.catalog_id=c.id AND last.published=1));
-- Retain approved media through archive even before a worker prepares delivery.
CREATE TABLE managed_catalog_legacy_pin_media (
 catalog_id TEXT NOT NULL REFERENCES managed_catalog_legacy_pins(catalog_id),
 media_id TEXT NOT NULL REFERENCES managed_catalog_media(id),
 PRIMARY KEY(catalog_id,media_id)
);
INSERT INTO managed_catalog_legacy_pin_media(catalog_id,media_id)
 SELECT p.catalog_id,p.media_id FROM managed_catalog_public_media p
 JOIN managed_catalog_legacy_pins approved ON approved.catalog_id=p.catalog_id;
CREATE TRIGGER managed_catalog_initial_legacy_guard
BEFORE UPDATE OF published_key,published_revision ON managed_catalog
WHEN NEW.published_key IS NOT NULL
 AND EXISTS(SELECT 1 FROM managed_catalog_legacy_pins p WHERE p.catalog_id=OLD.id)
 AND NOT EXISTS(SELECT 1 FROM managed_catalog_legacy_pins p WHERE p.catalog_id=OLD.id
  AND p.content_key=NEW.published_key AND p.revision=NEW.published_revision)
BEGIN
 SELECT RAISE(ABORT,'legacy publication is pinned to its approved snapshot');
END;
CREATE TRIGGER managed_catalog_first_legacy_pin
AFTER UPDATE OF published_key,published_revision ON managed_catalog
WHEN NEW.id='spanish-course' AND NEW.published_key IS NOT NULL
BEGIN
 -- First publication pins atomically and survives archive/old workers.
 INSERT OR IGNORE INTO managed_catalog_legacy_pins(catalog_id,revision,content_key)
 VALUES(NEW.id,NEW.published_revision,NEW.published_key);
 INSERT OR IGNORE INTO managed_catalog_legacy_pin_media(catalog_id,media_id)
 SELECT catalog_id,media_id FROM managed_catalog_public_media WHERE catalog_id=NEW.id;
END;
