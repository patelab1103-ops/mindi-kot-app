// app/game.tsx
import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, ImageBackground, TouchableOpacity, StyleSheet, FlatList, Alert, SafeAreaView, Dimensions } from 'react-native';
import { router } from 'expo-router';
import { auth, db } from '../src/firebase';
import { useRoom, Player } from '../src/store/roomStore';
import {
  collection, doc, getDoc, onSnapshot, runTransaction, serverTimestamp, setDoc, updateDoc
} from 'firebase/firestore';
import {
  Card, Suit, cardSuit, legalPlays as legalPlaysFn, evaluateTrickWinner,
  Play, buildDecksNoTwos, shuffle, cardsPerPlayer
} from '../src/logic/deck';
import {
  computeHiderAndLeader, planDeal, startTrick, legalToPlay, canRevealTrump,
  resolveTrick, applyRevealOnHand
} from '../src/logic/mindi';

const TABLE_BG = { uri: 'https://images.unsplash.com/photo-1518131678677-a09d92e87c3c?q=80&w=1400&auto=format&fit=crop' };

type RoomState = {
  mode?: string;
  deckCount?: 1|2;
  seats?: string[];                 // uids by seat index
  teamMap?: string[];               // seat -> team
  hostUid?: string;

  handNumber?: number;
  hiderSeat?: number;
  leaderSeat?: number;
  trumpSuit?: Suit;
  trumpRevealed?: boolean;
  trumpRevealedBySeat?: number | null;

  currentTurnSeat?: number;
  ledSuit?: Suit | null;
  plays?: Play[];
  trickIndex?: number;

  tensByTeam?: Record<string, number>;
  scrapHandsByTeam?: Record<string, number>;
  matchScoreByTeam?: Record<string, number>;

  seed?: string;
};

type MyHandDoc = {
  visible: Card[];
  hidden?: Card | null;
};

