/**
 * The root: fonts, the settings, the passcode lock, the wallets on this phone,
 * and one stack over everything — always behind the lock once a passcode
 * exists, and under a strip that says so whenever the app is on testnet.
 *
 * There is no sign-in. The first launch opens on the welcome screen — make a
 * wallet, or bring one in — and after that on the events. The splash screen
 * stays up until the fonts, the settings, the lock and the wallets have been read,
 * and for at least a second, so it is seen rather than flashed.
 */
import { IBMPlexMono_400Regular, IBMPlexMono_500Medium } from "@expo-google-fonts/ibm-plex-mono";
import {
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
  PlusJakartaSans_800ExtraBold,
} from "@expo-google-fonts/plus-jakarta-sans";
import { useFonts } from "expo-font";
import { NavigationBar } from "expo-navigation-bar";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { useColorScheme, View } from "react-native";
import { SafeAreaInsetsContext, SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { AppLock } from "@/components/AppLock";
import { StatePanel } from "@/components/StatePanel";
import { T } from "@/components/T";
import { ToastProvider } from "@/components/Toast";
import { Screen } from "@/components/ui";
import { LockProvider, useLock } from "@/lib/lock";
import { SettingsProvider, useSettings } from "@/lib/settings";
import { fonts, useTheme } from "@/lib/theme";
import { WalletProvider, useWalletState } from "@/lib/wallet";

void SplashScreen.preventAutoHideAsync();

/** The splash stays up at least this long after the app's code starts, however quickly it is ready. */
const MIN_SPLASH_MS = 1000;
const startedAt = Date.now();

/** Over everything while the app is on testnet, so a test badge is never taken for a real one. */
function TestnetStrip() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ paddingTop: insets.top, backgroundColor: theme.signal }}>
      <T variant="label" style={{ color: theme.onSignal, textAlign: "center", paddingVertical: 5 }}>
        Testnet: badges here are for testing only
      </T>
    </View>
  );
}

function Root() {
  const { status: walletStatus, retry } = useWalletState();
  const { status: lockStatus } = useLock();
  const status = lockStatus === "loading" ? "loading" : walletStatus;
  const { server } = useSettings();
  const testnet = server === "testnet";
  const dark = useColorScheme() === "dark";
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  useEffect(() => {
    if (status === "loading") return;
    const timer = setTimeout(() => SplashScreen.hide(), Math.max(0, MIN_SPLASH_MS - (Date.now() - startedAt)));
    return () => clearTimeout(timer);
  }, [status]);

  if (status === "loading") return null;
  if (status === "failed") {
    return (
      <Screen contentStyle={{ paddingTop: 80 }}>
        <StatePanel
          title="Your wallet did not open"
          body="This phone's secure storage did not answer. Unlock the phone and try again."
          action={{ label: "Try again", onPress: retry }}
        />
      </Screen>
    );
  }

  return (
    <AppLock>
      {/* The strip is dark orange on light, light orange on dark: the clock follows. */}
      <StatusBar style={testnet ? (dark ? "dark" : "light") : "auto"} />
      {/* Android's button bar is see-through; its buttons dark on light, light on dark.
          The style names the buttons' colour, as StatusBar's does (whatever its docs say). */}
      <NavigationBar style={dark ? "light" : "dark"} />
      {testnet ? <TestnetStrip /> : null}
      {/* Under the strip, screens start below the status bar already. */}
      <SafeAreaInsetsContext.Provider value={testnet ? { ...insets, top: 0 } : insets}>
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: theme.paper },
            headerShadowVisible: false,
            headerTintColor: theme.ink,
            headerTitleStyle: { fontFamily: fonts.semibold },
            headerBackButtonDisplayMode: "minimal",
            contentStyle: { backgroundColor: theme.paper },
          }}
        >
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="event/[eventId]" options={{ title: "" }} />
          <Stack.Screen name="pass/[eventId]" options={{ title: "Your pass" }} />
          <Stack.Screen name="badge/[nftokenId]" options={{ title: "Badge" }} />
          <Stack.Screen name="register/[eventId]" options={{ title: "Register", presentation: "modal" }} />
          <Stack.Screen name="backup" options={{ title: "Back up", presentation: "modal" }} />
          <Stack.Screen name="welcome/index" options={{ headerShown: false }} />
          <Stack.Screen name="welcome/create" options={{ title: "New wallet" }} />
          <Stack.Screen name="welcome/import" options={{ title: "Add a wallet" }} />
          <Stack.Screen name="welcome/passcode" options={{ title: "Passcode" }} />
          <Stack.Screen name="passcode/change" options={{ title: "Change passcode", presentation: "modal" }} />
        </Stack>
      </SafeAreaInsetsContext.Provider>
    </AppLock>
  );
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    PlusJakartaSans_400Regular,
    PlusJakartaSans_500Medium,
    PlusJakartaSans_600SemiBold,
    PlusJakartaSans_700Bold,
    PlusJakartaSans_800ExtraBold,
    IBMPlexMono_400Regular,
    IBMPlexMono_500Medium,
  });
  if (!fontsLoaded) return null;
  return (
    <SafeAreaProvider>
      <SettingsProvider>
        <ToastProvider>
          <LockProvider>
            <WalletProvider>
              <Root />
            </WalletProvider>
          </LockProvider>
        </ToastProvider>
      </SettingsProvider>
    </SafeAreaProvider>
  );
}
