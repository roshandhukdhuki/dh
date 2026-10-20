CREATE TABLE IF NOT EXISTS words (domain TEXT PRIMARY KEY, word TEXT NOT NULL, meaning TEXT NOT NULL, language TEXT NOT NULL, source TEXT NOT NULL, fetched TEXT NOT NULL, favorite INTEGER NOT NULL DEFAULT 0);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS runs (source TEXT PRIMARY KEY, checked TEXT NOT NULL, detail TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS reviews (word TEXT PRIMARY KEY, meaning TEXT NOT NULL, source TEXT NOT NULL, fetched TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS observations (domain TEXT PRIMARY KEY, status TEXT NOT NULL, checked_at TEXT NOT NULL, source_url TEXT NOT NULL, evidence TEXT NOT NULL);
