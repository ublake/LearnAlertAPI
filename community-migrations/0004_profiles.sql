ALTER TABLE community_users ADD COLUMN avatar_json TEXT NOT NULL DEFAULT '{"hair":0,"eyes":0,"mouth":0}';
ALTER TABLE community_users ADD COLUMN profile_completed INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX community_users_unique_handle ON community_users(handle COLLATE NOCASE);
