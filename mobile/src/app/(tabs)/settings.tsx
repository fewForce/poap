/**
 * Settings: the details the register form starts with, how the app looks,
 * the passcode and biometrics, and what it is and where it connects.
 *
 * The network choice — mainnet's poap.live or testnet.poap.live — is for the
 * people testing the app, not the people using it: it appears only after the
 * version number has been tapped five times.
 */
import Constants from "expo-constants";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, Keyboard, Linking, Pressable, StyleSheet, Switch, View } from "react-native";
import { PoweredBy } from "@/components/PoweredBy";
import { T } from "@/components/T";
import { useToast } from "@/components/Toast";
import { Button, Card, Field, Screen, Segmented } from "@/components/ui";
import { api, type Network } from "@/lib/api";
import { biometricMethod, confirmBiometric } from "@/lib/auth";
import { loadProfile, looksLikeEmail, saveProfile } from "@/lib/registrations";
import { server as currentServer, SERVERS, type Server } from "@/lib/server";
import { useSettings, type ThemeChoice } from "@/lib/settings";
import { useTheme } from "@/lib/theme";

const VERSION = Constants.expoConfig?.version ?? "1.0.0";
const SUPPORT = "lead@feooh.com";
/** Taps on the version, within this long, that show the network options. */
const TAPS = 5;
const TAP_WINDOW_MS = 3000;

type Health = { state: "checking" } | { state: "ok"; network: Network } | { state: "down" };

