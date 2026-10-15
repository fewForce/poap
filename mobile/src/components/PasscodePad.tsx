/**
 * Six dots and a number pad: entering a passcode, the way a phone's own lock
 * screen does it. It hands back the code once all six digits are in; whoever
 * uses it decides what that means, then bumps `resetKey` to clear it.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Animated, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { PASSCODE_LENGTH } from "@/lib/passcode";
import { useTheme } from "@/lib/theme";
import { T } from "./T";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

/**
 * Two sizes. The regular pad needs about 760 points of height with a header
 * above it; a short phone (a 640-point screen, say) gets smaller keys and
 * tighter spacing so the bottom row never sits under the phone's own buttons.
 */
const SIZES = {
  regular: { key: 76, colGap: 28, rowGap: 16, gap: 28, font: 28 },
  compact: { key: 60, colGap: 24, rowGap: 10, gap: 18, font: 24 },
} as const;
type Size = (typeof SIZES)[keyof typeof SIZES];

function useSize(): Size {
  return useWindowDimensions().height < 760 ? SIZES.compact : SIZES.regular;
}

export function PasscodePad({
  title,
  subtitle,
  error,
  busy = false,
  resetKey = 0,
  onComplete,
  extra,
  footer,
}: {
  title: string;
  subtitle?: string;
  /** Shown under the dots; a new one shakes them. */
  error?: string | null;
  /** While a code is being checked, and during a wait after wrong guesses. */
  busy?: boolean;
  /** Change it to clear the dots. */
  resetKey?: number;
  onComplete: (pin: string) => void;
  /** Bottom-left of the pad: "Face ID", for one. */
  extra?: { label: string; onPress: () => void };
  footer?: ReactNode;
}) {
  const theme = useTheme();
  const size = useSize();
  const side = { width: size.key, height: size.key };
  const [pin, setPin] = useState("");
  const [clearedFor, setClearedFor] = useState(resetKey);
  if (clearedFor !== resetKey) {
    setClearedFor(resetKey);
    setPin("");
  }

  const [shake] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (!error) return;
    shake.setValue(0);
    Animated.sequence(
      [10, -10, 7, -7, 3, 0].map((x) => Animated.timing(shake, { toValue: x, duration: 45, useNativeDriver: true })),
    ).start();
  }, [error, shake]);

  function press(digit: string) {
    if (busy || pin.length >= PASSCODE_LENGTH) return;
    const next = pin + digit;
    setPin(next);
    if (next.length === PASSCODE_LENGTH) onComplete(next);
  }

  return (
    <View style={[styles.wrap, { gap: size.gap }]}>
      {/* Room for a two-line subtitle always, so the pad does not jump between steps. */}
      <View style={{ gap: 8, alignItems: "center", justifyContent: "center", minHeight: 76 }}>
        <T variant="title" style={{ textAlign: "center" }}>
          {title}
        </T>
        {subtitle ? (
          <T variant="meta" tone="ink2" style={{ textAlign: "center" }}>
            {subtitle}
          </T>
        ) : null}
      </View>

      <View style={{ alignItems: "center", gap: 14 }}>
        <Animated.View
          style={[styles.dots, { transform: [{ translateX: shake }] }]}
          accessibilityLabel={`${pin.length} of ${PASSCODE_LENGTH} digits entered`}
        >
          {Array.from({ length: PASSCODE_LENGTH }, (_, i) => (
            <View
              key={i}
              style={[
                styles.dot,
                { borderColor: error ? theme.signal : theme.ink3 },
                i < pin.length ? { backgroundColor: error ? theme.signal : theme.ink, borderColor: "transparent" } : null,
              ]}
            />
          ))}
        </Animated.View>
        <T variant="small" tone="signal" style={{ minHeight: 18, textAlign: "center" }}>
          {error ?? ""}
        </T>
      </View>

      <View style={[styles.pad, { width: size.key * 3 + size.colGap * 2, columnGap: size.colGap, rowGap: size.rowGap }]}>
        {KEYS.map((k) => (
          <Key key={k} label={k} onPress={() => press(k)} disabled={busy} size={size} />
        ))}
        {extra ? (
          <Pressable onPress={extra.onPress} style={[styles.side, side]} accessibilityRole="button" hitSlop={8}>
            <T variant="meta" weight="semibold" tone="ink2">
              {extra.label}
            </T>
          </Pressable>
        ) : (
          <View style={side} />
        )}
        <Key label="0" onPress={() => press("0")} disabled={busy} size={size} />
        <Pressable
          onPress={() => !busy && setPin((p) => p.slice(0, -1))}
          style={[styles.side, side]}
          accessibilityRole="button"
          accessibilityLabel="Delete"
          hitSlop={8}
        >
          <Svg width={28} height={22} viewBox="0 0 28 22">
            <Path
              d="M9 2h15a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H9l-7-9 7-9Z M13 7l8 8 M21 7l-8 8"
              stroke={pin.length ? theme.ink : theme.ink3}
              strokeWidth={1.8}
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </Svg>
        </Pressable>
      </View>

      {footer ? <View style={{ alignItems: "center" }}>{footer}</View> : null}
    </View>
  );
}

function Key({ label, onPress, disabled, size }: { label: string; onPress: () => void; disabled: boolean; size: Size }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.key,
        { width: size.key, height: size.key, borderRadius: size.key / 2 },
        { backgroundColor: pressed ? theme.rule2 : theme.surface2, opacity: disabled ? 0.45 : 1 },
      ]}
    >
      <T weight="semibold" style={{ fontSize: size.font, lineHeight: size.font + 6 }}>
        {label}
      </T>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center" },
  dots: { flexDirection: "row", gap: 16 },
  dot: { width: 14, height: 14, borderRadius: 7, borderWidth: 1.5 },
  pad: { flexDirection: "row", flexWrap: "wrap" },
  key: { alignItems: "center", justifyContent: "center" },
  side: { alignItems: "center", justifyContent: "center" },
});
