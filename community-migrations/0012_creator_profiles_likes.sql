ALTER TABLE community_users ADD COLUMN profile_created_at INTEGER;
ALTER TABLE community_users ADD COLUMN hide_stats_publicly INTEGER NOT NULL DEFAULT 0 CHECK(hide_stats_publicly IN (0,1));
ALTER TABLE community_users ADD COLUMN first_like_received_at INTEGER;
UPDATE community_users SET profile_created_at=created_at WHERE profile_completed=1;

CREATE TRIGGER community_profile_created AFTER UPDATE OF profile_completed ON community_users
WHEN NEW.profile_completed=1 AND OLD.profile_created_at IS NULL
BEGIN
  UPDATE community_users SET profile_created_at=unixepoch() WHERE id=NEW.id AND profile_created_at IS NULL;
END;
CREATE TRIGGER community_completed_profile_insert AFTER INSERT ON community_users
WHEN NEW.profile_completed=1 AND NEW.profile_created_at IS NULL
BEGIN
  UPDATE community_users SET profile_created_at=NEW.created_at WHERE id=NEW.id;
END;

CREATE TABLE community_likes (
  deck_id TEXT NOT NULL REFERENCES community_decks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES community_users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(deck_id,user_id)
);
CREATE INDEX community_likes_user ON community_likes(user_id,created_at DESC,deck_id);
CREATE INDEX community_likes_deck_date ON community_likes(deck_id,created_at DESC,user_id);

CREATE TRIGGER community_like_available BEFORE INSERT ON community_likes
BEGIN
  SELECT RAISE(ABORT,'community_like_unavailable') WHERE NOT EXISTS (
    SELECT 1 FROM community_decks d JOIN community_users u ON u.id=NEW.user_id
    WHERE d.id=NEW.deck_id AND d.owner_id!=NEW.user_id AND u.profile_completed=1 AND d.status='published'
      AND d.review_status='approved' AND d.admin_hidden=0
      AND NOT EXISTS(SELECT 1 FROM community_account_restrictions r
        WHERE r.account_id IN (d.owner_id,NEW.user_id)
          AND (r.status='banned' OR (r.status='suspended' AND r.until_at>unixepoch())))
      AND NOT EXISTS(SELECT 1 FROM community_blocks b
        WHERE (b.viewer_id=NEW.user_id AND b.blocked_account_id=d.owner_id)
          OR (b.viewer_id=d.owner_id AND b.blocked_account_id=NEW.user_id))
  );
END;
CREATE TRIGGER community_first_like AFTER INSERT ON community_likes
BEGIN
  UPDATE community_users SET first_like_received_at=COALESCE(first_like_received_at,NEW.created_at)
    WHERE id=(SELECT owner_id FROM community_decks WHERE id=NEW.deck_id);
END;
