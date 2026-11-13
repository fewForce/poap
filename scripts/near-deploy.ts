/**
 * NEAR DEPLOY — puts the badge contract (contracts/near-badges) on a NEAR
 * account, initialises it, and gives the server a key that can only mint.
 * Later changes to the contract go out with scripts/near-upgrade.ts.
 *
 * BEFORE RUNNING
 *   Build the contract: `contracts/near-badges/build.sh` (nightly Rust). It
 *   writes res/near_badges.wasm in the MVP form NEAR accepts; this script
 *   checks that, and that the build keeps the methods upgrades need.
 *
 * ON TESTNET, FROM NOTHING — the script makes the account too:
 *   NEAR_CONTRACT_ID=poap-badges-yourname.testnet BADGE_BASE_URL=https://poap.live \
 *     npx tsx scripts/near-deploy.ts --create-account          # dry run: the plan
 *   ... --create-account --yes                                  # do it
 *
 *   `--create-account` asks NEAR's testnet faucet to create the account and
 *   fund it with free testnet NEAR. Its full access key is generated here and
 *   written to secrets/near-deployer.env (0600) BEFORE the faucet is asked,
 *   so it cannot be lost. That key deploys and upgrades the contract; it
 *   never goes on the server.
 *
 * WITH AN ACCOUNT YOU ALREADY HAVE (testnet or mainnet)
 *   Create and fund it with any NEAR wallet: the code is about 275 kB, which
 *   locks about 2.8 NEAR, and each badge for a new holder about 0.0036 NEAR.
 *   NEAR_NETWORK=testnet NEAR_CONTRACT_ID=… NEAR_DEPLOYER_PRIVATE_KEY=ed25519:… \
 *   BADGE_BASE_URL=https://poap.live npx tsx scripts/near-deploy.ts [--yes]
 *
 * OPTIONS
 *   --yes                 send; without it nothing is sent and nothing created
 *   --allowance=10        NEAR the minting key may spend on gas (default 10)
 *   --owner=you.testnet   who may pause, add minters, change metadata and
 *                         upgrade (default: the contract account itself)
 *   --out=./secrets/near-minter.env
 *
 * WHAT IT WRITES
 *   secrets/near-minter.env (0600, never overwritten): the four lines the
 *   server needs — NEAR_NETWORK, NEAR_CONTRACT_ID, NEAR_MINTER_ACCOUNT_ID and
 *   NEAR_MINTER_PRIVATE_KEY. That key can call `nft_mint` on this contract and
 *   nothing else, and spend at most --allowance on gas. It is written before
 *   the transaction that adds it on chain, and removed again if that fails.
 *
 * An account already running the badge contract is left alone: that is an
 * upgrade, and scripts/near-upgrade.ts does it with a migration.
 */
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { JsonRpcProvider, KeyPair, actions, parseNearAmount } from "near-api-js";
import { fitsNetwork, isNearAccountId } from "../src/near/account.js";
import {
  DEPLOYER_FILE,
  NO_CODE,
  TGAS,
  WASM_PATH,
  YOCTO_PER_BYTE,
  accountOrNull,
  arg,
  explorerTx,
  flag,
  isFullAccessKey,
  keyFrom,
  nearAmount,
  networkSetting,
  readContract,
  readEnvFile,
  sendActions,
  setting,
} from "./lib/near.js";
import { createReport, registerSecret } from "./lib/report.js";

const DEFAULT_OUT = "./secrets/near-minter.env";
/** The testnet faucet behind `near account create-account sponsor-by-faucet-service`. */
const FAUCET_URL = "https://helper.nearprotocol.com/account";

const r = createReport("near-deploy · the badge contract on NEAR");

function writeSecretFile(path: string, lines: string[]): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, lines.join("\n") + "\n", { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
}

async function waitForAccount(rpc: JsonRpcProvider, accountId: string, seconds: number) {
  for (let i = 0; i < seconds; i += 2) {
    const account = await accountOrNull(rpc, accountId);
    if (account) return account;
    await new Promise((done) => setTimeout(done, 2_000));
  }
  return null;
}

