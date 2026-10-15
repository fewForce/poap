/**
 * A wallet's key, for the person to write down. Shown only after they ask,
 * and never copied anywhere by the app. Which wallet: `?id=`, or the one in use.
 */
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import { View } from "react-native";
import { T } from "@/components/T";
import { Button, Card, Notice, Screen } from "@/components/ui";
import { OwnerCheck } from "@/components/PasscodeFlows";
import { revealSeed, useWalletState } from "@/lib/wallet";

export default function Backup() {
  const params = useLocalSearchParams<{ id?: string }>();
  const { active } = useWalletState();
  const [checking, setChecking] = useState(false);
  const id = params.id ?? active?.id;
  const [seed, setSeed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reveal = useCallback(async () => {
    setChecking(false);
    try {
      setSeed(id ? await revealSeed(id) : null);
    } catch {
      setError("The key could not be read. Unlock the phone and try again.");
    }
  }, [id]);
  const confirmed = useCallback(() => void reveal(), [reveal]);

  // The key is behind the passcode (or biometrics), every time.
  if (checking && !seed) {
    return (
      <Screen edges={[]} contentStyle={{ paddingTop: 28, alignItems: "center" }}>
        <OwnerCheck reason="To show your wallet key" onConfirmed={confirmed} />
      </Screen>
    );
  }

  return (
    <Screen edges={[]} contentStyle={{ paddingTop: 20, gap: 18 }}>
      <T variant="title">Back up your wallet</T>
      <T variant="body" tone="ink2">
        Your wallet has one key. With it, this wallet and its badges can be restored on any phone. Without it, nobody —
        not poap.live, not us — can bring them back if this phone is lost.
      </T>
      <View style={{ gap: 6 }}>
        <T variant="body">· Write it on paper and keep it somewhere safe.</T>
        <T variant="body">· Never share it, or type it into a website.</T>
      </View>

      {seed ? (
        <>
          <Card style={{ alignItems: "center", paddingVertical: 22 }}>
            <T variant="mono" selectable style={{ fontSize: 17, lineHeight: 24, textAlign: "center" }}>
              {seed}
            </T>
          </Card>
          <Notice tone="bad">Anyone who sees this key can use your wallet.</Notice>
          <Button label="I have written it down" onPress={() => router.back()} />
        </>
      ) : (
        <>
          {error ? <Notice tone="bad">{error}</Notice> : null}
          <Button label="Show my key" onPress={() => setChecking(true)} />
        </>
      )}
    </Screen>
  );
}
