CREATE TABLE "health_check_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stream_source_id" uuid NOT NULL,
	"result" "stream_test_result" NOT NULL,
	"latency_ms" integer,
	"error_message" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "health_check_log" ADD CONSTRAINT "health_check_log_stream_source_id_stream_source_id_fk" FOREIGN KEY ("stream_source_id") REFERENCES "public"."stream_source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "health_check_log_source_checked_at_idx" ON "health_check_log" USING btree ("stream_source_id","checked_at" DESC NULLS LAST);