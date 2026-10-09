-- 016 — the people invited to an event, by email, before they have a wallet.
--
-- The volunteer app registers somebody at the door by email: it checks the
-- email is on this list, makes them a wallet, and saves the wallet's address
-- here. The organiser fills the list in on /admin/invitees.
--
-- `address` is empty until the volunteer app sets it, and set once.

CREATE TABLE event_invitees (
  id             bigserial   PRIMARY KEY,
  event_id       integer     NOT NULL REFERENCES events (event_id) ON DELETE CASCADE,
  email          text        NOT NULL CHECK (email = lower(btrim(email)) AND position('@' IN email) > 1),
  display_name   text        CHECK (display_name IS NULL OR btrim(display_name) <> ''),
  address        text,
  wallet_set_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_invitees_event_email_key UNIQUE (event_id, email)
);
