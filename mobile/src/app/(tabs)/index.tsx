/**
 * Events — the app's front door. Events happening now or still to come, in
 * big cards, soonest first. Finished ones wait behind a button, small, most
 * recent first.
 */
import { router, useFocusEffect } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { EventCard } from "@/components/EventCard";
import { PastEventRow } from "@/components/PastEventRow";
import { PoweredBy } from "@/components/PoweredBy";
import { StatePanel } from "@/components/StatePanel";
import { T } from "@/components/T";
import { SafeArea } from "@/components/ui";
import { api, type EventSummary } from "@/lib/api";
import { ApiError } from "@/lib/http";
import { loadRegistrations, type Registrations } from "@/lib/registrations";
import { server as currentServer } from "@/lib/server";
import { useSettings } from "@/lib/settings";
import { column, useTheme } from "@/lib/theme";
import { useWallet } from "@/lib/wallet";

/** Undated events sort last either way. */
const byDate = (a: EventSummary, b: EventSummary) =>
  (a.eventDate ?? "9999").localeCompare(b.eventDate ?? "9999");

export default function Events() {
  const theme = useTheme();
  const wallet = useWallet();
  const [events, setEvents] = useState<EventSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [registrations, setRegistrations] = useState<Registrations>({});
  const [showPast, setShowPast] = useState(false);

  // Another network or another wallet is another list: drop the one on screen
  // rather than show it under the wrong name while the new one loads.
  const { server } = useSettings();
  const scope = `${server}:${wallet.address}`;
  const [shownFor, setShownFor] = useState(scope);
  if (shownFor !== scope) {
    setShownFor(scope);
    setEvents(null);
    setRegistrations({});
    setError(null);
    setShowPast(false);
  }

  const { upcoming, past } = useMemo(() => {
    const all = events ?? [];
    return {
      upcoming: all.filter((e) => e.status !== "closed").sort(byDate),
      past: all.filter((e) => e.status === "closed").sort((a, b) => byDate(b, a)),
    };
  }, [events]);

  const load = useCallback(async () => {
    const asked = server;
    try {
      const [list, mine] = await Promise.all([api.events(), loadRegistrations(wallet.address)]);
      if (currentServer() !== asked) return; // switched while this was in flight
      setEvents(list);
      setRegistrations(mine);
      setError(null);
    } catch (err) {
      if (currentServer() !== asked) return;
      setError(err instanceof ApiError ? err.message : "We could not read the events.");
    }
  }, [wallet.address, server]);

  // Fresh on every visit: the numbers move while an event is on.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  return (
    <SafeArea edges={["top"]} style={{ flex: 1, backgroundColor: theme.paper }}>
      <FlatList
        data={upcoming}
        keyExtractor={(e) => String(e.eventId)}
        contentContainerStyle={[styles.list, column]}
        ListHeaderComponent={
          <View style={styles.head}>
            <T variant="hero" style={{ textAlign: "center" }}>
              Events
            </T>
            <PoweredBy />
            <T variant="lede" tone="ink2" style={{ textAlign: "center", marginTop: 8 }}>
              Register to put your name on the list, then show your pass at the desk.
            </T>
          </View>
        }
        ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
        renderItem={({ item }) => (
          <EventCard
            event={item}
            signedUp={Boolean(registrations[String(item.eventId)])}
            onOpen={() => router.push(`/event/${item.eventId}`)}
            onPass={() => router.push(`/pass/${item.eventId}`)}
            onRegister={() => router.push(`/register/${item.eventId}`)}
          />
        )}
        ListEmptyComponent={
          error ? (
            <StatePanel title="This list is offline" body={error} action={{ label: "Try again", onPress: () => void load() }} />
          ) : events === null ? (
            <StatePanel title="Reading the events" body="One moment." />
          ) : (
            <StatePanel title="Nothing coming up" body="New events appear here as soon as they open." />
          )
        }
        ListFooterComponent={
          past.length ? (
            <View style={styles.past}>
              <Pressable
                onPress={() => setShowPast((v) => !v)}
                accessibilityRole="button"
                accessibilityState={{ expanded: showPast }}
                hitSlop={12}
                style={({ pressed }) => [styles.toggle, pressed ? { opacity: 0.6 } : null]}
              >
                <T variant="meta" weight="semibold" tone="ink3">
                  {showPast ? "Hide past events" : `Show past events (${past.length})`}
                </T>
                <Svg width={14} height={14} viewBox="0 0 14 14" style={showPast ? { transform: [{ rotate: "180deg" }] } : null}>
                  <Path d="M3 5.25 7 9l4-3.75" stroke={theme.ink3} strokeWidth={1.7} fill="none" strokeLinecap="round" strokeLinejoin="round" />
                </Svg>
              </Pressable>
              {showPast
                ? past.map((e) => (
                    <PastEventRow key={e.eventId} event={e} onOpen={() => router.push(`/event/${e.eventId}`)} />
                  ))
                : null}
            </View>
          ) : null
        }
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={theme.ink3}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
          />
        }
      />
    </SafeArea>
  );
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: 18, paddingBottom: 32 },
  head: { gap: 10, paddingTop: 24, paddingBottom: 22 },
  past: { gap: 10, paddingTop: 14 },
  toggle: { flexDirection: "row", alignItems: "center", alignSelf: "flex-start", gap: 6, paddingVertical: 8, paddingHorizontal: 2 },
});
