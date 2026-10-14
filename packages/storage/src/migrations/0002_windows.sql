CREATE TABLE windows (
  project_id TEXT NOT NULL, route TEXT NOT NULL, kind TEXT NOT NULL,
  used_pct REAL, resets_at TEXT, source TEXT NOT NULL, observed_at TEXT NOT NULL,
  paused_until TEXT,
  PRIMARY KEY (project_id, route, kind)
);

-- Pause state per route (a route can be paused before any window is known).
CREATE TABLE route_state (
  project_id TEXT NOT NULL, route TEXT NOT NULL,
  paused_until TEXT, pause_source TEXT, paused_at TEXT,
  PRIMARY KEY (project_id, route)
);

CREATE TABLE cost_samples (
  project_id TEXT NOT NULL,
  route TEXT NOT NULL, role TEXT NOT NULL, size TEXT NOT NULL, window_kind TEXT NOT NULL,
  delta_pct REAL NOT NULL, run_id TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX cost_samples_key ON cost_samples(route, role, size, window_kind, created_at);
