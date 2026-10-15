/**
 * Making a new wallet: a name if they want one, then its key, to write down.
 * The key is shown here once; after this it is only shown from the Wallet tab,
 * when asked for.
 */
import { router, Stack } from "expo-router";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, View } from "react-native";
import { T } from "@/components/T";
import { Button, Card, Field, Notice, Screen } from "@/components/ui";
import { useWalletState } from "@/lib/wallet";

export default function CreateWallet() {
  const { wallets, create } = useWalletState();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ name: string; seed: string } | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const { meta, seed } = await create(name);
      setMade({ name: meta.name, seed });
    } catch {
      setError("The wallet could not be made. Unlock the phone and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (made) {
    return (
      <Screen edges={[]} contentStyle={{ paddingTop: 20, gap: 18 }}>
        {/* No way back to the form: the wallet exists now. */}
        <Stack.Screen options={{ headerBackVisible: false, gestureEnabled: false, title: made.name }} />
        <T variant="title">Write down your wallet key</T>
        <T variant="body" tone="ink2">
          This key is your wallet. With it, the wallet and its badges can be brought back on any phone. Without it,
          nobody — not poap.live, not us — can get them back if this phone is lost.
        </T>
        <Card style={{ alignItems: "center", paddingVertical: 22 }}>
          <T variant="mono" selectable style={{ fontSize: 17, lineHeight: 24, textAlign: "center" }}>
            {made.seed}
          </T>
        </Card>
        <Notice tone="bad">Anyone who sees this key can use your wallet. Keep it on paper, somewhere safe.</Notice>
        <Button label="I have written it down" onPress={() => router.dismissTo("/")} />
        <Button label="Back up later" kind="quiet" onPress={() => router.dismissTo("/")} />
      </Screen>
    );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Screen edges={[]} contentStyle={{ paddingTop: 20, gap: 18 }}>
        <View style={{ gap: 8 }}>
          <T variant="title">A new wallet</T>
          <T variant="body" tone="ink2">
            It is made on this phone, and its key never leaves it.
          </T>
        </View>
        <Field
          label="Name (optional)"
          value={name}
          onChangeText={setName}
          placeholder={`Wallet ${wallets.length + 1}`}
          maxLength={40}
          returnKeyType="done"
          onSubmitEditing={submit}
        />
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <Button label="Create wallet" onPress={submit} busy={busy} />
      </Screen>
    </KeyboardAvoidingView>
  );
}
