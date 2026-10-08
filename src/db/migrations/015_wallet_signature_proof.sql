-- 015 — a registration can be proven by a signature from the wallet itself.
--
-- 006 knew two ways an address could arrive on a registration: proven by a
-- Xaman SignIn, or typed. The POAP app holds its own wallet key on the phone
-- and has no Xaman to sign in with, so it proves the address the direct way:
-- it signs a challenge this server issued with the wallet's key, and the
-- server checks the signature against the address before a row is written.
--
--   wallet_signature — the holder of the address's key signed a server
--                      challenge naming this event, this address and the
--                      name being registered. As strong as xaman_signin.
--
-- Nothing else about a registration changes. The constraint is the inline
-- CHECK from 006, under the name Postgres gave it.

ALTER TABLE registrations DROP CONSTRAINT registrations_address_proof_check;
ALTER TABLE registrations ADD CONSTRAINT registrations_address_proof_check
  CHECK (address_proof IN ('xaman_signin', 'self_declared', 'wallet_signature'));
