import { randomUUID } from 'crypto';
import type { Card, GameLogEntry, GameLogEvent, Room } from '../../../shared/types';

/*
 * Game log: the server records structured events (who, counts, reasons) and every client
 * renders them in its own language (client/src/game/gameLog.ts).
 */

/** Keep in sync with shared/constants.ts (not imported — Jest loads shared as ESM). */
const CHALLENGE_WINDOW_MS = 3_000;
const GAME_LOG_MAX_ENTRIES = 50;

export function participantDisplayName(room: Room, participantId: string): string {
  const player = room.players[participantId];
  if (player) return player.displayName;
  const team = room.teams[participantId];
  if (team) return team.name;
  const teamByMember = Object.values(room.teams).find((t) => t.playerIds.includes(participantId));
  return teamByMember?.name ?? participantId;
}

function pushLog(room: Room, entry: GameLogEntry): Room {
  if (!room.activeRound) return room;
  const prev = room.activeRound.gameLog ?? [];
  const gameLog = [...prev, entry].slice(-GAME_LOG_MAX_ENTRIES);
  return { ...room, activeRound: { ...room.activeRound, gameLog } };
}

export function logEvent(room: Room, event: GameLogEvent): Room {
  return pushLog(room, { ...event, id: randomUUID() });
}

export function logFlip(room: Room, title: string, correct: boolean): Room {
  return pushLog(room, { id: randomUUID(), title, correct });
}

export function logRoundStarted(room: Room): Room {
  return logEvent(room, { event: 'round_started', round: room.activeRound?.roundNumber ?? 1 });
}

export function logPlacement(room: Room, activeParticipantId: string): Room {
  return logEvent(room, {
    event: 'placed',
    who: participantDisplayName(room, activeParticipantId),
    seconds: CHALLENGE_WINDOW_MS / 1000,
  });
}

export function logChallenge(room: Room, challengerId: string): Room {
  return logEvent(room, { event: 'challenged', who: participantDisplayName(room, challengerId) });
}

export function logFlipResolution(
  room: Room,
  activeParticipantId: string,
  card: Card,
  correct: boolean,
  challengeResults: Array<{ challengerId: string; outcome: 'stole_card' | 'lost_token' }>,
): Room {
  const placer = participantDisplayName(room, activeParticipantId);
  let updated = logEvent(room, { event: 'revealed', who: placer, correct });
  for (const cr of challengeResults) {
    const who = participantDisplayName(room, cr.challengerId);
    updated = logEvent(updated, {
      event: cr.outcome === 'stole_card' ? 'challenge_won' : 'challenge_lost',
      who,
      placer,
    });
  }
  return logFlip(updated, card.title, correct);
}

/** Coins of the participant's pool after a change. */
function coinBalance(room: Room, participantId: string): number {
  const ar = room.activeRound;
  if (!ar) return 0;
  const pool = ar.config.mode === 'cooperative'
    ? 'cooperative'
    : room.useTeams
      ? (Object.entries(room.teams).find(([, t]) => t.playerIds.includes(participantId))?.[0] ?? participantId)
      : participantId;
  return ar.tokens[pool] ?? 0;
}

export function logSkip(room: Room, participantId: string): Room {
  return logEvent(room, {
    event: 'skipped',
    who: participantDisplayName(room, participantId),
    coins: coinBalance(room, participantId),
  });
}

export function logBuy(room: Room, participantId: string): Room {
  return logEvent(room, {
    event: 'bought',
    who: participantDisplayName(room, participantId),
    coins: coinBalance(room, participantId),
  });
}

/** Correct song name. `gained` is false when the bonus is off (Pro/Expert) or the pool is full. */
export function logNamed(room: Room, playerId: string, gained: boolean, bonusAvailable: boolean): Room {
  return logEvent(room, {
    event: 'named',
    who: participantDisplayName(room, playerId),
    result: !bonusAvailable ? 'counts' : gained ? 'gained' : 'max',
    coins: coinBalance(room, playerId),
  });
}

export function logAutoSkip(
  room: Room,
  participantId: string,
  reason: 'disconnect' | 'timeout',
): Room {
  return logEvent(room, { event: 'turn_skipped', who: participantDisplayName(room, participantId), reason });
}

export function logKick(room: Room, playerName: string): Room {
  return logEvent(room, { event: 'kicked', who: playerName });
}

export function logSpotifyFallback(room: Room, deviceName: string): Room {
  return logEvent(room, { event: 'spotify_fallback', device: deviceName });
}
