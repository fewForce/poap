-- 018 — Apple Wallet passes (src/wallet, docs/wallet-passes.md).
--
-- One pass per registration. The QR on it carries `authentication_token`,
-- which the desk's scan replaces; `previous_authentication_token` keeps the
-- one before so a phone that has not fetched the new pass yet can still ask
-- for it. Apple's web service answers "what changed since" from updated_at.
--
-- The three log tables are append-only and never read on a request's path.

CREATE TABLE wallet_passes (
  id                             bigserial   PRIMARY KEY,
  registration_id                bigint      NOT NULL UNIQUE REFERENCES registrations (id) ON DELETE CASCADE,
  event_id                       integer     NOT NULL REFERENCES events (event_id) ON DELETE CASCADE,
  serial_number                  uuid        NOT NULL UNIQUE,
  authentication_token           text        NOT NULL UNIQUE CHECK (length(authentication_token) >= 16),
  previous_authentication_token  text,
  download_key                   text        NOT NULL UNIQUE CHECK (length(download_key) >= 16),
  status                         text        NOT NULL DEFAULT 'pending'
                                   CHECK (status IN ('pending', 'issued', 'suspended', 'revoked', 'expired')),
  issued_at                      timestamptz,
  suspended_at                   timestamptz,
  revoked_at                     timestamptz,
  expired_at                     timestamptz,
  delivered_at                   timestamptz,
  delivery_error                 text,
  created_at                     timestamptz NOT NULL DEFAULT now(),
  updated_at                     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX wallet_passes_event_idx ON wallet_passes (event_id);
CREATE INDEX wallet_passes_previous_token_idx ON wallet_passes (previous_authentication_token)
  WHERE previous_authentication_token IS NOT NULL;

-- A phone that added the pass, and where to push it.
CREATE TABLE wallet_pass_devices (
  id                         bigserial   PRIMARY KEY,
  pass_id                    bigint      NOT NULL REFERENCES wallet_passes (id) ON DELETE CASCADE,
  device_library_identifier  text        NOT NULL,
  push_token                 text        NOT NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallet_pass_devices_device_pass_key UNIQUE (device_library_identifier, pass_id)
);

-- Every desk scan of a pass, valid or not. The token is stored hashed.
CREATE TABLE wallet_pass_scans (
  id          bigserial   PRIMARY KEY,
  pass_id     bigint      REFERENCES wallet_passes (id) ON DELETE SET NULL,
  event_id    integer,
  token_hash  text        NOT NULL,
  result      text        NOT NULL
                CHECK (result IN ('valid', 'stale', 'invalid', 'other_event', 'suspended', 'revoked', 'expired')),
  ip_address  text,
  scanned_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX wallet_pass_scans_pass_idx ON wallet_pass_scans (pass_id, scanned_at);

-- Every push to Apple, and what Apple said.
CREATE TABLE wallet_pass_pushes (
  id            bigserial   PRIMARY KEY,
  pass_id       bigint      REFERENCES wallet_passes (id) ON DELETE SET NULL,
  push_token    text        NOT NULL,
  event         text        NOT NULL,
  status_code   integer,
  error_reason  text,
  success       boolean     NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Every call Apple Wallet made to the web service. No headers or bodies: the
-- Authorization header is the pass's token.
CREATE TABLE wallet_pass_api_logs (
  id               bigserial   PRIMARY KEY,
  pass_id          bigint      REFERENCES wallet_passes (id) ON DELETE SET NULL,
  method           text        NOT NULL,
  endpoint         text        NOT NULL,
  response_status  integer     NOT NULL,
  timing_ms        integer     NOT NULL,
  ip_address       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
