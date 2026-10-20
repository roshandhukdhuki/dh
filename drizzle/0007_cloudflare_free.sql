CREATE TABLE native_daily_budget(day TEXT PRIMARY KEY,ticks INTEGER NOT NULL CHECK(ticks BETWEEN 1 AND 360));
--> statement-breakpoint
CREATE INDEX engine_runs_started ON engine_runs(started_at DESC);
--> statement-breakpoint
CREATE INDEX jobs_updated ON jobs(updated_at DESC,id);
--> statement-breakpoint
CREATE INDEX reviews_decision_fetched ON reviews(decision,fetched DESC);