export default function Game() {
  const { roomId, players, uid } = useRoom();
  const [state, setState] = useState<RoomState | null>(null);
  const [myHand, setMyHand] = useState<MyHandDoc | null>(null);

  // Subscribe room state
  useEffect(() => {
    if (!roomId) return;
    const unsub = onSnapshot(doc(db, 'rooms', roomId), (snap) => {
      setState((snap.data() as any) || null);
    });
    return () => unsub();
  }, [roomId]);

  // Subscribe my hand
  useEffect(() => {
    if (!roomId || !uid) return;
    const unsub = onSnapshot(doc(db, `rooms/${roomId}/hands/${uid}`), (snap) => {
      setMyHand((snap.data() as any) || null);
    });
    return () => unsub();
  }, [roomId, uid]);

  const seatsOrderedByPlayers = useMemo(() =>
    players.slice().sort((a,b)=>a.seat-b.seat).map(p=>p.uid), [players]);

  const teamMapByPlayers = useMemo(() =>
    players.slice().sort((a,b)=>a.seat-b.seat).map(p=>p.team), [players]);

  const hostUidByPlayers = useMemo(() =>
    (players.find(p=>p.isHost)?.uid) || seatsOrderedByPlayers[0], [players, seatsOrderedByPlayers]);

  const meSeat = useMemo(() => {
    if (!state?.seats || !uid) return -1;
    return state.seats.indexOf(uid);
  }, [state?.seats, uid]);

  const amHost = useMemo(() => {
    const me = auth.currentUser?.uid;
    return !!me && (me === state?.hostUid || (!state?.hostUid && me === hostUidByPlayers));
  }, [state?.hostUid, hostUidByPlayers]);

  const isInitialized = useMemo(() => {
    return !!(state?.seats && state?.teamMap && state?.hostUid && state?.deckCount && state?.mode);
  }, [state]);

  // ---------- INITIALIZE TABLE (host only) ----------
  async function initializeTable() {
    if (!roomId) return;
    if (!amHost) { Alert.alert('Only host can initialize'); return; }

    await updateDoc(doc(db,'rooms',roomId), {
      seats: seatsOrderedByPlayers,
      teamMap: teamMapByPlayers,
      hostUid: hostUidByPlayers,
      handNumber: state?.handNumber ?? 0,
      tensByTeam: buildZeroCounts(teamMapByPlayers),
      scrapHandsByTeam: buildZeroCounts(teamMapByPlayers),
      matchScoreByTeam: buildZeroCounts(teamMapByPlayers),
      // mode & deckCount should already be set in /setup; if not, default them:
      mode: state?.mode ?? '2v2',
      deckCount: state?.deckCount ?? 1,
    } as Partial<RoomState>);
  }

  // Try to auto-init if host lands here and required fields missing
  useEffect(() => {
    if (!roomId) return;
    if (amHost && !isInitialized && seatsOrderedByPlayers.length > 0) {
      initializeTable().catch(()=>{});
    }
  }, [amHost, isInitialized, roomId, seatsOrderedByPlayers.length]);

  // ---------- HOST: START/DEAL HAND ----------
  async function hostStartHand() {
    if (!roomId || !state) return;
    if (!amHost) { Alert.alert('Only host can deal'); return; }
    if (!isInitialized) { Alert.alert('Initialize the table first'); return; }

    const playersCount = state.seats!.length;
    await runTransaction(db, async (tx) => {
      const roomRef = doc(db, 'rooms', roomId);
      const roomSnap = await tx.get(roomRef);
      const room = roomSnap.data() as RoomState;

      const prevHider = room?.hiderSeat ?? null;
      const { hider, leader } = computeHiderAndLeader(prevHider, playersCount, true);
      const seed = String(Date.now());
      const plan = planDeal(playersCount, room.deckCount as 1|2, hider, leader, seed);

      // private hands
      for (let s = 0; s < playersCount; s++) {
        const u = room.seats![s];
        const handRef = doc(db, `rooms/${roomId}/hands/${u}`);
        tx.set(handRef, {
          visible: plan.hands[s].visible,
          hidden: plan.hands[s].hidden ?? null,
          updatedAt: serverTimestamp(),
        } as MyHandDoc);
      }

      tx.update(roomRef, {
        handNumber: (room.handNumber ?? 0) + 1,
        hiderSeat: hider,
        leaderSeat: leader,
        trumpSuit: plan.trumpSuit,
        trumpRevealed: false,
        trumpRevealedBySeat: null,

        currentTurnSeat: leader,
        ledSuit: null,
        plays: [],
        trickIndex: 0,

        tensByTeam: buildZeroCounts(room.teamMap!),
        seed,
      } as Partial<RoomState>);
    });
  }

  // ---------- PLAY CARD ----------
  async function playCard(card: Card) {
    if (!roomId || !state || !uid || !myHand) return;
    const mySeat = state.seats?.indexOf(uid) ?? -1;
    if (mySeat !== state.currentTurnSeat) return;

    await runTransaction(db, async (tx) => {
      const roomRef = doc(db, 'rooms', roomId);
      const handRef = doc(db, `rooms/${roomId}/hands/${uid}`);
      const room = (await tx.get(roomRef)).data() as RoomState;
      const hand = (await tx.get(handRef)).data() as MyHandDoc;

      const isFirstPlay = (room.plays?.length || 0) === 0;
      const ledSuit = isFirstPlay ? cardSuit(card) : (room.ledSuit as Suit);

      const vis = hand.visible.slice();
      const idx = vis.indexOf(card);
      if (idx < 0) throw new Error('Card not in your hand');
      vis.splice(idx, 1);

      const play: Play = { seat: mySeat, card, order: room.plays?.length || 0 };
      const newPlays = [...(room.plays || []), play];
      const totalPlayers = room.seats!.length;

      if (newPlays.length === totalPlayers) {
        // resolve trick
        const win = evaluateTrickWinner(newPlays, ledSuit, room.trumpRevealed ? room.trumpSuit : undefined);
        const tens = newPlays.filter(p => p.card.startsWith('T')).length;
        const tensByTeam = { ...(room.tensByTeam || {}) };
        const winnerTeam = room.teamMap![win.seat];
        tensByTeam[winnerTeam] = (tensByTeam[winnerTeam] || 0) + tens;

        tx.update(roomRef, {
          plays: [],
          ledSuit: null,
          currentTurnSeat: win.seat,
          trickIndex: (room.trickIndex || 0) + 1,
          tensByTeam,
        } as Partial<RoomState>);
      } else {
        tx.update(roomRef, {
          plays: newPlays,
          ledSuit,
          currentTurnSeat: ((room.currentTurnSeat || 0) + 1) % totalPlayers,
        } as Partial<RoomState>);
      }

      tx.update(handRef, { visible: vis, updatedAt: serverTimestamp() } as MyHandDoc);
    });
  }

  // ---------- REVEAL (void in led suit) ----------
  async function revealTrumpAndPlay(useHiddenIfOnly: boolean) {
    if (!roomId || !state || !uid || !myHand) return;
    const led = state.ledSuit as Suit | null;
    if (!led || state.trumpRevealed) return;

    const legal = legalPlaysFn(myHand.visible, led);
    const haveLed = legal.some(c => cardSuit(c) === led);
    if (haveLed) return; // must follow

    await runTransaction(db, async (tx) => {
      const roomRef = doc(db, 'rooms', roomId);
      const handRef = doc(db, `rooms/${roomId}/hands/${uid}`);
      const room = (await tx.get(roomRef)).data() as RoomState;
      const hand = (await tx.get(handRef)).data() as MyHandDoc;

      const mySeat = room.seats!.indexOf(uid);
      if (mySeat !== room.currentTurnSeat) throw new Error('Not your turn');

      const trump = room.trumpSuit!;
      const visibleTrumps = hand.visible.filter(c => cardSuit(c) === trump);
      let cardToPlay: Card | null = null;
      let usingHidden = false;

      if (visibleTrumps.length > 0) {
        // choose any; take highest by simple sort
        cardToPlay = visibleTrumps.sort().slice(-1)[0];
      } else if (hand.hidden && cardSuit(hand.hidden) === trump) {
        if (!useHiddenIfOnly) throw new Error('Only hidden trump available, pass useHiddenIfOnly=true');
        cardToPlay = hand.hidden;
        usingHidden = true;
      } else {
        throw new Error('No trump to reveal with');
      }

      const vis = hand.visible.slice();
      if (!usingHidden) {
        const idx = vis.indexOf(cardToPlay);
        if (idx >= 0) vis.splice(idx, 1);
        // unlock hidden if exists
        if (hand.hidden) {
          vis.push(hand.hidden);
        }
      }

      const play: Play = { seat: mySeat, card: cardToPlay!, order: room.plays?.length || 0 };
      const newPlays = [...(room.plays || []), play];
      const totalPlayers = room.seats!.length;

      const update: Partial<RoomState> = {
        plays: newPlays,
        ledSuit: room.ledSuit ?? cardSuit(newPlays[0].card),
        trumpRevealed: true,
        trumpRevealedBySeat: mySeat,
        currentTurnSeat: newPlays.length === totalPlayers ? room.currentTurnSeat : ((room.currentTurnSeat || 0) + 1) % totalPlayers,
      };

      if (newPlays.length === totalPlayers) {
        const win = evaluateTrickWinner(newPlays, update.ledSuit as Suit, room.trumpSuit);
        const tens = newPlays.filter(p => p.card.startsWith('T')).length;
        const tensByTeam = { ...(room.tensByTeam || {}) };
        const winnerTeam = room.teamMap![win.seat];
        tensByTeam[winnerTeam] = (tensByTeam[winnerTeam] || 0) + tens;

        update.plays = [];
        update.ledSuit = null;
        update.currentTurnSeat = win.seat;
        update.trickIndex = (room.trickIndex || 0) + 1;
        update.tensByTeam = tensByTeam;
      }

      tx.update(roomRef, update);
      tx.set(handRef, {
        visible: vis.sort(),
        hidden: usingHidden ? null : null,
        updatedAt: serverTimestamp(),
      } as MyHandDoc, { merge: true });
    });
  }

  // ---------- End hand (host) ----------
  async function hostEndHandIfDone() {
    if (!roomId || !state) return;
    if (!amHost) return;

    const hands: MyHandDoc[] = [];
    for (const u of state.seats || []) {
      const h = await getDoc(doc(db, `rooms/${roomId}/hands/${u}`));
      if (h.exists()) hands.push(h.data() as MyHandDoc);
    }
    const done = hands.every(h => h.visible.length === 0 && (!h.hidden || h.hidden === null));
    if (!done) { Alert.alert('Cards remain. Finish the hand first.'); return; }

    // winner = team with most 10s; scrap if trump never revealed
    let bestTeam = Object.keys(state.tensByTeam || {A:0})[0];
    for (const t of Object.keys(state.tensByTeam || {})) {
      if ((state.tensByTeam![t] || 0) > (state.tensByTeam![bestTeam] || 0)) bestTeam = t;
    }
    await runTransaction(db, async (tx) => {
      const roomRef = doc(db, 'rooms', roomId);
      const room = (await tx.get(roomRef)).data() as RoomState;
      const match = { ...(room.matchScoreByTeam || {}) };
      match[bestTeam] = (match[bestTeam] || 0) + 1;
      const scrap = { ...(room.scrapHandsByTeam || {}) };
      if (!room.trumpRevealed) scrap[bestTeam] = (scrap[bestTeam] || 0) + 1;
      tx.update(roomRef, {
        matchScoreByTeam: match,
        scrapHandsByTeam: scrap,
      } as Partial<RoomState>);
    });

    Alert.alert('Hand complete', `Team ${bestTeam} wins the hand${state.trumpRevealed ? '' : ' (scrap)'}.\nHost: Deal next hand when ready.`);
  }

  if (!state) {
    return <SafeAreaView style={styles.center}><Text>Loading…</Text></SafeAreaView>;
  }

  const legal = useMemo(() =>
    myHand ? legalPlaysFn(myHand.visible, state.ledSuit || undefined) : [], [myHand, state.ledSuit]);

  const isVoid = useMemo(() =>
    myHand && state.ledSuit ? !myHand.visible.some(c => cardSuit(c) === state.ledSuit) : false, [myHand, state.ledSuit]);

  const canReveal = !!(myHand && !state.trumpRevealed && state.ledSuit && isVoid);
  const amCurrent = state.currentTurnSeat !== undefined && meSeat === state.currentTurnSeat;

  const seatsInfo = useMemo(() => {
    const map: Record<string, Player> = {};
    players.forEach(p => map[p.uid] = p);
    return (state.seats || []).map((u, s) => ({
      seat: s,
      uid: u,
      name: map[u]?.displayName || `Seat ${s+1}`,
      team: state.teamMap?.[s] || '?',
      isMe: u === uid,
    }));
  }, [players, state.seats, state.teamMap, uid]);

  return (
    <ImageBackground source={TABLE_BG} resizeMode="cover" style={styles.bg}>
      <SafeAreaView style={styles.overlay}>
        <View style={styles.header}>
          <Text style={styles.title}>Mindi Kot</Text>
          <Text style={styles.sub}>Trump: {state.trumpRevealed ? state.trumpSuit : '— hidden —'}</Text>
          <View style={{ flexDirection: 'row', gap: 12, flexWrap: 'wrap' }}>
            {Object.entries(state.tensByTeam || {}).map(([t, v]) => (
              <Text key={t} style={styles.badge}>Team {t}: {v}×10</Text>
            ))}
            {Object.entries(state.matchScoreByTeam || {}).map(([t, v]) => (
              <Text key={t} style={styles.badgeDim}>Match {t}: {v}</Text>
            ))}
            {Object.entries(state.scrapHandsByTeam || {}).map(([t, v]) => (
              <Text key={t} style={styles.badgeDim}>Scrap {t}: {v}</Text>
            ))}
          </View>
        </View>

        {!isInitialized && amHost ? (
          <View style={{ paddingHorizontal: 16 }}>
            <TouchableOpacity style={styles.hostBtn} onPress={initializeTable}>
              <Text style={styles.hostTxt}>Initialize Table</Text>
            </TouchableOpacity>
            <Text style={{ color: '#fff', marginTop: 6 }}>Sets seats/teams/host from lobby and prepares scoreboard.</Text>
          </View>
        ) : null}

        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
            {(state.plays || []).map((p, i) => (
              <View key={i} style={styles.trickCard}>
                <Text style={styles.trickTxt}>{p.card}</Text>
                <Text style={styles.trickSeat}>S{p.seat+1}</Text>
              </View>
            ))}
          </View>

          <FlatList
            horizontal
            contentContainerStyle={{ gap: 12 }}
            data={seatsInfo.filter(s => !s.isMe)}
            keyExtractor={(x) => String(x.seat)}
            renderItem={({ item }) => (
              <View style={styles.seat}>
                <Text style={styles.seatName}>{item.name}</Text>
                <Text style={styles.seatTeam}>Team {item.team}</Text>
                <Text style={[styles.seatTurn, state.currentTurnSeat === item.seat && { color: '#111'}]}>
                  {state.currentTurnSeat === item.seat ? 'Your turn' : ' '}
                </Text>
              </View>
            )}
          />
        </View>

        {myHand ? (
          <View style={styles.meBlock}>
            <Text style={styles.meName}>You — Team {state.teamMap?.[meSeat]}</Text>

            {canReveal ? (
              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
                <TouchableOpacity style={styles.revealBtn} onPress={() => revealTrumpAndPlay(true)}>
                  <Text style={styles.revealTxt}>Reveal (use hidden if only)</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.revealBtn} onPress={() => revealTrumpAndPlay(false)}>
                  <Text style={styles.revealTxt}>Reveal (if other trumps)</Text>
                </TouchableOpacity>
              </View>
            ) : null}

            <FlatList
              horizontal
              contentContainerStyle={{ gap: 8 }}
              data={myHand.visible}
              keyExtractor={(c) => c}
              renderItem={({ item }) => {
                const playable = amCurrent && legal.includes(item);
                return (
                  <TouchableOpacity
                    onPress={() => playable && playCard(item)}
                    style={[styles.card, playable ? styles.cardPlay : styles.cardDim]}
                  >
                    <Text style={styles.cardTxt}>{item}</Text>
                  </TouchableOpacity>
                );
              }}
            />
          </View>
        ) : null}

        {amHost ? (
          <View style={styles.hostRow}>
            <TouchableOpacity style={styles.hostBtn} onPress={hostStartHand}>
              <Text style={styles.hostTxt}>Deal / Next Hand</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.hostBtn} onPress={hostEndHandIfDone}>
              <Text style={styles.hostTxt}>End Hand</Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </SafeAreaView>
    </ImageBackground>
  );
}

