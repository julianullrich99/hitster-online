import type { MessageKey, TFunction, TParams } from './index';

/*
 * Server errors arrive as English text (thrown in server/src/game/engine.ts, emitted in
 * server/src/index.ts, Spotify deck errors in server/src/spotify). They are translated here by
 * their exact wording, dynamic ones by pattern; anything unknown is shown as sent.
 */

const EXACT: Record<string, MessageKey> = {
  'An error occurred': 'error.generic',
  'You were removed from the room by the host.': 'error.kicked',
  'Cannot join a room that has ended': 'error.roomEnded',
  'Room is full (max 12 players)': 'error.roomFull',
  'Player is not in this room': 'error.playerNotInRoom',
  'The room owner cannot be removed': 'error.ownerCannotBeRemoved',
  'Cannot remove the last player in the round — end the game instead': 'error.lastPlayer',
  'Cannot create teams after round has started': 'error.teamsCreateLocked',
  'Maximum of 6 teams allowed': 'error.maxTeams',
  'Cannot change teams after round has started': 'error.teamsChangeLocked',
  'Team not found': 'error.teamNotFound',
  'Cannot leave teams after round has started': 'error.teamsLeaveLocked',
  'Not enough cards in the deck to deal starting cards': 'error.notEnoughStartCards',
  'Need at least 2 teams with players to start': 'error.needTwoTeams',
  'Deck is empty': 'error.deckEmpty',
  'No active round': 'error.noActiveRound',
  'No current turn': 'error.noCurrentTurn',
  'Not your turn': 'error.notYourTurn',
  'Tokens are disabled in this game': 'error.tokensDisabled',
  'Not enough tokens to skip': 'error.notEnoughTokensSkip',
  'Can only buy during place phase': 'error.buyOnlyPlacePhase',
  'Not enough tokens to buy (need 3)': 'error.notEnoughTokensBuy',
  'Connect a Spotify account first': 'error.connectSpotifyFirst',
  'No Spotify account linked': 'error.noSpotifyLinked',
  'Failed to create room': 'error.createRoomFailed',
  'Room not found': 'error.roomNotFound',
  'Failed to join room': 'error.joinFailed',
  'Only the room owner can remove players': 'error.ownerOnlyKick',
  'Failed to remove player': 'error.kickFailed',
  'Only the room owner can start the round': 'error.ownerOnlyStart',
  'Round already active': 'error.roundActive',
  'Not enough tracks available to start': 'error.notEnoughTracks',
  'Failed to start round': 'error.startFailed',
  'Only the room owner can preview tracks': 'error.ownerOnlyPreview',
  'Failed to fetch tracks for preview': 'error.previewFailed',
  'Placement failed': 'error.placeFailed',
  'Not in challenge phase': 'error.notChallengePhase',
  'Spectators cannot challenge': 'error.spectatorChallenge',
  'Cannot challenge your own placement': 'error.ownChallenge',
  'You already shouted HITSTER!': 'error.alreadyChallenged',
  'Skip failed': 'error.skipFailed',
  'No card to buy': 'error.noCardToBuy',
  'Buy failed': 'error.buyFailed',
  'Failed to create team': 'error.createTeamFailed',
  'Failed to join team': 'error.joinTeamFailed',
  'Failed to leave team': 'error.leaveTeamFailed',
  'Only the room owner can end the game': 'error.ownerOnlyEnd',
  'Only the room owner can change the audio': 'error.ownerOnlyAudio',
  'Could not change audio': 'error.audioFailed',
  'Could not load Spotify devices': 'error.devicesFailed',
  'That Spotify device is not available — open Spotify on it and refresh': 'error.deviceUnavailable',
  'Could not select the Spotify device': 'error.selectDeviceFailed',
  'Spotify search is temporarily unavailable (request limit reached). Decades like "80s" or a playlist link still work.':
    'error.searchUnavailable',
  'Spotify is throttling requests right now — try again in a few minutes.': 'error.throttled',
  'Invalid Spotify playlist ID': 'error.invalidPlaylist',
};

const PATTERNS: Array<{ re: RegExp; key: MessageKey; params: (m: RegExpMatchArray) => TParams }> = [
  {
    re: /^The name "(.*)" is already taken in this room$/,
    key: 'error.nameTaken',
    params: m => ({ name: m[1] }),
  },
  {
    re: /^Only (\d+) playable tracks found for "(.*)" \(need at least (\d+)\)\. Try a different playlist or genre\.$/,
    key: 'error.fewTracks',
    params: m => ({ count: m[1], label: m[2], min: m[3] }),
  },
  {
    re: /^Could not load Spotify devices \((\d+)\)$/,
    key: 'error.devicesFailedStatus',
    params: m => ({ status: m[1] }),
  },
  {
    re: /^Spotify playlist embed fetch failed: (\d+)$/,
    key: 'error.playlistFetchFailed',
    params: m => ({ status: m[1] }),
  },
  {
    re: /^Cannot extract playlist ID from: (.*)$/,
    key: 'error.playlistIdUnreadable',
    params: m => ({ input: m[1] }),
  },
];

/** A server (or client) error message in the current language; unknown messages pass through. */
export function translateError(message: string, t: TFunction): string {
  const key = EXACT[message];
  if (key) return t(key);
  for (const p of PATTERNS) {
    const m = message.match(p.re);
    if (m) return t(p.key, p.params(m));
  }
  return message;
}
