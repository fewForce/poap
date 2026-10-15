/**
 * Registering for an event: the person's name (and, if they like, email) on
 * the event's list, so the desk knows who they are when they walk in.
 *
 * The wallet proves itself the way Xaman would, without Xaman: poap.live hands
 * out a challenge, the phone signs it together with the name and email, and
 * poap.live checks the signature against the wallet's address before it
 * writes anything. The key stays on the phone.
 *
 * Registering is optional. Without it the desk still issues the badge — it just
 * has no name to greet anyone by.
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

/** A plausible email, so a typo is caught here rather than as a 400. */
export function looksLikeEmail(text: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
}

export async function registerFor(signer: Signer, eventId: number, profile: Profile): Promise<{ registration: Registration; already: boolean }> {
  const displayName = profile.displayName.trim();
  const email = profile.email?.trim() || null;

  const { challenge } = await api.registrationChallenge(eventId, signer.address);
  const { publicKey, signature } = signer.signRegistration({ eventId, displayName, email, challenge });
  const result = await api.registerWallet(eventId, {
    address: signer.address,
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
