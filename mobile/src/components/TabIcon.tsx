/**
 * The tab icons, drawn rather than imported: three strokes do not need
 * an icon font.
 */
import type { ColorValue } from "react-native";
import Svg, { Circle, Path, Rect } from "react-native-svg";

export function TabIcon({ name, color, size = 24 }: { name: "events" | "badges" | "wallet" | "settings"; color: ColorValue; size?: number }) {
  const stroke = { stroke: color, strokeWidth: 1.8, fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {name === "events" ? (
        <>
          <Rect x={3.5} y={5} width={17} height={15.5} rx={3} {...stroke} />
          <Path d="M3.5 10h17M8 3v4M16 3v4" {...stroke} />
        </>
      ) : name === "badges" ? (
        <>
          <Circle cx={12} cy={9.5} r={5.5} {...stroke} />
          <Path d="M8.5 13.8 7 21l5-2.6L17 21l-1.5-7.2" {...stroke} />
        </>
      ) : name === "settings" ? (
        <>
          <Path d="M4 7h8.5M17.5 7H20M4 17h2.5M11.5 17H20" {...stroke} />
          <Circle cx={15} cy={7} r={2.5} {...stroke} />
          <Circle cx={9} cy={17} r={2.5} {...stroke} />
        </>
      ) : (
        <>
          <Rect x={3} y={6} width={18} height={14} rx={3} {...stroke} />
          <Path d="M3 10h13.5M16 14.5h2M6.5 6 15 3.5l1.5 2.5" {...stroke} />
        </>
      )}
    </Svg>
  );
}
