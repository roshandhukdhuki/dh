-- Additive upgrade: existing words, reviews, observations, history and leases remain intact.
CREATE TABLE engine_control (
  id INTEGER PRIMARY KEY CHECK(id=1), paused INTEGER NOT NULL DEFAULT 1,
  epoch INTEGER NOT NULL DEFAULT 0, lease_token TEXT NOT NULL DEFAULT '', lease_until INTEGER NOT NULL DEFAULT 0,
  last_tick_at TEXT, last_scheduled_at TEXT, last_run_at TEXT, last_success_at TEXT,
  next_run_at INTEGER NOT NULL DEFAULT 0, availability_enabled INTEGER NOT NULL DEFAULT 0,
  last_external_tick_at TEXT, last_external_event TEXT NOT NULL DEFAULT ''
);
--> statement-breakpoint
INSERT INTO engine_control(id) VALUES(1);
--> statement-breakpoint
CREATE TABLE source_health (
  source TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'ready', failures INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT, last_success_at TEXT, next_allowed_at INTEGER NOT NULL DEFAULT 0,
  error_code TEXT NOT NULL DEFAULT '', cursor TEXT NOT NULL DEFAULT '', cycle INTEGER NOT NULL DEFAULT 0,
  exhausted INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
INSERT INTO source_health(source) VALUES('nepali'),('english'),('namecheap');
--> statement-breakpoint
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, source TEXT NOT NULL, payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','retry','succeeded','failed','blocked','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
  not_before INTEGER NOT NULL DEFAULT 0, lease_token TEXT NOT NULL DEFAULT '', lease_until INTEGER NOT NULL DEFAULT 0,
  cancel_requested INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  error_code TEXT NOT NULL DEFAULT '', result TEXT NOT NULL DEFAULT '{}'
);
--> statement-breakpoint
CREATE INDEX jobs_due ON jobs(status,not_before,source);
--> statement-breakpoint
CREATE TABLE job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT, happened TEXT NOT NULL,
  action TEXT NOT NULL, code TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT ''
);
--> statement-breakpoint
CREATE TABLE engine_runs (
  id TEXT PRIMARY KEY, trigger TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
  status TEXT NOT NULL, jobs_completed INTEGER NOT NULL DEFAULT 0, error_code TEXT NOT NULL DEFAULT '',
  request_id TEXT NOT NULL DEFAULT ''
);
--> statement-breakpoint
CREATE TABLE external_invocations (request_id TEXT PRIMARY KEY, received_at TEXT NOT NULL, event TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE manual_batches (id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
  expires TEXT NOT NULL, requested_count INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'active', released_at TEXT);
--> statement-breakpoint
CREATE TABLE dictionary_entries (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, page_id INTEGER NOT NULL, revision_id INTEGER NOT NULL,
  native TEXT NOT NULL, language TEXT NOT NULL, definition TEXT NOT NULL, raw_excerpt TEXT NOT NULL,
  entry_url TEXT NOT NULL, revision_url TEXT NOT NULL, revision_at TEXT NOT NULL,
  retrieved_at TEXT NOT NULL, request_url TEXT NOT NULL, license TEXT NOT NULL,
  eligible INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT '', usage_labels TEXT NOT NULL DEFAULT '[]',
  UNIQUE(source,page_id,revision_id)
);
--> statement-breakpoint
CREATE TABLE meanings (
  id TEXT PRIMARY KEY, domain TEXT NOT NULL REFERENCES words(domain), language TEXT NOT NULL,
  native TEXT NOT NULL DEFAULT '', definition TEXT NOT NULL, romanization TEXT NOT NULL,
  romanization_status TEXT NOT NULL, review_actor TEXT NOT NULL DEFAULT '', review_note TEXT NOT NULL DEFAULT '',
  entry_url TEXT NOT NULL, revision_url TEXT NOT NULL, revision_id INTEGER, revision_at TEXT,
  retrieved_at TEXT NOT NULL, license TEXT NOT NULL, origin TEXT NOT NULL,
  accepted INTEGER NOT NULL DEFAULT 0, first_seen_at TEXT NOT NULL,
  definition_status TEXT NOT NULL DEFAULT 'legacy_unverified', romanization_method TEXT NOT NULL DEFAULT '',
  romanization_confidence REAL, usage_labels TEXT NOT NULL DEFAULT '[]', commonness_status TEXT NOT NULL DEFAULT 'unknown',
  brand_score INTEGER NOT NULL DEFAULT 0, brand_suitability TEXT NOT NULL DEFAULT 'unassessed',
  spelling_friction TEXT NOT NULL DEFAULT 'unknown', brand_reasons TEXT NOT NULL DEFAULT '[]',
  reviewed_definition TEXT NOT NULL DEFAULT '',
  UNIQUE(domain,language,native,entry_url)
);
--> statement-breakpoint
CREATE INDEX meanings_domain ON meanings(domain,accepted);
--> statement-breakpoint
-- Legacy provenance is preserved without inventing license, review or freshness claims.
INSERT INTO meanings(id,domain,language,native,definition,romanization,romanization_status,review_note,
 entry_url,revision_url,retrieved_at,license,origin,accepted,first_seen_at)
 SELECT 'legacy:'||domain,domain,language,native,meaning,word,'legacy_unverified',source_note,
 source,source,fetched,'See retained source attribution','legacy_history',0,fetched FROM words;
--> statement-breakpoint
ALTER TABLE reviews ADD COLUMN entry_id TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE reviews ADD COLUMN definition TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE reviews ADD COLUMN romanization_suggestion TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE reviews ADD COLUMN romanization_method TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE reviews ADD COLUMN romanization_confidence REAL;
--> statement-breakpoint
ALTER TABLE reviews ADD COLUMN reviewer_type TEXT NOT NULL DEFAULT 'unattributed_legacy';
--> statement-breakpoint
ALTER TABLE reviews ADD COLUMN definition_status TEXT NOT NULL DEFAULT 'legacy_unverified';
--> statement-breakpoint
CREATE TABLE availability_events (
  id TEXT PRIMARY KEY, domain TEXT NOT NULL, status TEXT NOT NULL, checked_at TEXT NOT NULL,
  source_url TEXT NOT NULL, evidence TEXT NOT NULL, provider TEXT NOT NULL,
  environment TEXT NOT NULL DEFAULT 'production', price REAL, currency TEXT, period_months INTEGER,
  renewal_price REAL, error_code TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL,
  checkout_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(checkout_confirmed=0),
  taxes_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(taxes_confirmed=0)
);
--> statement-breakpoint
CREATE INDEX availability_domain_time ON availability_events(domain,checked_at DESC);
--> statement-breakpoint
ALTER TABLE observations ADD COLUMN provider TEXT NOT NULL DEFAULT 'namecheap';
--> statement-breakpoint
ALTER TABLE observations ADD COLUMN price REAL;
--> statement-breakpoint
ALTER TABLE observations ADD COLUMN currency TEXT;
--> statement-breakpoint
ALTER TABLE observations ADD COLUMN period_months INTEGER;
--> statement-breakpoint
ALTER TABLE observations ADD COLUMN kind TEXT NOT NULL DEFAULT 'manual';
--> statement-breakpoint
INSERT INTO availability_events(id,domain,status,checked_at,source_url,evidence,provider,kind)
 SELECT 'legacy:'||domain,domain,status,checked_at,source_url,evidence,'namecheap','legacy_manual' FROM observations;
