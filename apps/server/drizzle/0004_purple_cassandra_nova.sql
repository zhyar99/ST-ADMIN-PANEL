CREATE TABLE "live_channel" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name_i18n" jsonb NOT NULL,
	"logo_asset_id" uuid,
	"category" text NOT NULL,
	"status" "publication_status" DEFAULT 'DRAFT' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "live_channel" ADD CONSTRAINT "live_channel_logo_asset_id_media_asset_id_fk" FOREIGN KEY ("logo_asset_id") REFERENCES "public"."media_asset"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "live_channel_status_created_at_idx" ON "live_channel" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "live_channel_category_idx" ON "live_channel" USING btree ("category");