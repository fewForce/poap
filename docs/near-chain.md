# NEAR as a second chain

An event is created on one chain, XRPL or NEAR, and stays on it. Everything that
already exists for XRPL keeps working unchanged: the default is XRPL, and every
NEAR path is a branch taken only for events whose `chain` is `near`.

## Decisions

### 1. One shared badge contract

The XRP Ledger has NFTs built in: no contract, and an issuer account mints. NEAR
has no native NFTs, so a NEAR badge needs a contract. The CLAUDE.md rule "there
is no smart contract" stays true for XRPL and gets an explicit NEAR exception.

There is one contract for every NEAR event, not one per event. Deploying a
contract costs NEAR and an account per event; a single contract keyed by event
id gives the same isolation with none of the deployment work at the desk.

The contract lives in `contracts/near-badges` (Rust, near-sdk 5). It implements:

| Standard | What it gives wallets |
|---|---|
| NEP-171 core | `nft_token`; `nft_transfer` and `nft_transfer_call` exist but always refuse |
| NEP-177 metadata | contract metadata and per-token title, description and media |
| NEP-181 enumeration | `nft_tokens_for_owner`, `nft_supply_for_owner`, `nft_tokens`, `nft_total_supply` |
| NEP-256 events | `nft_mint` and `nft_burn` logs, which indexers and explorers read |

**Soulbound.** A transfer always fails. The holder can burn their own badge, the
same as `tfBurnable` on XRPL.

**Attendance survives a burn.** CLAUDE.md: "never verify attendance by current
NFT ownership". The contract keeps an attendance record per
`(event_id, account_id)` with the token id, the block height and the time. A
burn removes the token but not the record, and `attendance(event_id,
account_id)` answers from the record.

**One badge per person per event, enforced on chain.** `nft_mint` for an
`(event_id, receiver)` that already has a record returns that record with
`already: true` instead of minting a second one. A retry after a lost response
is therefore safe.

**Only minters mint.** The contract owner adds and removes minter accounts. The
server signs mints with one minter key, kept like the XRPL issuer seed: never in
logs, responses or errors.

**Storage is paid by the contract.** Each badge stores a few hundred bytes.
Rather than attach a deposit to every mint, the contract account is funded
once, and a mint fails with a clear message if its balance runs short. One
NEAR covers roughly a thousand badges.

### 2. Issuing: mint straight to the attendee

On XRPL the desk mints to the issuer, makes an offer only the attendee can take,
and the attendee signs the accept. That accept is the attendance record.

On NEAR none of that is needed. An account can own a token on a contract
without signing anything and without even existing on chain yet. The desk mints
directly to the attendee, and the mint transaction is the record. The attendee
never pays a fee, never signs, and needs no funded account.

So for a NEAR event:

- `POST /events/:eventId/claims` mints and records attendance in one call. There
  is no offer, no Xaman payload and no confirm step.
- `GET /events/:eventId/claims/for/:address` answers 404, as for an XRPL
  attendee with nothing pending.
- `attendance` rows hold the token id in `nftoken_id`, the mint transaction hash
  in `tx_hash` and the block height in `ledger_index`. `offer_id` is null.

### 3. Who an attendee is on NEAR

A NEAR account id: either named (`alice.near`, `alice.testnet`) or implicit (64
lowercase hex characters, the ed25519 public key).

**The wallet app needs no new key.** Its wallets are ed25519 keys (`sEd…`
seeds). NEAR implicit accounts are ed25519 keys too, so the same key is
a NEAR account: `hex(public key)`. One backup covers both chains, and the
attendee is never asked to make or fund anything.

**Proof of ownership at registration.**
- *Wallet app* (`near_signature`): the phone signs the registration message
  with the same key, and the server checks that the signature verifies and that
  the account id is the hex of the public key. No network call is needed.
- *Website*: there is no NEAR equivalent of Xaman sign-in in the static pages
  yet, so the attendee types their account id (`self_declared`, a proof type
  the schema already has). The cost is small: someone could register a stranger's
  account, and that stranger would get a badge. Signing in with a NEAR wallet
  (NEP-413 through wallet-selector) is the follow-up.

### 4. The event's chain

- `events.chain`, `xrpl` or `near`, default `xrpl` (migration 017).
- Chosen when the event is created; a PATCH that changes it is refused, because
  badges cannot move between chains.
- Creating a NEAR event is refused when the server has no NEAR configuration.
- XRP allowances and budgets are refused for NEAR events: they pay XRP to XRPL
  wallets, which a NEAR attendee does not have. No treasury is generated.
- `event_id` keeps its meaning and range. On NEAR it is the contract's
  `event_id` (u32), so the number in the console is the number on chain on both.

### 5. Server shape

- `src/near/`: a JSON-RPC client (`NearGateway`, the NEAR twin of
  `XrplGateway`), the badge calls (`issueNearBadge`, `nearAttendance`,
  `nearRoster`, `nearTokensFor`), account-id validation and the
  `near_signature` check. `near-api-js` is pinned to 7.3.1.
- `src/chains.ts`: `Chain`, and an address check that takes the chain.
- Routes branch on `event.chain` where the protocol differs: issuing, the
  attendee lookup at the desk, `/claims/for`, verification, the roster, badge
  art and metadata, and registration.
- `/health` adds `chains` and, when configured, `near: { network, contractId,
  rpcUrl }`.
- Config: `NEAR_NETWORK` (testnet or mainnet), `NEAR_RPC_URL`,
  `NEAR_CONTRACT_ID`, `NEAR_MINTER_ACCOUNT_ID`, `NEAR_MINTER_PRIVATE_KEY`. All
  optional; without them the server is XRPL-only, exactly as today.
- Tests use a `MockNearGateway` and never touch the network. Deploying the
  contract and a testnet end-to-end run are scripts in `scripts/`, run by hand.

### 6. Pages and apps

- Console: a chain choice on the event form, fixed after creation; XRP fields
  hidden for NEAR.
- Desk (volunteer page): accepts NEAR account ids for NEAR events; issuing
  shows "Badge minted" at once.
- Attend page: for a NEAR event, the attendee enters their NEAR account, gets a
  pass with that account's QR, and the page watches the attendance record.
- Wallet app: shows the NEAR account for NEAR events, registers with
  `near_signature`, reads NEAR badges from the contract.
- Volunteer app: a new attendee on a NEAR event gets an ed25519 key and so a
  NEAR implicit account, with no funding step.

## Not in this round

- Deploying the contract. That needs a funded NEAR account, which the operator
  creates; `scripts/near-deploy.ts` does the rest.
- NEAR wallet sign-in on the website (NEP-413).
- A NEAR reward store: the store, vendors and purchases are XRP payments.
