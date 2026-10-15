/**
 * One event: the day itself, its turnout, and what this person can do about it
 * — register, open their pass, or look at the badge they collected.
 */
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import { Image, RefreshControl, StyleSheet, View } from "react-native";
import { DateTile } from "@/components/DateTile";
import { StatePanel } from "@/components/StatePanel";
import { T } from "@/components/T";
import { Bar, Button, Card, Chip, Notice, Screen } from "@/components/ui";
import { api, type EventSummary } from "@/lib/api";
import { longDate, number, turnout } from "@/lib/format";
import { absolute, ApiError } from "@/lib/http";
import { heldTokens } from "@/lib/ledger";
import { loadRegistrations } from "@/lib/registrations";
import { radius, useTheme } from "@/lib/theme";
import { useWallet } from "@/lib/wallet";

export default function EventScreen() {
  const theme = useTheme();
  const wallet = useWallet();
  const params = useLocalSearchParams<{ eventId: string }>();
  const eventId = Number(params.eventId);
  const [event, setEvent] = useState<EventSummary | null>(null);
  /** Null while unknown: the ledger did not answer, which is not "no badge". */
  const [collected, setCollected] = useState<boolean | null>(null);
  /** This phone's registration for the event, if it made one. */
  const [mine, setMine] = useState<{ displayName: string | null; checkedIn: boolean } | null>(null);
  const [error, setError] = useState<{ title: string; body: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!Number.isInteger(eventId) || eventId < 0) {
      setError({ title: "No such event", body: "That link does not point at an event." });
      return;
    }
    const held = heldTokens(wallet.address).then(
      (tokens) => tokens.some((t) => t.taxon === eventId),
      () => null,
    );
    const myRegistration = loadRegistrations(wallet.address).then(async (all) => {
      const local = all[String(eventId)];
      if (!local) return null;
      // poap.live's copy says whether the desk has checked them in; the phone's
      // copy is enough to say they are registered when it cannot be reached.
      const remote = await api.registration(local.id).catch(() => null);
      return { displayName: remote?.displayName ?? local.displayName, checkedIn: Boolean(remote?.checkedInAt) };
    });
    try {
      const [e, h, r] = await Promise.all([api.event(eventId), held, myRegistration]);
      setEvent(e);
      setCollected(h);
      setMine(r);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setError({ title: "No such event", body: "It may not have been published yet." });
      } else {
        setError({
          title: "This event is offline",
          body: err instanceof ApiError ? err.message : "We could not read this event.",
        });
      }
    }
  }, [eventId, wallet.address]);

  // Fresh on every visit: coming back from the pass, the badge may be here.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const refresh = (
    <RefreshControl
      refreshing={refreshing}
      tintColor={theme.ink3}
      onRefresh={async () => {
        setRefreshing(true);
        await load();
        setRefreshing(false);
      }}
    />
  );

  if (!event) {
    return (
      <Screen edges={[]} contentStyle={{ paddingTop: 12 }} refreshControl={refresh}>
        {error ? (
          <StatePanel title={error.title} body={error.body} action={{ label: "Try again", onPress: () => void load() }} />
        ) : (
          <StatePanel title="Reading the event" body="One moment." />
        )}
      </Screen>
    );
  }

  const registered = Number(event.stats?.registered ?? 0);
  const badges = Number(event.stats?.attended ?? 0);
  const pct = turnout(registered, badges);
  const issuing = event.status === "open" || event.status === "live";
  const where = [longDate(event.eventDate), event.venue].filter(Boolean);

  return (
    <Screen edges={[]} contentStyle={{ paddingTop: 4, gap: 18 }} refreshControl={refresh}>
      <View style={{ gap: 10 }}>
        <Chip status={event.status} />
        <T variant="hero">{event.name}</T>
        <T variant="mono" tone="ink3">
          {event.eventId}
        </T>
      </View>

      <View style={styles.when}>
        <DateTile iso={event.eventDate} size={84} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          {where.map((line, i) => (
            <T key={i} variant={i === 0 ? "heading" : "meta"} tone={i === 0 ? "ink" : "ink2"}>
              {line}
            </T>
          ))}
        </View>
      </View>

      {event.description ? (
        <T variant="body" tone="ink2">
          {event.description}
        </T>
      ) : null}

      <Card style={{ gap: 10 }}>
        <View style={styles.figures}>
          <Figure value={number(registered)} label="registered" />
          <Figure value={badges > 0 ? number(badges) : "—"} label={badges === 1 ? "badge" : "badges"} jade={badges > 0} />
          {badges > 0 ? <Figure value={`${pct}%`} label="turnout" /> : null}
        </View>
        {badges > 0 ? <Bar percent={pct} /> : null}
      </Card>

      {collected ? (
        <Card style={styles.badge}>
          <Image
            source={{ uri: absolute(api.badgeArt(event.eventId, wallet.address)) }}
            style={[styles.art, { backgroundColor: theme.surface2 }]}
            accessibilityLabel={`Your badge for ${event.name}`}
          />
          <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
            <T variant="heading">You were there</T>
            <T variant="meta" tone="ink2">
              The badge is in your wallet.
            </T>
          </View>
        </Card>
      ) : mine ? (
        <View style={{ gap: 12 }}>
          <Notice tone="ok">
            {mine.checkedIn
              ? `You are checked in${mine.displayName ? ` as ${mine.displayName}` : ""}.`
              : `You are registered${mine.displayName ? ` as ${mine.displayName}` : ""}. The desk will know you.`}
          </Notice>
          {issuing ? <Button label="Show my pass" onPress={() => router.push(`/pass/${event.eventId}`)} /> : null}
        </View>
      ) : issuing ? (
        <View style={{ gap: 10 }}>
          <Button label="Register" onPress={() => router.push(`/register/${event.eventId}`)} />
          <Button label="Show my pass" kind="secondary" onPress={() => router.push(`/pass/${event.eventId}`)} />
          <T variant="small" tone="ink3" style={{ textAlign: "center" }}>
            Registering puts your name on the list. Without it the desk still gives you the badge.
          </T>
        </View>
      ) : (
        <Notice>{event.status === "closed" ? "This event is over." : "This event has not opened yet."}</Notice>
      )}
    </Screen>
  );
}

function Figure({ value, label, jade = false }: { value: string; label: string; jade?: boolean }) {
  return (
    <View>
      <T variant="figure" tone={jade ? "jade" : "ink"}>
        {value}
      </T>
      <T variant="small" tone="ink3">
        {label}
      </T>
    </View>
  );
}

const styles = StyleSheet.create({
  when: { flexDirection: "row", alignItems: "center", gap: 14 },
  figures: { flexDirection: "row", gap: 28 },
  badge: { flexDirection: "row", alignItems: "center", gap: 14 },
  art: { width: 88, height: 88, borderRadius: radius.tile },
});
