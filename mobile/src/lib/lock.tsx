/**
 * Whether the app is open to whoever holds the phone right now.
 *
 *   none      no passcode yet: a fresh install, before onboarding sets one
 *   locked    a passcode exists and nobody has given it (or biometrics) since
 *             the app opened or last went to the background
 *   unlocked  they have
 *
 * There is no setting that turns this off. The app holds wallet keys.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { checkPasscode, clearPasscode, hasPasscode, setPasscode, type Check } from "./passcode";

export type LockStatus = "loading" | "none" | "locked" | "unlocked";

interface LockValue {
  status: LockStatus;
  /** Sets (or replaces) the passcode, and counts as unlocking. */
  choose(pin: string): Promise<void>;
  /** Checks a passcode; unlocks on a match. */
  tryPasscode(pin: string): Promise<Check>;
  /** After biometrics matched. */
  unlock(): void;
  /** After a forgotten passcode, once the wallets have been removed. */
  forget(): Promise<void>;
}

const LockContext = createContext<LockValue | null>(null);

export function LockProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<LockStatus>("loading");

  useEffect(() => {
    let live = true;
    void hasPasscode().then((has) => live && setStatus(has ? "locked" : "none"));
    return () => {
      live = false;
    };
  }, []);

  // Locks the moment the app leaves the screen. The biometric prompt only
  // makes it "inactive", so asking for Face ID does not lock it again.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "background") setStatus((s) => (s === "unlocked" ? "locked" : s));
    });
    return () => sub.remove();
  }, []);

  const choose = useCallback(async (pin: string) => {
    await setPasscode(pin);
    setStatus("unlocked");
  }, []);

  const tryPasscode = useCallback(async (pin: string) => {
    const result = await checkPasscode(pin);
    if (result.ok) setStatus("unlocked");
    return result;
  }, []);

  const unlock = useCallback(() => setStatus((s) => (s === "locked" ? "unlocked" : s)), []);

  const forget = useCallback(async () => {
    await clearPasscode();
    setStatus("none");
  }, []);

  const value = useMemo<LockValue>(
    () => ({ status, choose, tryPasscode, unlock, forget }),
    [status, choose, tryPasscode, unlock, forget],
  );
  return <LockContext.Provider value={value}>{children}</LockContext.Provider>;
}

export function useLock(): LockValue {
  const value = useContext(LockContext);
  if (!value) throw new Error("useLock outside <LockProvider>");
  return value;
}
