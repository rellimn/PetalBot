CREATE TABLE `counter_counters` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`value` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `counter_counters_name_unique` ON `counter_counters` (`name`);