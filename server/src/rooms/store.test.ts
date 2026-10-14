import { RoomStore } from './store';
import { createRoom, addPlayer, initRound } from '../game/engine';
import type { Card, RoundConfig } from '../../../shared/types';

function makeCard(trackId: string, year: number): Card {
  return { trackId, title: `Song ${trackId}`, artist: 'Artist', releaseYear: year, previewUrl: `mock://${trackId}`, albumArt: '' };
}

const deck = Array.from({ length: 15 }, (_, i) => makeCard(`d${i}`, 1980 + i));
const config: RoundConfig = { mode: 'original', cardsToWin: 6, turnSeconds: 60, tokensEnabled: true };

describe('RoomStore', () => {
  let store: RoomStore;

  beforeEach(() => { store = new RoomStore(); });

  it('stores and retrieves rooms by code', () => {
    const room = createRoom('p1', 'Alice', 'Test Room');
    store.set(room);
    expect(store.get(room.code)).toEqual(room);
  });

  it('deletes rooms', () => {
    const room = createRoom('p1', 'Alice', 'Test Room');
    store.set(room);
    store.delete(room.code);
    expect(store.get(room.code)).toBeUndefined();
  });

  it('getAll returns all stored rooms', () => {
    const r1 = createRoom('p1', 'Alice', 'Room A');
    const r2 = createRoom('p2', 'Bob', 'Room B');
    store.set(r1);
    store.set(r2);
    expect(store.getAll()).toHaveLength(2);
  });

  describe('getSummaries', () => {
    it('returns lobby summary with no active round', () => {
      const room = createRoom('p1', 'Alice', 'My Room');
      store.set(room);
      const [s] = store.getSummaries();
      expect(s.code).toBe(room.code);
      expect(s.topic).toBe('My Room');
      expect(s.status).toBe('lobby');
      expect(s.playerCount).toBe(1);
      expect(s.genre).toBe('');
      expect(s.leaderName).toBe('Alice');
    });

    it('includes genre from playlistLabel when round is active', () => {
      let room = createRoom('p1', 'Alice', 'Rock Night');
      room = addPlayer(room, 'p2', 'Bob');
      const cfgWithGenre: RoundConfig = { ...config, playlistLabel: "90's rock" };
      const { room: initiated } = initRound(room, cfgWithGenre, deck);
      store.set(initiated);

      const [s] = store.getSummaries();
      expect(s.genre).toBe("90's rock");
      expect(s.status).toBe('round_active');
    });

    it('includes Spotify playlist URL as genre label', () => {
      let room = createRoom('p1', 'Alice', 'Spotify Room');
      room = addPlayer(room, 'p2', 'Bob');
      const url = 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M';
      const cfgWithUrl: RoundConfig = { ...config, playlistLabel: url };
      const { room: initiated } = initRound(room, cfgWithUrl, deck);
      store.set(initiated);

      const [s] = store.getSummaries();
      expect(s.genre).toBe(url);
    });

    it('tracks the leader (player with most cards) during active round', () => {
      let room = createRoom('p1', 'Alice', 'Game');
      room = addPlayer(room, 'p2', 'Bob');
      const { room: initiated } = initRound(room, config, deck);
      // Manually give Alice more cards
      const richRoom = {
        ...initiated,
        activeRound: {
          ...initiated.activeRound!,
          timelines: {
            ...initiated.activeRound!.timelines,
            p1: { ownerId: 'p1', cards: [makeCard('x1', 1990), makeCard('x2', 2000), makeCard('x3', 2010)] },
            p2: { ownerId: 'p2', cards: [makeCard('y1', 1995)] },
          },
        },
      };
      store.set(richRoom);
      const [s] = store.getSummaries();
      expect(s.leaderName).toBe('Alice');
      expect(s.leaderCards).toBe(3);
    });

    it('returns summaries for multiple rooms', () => {
      store.set(createRoom('p1', 'Alice', 'Room A'));
      store.set(createRoom('p2', 'Bob', 'Room B'));
      store.set(createRoom('p3', 'Carol', 'Room C'));
      expect(store.getSummaries()).toHaveLength(3);
    });
  });
});
