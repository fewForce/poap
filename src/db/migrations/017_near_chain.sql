-- 017 — NEAR, beside XRPL. See docs/near-chain.md.
--
-- Three changes, all additive. Every row that exists keeps its meaning.
--
-- 1. events.chain. Which chain the event's badges live on, chosen when the
--    event is created and never changed after: a badge cannot move between
--    chains. Every existing event is an XRPL event, which is the default.
--
-- 2. near_signature, a fourth way an address can arrive on a registration.
--    wallet_signature for a NEAR implicit account: the account id IS the
--    ed25519 public key, so a signature that verifies under the key that the
--    id spells out is proof of the account. As strong as wallet_signature.
--
-- 3. The NEAR mint, signed, on the claim slot. A NEAR transaction's hash is
--    fixed when it is signed, so the server signs, saves the bytes here, and
--    only then sends. A request that dies after sending is finished by sending
--    the same bytes again, which cannot mint twice, and the attendance row
--    always names the transaction that really minted. XRPL claims leave both
--    NULL; the reaper's sweep keys on offer_id, which NEAR claims never have.
--
-- What NEAR does NOT change: `attendance` keeps its shape. For a NEAR badge,
-- nftoken_id holds the contract's token id ("{event_id}:{account_id}"),
-- tx_hash the mint transaction's hash (base58, not hex), ledger_index the
-- block height, and offer_id stays NULL: nothing is offered, the badge is
-- minted straight to the attendee.

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS chain text NOT NULL DEFAULT 'xrpl'
    CONSTRAINT events_chain_check CHECK (chain IN ('xrpl', 'near'));

COMMENT ON COLUMN events.chain IS
  'The chain this event''s badges live on: xrpl or near. Fixed when the event is created.';

ALTER TABLE registrations DROP CONSTRAINT registrations_address_proof_check;
ALTER TABLE registrations ADD CONSTRAINT registrations_address_proof_check
  CHECK (address_proof IN ('xaman_signin', 'self_declared', 'wallet_signature', 'near_signature'));

ALTER TABLE claims
  ADD COLUMN IF NOT EXISTS near_tx_hash text,
  ADD COLUMN IF NOT EXISTS near_signed_tx text;

ALTER TABLE claims
  ADD CONSTRAINT claims_near_tx_together
    CHECK ((near_tx_hash IS NULL) = (near_signed_tx IS NULL));
