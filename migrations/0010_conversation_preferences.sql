ALTER TABLE channels ADD COLUMN display_name TEXT;
CREATE UNIQUE INDEX channel_display_name ON channels(COALESCE(display_name,name));
CREATE TABLE conversation_preferences(user_id TEXT NOT NULL, room TEXT NOT NULL, hidden_at TEXT NOT NULL, PRIMARY KEY(user_id,room));
