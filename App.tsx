import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  Alert,
  ActivityIndicator,
  StyleSheet,
  SafeAreaView,
  StatusBar,
} from 'react-native';
import { auth, db, ensureAnon } from './src/firebase';
import { useRoom, Player } from './src/store/roomStore';
import {
  addDoc,
  collection,
  doc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore';

function makeCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

/** Reusable black button with grey outline */
function AppButton({
  title,
  onPress,
  disabled,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <TouchableOpacity
      activeOpacity={0.8}
      onPress={onPress}
      disabled={disabled}
      style={[styles.button, disabled && styles.buttonDisabled]}
    >
      <Text style={styles.buttonText}>{title}</Text>
    </TouchableOpacity>
  );
}

export default function App() {
  const { name, setName, setUid, roomId, code, setRoom, players, setPlayers } = useRoom();
  const [joinCode, setJoinCode] = useState('');
  const [phase, setPhase] = useState<'home' | 'lobby'>('home');
  const [loading, setLoading] = useState(true);

  // Sign in anonymously, fail loudly if anything breaks
  useEffect(() => {
    (async () => {
      try {
        await ensureAnon();
        if (auth.currentUser?.uid) setUid(auth.currentUser.uid);
      } catch (e: any) {
        console.error('Auth error:', e);
        Alert.alert('Sign-in failed', String(e?.message || e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  function listenPlayers(id: string) {
    return onSnapshot(
      collection(db, `rooms/${id}/players`),
      (ps) => {
        const arr: Player[] = ps.docs.map((d) => ({ uid: d.id, ...(d.data() as any) }));
        arr.sort((a, b) => a.seat - b.seat);
        setPlayers(arr);
      },
      (err) => {
        console.error('Players listen error:', err);
        Alert.alert('Realtime error', String(err?.message || err));
      }
    );
  }

  async function createRoom() {
    try {
      if (!name.trim()) return Alert.alert('Enter your name');
      const roomCode = makeCode();
      const ref = await addDoc(collection(db, 'rooms'), {
        code: roomCode,
        game: 'mindi',
        teamMode: 'two_teams',
        status: 'lobby',
        createdAt: serverTimestamp(),
      });

      const uid = auth.currentUser!.uid;
      await setDoc(doc(db, `rooms/${ref.id}/players/${uid}`), {
        displayName: name.trim(),
        seat: 0,
        team: 'A',
        isHost: true,
        connected: true,
      });

      setRoom(ref.id, roomCode);
      setPhase('lobby');
      listenPlayers(ref.id);
    } catch (e: any) {
      console.error('Create room failed:', e);
      Alert.alert('Create room failed', String(e?.message || e));
    }
  }

  async function joinByCode() {
    try {
      if (!name.trim()) return Alert.alert('Enter your name');
      const codeUpper = joinCode.trim().toUpperCase();
      if (!codeUpper) return Alert.alert('Enter a room code');
      const q = query(collection(db, 'rooms'), where('code', '==', codeUpper));
      const snap = await getDocs(q);
      if (snap.empty) return Alert.alert('No room found with that code');

      const roomDoc = snap.docs[0];
      const id = roomDoc.id;
      setRoom(id, codeUpper);
      setPhase('lobby');
      listenPlayers(id);
    } catch (e: any) {
      console.error('Join failed:', e);
      Alert.alert('Join failed', String(e?.message || e));
    }
  }

  const nextSeatAndTeam = useMemo(() => {
    const taken = new Set(players.map((p) => p.seat));
    let seat = 0;
    while (taken.has(seat)) seat++;
    const team: 'A' | 'B' = seat % 2 === 0 ? 'A' : 'B';
    return { seat, team };
  }, [players]);

  async function claimSeat() {
    try {
      if (!roomId) return;
      const uid = auth.currentUser!.uid;
      const me = players.find((p) => p.uid === uid);
      if (me) return Alert.alert('Seat already claimed');

      await setDoc(doc(db, `rooms/${roomId}/players/${uid}`), {
        displayName: name.trim() || 'You',
        seat: nextSeatAndTeam.seat,
        team: nextSeatAndTeam.team,
        isHost: players.length === 0,
        connected: true,
      });
    } catch (e: any) {
      console.error('Claim seat failed:', e);
      Alert.alert('Claim seat failed', String(e?.message || e));
    }
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <StatusBar barStyle="dark-content" />
        <View style={styles.center}>
          <ActivityIndicator />
          <Text style={styles.muted}>Starting…</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (phase === 'home') {
    return (
      <SafeAreaView style={styles.container}>
        <StatusBar barStyle="dark-content" />
        <View style={styles.header}>
          <Text style={styles.title}>Mindi Kot — Lobby</Text>
          <Text style={styles.subtitle}>Create a room or join one with a code</Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.label}>Your Name</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="e.g., Adi"
            placeholderTextColor={colors.muted}
            autoCapitalize="words"
            style={styles.input}
          />
          <AppButton title="Create Room" onPress={createRoom} />
        </View>

        <View style={styles.divider} />

        <View style={styles.section}>
          <Text style={styles.label}>Room Code</Text>
          <TextInput
            value={joinCode}
            onChangeText={setJoinCode}
            placeholder="ABC123"
            placeholderTextColor={colors.muted}
            autoCapitalize="characters"
            style={styles.input}
          />
          <AppButton title="Join by Code" onPress={joinByCode} />
        </View>
      </SafeAreaView>
    );
  }

  // LOBBY
  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.headerRow}>
        <Text style={styles.title}>Lobby</Text>
        {code ? (
          <Text style={styles.code}>
            Room: <Text style={styles.codeBold}>{code}</Text>
          </Text>
        ) : null}
      </View>

      <FlatList
        style={{ marginTop: 12 }}
        data={[...players]}
        keyExtractor={(x) => x.uid}
        renderItem={({ item }) => (
          <Text style={styles.listItem}>
            {item.seat + 1}. {item.displayName} — Team {item.team}
            {item.isHost ? ' (Host)' : ''}
          </Text>
        )}
        ListEmptyComponent={
          <Text style={styles.muted}>No players yet. Tap “Claim Seat”.</Text>
        }
      />

      <View style={{ height: 12 }} />
      <AppButton title="Claim Seat" onPress={claimSeat} />

      <Text style={[styles.muted, { marginTop: 18 }]}>Next: deal & play.</Text>
    </SafeAreaView>
  );
}

/* ---------------------------- THEME & STYLES ---------------------------- */

const colors = {
  bg: '#FFFFFF',          // white background
  text: '#111827',        // near-black text
  border: '#D1D5DB',      // light grey borders
  outline: '#9CA3AF',     // mid grey outline
  buttonBg: '#000000',    // black button background
  buttonText: '#FFFFFF',  // white button text
  muted: '#6B7280',       // muted grey text
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: {
    marginVertical: 12,
  },
  headerRow: {
    marginVertical: 12,
  },
  title: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '800',
  },
  subtitle: {
    color: colors.muted,
    marginTop: 4,
  },
  code: {
    color: colors.text,
    marginTop: 4,
  },
  codeBold: {
    color: colors.text,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  section: {
    gap: 10,
    marginTop: 8,
  },
  label: {
    color: colors.text,
    fontWeight: '600',
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
  },
  button: {
    backgroundColor: colors.buttonBg,
    borderColor: colors.outline,
    borderWidth: 1,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: colors.buttonText,
    fontWeight: '700',
    fontSize: 16,
    letterSpacing: 0.2,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: 16,
  },
  listItem: {
    color: colors.text,
    paddingVertical: 6,
  },
  muted: {
    color: colors.muted,
  },
});
