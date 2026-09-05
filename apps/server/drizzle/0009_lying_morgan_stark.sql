CREATE TYPE "public"."import_entry_status" AS ENUM('STAGED', 'APPROVED', 'REJECTED', 'DUPLICATE');--> statement-breakpoint
CREATE TYPE "public"."import_job_status" AS ENUM('PENDING', 'PROCESSING', 'DONE', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."import_mapped_type" AS ENUM('LIVE_CHANNEL', 'MOVIE', 'EPISODE', 'UNKNOWN');--> statement-breakpoint
CREATE TABLE "import_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"raw_name" text,
	"raw_url" text NOT NULL,
	"raw_logo" text,
	"raw_group" text,
	"raw_tvg_id" text,
	"mapped_type" "import_mapped_type" DEFAULT 'UNKNOWN' NOT NULL,
	"mapped_id" uuid,
	"status" "import_entry_status" DEFAULT 'STAGED' NOT NULL,
	"duplicate_of" uuid,
	"admin_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"filename" text NOT NULL,
	"status" "import_job_status" DEFAULT 'PENDING' NOT NULL,
	"total_entries" integer DEFAULT 0 NOT NULL,
	"approved_count" integer DEFAULT 0 NOT NULL,
	"rejected_count" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "import_entry" ADD CONSTRAINT "import_entry_job_id_import_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."import_job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_entry" ADD CONSTRAINT "import_entry_duplicate_of_stream_source_id_fk" FOREIGN KEY ("duplicate_of") REFERENCES "public"."stream_source"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_job" ADD CONSTRAINT "import_job_created_by_admin_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."admin_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_entry_job_line_idx" ON "import_entry" USING btree ("job_id","line_number","id");--> statement-breakpoint
CREATE INDEX "import_entry_job_status_idx" ON "import_entry" USING btree ("job_id","status");--> statement-breakpoint
CREATE INDEX "import_job_created_at_id_idx" ON "import_job" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);