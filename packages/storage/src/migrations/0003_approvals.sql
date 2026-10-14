CREATE TABLE approvals (
  id TEXT NOT NULL, project_id TEXT NOT NULL, task_id TEXT,
  category TEXT NOT NULL, action TEXT, context TEXT NOT NULL,
  state TEXT NOT NULL,                       -- PENDING | GRANTED | DENIED
  comment TEXT, created_at TEXT NOT NULL, decided_at TEXT,
  PRIMARY KEY (project_id, id)
);
