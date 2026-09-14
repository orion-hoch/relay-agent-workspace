ALTER TABLE channels ADD COLUMN topic TEXT NOT NULL DEFAULT '';
ALTER TABLE channels ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE documents ADD COLUMN source_room TEXT;
ALTER TABLE documents ADD COLUMN relative_path TEXT;
CREATE INDEX documents_source_room ON documents(source_room);
