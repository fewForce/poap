/**
 * The first screen, before there is a wallet — and the way to add another one
 * later, from the Wallet tab.
 */
import { router } from "expo-router";
import { StyleSheet, View } from "react-native";
import { PoweredBy } from "@/components/PoweredBy";
import { T } from "@/components/T";
import { Button, SafeArea } from "@/components/ui";
import { useLock } from "@/lib/lock";
import { column, useTheme } from "@/lib/theme";
import { useWalletState } from "@/lib/wallet";

export default function Welcome() {
  const theme = useTheme();
  const { wallets } = useWalletState();
  const adding = wallets.length > 0;
  // A wallet app opens behind a passcode, so the first wallet waits for one.
  const { status } = useLock();
  const go = (next: "create" | "import") =>
    status === "none"
      ? router.push({ pathname: "/welcome/passcode", params: { next } })
      : router.push(`/welcome/${next}`);

  return (
    <SafeArea style={{ flex: 1, backgroundColor: theme.paper }}>
      <View style={styles.body}>
        <View style={{ gap: 12 }}>
          <T variant="hero" style={{ textAlign: "center" }}>
            {adding ? "Add a wallet" : "Your POAP wallet"}
          </T>
          <PoweredBy />
          <T variant="lede" tone="ink2" style={{ textAlign: "center", marginTop: 8 }}>
            {adding
              ? "Make a new one, or bring in one you already have."
              : "A badge for every event you go to, kept in a wallet that lives on this phone."}
          </T>
        </View>

        <View style={{ gap: 14 }}>
          <Button label="Create a new wallet" onPress={() => go("create")} style={styles.big} />
          <Button
            label="I already have a wallet"
            kind="secondary"
            onPress={() => go("import")}
            style={styles.big}
          />
          {adding ? <Button label="Cancel" kind="quiet" onPress={() => router.back()} /> : null}
        </View>
      </View>
    </SafeArea>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, justifyContent: "center", paddingHorizontal: 22, gap: 36, ...column },
  big: { minHeight: 60 },
});
