// ============================================================
// Hitster Online — Shared TypeScript Types
// Imported by both server and client. Define ALL types here.
// ============================================================

// ----------------------------
// Core domain types
// ----------------------------

export type GameMode = 'original' | 'pro' | 'expert' | 'cooperative';
export type RoomStatus = 'lobby' | 'round_active' | 'round_ended' | 'game_over';
export type TurnPhase = 'place' | 'challenge' | 'flip';
export type TokenStrategy = 'hoard' | 'spend' | 'balanced';

export interface Player {
  id: string;         // sessionId (UUID, generated client-side)
  displayName: string;
  email?: string;     // never shared with other clients
  isConnected: boolean;
  missedTurns: number;
  isSpectator?: boolean; // true when player joins a ROUND_ACTIVE room
}

export interface Team {
  id: string;
  name: string;
  playerIds: string[];
}

/** Full card — year revealed. Used after flip, on starting cards, and in timelines. */
export interface Card {
  trackId: string;
  title: string;
  artist: string;
  releaseYear: number;
  /** Spotify play page URL used during turns. */
  previewUrl: string;
  /** 30s MP3 preview when Spotify provides one (playlist preview modal, etc.). */
  streamUrl?: string | null;
  albumArt: string;
  /** Spotify artist genre tags (from artist profile). */
  genres?: string[];
}

/** Hidden card — sent to clients when the turn starts. Year/title/artist hidden until flip. */
export type CardHidden = Pick<Card, 'trackId' | 'previewUrl' | 'albumArt' | 'streamUrl'>;

export interface Timeline {
  ownerId: string;   // playerId or teamId
  cards: Card[];     // chronological order: oldest (index 0) → newest
}

export interface RoundConfig {
  playlistLabel?: string;     // Spotify playlist label / genre tag
  mode: GameMode;
  cardsToWin: number;         // default 6, max 6
  tokensEnabled: boolean;     // false disables all token mechanics
}

export interface RoundSummary {
  winnerId: string | null;    // playerId, teamId, or null (cooperative loss / deck empty tie)
  mode: GameMode;
  roundNumber: number;
}

export interface Room {
  code: string;
  ownerId: string;
  topic: string;
  status: RoomStatus;
  players: Record<string, Player>;
  teams: Record<string, Team>;
  useTeams: boolean;
  roundHistory: RoundSummary[];
  activeRound?: ActiveRound;
}

/** Standard game-log line (who / action / consequence). */
export interface GameLogLine {
  id: string;
  who: string;
  action: string;
  consequence: string;
}

/** Flip reveal line shown after a card is revealed. */
export interface GameLogFlipLine {
  id: string;
  title: string;
  correct: boolean;
}

export type GameLogEntry = GameLogLine | GameLogFlipLine;

export function isGameLogFlipLine(entry: GameLogEntry): entry is GameLogFlipLine {
  return 'title' in entry && 'correct' in entry;
}

export interface ActiveRound {
  config: RoundConfig;
  roundNumber: number;
  turnOrder: string[];              // ordered playerIds / teamIds
  turnIndex: number;
  timelines: Record<string, Timeline>;
  tokens: Record<string, number>;
  currentCard?: CardHidden;         // card in play this turn
  currentTurn?: CurrentTurn;
  deckRemaining: number;
  pendingSkips?: string[];          // playerIds whose NEXT turn is auto-skipped (after buying)
  /** Chronological log for late joiners / spectators (newest at end). */
  gameLog?: GameLogEntry[];
}

export interface Challenge {
  challengerId: string;
}

export interface CurrentTurn {
  activeId: string;          // playerId / teamId whose turn it is
  phase: TurnPhase;
  placedPosition?: number;
  challengeDeadline?: number; // Unix ms
  challenges: Challenge[];
  named?: boolean;   // Pro/Expert: placing player named song correctly this turn
}

// ----------------------------
// Room browser (lobby list)
// ----------------------------

export interface RoomSummary {
  code: string;
  topic: string;
  status: RoomStatus;
  playerCount: number;
  genre?: string;
  roundNumber?: number;
  leaderName?: string;
  leaderCards?: number;
  cardsToWin?: number;
}

// ----------------------------
// Socket.io event payloads
// ----------------------------

export interface ServerToClientEvents {
  /** Emitted to requesting socket with full card list for preview */
  'playlist:previewed': (data: { cards: Card[] }) => void;

