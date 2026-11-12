/**
 * Issuing a NEAR badge: the NEAR branch of POST /events/:eventId/claims.
 *
 * Much shorter than the XRPL path, because NEAR needs none of its dance. An
 * account can hold a token on a contract without signing anything and without
 * existing on chain, so the desk mints straight to the attendee: no offer, no
 * Xaman payload, no accept, no confirm. The mint transaction is the record.
 *
 * The order is what makes it safe to retry, and to crash at any line:
 *
 *   1. TAKE THE SLOT (the same `claims` row XRPL uses). Two desks scanning one
 *      attendee at the same instant: one mints, the other is told it is under
 *      way.
 *   2. SIGN, AND SAVE BEFORE SENDING. A NEAR transaction's hash is fixed when
 *      it is signed. The bytes go on the slot first; a request that dies after
 *      sending is finished by the next one sending the SAME bytes, which is the
 *      same transaction and cannot mint twice.
 *   3. SEND AND WAIT FOR FINAL. Nothing is recorded on an optimistic result.
 *   4. RECORD from the contract's answer: the token id, and the block height
 *      from the contract's own record, never a retry's.
 *
 * Mints go one at a time through this process: one minter key, one nonce
 * sequence. The contract also refuses a second badge for an (event, account)
 * pair, so even two servers sharing a key cannot double-mint, only collide.
 */
import { TransactionFailedError, XrplLayerError } from "../errors.js";
import type {
  AttendanceRecord,
  AttendanceRepository,
  ClaimRecord,
  ClaimRepository,
  EventRecord,
  NearAttendance,
  NearGateway,
  NearSignedTx,
} from "../types.js";
import { assertNearAccountId, isImplicitAccountId } from "./account.js";
import { nearAttendance, parseMintResult, signNearMint } from "./badges.js";

export interface NearIssueDeps {
  near: NearGateway;
  claims: ClaimRepository;
  attendance: AttendanceRepository;
}

export type NearIssueResult =
  /** Minted now, or finished from an earlier request's saved transaction. */
  | { kind: "issued"; record: AttendanceRecord; onChain: NearAttendance }
  /** Already in the attendance index: nothing was sent. */
  | { kind: "duplicate"; record: AttendanceRecord };

interface Logger {
  warn(obj: object, msg: string): void;
}

let queue: Promise<unknown> = Promise.resolve();

/** Runs `fn` after every mint before it has finished. One minter key, one line. */
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

export async function issueNearBadge(
  deps: NearIssueDeps,
  event: EventRecord,
  address: string,
  log?: Logger,
): Promise<NearIssueResult> {
  const { near } = deps;
  const eventId = event.eventId;
  assertNearAccountId(address, near.network);

  // A typo in a named account would mint, forever, to an account nobody has.
  // An implicit account is a key, and holds the badge before it exists.
  if (!isImplicitAccountId(address) && !(await near.accountExists(address))) {
    throw new XrplLayerError(
      "ACCOUNT_NOT_FOUND",
      `There is no NEAR account called ${address} on ${near.network}. Check the spelling.`,
      { address, network: near.network },
    );
  }

  const existing = await deps.attendance.findByEventAndAddress(eventId, address);
  if (existing) return { kind: "duplicate", record: existing };

  // 1. The slot.
  let claim = await deps.claims.open({ eventId, address });
  if (!claim) {
    const held = await deps.claims.find(eventId, address);
    if (!held) {
      throw new XrplLayerError("CONFLICT", "The claim slot changed under this request. Try again.", {
        eventId,
        address,
      });
    }
    if (held.status === "pending" && !held.nearTx) {
      throw new XrplLayerError(
        "CONFLICT",
        `A badge for ${address} is being issued right now. Give it a few seconds.`,
        { eventId, address },
      );
    }
    // A saved transaction from a request that did not finish, or a claimed
    // slot whose attendance row is missing: either way, finish it below.
    claim = held;
  }

  const result = await oneAtATime(() => mintAndConfirm(deps, event, address, claim, log));
  return result;
}

async function mintAndConfirm(
  deps: NearIssueDeps,
  event: EventRecord,
  address: string,
  claim: ClaimRecord,
  log?: Logger,
): Promise<NearIssueResult> {
  const { near } = deps;
  const eventId = event.eventId;

  // 2. Sign and save, unless an earlier request already did.
  let signed: NearSignedTx | null = claim.nearTx ?? null;
  if (!signed) {
    signed = await signNearMint(near, { eventId, accountId: address, eventTitle: event.name });
    await deps.claims.attach(claim.id, { nearTx: signed });
  }

  // 3. Send. An expired transaction never ran; sign once more and send that.
  let outcome = await near.send(signed);
  if (outcome.status === "expired") {
    const onChain = await nearAttendance(near, eventId, address);
    if (onChain) {
      // Minted by something other than this slot's transaction: another
      // server, or a script. The chain is right; the hash to index is not
      // known here. Leave the slot for an operator rather than guess.
      throw new XrplLayerError(
        "CONFLICT",
        `${address} already holds event ${eventId}'s badge on NEAR, minted outside this claim. ` +
          "Nothing was sent.",
        { eventId, address, tokenId: onChain.tokenId, blockHeight: onChain.blockHeight },
      );
    }
    signed = await signNearMint(near, { eventId, accountId: address, eventTitle: event.name });
    await deps.claims.attach(claim.id, { nearTx: signed });
    outcome = await near.send(signed);
  }

  if (outcome.status === "failure") {
    // The contract refused: paused, out of storage, not a minter. Nothing was
    // minted, so the slot goes and the attendee can be issued again later.
    await deps.claims.delete(claim.id);
    throw new TransactionFailedError("NEAR_CONTRACT_REFUSED", `The badge contract refused to mint: ${outcome.error}`, {
      eventId,
      address,
      txHash: outcome.hash,
    });
  }
  if (outcome.status === "expired") {
    throw new XrplLayerError("CONNECTION_FAILED", "The NEAR network did not take the mint. Try again.", {
      eventId,
      address,
      hash: outcome.hash,
    });
  }

  // 4. Record. The block height comes from the contract's record.
  const { already, attendance: onChain } = parseMintResult(outcome.value);
  if (already) {
    log?.warn(
      { eventId, address, hash: outcome.hash, blockHeight: onChain.blockHeight },
      "nft_mint found an existing record; indexing it under the transaction that returned it",
    );
  }
  try {
    const record = await deps.attendance.insert({
      eventId,
      address,
      nftokenId: onChain.tokenId,
      offerId: null,
      txHash: outcome.hash,
      ledgerIndex: onChain.blockHeight,
      claimedAt: onChain.mintedAt,
    });
    await markClaimed(deps, claim, log);
    return { kind: "issued", record, onChain };
  } catch (err) {
    // Another request for the same slot recorded it first: that is success.
    if (err instanceof XrplLayerError && err.code === "DUPLICATE_CLAIM") {
      const record = await deps.attendance.findByEventAndAddress(eventId, address);
      await markClaimed(deps, claim, log);
      if (record) return { kind: "issued", record, onChain };
    }
    throw err;
  }
}

async function markClaimed(deps: NearIssueDeps, claim: ClaimRecord, log?: Logger): Promise<void> {
  if (claim.status === "claimed") return;
  try {
    await deps.claims.markClaimed(claim.id);
  } catch (err) {
    // The attendance row is what counts; a slot left pending only costs a
    // retry that finds the row and stops.
    log?.warn({ claimId: claim.id, err }, "could not mark the NEAR claim slot claimed");
  }
}
