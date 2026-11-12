/**
 * The NEAR gateway: JSON-RPC to one node, one contract, one key.
 *
 * Everything that touches NEAR goes through a NearGateway (src/types.ts), the
 * way everything that touches XRPL goes through an XrplGateway. This is the
 * real one; tests use test/helpers/mock-near-gateway.ts and never the network.
 *
 * THE KEY. NEAR_MINTER_PRIVATE_KEY is meant to be a function-call access key
 * on the contract's own account, limited to `nft_mint` with no deposit. It is
 * held here and nowhere else: never logged, never in a response or an error.
 *
 * NONCES. Every transaction from an access key carries a nonce greater than
 * the last one the chain has seen from it. Two transactions signed close
 * together get increasing nonces from a counter kept here, so they do not
 * collide; if they reach the chain out of order the later-nonced one wins and
 * the other comes back as `expired`, which the caller answers by signing again.
 * src/near/issue.ts sends mints one at a time, so that is rare.
 */
import {
  JsonRpcProvider,
  KeyPairSigner,
  SignedTransaction,
  actions,
  base64Decode,
  base64Encode,
  baseDecode,
  baseEncode,
  createTransaction,
  type KeyPairString,
} from "near-api-js";
import { ConnectionError, XrplLayerError } from "../errors.js";
import type { NearGateway, NearNetwork, NearSignedTx, NearTxOutcome } from "../types.js";

/** Enough for a mint, which writes a few records. Unused gas is refunded. */
const CALL_GAS = 30_000_000_000_000n;

export interface NearGatewayConfig {
  network: NearNetwork;
  rpcUrl: string;
  contractId: string;
  minterAccountId: string;
  /** `ed25519:<base58>`. Never logged. */
  minterPrivateKey: string;
}

/** The part of near-api-js's JsonRpcProvider this file uses. Tests hand in a fake. */
export type NearRpc = Pick<
  JsonRpcProvider,
  "callFunction" | "viewAccount" | "viewAccessKey" | "sendTransactionUntil" | "viewTransactionStatus"
>;

type RpcResponse = Awaited<ReturnType<NearRpc["sendTransactionUntil"]>>;

/** Errors that mean "this transaction will never run", whatever else is true. */
const NEVER_RUNS = /InvalidNonce|Expired|InvalidTxError|nonce .*(too|less|already)|expired/i;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function typeOf(err: unknown): string {
  const t = (err as { type?: unknown } | null)?.type;
  return typeof t === "string" ? t : "";
}

/** The first `ExecutionError` string in a failure, which is the contract's panic. */
export function failureMessage(failure: unknown): string {
  const seen = new Set<unknown>();
  const walk = (v: unknown): string | undefined => {
    if (v === null || typeof v !== "object" || seen.has(v)) return undefined;
    seen.add(v);
    for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
      if (key === "ExecutionError" && typeof value === "string") return value;
      const found = walk(value);
      if (found) return found;
    }
    return undefined;
  };
  const panic = walk(failure);
  if (panic) return panic.replace(/^Smart contract panicked: /, "");
  return JSON.stringify(failure);
}

/** Reads a final RPC response into an outcome. */
export function outcomeOf(hash: string, res: RpcResponse): NearTxOutcome {
  const status = (res as { status?: unknown }).status as
    | { SuccessValue?: string; Failure?: unknown }
    | string
    | undefined;
  if (status && typeof status === "object" && "Failure" in status && status.Failure) {
    return { status: "failure", hash, error: failureMessage(status.Failure) };
  }
  // A receipt can fail after the transaction itself succeeded. For a single
  // function call that is the call itself, so look there too.
  const receipts = ((res as { receipts_outcome?: unknown[] }).receipts_outcome ?? []) as Array<{
    outcome?: { status?: { Failure?: unknown } };
  }>;
  for (const r of receipts) {
    const failure = r.outcome?.status?.Failure;
    if (failure) return { status: "failure", hash, error: failureMessage(failure) };
  }
  if (status && typeof status === "object" && typeof status.SuccessValue === "string") {
    const raw = status.SuccessValue ? Buffer.from(status.SuccessValue, "base64").toString("utf8") : "";
    let value: unknown = null;
    try {
      value = raw ? JSON.parse(raw) : null;
    } catch {
      value = raw;
    }
    return { status: "success", hash, value };
  }
  throw new XrplLayerError("LEDGER_QUERY_FAILED", "The NEAR node returned a transaction with no final status.", {
    hash,
  });
}

