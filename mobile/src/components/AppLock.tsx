/**
 * The gate in front of the app. Once a passcode exists, POAP opens behind a
 * lock screen every time — at launch and whenever it comes back from the
 * background — and lifts only for the passcode, or for biometrics if they
 * are turned on. A phone that already holds a wallet but has no passcode yet
 * (an older version of the app) is asked to set one before anything else.
 *
 * The screens stay mounted underneath; nothing reloads when the lock lifts.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, AppState, Pressable, StyleSheet, View } from "react-native";
import { biometricMethod, confirmBiometric } from "@/lib/auth";
import { useLock } from "@/lib/lock";
import { waitSeconds } from "@/lib/passcode";
import { useSettings } from "@/lib/settings";
import { useTheme } from "@/lib/theme";
import { useWalletState } from "@/lib/wallet";
import { ChoosePasscode, checkMessage, OfferBiometrics } from "./PasscodeFlows";
import { PasscodePad } from "./PasscodePad";
import { PoweredBy } from "./PoweredBy";
import { T } from "./T";
import { SafeArea } from "./ui";

export function AppLock({ children }: { children: ReactNode }) {
  const lock = useLock();
  const { wallets } = useWalletState();
  // After the first passcode is chosen, the biometrics offer still has to show.
  const [offering, setOffering] = useState(false);
  const doneOffering = useCallback(() => setOffering(false), []);

  return (
    <View style={{ flex: 1 }}>
      {children}
      {lock.status === "locked" ? (
        <Cover>
          <LockScreen />
        </Cover>
      ) : lock.status === "none" && wallets.length > 0 ? (
        <Cover>
          <ChoosePasscode
            title="Set a passcode"
            subtitle="POAP holds your wallet, so from now on it asks for this every time it opens."
            onChosen={async (pin) => {
              setOffering(true);
              await lock.choose(pin);
            }}
          />
        </Cover>
      ) : offering ? (
        <Cover>
          <OfferBiometrics onDone={doneOffering} />
        </Cover>
      ) : null}
    </View>
  );
}

function Cover({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return (
    <SafeArea style={[StyleSheet.absoluteFill, { backgroundColor: theme.paper }]}>
      <View style={styles.body}>{children}</View>
    </SafeArea>
  );
}

function LockScreen() {
  const lock = useLock();
  const wallet = useWalletState();
  const settings = useSettings();
  const { biometrics } = settings;
  const [method, setMethod] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(0);
  const [reset, setReset] = useState(0);
  const asking = useRef(false);
  const asked = useRef(false);

  const tryBiometric = useCallback(async () => {
    // One prompt at a time, and only in front: the phone refuses one asked
    // for from the background.
    if (asking.current || AppState.currentState !== "active") return;
    asking.current = true;
    asked.current = true;
    const ok = await confirmBiometric("Unlock POAP");
    asking.current = false;
    if (ok) lock.unlock();
  }, [lock]);

  // Biometrics, if they are on: asked for once, as soon as the app is in front.
  // Cancelling leaves the passcode pad; it does not ask again by itself.
  useEffect(() => {
    if (!biometrics) return;
    let live = true;
    void biometricMethod().then((m) => {
      if (!live || !m) return;
      setMethod(m);
      if (!asked.current) void tryBiometric();
    });
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active" && !asked.current) void tryBiometric();
    });
    return () => {
      live = false;
      sub.remove();
    };
  }, [biometrics, tryBiometric]);

  // A wait left over from wrong guesses, counted down to the second.
  useEffect(() => {
    let live = true;
    void waitSeconds().then((s) => live && setWait(s));
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((s) => Math.max(0, s - 1)), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  async function complete(pin: string) {
    setBusy(true);
    const result = await lock.tryPasscode(pin);
    setBusy(false);
    if (result.ok) return;
    setError(checkMessage(result));
    setWait(result.waitSeconds);
    setReset((r) => r + 1);
  }

  function forgot() {
    Alert.alert(
      "Forgot your passcode?",
      "It cannot be recovered. The only way back in is to remove every wallet from this phone and start again. Each wallet comes back with its key, if you wrote it down.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove wallets",
          style: "destructive",
          onPress: async () => {
            await wallet.removeAll();
            await settings.update({ biometrics: false });
            await lock.forget();
          },
        },
      ],
    );
  }

  return (
    <View style={{ gap: 26, alignItems: "center" }}>
      <PoweredBy />
      <PasscodePad
        title="POAP is locked"
        subtitle="Enter your passcode"
        error={wait > 0 ? `Too many wrong tries. Wait ${wait} seconds.` : error}
        busy={busy || wait > 0}
        resetKey={reset}
        onComplete={(pin) => void complete(pin)}
        {...(biometrics && method ? { extra: { label: method, onPress: () => void tryBiometric() } } : {})}
        footer={
          <Pressable onPress={forgot} hitSlop={10}>
            <T variant="meta" weight="semibold" tone="ink3">
              Forgot passcode?
            </T>
          </Pressable>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, justifyContent: "center", alignItems: "center", paddingHorizontal: 22 },
});
