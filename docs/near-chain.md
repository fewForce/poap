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

**Token ids say what they are.** A badge's token id is `"{event_id}:{account}"`,
for example `70011:alice.testnet`. There is one per person per event, so the id
needs no counter, and a wallet or explorer showing it shows which event and who.

**Attendance survives a burn.** CLAUDE.md: "never verify attendance by current
NFT ownership". The contract keeps an attendance record per
`(event_id, account_id)` with the block height and the time it was minted, and
the time it was burned if it was. A burn removes the token but not the record,
and `attendance(event_id, account_id)` answers from the record.

**One badge per person per event, enforced on chain.** `nft_mint` for an
`(event_id, receiver)` that already has a record returns that record with
`already: true` instead of minting a second one. A retry after a lost response
is therefore safe.

**Only minters mint.** The contract owner adds and removes minter accounts; the
contract's own account is a minter from the start. The server signs as the
contract account with a **function-call access key** that may call `nft_mint`
on the contract and nothing else, with a bounded gas allowance. A stolen server
key can therefore mint badges, and cannot move the contract's NEAR, change its
code or call the owner methods. The key is kept like the XRPL issuer seed:
never in logs, responses or errors.

**Storage is paid by the contract.** Rather than attach a deposit to every
mint, the contract account is funded once, and a mint fails with a clear
message if its balance runs short. Measured: a badge for a new holder adds 364
bytes (about 0.0036 NEAR at 1 NEAR per 100 kB), so one NEAR covers about 275
badges. The code itself is about 267 kB, which locks about 2.7 NEAR.

**Built for the protocol as deployed.** Rust 1.82+ emits WebAssembly features
(sign extension, a newer `call_indirect` encoding) that NEAR rejects.
`contracts/near-badges/build.sh` builds with nightly and `-Zbuild-std` for the
MVP target, and the result has none of them.

### 2. Issuing: mint straight to the attendee

On XRPL the desk mints to the issuer, makes an offer only the attendee can take,
and the attendee signs the accept. That accept is the attendance record.

On NEAR none of that is needed. An account can own a token on a contract
without signing anything and without even existing on chain yet. The desk mints
directly to the attendee, and the mint transaction is the record. The attendee
never pays a fee, never signs, and needs no funded account.

So for a NEAR event:

- `POST /events/:eventId/claims` mints and records attendance in one call. There
  is no offer, no Xaman payload and no confirm step. It answers 201 with
  `{ chain: "near", tokenId, txHash, blockHeight, record }`, and 409 when the
  attendee already has the badge.
- `GET /events/:eventId/claims/for/:address` answers 404, as for an XRPL
  attendee with nothing pending.
- `attendance` rows hold the token id in `nftoken_id`, the mint transaction hash
  in `tx_hash` and the contract's block height in `ledger_index`. `offer_id` is
  null.

**How a mint is sent, so that a retry never mints twice or loses one.**

1. The claim slot is opened, as for XRPL. A second desk issuing the same person
   at the same moment gets 409 `CONFLICT`.
2. The `nft_mint` transaction is signed, and the signed bytes and hash are saved
   on the claim (`near_tx_hash`, `near_signed_tx`) **before** they are sent.
3. Mints go out one at a time, so the minter key's nonces stay in order.
4. The server waits for `FINAL`. If the answer is lost, a retry sends the same
   saved bytes: NEAR runs a transaction once, so the retry returns the first
   outcome. If the saved transaction expired without running, the server reads
   the contract's record, and signs again only if there is none.
5. If the contract refuses (paused, out of storage), the slot is freed and the
   desk is told why. Nothing is recorded.

### 3. Who an attendee is on NEAR

A NEAR account id: either named (`alice.near`, `alice.testnet`) or implicit (64
lowercase hex characters, the ed25519 public key).

- It must belong to the server's NEAR network: `.testnet` names on testnet, and
  not on mainnet. Implicit accounts work on both.
- A named account must exist; the server asks the chain before minting. An
  implicit account need not exist yet: the badge waits for it.
- `0x…` (Ethereum-style) accounts are refused: they are not keys the apps hold.

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

- `src/near/`: `gateway.ts` (the JSON-RPC client, `NearGateway`, the NEAR twin
  of `XrplGateway`), `badges.ts` (`nearAttendance`, `nearRoster`,
  `signNearMint`), `issue.ts` (`issueNearBadge`, the protocol above),
  `account.ts` (account-id rules) and `wallet-proof.ts` (the
  `near_signature` check). `near-api-js` is pinned to 7.3.1.
- `Chain` and the NEAR types are in `src/types.ts`; the chain-aware address
  checks for routes are in `src/api/http-errors.ts`.
- Routes branch on `event.chain` where the protocol differs: issuing, the
  attendee lookup at the desk, `/claims/for`, verification, the roster, badge
  art and metadata, and registration.
- `/health` adds `chains` and, when configured, `near: { network, contractId,
  rpcUrl }`.
- Config: `NEAR_NETWORK` (testnet or mainnet), `NEAR_RPC_URL`,
  `NEAR_CONTRACT_ID`, `NEAR_MINTER_ACCOUNT_ID`, `NEAR_MINTER_PRIVATE_KEY`. All
  optional; without them the server is XRPL-only, exactly as today.
- Tests use a `MockNearGateway` and never touch the network. Deploying the
  contract (`npm run near:deploy`) and a testnet end-to-end run
  (`npm run e2e:near`) are scripts in `scripts/`, run by hand.

### 6. Pages and apps

- Console: the chain is the first choice on the event form, and fixed once the
  event exists. For NEAR the XRP allowance, budget, treasury and vendors are
  hidden, and the event id is explained as the contract's event number.
- Desk (volunteer page): takes NEAR account ids for NEAR events (lowercased,
  pulled out of `near:` codes), says so when a named account does not exist,
  and shows "Badge minted" as soon as the mint is final.
- Attend page: for a NEAR event, the attendee types their NEAR account, gets a
  pass with that account's QR, and the page turns into their receipt when the
  index has the badge.
- Register page: for a NEAR event, the account is typed beside the name, and
  goes to `POST /api/events/:id/registrations/near`.
- Public event page: says NEAR where it said the ledger.
- Wallet app: shows the NEAR account for NEAR events, registers with
  `near_signature`, reads NEAR badges from the contract.
- Volunteer app: a new attendee on a NEAR event gets an ed25519 key and so a
  NEAR implicit account, with no funding step.

## Deploying

1. `contracts/near-badges/build.sh` (needs nightly Rust and `rust-src`).
2. Create and fund the contract account with any NEAR wallet, e.g.
   `badges.feooh.testnet`: about 5 NEAR covers the code and some 600 badges.
3. `NEAR_CONTRACT_ID=… NEAR_DEPLOYER_PRIVATE_KEY=… BADGE_BASE_URL=https://…
   npm run near:deploy` reads the chain and prints the plan; add `-- --yes` to
   send it. It deploys, initialises and adds the mint-only key in one
   transaction, and writes the server's four `NEAR_*` lines to
   `secrets/near-minter.env`.
4. Put those lines in the server's environment and restart. `/health` lists
   `near` among its chains, and the console offers NEAR on new events.
5. `npm run e2e:near` mints one badge to a fresh account and reads it back.

## Not in this round

- Running the deploy. It needs a funded NEAR account, which the operator
  creates.
- NEAR wallet sign-in on the website (NEP-413).
- A NEAR reward store: the store, vendors and purchases are XRP payments.
