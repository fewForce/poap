/**
 * Text, in the web's type scale. Plus Jakarta Sans for everything people read,
 * IBM Plex Mono only for identifiers — the event number stamped into a badge.
 */
import { Text, type TextProps } from "react-native";
import { fonts, useTheme, type Palette } from "@/lib/theme";

const VARIANTS = {
  /** "Every event so far": 800, tight, the one loud thing on a screen. */
  hero: { fontFamily: fonts.extrabold, fontSize: 34, lineHeight: 39, letterSpacing: -1.3 },
  title: { fontFamily: fonts.bold, fontSize: 20, lineHeight: 25, letterSpacing: -0.55 },
  heading: { fontFamily: fonts.bold, fontSize: 17, lineHeight: 22, letterSpacing: -0.25 },
  lede: { fontFamily: fonts.regular, fontSize: 17, lineHeight: 25 },
  body: { fontFamily: fonts.regular, fontSize: 15.5, lineHeight: 23 },
  meta: { fontFamily: fonts.regular, fontSize: 14.5, lineHeight: 20 },
  small: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 18 },
  label: { fontFamily: fonts.semibold, fontSize: 12.5, lineHeight: 16 },
  figure: { fontFamily: fonts.extrabold, fontSize: 22, lineHeight: 26, letterSpacing: -0.8 },
  mono: { fontFamily: fonts.mono, fontSize: 12, lineHeight: 16 },
} as const;

type Tone = keyof Pick<Palette, "ink" | "ink2" | "ink3" | "jade" | "signal" | "paper" | "onSignal">;

export interface TProps extends TextProps {
  variant?: keyof typeof VARIANTS;
  tone?: Tone;
  weight?: keyof typeof fonts;
}

export function T({ variant = "body", tone = "ink", weight, style, ...rest }: TProps) {
  const theme = useTheme();
  return (
    <Text
      {...rest}
      style={[VARIANTS[variant], { color: theme[tone] }, weight ? { fontFamily: fonts[weight] } : null, style]}
    />
  );
}
