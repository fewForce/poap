/**
 * NEAR DEPLOY — puts the badge contract (contracts/near-badges) on a NEAR
 * account, initialises it, and gives the server a key that can only mint.
 *
 * BEFORE RUNNING
 *   1. Build the contract: `contracts/near-badges/build.sh` (nightly Rust; it
 *      writes res/near_badges.wasm in the MVP form NEAR accepts).
 *   2. Create the contract's account with any NEAR wallet, e.g.
 *      badges.feooh.testnet, and fund it. The code is about 270 kB, which
 *      locks about 2.7 NEAR; every badge for a new holder locks about 0.0037
 *      NEAR more (364 bytes). 5 NEAR covers the code and roughly 600 badges.
 *   3. Export that account's FULL ACCESS private key. It is used for this one
 *      transaction and is never written anywhere by this script.
 *
 * RUN — dry by default: reads the chain, prints the plan, sends nothing.
 *   NEAR_NETWORK=testnet \
 *   NEAR_CONTRACT_ID=badges.feooh.testnet \
 *   NEAR_DEPLOYER_PRIVATE_KEY=ed25519:... \
 *   BADGE_BASE_URL=https://poap.live \
 *     npx tsx scripts/near-deploy.ts
 *
 *   ... --yes                deploy + initialise + add the minting key, in one transaction
 *   ... --allowance=10       NEAR the minting key may spend on gas (default 10)
 *   ... --owner=you.testnet  the account that may pause, add minters, etc.
 *                            (default: the contract account itself)
 *   ... --out=./secrets/near-minter.env
 *
 * WHAT IT WRITES
 *   The minting key goes to --out (mode 0600, refuses to overwrite), as the
 *   four lines the server needs: NEAR_NETWORK, NEAR_CONTRACT_ID,
 *   NEAR_MINTER_ACCOUNT_ID and NEAR_MINTER_PRIVATE_KEY. Only its public half is
 *   printed. That key can call `nft_mint` on this contract and nothing else,
 *   and spend at most --allowance on gas; topping it up means adding a new key.
 *
 * An already-initialised contract is not touched: the contract has no state
 * migration, and redeploying different code over its state could break it.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  JsonRpcProvider,
  KeyPair,
  KeyPairSigner,
  type KeyPairString,
  actions,
  baseDecode,
  baseEncode,
  createTransaction,
  formatNearAmount,
  parseNearAmount,
} from "near-api-js";
import { NEAR_RPC_DEFAULTS } from "../src/config.js";
import { fitsNetwork, isNearAccountId } from "../src/near/account.js";
import { failureMessage } from "../src/near/gateway.js";
import type { NearNetwork } from "../src/types.js";
import { createReport, registerSecret } from "./lib/report.js";

const WASM = resolve("contracts/near-badges/res/near_badges.wasm");
const DEFAULT_OUT = "./secrets/near-minter.env";
/** 1 NEAR per 100 kB: the protocol's storage price, per byte, in yocto. */
const YOCTO_PER_BYTE = 10n ** 19n;
/** An account that has never had code has this hash. */
const NO_CODE = "11111111111111111111111111111111";
const INIT_GAS = 100_000_000_000_000n;

const r = createReport("near-deploy · the badge contract on NEAR");

function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3).trim() || undefined;
}

function env(key: string): string | undefined {
  const v = process.env[key]?.trim();
  return v ? v : undefined;
}

function near(yocto: bigint): string {
  return `${formatNearAmount(yocto.toString(), 4)} NEAR`;
}

