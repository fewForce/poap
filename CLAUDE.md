# Conventions for this repo

XRPL NFT layer for a POAP-style attendance app, with NEAR as a second chain:
each event is on one chain, chosen when it is created (`events.chain`). The
NEAR design and how to deploy it are in `docs/near-chain.md`.

The original spec (`xrpl-nft-layer-brief.md`) has been removed; it is in git
history at commit 4720bd5 if you need it. Its settled decisions are restated
below. Its factual claims about endpoints and burn behaviour were measured
against a live ledger and several were wrong; what the measurements found is
written into the comments and the fixtures of the code that depends on it —
`src/xrpl/verify.ts`, `src/xrpl/roster.ts` and their tests. Trust those over
the brief, and measure again rather than reasoning from it.

## Non-negotiables

- **There is no smart contract on XRPL.** NFTs are native transaction types.
  NEAR is the one exception: its badges come from `contracts/near-badges`, one
  contract shared by every NEAR event.
- **Badges are soulbound.** Mint with `tfTransferable` unset. Flags on
  `NFTokenMint` are `1` (`tfBurnable` alone) — never `9`, never `11`.
- **Never include `TransferFee`** when `tfTransferable` is unset.
- **Every claim offer sets `Destination`.** Without it, anyone can take the badge.
- **Never verify attendance by current NFT ownership.** Attendance is an event.
  A burned badge is still attendance. On NEAR, verify from the contract's
  `attendance(event_id, account_id)` record, which a burn does not remove.
- **NEAR badges are soulbound too.** The contract refuses every transfer; only
  the holder can burn. A NEAR mint goes straight to the attendee: no offer, no
  accept.
- **`nftoken_id` / `offer_id` only exist in transaction metadata.** Use
  `requireMetaString(outcome, "nftoken_id")` from `src/xrpl/client.ts`.
- **Use named flag enums from `xrpl`**, not magic numbers. `1` means
  `tfBurnable` on mint and `tfSellNFToken` on create-offer.
- **The issuer seed never leaves the server.** Not in logs, not in responses,
  not in errors. The same goes for `NEAR_MINTER_PRIVATE_KEY`, which is a
  function-call key that may only call `nft_mint`.
- **An XRPL event behaves exactly as before.** Every NEAR path is a branch on
  `event.chain === "near"`; the XRPL side of a route keeps its old schema and
  its old answers.

## Code conventions

- TypeScript, ESM, `"module": "NodeNext"`. **Relative imports need a `.js`
  extension** (`import { x } from "./foo.js"`) even though the file is `.ts`.
- Shared contracts live in `src/types.ts`. Do not redefine them locally, do not
  edit them without a reason that affects more than one module.
- Errors: throw the typed classes in `src/errors.ts`. No bare `throw new Error`
  in `src/`.
- Every module that touches the ledger takes an `XrplGateway` as its first
  argument. Never construct a `Client` outside `src/xrpl/client.ts`. The NEAR
  twin: modules take a `NearGateway`, and only `src/near/gateway.ts` makes a
  `JsonRpcProvider` (scripts excepted).
- `strict` plus `noUncheckedIndexedAccess` are on. Index access yields
  `T | undefined`; handle it.
- Amounts: XRP as decimal strings, drops as strings. Use `xrpToDrops` /
  `dropsToXrp` from `xrpl`, never float arithmetic.

## Tests

- `npm test` (vitest). Unit tests are colocated: `src/xrpl/mint.test.ts`.
- **Unit tests never touch the network.** Use `MockGateway` from
  `test/helpers/mock-gateway.ts`, and `MockNearGateway` from
  `test/helpers/mock-near-gateway.ts` for NEAR.
- The contract has its own tests: `cargo test` in `contracts/near-badges`.
- The contract is upgradable and its state outlives every release: never
  reorder or remove `StorageKey` variants, and change `Contract` only with a
  matching `migrate` (docs/near-chain.md, "Upgrading").
- Network-touching work lives in `scripts/` and is run by hand.

## Commands

```
npm run typecheck     # tsc --noEmit
npm test              # vitest run
npm run e2e:testnet   # scripts/01-testnet-e2e.ts, needs network
npm run near:deploy   # scripts/near-deploy.ts, dry unless -- --yes (testnet: -- --create-account)
npm run near:upgrade  # scripts/near-upgrade.ts, new code + migrate, dry unless -- --yes
npm run e2e:near      # scripts/04-near-testnet-e2e.ts, needs a deployed contract
contracts/near-badges/build.sh   # the contract, nightly Rust, MVP wasm
```
