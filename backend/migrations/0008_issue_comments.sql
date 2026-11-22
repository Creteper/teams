CREATE TABLE issue_comments (
    id uuid PRIMARY KEY,
    issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    author_id uuid NOT NULL REFERENCES team_members(id),
    body text NOT NULL,
    reply_to_id uuid,
    root_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (issue_id, id),
    FOREIGN KEY (issue_id, reply_to_id) REFERENCES issue_comments(issue_id, id),
    FOREIGN KEY (issue_id, root_id) REFERENCES issue_comments(issue_id, id)
);
CREATE INDEX issue_comments_activity ON issue_comments(issue_id, created_at, id);
ALTER TABLE attachments ADD COLUMN comment_id uuid,
    ADD CHECK (comment_id IS NULL OR issue_id IS NOT NULL),
    ADD FOREIGN KEY (issue_id, comment_id) REFERENCES issue_comments(issue_id, id) ON DELETE CASCADE;
CREATE INDEX attachments_comment ON attachments(comment_id) WHERE comment_id IS NOT NULL;
