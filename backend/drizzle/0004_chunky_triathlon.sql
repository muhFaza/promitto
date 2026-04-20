CREATE TABLE `scheduled_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`recipient_jid` text NOT NULL,
	`recipient_name_snapshot` text NOT NULL,
	`message_text` text NOT NULL,
	`schedule_type` text NOT NULL,
	`cron_expression` text,
	`timezone` text NOT NULL,
	`next_run_at` integer NOT NULL,
	`last_run_at` integer,
	`last_status` text,
	`last_error` text,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`picked_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `scheduled_messages_due_idx` ON `scheduled_messages` (`is_active`,`next_run_at`);--> statement-breakpoint
CREATE INDEX `scheduled_messages_user_idx` ON `scheduled_messages` (`user_id`);--> statement-breakpoint
CREATE TABLE `sent_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`scheduled_message_id` text NOT NULL,
	`user_id` text NOT NULL,
	`recipient_jid` text NOT NULL,
	`message_text_snapshot` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`sent_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sent_messages_user_idx` ON `sent_messages` (`user_id`,`sent_at`);--> statement-breakpoint
CREATE INDEX `sent_messages_scheduled_idx` ON `sent_messages` (`scheduled_message_id`);