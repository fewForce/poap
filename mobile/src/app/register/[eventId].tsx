/**
 * Registering for one event: a name for the desk, an email if they like, one
 * button. The phone signs the registration with its wallet's key; nothing is
 * shown about that, because nothing about it needs a decision.
 */
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, View } from "react-native";
import { T } from "@/components/T";
import { useToast } from "@/components/Toast";
import { Button, Field, Notice, Screen } from "@/components/ui";
import { api, type EventSummary } from "@/lib/api";
import { ApiError } from "@/lib/http";
import { loadProfile, looksLikeEmail, registerFor } from "@/lib/registrations";
import { useWallet } from "@/lib/wallet";

export default function Register() {
  const wallet = useWallet();
  const toast = useToast();
  const params = useLocalSearchParams<{ eventId: string }>();
  const eventId = Number(params.eventId);
  const [event, setEvent] = useState<EventSummary | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.event(eventId).then(
      (e) => live && setEvent(e),
      () => undefined,
    );
    // Last time's name and email, so registering for the next event is one tap.
    loadProfile().then((p) => {
      if (!live || !p) return;
      setName(p.displayName);
      setEmail(p.email ?? "");
    });
    return () => {
      live = false;
    };
  }, [eventId]);

  const valid = name.trim().length > 0;

  async function submit() {
    if (!valid || busy) return;
    const mail = email.trim();
    if (mail && !looksLikeEmail(mail)) {
      setError("That email does not look right. Check it, or leave it empty.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { already } = await registerFor(wallet, eventId, { displayName: name, email: mail || null });
      router.back();
      toast.show(already ? "You were already registered" : event ? `Registered for ${event.name}` : "You are registered");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That did not go through. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Screen edges={[]} contentStyle={{ paddingTop: 20, gap: 18 }}>
        <View style={{ gap: 8 }}>
          <T variant="title">{event ? `Register for ${event.name}` : "Register"}</T>
          <T variant="body" tone="ink2">
            The desk sees your name when you arrive. Your email goes to the organiser only, and you can leave it out.
          </T>
        </View>
        <Field
          label="Your name"
          value={name}
          onChangeText={setName}
          placeholder="Ada Lovelace"
          autoComplete="name"
          textContentType="name"
          autoCapitalize="words"
          returnKeyType="next"
          maxLength={120}
          autoFocus={!name}
        />
        <Field
          label="Email (optional)"
          value={email}
          onChangeText={setEmail}
          placeholder="you@example.com"
          autoComplete="email"
          textContentType="emailAddress"
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          onSubmitEditing={submit}
          maxLength={254}
        />
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <Button label="Register" onPress={submit} busy={busy} disabled={!valid} />
      </Screen>
    </KeyboardAvoidingView>
  );
}
