import { describe, expect, it } from "vitest";
import { assertNearAccountId, fitsNetwork, isImplicitAccountId, isNearAccountId } from "./account.js";

const IMPLICIT = "98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6648cdf0dbd6de";

describe("isNearAccountId", () => {
  it.each(["alice.near", "alice.testnet", "desk.feooh.testnet", "a-b_c.near", "ab", IMPLICIT, "near", "alice.tg"])(
    "accepts %s",
    (id) => expect(isNearAccountId(id)).toBe(true),
  );

  it.each([
    ["one character", "a"],
    ["65 characters", "a".repeat(65)],
    ["uppercase", "Alice.near"],
    ["a leading dot", ".alice.near"],
    ["a trailing dot", "alice.near."],
    ["two dots in a row", "alice..near"],
    ["two separators in a row", "al--ice.near"],
    ["a separator before a dot", "alice-.near"],
    ["a space", "alice near"],
    ["markup", "<svg>.near"],
    ["a colon, which token ids use", "1:alice.near"],
    ["an ETH-implicit account, refused for now", "0x" + "a".repeat(40)],
    ["an XRPL address", "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh"],
    ["not a string", 42],
  ])("refuses %s", (_why, id) => expect(isNearAccountId(id)).toBe(false));
});

describe("implicit accounts", () => {
  it("are 64 lowercase hex characters", () => {
    expect(isImplicitAccountId(IMPLICIT)).toBe(true);
    expect(isImplicitAccountId(IMPLICIT.toUpperCase())).toBe(false);
    expect(isImplicitAccountId(IMPLICIT.slice(1))).toBe(false);
  });

  it("belong to both networks", () => {
    expect(fitsNetwork(IMPLICIT, "testnet")).toBe(true);
    expect(fitsNetwork(IMPLICIT, "mainnet")).toBe(true);
  });
});

describe("fitsNetwork", () => {
  it("keeps testnet names on testnet and off mainnet", () => {
    expect(fitsNetwork("alice.testnet", "testnet")).toBe(true);
    expect(fitsNetwork("alice.testnet", "mainnet")).toBe(false);
    expect(fitsNetwork("alice.near", "testnet")).toBe(false);
    expect(fitsNetwork("alice.near", "mainnet")).toBe(true);
    expect(fitsNetwork("alice.tg", "mainnet")).toBe(true);
  });
});

describe("assertNearAccountId", () => {
  it("says what shape is wanted", () => {
    expect(() => assertNearAccountId("Not An Account", "testnet")).toThrow(/Not a NEAR account id/);
  });

  it("says which network is wrong", () => {
    expect(() => assertNearAccountId("alice.near", "testnet")).toThrow(/not a testnet account/);
    expect(() => assertNearAccountId("alice.testnet", "mainnet")).toThrow(/testnet account/);
  });

  it("passes a good one", () => {
    expect(() => assertNearAccountId("alice.testnet", "testnet")).not.toThrow();
  });
});
