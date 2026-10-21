CREATE TABLE `blob_owners` (
	`relay_id` text NOT NULL,
	`sha256` text NOT NULL,
	`pubkey` text NOT NULL,
	`size` integer NOT NULL,
	`type` text NOT NULL,
	`uploaded_at` integer NOT NULL,
	`expires_at` integer,
	PRIMARY KEY(`relay_id`, `sha256`, `pubkey`)
);
--> statement-breakpoint
CREATE INDEX `blob_owners_sha_idx` ON `blob_owners` (`sha256`);--> statement-breakpoint
CREATE INDEX `blob_owners_owner_idx` ON `blob_owners` (`relay_id`,`pubkey`,`uploaded_at`);--> statement-breakpoint
CREATE INDEX `blob_owners_expires_idx` ON `blob_owners` (`expires_at`) WHERE "blob_owners"."expires_at" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `docs` (
	`collection` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`collection`, `key`)
);
--> statement-breakpoint
CREATE TABLE `events` (
	`seq` integer PRIMARY KEY NOT NULL,
	`relay_id` text NOT NULL,
	`id` text NOT NULL,
	`pubkey` text NOT NULL,
	`created_at` integer NOT NULL,
	`kind` integer NOT NULL,
	`tags` text NOT NULL,
	`content` text NOT NULL,
	`sig` text NOT NULL,
	`address` text,
	`expires_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_id_relay_uq` ON `events` (`id`,`relay_id`);--> statement-breakpoint
CREATE INDEX `events_relay_created_idx` ON `events` (`relay_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `events_relay_kind_created_idx` ON `events` (`relay_id`,`kind`,`created_at`);--> statement-breakpoint
CREATE INDEX `events_relay_pubkey_created_idx` ON `events` (`relay_id`,`pubkey`,`created_at`);--> statement-breakpoint
CREATE INDEX `events_relay_address_idx` ON `events` (`relay_id`,`address`) WHERE "events"."address" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `events_expires_idx` ON `events` (`expires_at`) WHERE "events"."expires_at" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `metrics` (
	`seq` integer PRIMARY KEY NOT NULL,
	`metric` text NOT NULL,
	`labels` text NOT NULL,
	`t` integer NOT NULL,
	`v` real NOT NULL
);
--> statement-breakpoint
CREATE INDEX `metrics_metric_t_idx` ON `metrics` (`metric`,`t`);--> statement-breakpoint
CREATE INDEX `metrics_t_idx` ON `metrics` (`t`);--> statement-breakpoint
CREATE TABLE `tags` (
	`relay_id` text NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`value` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`relay_id`, `name`, `value`, `created_at`, `event_id`)
);
--> statement-breakpoint
CREATE TABLE `tombstones` (
	`relay_id` text NOT NULL,
	`type` text NOT NULL,
	`target` text NOT NULL,
	`pubkey` text NOT NULL,
	`until` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`relay_id`, `type`, `target`, `pubkey`)
);
