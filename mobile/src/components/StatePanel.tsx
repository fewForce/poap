/**
 * Nothing to show yet, and why — the same quiet panel poap.live uses while it
 * reads a record: a heading, a line, and sometimes one thing to press.
 */
import { StyleSheet, View } from "react-native";
import { useTheme } from "@/lib/theme";
import { T } from "./T";
import { Button } from "./ui";

export function StatePanel({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: { label: string; onPress: () => void };
}) {
  const theme = useTheme();
  return (
    <View style={[styles.panel, { backgroundColor: theme.surface, borderColor: theme.rule }]}>
      <T variant="heading" style={{ fontSize: 20, letterSpacing: -0.6 }}>
        {title}
      </T>
      <T variant="meta" tone="ink2" style={{ marginTop: 6 }}>
        {body}
      </T>
      {action ? <Button label={action.label} kind="secondary" onPress={action.onPress} style={{ marginTop: 16 }} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { borderWidth: 1, paddingVertical: 26, paddingHorizontal: 22 },
});
