/**
 * Everything the app asks poap.live, typed. Public routes only — the ones the
 * website's own pages use, plus the two that let a wallet register by signing:
 *
 *   GET  /health                                  which ledger poap.live is on
 *   GET  /api/events/summary                      the event list
 *   GET  /api/events/:eventId/summary             one event and its numbers
 *   POST /api/events/:eventId/registrations/challenge   what to sign to register
 *   POST /api/events/:eventId/registrations/wallet      register, with the signature
 *   GET  /api/registrations/:id                   a registration, checked in or not
 *   GET  /events/:eventId/claims/for/:address     has the desk issued me a badge?
 *   POST /events/:eventId/claims/:offerId/confirm I accepted it: here is the hash
 *   GET  /badge/:eventId/:address.png             the badge's art
 *   GET  /events/:eventId/attendance/:address     is my badge recorded? (NEAR events)
 *
 * NEAR events (a server with NEAR set up says so in /health) mint straight to
 * the wallet's NEAR account, so there is nothing to accept: the app shows the
 * NEAR account on its pass and watches the attendance record. A server
 * without NEAR has no NEAR events, and none of that ever runs.
 *
 * Registering needs poap.live's wallet-signature routes (the
 * feature/wallet-registration branch); everything else is on poap.live today.
 *
 * Nothing here can mint or spend. Issuing stays at the desk, behind its login;
 * the app only ever reads an offer made for its own wallet and reports the
 * accept it signed itself — which poap.live then checks against the ledger
 * before it records anything.
 */
import { ApiError, request } from "./http";

export type EventStatus = "draft" | "open" | "live" | "closed";
export type Network = "mainnet" | "testnet" | "devnet";
export type Chain = "xrpl" | "near";

export interface Health {
  status: string;
  network: Network;
  issuer: string;
  /** Absent on a server that predates NEAR: XRPL only. */
  chains?: Chain[];
  /** Where NEAR badges live, when this server issues them. */
  near?: { network: "testnet" | "mainnet"; contractId: string; rpcUrl: string };
}

export interface EventSummary {
  eventId: number;
  name: string;
  description: string | null;
  eventDate: string | null;
  venue: string | null;
  status: EventStatus;
  /** Absent on a server that predates NEAR, which means XRPL. */
  chain?: Chain;
  stats?: { registered?: number; attended?: number };
}

export const isNearEvent = (e: Pick<EventSummary, "chain"> | null | undefined): boolean => e?.chain === "near";

/** What the desk left for this wallet: an offer only it can accept. */
export interface OfferForMe {
  eventId: number;
  address: string;
  offerId: string;
  nftokenId?: string;
  /** The accept transaction, unsigned, as poap.live would have Xaman sign it. */
  accept: { TransactionType: string; Account: string; NFTokenSellOffer: string; SourceTag?: number };
}

/** A registration as poap.live shows it to the person it belongs to. */
export interface Registration {
  id: string;
  address: string;
  displayName: string | null;
  registeredAt: string | null;
  checkedInAt: string | null;
}

export const api = {
  health: () => request<Health>("GET", "/health"),

  events: () => request<{ events: EventSummary[] }>("GET", "/api/events/summary?limit=50").then((r) => r.events),
  event: (eventId: number) => request<EventSummary>("GET", `/api/events/${eventId}/summary`),

  /** The offer the desk made for this wallet, or null while nothing is issued. */
  async offerFor(eventId: number, address: string): Promise<OfferForMe | null> {
    try {
      return await request<OfferForMe>("GET", `/events/${eventId}/claims/for/${address}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  },

  /**
   * Report an accept. 200 means recorded (or recorded already). A 422 with
   * `notYet` means poap.live's node has not caught up — ask again shortly.
   */
  confirm: (eventId: number, offerId: string, address: string, txHash: string) =>
    request<{ attended: boolean; alreadyRecorded: boolean }>("POST", `/events/${eventId}/claims/${offerId}/confirm`, {
      body: { address, txHash },
    }),

  badgeArt: (eventId: number, address: string) => `/badge/${eventId}/${address}.png`,

  /** The attendance poap.live has recorded for this address, or null. Index only, no chain read. */
  async attendance(eventId: number, address: string): Promise<{ txHash: string; claimedAt: string | null } | null> {
    try {
      const r = await request<{ record: { txHash: string; claimedAt?: string | null } }>(
        "GET",
        `/events/${eventId}/attendance/${encodeURIComponent(address)}`,
      );
      return { txHash: r.record.txHash, claimedAt: r.record.claimedAt ?? null };
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  },

  registrationChallenge: (eventId: number, address: string) =>
    request<{ challenge: string; expiresAt: string }>("POST", `/api/events/${eventId}/registrations/challenge`, {
      body: { address },
    }),

  /** Register with a signature. Already registered is an answer, not an error. */
  async registerWallet(
    eventId: number,
    body: { address: string; publicKey: string; signature: string; challenge: string; displayName: string; email: string },
  ): Promise<{ registration: Registration; already: boolean }> {
    try {
      const r = await request<{ registration: Registration }>("POST", `/api/events/${eventId}/registrations/wallet`, { body });
      return { registration: r.registration, already: false };
    } catch (err) {
      const existing = err instanceof ApiError && err.status === 409 ? (err.body as { registration?: Registration })?.registration : undefined;
      if (existing) return { registration: existing, already: true };
      throw err;
    }
  },

  registration: (id: string) =>
    request<{ registration: Registration }>("GET", `/api/registrations/${encodeURIComponent(id)}`).then((r) => r.registration),
};
