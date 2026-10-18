ALTER TABLE "resources" ADD COLUMN "admin_delisted_at" timestamp;
--> statement-breakpoint
CREATE INDEX "idx_payments_resource_id" ON "payments" ("resource_id");
--> statement-breakpoint
CREATE INDEX "idx_verifications_resource_id" ON "verifications" ("resource_id");