async function run(): Promise<void> {
  const send = flag("yes");
  const create = flag("create-account");
  r.header(send ? "LIVE: this run creates and sends" : "dry run: reads only, creates and sends nothing (pass --yes)");

  // -- 1: inputs --------------------------------------------------------------
  r.step(1, "Inputs");
  const net = networkSetting();
  if (!r.check("NEAR_NETWORK is testnet or mainnet", !!net, setting("NEAR_NETWORK") ?? "testnet")) return;
  const { network, rpcUrl } = net as NonNullable<typeof net>;
  const contractId = setting("NEAR_CONTRACT_ID");
  const ownerId = arg("owner") ?? contractId;
  const baseUri = setting("BADGE_BASE_URL")?.replace(/\/+$/, "");
  const allowanceNear = arg("allowance") ?? "10";
  const outPath = resolve(arg("out") ?? DEFAULT_OUT);

  const okId = (id: string | undefined): id is string => !!id && isNearAccountId(id) && fitsNetwork(id, network);
  if (!r.check(`NEAR_CONTRACT_ID is an account on ${network}`, okId(contractId), contractId ?? "unset")) return;
  if (!r.check(`owner is an account on ${network}`, okId(ownerId), ownerId ?? "unset")) return;
  if (!r.check("BADGE_BASE_URL is https", !!baseUri && baseUri.startsWith("https://"), baseUri ?? "unset")) return;
  const allowanceOk = /^\d+(\.\d{1,24})?$/.test(allowanceNear);
  const allowance = allowanceOk ? parseNearAmount(allowanceNear as `${number}`) : "0";
  if (!r.check("allowance is an amount of NEAR", BigInt(allowance) > 0n, `${allowanceNear} NEAR`)) return;
  r.info("network", network);
  r.info("rpc", rpcUrl);

  // -- 2: the code ------------------------------------------------------------
  r.step(2, "The contract code");
  const code = readContract();
  if (!r.check("wasm is built", !!code, WASM_PATH)) {
    r.note("Run contracts/near-badges/build.sh first.");
    return;
  }
  const wasm = code as NonNullable<typeof code>;
  r.info("size", `${wasm.bytes.length.toLocaleString()} bytes`);
  r.info("sha256", wasm.sha256);
  if (!r.check("MVP WebAssembly, and upgradable (migrate, update_contract)", wasm.problems.length === 0)) {
    for (const p of wasm.problems) r.note(p);
    r.note("Build with contracts/near-badges/build.sh, not plain cargo.");
    return;
  }

  // -- 3: the account ---------------------------------------------------------
  r.step(3, "The contract account");
  const rpc = new JsonRpcProvider({ url: rpcUrl });
  let account = await accountOrNull(rpc, contractId as string);

  if (!account) {
    if (!create) {
      r.check("account exists", false, `${contractId} does not exist on ${network}`);
      r.note("Create and fund it with a NEAR wallet, or on testnet pass --create-account.");
      return;
    }
    if (!r.check("--create-account is for testnet", network === "testnet", network)) return;
    if (
      !r.check(
        "a direct .testnet name, as the faucet makes",
        /^[a-z0-9_-]{2,56}\.testnet$/.test(contractId as string),
        contractId,
      )
    ) {
      r.note("The faucet creates names like poap-badges-yourname.testnet: one part, then .testnet.");
      return;
    }
    const kept = readEnvFile(DEPLOYER_FILE);
    if (kept.NEAR_CONTRACT_ID && kept.NEAR_CONTRACT_ID !== contractId) {
      r.check("secrets/near-deployer.env is free", false, `it holds the key of ${kept.NEAR_CONTRACT_ID}`);
      r.note("Move that file away first: it may be the only copy of that account's key.");
      return;
    }
    r.info("will create", `${contractId}, funded by the testnet faucet`);
    r.info("its key goes to", DEPLOYER_FILE);
    if (!send) {
      r.blank();
      r.note("Dry run. Pass --yes to create the account; the rest of the plan is checked once it exists.");
      return;
    }

    r.step(4, "Create the account through the testnet faucet");
    let key = keyFrom(kept.NEAR_DEPLOYER_PRIVATE_KEY);
    if (key) {
      registerSecret(key.toString());
      r.ok(`reusing the key already in ${DEPLOYER_FILE}`);
    } else {
      key = KeyPair.fromRandom("ed25519");
      registerSecret(key.toString());
      // On disk before the faucet hears of it: the account must never exist
      // with a key nobody kept.
      writeSecretFile(DEPLOYER_FILE, [
        "# NEAR testnet account holding the POAP badge contract — written by scripts/near-deploy.ts",
        `# ${new Date().toISOString()}`,
        "# Its FULL ACCESS key: it deploys and upgrades the contract and can spend the",
        "# account's NEAR. Keep it here, not on the server.",
        `NEAR_NETWORK=${network}`,
        `NEAR_CONTRACT_ID=${contractId}`,
        `NEAR_DEPLOYER_PRIVATE_KEY=${key.toString()}`,
      ]);
      r.ok(`key written: ${DEPLOYER_FILE}`);
    }
    const res = await fetch(FAUCET_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newAccountId: contractId, newAccountPublicKey: key.getPublicKey().toString() }),
    }).catch((err: unknown) => {
      r.fail(`The faucet did not answer: ${(err as Error).message}`);
      return null;
    });
    if (!res) return;
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 300);
      r.fail(`The faucet refused (${res.status}): ${text || "no reason given"}`);
      r.note("A name that is taken is refused too. Pick another NEAR_CONTRACT_ID, then delete secrets/near-deployer.env.");
      return;
    }
    account = await waitForAccount(rpc, contractId as string, 60);
    if (!r.check("account exists", !!account, contractId)) {
      r.note("The faucet answered but the account has not appeared yet. Run this again in a minute: the key is kept.");
      return;
    }
  }

  const live = account as NonNullable<typeof account>;
  const balance = BigInt(live.amount);
  r.info("balance", nearAmount(balance));
  r.info("storage used", `${live.storage_usage.toLocaleString()} bytes`);

  if (String(live.code_hash) !== NO_CODE) {
    const version = await rpc
      .callFunction({ contractId: contractId as string, method: "version", args: {} })
      .catch(() => null);
    if (version) {
      r.warn(`${contractId} already runs the badge contract (version ${String(version)}).`);
      r.note("To put new code on it, keeping every badge: npm run near:upgrade");
    } else {
      r.warn(`${contractId} already has other code on it. Use a fresh account for the badge contract.`);
    }
    return;
  }
  r.ok("no code yet: a fresh deploy");

  // Code bytes plus a margin for the contract's own state, then gas.
  const needed = (BigInt(wasm.bytes.length) + BigInt(live.storage_usage) + 4_000n) * YOCTO_PER_BYTE + 10n ** 23n;
  if (!r.check("balance covers the code's storage", balance >= needed, `needs about ${nearAmount(needed)}`)) {
    r.note(`Send at least ${nearAmount(needed - balance)} more to ${contractId}, and more for badges.`);
    return;
  }
  const room = (balance - needed) / (364n * YOCTO_PER_BYTE);
  r.info("badges the rest pays for", `about ${room.toLocaleString()} (364 bytes each for a new holder)`);

  const deployer = keyFrom(setting("NEAR_DEPLOYER_PRIVATE_KEY"));
  if (!r.check("NEAR_DEPLOYER_PRIVATE_KEY is a NEAR key", !!deployer, deployer ? "set, not printed" : "unset or not a key")) {
    return;
  }
  const deployerKey = deployer as KeyPair;
  const deployerPub = deployerKey.getPublicKey().toString();
  if (
    !r.check(
      "it is a full access key of the account",
      await isFullAccessKey(rpc, contractId as string, deployerPub),
      deployerPub,
    )
  ) {
    return;
  }

  // -- the plan ---------------------------------------------------------------
  r.step(5, "One transaction: deploy, initialise, add the minting key");
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
  r.info(
    "upgrades",
    ownerId === contractId ? "with this account's key (npm run near:upgrade)" : `by ${ownerId}, or with this account's key`,
  );

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

  // -- the minting key, on disk first -----------------------------------------
  r.step(6, "Write the minting key to one 0600 file");
  const minter = KeyPair.fromRandom("ed25519");
  registerSecret(minter.toString());
  writeSecretFile(outPath, [
    "# NEAR minting key for the POAP server — written by scripts/near-deploy.ts",
    `# ${new Date().toISOString()}`,
    "# It can call nft_mint on the contract below and nothing else, once the deploy",
    "# transaction that adds it has run. Copy these four lines into the server's",
    "# environment.",
    `NEAR_NETWORK=${network}`,
    `NEAR_CONTRACT_ID=${contractId}`,
    `NEAR_MINTER_ACCOUNT_ID=${contractId}`,
    `NEAR_MINTER_PRIVATE_KEY=${minter.toString()}`,
  ]);
  r.ok(`written: ${outPath}`);
  r.info("minting key (public half)", minter.getPublicKey().toString());

  // -- send -------------------------------------------------------------------
  r.step(7, "Send");
  const { hash, outcome } = await sendActions(rpc, deployerKey, contractId as string, contractId as string, [
    actions.deployContract(wasm.bytes),
    actions.functionCall("new", { owner_id: ownerId, metadata }, 100n * TGAS, 0n),
    actions.addFunctionCallAccessKey(minter.getPublicKey(), contractId as string, ["nft_mint"], BigInt(allowance)),
  ]);
  r.info("transaction", hash);
  r.link("explorer", explorerTx(network, hash));
  const result = await outcome.catch((err: unknown) => {
    r.fail(`No answer for the deploy transaction: ${(err as Error).message}`);
    r.note(`It may still have run: look it up at the link above. If it did, ${outPath} holds the live minting key.`);
    r.note("If it did not, delete that file before running this again.");
    return null;
  });
  if (!result) return;
  if (result.status !== "success") {
    rmSync(outPath, { force: true });
    r.fail(`The transaction failed: ${result.status === "failure" ? result.error : "it expired"}`);
    r.note(`Nothing changed on the account but its balance (gas). ${outPath} was removed: its key was never added.`);
    return;
  }
  r.ok("deployed, initialised, minting key added");

  // -- check ------------------------------------------------------------------
  r.step(8, "Read it back");
  const view = <T>(method: string, args: Record<string, unknown> = {}) =>
    rpc.callFunction({ contractId: contractId as string, method, args }) as Promise<T>;
  const version = await view<string>("version");
  r.check("version answers", !!version, version);
  r.check("owner is as asked", (await view<string>("owner")) === ownerId, ownerId);
  r.check("the contract account mints", await view<boolean>("is_minter", { account_id: contractId }), contractId);
  r.check("not paused", !(await view<boolean>("paused")));
  r.note(`Next: put the lines in ${outPath} in the server's environment, then npm run e2e:near.`);
}

run()
  .catch((err) => r.caught(err, "near-deploy"))
  .finally(() => r.summary());
