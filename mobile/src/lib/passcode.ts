/**
 * The app's own passcode: six digits, asked for every time POAP opens and
 * before a wallet key is shown. Biometrics can stand in for it; nothing can
 * stand in for having one.
 *
 * Never stored as digits. What is kept, in the keychain on this device only,
 * is a salted PBKDF2-SHA256 hash, and the count of wrong guesses: after five,
 * each further miss waits twice as long as the last, up to a quarter of an hour.
 * That wait is the protection that matters. The hash sits in the same keychain
 * as the wallet keys, so whoever could read it already has the keys; making it
 * slow would only make every unlock slow (20,000 rounds measured 4.2 s in a
 * debug build), so it is kept light.
 */
import { pbkdf2Async } from "@noble/hashes/pbkdf2.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

export const PASSCODE_LENGTH = 6;

const KEY = "poap.passcode";
const FAILURES_KEY = "poap.passcode.failures";
const STORE: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

/** PBKDF2 rounds. Kept with each hash; one saved under another count is re-saved on the next match. */
const ITERATIONS = 2_000;
const FREE_TRIES = 5;
const FIRST_WAIT_S = 30;
const LONGEST_WAIT_S = 15 * 60;

interface Stored {
  v: 1;
  salt: string;
  hash: string;
  iterations: number;
}

interface Failures {
  count: number;
  /** Epoch ms before which no guess is checked. */
  until: number;
}

export type Check = { ok: true } | { ok: false; waitSeconds: number; triesLeft: number };

async function derive(pin: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await pbkdf2Async(sha256, utf8ToBytes(pin), salt, { c: iterations, dkLen: 32 });
  return bytesToHex(key);
}

async function readJson<T>(key: string): Promise<T | null> {
  try {
    const raw = await SecureStore.getItemAsync(key, STORE);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/** Compares without stopping at the first difference. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const isPasscode = (pin: string) => new RegExp(`^\\d{${PASSCODE_LENGTH}}$`).test(pin);

export async function hasPasscode(): Promise<boolean> {
  return (await readJson<Stored>(KEY)) !== null;
}

export async function setPasscode(pin: string): Promise<void> {
  if (!isPasscode(pin)) throw new Error(`A passcode is ${PASSCODE_LENGTH} digits.`);
  const salt = Crypto.getRandomBytes(16);
  const stored: Stored = { v: 1, salt: bytesToHex(salt), hash: await derive(pin, salt, ITERATIONS), iterations: ITERATIONS };
  await SecureStore.setItemAsync(KEY, JSON.stringify(stored), STORE);
  await SecureStore.deleteItemAsync(FAILURES_KEY, STORE);
}

/** Seconds until the next guess will be checked; 0 when one can be made now. */
export async function waitSeconds(): Promise<number> {
  const f = await readJson<Failures>(FAILURES_KEY);
  return f ? Math.max(0, Math.ceil((f.until - Date.now()) / 1000)) : 0;
}

export async function checkPasscode(pin: string): Promise<Check> {
  const stored = await readJson<Stored>(KEY);
  const failures = (await readJson<Failures>(FAILURES_KEY)) ?? { count: 0, until: 0 };
  const now = Date.now();
  if (failures.until > now) {
    return { ok: false, waitSeconds: Math.ceil((failures.until - now) / 1000), triesLeft: 0 };
  }
  if (stored && isPasscode(pin) && same(await derive(pin, hexToBytes(stored.salt), stored.iterations), stored.hash)) {
    if (stored.iterations !== ITERATIONS) await setPasscode(pin);
    else if (failures.count) await SecureStore.deleteItemAsync(FAILURES_KEY, STORE);
    return { ok: true };
  }
  const count = failures.count + 1;
  const over = count - FREE_TRIES;
  const wait = over >= 0 ? Math.min(LONGEST_WAIT_S, FIRST_WAIT_S * 2 ** over) : 0;
  await SecureStore.setItemAsync(FAILURES_KEY, JSON.stringify({ count, until: now + wait * 1000 }), STORE);
  return { ok: false, waitSeconds: wait, triesLeft: Math.max(0, FREE_TRIES - count) };
}

/** Only for starting over after a forgotten passcode, once the wallets are gone. */
export async function clearPasscode(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY, STORE);
  await SecureStore.deleteItemAsync(FAILURES_KEY, STORE);
}
