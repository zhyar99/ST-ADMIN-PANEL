CREATE TYPE "public"."stream_source_kind" AS ENUM('DIRECT', 'EMBED');--> statement-breakpoint
ALTER TABLE "stream_source" ADD COLUMN "kind" "stream_source_kind" DEFAULT 'DIRECT' NOT NULL;