ALTER TABLE community_users ADD COLUMN is_developer INTEGER NOT NULL DEFAULT 0 CHECK(is_developer IN (0,1));
ALTER TABLE community_users ADD COLUMN developer_anki_uploads INTEGER NOT NULL DEFAULT 0 CHECK(developer_anki_uploads IN (0,1));
ALTER TABLE community_decks ADD COLUMN publisher_handle TEXT;
ALTER TABLE community_decks ADD COLUMN anki_media_json TEXT NOT NULL DEFAULT '{}';
