-- Browser Web Push (VAPID) subscriptions. Bound to the login session that
-- created them, so logging out (or session expiry) removes the subscription.
CREATE TABLE push_subscriptions (
    id              uuid PRIMARY KEY,
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id      uuid REFERENCES sessions(id) ON DELETE CASCADE,
    endpoint        text NOT NULL UNIQUE,
    p256dh          text NOT NULL,
    auth            text NOT NULL,
    user_agent      text NOT NULL DEFAULT '',
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    last_success_at timestamptz,
    last_error      text
);
CREATE INDEX push_subscriptions_user ON push_subscriptions (user_id);
