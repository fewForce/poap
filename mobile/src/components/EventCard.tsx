/**
 * One event in the list — the phone layout of poap.live's event card.
 *
 *   Happening now                    ┌──────┐
 *   Merchandise test                 │ SEP  │
 *   70009                            │  16  │
 *   delhi                            │ 2026 │
 *   sgfdg                            └──────┘
 *   0 registered   2 badges   turnout 100%
 *   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *   [             Show my pass            ]
 *
 * The whole card opens the event. One button besides, and only on an event
 * still to happen: "Register" on one coming up that this phone has not
 * registered for, the pass otherwise.
 */
import { Pressable, StyleSheet, View } from "react-native";
import type { EventSummary } from "@/lib/api";
import { number, turnout } from "@/lib/format";
import { DateTile } from "./DateTile";
import { T } from "./T";
import { Bar, Button, Card, Chip } from "./ui";

export function EventCard({
  event,
  signedUp,
  onOpen,
  onPass,
  onRegister,
}: {
  event: EventSummary;
  /** This phone has registered for it. */
  signedUp: boolean;
  onOpen: () => void;
  onPass: () => void;
  onRegister: () => void;
}) {
  const registered = Number(event.stats?.registered ?? 0);
  const badges = Number(event.stats?.attended ?? 0);
  const issuing = event.status === "open" || event.status === "live";
  const pct = turnout(registered, badges);

  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Open ${event.name}`} onPress={onOpen}>
      {({ pressed }) => (
        <Card style={{ opacity: pressed ? 0.92 : 1 }}>
          <View style={styles.top}>
            <View style={styles.text}>
              <Chip status={event.status} />
              <T variant="title" numberOfLines={2} style={{ marginTop: 9 }}>
                {event.name}
              </T>
              <T variant="mono" tone="ink3" style={{ marginTop: 4 }}>
                {event.eventId}
              </T>
              {event.venue ? (
                <T variant="meta" tone="ink2" numberOfLines={2} style={{ marginTop: 3 }}>
                  {event.venue}
                </T>
              ) : null}
              {event.description ? (
                <T variant="meta" tone="ink3" numberOfLines={2} style={{ marginTop: 7 }}>
                  {event.description}
                </T>
              ) : null}
            </View>
            <DateTile iso={event.eventDate} />
          </View>

          <View style={styles.figures}>
            <T variant="meta" tone="ink3">
              <T variant="meta" weight="semibold" tone="ink2">
                {number(registered)}
              </T>{" "}
              registered
            </T>
            <T variant="meta" tone="ink3">
              <T variant="figure" tone={badges > 0 ? "jade" : "ink3"}>
                {badges > 0 ? number(badges) : "—"}
              </T>{" "}
              {badges === 1 ? "badge" : "badges"}
            </T>
            {badges > 0 ? (
              <T variant="meta" tone="ink3" style={{ marginLeft: "auto" }}>
                turnout{" "}
                <T variant="meta" weight="bold">
                  {pct}%
                </T>
              </T>
            ) : null}
          </View>
          {badges > 0 ? <Bar percent={pct} /> : null}

          {issuing && !signedUp ? (
            // Registering comes first, on either chain: the pass opens after it.
            <Button label="Register" onPress={onRegister} style={{ marginTop: 14 }} />
          ) : issuing ? (
            <Button
              label="Show my pass"
              kind={event.status === "live" ? "primary" : "secondary"}
              onPress={onPass}
              style={{ marginTop: 14 }}
            />
          ) : null}
        </Card>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  top: { flexDirection: "row", alignItems: "center", gap: 12 },
  text: { flex: 1, minWidth: 0 },
  figures: { flexDirection: "row", alignItems: "baseline", gap: 18, marginTop: 14, marginBottom: 8 },
});
