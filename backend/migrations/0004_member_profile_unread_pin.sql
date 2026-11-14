-- Per-user channel state: read position (unread badges) and pinning.
--
-- team_members.join_seq records the newest message seq at the moment the
-- membership row was created. Messages with seq <= join_seq count as read
-- for that member, so a new member (or a re-joined one) does not start with
-- the whole history unread. Existing members are back-filled with the
-- current max(seq): after this migration everyone starts "all read".
ALTER TABLE team_members ADD COLUMN join_seq bigint NOT NULL DEFAULT 0;
UPDATE team_members SET join_seq = (SELECT COALESCE(max(seq), 0) FROM messages);

CREATE FUNCTION team_members_set_join_seq() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.join_seq := (SELECT COALESCE(max(seq), 0) FROM messages);
    RETURN NEW;
END
$$;
CREATE TRIGGER team_members_join_seq BEFORE INSERT ON team_members
    FOR EACH ROW EXECUTE FUNCTION team_members_set_join_seq();

CREATE TABLE user_channel_state (
    user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id    uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    last_read_seq bigint NOT NULL DEFAULT 0,
    pinned_at     timestamptz,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, channel_id)
);
