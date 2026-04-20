CREATE TABLE `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`jid` text NOT NULL,
	`display_name` text NOT NULL,
	`phone` text NOT NULL,
	`source` text NOT NULL,
	`verified_on_whatsapp` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_user_jid_unique` ON `contacts` (`user_id`,`jid`);--> statement-breakpoint
CREATE INDEX `contacts_user_search_idx` ON `contacts` (`user_id`,`display_name`);