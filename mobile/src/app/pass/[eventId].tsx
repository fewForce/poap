/**
 * The pass: what the desk scans, and where the badge arrives.
 *
 * The code carries this phone's wallet address and nothing else, exactly like
 * the website's pass, so the desk cannot tell the two apart. Nobody needs to
 * have signed up: the desk issues to any address it scans.
 *
 * WHILE IT IS ON SCREEN it watches the wallet on the ledger. Issuing tops an
 * empty wallet up first, so a wallet that changes is the sign to ask poap.live
 * for the offer — asking is limited to five a minute per network, and a room
 * on one Wi-Fi shares that, so it is not asked on every tick. A wallet that
 * already had enough shows no change; for that, poap.live is asked once a
 * minute anyway, and "Check for my badge" asks now.
 *
 * Then the phone accepts the offer itself (src/lib/collect.ts) and the code
 * turns into the badge. Nobody presses anything.
 *
 * A NEAR EVENT is simpler. The code carries the wallet's NEAR account (the
 * same key), the desk mints straight into it, and there is nothing to accept:
 * the pass asks poap.live every few seconds whether the badge is recorded,
 * which is one index read, and turns into the badge when it is.
 */
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, AppState, Image, StyleSheet, useWindowDimensions, View } from "react-native";
import { QrCode } from "@/components/QrCode";
import { StatePanel } from "@/components/StatePanel";
import { T } from "@/components/T";
import { Button, Card, Notice, Screen } from "@/components/ui";
import { api, isNearEvent, type EventSummary } from "@/lib/api";
import { collect, CollectError, report } from "@/lib/collect";
import { longDate, stamp } from "@/lib/format";
import { absolute, ApiError } from "@/lib/http";
import { account, findAccept, heldTokens, LedgerError } from "@/lib/ledger";
import { radius, useTheme } from "@/lib/theme";
import { loadRegistrations } from "@/lib/registrations";
import { isRecorded, markRecorded, useWallet } from "@/lib/wallet";

/** How often the wallet is looked at while the pass is on screen. */
const WATCH_MS = 5_000;
/** The least time between two offer reads. poap.live allows five a minute per IP. */
const OFFER_GAP_MS = 13_000;
/** After the wallet changes, keep asking at that pace for this long: the offer follows the top-up. */
const HOT_MS = 60_000;
/** With no sign from the ledger, ask anyway this often. */
const IDLE_MS = 60_000;
/** NEAR: how often the attendance record is asked about. One index read, no chain call. */
const NEAR_WATCH_MS = 4_000;

type Phase = "loading" | "waiting" | "collecting" | "collected";