export default function SettingsTab() {
  const settings = useSettings();
  const theme = useTheme();
  const host = SERVERS[settings.server].host;

  // ---- your details
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [saved, setSaved] = useState({ name: "", email: "" });
  const toast = useToast();
  useEffect(() => {
    void loadProfile().then((p) => {
      const loaded = { name: p?.displayName ?? "", email: p?.email ?? "" };
      setName(loaded.name);
      setEmail(loaded.email);
      setSaved(loaded);
    });
  }, []);
  const dirty = name.trim() !== saved.name || email.trim() !== saved.email;

  async function saveDetails() {
    const mail = email.trim();
    if (mail && !looksLikeEmail(mail)) {
      toast.show("That email does not look right.", "bad");
      return;
    }
    await saveProfile({ displayName: name, email: mail || null });
    setSaved({ name: name.trim(), email: mail });
    Keyboard.dismiss();
    toast.show("Your details are saved");
  }

  // ---- the lock, and the server's health, fresh on every visit
  const [method, setMethod] = useState<string | null | undefined>(undefined);
  const [health, setHealth] = useState<Health>({ state: "checking" });
  useFocusEffect(
    useCallback(() => {
      let live = true;
      const asked = settings.server;
      // An answer from the server this screen no longer shows is dropped.
      const mine = () => live && currentServer() === asked;
      void biometricMethod().then((m) => live && setMethod(m));
      setHealth({ state: "checking" });
      api.health().then(
        (h) => mine() && setHealth({ state: "ok", network: h.network }),
        () => mine() && setHealth({ state: "down" }),
      );
      return () => {
        live = false;
      };
    }, [settings.server]),
  );

  // Turning biometrics on proves they work here; turning them off weakens
  // nothing, since the passcode is always there.
  async function toggleBiometrics(on: boolean) {
    if (!method) return;
    if (!on) {
      await settings.update({ biometrics: false });
      toast.show(`${method} is off. POAP will ask for the passcode.`);
    } else if (await confirmBiometric(`Turn on ${method}`)) {
      await settings.update({ biometrics: true });
      toast.show(`${method} is on`);
    }
  }

  // ---- five taps on the version
  const taps = useRef({ count: 0, first: 0 });
  function tapVersion() {
    const now = Date.now();
    if (now - taps.current.first > TAP_WINDOW_MS) taps.current = { count: 0, first: now };
    taps.current.count += 1;
    if (taps.current.count >= TAPS) {
      taps.current = { count: 0, first: 0 };
      if (!settings.networkOptions) void settings.update({ networkOptions: true });
    }
  }

  function chooseServer(next: Server) {
    Alert.alert(
      `Switch to ${SERVERS[next].label}?`,
      `The app will use ${SERVERS[next].host}. Your wallets stay the same; badges and registrations are separate on each network.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Switch",
          onPress: async () => {
            await settings.update({ server: next });
            toast.show(`Now on ${SERVERS[next].label}`);
          },
        },
      ],
    );
  }

  const status =
    health.state === "ok"
      ? { colour: theme.jade, text: "Connected" }
      : health.state === "down"
        ? { colour: theme.signal, text: "Not reachable" }
        : { colour: theme.ink3, text: "Checking…" };

  return (
    <Screen contentStyle={{ paddingTop: 24, gap: 22 }}>
      <T variant="hero" style={{ textAlign: "center" }}>
        Settings
      </T>

      <Section title="Your details" note="Filled in for you when you register for an event.">
        <Card style={{ gap: 14 }}>
          <Field
            label="Name"
            value={name}
            onChangeText={setName}
            placeholder="Ada Lovelace"
            autoComplete="name"
            textContentType="name"
            autoCapitalize="words"
            maxLength={120}
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
            maxLength={254}
          />
          <Button label="Save" kind="secondary" onPress={() => void saveDetails()} disabled={!dirty} />
        </Card>
      </Section>

      <Section title="Appearance">
        <Segmented<ThemeChoice>
          options={[
            { value: "system", label: "System" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
          value={settings.theme}
          onChange={(t) => void settings.update({ theme: t })}
        />
      </Section>

      <Section
        title="Security"
        note={`POAP asks for your passcode${settings.biometrics && method ? ` or ${method}` : ""} every time it opens, and before it shows a wallet key.`}
      >
        <Card style={{ paddingVertical: 4 }}>
          <Row label="Passcode" first onPress={() => router.push("/passcode/change")}>
            <T variant="meta" tone="jade">
              Change
            </T>
          </Row>
          {method ? (
            <View style={[styles.switchRow, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.rule }]}>
              <T variant="meta" tone="ink3" style={{ flex: 1 }}>
                Unlock with {method}
              </T>
              <Switch
                value={settings.biometrics}
                onValueChange={(on) => void toggleBiometrics(on)}
                trackColor={{ true: theme.jade, false: theme.rule2 }}
                accessibilityLabel={`Unlock with ${method}`}
              />
            </View>
          ) : null}
        </Card>
      </Section>

      {settings.networkOptions ? (
        <Section title="Network" note="For testing. Your wallets are the same on both; badges and registrations are not.">
          <Segmented<Server>
            options={[
              { value: "mainnet", label: "Mainnet" },
              { value: "testnet", label: "Testnet" },
            ]}
            value={settings.server}
            onChange={chooseServer}
          />
          {settings.server === "mainnet" ? (
            <Pressable onPress={() => void settings.update({ networkOptions: false })} hitSlop={10} style={{ alignSelf: "flex-start" }}>
              <T variant="meta" weight="semibold" tone="ink3">
                Hide network options
              </T>
            </Pressable>
          ) : null}
        </Section>
      ) : null}

      <Section title="About">
        <Card style={{ paddingVertical: 4 }}>
          <Row label="Version" first onPress={tapVersion}>
            <T variant="meta">{VERSION}</T>
          </Row>
          <Row label="Server">
            <View style={styles.status}>
              <View style={[styles.dot, { backgroundColor: status.colour }]} />
              <T variant="meta">{host}</T>
            </View>
          </Row>
          <Row label="Status">
            <T variant="meta" tone={health.state === "down" ? "signal" : "ink"}>
              {status.text}
            </T>
          </Row>
          {health.state === "ok" ? (
            <Row label="Ledger">
              <T variant="meta">XRP Ledger {health.network}</T>
            </Row>
          ) : null}
          <Row label="Website" onPress={() => void Linking.openURL(`https://${host}`)}>
            <T variant="meta" tone="jade">
              {host}
            </T>
          </Row>
          <Row label="Support" onPress={() => void Linking.openURL(`mailto:${SUPPORT}`)}>
            <T variant="meta" tone="jade">
              {SUPPORT}
            </T>
          </Row>
        </Card>
      </Section>

      <View style={{ paddingTop: 8 }}>
        <PoweredBy />
      </View>
    </Screen>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <View style={{ gap: 10 }}>
      <View style={{ gap: 2, paddingHorizontal: 2 }}>
        <T variant="label" tone="ink3">
          {title}
        </T>
        {note ? (
          <T variant="small" tone="ink3">
            {note}
          </T>
        ) : null}
      </View>
      {children}
    </View>
  );
}

function Row({ label, first, onPress, children }: { label: string; first?: boolean; onPress?: () => void; children: ReactNode }) {
  const theme = useTheme();
  const body = (
    <View style={[styles.row, first ? null : { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.rule }]}>
      <T variant="meta" tone="ink3">
        {label}
      </T>
      {children}
    </View>
  );
  return onPress ? (
    <Pressable onPress={onPress} style={({ pressed }) => (pressed ? { opacity: 0.6 } : null)}>
      {body}
    </Pressable>
  ) : (
    body
  );
}

const styles = StyleSheet.create({
  switchRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8 },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 16, paddingVertical: 12 },
  status: { flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
