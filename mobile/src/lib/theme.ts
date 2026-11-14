/**
 * The look of poap.live, as tokens. Every value here is lifted from the web's
 * own stylesheet (src/api/public/events.html in the poap repo), so the app and
 * the site read as one product: the same paper, ink, jade and signal, the same
 * Plus Jakarta Sans and IBM Plex Mono.
 */
import { useColorScheme } from "react-native";

export interface Palette {
  paper: string;
  surface: string;
  surface2: string;
  sunk: string;
  ink: string;
  ink2: string;
  ink3: string;
  rule: string;
  rule2: string;
  signal: string;
  signalWash: string;
  onSignal: string;
  jade: string;
  jadeWash: string;
  /** The QR plate stays light in dark mode: a scanner wants dark on light. */
  qrPlate: string;
  qrInk: string;
}

export const palettes: { light: Palette; dark: Palette } = {
  light: {
    paper: "#faf9f7",
    surface: "#ffffff",
    surface2: "#f4f2ef",
    sunk: "#f1efec",
    ink: "#1c1b1a",
    ink2: "#57544f",
    ink3: "#8a8681",
    rule: "#eceae6",
    rule2: "#ddd9d3",
    signal: "#b4552d",
    signalWash: "rgba(180,85,45,0.09)",
    onSignal: "#ffffff",
    jade: "#16794f",
    jadeWash: "rgba(22,121,79,0.09)",
    qrPlate: "#f7f3ea",
    qrInk: "#17140f",
  },
  dark: {
    paper: "#141413",
    surface: "#1c1c1b",
    surface2: "#232322",
    sunk: "#191918",
    ink: "#f2f0ed",
    ink2: "#b3afa8",
    ink3: "#8a8681",
    rule: "#2c2b29",
    rule2: "#3b3a37",
    signal: "#e08b5f",
    signalWash: "rgba(224,139,95,0.13)",
    onSignal: "#1c1310",
    jade: "#4fbd8b",
    jadeWash: "rgba(79,189,139,0.13)",
    qrPlate: "#f7f3ea",
    qrInk: "#17140f",
  },
};

export const fonts = {
  regular: "PlusJakartaSans_400Regular",
  medium: "PlusJakartaSans_500Medium",
  semibold: "PlusJakartaSans_600SemiBold",
  bold: "PlusJakartaSans_700Bold",
  extrabold: "PlusJakartaSans_800ExtraBold",
  mono: "IBMPlexMono_400Regular",
  monoMedium: "IBMPlexMono_500Medium",
} as const;

export const radius = { card: 16, tile: 12, button: 10, pill: 999 } as const;

/**
 * The widest a screen's content gets. Phones never reach it; on a tablet the
 * content stays a readable column in the middle instead of stretching edge
 * to edge.
 */
export const MAX_CONTENT = 640;

/** For a scroll view's content: full width up to MAX_CONTENT, centred beyond it. */
export const column = { width: "100%", maxWidth: MAX_CONTENT, alignSelf: "center" } as const;

export function useTheme(): Palette {
  return useColorScheme() === "dark" ? palettes.dark : palettes.light;
}

/** The web's --shadow: a hairline and a long soft fall. */
export function cardShadow(dark: boolean) {
  return {
    shadowColor: "#000",
    shadowOpacity: dark ? 0.45 : 0.08,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 2,
  } as const;
}
