CREATE TYPE "public"."batch_status" AS ENUM('pending', 'running', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."url_status" AS ENUM('queued', 'checking', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "batch_urls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"url" text NOT NULL,
	"status" "url_status" DEFAULT 'queued' NOT NULL,
	"http_status" integer,
	"response_ms" integer,
	"page_title" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "batch_status" DEFAULT 'pending' NOT NULL,
	"total_count" integer NOT NULL,
	"run_seq" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "batch_urls" ADD CONSTRAINT "batch_urls_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "batch_urls_batch_id_url_unique" ON "batch_urls" USING btree ("batch_id","url");--> statement-breakpoint
CREATE INDEX "batch_urls_batch_id_status_idx" ON "batch_urls" USING btree ("batch_id","status");--> statement-breakpoint
CREATE INDEX "batches_created_at_idx" ON "batches" USING btree ("created_at");