/**
 * Registering for an event: the person's name (and, if they like, email) on
 * the event's list, so the desk knows who they are when they walk in.
 *
 * The wallet proves itself the way Xaman would, without Xaman: poap.live hands
 * out a challenge, the phone signs it together with the name and email, and
 * poap.live checks the signature against the wallet's address before it
 * writes anything. The key stays on the phone.
 *
 * The app registers before it shows a pass, for every event on either chain:
 * the pass screen sends anyone not yet registered here first. So the organiser
 * has the same details for every attendee who uses the app — a name, and an
 * email if they gave one — and the desk checks them in when the badge is
 * issued. (The desk itself still issues to any address it scans, a pass from
 * the website say; that rule is poap.live's, not the app's.)
 *
 * The phone remembers which events each wallet registered for, and the name it
 * used, so screens can say so without asking. Forgetting is harmless:
 * registering again answers with the registration poap.live already has.
 */
import * as SecureStore from "expo-secure-store";
import { api, type Registration } from "./api";
import type { Signer } from "./keys";
import { scoped, type Server } from "./server";

/**
 * Where one wallet's registrations are kept. Each wallet on the phone has its
 * own, and so does each server: testnet's registrations are not mainnet's.
 */
export const registrationsKey = (address: string, on?: Server) => scoped(`poap.registrations.${address}`, on);
const PROFILE_KEY = "poap.profile";
const STORE: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

export interface Profile {
  displayName: string;
  email: string | null;
}

/** eventId → the registration this phone holds for it. */
export type Registrations = Record<string, { id: string; displayName: string | null }>;

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await SecureStore.getItemAsync(key, STORE);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function loadRegistrations(address: string): Promise<Registrations> {
  return readJson<Registrations>(registrationsKey(address), {});
}

/** The name and email the register form starts with. The same on every server. */
export function loadProfile(): Promise<Profile | null> {
  return readJson<Profile | null>(PROFILE_KEY, null);
}

export async function saveProfile(profile: Profile): Promise<void> {
  const displayName = profile.displayName.trim();
  const email = profile.email?.trim() || null;
  if (!displayName && !email) await SecureStore.deleteItemAsync(PROFILE_KEY, STORE);
  else await SecureStore.setItemAsync(PROFILE_KEY, JSON.stringify({ displayName, email }), STORE);
}

/**
 * Where "Register" goes for an event. While it is on, straight on to the pass
 * once registered; before that, back to wherever they came from.
 */
export function registerRoute(event: { eventId: number; status: string }): string {
  return event.status === "live" ? `/register/${event.eventId}?next=pass` : `/register/${event.eventId}`;
}

/** A plausible email, so a typo is caught here rather than as a 400. */
export function looksLikeEmail(text: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
}

/**
 * A NEAR event registers the wallet's NEAR account — the same key, named the
 * NEAR way — and poap.live checks the signature against that account
 * (`near_signature`). Everything else is the same.
 */
export async function registerFor(
  signer: Signer,
  eventId: number,
  profile: Profile,
  chain: "xrpl" | "near" = "xrpl",
): Promise<{ registration: Registration; already: boolean }> {
  const displayName = profile.displayName.trim();
  const email = profile.email?.trim() || null;
  const address = chain === "near" ? signer.nearAccount : signer.address;
  if (!address) throw new Error("This wallet's key cannot be a NEAR account. Make a new wallet in the app for NEAR events.");

  const { challenge } = await api.registrationChallenge(eventId, address);
  const { publicKey, signature } = signer.signRegistration({ eventId, displayName, email, challenge }, { chain });
  const result = await api.registerWallet(eventId, {
    address,
    publicKey,
    signature,
    challenge,
    displayName,
    ...(email ? { email } : {}),
  });

  const all = await loadRegistrations(signer.address);
  all[String(eventId)] = { id: result.registration.id, displayName: result.registration.displayName };
  await SecureStore.setItemAsync(registrationsKey(signer.address), JSON.stringify(all), STORE);
  await SecureStore.setItemAsync(PROFILE_KEY, JSON.stringify({ displayName, email }), STORE);
  return result;
}
