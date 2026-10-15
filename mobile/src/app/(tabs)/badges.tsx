/**
 * Every badge in the wallet in use, as a wall of badges: read straight off the
 * ledger and named from poap.live's event list (a badge's taxon is its event
 * id). The art is the badge's own, served by poap.live for this wallet and
 * that event. Tapping one opens the badge, not the event.
 */
import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { FlatList, Image, Pressable, RefreshControl, StyleSheet, useWindowDimensions, View } from "react-native";
import { StatePanel } from "@/components/StatePanel";
import { T } from "@/components/T";
import { SafeArea } from "@/components/ui";
import { api, type EventSummary } from "@/lib/api";
import { longDate } from "@/lib/format";
import { absolute, ApiError } from "@/lib/http";
import { heldTokens, LedgerError } from "@/lib/ledger";
import { column, MAX_CONTENT, radius, useTheme } from "@/lib/theme";
import { server as currentServer } from "@/lib/server";
import { useSettings } from "@/lib/settings";
import { useWallet } from "@/lib/wallet";

interface BadgeRow {
  event: EventSummary;
  nftokenId: string;
}

export default function Badges() {
  const theme = useTheme();
  const wallet = useWallet();
  const tileWidth = (Math.min(useWindowDimensions().width, MAX_CONTENT) - PAD * 2 - GAP) / 2;
  const [badges, setBadges] = useState<BadgeRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Another network or another wallet holds other badges: clear, then load.
  const { server } = useSettings();
  const scope = `${server}:${wallet.address}`;
  const [shownFor, setShownFor] = useState(scope);
  if (shownFor !== scope) {
    setShownFor(scope);
    setBadges(null);
    setError(null);
  }

  const load = useCallback(async () => {
    const asked = server;
    try {
      const [tokens, events] = await Promise.all([heldTokens(wallet.address), api.events()]);
      if (currentServer() !== asked) return; // switched while this was in flight
      const byId = new Map(events.map((e) => [e.eventId, e]));
      const rows = tokens.flatMap((t) => {
        const event = byId.get(t.taxon);
        return event ? [{ event, nftokenId: t.nftokenId }] : [];
      });
      rows.sort((a, b) => (b.event.eventDate ?? "").localeCompare(a.event.eventDate ?? ""));
      setBadges(rows);
      setError(null);
    } catch (err) {
      if (currentServer() !== asked) return;
      setError(err instanceof ApiError || err instanceof LedgerError ? err.message : "We could not read your badges.");
    }
  }, [wallet.address, server]);

  // Fresh every time the tab is opened: a badge collected a minute ago belongs here.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  return (
    <SafeArea edges={["top"]} style={{ flex: 1, backgroundColor: theme.paper }}>
      <FlatList
        data={badges ?? []}
        keyExtractor={(b) => b.nftokenId}
        numColumns={2}
        columnWrapperStyle={styles.columns}
        contentContainerStyle={[styles.list, column]}
        ListHeaderComponent={
          <View style={styles.head}>
            <T variant="hero" style={{ textAlign: "center" }}>
              Your badges
            </T>
            <T variant="lede" tone="ink2" style={{ textAlign: "center" }}>
              One for every event you turned up to. They are yours for good.
            </T>
          </View>
        }
        ItemSeparatorComponent={() => <View style={{ height: 20 }} />}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => router.push(`/badge/${item.nftokenId}`)}
            style={({ pressed }) => [styles.tile, { width: tileWidth }, pressed ? { opacity: 0.7 } : null]}
            accessibilityRole="button"
            accessibilityLabel={`The badge for ${item.event.name}`}
          >
            <Image
              source={{ uri: absolute(api.badgeArt(item.event.eventId, wallet.address)) }}
              style={[styles.art, { backgroundColor: theme.surface2, borderColor: theme.rule }]}
            />
            <View style={{ gap: 2, paddingHorizontal: 2 }}>
              <T variant="label" numberOfLines={2} style={{ fontSize: 14, lineHeight: 18 }}>
                {item.event.name}
              </T>
              {item.event.eventDate ? (
                <T variant="small" tone="ink3" numberOfLines={1}>
                  {longDate(item.event.eventDate)}
                </T>
              ) : null}
            </View>
          </Pressable>
        )}
        ListEmptyComponent={
          error ? (
            <StatePanel title="We could not read your badges" body={error} action={{ label: "Try again", onPress: () => void load() }} />
          ) : badges === null ? (
            <StatePanel title="Reading your badges" body="One moment." />
          ) : (
            <StatePanel
              title="No badges yet"
              body="Show your pass at the desk of an event and your first badge lands here."
              action={{ label: "See events", onPress: () => router.navigate("/") }}
            />
          )
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

const PAD = 18;
const GAP = 14;

const styles = StyleSheet.create({
  list: { paddingHorizontal: PAD, paddingBottom: 32 },
  head: { gap: 10, paddingTop: 24, paddingBottom: 22 },
  columns: { gap: GAP },
  tile: { gap: 8 },
  art: { width: "100%", aspectRatio: 1, borderRadius: radius.card, borderWidth: StyleSheet.hairlineWidth },
});
