import { describe, expect, it } from "vitest";
import { ed25519Wallet } from "../../test/helpers/ed25519-wallet.js";
import { MockGateway, rippledError } from "../../test/helpers/mock-gateway.js";
import { XrplLayerError } from "../errors.js";
import { isSignedByAddress, masterKeyCounts, registrationMessage } from "./wallet-proof.js";

const FIELDS = { eventId: 700013, displayName: "Ann Lee", email: "ann@example.com", challenge: "c-1" };

describe("registrationMessage", () => {
  it("is plain text a person could read, one field a line", () => {
    expect(registrationMessage({ ...FIELDS, address: "rAddr" })).toBe(
      "poap.live registration\nevent: 700013\naddress: rAddr\nname: Ann Lee\nemail: ann@example.com\nchallenge: c-1",
    );
  });

  it("writes a missing email as an empty line, the same as an empty one", () => {
    const a = registrationMessage({ ...FIELDS, address: "rAddr", email: undefined });
    expect(a).toContain("\nemail: \n");
    expect(registrationMessage({ ...FIELDS, address: "rAddr", email: null })).toBe(a);
  });
});

describe("isSignedByAddress", () => {
  const wallet = ed25519Wallet();
  const message = registrationMessage({ ...FIELDS, address: wallet.address });

  it("accepts the wallet's own signature over the message", () => {
    expect(isSignedByAddress({ address: wallet.address, publicKey: wallet.publicKey, signature: wallet.sign(message), message })).toBe(true);
  });

  it("refuses a signature over anything else — a different name, say", () => {
    const other = registrationMessage({ ...FIELDS, address: wallet.address, displayName: "Mallory" });
    expect(isSignedByAddress({ address: wallet.address, publicKey: wallet.publicKey, signature: wallet.sign(other), message })).toBe(false);
  });

  it("refuses a real signature from a key that is not this address's", () => {
    const thief = ed25519Wallet();
    const msg = registrationMessage({ ...FIELDS, address: wallet.address });
    expect(isSignedByAddress({ address: wallet.address, publicKey: thief.publicKey, signature: thief.sign(msg), message: msg })).toBe(false);
  });

  it("refuses rubbish without throwing", () => {
    expect(isSignedByAddress({ address: wallet.address, publicKey: "ED00", signature: "zz", message })).toBe(false);
    expect(isSignedByAddress({ address: wallet.address, publicKey: wallet.publicKey, signature: "00".repeat(64), message })).toBe(false);
  });
});

describe("masterKeyCounts", () => {
  const ADDRESS = "rNasjPPz3pA637wAfr25xedCoDVrwDDzU6";

  it("counts for an account not on the ledger yet — a new app wallet", async () => {
    const gateway = new MockGateway().onRequest("account_info", rippledError("actNotFound"));
    expect(await masterKeyCounts(gateway, ADDRESS)).toBe(true);
  });

  it("counts for an ordinary account", async () => {
    const gateway = new MockGateway().onRequest("account_info", { result: { account_data: { Flags: 0 } } });
    expect(await masterKeyCounts(gateway, ADDRESS)).toBe(true);
  });

  it("does not count once the account has disabled it", async () => {
    const gateway = new MockGateway().onRequest("account_info", { result: { account_data: { Flags: 0x0010_0000 } } });
    expect(await masterKeyCounts(gateway, ADDRESS)).toBe(false);
  });

  it("says so when the ledger cannot be read, rather than guessing", async () => {
    const gateway = new MockGateway().onRequest("account_info", rippledError("tooBusy"));
    await expect(masterKeyCounts(gateway, ADDRESS)).rejects.toMatchObject({ code: "LEDGER_QUERY_FAILED" });
    await expect(masterKeyCounts(gateway, ADDRESS)).rejects.toBeInstanceOf(XrplLayerError);
  });
});
