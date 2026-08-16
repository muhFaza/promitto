ALTER TABLE `contacts` ADD `last_interaction_at` integer;--> statement-breakpoint
ALTER TABLE `contacts` ADD `wa_pinned_at` integer;--> statement-breakpoint
CREATE INDEX `contacts_user_recent_idx` ON `contacts` (`user_id`,`last_interaction_at`);