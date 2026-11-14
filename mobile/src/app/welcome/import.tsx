/**
 * Bringing in a wallet the person already has, from its key. It joins the
 * wallets on this phone and becomes the one in use.
 */
import { router } from "expo-router";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, View } from "react-native";
import { T } from "@/components/T";
import { useToast } from "@/components/Toast";
import { Button, Field, Notice, Screen } from "@/components/ui";
import { useWalletState } from "@/lib/wallet";

export default function ImportWallet() {
  const { wallets, importKey } = useWalletState();
  const toast = useToast();
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!key.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const meta = await importKey(key, name);
      router.dismissTo("/");
      toast.show(`${meta.name} added`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Screen edges={[]} contentStyle={{ paddingTop: 20, gap: 18 }}>
        <View style={{ gap: 8 }}>
          <T variant="title">Use a wallet you have</T>
          <T variant="body" tone="ink2">
            Type its key — the one that starts with “s”. Its badges come with it.
          </T>
        </View>
        <Field
          label="Wallet key"
          value={key}
          onChangeText={setKey}
          placeholder="sEd…"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          spellCheck={false}
          autoFocus
        />
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
        <Button label="Use this wallet" onPress={submit} busy={busy} disabled={!key.trim()} />
      </Screen>
    </KeyboardAvoidingView>
  );
}
