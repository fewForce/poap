/**
 * Changing the passcode, from Settings: the current one first, then the new
 * one twice. Biometrics do not stand in for the current one here.
 */
import { router } from "expo-router";
import { useState } from "react";
import { checkMessage, ChoosePasscode } from "@/components/PasscodeFlows";
import { PasscodePad } from "@/components/PasscodePad";
import { useToast } from "@/components/Toast";
import { Screen } from "@/components/ui";
import { useLock } from "@/lib/lock";
import { checkPasscode } from "@/lib/passcode";

export default function ChangePasscode() {
  const lock = useLock();
  const toast = useToast();
  /** The current code, once given: the new one must differ from it. */
  const [proved, setProved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reset, setReset] = useState(0);

  async function current(pin: string) {
    setBusy(true);
    const result = await checkPasscode(pin);
    setBusy(false);
    if (result.ok) {
      setProved(pin);
      return;
    }
    setError(checkMessage(result));
    setReset((r) => r + 1);
  }

  return (
    <Screen edges={[]} contentStyle={{ paddingTop: 28, alignItems: "center" }}>
      {proved ? (
        <ChoosePasscode
          title="Choose a new passcode"
          subtitle="Six digits, different from the one before."
          notThis={proved}
          onChosen={async (pin) => {
            await lock.choose(pin);
            router.back();
            toast.show("Passcode changed");
          }}
        />
      ) : (
        <PasscodePad
          title="Enter your current passcode"
          error={error}
          busy={busy}
          resetKey={reset}
          onComplete={(pin) => void current(pin)}
        />
      )}
    </Screen>
  );
}
