/**
 * A toast: one short line that drops in at the top, says what just happened,
 * and goes away by itself after a couple of seconds (or when tapped). For
 * confirmations — "Saved", "Passcode changed" — not for anything a person has
 * to act on, which stays on the screen it belongs to.
 *
 *   const toast = useToast();
 *   toast.show("Saved");
 *   toast.show("That email does not look right.", "bad");
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { AccessibilityInfo, Animated, Pressable, StyleSheet, useColorScheme, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Circle, Path } from "react-native-svg";
import { useSettings } from "@/lib/settings";
import { cardShadow, palettes, useTheme } from "@/lib/theme";
import { T } from "./T";

type Tone = "ok" | "bad";

interface ToastValue {
  show(text: string, tone?: Tone): void;
}

const ToastContext = createContext<ToastValue | null>(null);

const SHOWN_MS = 2600;
/** The testnet strip's height below the status bar, which a toast must clear. */
const STRIP = 26;

export function ToastProvider({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const dark = useColorScheme() === "dark";
  const insets = useSafeAreaInsets();
  const { server } = useSettings();
  const [toast, setToast] = useState<{ id: number; text: string; tone: Tone } | null>(null);
  const [anim] = useState(() => new Animated.Value(0));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    Animated.timing(anim, { toValue: 0, duration: 180, useNativeDriver: true }).start(({ finished }) => {
      if (finished) setToast(null);
    });
  }, [anim]);

  const show = useCallback(
    (text: string, tone: Tone = "ok") => {
      if (timer.current) clearTimeout(timer.current);
      setToast({ id: Date.now(), text, tone });
      anim.setValue(0);
      Animated.spring(anim, { toValue: 1, speed: 16, bounciness: 5, useNativeDriver: true }).start();
      timer.current = setTimeout(hide, SHOWN_MS);
      AccessibilityInfo.announceForAccessibility(text);
    },
    [anim, hide],
  );

  const value = useMemo<ToastValue>(() => ({ show }), [show]);

  // Inverted: dark on a light screen, light on a dark one, with the accent
  // taken from the opposite palette so it reads against the toast itself.
  const opposite = dark ? palettes.light : palettes.dark;
  const accent = toast?.tone === "bad" ? opposite.signal : opposite.jade;

  return (
    <ToastContext.Provider value={value}>
      {children}
      {toast ? (
        <View
          pointerEvents="box-none"
          style={[styles.layer, { top: insets.top + (server === "testnet" ? STRIP : 0) + 8 }]}
        >
          <Animated.View
            key={toast.id}
            style={{
              opacity: anim,
              transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [-16, 0] }) }],
            }}
          >
            <Pressable
              onPress={hide}
              accessibilityRole="alert"
              style={[styles.toast, { backgroundColor: theme.ink }, cardShadow(dark)]}
            >
              <Svg width={20} height={20} viewBox="0 0 20 20">
                <Circle cx={10} cy={10} r={10} fill={accent} />
                {toast.tone === "bad" ? (
                  <Path d="M10 5.5v5.5 M10 14.2v.3" stroke={theme.ink} strokeWidth={2} strokeLinecap="round" />
                ) : (
                  <Path
                    d="M6 10.4l2.6 2.6L14.2 7.4"
                    stroke={theme.ink}
                    strokeWidth={2}
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                )}
              </Svg>
              <T variant="meta" weight="semibold" tone="paper" style={{ flexShrink: 1 }}>
                {toast.text}
              </T>
            </Pressable>
          </Animated.View>
        </View>
      ) : null}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastValue {
  const value = useContext(ToastContext);
  if (!value) throw new Error("useToast outside <ToastProvider>");
  return value;
}

const styles = StyleSheet.create({
  layer: { position: "absolute", left: 18, right: 18, alignItems: "center" },
  toast: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 12,
    paddingLeft: 14,
    paddingRight: 18,
    borderRadius: 999,
  },
});
