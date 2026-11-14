/**
 * The small pieces every screen uses: the page, buttons, a text field, the
 * status chip, a notice. Each one is the web's version of the same thing —
 * see the matching class in poap.live's stylesheets.
 */
import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  useColorScheme,
  type RefreshControlProps,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets, type Edge } from "react-native-safe-area-context";
import type { EventStatus } from "@/lib/api";
import { cardShadow, column, fonts, radius, useTheme } from "@/lib/theme";
import { T } from "./T";

// ---- the page ---------------------------------------------------------------

/**
 * Padding for the phone's notch and home bar, from the insets in context
 * rather than the native SafeAreaView. The difference matters on testnet: the
 * strip at the top already clears the status bar, so the root hands screens a
 * top inset of zero, which a native SafeAreaView would not take.
 */
export function SafeArea({
  edges = ["top", "bottom"],
  style,
  children,
}: {
  edges?: Edge[];
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const pad = {
    paddingTop: edges.includes("top") ? insets.top : 0,
    paddingBottom: edges.includes("bottom") ? insets.bottom : 0,
    paddingLeft: edges.includes("left") ? insets.left : 0,
    paddingRight: edges.includes("right") ? insets.right : 0,
  };
  return <View style={[pad, style]}>{children}</View>;
}

export function Screen({
  children,
  scroll = true,
  edges = ["top"],
  refreshControl,
  contentStyle,
}: {
  children: ReactNode;
  scroll?: boolean;
  edges?: Edge[];
  refreshControl?: React.ReactElement<RefreshControlProps>;
  contentStyle?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  // The phone's own bar at the bottom (under the tabs this inset is zero).
  // Android's three buttons get a solid strip of page colour: the page stops
  // above them, so nothing ever scrolls behind the buttons. The iPhone's home
  // bar is a thin line, so there the page scrolls under it and only the end of
  // the content is kept clear of it.
  const bottom = useSafeAreaInsets().bottom;
  const android = Platform.OS === "android";
  const inner = [styles.content, column, { paddingBottom: 40 + (android ? 0 : bottom) }, contentStyle];
  return (
    <SafeArea
      edges={edges}
      style={[styles.page, { backgroundColor: theme.paper }, android ? { paddingBottom: bottom } : null]}
    >
      {scroll ? (
        <ScrollView
          contentContainerStyle={inner}
          keyboardShouldPersistTaps="handled"
          {...(refreshControl ? { refreshControl } : {})}
        >
          {children}
        </ScrollView>
      ) : (
        <View style={inner}>{children}</View>
      )}
    </SafeArea>
  );
}

/** A card: white, a hairline, sixteen-point corners, the web's soft fall. */
export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const theme = useTheme();
  const dark = useColorScheme() === "dark";
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.surface, borderColor: theme.rule },
        cardShadow(dark),
        style,
      ]}
    >
      {children}
    </View>
  );
}

// ---- buttons ------------------------------------------------------------------

export function Button({
  label,
  onPress,
  kind = "primary",
  busy = false,
  disabled = false,
  style,
}: {
  label: string;
  onPress: () => void;
  /** primary: the one thing worth pressing. secondary: everything else. */
  kind?: "primary" | "secondary" | "quiet";
  busy?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const off = disabled || busy;
  const look =
    kind === "primary"
      ? { backgroundColor: theme.ink, borderColor: "transparent" }
      : kind === "secondary"
        ? { backgroundColor: theme.surface, borderColor: theme.rule2 }
        : { backgroundColor: "transparent", borderColor: "transparent" };
  const text = kind === "primary" ? theme.paper : kind === "quiet" ? theme.ink2 : theme.ink;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: off, busy }}
      onPress={off ? undefined : onPress}
      style={({ pressed }) => [styles.button, look, { opacity: off ? 0.5 : pressed ? 0.85 : 1 }, style]}
    >
      {busy ? (
        <ActivityIndicator color={text} />
      ) : (
        <T variant="body" weight="semibold" style={{ color: text }}>
          {label}
        </T>
      )}
    </Pressable>
  );
}

