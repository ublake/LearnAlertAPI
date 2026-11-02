-- Preserve the owning deck while its media rows cascade away. This also lets
-- immediate retries find legacy attachments whose keys use an older format.
ALTER TABLE community_deleted_objects ADD COLUMN deck_id TEXT;
CREATE INDEX community_deleted_objects_deck ON community_deleted_objects(deck_id);
UPDATE community_deleted_objects SET deck_id=substr(object_key,7,36)
  WHERE object_key GLOB 'decks/????????-????-????-????-????????????/*';
