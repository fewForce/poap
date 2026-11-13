/**
 * What scripts/near-deploy.ts and scripts/near-upgrade.ts share: reading
 * their inputs, the contract's wasm, the keys, and sending one transaction.
 *
 * Keys are never printed. A key read from a file is registered with the
 * report so that an error carrying it is scrubbed before it reaches a screen.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  JsonRpcProvider,
  KeyPair,
  KeyPairSigner,
  type Action,
  type KeyPairString,
  baseDecode,
  baseEncode,
  createTransaction,
  formatNearAmount,
} from "near-api-js";
import { NEAR_RPC_DEFAULTS } from "../../src/config.js";
import { outcomeOf } from "../../src/near/gateway.js";
import { wasmProblems } from "../../src/near/wasm.js";
import type { NearNetwork, NearTxOutcome } from "../../src/types.js";
import { registerSecret } from "./report.js";

export const WASM_PATH = resolve("contracts/near-badges/res/near_badges.wasm");
/** Where `near-deploy --create-account` keeps the contract account's own key. */
export const DEPLOYER_FILE = resolve("secrets/near-deployer.env");
/** 1 NEAR per 100 kB: the protocol's storage price, per byte, in yocto. */
export const YOCTO_PER_BYTE = 10n ** 19n;
/** An account that has never had code has this hash. */
export const NO_CODE = "11111111111111111111111111111111";
export const TGAS = 1_000_000_000_000n;

export function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3).trim() || undefined;
}

export function flag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

/** KEY=VALUE lines of a secrets file, or nothing when it does not exist. */
export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m?.[1] && m[2] !== undefined) out[m[1]] = m[2].trim();
  }
  return out;
}

/** The environment first, then the deployer file: what `--create-account` wrote stays usable. */
export function setting(key: string): string | undefined {
  const fromEnv = process.env[key]?.trim();
  const value = fromEnv || readEnvFile(DEPLOYER_FILE)[key];
  if (value && /PRIVATE_KEY$/.test(key)) registerSecret(value);
  return value || undefined;
}

export function networkSetting(): { network: NearNetwork; rpcUrl: string } | null {
  const network = (setting("NEAR_NETWORK") ?? "testnet") as NearNetwork;
  if (network !== "testnet" && network !== "mainnet") return null;
  return { network, rpcUrl: setting("NEAR_RPC_URL") ?? NEAR_RPC_DEFAULTS[network] };
}

export function nearAmount(yocto: bigint): string {
  return `${formatNearAmount(yocto.toString(), 4)} NEAR`;
}

export function keyFrom(text: string | undefined): KeyPair | null {
  if (!text) return null;
  try {
    return KeyPair.fromString(text as KeyPairString);
  } catch {
    return null;
  }
}

export interface ContractCode {
  bytes: Uint8Array;
  sha256: string;
  /** What NEAR reports as the account's `code_hash` once this is deployed. */
  codeHash: string;
  problems: string[];
}

export function readContract(): ContractCode | null {
  if (!existsSync(WASM_PATH)) return null;
  const bytes = new Uint8Array(readFileSync(WASM_PATH));
  const digest = createHash("sha256").update(bytes).digest();
  return {
    bytes,
    sha256: digest.toString("hex"),
    codeHash: baseEncode(digest),
    problems: wasmProblems(bytes),
  };
}

export async function isFullAccessKey(rpc: JsonRpcProvider, accountId: string, publicKey: string): Promise<boolean> {
  try {
    const key = (await rpc.viewAccessKey({ accountId, publicKey, finalityQuery: { finality: "final" } })) as unknown as {
      permission: unknown;
    };
    return key.permission === "FullAccess";
  } catch {
    return false;
  }
}

export async function accountOrNull(rpc: JsonRpcProvider, accountId: string) {
  try {
    return await rpc.viewAccount({ accountId });
  } catch {
    return null;
  }
}

export function explorerTx(network: NearNetwork, hash: string): string {
  return `https://${network === "mainnet" ? "" : "testnet."}nearblocks.io/txns/${hash}`;
}

/**
 * Signs `actions` from `signerId` to `receiverId` with `key` and waits for
 * FINAL. Throws only when there was no answer; a refused transaction comes
 * back as `{ status: "failure" }`.
 */
export async function sendActions(
  rpc: JsonRpcProvider,
  key: KeyPair,
  signerId: string,
  receiverId: string,
  build: Action[],
): Promise<{ hash: string; outcome: Promise<NearTxOutcome> }> {
  const access = (await rpc.viewAccessKey({
    accountId: signerId,
    publicKey: key.getPublicKey().toString(),
    finalityQuery: { finality: "final" },
  })) as unknown as { nonce: bigint | number; block_hash: string };
  const tx = createTransaction(
    signerId,
    key.getPublicKey(),
    receiverId,
    BigInt(access.nonce) + 1n,
    build,
    baseDecode(access.block_hash),
  );
  const { signedTransaction, txHash } = await new KeyPairSigner(key).signTransaction(tx);
  const hash = baseEncode(txHash);
  return {
    hash,
    outcome: rpc.sendTransactionUntil(signedTransaction, "FINAL").then((res) => outcomeOf(hash, res)),
  };
}
