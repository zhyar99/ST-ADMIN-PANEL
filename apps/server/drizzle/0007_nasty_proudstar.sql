CREATE TABLE "ad_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"singleton" boolean DEFAULT true NOT NULL,
	"pre_roll_min_seconds" integer DEFAULT 5 NOT NULL,
	"pre_roll_max_seconds" integer DEFAULT 10 NOT NULL,
	"mid_roll_interval_minutes" integer DEFAULT 30 NOT NULL,
	"mid_roll_max_seconds" integer DEFAULT 30 NOT NULL,
	"skip_after_seconds" integer DEFAULT 5 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_config_singleton_unique" UNIQUE("singleton"),
	CONSTRAINT "ad_config_singleton_true" CHECK ("ad_config"."singleton" = true),
	CONSTRAINT "ad_config_pre_roll_range" CHECK ("ad_config"."pre_roll_min_seconds" >= 1 and "ad_config"."pre_roll_max_seconds" >= "ad_config"."pre_roll_min_seconds"),
	CONSTRAINT "ad_config_positive_intervals" CHECK ("ad_config"."mid_roll_interval_minutes" >= 1 and "ad_config"."mid_roll_max_seconds" >= 1 and "ad_config"."skip_after_seconds" >= 1)
);
--> statement-breakpoint
CREATE TABLE "ad_creative" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"duration_seconds" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_creative_duration_positive" CHECK ("ad_creative"."duration_seconds" >= 1)
);
--> statement-breakpoint
ALTER TABLE "ad_creative" ADD CONSTRAINT "ad_creative_asset_id_media_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."media_asset"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ad_creative_active_idx" ON "ad_creative" USING btree ("is_active");