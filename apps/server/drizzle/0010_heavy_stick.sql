CREATE TYPE "public"."device_content_type" AS ENUM('MOVIE', 'SERIES', 'LIVE_CHANNEL');--> statement-breakpoint
CREATE TYPE "public"."watch_content_type" AS ENUM('MOVIE', 'EPISODE', 'LIVE_CHANNEL');--> statement-breakpoint
CREATE TABLE "device_favorite" (
	"device_id" text NOT NULL,
	"content_type" "device_content_type" NOT NULL,
	"content_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_favorite_device_id_content_type_content_id_pk" PRIMARY KEY("device_id","content_type","content_id")
);
--> statement-breakpoint
CREATE TABLE "device_profile" (
	"id" text PRIMARY KEY NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"total_watch_seconds" bigint DEFAULT 0 NOT NULL,
	"genre_affinity" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"top_content_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_blocked" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_watchlist" (
	"device_id" text NOT NULL,
	"content_type" "device_content_type" NOT NULL,
	"content_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_watchlist_device_id_content_type_content_id_pk" PRIMARY KEY("device_id","content_type","content_id")
);
--> statement-breakpoint
CREATE TABLE "recommendation_boost" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_type" "device_content_type" NOT NULL,
	"content_id" uuid NOT NULL,
	"boost_score" numeric(4, 2) DEFAULT '0.0' NOT NULL,
	"reason" text,
	"active" boolean DEFAULT true NOT NULL,
	"expires_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recommendation_boost_content_key" UNIQUE("content_type","content_id")
);
--> statement-breakpoint
CREATE TABLE "watch_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" text NOT NULL,
	"content_type" "watch_content_type" NOT NULL,
	"content_id" uuid NOT NULL,
	"watch_seconds" integer DEFAULT 0 NOT NULL,
	"content_seconds" integer DEFAULT 0 NOT NULL,
	"completion_rate" numeric(4, 3) GENERATED ALWAYS AS ((CASE WHEN content_seconds > 0 THEN LEAST(watch_seconds::numeric / content_seconds, 1.0) ELSE 0 END)) STORED,
	"rewatch" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "device_favorite" ADD CONSTRAINT "device_favorite_device_id_device_profile_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."device_profile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_watchlist" ADD CONSTRAINT "device_watchlist_device_id_device_profile_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."device_profile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_boost" ADD CONSTRAINT "recommendation_boost_created_by_admin_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."admin_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_event" ADD CONSTRAINT "watch_event_device_id_device_profile_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."device_profile"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_profile_last_seen_at_idx" ON "device_profile" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "device_profile_first_seen_at_idx" ON "device_profile" USING btree ("first_seen_at");--> statement-breakpoint
CREATE INDEX "watch_event_device_started_at_idx" ON "watch_event" USING btree ("device_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "watch_event_content_idx" ON "watch_event" USING btree ("content_type","content_id");--> statement-breakpoint
CREATE INDEX "watch_event_created_at_idx" ON "watch_event" USING btree ("created_at");