export default function PassScreen() {
  const theme = useTheme();
  const wallet = useWallet();
  const { width } = useWindowDimensions();
  const params = useLocalSearchParams<{ eventId: string }>();
  const eventId = Number(params.eventId);
  const validId = Number.isInteger(eventId) && eventId >= 0;

  const [event, setEvent] = useState<EventSummary | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [collectedAt, setCollectedAt] = useState<string | undefined>();
  const [problem, setProblem] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [refused, setRefused] = useState(false);
  /** The name on this phone's registration for the event, if there is one. */
  const [registeredAs, setRegisteredAs] = useState<string | null>(null);
  /** Known once the event has loaded: a NEAR event shows the NEAR account. */
  const [onNear, setOnNear] = useState(false);

  const busy = useRef(false);
  /** Set when an offer was refused: asking again would only be refused again. */
  const stopped = useRef(false);
  const done = useRef(false);
  const lastAsked = useRef(0);
  const hotUntil = useRef(0);
  const lastSeen = useRef<string | null>(null);

  const finish = useCallback((at: string | undefined) => {
    done.current = true;
    setCollectedAt(at);
    setPhase("collected");
  }, []);

  /** Already holding this event's badge? Then make sure poap.live has it on record. */
  const checkHeld = useCallback(async (): Promise<boolean> => {
    const held = (await heldTokens(wallet.address)).find((t) => t.taxon === eventId);
    if (!held) return false;
    const accept = await findAccept(wallet.address, { nftokenId: held.nftokenId }).catch(() => null);
    if (accept && !(await isRecorded(wallet.address, eventId))) {
      // The app was closed between accepting and telling poap.live. Finish it.
      await report(eventId, accept.offerId, wallet.address, accept.hash)
        .then(() => markRecorded(wallet.address, eventId))
        .catch(() => undefined);
    }
    finish(accept?.at);
    return true;
  }, [wallet.address, eventId, finish]);

  /** Ask poap.live for an offer, and take it if there is one. */
  const tryCollect = useCallback(async () => {
    if (busy.current || stopped.current || done.current) return;
    if (Date.now() - lastAsked.current < OFFER_GAP_MS) return;
    busy.current = true;
    lastAsked.current = Date.now();
    try {
      const offered = await api.offerFor(eventId, wallet.address);
      if (!offered) return;
      setPhase("collecting");
      setProblem(null);
      await collect(wallet, eventId, offered);
      await markRecorded(wallet.address, eventId);
      const accept = await findAccept(wallet.address, { offerId: offered.offerId }).catch(() => null);
      finish(accept?.at ?? new Date().toISOString());
    } catch (err) {
      setPhase("waiting");
      if (err instanceof CollectError && err.kind === "refused") {
        stopped.current = true;
        setRefused(true);
        setProblem(`${err.message} Ask at the desk.`);
      } else if (err instanceof CollectError) {
        // Gone with nothing of ours behind it: cancelled. The desk can issue again.
      } else if (err instanceof ApiError && err.status === 429) {
        lastAsked.current = Date.now() + 30_000; // the room is asking a lot; back off
      } else if (err instanceof LedgerError || (err instanceof ApiError && err.offline)) {
        setProblem("The connection is slow right now. Your badge is safe; trying again.");
      } else {
        setProblem(err instanceof Error ? err.message : "Your badge did not arrive yet. Trying again.");
      }
    } finally {
      busy.current = false;
    }
  }, [wallet, eventId, finish]);

  useFocusEffect(
    useCallback(() => {
      if (!validId) return undefined;
      let alive = true;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const tick = async () => {
        if (!alive || done.current) return;
        if (AppState.currentState === "active" && !stopped.current) {
          try {
            const a = await account(wallet.address);
            const seen = `${a.exists}:${a.balanceDrops}:${a.sequence}`;
            const first = lastSeen.current === null;
            if (!first && seen !== lastSeen.current) hotUntil.current = Date.now() + HOT_MS;
            lastSeen.current = seen;
            setOffline(false);
            const now = Date.now();
            if (first || now < hotUntil.current || now - lastAsked.current >= IDLE_MS) await tryCollect();
          } catch {
            setOffline(true);
          }
        }
        if (alive && !done.current) timer = setTimeout(tick, WATCH_MS);
      };

      /** NEAR: the desk mints straight into the account; watch for the record. */
      const nearTick = async () => {
        if (!alive || done.current) return;
        if (AppState.currentState === "active") {
          try {
            const rec = await api.attendance(eventId, wallet.nearAccount);
            setOffline(false);
            if (rec) {
              finish(rec.claimedAt ?? undefined);
              return;
            }
          } catch (err) {
            if (err instanceof ApiError && err.offline) setOffline(true);
          }
        }
        if (alive && !done.current) timer = setTimeout(nearTick, NEAR_WATCH_MS);
      };

      (async () => {
        loadRegistrations(wallet.address).then((all) => alive && setRegisteredAs(all[String(eventId)]?.displayName ?? null));
        // The chain decides what the code holds, so the event comes first. An
        // event that cannot be read (offline, an older server) is an XRPL one,
        // as every event was before NEAR.
        const e = await api.event(eventId).catch(() => null);
        if (!alive) return;
        if (e) setEvent(e);
        if (isNearEvent(e)) {
          setOnNear(true);
          if (!wallet.nearAccount) {
            stopped.current = true;
            setRefused(true);
            setProblem("This wallet's key cannot be a NEAR account, so it cannot hold this event's badge. Make a new wallet in the app for NEAR events.");
            setPhase("waiting");
            return;
          }
          setPhase("waiting");
          void nearTick();
          return;
        }
        try {
          if (await checkHeld()) return;
        } catch {
          setOffline(true);
        }
        if (!alive) return;
        setPhase((p) => (p === "loading" ? "waiting" : p));
        void tick();
      })();

      return () => {
        alive = false;
        if (timer) clearTimeout(timer);
      };
    }, [validId, eventId, wallet.address, wallet.nearAccount, checkHeld, tryCollect, finish]),
  );

  if (!validId) {
    return (
      <Screen edges={[]} contentStyle={{ paddingTop: 12 }}>
        <StatePanel title="No such pass" body="That link does not point at an event." action={{ label: "Back", onPress: () => router.back() }} />
      </Screen>
    );
  }
  if (phase === "loading") {
    return (
      <Screen edges={[]} contentStyle={{ paddingTop: 12 }}>
        <StatePanel title="Opening your pass" body="One moment." />
      </Screen>
    );
  }

  const title = event?.name ?? `Event ${eventId}`;
  const when = [longDate(event?.eventDate), event?.venue].filter(Boolean).join(" · ");

  // ---- collected: the code has done its job --------------------------------
  if (phase === "collected") {
    const art = Math.min(width - 36 - 32, 320);
    return (
      <Screen edges={[]} contentStyle={{ paddingTop: 8, gap: 16 }}>
        <Card style={{ alignItems: "center", gap: 14, paddingVertical: 24 }}>
          <Image
            source={{ uri: absolute(api.badgeArt(eventId, onNear ? wallet.nearAccount : wallet.address)) }}
            style={{ width: art, height: art, borderRadius: radius.card, backgroundColor: theme.surface2 }}
            accessibilityLabel={`Your badge for ${title}`}
          />
          <View style={{ alignItems: "center", gap: 4 }}>
            <T variant="title" style={{ textAlign: "center" }}>
              The badge is yours
            </T>
            <T variant="meta" tone="ink2" style={{ textAlign: "center" }}>
              {title}
            </T>
            {collectedAt ? (
              <T variant="small" tone="jade" weight="semibold">
                Collected {stamp(collectedAt)}
              </T>
            ) : null}
            {onNear ? (
              <T variant="small" tone="ink3" style={{ textAlign: "center" }}>
                In your NEAR account
              </T>
            ) : null}
          </View>
        </Card>
        <Button label="See all your badges" kind="secondary" onPress={() => router.navigate("/badges")} />
      </Screen>
    );
  }

  // ---- the pass itself -----------------------------------------------------------
  const qr = Math.min(width - 36 - 32 - 18, 300);
  const arriving = phase === "collecting";

  return (
    <Screen edges={[]} contentStyle={{ paddingTop: 8, gap: 14 }}>
      <Card style={{ alignItems: "center", gap: 16, paddingVertical: 22 }}>
        <View style={{ alignItems: "center", gap: 3 }}>
          <T variant="title" style={{ textAlign: "center" }}>
            {title}
          </T>
          {when ? (
            <T variant="meta" tone="ink2" style={{ textAlign: "center" }}>
              {when}
            </T>
          ) : null}
        </View>

        {onNear && !wallet.nearAccount ? null : (
          <View style={{ padding: 9 }}>
            <QrCode value={onNear ? wallet.nearAccount : wallet.address} size={qr} live={!arriving} />
          </View>
        )}

        {registeredAs ? <T variant="heading">{registeredAs}</T> : null}

        {arriving ? (
          <View style={styles.arriving}>
            <ActivityIndicator size="small" color={theme.jade} />
            <T variant="meta" tone="jade" weight="semibold">
              Your badge is on its way
            </T>
          </View>
        ) : (
          <T variant="meta" tone="ink2" style={{ textAlign: "center" }}>
            {onNear
              ? "Show this at the desk. Your badge arrives in your NEAR account, with nothing to accept."
              : "Show this at the desk. Your badge arrives here."}
          </T>
        )}
      </Card>

      {problem ? <Notice tone="bad">{problem}</Notice> : null}
      {offline ? <Notice>You are offline. The desk can still scan your pass; the badge arrives once you are back online.</Notice> : null}
      {!arriving && !refused && !onNear ? (
        <Button
          label="Check for my badge"
          kind="quiet"
          onPress={() => {
            hotUntil.current = Date.now() + HOT_MS;
            void tryCollect();
          }}
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  arriving: { flexDirection: "row", alignItems: "center", gap: 8 },
});
