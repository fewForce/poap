/**
 * NEAR UPGRADE — puts new code on the badge contract and keeps everything it
 * holds: badges, attendance records, minters, owner, metadata.
 *
 * The new code's `migrate` runs straight after it is deployed, in the same
 * receipt, so the two succeed or fail together: code whose `migrate` fails,
 * or that has none, never replaces the old. Build first with
 * contracts/near-badges/build.sh; this script refuses a wasm NEAR would reject
 * or one that drops `migrate` / `update_contract` (no further upgrades).
 *
 * TWO WAYS IN, dry unless --yes:
 *
 *   --via=account (default) — the contract account's own full access key, as
 *     near-deploy --create-account left it in secrets/near-deployer.env, or
 *     NEAR_DEPLOYER_PRIVATE_KEY. One transaction: DeployContract + migrate.
 *       NEAR_CONTRACT_ID=poap-badges-yourname.testnet npx tsx scripts/near-upgrade.ts [--yes]
 *
 *   --via=owner — the contract's owner calls `update_contract` with the wasm
 *     as the call's input and 1 yoctoNEAR. For when the owner is another
 *     account, or the contract account no longer has a full access key.
 *       NEAR_CONTRACT_ID=… NEAR_OWNER_ID=you.testnet NEAR_OWNER_PRIVATE_KEY=ed25519:… \
 *         npx tsx scripts/near-upgrade.ts --via=owner [--yes]
 *
 * Before and after, it reads what must not change — owner, minters, paused,
 * total supply, metadata — and says so if anything did.
 */
import { JsonRpcProvider, actions } from "near-api-js";
import { fitsNetwork, isNearAccountId } from "../src/near/account.js";
import {
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
  sendActions,
  setting,
} from "./lib/near.js";
import { createReport } from "./lib/report.js";

const r = createReport("near-upgrade · new code for the badge contract");

interface Snapshot {
  version: string;
  owner: string;
  minters: string[];
  paused: boolean;
  supply: string;
  metadata: unknown;
}

async function snapshot(rpc: JsonRpcProvider, contractId: string): Promise<Snapshot> {
  const view = <T>(method: string) => rpc.callFunction({ contractId, method, args: {} }) as Promise<T>;
  const [version, owner, minters, paused, supply, metadata] = await Promise.all([
    view<string>("version"),
    view<string>("owner"),
    view<string[]>("minters"),
    view<boolean>("paused"),
    view<string>("nft_total_supply"),
    view<unknown>("nft_metadata"),
  ]);
  return { version, owner, minters: [...minters].sort(), paused, supply, metadata };
}

