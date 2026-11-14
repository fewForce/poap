/**
 * Onboarding's first step, before any wallet exists: the passcode POAP will
 * ask for every time it opens, then biometrics if the phone has them. Then on
 * to making a wallet, or bringing one in (`?next=create|import`).
 */
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import { ChoosePasscode, OfferBiometrics } from "@/components/PasscodeFlows";
import { Screen } from "@/components/ui";
import { useLock } from "@/lib/lock";

export default function OnboardingPasscode() {
  const { next } = useLocalSearchParams<{ next?: string }>();
  const lock = useLock();
  const [chosen, setChosen] = useState(false);

  const onward = useCallback(() => {
    router.replace(next === "import" ? "/welcome/import" : "/welcome/create");
  }, [next]);

  return (
    <Screen edges={[]} contentStyle={{ paddingTop: 28, alignItems: "center" }}>
      {/* Once it is set there is no going back to set it again. */}
      <Stack.Screen options={{ headerBackVisible: !chosen, gestureEnabled: !chosen }} />
      {chosen ? (
        <OfferBiometrics onDone={onward} />
      ) : (
        <ChoosePasscode
          subtitle="Six digits. POAP asks for it every time it opens, because it holds your wallet."
          onChosen={async (pin) => {
            await lock.choose(pin);
            setChosen(true);
          }}
        />
      )}
    </Screen>
  );
}
