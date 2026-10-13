ALTER TABLE community_decks ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER community_deck_revision AFTER UPDATE ON community_decks
WHEN NEW.revision=OLD.revision
BEGIN
  UPDATE community_decks SET revision=OLD.revision+1 WHERE id=NEW.id;
END;
