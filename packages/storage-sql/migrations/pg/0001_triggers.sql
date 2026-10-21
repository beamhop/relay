-- Custom SQL migration (drizzle-kit generate --custom): tag index trigger.
-- Tag rows are removed by the ON DELETE CASCADE foreign key.
CREATE FUNCTION beamhop_events_tags() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	INSERT INTO tags (relay_id, event_id, name, value, created_at)
	SELECT DISTINCT NEW.relay_id, NEW.id, t->>0, t->>1, NEW.created_at
	FROM jsonb_array_elements(NEW.tags) AS t
	WHERE jsonb_typeof(t) = 'array' AND jsonb_typeof(t->1) = 'string' AND length(t->>0) = 1;
	RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER events_tags_ai AFTER INSERT ON events FOR EACH ROW EXECUTE FUNCTION beamhop_events_tags();
