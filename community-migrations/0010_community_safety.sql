ALTER TABLE community_users ADD COLUMN public_id TEXT;
UPDATE community_users SET public_id=lower(hex(randomblob(16))) WHERE public_id IS NULL;
CREATE UNIQUE INDEX community_users_public_id ON community_users(public_id);
CREATE TRIGGER community_public_identity AFTER INSERT ON community_users
WHEN NEW.public_id IS NULL
BEGIN
 UPDATE community_users SET public_id=lower(hex(randomblob(16))) WHERE id=NEW.id;
END;
CREATE TABLE community_blocks (
 viewer_id TEXT NOT NULL REFERENCES community_users(id) ON DELETE CASCADE,
 blocked_account_id TEXT NOT NULL,
 blocked_author_id TEXT NOT NULL,
 blocked_handle TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(viewer_id,blocked_account_id)
);
-- No profile foreign key: enforcement must survive profile deletion/recreation.
CREATE TABLE community_account_restrictions (
 account_id TEXT PRIMARY KEY,
 author_id TEXT NOT NULL UNIQUE,
 handle TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('active','suspended','banned')),
 reason TEXT,
 until_at INTEGER,
 updated_at INTEGER NOT NULL,
 actor TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE community_apple_tokens (
 user_id TEXT PRIMARY KEY REFERENCES community_users(id) ON DELETE CASCADE,
 encrypted_token TEXT NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE TABLE community_apple_revocations (
 id TEXT PRIMARY KEY,
 encrypted_token TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE TABLE community_apple_events (
 id TEXT PRIMARY KEY,
 created_at INTEGER NOT NULL
);
