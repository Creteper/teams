ALTER TABLE messages ADD COLUMN qa_card jsonb;
ALTER TABLE bot_webhooks ADD COLUMN issues_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE webhook_deliveries ADD COLUMN event_data jsonb;

-- Enqueue alongside the mutation so a rollback or idempotent retry cannot emit a phantom event.
CREATE FUNCTION enqueue_issue_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    tid uuid;
    iid uuid;
    event_name text;
    details jsonb;
BEGIN
    IF TG_TABLE_NAME = 'issue_comments' THEN
        iid := NEW.issue_id;
        SELECT team_id INTO tid FROM issues WHERE id = iid;
        event_name := 'issue.commented';
        details := jsonb_build_object('comment_id', NEW.id);
    ELSE
        tid := NEW.team_id;
        iid := NEW.id;
        details := '{}'::jsonb;
        IF TG_OP = 'INSERT' THEN
            event_name := 'issue.created';
        ELSIF NEW IS NOT DISTINCT FROM OLD THEN
            RETURN NEW;
        ELSIF NEW.archived_at IS DISTINCT FROM OLD.archived_at THEN
            event_name := 'issue.archived';
        ELSE
            event_name := 'issue.updated';
        END IF;
    END IF;
    INSERT INTO webhook_deliveries(id,bot_id,event,status,event_data)
        SELECT gen_random_uuid(),b.id,event_name,'pending',details || jsonb_build_object('issue_id',iid)
        FROM bots b JOIN bot_webhooks w ON w.bot_id=b.id
        WHERE b.team_id=tid AND b.deleted_at IS NULL AND w.enabled AND w.issues_enabled;
    RETURN NEW;
END $$;

CREATE TRIGGER issue_webhooks AFTER INSERT OR UPDATE ON issues
    FOR EACH ROW EXECUTE FUNCTION enqueue_issue_event();
CREATE TRIGGER issue_comment_webhooks AFTER INSERT ON issue_comments
    FOR EACH ROW EXECUTE FUNCTION enqueue_issue_event();
