/**
 * A finished event, small: the date square, the name and where it was. The
 * big card is for events a person can still go to.
 */
import { Pressable, StyleSheet, View } from "react-native";
import type { EventSummary } from "@/lib/api";
import { radius, useTheme } from "@/lib/theme";
import { DateTile } from "./DateTile";
import { T } from "./T";

export function PastEventRow({ event, onOpen }: { event: EventSummary; onOpen: () => void }) {
  const theme = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Open ${event.name}`} onPress={onOpen}>
      {({ pressed }) => (
        <View style={[styles.row, { backgroundColor: theme.surface, borderColor: theme.rule, opacity: pressed ? 0.85 : 1 }]}>
          <DateTile iso={event.eventDate} size={58} />
          <View style={styles.text}>
            <T variant="heading" numberOfLines={2}>
              {event.name}
            </T>
            {event.venue ? (
              <T variant="meta" tone="ink2" numberOfLines={1}>
                {event.venue}
              </T>
            ) : null}
          </View>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    padding: 10,
    paddingRight: 14,
    borderRadius: radius.tile + 4,
    borderWidth: StyleSheet.hairlineWidth,
  },
  text: { flex: 1, minWidth: 0, gap: 2 },
});
