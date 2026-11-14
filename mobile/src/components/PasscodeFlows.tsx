/**
 * The passcode's three small journeys, shared by onboarding, the lock screen,
 * Settings and the backup screen:
 *
 *   ChoosePasscode   six digits, then the same six again
 *   OfferBiometrics  "Unlock with Face ID?" once a passcode exists
 *   OwnerCheck       biometrics if they are on, else the passcode — before a
 *                    wallet key is shown
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { biometricMethod, confirmBiometric } from "@/lib/auth";
import { checkPasscode, type Check } from "@/lib/passcode";
import { useSettings } from "@/lib/settings";
import { PasscodePad } from "./PasscodePad";
import { T } from "./T";
import { Button } from "./ui";

/** A code anyone would try first. */
function obvious(pin: string): boolean {
  if (/^(\d)\1+$/.test(pin)) return true;
  const up = "01234567890123456789";
  const down = "98765432109876543210";
  return up.includes(pin) || down.includes(pin);
}

/** "Wrong passcode. 2 tries left." / "Too many tries. Wait 1 minute." */
export function checkMessage(check: Extract<Check, { ok: false }>): string {
  if (check.waitSeconds > 0) {
    const s = check.waitSeconds;
    const wait = s >= 90 ? `${Math.ceil(s / 60)} minutes` : s >= 60 ? "1 minute" : `${s} seconds`;
    return `Too many wrong tries. Wait ${wait}, then try again.`;
  }
  return check.triesLeft === 1 ? "Wrong passcode. 1 try before a wait." : `Wrong passcode. ${check.triesLeft} tries before a wait.`;
}

export function ChoosePasscode({
  title = "Choose a passcode",
  subtitle = "Six digits. POAP asks for it every time it opens.",
  notThis,
  onChosen,
}: {
  title?: string;
  subtitle?: string;
  /** The code being replaced, which the new one may not repeat. */
  notThis?: string;
  onChosen: (pin: string) => Promise<void>;
}) {
  const [first, setFirst] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reset, setReset] = useState(0);

  async function complete(pin: string) {
    setReset((r) => r + 1);
    if (!first) {
      if (obvious(pin)) {
        setError("That one is too easy to guess. Try another.");
        return;
      }
      if (notThis && pin === notThis) {
        setError("That is the passcode you have now. Choose a different one.");
        return;
      }
      setFirst(pin);
      setError(null);
      return;
    }
    if (pin !== first) {
      setFirst(null);
      setError("Those did not match. Choose one again.");
      return;
    }
    setBusy(true);
    try {
      await onChosen(pin);
    } catch {
      setFirst(null);
      setError("The passcode could not be saved. Unlock the phone and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <PasscodePad
      title={first ? "Enter it again" : title}
      subtitle={first ? "The same six digits, to be sure." : subtitle}
      error={error}
      busy={busy}
      resetKey={reset}
      onComplete={(pin) => void complete(pin)}
    />
  );
}

/** Offers biometrics once; calls onDone straight away on a phone without any. */
export function OfferBiometrics({ onDone }: { onDone: () => void }) {
  const settings = useSettings();
  const [method, setMethod] = useState<string | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void biometricMethod().then((m) => {
      if (!live) return;
      if (!m) onDone();
      else setMethod(m);
    });
    return () => {
      live = false;
    };
  }, [onDone]);

  if (!method) return null;
  return (
    <View style={{ gap: 18, alignSelf: "stretch" }}>
      <View style={{ gap: 8 }}>
        <T variant="title" style={{ textAlign: "center" }}>
          Unlock with {method}?
        </T>
        <T variant="body" tone="ink2" style={{ textAlign: "center" }}>
          {method} can open POAP instead of the passcode. The passcode still works whenever {method} does not.
        </T>
      </View>
      {failed ? (
        <T variant="small" tone="signal" style={{ textAlign: "center" }}>
          {method} did not go through. Try again, or leave it for now.
        </T>
      ) : null}
      <Button
        label={`Use ${method}`}
        onPress={async () => {
          if (await confirmBiometric(`Turn on ${method}`)) {
            await settings.update({ biometrics: true });
            onDone();
          } else {
            setFailed(true);
          }
        }}
      />
      <Button
        label="Not now"
        kind="quiet"
        onPress={async () => {
          await settings.update({ biometrics: false });
          onDone();
        }}
      />
    </View>
  );
}

/**
 * Proof that the person holding the phone is its owner: biometrics when they
 * are turned on, the passcode otherwise — or after biometrics fail.
 */
export function OwnerCheck({ reason, onConfirmed }: { reason: string; onConfirmed: () => void }) {
  const { biometrics } = useSettings();
  const [method, setMethod] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reset, setReset] = useState(0);
  const asked = useRef(false);

  const tryBiometric = useCallback(async () => {
    if (await confirmBiometric(reason)) onConfirmed();
  }, [reason, onConfirmed]);

  useEffect(() => {
    if (!biometrics) return;
    let live = true;
    void biometricMethod().then((m) => {
      if (!live || !m) return;
      setMethod(m);
      if (!asked.current) {
        asked.current = true;
        void tryBiometric();
      }
    });
    return () => {
      live = false;
    };
  }, [biometrics, tryBiometric]);

  async function complete(pin: string) {
    setBusy(true);
    const result = await checkPasscode(pin);
    setBusy(false);
    if (result.ok) {
      onConfirmed();
      return;
    }
    setError(checkMessage(result));
    setReset((r) => r + 1);
  }

  return (
    <PasscodePad
      title="Enter your passcode"
      subtitle={reason}
      error={error}
      busy={busy}
      resetKey={reset}
      onComplete={(pin) => void complete(pin)}
      {...(biometrics && method ? { extra: { label: method, onPress: () => void tryBiometric() } } : {})}
    />
  );
}
