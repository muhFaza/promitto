ALTER TABLE `users` ADD `retention_days` integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `contact_sync_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
UPDATE `sessions` SET `ip` = NULL;
