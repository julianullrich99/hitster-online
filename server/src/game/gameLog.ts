import { randomUUID } from 'crypto';
import type { Card, GameLogEntry, Room } from '../../../shared/types';

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

export function logAction(
  room: Room,
  who: string,
  action: string,
  consequence: string,
): Room {
  return pushLog(room, { id: randomUUID(), who, action, consequence });
}

export function logFlip(room: Room, title: string, correct: boolean): Room {
  return pushLog(room, { id: randomUUID(), title, correct });
}

export function logRoundStarted(room: Room): Room {
  const n = room.activeRound?.roundNumber ?? 1;
  return logAction(room, 'Game', 'Round started', `Round ${n} is live`);
}

export function logPlacement(room: Room, activeParticipantId: string): Room {
  const who = participantDisplayName(room, activeParticipantId);
  const secs = CHALLENGE_WINDOW_MS / 1000;
  return logAction(
    room,
    who,
    'placed a card',
    `${secs}s to challenge if the spot looks wrong`,
  );
}

export function logChallenge(room: Room, challengerId: string): Room {
  const who = participantDisplayName(room, challengerId);
  return logAction(room, who, 'Challenge', 'Challenged the placement');
}

export function logFlipResolution(
  room: Room,
  activeParticipantId: string,
  card: Card,
  correct: boolean,
  challengeResults: Array<{ challengerId: string; outcome: 'stole_card' | 'lost_token' }>,
): Room {
  const placer = participantDisplayName(room, activeParticipantId);
  const placementResult = correct
    ? `${placer} was correct — card stays on their timeline`
    : `${placer} was wrong — card discarded`;

  let updated = logAction(room, placer, 'card revealed', placementResult);
  for (const cr of challengeResults) {
    const challenger = participantDisplayName(room, cr.challengerId);
    if (cr.outcome === 'stole_card') {
      updated = logAction(
        updated,
        challenger,
        'Challenge',
        `${placer} was wrong — ${challenger} steals the card`,
      );
    } else {
      updated = logAction(
        updated,
        challenger,
        'Challenge',
        `${placer} was correct — ${challenger} loses 1 token`,
      );
    }
  }
  return logFlip(updated, card.title, correct);
}

export function logSkip(room: Room, participantId: string): Room {
  const who = participantDisplayName(room, participantId);
  return logAction(room, who, 'skipped', 'Drew a new card — turn continues');
}

export function logAutoSkip(
  room: Room,
  participantId: string,
  reason: 'disconnect' | 'timeout',
): Room {
  const who = participantDisplayName(room, participantId);
  const consequence =
    reason === 'timeout' ? 'Ran out of time — turn skipped' : 'Disconnected — turn skipped';
  return logAction(room, who, 'turn skipped', consequence);
}

export function logKick(room: Room, playerName: string): Room {
  return logAction(room, playerName, 'was removed by the host', 'Left the round');
}

export function logSpotifyFallback(room: Room, deviceName: string): Room {
  return logAction(room, 'Spotify', `couldn't play on ${deviceName}`, 'Playing the preview on every device');
}
