-- Team invite links
CREATE TABLE team_invites (
    id         uuid PRIMARY KEY,
    team_id    uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    code       text NOT NULL UNIQUE,
    created_by uuid NOT NULL REFERENCES team_members(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz,
    max_uses   int CHECK (max_uses IS NULL OR max_uses BETWEEN 1 AND 1000),
    uses       int NOT NULL DEFAULT 0,
    revoked_at timestamptz,
    CHECK (max_uses IS NULL OR uses <= max_uses)
);
CREATE INDEX team_invites_team ON team_invites (team_id, id);
