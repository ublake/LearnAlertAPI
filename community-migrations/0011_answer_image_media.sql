-- Back images participate in the same atomic attachment/cleanup guard as fronts.
DROP TRIGGER community_validate_publication;
CREATE TRIGGER community_validate_publication BEFORE UPDATE OF cards_json,status ON community_decks
WHEN NEW.status='published'
BEGIN
  SELECT RAISE(ABORT, 'community_attachment_unavailable') WHERE EXISTS (
    SELECT 1 FROM json_each(NEW.cards_json) card, json_tree(card.value) item
    WHERE ((item.key IN ('promptImageID','answerImageID','promptAudioID') AND item.type='text')
      OR (item.type='text' AND item.path='$.optionImageIDs'))
      AND NOT EXISTS(SELECT 1 FROM community_media m WHERE m.id=item.value AND m.deck_id=NEW.id
        AND m.uploaded=1 AND m.deleting=0 AND m.attached=1)
  );
END;

DROP TRIGGER community_validate_submission;
CREATE TRIGGER community_validate_submission BEFORE UPDATE OF cards_json,review_status ON community_decks
WHEN NEW.review_status='pending'
BEGIN
  SELECT RAISE(ABORT, 'community_attachment_unavailable') WHERE EXISTS (
    SELECT 1 FROM json_each(NEW.cards_json) card, json_tree(card.value) item
    WHERE ((item.key IN ('promptImageID','answerImageID','promptAudioID') AND item.type='text')
      OR (item.type='text' AND item.path='$.optionImageIDs'))
      AND NOT EXISTS(SELECT 1 FROM community_media m WHERE m.id=item.value AND m.deck_id=NEW.id
        AND m.uploaded=1 AND m.deleting=0 AND m.attached=1)
  );
END;
