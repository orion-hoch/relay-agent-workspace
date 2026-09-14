ALTER TABLE tasks ADD COLUMN agent_id TEXT;
ALTER TABLE tasks ADD COLUMN room TEXT;
ALTER TABLE tasks ADD COLUMN context TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS one_active_task_run ON runs(task_id) WHERE task_id IS NOT NULL AND status IN ('queued','preparing','running','awaiting');
