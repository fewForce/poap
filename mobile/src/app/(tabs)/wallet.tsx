/**
 * The wallets on this phone: the one in use, the others to switch to, adding
 * another, and the two things a person may need to do with one — keep a copy
 * of its key, or forget it on this phone.
 */
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Pressable, View } from "react-native";
import { T } from "@/components/T";
import { useToast } from "@/components/Toast";
import { Button, Card, Screen } from "@/components/ui";
import { nearOf } from "@/lib/near";
import { useSettings } from "@/lib/settings";
import { radius, useTheme } from "@/lib/theme";
import { useWallet, useWalletState, type WalletMeta } from "@/lib/wallet";

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

export default function WalletTab() {
  const theme = useTheme();
  const wallet = useWallet();
  const { wallets, active, switchTo, remove } = useWalletState();
  const toast = useToast();
  // The NEAR account is shown only where it is used: on a server with NEAR events.
  const { server } = useSettings();
  // Asked again when the server changes: testnet may have NEAR, mainnet not.
  // The answer carries the server it is for, so a stale one is never shown.
  const [nearOn, setNearOn] = useState<string | null>(null);
  const hasNear = nearOn === server;
  useEffect(() => {
    let alive = true;
    nearOf().then(
      (n) => alive && setNearOn(n ? server : null),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [server]);

  function confirmRemove(meta: WalletMeta) {
    Alert.alert(
      `Remove ${meta.name} from this phone?`,
      "Its badges stay with its address on the ledger, but this phone forgets its key. Without your written backup, you cannot use it again.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: async () => {
            await remove(meta.id);
            toast.show(`${meta.name} removed from this phone`);
          },
        },
      ],
    );
  }

  return (
    <Screen contentStyle={{ paddingTop: 24, gap: 18 }}>
      <T variant="hero" style={{ textAlign: "center" }}>
        Wallet
      </T>

      {active ? (
        <Card style={{ gap: 10 }}>
          <T variant="label" tone="jade">
            In use
          </T>
          <T variant="title">{active.name}</T>
          <View style={{ gap: 4 }}>
            <T variant="label" tone="ink3">
              Wallet address
            </T>
            <T variant="mono" selectable style={{ fontSize: 13 }}>
              {wallet.address}
            </T>
          </View>
          {hasNear && wallet.nearAccount ? (
            <View style={{ gap: 4 }}>
              <T variant="label" tone="ink3">
                NEAR account
              </T>
              <T variant="mono" selectable style={{ fontSize: 13 }}>
                {wallet.nearAccount}
              </T>
              <T variant="small" tone="ink3">
                The same key, for events on NEAR. Your backup covers both.
              </T>
            </View>
          ) : null}
          <View style={{ gap: 10, paddingTop: 6 }}>
            <Button label="Back up this wallet" onPress={() => router.push({ pathname: "/backup", params: { id: active.id } })} />
            <Button label="Remove from this phone" kind="quiet" onPress={() => confirmRemove(active)} />
          </View>
        </Card>
      ) : null}

      {wallets.length > 1 ? (
        <View style={{ gap: 10 }}>
          <T variant="heading">Your wallets</T>
          {wallets.map((w) => {
            const on = w.id === active?.id;
            return (
              <Pressable
                key={w.id}
                onPress={async () => {
                  if (on) return;
                  await switchTo(w.id);
                  toast.show(`Now using ${w.name}`);
                }}
                accessibilityState={{ selected: on }}
              >
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 12,
                    padding: 14,
                    borderRadius: radius.tile,
                    borderWidth: on ? 2 : 1,
                    borderColor: on ? theme.jade : theme.rule,
                    backgroundColor: theme.surface,
                  }}
                >
                  <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                    <T variant="heading">{w.name}</T>
                    <T variant="mono" tone="ink3">
                      {short(w.address)}
                    </T>
                  </View>
                  <T variant="label" tone={on ? "jade" : "ink3"}>
                    {on ? "In use" : "Use"}
                  </T>
                </View>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      <Button label="Add a wallet" kind="secondary" onPress={() => router.push("/welcome")} />

      <T variant="small" tone="ink3">
        Every wallet&apos;s key exists only on this phone. Not poap.live, not anyone else has it, so keep a backup of each.
        Badges cannot be moved or sold: each one stays in the wallet it was given to.
      </T>
    </Screen>
  );
}
