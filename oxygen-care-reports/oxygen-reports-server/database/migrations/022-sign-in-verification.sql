-- Second sign-in step: staff use an authenticator app; customers get an email code.
ALTER TABLE users
  ADD COLUMN mfa_recovery_hashes TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN mfa_last_step BIGINT;

-- A password that has been accepted but whose second step is still outstanding.
CREATE TABLE login_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('totp', 'totp_setup', 'email')),
  code_hash TEXT,
  pending_secret BYTEA,
  attempts INT NOT NULL DEFAULT 0,
  sends INT NOT NULL DEFAULT 0,
  last_sent_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((kind = 'email') = (code_hash IS NOT NULL)),
  CHECK ((kind = 'totp_setup') = (pending_secret IS NOT NULL))
);
CREATE INDEX login_challenges_user_idx ON login_challenges(user_id);
CREATE INDEX login_challenges_expiry_idx ON login_challenges(expires_at);