async function run(): Promise<void> {
  const send = flag("yes");
  const via = arg("via") ?? "account";
  r.header(send ? "LIVE: this run replaces the contract's code" : "dry run: reads only, sends nothing (pass --yes)");

  // -- 1: inputs --------------------------------------------------------------
  r.step(1, "Inputs");
  const net = networkSetting();
  if (!r.check("NEAR_NETWORK is testnet or mainnet", !!net, setting("NEAR_NETWORK") ?? "testnet")) return;
  const { network, rpcUrl } = net as NonNullable<typeof net>;
  const contractId = setting("NEAR_CONTRACT_ID");
  if (!r.check("--via is account or owner", via === "account" || via === "owner", via)) return;
  const okId = (id: string | undefined): id is string => !!id && isNearAccountId(id) && fitsNetwork(id, network);
  if (!r.check(`NEAR_CONTRACT_ID is an account on ${network}`, okId(contractId), contractId ?? "unset")) return;
  r.info("network", network);
  r.info("rpc", rpcUrl);
  r.info("via", via === "account" ? "the contract account's own key" : "the owner's update_contract");

  // -- 2: the new code --------------------------------------------------------
  r.step(2, "The new code");
  const code = readContract();
  if (!r.check("wasm is built", !!code, WASM_PATH)) {
    r.note("Run contracts/near-badges/build.sh first.");
    return;
  }
  const wasm = code as NonNullable<typeof code>;
  r.info("size", `${wasm.bytes.length.toLocaleString()} bytes`);
  r.info("code hash", wasm.codeHash);
  if (!r.check("MVP WebAssembly that keeps migrate and update_contract", wasm.problems.length === 0)) {
    for (const p of wasm.problems) r.note(p);
    return;
  }

  // -- 3: the contract as it is ----------------------------------------------
  r.step(3, "The contract as it is");
  const rpc = new JsonRpcProvider({ url: rpcUrl });
  const account = await accountOrNull(rpc, contractId as string);
  if (!r.check("account exists", !!account, contractId)) return;
  const live = account as NonNullable<typeof account>;
  if (!r.check("it runs a contract", String(live.code_hash) !== NO_CODE, String(live.code_hash))) {
    r.note("Nothing to upgrade: deploy it first with npm run near:deploy.");
    return;
  }
  const before = await snapshot(rpc, contractId as string).catch(() => null);
  if (!r.check("it is the badge contract", !!before, before ? `version ${before.version}` : "its views do not answer")) return;
  const was = before as Snapshot;
  r.info("owner", was.owner);
  r.info("minters", was.minters.join(", ") || "none");
  r.info("badges held", was.supply);
  r.info("current code hash", String(live.code_hash));
  if (String(live.code_hash) === wasm.codeHash) {
    r.ok("this exact code is already deployed: nothing to do");
    return;
  }

  // Storage: the old code's bytes are freed, the new code's are locked.
  const old = await rpc.viewContractCode({ contractId: contractId as string }).catch(() => null);
  const oldSize = old ? BigInt(old.code.length) : 0n;
  const after = BigInt(live.storage_usage) - oldSize + BigInt(wasm.bytes.length);
  const needed = after * YOCTO_PER_BYTE + 10n ** 23n;
  const balance = BigInt(live.amount);
  r.info("balance", nearAmount(balance));
  if (!r.check("balance covers storage with the new code", balance >= needed, `needs about ${nearAmount(needed)}`)) {
    r.note(`Send at least ${nearAmount(needed - balance)} more to ${contractId}.`);
    return;
  }

  // -- 4: who signs ---------------------------------------------------------
  r.step(4, "Who signs");
  let signerId: string;
  let keyText: string | undefined;
  if (via === "account") {
    signerId = contractId as string;
    keyText = setting("NEAR_DEPLOYER_PRIVATE_KEY");
  } else {
    const ownerId = setting("NEAR_OWNER_ID");
    if (!r.check("NEAR_OWNER_ID is the contract's owner", ownerId === was.owner, ownerId ?? "unset")) {
      r.note(`The owner is ${was.owner}.`);
      return;
    }
    signerId = ownerId as string;
    keyText = setting("NEAR_OWNER_PRIVATE_KEY");
  }
  const key = keyFrom(keyText);
  if (!r.check("its key is a NEAR key", !!key, key ? "set, not printed" : "unset or not a key")) return;
  const signer = key as NonNullable<typeof key>;
  const pub = signer.getPublicKey().toString();
  if (!r.check(`a full access key of ${signerId}`, await isFullAccessKey(rpc, signerId, pub), pub)) return;

  // -- 5: send --------------------------------------------------------------
  r.step(5, via === "account" ? "One transaction: deploy, then migrate" : "update_contract: deploy, then migrate");
  if (!send) {
    r.blank();
    r.note("Dry run. Pass --yes to replace the code.");
    return;
  }
  const { hash, outcome } =
    via === "account"
      ? await sendActions(rpc, signer, signerId, contractId as string, [
          actions.deployContract(wasm.bytes),
          actions.functionCall("migrate", {}, 100n * TGAS, 0n),
        ])
      : await sendActions(rpc, signer, signerId, contractId as string, [
          // The wasm itself is the input: no JSON around it, no base64.
          actions.functionCall("update_contract", wasm.bytes, 300n * TGAS, 1n),
        ]);
  r.info("transaction", hash);
  r.link("explorer", explorerTx(network, hash));
  const result = await outcome.catch((err: unknown) => {
    r.fail(`No answer: ${(err as Error).message}`);
    r.note("It may still have run: look it up at the link above, or run this again (it stops if the code is already there).");
    return null;
  });
  if (!result) return;
  if (result.status !== "success") {
    r.fail(`The upgrade failed, and the old code is still in place: ${result.status === "failure" ? result.error : "it expired"}`);
    return;
  }
  r.ok("new code deployed and migrated");

  // -- 6: check -------------------------------------------------------------
  r.step(6, "Read it back");
  const nowAccount = await accountOrNull(rpc, contractId as string);
  r.check("the account runs the new code", String(nowAccount?.code_hash) === wasm.codeHash, String(nowAccount?.code_hash));
  const now = await snapshot(rpc, contractId as string);
  r.info("version", `${was.version} → ${now.version}`);
  r.check("owner unchanged", now.owner === was.owner, now.owner);
  r.check("minters unchanged", JSON.stringify(now.minters) === JSON.stringify(was.minters), now.minters.join(", "));
  r.check("paused unchanged", now.paused === was.paused, String(now.paused));
  r.check("every badge still there", now.supply === was.supply, now.supply);
  r.check("metadata unchanged", JSON.stringify(now.metadata) === JSON.stringify(was.metadata));
}

run()
  .catch((err) => r.caught(err, "near-upgrade"))
  .finally(() => r.summary());
