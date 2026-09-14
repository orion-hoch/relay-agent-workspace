ALTER TABLE tasks ADD COLUMN workspace_directory TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS task_workspace_directory ON tasks(lower(workspace_directory)) WHERE workspace_directory IS NOT NULL;
