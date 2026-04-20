CREATE TABLE `wa_connections` (
	`user_id` text PRIMARY KEY NOT NULL,
	`jid` text,
	`status` text DEFAULT 'disconnected' NOT NULL,
	`last_connected_at` integer,
	`last_error` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
