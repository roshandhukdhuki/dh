ALTER TABLE reviews ADD COLUMN decision TEXT NOT NULL DEFAULT 'pending';
--> statement-breakpoint
ALTER TABLE reviews ADD COLUMN reviewed_domain TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE reviews ADD COLUMN review_note TEXT NOT NULL DEFAULT '';