async function run(): Promise<void> {
  const send = process.argv.includes("--yes");
  r.header(send ? "LIVE: this run sends one transaction" : "dry run: reads only, sends nothing (pass --yes to deploy)");

  // -- 1: inputs --------------------------------------------------------------
  r.step(1, "Inputs");
  const network = (env("NEAR_NETWORK") ?? "testnet") as NearNetwork;
  if (network !== "testnet" && network !== "mainnet") {
    r.fail(`NEAR_NETWORK must be testnet or mainnet, got ${network}`);
    return;
  }
  const rpcUrl = env("NEAR_RPC_URL") ?? NEAR_RPC_DEFAULTS[network];
  const contractId = env("NEAR_CONTRACT_ID");
  const deployerKey = env("NEAR_DEPLOYER_PRIVATE_KEY");
  registerSecret(deployerKey);
  const baseUri = env("BADGE_BASE_URL")?.replace(/\/+$/, "");
  const ownerId = arg("owner") ?? contractId;
  const allowanceNear = arg("allowance") ?? "10";
  const outPath = resolve(arg("out") ?? DEFAULT_OUT);

  const okId = (id: string | undefined): id is string => !!id && isNearAccountId(id) && fitsNetwork(id, network);
  if (!r.check("NEAR_CONTRACT_ID is an account on " + network, okId(contractId), contractId ?? "unset")) return;
  if (!r.check("owner is an account on " + network, okId(ownerId), ownerId ?? "unset")) return;
  if (!r.check("NEAR_DEPLOYER_PRIVATE_KEY is set", !!deployerKey, deployerKey ? "set, not printed" : "unset")) return;
  if (!r.check("BADGE_BASE_URL is https", !!baseUri && baseUri.startsWith("https://"), baseUri ?? "unset")) return;
  const allowanceOk = /^\d+(\.\d{1,24})?$/.test(allowanceNear);
  const allowance = allowanceOk ? parseNearAmount(allowanceNear as `${number}`) : "0";
  if (!r.check("allowance is an amount of NEAR", BigInt(allowance) > 0n, `${allowanceNear} NEAR`)) return;
  r.info("network", network);
  r.info("rpc", rpcUrl);

  let deployer: KeyPair;
  try {
    deployer = KeyPair.fromString(deployerKey as KeyPairString);
  } catch {
    r.fail("NEAR_DEPLOYER_PRIVATE_KEY is not a NEAR private key (ed25519:...). It is not repeated here.");
    return;
  }

  // -- 2: the code ------------------------------------------------------------
  r.step(2, "The contract code");
  if (!r.check("wasm is built", existsSync(WASM), WASM)) {
    r.note("Run contracts/near-badges/build.sh first.");
    return;
  }
  const code = readFileSync(WASM);
  r.info("size", `${code.length.toLocaleString()} bytes`);
  r.info("sha256", createHash("sha256").update(code).digest("hex"));

  // -- 3: the account ---------------------------------------------------------
  r.step(3, "The contract account");
  const rpc = new JsonRpcProvider({ url: rpcUrl });
  let account: Awaited<ReturnType<JsonRpcProvider["viewAccount"]>>;
  try {
    account = await rpc.viewAccount({ accountId: contractId as string });
  } catch (err) {
    r.check("account exists", false, `${contractId}: ${(err as Error).message}`);
    r.note("Create and fund it with a NEAR wallet first.");
    return;
  }
  const balance = BigInt(account.amount);
  r.info("balance", near(balance));
  r.info("storage used", `${account.storage_usage.toLocaleString()} bytes`);

  const hasCode = String(account.code_hash) !== NO_CODE;
  if (hasCode) {
    let version: unknown = null;
    try {
      version = await rpc.callFunction({ contractId: contractId as string, method: "version", args: {} });
    } catch {
      version = null;
    }
    r.warn(
      version
        ? `${contractId} already runs the badge contract (version ${String(version)}). Nothing to do.`
        : `${contractId} already has other code on it. Use a fresh account for the badge contract.`,
    );
    r.note("This script never deploys over existing state: the contract has no migration.");
    return;
  }
  r.ok("no code yet: a fresh deploy");

  // Code bytes plus a margin for the contract's own state, then gas.
  const needed = (BigInt(code.length) + BigInt(account.storage_usage) + 4_000n) * YOCTO_PER_BYTE + 10n ** 23n;
  if (!r.check("balance covers the code's storage", balance >= needed, `needs about ${near(needed)}`)) {
    r.note(`Send at least ${near(needed - balance)} more to ${contractId}, and more for badges.`);
    return;
  }
  const room = (balance - needed) / (364n * YOCTO_PER_BYTE);
  r.info("badges the rest pays for", `about ${room.toLocaleString()} (364 bytes each for a new holder)`);

  const deployerPub = deployer.getPublicKey().toString();
  let fullAccess = false;
  try {
    const key = (await rpc.viewAccessKey({
      accountId: contractId as string,
      publicKey: deployerPub,
      finalityQuery: { finality: "final" },
    })) as unknown as { permission: unknown };
    fullAccess = key.permission === "FullAccess";
  } catch {
    fullAccess = false;
  }
  if (!r.check("deployer key is a full access key of the account", fullAccess, deployerPub)) return;

  // -- 4: the plan ------------------------------------------------------------
  r.step(4, "One transaction: deploy, initialise, add the minting key");
  const metadata = {
    spec: "nft-2.1.0",
    name: "POAP attendance badges",
    symbol: "POAP",
    icon: null,
    base_uri: baseUri,
    reference: null,
    reference_hash: null,
  };
  r.json("new(owner_id, metadata)", { owner_id: ownerId, metadata });
  r.info("minting key may call", `${contractId}.nft_mint, and nothing else`);
  r.info("minting key gas allowance", `${allowanceNear} NEAR`);
  r.info("minting key written to", outPath);

  if (existsSync(outPath)) {
    r.check("output file is free", false, `${outPath} exists`);
    r.note("Refusing to overwrite: it may hold a live minting key. Pass --out= elsewhere.");
    return;
  }
  if (!send) {
    r.blank();
    r.note("Dry run. Pass --yes to send it.");
    return;
  }

  // -- 5: send ----------------------------------------------------------------
  r.step(5, "Send");
  const minter = KeyPair.fromRandom("ed25519");
  registerSecret(minter.toString());

  const access = (await rpc.viewAccessKey({
    accountId: contractId as string,
    publicKey: deployerPub,
    finalityQuery: { finality: "final" },
  })) as unknown as { nonce: bigint | number; block_hash: string };
  const tx = createTransaction(
    contractId as string,
    deployer.getPublicKey(),
    contractId as string,
    BigInt(access.nonce) + 1n,
    [
      actions.deployContract(new Uint8Array(code)),
      actions.functionCall("new", { owner_id: ownerId, metadata }, INIT_GAS, 0n),
      actions.addFunctionCallAccessKey(minter.getPublicKey(), contractId as string, ["nft_mint"], BigInt(allowance)),
    ],
    baseDecode(access.block_hash),
  );
  const { signedTransaction, txHash } = await new KeyPairSigner(deployer).signTransaction(tx);
  const res = (await rpc.sendTransactionUntil(signedTransaction, "FINAL")) as unknown as {
    status?: { Failure?: unknown } | string;
  };
  const failure = typeof res.status === "object" && res.status && "Failure" in res.status ? res.status.Failure : null;
  const hash = baseEncode(txHash);
  r.info("transaction", hash);
  r.link("explorer", `https://${network === "mainnet" ? "" : "testnet."}nearblocks.io/txns/${hash}`);
  if (failure) {
    r.fail(`The transaction failed: ${failureMessage(failure)}`);
    r.note("Nothing was written. A failed transaction changes nothing on the account but its balance (gas).");
    return;
  }
  r.ok("deployed and initialised");

  // -- 6: check ---------------------------------------------------------------
  r.step(6, "Read it back");
  const view = <T>(method: string, args: Record<string, unknown> = {}) =>
    rpc.callFunction({ contractId: contractId as string, method, args }) as Promise<T>;
  r.check("version answers", !!(await view<string>("version")), await view<string>("version"));
  r.check("owner is as asked", (await view<string>("owner")) === ownerId, ownerId);
  r.check("the contract account mints", await view<boolean>("is_minter", { account_id: contractId }), contractId);
  r.check("not paused", !(await view<boolean>("paused")));

  // -- 7: write the key ---------------------------------------------------------
  r.step(7, "Write the minting key to one 0600 file");
  mkdirSync(dirname(outPath), { recursive: true, mode: 0o700 });
  const body = [
    "# NEAR minting key for the POAP server — written by scripts/near-deploy.ts",
    `# ${new Date().toISOString()}`,
    "# It can call nft_mint on the contract below and nothing else.",
    "# Copy these four lines into the server's environment, then delete this file.",
    `NEAR_NETWORK=${network}`,
    `NEAR_CONTRACT_ID=${contractId}`,
    `NEAR_MINTER_ACCOUNT_ID=${contractId}`,
    `NEAR_MINTER_PRIVATE_KEY=${minter.toString()}`,
    "",
  ].join("\n");
  writeFileSync(outPath, body, { mode: 0o600, flag: "wx" });
  chmodSync(outPath, 0o600);
  r.ok(`written: ${outPath}`);
  r.info("minting key (public half)", minter.getPublicKey().toString());
  r.note("Restart the server with those lines; /health then lists near among its chains.");
}

run()
  .catch((err) => r.caught(err, "near-deploy"))
  .finally(() => r.summary());
