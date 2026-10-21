CREATE TABLE "blob_owners" (
	"relay_id" text NOT NULL,
	"sha256" text COLLATE "C" NOT NULL,
	"pubkey" text COLLATE "C" NOT NULL,
	"size" bigint NOT NULL,
	"type" text NOT NULL,
	"uploaded_at" bigint NOT NULL,
	"expires_at" bigint,
	CONSTRAINT "blob_owners_relay_id_sha256_pubkey_pk" PRIMARY KEY("relay_id","sha256","pubkey")
);
--> statement-breakpoint
CREATE TABLE "docs" (
	"collection" text NOT NULL,
	"key" text COLLATE "C" NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "docs_collection_key_pk" PRIMARY KEY("collection","key")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"relay_id" text NOT NULL,
	"id" text COLLATE "C" NOT NULL,
	"pubkey" text NOT NULL,
	"created_at" bigint NOT NULL,
	"kind" bigint NOT NULL,
	"tags" jsonb NOT NULL,
	"content" text NOT NULL,
	"sig" text NOT NULL,
	"address" text,
	"expires_at" bigint,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED
);
--> statement-breakpoint
CREATE TABLE "metrics" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"metric" text NOT NULL,
	"labels" jsonb NOT NULL,
	"t" bigint NOT NULL,
	"v" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"relay_id" text NOT NULL,
	"event_id" text COLLATE "C" NOT NULL,
	"name" text NOT NULL,
	"value" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tombstones" (
	"relay_id" text NOT NULL,
	"type" text NOT NULL,
	"target" text NOT NULL,
	"pubkey" text NOT NULL,
	"until" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "tombstones_relay_id_type_target_pubkey_pk" PRIMARY KEY("relay_id","type","target","pubkey")
);
--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_event_fk" FOREIGN KEY ("event_id","relay_id") REFERENCES "public"."events"("id","relay_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blob_owners_sha_idx" ON "blob_owners" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "blob_owners_owner_idx" ON "blob_owners" USING btree ("relay_id","pubkey","uploaded_at");--> statement-breakpoint
CREATE INDEX "blob_owners_expires_idx" ON "blob_owners" USING btree ("expires_at") WHERE "blob_owners"."expires_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "events_id_relay_uq" ON "events" USING btree ("id","relay_id");--> statement-breakpoint
CREATE INDEX "events_relay_created_idx" ON "events" USING btree ("relay_id","created_at");--> statement-breakpoint
CREATE INDEX "events_relay_kind_created_idx" ON "events" USING btree ("relay_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "events_relay_pubkey_created_idx" ON "events" USING btree ("relay_id","pubkey","created_at");--> statement-breakpoint
CREATE INDEX "events_relay_address_idx" ON "events" USING btree ("relay_id","address") WHERE "events"."address" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "events_expires_idx" ON "events" USING btree ("expires_at") WHERE "events"."expires_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "events_search_idx" ON "events" USING gin ("search");--> statement-breakpoint
CREATE INDEX "metrics_metric_t_idx" ON "metrics" USING btree ("metric","t");--> statement-breakpoint
CREATE INDEX "metrics_t_idx" ON "metrics" USING btree ("t");--> statement-breakpoint
CREATE INDEX "metrics_labels_idx" ON "metrics" USING gin ("labels");--> statement-breakpoint
CREATE INDEX "tags_lookup_idx" ON "tags" USING btree ("relay_id","name","value","created_at");--> statement-breakpoint
CREATE INDEX "tags_event_idx" ON "tags" USING btree ("event_id","relay_id");