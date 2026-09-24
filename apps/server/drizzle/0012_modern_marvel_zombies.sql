ALTER TABLE "live_channel" ADD COLUMN "sort_order" integer DEFAULT 2147483647 NOT NULL;--> statement-breakpoint
CREATE INDEX "live_channel_sort_order_idx" ON "live_channel" USING btree ("sort_order");