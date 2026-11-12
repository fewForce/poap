import { createHash } from "node:crypto";
import { KeyPair, SignedTransaction, base64Decode, baseEncode, encodeTransaction } from "near-api-js";
import { describe, expect, it, vi } from "vitest";
import { InvalidNonceError, TransactionExpiredError } from "near-api-js/rpc-errors";
import { ConnectionError, XrplLayerError } from "../errors.js";
import { NearConnection, failureMessage, type NearRpc } from "./gateway.js";

const CONTRACT = "badges.feooh.testnet";
const BLOCK_HASH = baseEncode(new Uint8Array(32).fill(7));

function successValue(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

function fakeRpc(overrides: Partial<Record<keyof NearRpc, unknown>> = {}): NearRpc {
  return {
    callFunction: vi.fn(async () => ({ ok: true })),
    viewAccount: vi.fn(async () => ({ amount: "1" })),
    viewAccessKey: vi.fn(async () => ({ nonce: 5n, block_hash: BLOCK_HASH, permission: "FullAccess" })),
    sendTransactionUntil: vi.fn(async () => ({ status: { SuccessValue: successValue({ ok: 1 }) }, receipts_outcome: [] })),
    viewTransactionStatus: vi.fn(async () => {
      throw new Error("UNKNOWN_TRANSACTION");
    }),
    ...overrides,
  } as unknown as NearRpc;
}

function connection(rpc: NearRpc, key = KeyPair.fromRandom("ed25519")) {
  const near = new NearConnection(
    {
      network: "testnet",
      rpcUrl: "https://rpc.mock",
      contractId: CONTRACT,
      minterAccountId: CONTRACT,
      minterPrivateKey: key.toString(),
    },
    rpc,
  );
  return { near, key };
}

describe("NearConnection.signCall", () => {
  it("signs a call to the contract with the next nonce, and the hash is the transaction's", async () => {
    const { near, key } = connection(fakeRpc());
    const signed = await near.signCall("nft_mint", { event_id: 1, receiver_id: "alice.testnet", event_title: "T" });

    const decoded = SignedTransaction.decode(base64Decode(signed.signedTx));
    const tx = decoded.transaction;
    expect(tx.receiverId).toBe(CONTRACT);
    expect(tx.signerId).toBe(CONTRACT);
    expect(BigInt(tx.nonce)).toBe(6n);
    expect(tx.actions[0]?.functionCall?.methodName).toBe("nft_mint");
    expect(tx.actions[0]?.functionCall?.deposit).toBe(0n);

    const digest = createHash("sha256").update(encodeTransaction(tx)).digest();
    expect(signed.hash).toBe(baseEncode(digest));
    // borsh decodes the fixed-size signature as a plain array.
    const sig = Uint8Array.from(decoded.signature.ed25519Signature?.data ?? []);
    expect(key.verify(digest, sig)).toBe(true);
  });

  it("never reuses a nonce, even when the chain has not caught up", async () => {
    const { near } = connection(fakeRpc());
    const a = await near.signCall("nft_mint", {});
    const b = await near.signCall("nft_mint", {});
    const nonce = (s: { signedTx: string }) => BigInt(SignedTransaction.decode(base64Decode(s.signedTx)).transaction.nonce);
    expect(nonce(a)).toBe(6n);
    expect(nonce(b)).toBe(7n);
  });

  it("follows the chain when it is ahead", async () => {
    const rpc = fakeRpc({ viewAccessKey: vi.fn(async () => ({ nonce: 41n, block_hash: BLOCK_HASH })) });
    const { near } = connection(rpc);
    const s = await near.signCall("nft_mint", {});
    expect(BigInt(SignedTransaction.decode(base64Decode(s.signedTx)).transaction.nonce)).toBe(42n);
  });

  it("says plainly when the key is not on the account", async () => {
    const rpc = fakeRpc({
      viewAccessKey: vi.fn(async () => {
        throw new Error("access key ed25519:abc does not exist while viewing");
      }),
    });
    const { near } = connection(rpc);
    await expect(near.signCall("nft_mint", {})).rejects.toBeInstanceOf(ConnectionError);
  });
});

describe("NearConnection.send", () => {
  async function signedFor(near: NearConnection) {
    return near.signCall("nft_mint", { event_id: 1, receiver_id: "alice.testnet", event_title: "T" });
  }

  it("reads the call's JSON result when it succeeds", async () => {
    const value = { already: false, attendance: { token_id: "1:alice.testnet" } };
    const rpc = fakeRpc({
      sendTransactionUntil: vi.fn(async () => ({ status: { SuccessValue: successValue(value) }, receipts_outcome: [] })),
    });
    const { near } = connection(rpc);
    const signed = await signedFor(near);
    await expect(near.send(signed)).resolves.toEqual({ status: "success", hash: signed.hash, value });
    expect(rpc.sendTransactionUntil).toHaveBeenCalledWith(expect.anything(), "FINAL");
  });

  it("reports the contract's panic when it refuses", async () => {
    const failure = {
      ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: Minting is paused" } } },
    };
    const rpc = fakeRpc({ sendTransactionUntil: vi.fn(async () => ({ status: { Failure: failure }, receipts_outcome: [] })) });
    const { near } = connection(rpc);
    const signed = await signedFor(near);
    await expect(near.send(signed)).resolves.toEqual({ status: "failure", hash: signed.hash, error: "Minting is paused" });
  });

  it("finds a transaction that already ran when the resend is refused", async () => {
    const value = { already: false };
    const rpc = fakeRpc({
      sendTransactionUntil: vi.fn(async () => {
        throw Object.assign(new Error("Transaction nonce 6 must be larger than nonce of the used access key 6"), {
          type: "InvalidNonce",
        });
      }),
      viewTransactionStatus: vi.fn(async () => ({ status: { SuccessValue: successValue(value) }, receipts_outcome: [] })),
    });
    const { near } = connection(rpc);
    const signed = await signedFor(near);
    await expect(near.send(signed)).resolves.toEqual({ status: "success", hash: signed.hash, value });
  });

  it("knows near-api-js's own nonce and expiry errors mean it will never run", async () => {
    for (const thrown of [
      new InvalidNonceError(9, 6, "h", "b"),
      new TransactionExpiredError("h", "b"),
    ]) {
      const rpc = fakeRpc({
        sendTransactionUntil: vi.fn(async () => {
          throw thrown;
        }),
      });
      const { near } = connection(rpc);
      const signed = await signedFor(near);
      await expect(near.send(signed)).resolves.toEqual({ status: "expired", hash: signed.hash });
    }
  });

  it("calls a transaction that will never run expired", async () => {
    const rpc = fakeRpc({
      sendTransactionUntil: vi.fn(async () => {
        throw Object.assign(new Error("Transaction has expired"), { type: "Expired" });
      }),
    });
    const { near } = connection(rpc);
    const signed = await signedFor(near);
    await expect(near.send(signed)).resolves.toEqual({ status: "expired", hash: signed.hash });
  });

  it("gives up on a node that never answers, so the mint queue moves on", async () => {
    vi.useFakeTimers();
    try {
      const rpc = fakeRpc({ sendTransactionUntil: vi.fn(() => new Promise(() => undefined)) });
      const { near } = connection(rpc);
      const signed = await signedFor(near);
      const sent = near.send(signed);
      const caught = sent.catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(31_000);
      expect(await caught).toBeInstanceOf(ConnectionError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not guess when the node simply did not answer", async () => {
    const rpc = fakeRpc({
      sendTransactionUntil: vi.fn(async () => {
        throw new Error("fetch failed");
      }),
    });
    const { near } = connection(rpc);
    await expect(near.send(await signedFor(near))).rejects.toBeInstanceOf(ConnectionError);
  });
});

describe("NearConnection.accountExists", () => {
  it("is true for an account the node knows", async () => {
    const { near } = connection(fakeRpc());
    await expect(near.accountExists("alice.testnet")).resolves.toBe(true);
  });

  it("is false for one it does not", async () => {
    const rpc = fakeRpc({
      viewAccount: vi.fn(async () => {
        throw new Error("account nobody.testnet does not exist while viewing");
      }),
    });
    const { near } = connection(rpc);
    await expect(near.accountExists("nobody.testnet")).resolves.toBe(false);
  });

  it("throws when the node could not say", async () => {
    const rpc = fakeRpc({
      viewAccount: vi.fn(async () => {
        throw new Error("fetch failed");
      }),
    });
    const { near } = connection(rpc);
    await expect(near.accountExists("alice.testnet")).rejects.toBeInstanceOf(ConnectionError);
  });
});

describe("the minter key", () => {
  it("is refused when malformed, without being repeated", () => {
    const secret = "ed25519:not-a-real-key-but-secret-looking";
    try {
      new NearConnection(
        { network: "testnet", rpcUrl: "x", contractId: CONTRACT, minterAccountId: CONTRACT, minterPrivateKey: secret },
        fakeRpc(),
      );
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(XrplLayerError);
      expect((err as Error).message).not.toContain("secret-looking");
    }
  });
});

describe("failureMessage", () => {
  it("falls back to the raw failure when there is no panic in it", () => {
    expect(failureMessage({ InvalidTxError: "NotEnoughBalance" })).toContain("NotEnoughBalance");
  });
});
