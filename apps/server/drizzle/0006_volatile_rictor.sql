CREATE TABLE "home_row" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title_i18n" jsonb NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"item_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "home_row_order_idx" ON "home_row" USING btree ("order","id");