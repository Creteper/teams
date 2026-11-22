CREATE TABLE issue_options (
    team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('status','label')),
    name text NOT NULL,
    color text NOT NULL,
    position bigint GENERATED ALWAYS AS IDENTITY,
    PRIMARY KEY (team_id, kind, name)
);
CREATE UNIQUE INDEX issue_option_name ON issue_options(team_id, kind, lower(name));

CREATE FUNCTION seed_issue_options(tid uuid) RETURNS void LANGUAGE sql AS $$
    INSERT INTO issue_options(team_id, kind, name, color) VALUES
        (tid,'status','待处理','#949ba4'), (tid,'status','进行中','#eab44d'),
        (tid,'status','已完成','#8b80f9'), (tid,'status','已取消','#818893');
$$;
SELECT seed_issue_options(id) FROM teams;

CREATE TABLE issues (
    id uuid PRIMARY KEY,
    team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    title text NOT NULL,
    description text NOT NULL DEFAULT '',
    status text NOT NULL,
    priority text NOT NULL CHECK (priority IN ('none','urgent','high','medium','low')),
    creator_id uuid NOT NULL REFERENCES team_members(id),
    assignee_id uuid REFERENCES team_members(id),
    labels text[] NOT NULL DEFAULT '{}',
    start_date date,
    end_date date,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (end_date >= start_date)
);
CREATE INDEX issues_team ON issues(team_id, created_at DESC);
CREATE INDEX issues_creator ON issues(creator_id);
CREATE INDEX issues_assignee ON issues(assignee_id);
ALTER TABLE attachments ADD COLUMN issue_id uuid REFERENCES issues(id) ON DELETE SET NULL,
    ADD CHECK (message_id IS NULL OR issue_id IS NULL),
    DROP CONSTRAINT attachments_kind_check,
    ADD CHECK (kind IN ('image','video','file'));
CREATE INDEX attachments_issue ON attachments(issue_id) WHERE issue_id IS NOT NULL;
