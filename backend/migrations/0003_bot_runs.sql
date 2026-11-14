-- Bot run (processing) state tracked on webhook deliveries
ALTER TABLE webhook_deliveries
    ADD COLUMN run_status       text CHECK (run_status IN ('started','delivered','retrying','failed','completed')),
    ADD COLUMN run_reason       text,
    ADD COLUMN reply_message_id uuid,
    ADD COLUMN run_updated_at   timestamptz NOT NULL DEFAULT now();
CREATE INDEX webhook_deliveries_runs ON webhook_deliveries (channel_id, created_at) WHERE run_status IS NOT NULL;
CREATE INDEX webhook_deliveries_reply ON webhook_deliveries (bot_id, message_id) WHERE run_status IN ('started','delivered','retrying');
