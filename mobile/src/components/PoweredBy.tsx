/**
 * Under the main screen's heading, centred:
 *
 *                 powered by
 *          [feooh]  on  [XRPL]
 *
 * In colour on light. On dark the feooh mark has a twin: letters in the
 * theme's ink, and the ∞ in its own colours on a thin ring of ink — its
 * shadows are near-black and would otherwise vanish into the page. The XRPL
 * mark is drawn in the theme's ink.
 */
import { Image, StyleSheet, useColorScheme, View } from "react-native";
import { SvgXml } from "react-native-svg";
import { useTheme } from "@/lib/theme";
import { T } from "./T";
import { XRPL_MARK } from "./xrplLogotype";

const FEOOH = require("../../assets/feooh.png") as number;
const FEOOH_DARK = require("../../assets/feooh-dark.png") as number;
/** 695 × 244 both, cropped to the mark. */
const FEOOH_RATIO = 695 / 244;
/** 37.2 × 31.6 */
const XRPL_RATIO = 37.2 / 31.6;

export function PoweredBy({ height = 28 }: { height?: number }) {
  const theme = useTheme();
  const dark = useColorScheme() === "dark";
  return (
    <View style={styles.wrap} accessibilityLabel="Powered by feooh on the XRP Ledger">
      <T variant="small" tone="ink3">
        powered by
      </T>
      <View style={styles.logos}>
        <Image source={dark ? FEOOH_DARK : FEOOH} style={{ height, width: height * FEOOH_RATIO }} resizeMode="contain" />
        <T variant="small" tone="ink3">
          on
        </T>
        <SvgXml xml={XRPL_MARK} color={theme.ink} height={height * 0.8} width={height * 0.8 * XRPL_RATIO} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", gap: 4 },
  logos: { flexDirection: "row", alignItems: "center", gap: 8 },
});
