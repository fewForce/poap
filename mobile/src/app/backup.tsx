/**
 * A wallet's key, for the person to write down. Shown only after they ask,
 * and never copied anywhere by the app. Which wallet: `?id=`, or the one in use.
 *
 * Twice, in two spellings of the one key: the seed this app and XRPL wallets
 * take, and the NEAR account with its `ed25519:` private key, which is what
 * NEAR wallets such as Meteor ask for.
 */
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { View } from "react-native";
import { T } from "@/components/T";
import { Button, Card, Notice, Screen } from "@/components/ui";
import { OwnerCheck } from "@/components/PasscodeFlows";
import { nearPrivateKeyOf, signerFromSeed } from "@/lib/keys";
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
  /** The same key for NEAR wallets; null for a wallet whose key cannot be a NEAR account. */
  const near = useMemo(() => {
    if (!seed) return null;
    const privateKey = nearPrivateKeyOf(seed);
    const account = signerFromSeed(seed).nearAccount;
    return privateKey && account ? { account, privateKey } : null;
  }, [seed]);

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
          <Card style={{ alignItems: "center", paddingVertical: 22, gap: 8 }}>
            <T variant="mono" selectable style={{ fontSize: 17, lineHeight: 24, textAlign: "center" }}>
              {seed}
            </T>
            <T variant="small" tone="ink3" style={{ textAlign: "center" }}>
              For this app, and XRP Ledger wallets like Xaman.
            </T>
          </Card>
          {near ? (
            <View style={{ gap: 10 }}>
              <T variant="heading">For a NEAR wallet</T>
              <T variant="body" tone="ink2">
                NEAR wallets like Meteor ask for an account ID and a private key. They are this same key, written the NEAR
                way: import with the private key, or import manually with both.
              </T>
              <Card style={{ gap: 14 }}>
                <View style={{ gap: 4 }}>
                  <T variant="small" tone="ink3">
                    Account ID
                  </T>
                  <T variant="mono" selectable style={{ fontSize: 14, lineHeight: 20 }}>
                    {near.account}
                  </T>
                </View>
                <View style={{ gap: 4 }}>
                  <T variant="small" tone="ink3">
                    Private key
                  </T>
                  <T variant="mono" selectable style={{ fontSize: 14, lineHeight: 20 }}>
                    {near.privateKey}
                  </T>
                </View>
              </Card>
              <T variant="small" tone="ink3">
                Badges from testnet events are on NEAR testnet: switch the NEAR wallet to testnet to see them.
              </T>
            </View>
          ) : null}
          <Notice tone="bad">{`Anyone who sees ${near ? "these keys" : "this key"} can use your wallet.`}</Notice>
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
