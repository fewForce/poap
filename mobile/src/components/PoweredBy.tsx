/**
 * Under the main screen's heading, centred:
 *
 *                 powered by
 *                  [feooh]
 *
 * No chain beside it: an event's badges can be on XRPL or NEAR.
 *
 * In colour on light. On dark the feooh mark has a twin: letters in the
 * theme's ink, and the ∞ in its own colours on a thin ring of ink — its
 * shadows are near-black and would otherwise vanish into the page.
 */
import { Image, StyleSheet, useColorScheme, View } from "react-native";
import { T } from "./T";

const FEOOH = require("../../assets/feooh.png") as number;
const FEOOH_DARK = require("../../assets/feooh-dark.png") as number;
/** 695 × 244 both, cropped to the mark. */
const FEOOH_RATIO = 695 / 244;

export function PoweredBy({ height = 28 }: { height?: number }) {
  const dark = useColorScheme() === "dark";
  return (
    <View style={styles.wrap} accessibilityLabel="Powered by feooh">
      <T variant="small" tone="ink3">
        powered by
      </T>
      <Image source={dark ? FEOOH_DARK : FEOOH} style={{ height, width: height * FEOOH_RATIO }} resizeMode="contain" />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", gap: 4 },
});