export class NearConnection implements NearGateway {
  readonly network: NearNetwork;
  readonly rpcUrl: string;
  readonly contractId: string;
  readonly minterAccountId: string;
  readonly #signer: KeyPairSigner;
  readonly #rpc: NearRpc;
  /** The highest nonce this process has signed with. */
  #lastNonce = 0n;

  constructor(config: NearGatewayConfig, rpc?: NearRpc) {
    this.network = config.network;
    this.rpcUrl = config.rpcUrl;
    this.contractId = config.contractId;
    this.minterAccountId = config.minterAccountId;
    try {
      this.#signer = KeyPairSigner.fromSecretKey(config.minterPrivateKey as KeyPairString);
    } catch {
      // Not the key's text: the message must never carry it.
      throw new XrplLayerError(
        "CONFIG_INVALID",
        "NEAR_MINTER_PRIVATE_KEY is not a NEAR private key (expected ed25519:<base58>).",
      );
    }
    this.#rpc = rpc ?? new JsonRpcProvider({ url: config.rpcUrl });
  }

  async view<T>(method: string, args: Record<string, unknown>): Promise<T> {
    try {
      return (await this.#rpc.callFunction({ contractId: this.contractId, method, args })) as T;
    } catch (err) {
      throw new ConnectionError(`NEAR view ${method} on ${this.contractId} failed: ${messageOf(err)}`, {
        method,
        contractId: this.contractId,
      });
    }
  }

  async accountExists(accountId: string): Promise<boolean> {
    try {
      await this.#rpc.viewAccount({ accountId, blockQuery: { finality: "final" } });
      return true;
    } catch (err) {
      if (/does not exist|UNKNOWN_ACCOUNT|AccountDoesNotExist/i.test(`${typeOf(err)} ${messageOf(err)}`)) {
        return false;
      }
      throw new ConnectionError(`Could not look up NEAR account ${accountId}: ${messageOf(err)}`, {
        accountId,
      });
    }
  }

  async signCall(method: string, args: Record<string, unknown>): Promise<NearSignedTx> {
    const publicKey = await this.#signer.getPublicKey();
    let key: { nonce: bigint | number; block_hash: string };
    try {
      key = (await this.#rpc.viewAccessKey({
        accountId: this.minterAccountId,
        publicKey: publicKey.toString(),
        finalityQuery: { finality: "final" },
      })) as unknown as { nonce: bigint | number; block_hash: string };
    } catch (err) {
      throw new ConnectionError(
        `The minter key is not an access key of ${this.minterAccountId}, or the node did not answer: ` +
          messageOf(err),
        { minterAccountId: this.minterAccountId },
      );
    }
    const chainNonce = BigInt(key.nonce);
    const nonce = (chainNonce > this.#lastNonce ? chainNonce : this.#lastNonce) + 1n;
    this.#lastNonce = nonce;

    const tx = createTransaction(
      this.minterAccountId,
      publicKey,
      this.contractId,
      nonce,
      [actions.functionCall(method, args, CALL_GAS, 0n)],
      baseDecode(key.block_hash),
    );
    const { txHash, signedTransaction } = await this.#signer.signTransaction(tx);
    return { hash: baseEncode(txHash), signedTx: base64Encode(signedTransaction.encode()) };
  }

  async send(signed: NearSignedTx): Promise<NearTxOutcome> {
    const tx = SignedTransaction.decode(base64Decode(signed.signedTx));
    try {
      return outcomeOf(signed.hash, await this.#rpc.sendTransactionUntil(tx, "FINAL"));
    } catch (sendErr) {
      // Maybe it ran already — a resend of bytes that landed the first time —
      // or maybe it never will. The chain knows; ask it by hash.
      const known = await this.#statusByHash(signed.hash);
      if (known) return known;
      if (NEVER_RUNS.test(`${typeOf(sendErr)} ${messageOf(sendErr)}`)) {
        return { status: "expired", hash: signed.hash };
      }
      if (/panicked/i.test(messageOf(sendErr))) {
        return { status: "failure", hash: signed.hash, error: messageOf(sendErr) };
      }
      throw new ConnectionError(`Sending a NEAR transaction failed: ${messageOf(sendErr)}`, {
        hash: signed.hash,
      });
    }
  }

  async #statusByHash(hash: string): Promise<NearTxOutcome | null> {
    try {
      const res = await this.#rpc.viewTransactionStatus({
        txHash: hash,
        accountId: this.minterAccountId,
        waitUntil: "FINAL",
      });
      return outcomeOf(hash, res);
    } catch {
      return null;
    }
  }
}

export function createNearGateway(config: NearGatewayConfig): NearGateway {
  return new NearConnection(config);
}
