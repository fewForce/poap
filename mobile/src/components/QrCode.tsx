/**
 * A QR code on the pass's plate, with the viewfinder brackets outside it —
 * the same plate, the same ink and the same encoder as poap.live's pass.
 *
 * The four-module quiet zone is inside the drawing, so nothing laid out next
 * to it can eat into it. The plate stays light in dark mode on purpose: a
 * scanner wants dark on light, and an inverted code fails on half of them.
 */
import { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import { encodeQr } from "@/lib/qr-encoder";
import { useTheme } from "@/lib/theme";

function pathFor(value: string): { d: string; dim: number } {
  const q = encodeQr(value);
  const quiet = 4;
  const dim = q.size + quiet * 2;
  let d = "";
  for (let r = 0; r < q.size; r += 1) {
    let c = 0;
    while (c < q.size) {
      if (q.modules[r * q.size + c]) {
        let run = 1;
        while (c + run < q.size && q.modules[r * q.size + c + run]) run += 1;
        d += `M${c + quiet} ${r + quiet}h${run}v1h-${run}z`;
        c += run;
      } else c += 1;
    }
  }
  return { d, dim };
}

export function QrCode({ value, size = 260, live = true }: { value: string; size?: number; live?: boolean }) {
  const theme = useTheme();
  const { d, dim } = useMemo(() => pathFor(value), [value]);
  return (
    <View style={[styles.plate, { width: size, height: size, backgroundColor: theme.qrPlate, borderColor: theme.rule2 }]}>
      <Svg width="100%" height="100%" viewBox={`0 0 ${dim} ${dim}`}>
        <Rect width={dim} height={dim} fill={theme.qrPlate} />
        <Path d={d} fill={theme.qrInk} />
      </Svg>
      {live
        ? (["tl", "tr", "bl", "br"] as const).map((corner) => (
            <View key={corner} style={[styles.bracket, styles[corner], { borderColor: theme.signal }]} />
          ))
        : null}
    </View>
  );
}

const B = 19;
const styles = StyleSheet.create({
  plate: { borderRadius: 16, borderWidth: 1, padding: 9 },
  bracket: { position: "absolute", width: B, height: B, borderWidth: 2.5 },
  tl: { top: -8, left: -8, borderRightWidth: 0, borderBottomWidth: 0, borderTopLeftRadius: 16 },
  tr: { top: -8, right: -8, borderLeftWidth: 0, borderBottomWidth: 0, borderTopRightRadius: 16 },
  bl: { bottom: -8, left: -8, borderRightWidth: 0, borderTopWidth: 0, borderBottomLeftRadius: 16 },
  br: { bottom: -8, right: -8, borderLeftWidth: 0, borderTopWidth: 0, borderBottomRightRadius: 16 },
});
