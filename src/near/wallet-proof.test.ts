import { describe, expect, it } from "vitest";
import { ed25519Wallet } from "../../test/helpers/ed25519-wallet.js";
import { registrationMessage } from "../xrpl/wallet-proof.js";
import { ed25519KeyHex, isSignedByImplicitAccount } from "./wallet-proof.js";

/** The POAP app's wallet, and its NEAR implicit account: the same key. */
function appWallet() {
  const wallet = ed25519Wallet();
  return { wallet, accountId: wallet.publicKey.slice(2).toLowerCase() };
}

const fields = (accountId: string) => ({
  eventId: 70011,
  address: accountId,
  displayName: "Priya Raman",
  email: null,
  challenge: "challenge-0123456789abcdef",
});

describe("ed25519KeyHex", () => {
  it("reads XRPL's ED-prefixed spelling and the bare one alike", () => {
    const { wallet, accountId } = appWallet();
    expect(ed25519KeyHex(wallet.publicKey)).toBe(accountId);
    expect(ed25519KeyHex(accountId)).toBe(accountId);
  });

  it("refuses anything else", () => {
    expect(ed25519KeyHex("02" + "a".repeat(64))).toBeNull();
    expect(ed25519KeyHex("ed" + "a".repeat(63))).toBeNull();
  });
});

describe("isSignedByImplicitAccount", () => {
  it("accepts the account's own key signing the registration text", () => {
    const { wallet, accountId } = appWallet();
    const message = registrationMessage(fields(accountId));
    expect(
      isSignedByImplicitAccount({ accountId, publicKey: wallet.publicKey, signature: wallet.sign(message), message }),
    ).toBe(true);
  });

  it("accepts the key sent bare", () => {
    const { wallet, accountId } = appWallet();
    const message = registrationMessage(fields(accountId));
    expect(isSignedByImplicitAccount({ accountId, publicKey: accountId, signature: wallet.sign(message), message })).toBe(
      true,
    );
  });

  it("refuses a key that is not the account", () => {
    const { accountId } = appWallet();
    const other = appWallet().wallet;
    const message = registrationMessage(fields(accountId));
    expect(
      isSignedByImplicitAccount({ accountId, publicKey: other.publicKey, signature: other.sign(message), message }),
    ).toBe(false);
  });

  it("refuses a signature over different text", () => {
    const { wallet, accountId } = appWallet();
    const message = registrationMessage(fields(accountId));
    const signature = wallet.sign(registrationMessage({ ...fields(accountId), displayName: "Someone Else" }));
    expect(isSignedByImplicitAccount({ accountId, publicKey: wallet.publicKey, signature, message })).toBe(false);
  });

  it("refuses a named account, whose keys it cannot see", () => {
    const { wallet } = appWallet();
    const message = registrationMessage(fields("alice.testnet"));
    expect(
      isSignedByImplicitAccount({
        accountId: "alice.testnet",
        publicKey: wallet.publicKey,
        signature: wallet.sign(message),
        message,
      }),
    ).toBe(false);
  });

  it("never throws on garbage", () => {
    expect(isSignedByImplicitAccount({ accountId: "x", publicKey: "y", signature: "z", message: "" })).toBe(false);
  });
});
