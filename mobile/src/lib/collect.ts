/**
 * Collecting a badge the desk issued: the one thing the app signs.
 *
 *   1. poap.live says which offer the desk made for this wallet.
 *   2. The LEDGER is asked about that offer, and the app accepts it only if it
 *      is a sell offer of nothing, made out to this wallet. poap.live is never
 *      trusted to describe what is being signed — a server that asked for an
 *      accept that cost money, or took somebody else's offer, gets nothing.
 *   3. The phone signs and submits the accept and waits for a validated ledger.
 *   4. poap.live is told the hash, reads the transaction back off the ledger
 *      itself, and records the attendance.
 *
 * Safe to run again at any point. An offer already gone is looked for in the
 * wallet's own history before anything is signed, so a phone closed between
 * signing and step 4 finishes the job instead of signing twice.
 */
import { api, type OfferForMe } from "./api";
import { ApiError } from "./http";
import type { Signer } from "./keys";
import { acceptOffer, findAccept, isFreeOfferTo, offer as ledgerOffer } from "./ledger";

export class CollectError extends Error {
  constructor(
    message: string,
    /** refused: will never be signed. gone: nothing to take right now. */
    readonly kind: "refused" | "gone",
  ) {
    super(message);
    this.name = "CollectError";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function collect(signer: Signer, eventId: number, offered: OfferForMe): Promise<{ txHash: string }> {
  const { address } = signer;
  const a = offered.accept;
  if (
    offered.address !== address ||
    a.TransactionType !== "NFTokenAcceptOffer" ||
    a.Account !== address ||
    a.NFTokenSellOffer.toUpperCase() !== offered.offerId.toUpperCase()
  ) {
    throw new CollectError("That offer is not for this wallet. Nothing was signed.", "refused");
  }

  let txHash: string;
  const onLedger = await ledgerOffer(offered.offerId);
  if (onLedger) {
    if (!isFreeOfferTo(onLedger, address)) {
      throw new CollectError("That offer is not a free badge for this wallet. Nothing was signed.", "refused");
    }
    txHash = (await acceptOffer(signer, a)).hash;
  } else {
    // Gone. Taken by this wallet already, or cancelled — the history says which.
    const mine = await findAccept(address, { offerId: offered.offerId });
    if (!mine) throw new CollectError("That offer is no longer open.", "gone");
    txHash = mine.hash;
  }

  await report(eventId, offered.offerId, address, txHash);
  return { txHash };
}

/**
 * Tell poap.live about an accept, asking again while its node catches up. A
 * ledger closes every few seconds, so a confirm sent the moment the accept
 * validates can arrive before the node poap.live reads from has it.
 */
export async function report(eventId: number, offerId: string, address: string, txHash: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await api.confirm(eventId, offerId, address, txHash);
      return;
    } catch (err) {
      const notYet = err instanceof ApiError && err.status === 422 && err.details?.notYet === true;
      if (!notYet || attempt >= 5) throw err;
      await sleep(2_000 + attempt * 1_500);
    }
  }
}