// ---- a text field --------------------------------------------------------------

export function Field({ label, ...input }: TextInputProps & { label: string }) {
  const theme = useTheme();
  return (
    <View style={{ gap: 7 }}>
      <T variant="label" tone="ink2">
        {label}
      </T>
      <TextInput
        placeholderTextColor={theme.ink3}
        {...input}
        style={[
          styles.field,
          { color: theme.ink, backgroundColor: theme.surface, borderColor: theme.rule2 },
          input.style,
        ]}
      />
    </View>
  );
}

// ---- the status chip -----------------------------------------------------------

const CHIP_WORDS: Record<EventStatus, string> = {
  live: "Happening now",
  open: "Open",
  closed: "Finished",
  draft: "Not started",
};

export function Chip({ status }: { status: EventStatus }) {
  const theme = useTheme();
  const look =
    status === "live"
      ? { bg: theme.signalWash, fg: theme.signal }
      : status === "open"
        ? { bg: theme.jadeWash, fg: theme.jade }
        : { bg: theme.surface2, fg: theme.ink2 };
  return (
    <View style={[styles.chip, { backgroundColor: look.bg }]}>
      <T variant="label" style={{ color: look.fg }}>
        {CHIP_WORDS[status]}
      </T>
    </View>
  );
}

// ---- a notice ------------------------------------------------------------------

export function Notice({ tone = "warn", children }: { tone?: "warn" | "ok" | "bad"; children: ReactNode }) {
  const theme = useTheme();
  const accent = tone === "ok" ? theme.jade : tone === "bad" ? theme.signal : theme.ink3;
  const bg = tone === "ok" ? theme.jadeWash : tone === "bad" ? theme.signalWash : theme.surface2;
  return (
    <View style={[styles.notice, { backgroundColor: bg, borderLeftColor: accent }]}>
      {typeof children === "string" ? (
        <T variant="meta" tone="ink">
          {children}
        </T>
      ) : (
        children
      )}
    </View>
  );
}

/** The turnout bar: a track and a jade fill. */
export function Bar({ percent }: { percent: number }) {
  const theme = useTheme();
  return (
    <View style={[styles.bar, { backgroundColor: theme.surface2 }]}>
      <View style={{ width: `${Math.max(0, Math.min(100, percent))}%`, height: "100%", backgroundColor: theme.jade, borderRadius: radius.pill }} />
    </View>
  );
}

/** A choice of two or three, side by side: Appearance, Network. */
export function Segmented<V extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: V; label: string }[];
  value: V;
  onChange: (value: V) => void;
}) {
  const theme = useTheme();
  return (
    <View accessibilityRole="radiogroup" style={[styles.segments, { backgroundColor: theme.surface2 }]}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            onPress={() => !on && onChange(o.value)}
            style={[styles.segment, on ? { backgroundColor: theme.surface, borderColor: theme.rule2 } : null]}
          >
            <T variant="meta" weight={on ? "semibold" : "medium"} tone={on ? "ink" : "ink2"}>
              {o.label}
            </T>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Centered({ children }: { children: ReactNode }) {
  return <View style={styles.centered}>{children}</View>;
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  content: { paddingHorizontal: 18, paddingBottom: 40, gap: 14 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.card, padding: 16 },
  segments: { flexDirection: "row", borderRadius: radius.button + 2, padding: 3, gap: 3 },
  segment: {
    flex: 1,
    minHeight: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.button,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "transparent",
  },
  button: {
    minHeight: 50,
    borderRadius: radius.button,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
  },
  field: {
    minHeight: 52,
    borderWidth: 1,
    borderRadius: radius.button,
    paddingHorizontal: 14,
    fontFamily: fonts.medium,
    fontSize: 17,
  },
  chip: { alignSelf: "flex-start", borderRadius: radius.pill, paddingHorizontal: 11, paddingVertical: 4 },
  notice: { borderRadius: 12, borderLeftWidth: 4, padding: 13 },
  bar: { height: 5, borderRadius: radius.pill, overflow: "hidden" },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 14 },
});
