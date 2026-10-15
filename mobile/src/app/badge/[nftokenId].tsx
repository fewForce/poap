/**
 * One badge, as the badge itself has it: its artwork, and what its metadata
 * and the ledger say about it. No event numbers — that is the event's page.
 */
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import { Image, StyleSheet, useWindowDimensions, View } from "react-native";
import { StatePanel } from "@/components/StatePanel";
import { T } from "@/components/T";
import { Card, Screen } from "@/components/ui";
import { api } from "@/lib/api";
import { badgeContents, type BadgeContents } from "@/lib/badge";
import { longDate } from "@/lib/format";
import { absolute } from "@/lib/http";
import { heldTokens, LedgerError, TRANSFERABLE, type HeldToken } from "@/lib/ledger";
import { radius, useTheme } from "@/lib/theme";
import { useWallet } from "@/lib/wallet";

const short = (id: string) => `${id.slice(0, 6)}…${id.slice(-4)}`;
const looksLikeAddress = (v: string) => /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(v);

/** Already the heading, so not repeated below it. */
const IN_HEADING = new Set(["event_name"]);

interface Loaded {
  token: HeldToken;
  contents: BadgeContents | null;
  eventName: string | null;
  when: string | null;
}

export default function BadgeScreen() {
  const theme = useTheme();
  const wallet = useWallet();
  const { width } = useWindowDimensions();
  const { nftokenId } = useLocalSearchParams<{ nftokenId: string }>();
  const [badge, setBadge] = useState<Loaded | null>(null);
  const [error, setError] = useState<{ title: string; body: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const tokens = await heldTokens(wallet.address);
      const token = tokens.find((t) => t.nftokenId.toUpperCase() === String(nftokenId).toUpperCase());
      if (!token) {
        setError({ title: "Not in this wallet", body: "This badge is not held by the wallet in use." });
        return;
      }
      const [contents, event] = await Promise.all([
        token.uri ? badgeContents(token.uri).catch(() => null) : Promise.resolve(null),
        api.event(token.taxon).catch(() => null),
      ]);
      const named = contents?.traits.find((t) => t.key === "event_name")?.value;
      setBadge({
        token,
        contents,
        eventName: event?.name ?? named ?? contents?.name ?? null,
        when: [longDate(event?.eventDate), event?.venue].filter(Boolean).join(" · ") || null,
      });
      setError(null);
    } catch (err) {
      setError({
        title: "We could not read this badge",
        body: err instanceof LedgerError ? err.message : "Check your connection and try again.",
      });
    }
  }, [wallet.address, nftokenId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (error || !badge) {
    return (
      <Screen edges={[]} contentStyle={{ paddingTop: 16 }}>
        {error ? (
          <StatePanel title={error.title} body={error.body} action={{ label: "Try again", onPress: () => void load() }} />
        ) : (
          <StatePanel title="Reading your badge" body="One moment." />
        )}
      </Screen>
    );
  }

  const { token, contents } = badge;
  const art = contents?.image ?? absolute(api.badgeArt(token.taxon, wallet.address));
  const size = Math.min(width - 36, 520);
  const traits = (contents?.traits ?? []).filter((t) => !IN_HEADING.has(t.key));
  const ledger: { label: string; value: string; mono?: boolean }[] = [
    { label: "Token", value: short(token.nftokenId), mono: true },
    { label: "Issued by", value: short(token.issuer), mono: true },
    { label: "Serial", value: `#${token.serial}` },
    { label: "Can be sent on", value: token.flags & TRANSFERABLE ? "Yes" : "No, it stays in this wallet" },
  ];

  return (
    <Screen edges={[]} contentStyle={{ paddingTop: 16, gap: 20, alignItems: "center" }}>
      <Image
        source={{ uri: art }}
        style={{ width: size, height: size, borderRadius: radius.card, backgroundColor: theme.surface2 }}
        accessibilityLabel={badge.eventName ? `The badge for ${badge.eventName}` : "The badge"}
      />

      <View style={{ gap: 6, alignSelf: "stretch" }}>
        <T variant="title" style={{ textAlign: "center" }}>
          {badge.eventName ?? "Badge"}
        </T>
        {badge.when ? (
          <T variant="meta" tone="ink2" style={{ textAlign: "center" }}>
            {badge.when}
          </T>
        ) : null}
      </View>

      {contents?.description ? (
        <T variant="body" tone="ink2" style={{ alignSelf: "stretch" }}>
          {contents.description}
        </T>
      ) : null}

      {traits.length ? (
        <Card style={styles.list}>
          {traits.map((t, i) => (
            <Row key={`${t.key}-${i}`} label={t.label} first={i === 0}>
              <T variant={looksLikeAddress(t.value) ? "mono" : "meta"} selectable style={styles.value}>
                {looksLikeAddress(t.value) ? short(t.value) : t.value}
              </T>
            </Row>
          ))}
        </Card>
      ) : null}

      <View style={{ gap: 8, alignSelf: "stretch" }}>
        <T variant="label" tone="ink3">
          On the XRP Ledger
        </T>
        <Card style={styles.list}>
          {ledger.map((r, i) => (
            <Row key={r.label} label={r.label} first={i === 0}>
              <T variant={r.mono ? "mono" : "meta"} selectable style={styles.value}>
                {r.value}
              </T>
            </Row>
          ))}
        </Card>
      </View>
    </Screen>
  );
}

function Row({ label, first, children }: { label: string; first: boolean; children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <View style={[styles.row, first ? null : { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.rule }]}>
      <T variant="meta" tone="ink3">
        {label}
      </T>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { alignSelf: "stretch", paddingVertical: 4 },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 16, paddingVertical: 12 },
  value: { flexShrink: 1, textAlign: "right" },
});
