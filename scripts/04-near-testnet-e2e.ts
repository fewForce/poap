/**
 * 04 — NEAR TESTNET END TO END. The NEAR twin of 01-testnet-e2e.ts: the
 * server's own issuing code against the deployed badge contract.
 *
 *   fresh implicit account -> issueNearBadge (signs, saves, sends, indexes)
 *   -> a second issue is answered from the index -> a second nft_mint on the
 *   chain returns already: true -> the attendance record, the roster and the
 *   holder's tokens all show it.
 *
 * The attendee is a brand-new implicit account that holds nothing and never
 * signs: a NEAR badge needs nothing from its holder to arrive. Burning and
 * the soulbound check need the holder to sign with gas, so they are left to
 * the contract's own tests (contracts/near-badges/src/tests.rs).
 *
 * NEEDS (as the server does — the lines scripts/near-deploy.ts writes):
 *   NEAR_NETWORK=testnet NEAR_CONTRACT_ID NEAR_MINTER_ACCOUNT_ID NEAR_MINTER_PRIVATE_KEY
 *   NEAR_RPC_URL optional. Read from the environment, or else from
 *   secrets/near-minter.env, so right after a deploy it needs nothing.
 *
 * RUN:
 *   npx tsx scripts/04-near-testnet-e2e.ts
 *   npx tsx scripts/04-near-testnet-e2e.ts --event=4100001
 *
 * Testnet only: it refuses NEAR_NETWORK=mainnet. Each run mints one badge.
 */
import "dotenv/config";
import { KeyPair } from "near-api-js";
import { NEAR_RPC_DEFAULTS } from "../src/config.js";
import { MemoryAttendanceRepository, MemoryClaimRepository } from "../src/db/memory.js";
import { nearAttendance, nearRoster, parseMintResult, signNearMint } from "../src/near/badges.js";
import { createNearGateway } from "../src/near/gateway.js";
import { issueNearBadge } from "../src/near/issue.js";
import type { EventRecord } from "../src/types.js";
import { readEnvFile } from "./lib/near.js";
import { createReport, registerSecret } from "./lib/report.js";

const r = createReport("04 · NEAR testnet end to end");

const MINTER_FILE = readEnvFile("secrets/near-minter.env");

function env(key: string): string | undefined {
  const v = process.env[key]?.trim() || MINTER_FILE[key];
  return v ? v : undefined;
}

function eventIdArg(): number {
  const hit = process.argv.slice(2).find((a) => a.startsWith("--event="));
  if (hit) return Number(hit.slice("--event=".length));
  // A fresh event per run, inside the u32 the contract takes and the taxon range the server takes.
  return 1_900_000_000 + (Math.floor(Date.now() / 1000) % 200_000_000);
}

async function run(): Promise<void> {
  r.header("mints one badge on NEAR testnet to a brand-new account");

  r.step(1, "Configuration");
  const network = env("NEAR_NETWORK") ?? "testnet";
  if (!r.check("NEAR_NETWORK is testnet", network === "testnet", network)) return;
  const contractId = env("NEAR_CONTRACT_ID");
  const minterAccountId = env("NEAR_MINTER_ACCOUNT_ID") ?? contractId;
  const minterPrivateKey = env("NEAR_MINTER_PRIVATE_KEY");
  registerSecret(minterPrivateKey);
  if (!r.check("NEAR_CONTRACT_ID is set", !!contractId, contractId ?? "unset")) return;
  if (!r.check("NEAR_MINTER_PRIVATE_KEY is set", !!minterPrivateKey, minterPrivateKey ? "set, not printed" : "unset")) return;
  const rpcUrl = env("NEAR_RPC_URL") ?? NEAR_RPC_DEFAULTS.testnet;
  r.info("contract", contractId);
  r.info("rpc", rpcUrl);

  const near = createNearGateway({
    network: "testnet",
    rpcUrl,
    contractId: contractId as string,
    minterAccountId: minterAccountId as string,
    minterPrivateKey: minterPrivateKey as string,
  });

  r.step(2, "The contract");
  r.info("version", await near.view<string>("version", {}));
  if (!r.check("not paused", !(await near.view<boolean>("paused", {})))) return;
  if (!r.check("the minter account may mint", await near.view<boolean>("is_minter", { account_id: minterAccountId }), minterAccountId)) return;

  const eventId = eventIdArg();
  const event: EventRecord = { eventId, name: `NEAR e2e ${eventId}`, status: "live", chain: "near" };
  const attendee = Buffer.from(KeyPair.fromRandom("ed25519").getPublicKey().data).toString("hex");
  r.info("event", eventId);
  r.info("attendee (implicit, never funded)", attendee);

  r.step(3, "Issue, as the desk does");
  const deps = { near, claims: new MemoryClaimRepository(), attendance: new MemoryAttendanceRepository() };
  const started = Date.now();
  const issued = await issueNearBadge(deps, event, attendee);
  if (!r.check("issued", issued.kind === "issued", issued.kind)) return;
  if (issued.kind !== "issued") return;
  r.info("took", `${((Date.now() - started) / 1000).toFixed(1)}s to finality`);
  r.check("token id is event:account", issued.record.nftokenId === `${eventId}:${attendee}`, issued.record.nftokenId);
  r.check("indexed at the contract's block height", issued.record.ledgerIndex === issued.onChain.blockHeight, String(issued.record.ledgerIndex));
  r.link("transaction", `https://testnet.nearblocks.io/txns/${issued.record.txHash}`);

  r.step(4, "Issue again");
  const again = await issueNearBadge(deps, event, attendee);
  r.check("answered from the index, nothing sent", again.kind === "duplicate", again.kind);
  const signed = await signNearMint(near, { eventId, accountId: attendee, eventTitle: event.name });
  const second = await near.send(signed);
  r.check("a second nft_mint runs", second.status === "success", second.status);
  if (second.status === "success") {
    r.check("and the contract says already", parseMintResult(second.value).already === true);
  }

  r.step(5, "Read it back");
  const record = await nearAttendance(near, eventId, attendee);
  r.check("attendance record", !!record && record.burnedAt === null, record ? `block ${record.blockHeight}` : "none");
  const roster = await nearRoster(near, eventId);
  r.check("the event's roster has exactly them", roster.length === 1 && roster[0]?.accountId === attendee, `${roster.length} entr${roster.length === 1 ? "y" : "ies"}`);
  const tokens = await near.view<Array<{ token_id: string; metadata?: { media?: string } }>>("nft_tokens_for_owner", {
    account_id: attendee,
  });
  const token = tokens.find((t) => t.token_id === `${eventId}:${attendee}`);
  r.check("the holder's tokens include the badge", !!token, token?.token_id ?? "missing");
  r.info("media", token?.metadata?.media ?? "(no base_uri set)");
}

run()
  .catch((err) => r.caught(err, "near e2e"))
  .finally(() => r.summary());
