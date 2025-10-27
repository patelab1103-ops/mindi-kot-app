// App.tsx
import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { router } from 'expo-router';

import { auth, db } from './src/firebase';
import { signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';

type PlayerRow = {
  uid: string;
  displayName: string;
  seat: number; // 0..N-1
  team: 'A' | 'B' | 'C' | 'D';
  isHost?: boolean;
  joinedAt?: any;
};

// 3-letter room codes
function makeCode() {
  let out = '';
  const A = 'A'.charCodeAt(0);
  for (let i = 0; i < 3; i++) out += String.fromCharCode(A + Math.floor(Math.random() * 26));
  return out;
}

export default function App() {
  // auth
  const [uid, setUid] = useState<string | null>(null);

  // UI state
  const [screen, setScreen] = useState<'home' | 'lobby'>('home');

  // inputs
  const [name, setName] = useState('');
  const [joinCode, setJoinCode] = useState('');

  // room
  const [roomId, setRoomId] = useState<string | null>(null);
  const [players, setPlayers] = useState<PlayerRow[]>([]);

  // ---------- auth ----------
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (u) {
        setUid(u.uid);
      } else {
        const cred = await signInAnonymously(auth);
        setUid(cred.user.uid);
      }
    });
    return () => unsub();
  }, []);

  // ---------- subscribe players in current room ----------
  useEffect(() => {
    if (!roomId) return;
    const q = query(collection(db, `rooms/${roomId}/players`), orderBy('seat', 'asc'));
    const unsub = onSnapshot(q, (snap) => {
      const arr: PlayerRow[] = [];
      snap.forEach((d) => arr.push(d.data() as PlayerRow));
      setPlayers(arr);
    });
    return () => unsub();
  }, [roomId]);

  const meInRoom = useMemo(() => players.find((p) => p.uid === uid), [players, uid]);
  const hostRow = useMemo(() => players.find((p) => p.isHost), [players]);
  const amHost = useMemo(() => hostRow?.uid === uid, [hostRow?.uid, uid]);

  // ---------- room actions ----------
  async function createRoom() {
    if (!name.trim()) {
      Alert.alert('Enter your name first');
      return;
    }
    const code = makeCode();
    const roomRef = doc(db, 'rooms', code);
    const exists = await getDoc(roomRef);
    if (exists.exists()) {
      // extremely unlikely; regenerate
      return createRoom();
    }
    await setDoc(roomRef, {
      createdAt: serverTimestamp(),
      code,
    });
    setRoomId(code);
    setScreen('lobby');
  }

  async function joinRoom() {
    if (!name.trim()) {
      Alert.alert('Enter your name first');
      return;
    }
    const code = (joinCode || '').trim().toUpperCase();
    if (!code || code.length !== 3) {
      Alert.alert('Enter a 3-letter room code');
      return;
    }
    const roomRef = doc(db, 'rooms', code);
    const exists = await getDoc(roomRef);
    if (!exists.exists()) {
      Alert.alert('Room not found');
      return;
    }
    setRoomId(code);
    setScreen('lobby');
  }

  async function claimSeat() {
    if (!roomId || !uid) return;
    if (!name.trim()) {
      Alert.alert('Enter your name'); return;
    }
    if (meInRoom) {
      Alert.alert('You already have a seat'); return;
    }
    // seat index = first free index in order
    const takenSeats = new Set(players.map((p) => p.seat));
    let seat = 0;
    while (takenSeats.has(seat)) seat++;
    // team: ABAB…
    const team = seat % 2 === 0 ? 'A' : 'B';
    // host = first claimer
    const hostAlready = players.some((p) => p.isHost);
    const isHost = hostAlready ? false : true;

    await setDoc(doc(db, `rooms/${roomId}/players/${uid}`), {
      uid,
      displayName: name.trim(),
      seat,
      team,
      isHost,
      joinedAt: serverTimestamp(),
    } as PlayerRow);
  }

  async function leaveSeat() {
    if (!roomId || !uid) return;
    try {
      await deleteDoc(doc(db, `rooms/${roomId}/players/${uid}`));
    } catch {}
  }

  // Host → proceed to Setup (ALWAYS navigates; writes seats/teamMap/hostUid first with try/catch)
  async function continueToSetup() {
    if (!roomId) return;

    // Let anyone press; the Setup page does the actual start.
    // We still *attempt* to write seats/team/host so Game can initialize.
    try {
      const ordered = players.slice().sort((a, b) => a.seat - b.seat);
      const seats = ordered.map((p) => p.uid);
      const teamMap = ordered.map((p) => p.team);
      const hostUid = ordered.find((p) => p.isHost)?.uid || seats[0];

      await updateDoc(doc(db, 'rooms', roomId), {
        seats,
        teamMap,
        hostUid,
      });
    } catch (e: any) {
      // Don’t block navigation — just inform
      console.log('continueToSetup write failed', e?.message || e);
      Alert.alert('Note', 'Could not save seats to server yet, continuing to Setup anyway.');
    }

    // Navigate no matter what — so you’re never stuck on Lobby
    router.replace('/setup');
  }

  // ---------- UI ----------
  if (!uid) {
    return (
      <SafeAreaView style={[S.container, { alignItems: 'center', justifyContent: 'center' }]}>
        <Text style={{ color: '#111' }}>Connecting…</Text>
      </SafeAreaView>
    );
  }

  if (screen === 'home') {
    return (
      <SafeAreaView style={S.container}>
        <Text style={S.title}>Mindi Kot</Text>

        <Text style={S.label}>Your name</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Enter your name"
          placeholderTextColor="#9ca3af"
          style={S.input}
        />

        <TouchableOpacity onPress={createRoom} style={S.btn}>
          <Text style={S.btnTxt}>Create Room</Text>
        </TouchableOpacity>

        <View style={{ height: 14 }} />

        <Text style={S.label}>Join by code</Text>
        <TextInput
          value={joinCode}
          onChangeText={(t) => setJoinCode(t.toUpperCase())}
          placeholder="ABC"
          placeholderTextColor="#9ca3af"
          autoCapitalize="characters"
          maxLength={3}
          style={S.input}
        />

        <TouchableOpacity onPress={joinRoom} style={S.btn}>
          <Text style={S.btnTxt}>Join Room</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  // Lobby
  return (
    <SafeAreaView style={S.container}>
      <Text style={S.title}>Lobby</Text>
      <Text style={S.sub}>
        Room: <Text style={{ fontWeight: '800' }}>{roomId}</Text>
      </Text>

      <View style={{ marginTop: 10 }}>
        {players
          .slice()
          .sort((a, b) => a.seat - b.seat)
          .map((p, i) => (
            <Text key={p.uid} style={S.row}>
              {i + 1}. {p.displayName} — Team {p.team}
              {p.isHost ? ' (Host)' : ''}
            </Text>
          ))}
      </View>

      {!meInRoom ? (
        <TouchableOpacity onPress={claimSeat} style={[S.btn, { marginTop: 'auto' }]}>
          <Text style={S.btnTxt}>Claim Seat</Text>
        </TouchableOpacity>
      ) : (
        <View style={{ marginTop: 'auto' }}>
          <TouchableOpacity onPress={leaveSeat} style={[S.btnGhost]}>
            <Text style={S.btnGhostTxt}>Leave Seat</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Start button visible to everyone; we still allow navigation so no one gets stuck */}
      <TouchableOpacity
        onPress={continueToSetup}
        style={[S.btn, { marginTop: 10, opacity: amHost ? 1 : 0.85 }]}
      >
        <Text style={S.btnTxt}>
          {amHost ? 'Setup & Start' : 'Setup & Start (Host only proceeds)'}
        </Text>
      </TouchableOpacity>

      <Text style={{ color: '#6b7280', marginTop: 6 }}>
        Host: {hostRow?.displayName || '—'}
      </Text>

      <Text style={{ color: '#6b7280', marginTop: 10 }}>Next: deal & play.</Text>
    </SafeAreaView>
  );
}

const S = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff', padding: 16 },
  title: { fontSize: 22, fontWeight: '800', color: '#111' },
  sub: { marginTop: 4, color: '#111' },
  label: { marginTop: 16, marginBottom: 6, color: '#111', fontWeight: '700' },
  input: {
    backgroundColor: '#fff',
    color: '#111',
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  btn: {
    marginTop: 12,
    backgroundColor: '#000',
    borderColor: '#9ca3af',
    borderWidth: 1,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  btnTxt: { color: '#fff', fontWeight: '700' },
  btnGhost: {
    backgroundColor: '#fff',
    borderColor: '#d1d5db',
    borderWidth: 1,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: 'center',
  },
  btnGhostTxt: { color: '#111', fontWeight: '700' },
  row: { color: '#111', marginVertical: 4 },
});
