CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL);

CREATE TABLE tasks (
  id TEXT NOT NULL, project_id TEXT NOT NULL, title TEXT NOT NULL, role TEXT NOT NULL,
  state TEXT NOT NULL,
  size TEXT NOT NULL, depends_on TEXT NOT NULL DEFAULT '[]',
  attempts INTEGER NOT NULL DEFAULT 0, attempts_max INTEGER NOT NULL,
  branch TEXT, worktree TEXT, spec_path TEXT NOT NULL,
  blocked_reason TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);

CREATE TABLE workers (
  id TEXT NOT NULL, project_id TEXT NOT NULL, role TEXT NOT NULL,
  state TEXT NOT NULL,
  current_run TEXT, heartbeat_at TEXT, waiting_reason TEXT,
  PRIMARY KEY (project_id, id)
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT NOT NULL, worker_id TEXT NOT NULL,
  route TEXT NOT NULL, vendor TEXT NOT NULL, model TEXT,
  kind TEXT NOT NULL,
  vendor_session_id TEXT, pid INTEGER,
  state TEXT NOT NULL,
  started_at TEXT NOT NULL, ended_at TEXT, exit_code INTEGER, error_kind TEXT,
  usage_delta_json TEXT,
  artifact_dir TEXT NOT NULL
);
CREATE INDEX runs_task ON runs(project_id, task_id);

CREATE TABLE check_results (
  id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, check_id TEXT NOT NULL,
  ok INTEGER NOT NULL, exit_code INTEGER, duration_ms INTEGER,
  signature TEXT, output_tail TEXT, required INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX check_results_run ON check_results(run_id);

CREATE TABLE findings (
  id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, severity TEXT NOT NULL,
  file TEXT, line INTEGER, message TEXT NOT NULL, resolved INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX findings_run ON findings(run_id);

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, project_id TEXT NOT NULL,
  type TEXT NOT NULL, task_id TEXT, run_id TEXT, worker_id TEXT, payload TEXT NOT NULL
);
CREATE INDEX events_task ON events(project_id, task_id, seq);
CREATE INDEX events_project ON events(project_id, seq);
