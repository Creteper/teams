-- Bots may decline to answer a mention. The decline is stored as a message
-- of kind 'bot_declined' (reply_to = trigger message) and the run status
-- becomes 'declined' (terminal, like 'completed').
ALTER TABLE messages ADD COLUMN kind text NOT NULL DEFAULT 'message'
    CHECK (kind IN ('message', 'bot_declined'));

ALTER TABLE webhook_deliveries DROP CONSTRAINT IF EXISTS webhook_deliveries_run_status_check;
ALTER TABLE webhook_deliveries ADD CONSTRAINT webhook_deliveries_run_status_check
    CHECK (run_status IN ('started','delivered','retrying','failed','completed','declined'));
