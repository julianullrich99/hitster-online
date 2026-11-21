import { createRoom, addPlayer, initRound } from './engine';
import {
  logRoundStarted,
  logPlacement,
  logFlipResolution,
  logSkip,
  logNamed,
  logAutoSkip,
  logSpotifyFallback,
} from './gameLog';
import type { Card, Room, RoundConfig } from '../../../shared/types';

function makeCard(trackId: string, year: number): Card {
  return { trackId, title: `Song ${trackId}`, artist: 'Artist', releaseYear: year, previewUrl: '', albumArt: '' };
}

const config: RoundConfig = { mode: 'original', cardsToWin: 6, turnSeconds: null, tokensEnabled: true };

function startedRoom(): Room {
  let room = createRoom('p1', 'Alice', 'Test');
  room = addPlayer(room, 'p2', 'Bob');
  const deck = Array.from({ length: 15 }, (_, i) => makeCard(`t${i}`, 1980 + i));
  return initRound(room, config, deck).room;
}

/** Entries without their random ids */
function log(room: Room): Array<Record<string, unknown>> {
  return (room.activeRound?.gameLog ?? []).map(({ id: _id, ...rest }) => rest);
}

describe('game log', () => {
  it('records structured events, not sentences', () => {
    const room = logPlacement(logRoundStarted(startedRoom()), 'p1');
    expect(log(room)).toEqual([
      { event: 'round_started', round: 1 },
      { event: 'placed', who: 'Alice', seconds: 3 },
    ]);
  });

  it('logs the reveal, challenge outcomes and then the flip line with the title', () => {
    const room = logFlipResolution(startedRoom(), 'p1', makeCard('x', 1999), false, [
      { challengerId: 'p2', outcome: 'stole_card' },
    ]);
    expect(log(room)).toEqual([
      { event: 'revealed', who: 'Alice', correct: false },
      { event: 'challenge_won', who: 'Bob', placer: 'Alice' },
      { title: 'Song x', correct: false },
    ]);
  });

  it('carries the coin balance after skips and naming', () => {
    const room = startedRoom();
    const balance = room.activeRound?.tokens['p1'] ?? 0;
    expect(log(logSkip(room, 'p1'))).toEqual([{ event: 'skipped', who: 'Alice', coins: balance }]);
    expect(log(logNamed(room, 'p1', true, true))).toEqual([
      { event: 'named', who: 'Alice', result: 'gained', coins: balance },
    ]);
    expect(log(logNamed(room, 'p1', false, true))[0]).toMatchObject({ result: 'max' });
    expect(log(logNamed(room, 'p1', false, false))[0]).toMatchObject({ result: 'counts' });
  });

  it('logs skipped turns and Spotify fallbacks with their reason / device', () => {
    const room = startedRoom();
    expect(log(logAutoSkip(room, 'p2', 'timeout'))).toEqual([{ event: 'turn_skipped', who: 'Bob', reason: 'timeout' }]);
    expect(log(logSpotifyFallback(room, 'Kitchen'))).toEqual([{ event: 'spotify_fallback', device: 'Kitchen' }]);
  });
});
