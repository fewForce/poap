import { beforeEach, describe, expect, it } from "vitest";
import { MockNearGateway } from "../../test/helpers/mock-near-gateway.js";
import { MemoryAttendanceRepository, MemoryClaimRepository } from "../db/memory.js";
import { XrplLayerError } from "../errors.js";
import type { EventRecord } from "../types.js";
import { issueNearBadge, type NearIssueDeps } from "./issue.js";

const EVENT: EventRecord = { eventId: 70011, name: "Make Waves", status: "live", chain: "near" };
const IMPLICIT = "98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6648cdf0dbd6de";

let near: MockNearGateway;
let deps: NearIssueDeps & { claims: MemoryClaimRepository; attendance: MemoryAttendanceRepository };

beforeEach(() => {
  near = new MockNearGateway();
  near.accounts.add("alice.testnet");
  deps = { near, claims: new MemoryClaimRepository(), attendance: new MemoryAttendanceRepository() };
});

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return err instanceof XrplLayerError ? err.code : String(err);
  }
  return "no error";
}

describe("issueNearBadge", () => {
  it("mints straight to the attendee and records the mint", async () => {
    const result = await issueNearBadge(deps, EVENT, "alice.testnet");
    expect(result.kind).toBe("issued");
    if (result.kind !== "issued") return;

    expect(result.record).toMatchObject({
      eventId: 70011,
      address: "alice.testnet",
      nftokenId: "70011:alice.testnet",
      offerId: null,
      txHash: near.signed[0]!.hash,
      ledgerIndex: result.onChain.blockHeight,
    });
    expect(near.signed[0]!.args).toEqual({ event_id: 70011, receiver_id: "alice.testnet", event_title: "Make Waves" });
    expect((await deps.claims.find(70011, "alice.testnet"))?.status).toBe("claimed");
  });

  it("does not need an implicit account to exist", async () => {
    const result = await issueNearBadge(deps, EVENT, IMPLICIT);
    expect(result.kind).toBe("issued");
  });

  it("refuses a named account that does not exist, before signing anything", async () => {
    expect(await codeOf(issueNearBadge(deps, EVENT, "nobody.testnet"))).toBe("ACCOUNT_NOT_FOUND");
    expect(near.signed).toHaveLength(0);
  });

  it("refuses an account from the other network", async () => {
    expect(await codeOf(issueNearBadge(deps, EVENT, "alice.near"))).toBe("INVALID_ADDRESS");
  });

  it("refuses an XRPL address", async () => {
    expect(await codeOf(issueNearBadge(deps, EVENT, "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh"))).toBe("INVALID_ADDRESS");
  });

  it("answers a second issue from the index without sending anything", async () => {
    await issueNearBadge(deps, EVENT, "alice.testnet");
    const again = await issueNearBadge(deps, EVENT, "alice.testnet");
    expect(again.kind).toBe("duplicate");
    expect(near.sent).toHaveLength(1);
  });

  it("saves the signed mint before sending it, and finishes it on retry with the same bytes", async () => {
    near.throwOnNextSend("socket hang up");
    expect(await codeOf(issueNearBadge(deps, EVENT, "alice.testnet"))).toMatch(/socket hang up/);

    const slot = await deps.claims.find(70011, "alice.testnet");
    expect(slot?.status).toBe("pending");
    expect(slot?.nearTx?.hash).toBe(near.signed[0]!.hash);

    const retry = await issueNearBadge(deps, EVENT, "alice.testnet");
    expect(retry.kind).toBe("issued");
    // One signature, sent twice: one transaction.
    expect(near.signed).toHaveLength(1);
    expect(near.sent).toEqual([near.signed[0]!.hash, near.signed[0]!.hash]);
    if (retry.kind === "issued") expect(retry.record.txHash).toBe(near.signed[0]!.hash);
  });

  it("signs again when the saved transaction expired without running", async () => {
    near.expireNextSend();
    const result = await issueNearBadge(deps, EVENT, "alice.testnet");
    expect(result.kind).toBe("issued");
    expect(near.signed).toHaveLength(2);
    if (result.kind === "issued") expect(result.record.txHash).toBe(near.signed[1]!.hash);
  });

  it("frees the slot and says why when the contract refuses", async () => {
    near.failNextSend("Minting is paused");
    const err = await issueNearBadge(deps, EVENT, "alice.testnet").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(XrplLayerError);
    expect((err as Error).message).toContain("Minting is paused");
    expect(await deps.claims.find(70011, "alice.testnet")).toBeNull();
    expect(await deps.attendance.findByEventAndAddress(70011, "alice.testnet")).toBeNull();
  });

  it("indexes a badge that exists by the time an expired mint is signed again", async () => {
    // The saved transaction expired; meanwhile the record appeared (this slot's
    // own lost mint, or another process). The re-signed mint is answered with
    // already: true, and the record is indexed rather than left stuck.
    near.mintedElsewhere(70011, "alice.testnet");
    near.expireNextSend();
    const result = await issueNearBadge(deps, EVENT, "alice.testnet");
    expect(result.kind).toBe("issued");
    if (result.kind === "issued") expect(result.record.txHash).toBe(near.signed[1]!.hash);
    expect((await deps.claims.find(70011, "alice.testnet"))?.status).toBe("claimed");
  });

  it("frees the slot when signing fails before anything is sent", async () => {
    near.failNextSign("fetch failed");
    expect(await codeOf(issueNearBadge(deps, EVENT, "alice.testnet"))).toMatch(/fetch failed/);
    expect(await deps.claims.find(70011, "alice.testnet")).toBeNull();
    // The next scan starts clean instead of hearing "being issued" for ever.
    const retry = await issueNearBadge(deps, EVENT, "alice.testnet");
    expect(retry.kind).toBe("issued");
  });

  it("cuts an event title to the contract's 200 bytes, never inside a character", async () => {
    const long = { ...EVENT, name: "会".repeat(120) }; // 360 bytes
    await issueNearBadge(deps, long, "alice.testnet");
    const sent = String(near.signed[0]!.args.event_title);
    expect(Buffer.byteLength(sent, "utf8")).toBeLessThanOrEqual(200);
    expect(sent).toBe("会".repeat(66));
  });

  it("tells a second desk that the first is still issuing", async () => {
    await deps.claims.open({ eventId: 70011, address: "alice.testnet" });
    expect(await codeOf(issueNearBadge(deps, EVENT, "alice.testnet"))).toBe("CONFLICT");
    expect(near.signed).toHaveLength(0);
  });

  it("indexes the contract's own block height, not a later one", async () => {
    near.loseNextResponse();
    await issueNearBadge(deps, EVENT, "alice.testnet").catch(() => undefined);
    near.height += 500;
    const retry = await issueNearBadge(deps, EVENT, "alice.testnet");
    if (retry.kind !== "issued") throw new Error("expected issued");
    expect(retry.record.ledgerIndex).toBe(retry.onChain.blockHeight);
    expect(retry.record.ledgerIndex).toBeLessThan(near.height);
  });
});
