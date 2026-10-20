ALTER TABLE words ADD COLUMN triage TEXT NOT NULL DEFAULT 'new';
--> statement-breakpoint
ALTER TABLE words ADD COLUMN reason TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY AUTOINCREMENT, happened TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL);
