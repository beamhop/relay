-- Custom SQL migration (drizzle-kit generate --custom): tag index + NIP-50 FTS5.
-- Tags are extracted from events.tags by trigger, so a save is one atomic
-- statement (no bound-parameter blowup on D1, no N+1 inserts).
-- `tags` is rebuilt WITHOUT ROWID (same columns/PK as the Drizzle schema):
-- one B-tree entry per tag instead of table + PK index.
DROP TABLE `tags`;
--> statement-breakpoint
CREATE TABLE `tags` (
	`relay_id` text NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`value` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`relay_id`, `name`, `value`, `created_at`, `event_id`)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE VIRTUAL TABLE `events_fts` USING fts5(
	content,
	content='events',
	content_rowid='seq',
	tokenize='unicode61 remove_diacritics 2'
);
--> statement-breakpoint
CREATE TRIGGER `events_tags_ai` AFTER INSERT ON `events` BEGIN
	INSERT OR IGNORE INTO `tags` (`relay_id`, `event_id`, `name`, `value`, `created_at`)
	SELECT new.`relay_id`, new.`id`, json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), new.`created_at`
	FROM json_each(new.`tags`) AS j
	WHERE json_type(j.value, '$[1]') = 'text' AND length(json_extract(j.value, '$[0]')) = 1;
END;
--> statement-breakpoint
-- Delete through the primary key (no separate event_id index to maintain).
CREATE TRIGGER `events_tags_ad` AFTER DELETE ON `events` BEGIN
	DELETE FROM `tags`
	WHERE `relay_id` = old.`relay_id` AND `created_at` = old.`created_at` AND `event_id` = old.`id`
		AND (`name`, `value`) IN (
			SELECT json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]')
			FROM json_each(old.`tags`) AS j
			WHERE json_type(j.value, '$[1]') = 'text' AND length(json_extract(j.value, '$[0]')) = 1
		);
END;
--> statement-breakpoint
-- Encrypted / non-prose kinds are not full-text indexed.
CREATE TRIGGER `events_fts_ai` AFTER INSERT ON `events`
WHEN new.`content` <> '' AND new.`kind` NOT IN (3, 4, 7, 13, 1059)
BEGIN
	INSERT INTO `events_fts` (rowid, content) VALUES (new.`seq`, new.`content`);
END;
--> statement-breakpoint
CREATE TRIGGER `events_fts_ad` AFTER DELETE ON `events`
WHEN old.`content` <> '' AND old.`kind` NOT IN (3, 4, 7, 13, 1059)
BEGIN
	INSERT INTO `events_fts` (`events_fts`, rowid, content) VALUES ('delete', old.`seq`, old.`content`);
END;
