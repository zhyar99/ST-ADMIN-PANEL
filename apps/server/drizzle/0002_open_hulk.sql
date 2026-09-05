CREATE TABLE "genre" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name_i18n" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "movie" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title_i18n" jsonb NOT NULL,
	"overview_i18n" jsonb NOT NULL,
	"tagline_i18n" jsonb,
	"release_year" integer,
	"runtime_minutes" integer,
	"poster_asset_id" uuid,
	"backdrop_asset_id" uuid,
	"status" "publication_status" DEFAULT 'DRAFT' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "movie_genre" (
	"movie_id" uuid NOT NULL,
	"genre_id" uuid NOT NULL,
	CONSTRAINT "movie_genre_movie_id_genre_id_pk" PRIMARY KEY("movie_id","genre_id")
);
--> statement-breakpoint
CREATE TABLE "stream_source" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_type" "stream_source_owner_type" NOT NULL,
	"owner_id" uuid NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"url" text NOT NULL,
	"last_tested_at" timestamp with time zone,
	"last_test_result" "stream_test_result",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subtitle_track" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_type" "stream_source_owner_type" NOT NULL,
	"owner_id" uuid NOT NULL,
	"language" "subtitle_language" NOT NULL,
	"asset_id" uuid,
	"external_url" text,
	CONSTRAINT "subtitle_track_owner_language_key" UNIQUE("owner_type","owner_id","language"),
	CONSTRAINT "subtitle_track_exactly_one_source" CHECK (("subtitle_track"."asset_id" is not null) <> ("subtitle_track"."external_url" is not null)),
	CONSTRAINT "subtitle_track_owner_type_allowed" CHECK ("subtitle_track"."owner_type" in ('MOVIE', 'EPISODE'))
);
--> statement-breakpoint
ALTER TABLE "movie" ADD CONSTRAINT "movie_poster_asset_id_media_asset_id_fk" FOREIGN KEY ("poster_asset_id") REFERENCES "public"."media_asset"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movie" ADD CONSTRAINT "movie_backdrop_asset_id_media_asset_id_fk" FOREIGN KEY ("backdrop_asset_id") REFERENCES "public"."media_asset"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movie_genre" ADD CONSTRAINT "movie_genre_movie_id_movie_id_fk" FOREIGN KEY ("movie_id") REFERENCES "public"."movie"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movie_genre" ADD CONSTRAINT "movie_genre_genre_id_genre_id_fk" FOREIGN KEY ("genre_id") REFERENCES "public"."genre"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subtitle_track" ADD CONSTRAINT "subtitle_track_asset_id_media_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."media_asset"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "movie_status_created_at_idx" ON "movie" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "movie_genre_genre_id_idx" ON "movie_genre" USING btree ("genre_id");--> statement-breakpoint
CREATE INDEX "stream_source_owner_idx" ON "stream_source" USING btree ("owner_type","owner_id","priority");