/**
 * The date, as a date: the calendar square from poap.live's event list.
 * A person looking for the event they went to on the sixth is looking for a
 * 6, not for a sentence.
 */
import { StyleSheet, View } from "react-native";
import { dateParts } from "@/lib/format";
import { radius, useTheme } from "@/lib/theme";
import { T } from "./T";

export function DateTile({ iso, size = 100 }: { iso: string | null; size?: number }) {
  const theme = useTheme();
  const parts = dateParts(iso);
  const scale = size / 100;
  return (
    <View style={[styles.tile, { width: size, height: size, backgroundColor: theme.surface2 }]}>
      {parts ? (
        <>
          <T variant="label" tone="ink3" style={{ fontSize: 12 * scale, letterSpacing: 0.4 }}>
            {parts.mon}
          </T>
          <T weight="extrabold" style={{ fontSize: 32 * scale, lineHeight: 36 * scale, letterSpacing: -1.3 }}>
            {parts.day}
          </T>
          <T variant="small" tone="ink3" style={{ fontSize: 12 * scale }}>
            {parts.year}
          </T>
        </>
      ) : (
        <T variant="small" tone="ink3">
          no date
        </T>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { borderRadius: radius.tile, alignItems: "center", justifyContent: "center", gap: 2 },
});
