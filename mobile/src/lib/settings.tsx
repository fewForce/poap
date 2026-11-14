/**
 * The app's own settings: how it looks, whether biometrics can unlock it, and
 * which poap.live it talks to. Kept on the phone; none of it is sent anywhere.
 *
 * Read before the first screen renders (the splash waits for it), so the theme
 * and the server are right from the first frame and the first request.
 */
import * as SecureStore from "expo-secure-store";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Appearance } from "react-native";
import { setServer, type Server } from "./server";

const KEY = "poap.settings";
const STORE: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

export type ThemeChoice = "system" | "light" | "dark";

export interface Settings {
  theme: ThemeChoice;
  /** Let biometrics stand in for the passcode. The passcode itself is always on. */
  biometrics: boolean;
  server: Server;
  /** The network options, shown after tapping the version five times. */
  networkOptions: boolean;
}

const DEFAULTS: Settings = { theme: "system", biometrics: false, server: "mainnet", networkOptions: false };

interface SettingsValue extends Settings {
  ready: boolean;
  update(patch: Partial<Settings>): Promise<void>;
}

const SettingsContext = createContext<SettingsValue | null>(null);

async function read(): Promise<Settings> {
  try {
    const raw = await SecureStore.getItemAsync(KEY, STORE);
    const saved = raw ? (JSON.parse(raw) as Partial<Settings>) : {};
    return {
      theme: saved.theme === "light" || saved.theme === "dark" ? saved.theme : "system",
      biometrics: saved.biometrics === true,
      server: saved.server === "testnet" ? "testnet" : "mainnet",
      networkOptions: saved.networkOptions === true,
    };
  } catch {
    return DEFAULTS;
  }
}

/** What the rest of the app follows: the colour scheme, and the server requests go to. */
function apply(s: Settings): void {
  Appearance.setColorScheme(s.theme === "system" ? "unspecified" : s.theme);
  setServer(s.server);
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const latest = useRef<Settings>(DEFAULTS);

  useEffect(() => {
    let live = true;
    void read().then((s) => {
      if (!live) return;
      apply(s);
      latest.current = s;
      setSettings(s);
    });
    return () => {
      live = false;
    };
  }, []);

  const update = useCallback(async (patch: Partial<Settings>) => {
    const next = { ...latest.current, ...patch };
    latest.current = next;
    apply(next);
    setSettings(next);
    await SecureStore.setItemAsync(KEY, JSON.stringify(next), STORE);
  }, []);

  const value = useMemo<SettingsValue>(
    () => ({ ...(settings ?? DEFAULTS), ready: settings !== null, update }),
    [settings, update],
  );

  // Nothing renders until the settings are in: the splash screen covers it.
  return <SettingsContext.Provider value={value}>{settings ? children : null}</SettingsContext.Provider>;
}

export function useSettings(): SettingsValue {
  const value = useContext(SettingsContext);
  if (!value) throw new Error("useSettings outside <SettingsProvider>");
  return value;
}
