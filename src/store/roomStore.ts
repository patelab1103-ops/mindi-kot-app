import { create } from 'zustand';

type Team = 'A' | 'B';
export type Player = {
  uid: string;
  displayName: string;
  seat: number;
  team: Team;
  isHost?: boolean;
  connected?: boolean;
};

type RoomState = {
  uid?: string;
  name: string;
  roomId?: string;
  code?: string;
  players: Player[];
  setName: (n: string) => void;
  setUid: (u: string) => void;
  setRoom: (id: string, code?: string) => void;
  setPlayers: (p: Player[]) => void;
};

export const useRoom = create<RoomState>((set) => ({
  name: '',
  players: [],
  setName: (name) => set({ name }),
  setUid: (uid) => set({ uid }),
  setRoom: (roomId, code) => set({ roomId, code }),
  setPlayers: (players) => set({ players }),
}));
