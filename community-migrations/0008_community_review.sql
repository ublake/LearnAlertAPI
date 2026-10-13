ALTER TABLE community_decks ADD COLUMN review_status TEXT DEFAULT 'approved' CHECK(review_status IN ('pending','approved','rejected'));
ALTER TABLE community_decks ADD COLUMN review_message TEXT;
ALTER TABLE community_decks ADD COLUMN submitted_at INTEGER;
ALTER TABLE community_decks ADD COLUMN reviewed_at INTEGER;
ALTER TABLE community_decks ADD COLUMN reviewed_by TEXT;
CREATE INDEX community_decks_review ON community_decks(review_status,submitted_at DESC,id);
CREATE TRIGGER community_validate_submission BEFORE UPDATE OF cards_json,review_status ON community_decks
WHEN NEW.review_status='pending'
BEGIN
  SELECT RAISE(ABORT, 'community_attachment_unavailable') WHERE EXISTS (
    SELECT 1 FROM json_each(NEW.cards_json) card, json_tree(card.value) item
    WHERE ((item.key IN ('promptImageID','promptAudioID') AND item.type='text')
      OR (item.type='text' AND item.path='$.optionImageIDs'))
      AND NOT EXISTS(SELECT 1 FROM community_media m WHERE m.id=item.value AND m.deck_id=NEW.id
        AND m.uploaded=1 AND m.deleting=0 AND m.attached=1)
  );
END;