function buildZeroCounts(teamMap: string[]) {
  const set = new Set(teamMap);
  const out: Record<string, number> = {};
  for (const t of set) out[t] = 0;
  return out;
}

const styles = StyleSheet.create({
  bg: { flex: 1, backgroundColor: '#0a0a0a' },
  overlay: { flex: 1, backgroundColor: 'rgba(255,255,255,0.02)' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { padding: 16, gap: 6 },
  title: { color: '#fff', fontSize: 20, fontWeight: '800' },
  sub: { color: '#e5e7eb' },
  badge: { color: '#fff', fontWeight: '700', backgroundColor: 'rgba(0,0,0,0.35)', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6 },
  badgeDim: { color: '#e5e7eb', backgroundColor: 'rgba(0,0,0,0.25)', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6 },
  trickCard: { backgroundColor: '#fff', borderColor: '#9ca3af', borderWidth: 1, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 10, alignItems: 'center' },
  trickTxt: { color: '#111', fontWeight: '800' },
  trickSeat: { color: '#6b7280', fontSize: 12 },
  seat: { backgroundColor: 'rgba(255,255,255,0.9)', padding: 8, borderRadius: 10, alignItems: 'center' },
  seatName: { color: '#111', fontWeight: '800' },
  seatTeam: { color: '#6b7280' },
  seatTurn: { color: '#6b7280', fontSize: 12 },
  meBlock: { backgroundColor: 'rgba(255,255,255,0.96)', paddingVertical: 10, paddingHorizontal: 8, borderTopLeftRadius: 16, borderTopRightRadius: 16 },
  meName: { color: '#111', fontWeight: '800', marginBottom: 6, marginLeft: 4 },
  card: { backgroundColor: '#fff', paddingVertical: 16, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: '#d1d5db' },
  cardPlay: { borderColor: '#111', transform: [{ translateY: -6 }] },
  cardDim: { opacity: 0.6 },
  revealBtn: { backgroundColor: '#000', borderColor: '#9ca3af', borderWidth: 1, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 8 },
  revealTxt: { color: '#fff', fontWeight: '700', fontSize: 12 },
  hostRow: { position: 'absolute', right: 10, bottom: 12, gap: 8 },
  hostBtn: { backgroundColor: '#000', borderColor: '#9ca3af', borderWidth: 1, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10 },
  hostTxt: { color: '#fff', fontWeight: '800' },
});