  /** Emitted to creator after room:create succeeds */
  'room:created': (data: { roomCode: string; room: Room }) => void;

  /** Emitted to joiner after room:join succeeds */
  'room:joined': (data: { roomCode: string; room: Room }) => void;

  /** Broadcast to all room members when room state changes */
  'room:updated': (room: Room) => void;

  /** Broadcast when round is ready to start (starting cards dealt) */
  'round:started': (data: { room: Room }) => void;

  /** Broadcast at the start of each turn */
  'turn:started': (data: {
    activePlayerId: string;
    card: CardHidden;
    previewUrl: string;
    /** 30s MP3 for in-browser playback (API preview_url and/or embed-resolved). */
    streamUrl: string | null;
    playAt: number;        // Server Unix ms — start audio at this time (0 = don't play)
    /** Server Date.now() when emitted — clients schedule playAt relative to this (clock skew). */
    serverNow: number;
    timelineLength: number; // number of cards already on the active player's timeline
    /** Unix ms — auto-skip if still in place phase */
    turnEndsAt: number;
  }) => void;

  /** Broadcast after active player places their card */
  'turn:placed': (data: {
    position: number;
    activePlayerId: string;
    challengeEndsAt: number; // Unix ms — same instant as server challenge timer
  }) => void;

  /** Broadcast when a player challenges the placement */
  'turn:challenged': (data: { challengerId: string }) => void;

  /** Broadcast after challenge window closes — reveals card & result */
  'turn:flipped': (data: {
    card: Card;
    correct: boolean;
    activePlayerId: string;
    placedPosition: number;
    updatedTimeline: Timeline;
    timelines: Record<string, Timeline>;
    tokensUpdated: Record<string, number>;
    challengeResults: Array<{ challengerId: string; outcome: 'stole_card' | 'lost_token' }>;
  }) => void;

  /** Broadcast when a player correctly names the song (+1 token) */
  'turn:named': (data: { playerId: string; tokensUpdated: Record<string, number> }) => void;

  /** Broadcast when the round ends */
  'round:ended': (data: { winnerId: string | null; summary: RoundSummary }) => void;

  /** Broadcast when a player uses buy — spends 3 tokens, next turn will be skipped */
  'turn:bought': (data: { playerId: string; tokensUpdated: Record<string, number> }) => void;

  /** Broadcast when a player's turn is auto-skipped (due to buy or disconnect) */
  'turn:auto-skipped': (data: { playerId: string; reason: 'buy' | 'disconnect' | 'timeout' }) => void;

  /** Error — emitted only to the socket that caused it */
  'error': (message: string) => void;
}

export interface ClientToServerEvents {
  /** Fetch a track list for a playlist URL or genre label (preview/cheat mode) */
  'playlist:preview': (data: { playlistLabel: string }) => void;

  /** Create a new room. Player identity comes from socket.handshake.auth */
  'room:create': (data: { topic: string }) => void;

  /** Join an existing room by code */
  'room:join': (data: { roomCode: string }) => void;

  /** Owner starts the round */
  'round:start': (data: { playlistLabel?: string; mode: GameMode; cardsToWin?: number; tokensEnabled?: boolean }) => void;

  /** Active player places their card at position (0 = before all, n = after all) */
  'turn:place': (data: { position: number }) => void;

  /** Any non-active player challenges the current placement */
  'turn:challenge': () => void;

  /** Active player spends 1 token to skip their current card */
  'turn:skip': () => void;

  /** Active player attempts to name the song for +1 token */
  'turn:name': (data: { title: string; artist: string; year?: number }) => void;

  /** Active player spends 3 tokens to place the current card without hearing the song; their next turn is skipped */
  'turn:buy': () => void;

  /** Create a new team in the lobby */
  'team:create': (data: { name: string }) => void;

  /** Join an existing team (auto-leaves current team) */
  'team:join': (data: { teamId: string }) => void;

  /** Leave your current team */
  'team:leave': () => void;

  /** Owner ends the game session, transitioning room to game_over */
  'room:end': () => void;
}

// ----------------------------
// Socket auth (handshake)
// ----------------------------

export interface SocketAuth {
  sessionId: string;     // UUID, generated client-side
  displayName: string;   // shown to other players
  email?: string;        // never shared
}

/** GET /api/spotify/tracks/:trackId/embed-preview */
export interface EmbedPreviewResponse {
  streamUrl: string | null;
}
