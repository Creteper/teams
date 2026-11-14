-- TeAms initial schema
CREATE TABLE users (
    id            uuid PRIMARY KEY,
    username      text NOT NULL,
    password_hash text NOT NULL,
    display_name  text NOT NULL,
    avatar_id     uuid,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_lower ON users (lower(username));

CREATE TABLE sessions (
    id           uuid PRIMARY KEY,
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   bytea NOT NULL UNIQUE,
    expires_at   timestamptz NOT NULL,
    last_used_at timestamptz NOT NULL DEFAULT now(),
    created_at   timestamptz NOT NULL DEFAULT now(),
    user_agent   text NOT NULL DEFAULT ''
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE avatars (
    id          uuid PRIMARY KEY,
    owner_kind  text NOT NULL CHECK (owner_kind IN ('user','team','bot')),
    owner_id    uuid NOT NULL,
    mime_type   text NOT NULL,
    size_bytes  bigint NOT NULL,
    width       int,
    height      int,
    sha256      bytea NOT NULL,
    storage_key text NOT NULL,
    source_url  text,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE teams (
    id             uuid PRIMARY KEY,
    name           text NOT NULL,
    description    text NOT NULL DEFAULT '',
    icon_avatar_id uuid,
    owner_user_id  uuid NOT NULL REFERENCES users(id),
    created_at     timestamptz NOT NULL DEFAULT now(),
    deleted_at     timestamptz
);

CREATE TABLE bots (
    id                   uuid PRIMARY KEY,
    team_id              uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    member_id            uuid NOT NULL UNIQUE,
    name                 text NOT NULL,
    display_name         text NOT NULL,
    description          text NOT NULL DEFAULT '',
    avatar_id            uuid,
    avatar_source_url    text,
    avatar_shape         text,
    avatar_color         text,
    token_hash           bytea NOT NULL UNIQUE,
    token_prefix         text NOT NULL,
    created_by_member_id uuid,
    created_at           timestamptz NOT NULL DEFAULT now(),
    deleted_at           timestamptz
);
CREATE UNIQUE INDEX bots_team_name ON bots (team_id, lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE team_members (
    id        uuid PRIMARY KEY,
    team_id   uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    type      text NOT NULL CHECK (type IN ('user','bot')),
    user_id   uuid REFERENCES users(id),
    bot_id    uuid REFERENCES bots(id),
    role      text NOT NULL CHECK (role IN ('owner','admin','member','bot')),
    joined_at timestamptz NOT NULL DEFAULT now(),
    left_at   timestamptz,
    CHECK ((type = 'user' AND user_id IS NOT NULL AND bot_id IS NULL) OR
           (type = 'bot'  AND bot_id  IS NOT NULL AND user_id IS NULL))
);
CREATE UNIQUE INDEX team_members_active_user ON team_members (team_id, user_id) WHERE left_at IS NULL AND user_id IS NOT NULL;
CREATE INDEX team_members_user ON team_members (user_id) WHERE left_at IS NULL;

CREATE TABLE bot_webhooks (
    bot_id                  uuid PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
    url                     text NOT NULL,
    enabled                 boolean NOT NULL DEFAULT true,
    secret_header_name      text,
    secret_header_value_enc bytea,
    signing_secret_enc      bytea NOT NULL,
    updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE channels (
    id                   uuid PRIMARY KEY,
    team_id              uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    name                 text NOT NULL,
    topic                text NOT NULL DEFAULT '',
    is_default           boolean NOT NULL DEFAULT false,
    created_by_member_id uuid,
    created_at           timestamptz NOT NULL DEFAULT now(),
    deleted_at           timestamptz
);
CREATE UNIQUE INDEX channels_team_name ON channels (team_id, lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE messages (
    id               uuid PRIMARY KEY,
    seq              bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    team_id          uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    channel_id       uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    sender_member_id uuid NOT NULL REFERENCES team_members(id),
    content          text NOT NULL DEFAULT '',
    reply_to         uuid,
    trigger_depth    smallint NOT NULL DEFAULT 0,
    client_msg_id    text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    edited_at        timestamptz,
    deleted_at       timestamptz
);
CREATE INDEX messages_channel_seq ON messages (channel_id, seq);
CREATE INDEX messages_client_msg ON messages (sender_member_id, channel_id, client_msg_id) WHERE client_msg_id IS NOT NULL;

CREATE TABLE message_mentions (
    message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    member_id  uuid NOT NULL REFERENCES team_members(id),
    position   int NOT NULL,
    PRIMARY KEY (message_id, member_id)
);
CREATE INDEX message_mentions_member ON message_mentions (member_id);

CREATE TABLE attachments (
    id                 uuid PRIMARY KEY,
    team_id            uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    uploader_member_id uuid NOT NULL REFERENCES team_members(id),
    message_id         uuid REFERENCES messages(id) ON DELETE SET NULL,
    kind               text NOT NULL CHECK (kind IN ('image','video')),
    mime_type          text NOT NULL,
    size_bytes         bigint NOT NULL,
    file_name          text NOT NULL,
    storage_key        text NOT NULL,
    sha256             bytea NOT NULL,
    width              int,
    height             int,
    duration_ms        int,
    created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachments_message ON attachments (message_id);
CREATE INDEX attachments_unreferenced ON attachments (created_at) WHERE message_id IS NULL;

CREATE TABLE webhook_deliveries (
    id               uuid PRIMARY KEY,
    bot_id           uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    message_id       uuid REFERENCES messages(id) ON DELETE CASCADE,
    channel_id       uuid,
    event            text NOT NULL,
    status           text NOT NULL CHECK (status IN ('pending','succeeded','failed','skipped_depth','skipped_rate_limited')),
    attempts         int NOT NULL DEFAULT 0,
    next_attempt_at  timestamptz NOT NULL DEFAULT now(),
    last_status_code int,
    last_error       text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    finished_at      timestamptz
);
CREATE UNIQUE INDEX webhook_deliveries_bot_msg ON webhook_deliveries (bot_id, message_id) WHERE message_id IS NOT NULL;
CREATE INDEX webhook_deliveries_pending ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX webhook_deliveries_rate ON webhook_deliveries (bot_id, channel_id, created_at);
