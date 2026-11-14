import { Redirect } from "expo-router";
import { TopTabs } from "expo-router/js-top-tabs";
import { StyleSheet } from "react-native";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { TabIcon } from "@/components/TabIcon";
import { fonts, useTheme } from "@/lib/theme";
import { useWalletState } from "@/lib/wallet";

/**
 * Four tabs: what is on, what you have, the wallet that holds it, and the
 * app's settings. With no wallet on the phone yet, the welcome screen comes
 * first.
 *
 * Swipeable: the pager's tabs with their bar at the bottom, so a sideways swipe
 * anywhere on a screen, or on the bar, moves to the next tab. The line over the
 * bar follows the finger.
 */
export default function TabsLayout() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { wallet } = useWalletState();
  if (!wallet) return <Redirect href="/welcome" />;
  return (
    // The tab bar pads itself above the phone's own bar, so the screens above
    // it are told there is nothing at the bottom to clear.
    <SafeAreaInsetsContext.Provider value={{ ...insets, bottom: 0 }}>
      <TopTabs
        tabBarPosition="bottom"
        screenOptions={{
          tabBarActiveTintColor: theme.ink,
          tabBarInactiveTintColor: theme.ink3,
          tabBarShowIcon: true,
          tabBarPressColor: "transparent",
          tabBarStyle: {
            backgroundColor: theme.paper,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: theme.rule,
            paddingBottom: insets.bottom,
            elevation: 0,
            shadowOpacity: 0,
          },
          tabBarItemStyle: { paddingTop: 8, paddingBottom: 4, minHeight: 0 },
          tabBarLabelStyle: { fontFamily: fonts.semibold, fontSize: 11.5, textTransform: "none", margin: 0 },
          tabBarIndicatorStyle: { top: 0, height: 2, backgroundColor: theme.ink },
          sceneStyle: { backgroundColor: theme.paper },
        }}
      >
        <TopTabs.Screen
          name="index"
          options={{ title: "Events", tabBarIcon: ({ color }: { color: string }) => <TabIcon name="events" color={color} /> }}
        />
        <TopTabs.Screen
          name="badges"
          options={{ title: "Badges", tabBarIcon: ({ color }: { color: string }) => <TabIcon name="badges" color={color} /> }}
        />
        <TopTabs.Screen
          name="wallet"
          options={{ title: "Wallet", tabBarIcon: ({ color }: { color: string }) => <TabIcon name="wallet" color={color} /> }}
        />
        <TopTabs.Screen
          name="settings"
          options={{ title: "Settings", tabBarIcon: ({ color }: { color: string }) => <TabIcon name="settings" color={color} /> }}
        />
      </TopTabs>
    </SafeAreaInsetsContext.Provider>
  );
}
