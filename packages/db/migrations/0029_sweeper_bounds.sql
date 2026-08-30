CREATE INDEX "rate_events_created_at_idx" ON "rate_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "one_time_tokens_expires_at_idx" ON "one_time_tokens" USING btree ("expires_at");
