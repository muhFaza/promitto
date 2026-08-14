ALTER TABLE `contacts` ADD `pinned_at` integer;--> statement-breakpoint
ALTER TABLE `contacts` ADD `last_interaction_at` integer;--> statement-breakpoint
CREATE INDEX `contacts_user_recent_idx` ON `contacts` (`user_id`,`pinned_at`,`last_interaction_at`);