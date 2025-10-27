// app/setup.tsx
import React, { useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, SafeAreaView } from 'react-native';
import { router } from 'expo-router';
import { db } from '../src/firebase';
import { useRoom } from '../src/store/roomStore';
import { doc, updateDoc } from 'firebase/firestore';

type Mode =
  | '2v2'
  | '3v3'
  | '3teams_of_2'
  | '2v4'
  | '4teams_of_2';

export default function Setup() {
  const { roomId, players } = useRoom();
  const [selection, setSelection] = useState<Mode | null>(null);
  const [deckCount, setDeckCount] = useState<1 | 2>(1);

  const count = players.length;

  // Valid team formats based on player count
  const options: { key: Mode; label: string }[] = useMemo(() => {
    const o: { key: Mode; label: string }[] = [];
    if (count === 4) o.push({ key: '2v2', label: '2 teams of 2 (2v2)' });
    if (count === 6) {
      o.push({ key: '3v3', label: '2 teams of 3 (3v3)' });
      o.push({ key: '3teams_of_2', label: '3 teams of 2' });
    }
    if (count === 8) {
      o.push({ key: '2v4', label: '2 teams of 4' });
      o.push({ key: '4teams_of_2', label: '4 teams of 2' });
    }
    return o;
  }, [count]);

  async function applyTeams() {
    if (!roomId || !selection) return;

    // Deck rules per your spec:
    // - 6 players => 1 deck
    // - 8 players => choose 1 or 2 decks
    // - 4 players => 1 deck (implicit)
    let decks: 1 | 2 = 1;
    if (count === 8) decks = deckCount;

    // Seats and teams ordered by seat index
    const seatsOrdered = players
      .slice()
      .sort((a, b) => a.seat - b.seat)
      .map((p) => p.uid);

    const teamMapOrdered = players
      .slice()
      .sort((a, b) => a.seat - b.seat)
      .map((p) => p.team);

    const hostUid =
      players.find((p) => p.isHost)?.uid || seatsOrdered[0];

    await updateDoc(doc(db, 'rooms', roomId), {
      mode: selection,
      deckCount: decks,
      seats: seatsOrdered,
      teamMap: teamMapOrdered,
      hostUid,
    });

    router.replace('/game');
  }

  return (
    <SafeAreaView style={S.container}>
      <Text style={S.title}>Game Setup</Text>
      <Text style={S.note}>Players seated: {count}</Text>

      {options.length === 0 ? (
        <Text style={S.warn}>
          This player count isn’t supported on Setup. Go back or ask me to add it.
        </Text>
      ) : (
        options.map((o) => (
          <TouchableOpacity
            key={o.key}
            style={[S.option, selection === o.key && S.optionSel]}
            onPress={() => setSelection(o.key)}
          >
            <Text style={S.optionText}>{o.label}</Text>
          </TouchableOpacity>
        ))
      )}

      {/* 8 players can choose deck count */}
      {count === 8 ? (
        <View style={{ marginTop: 12, gap: 8 }}>
          <Text style={{ color: '#111', fontWeight: '700' }}>Deck count</Text>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <TouchableOpacity
              style={[S.pill, deckCount === 1 && S.pillSel]}
              onPress={() => setDeckCount(1)}
            >
              <Text style={S.pillTxt}>1 deck</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[S.pill, deckCount === 2 && S.pillSel]}
              onPress={() => setDeckCount(2)}
            >
              <Text style={S.pillTxt}>2 decks</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}

      <TouchableOpacity
        onPress={applyTeams}
        disabled={!selection}
        style={[S.startBtn, !selection && { opacity: 0.6 }]}
      >
        <Text style={S.startTxt}>Start</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const S = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff', padding: 20, gap: 12 },
  title: { fontSize: 22, fontWeight: '800', color: '#111' },
  note: { color: '#555' },
  warn: { color: '#b00' },
  option: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    padding: 12,
    borderRadius: 10,
    backgroundColor: '#fff',
  },
  optionSel: { borderColor: '#111' },
  optionText: { color: '#111', fontWeight: '600' },
  pill: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 999,
    backgroundColor: '#fff',
  },
  pillSel: { borderColor: '#111', backgroundColor: '#f3f4f6' },
  pillTxt: { color: '#111', fontWeight: '600' },
  startBtn: {
    marginTop: 16,
    backgroundColor: '#000',
    borderColor: '#9ca3af',
    borderWidth: 1,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  startTxt: { color: '#fff', fontWeight: '700' },
});
