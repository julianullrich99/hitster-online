import { config as loadEnv } from 'dotenv';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { join, resolve } from 'path';

// Load server/.env even when started from repo root (e.g. npx tsx server/src/index.ts)
for (const envPath of [
  resolve(__dirname, '..', '.env'),
  resolve(__dirname, '..', '..', '..', '.env'),
  resolve(process.cwd(), 'server', '.env'),
  resolve(process.cwd(), '.env'),
]) {
  if (existsSync(envPath)) {
    loadEnv({ path: envPath });
    break;
  }
}
import {
  CARDS_TO_WIN_DEFAULT,
  CARDS_TO_WIN_MIN,
  CHALLENGE_WINDOW_MS as DEFAULT_CHALLENGE_WINDOW_MS,
  FLIP_REVEAL_DISPLAY_MS as DEFAULT_FLIP_REVEAL_DISPLAY_MS,
  TURN_SECONDS_DEFAULT,
  TURN_SECONDS_OPTIONS,
} from '../../shared/constants';
import type { Socket } from 'socket.io';
import type {
  ServerToClientEvents,
  ClientToServerEvents,
  SocketAuth,
  RoundConfig,
  Challenge,
  Room,
  Card,
  CardHidden,
} from '../../shared/types';
import { createSpotifyClient } from './spotify/client';
import {
  fetchEmbedPreviewUrl,
  isSpotifyTrackPageUrl,
  isValidSpotifyTrackId,
} from './spotify/embedPreview';
import { SpotifyConnect } from './spotify/connect';
import { RoomStore } from './rooms/store';
import * as engine from './game/engine';
import * as gameLog from './game/gameLog';
import * as naming from './game/naming';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const app = express();
const httpServer = createServer(app);

const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: {
    origin: process.env.CLIENT_URL || 'http://localhost:5173',
    methods: ['GET', 'POST'],
  },
});

app.use(cors());
app.use(express.json());

const store = new RoomStore();
const spotify = createSpotifyClient();
const spotifyConnect = new SpotifyConnect(
  process.env.SPOTIFY_CLIENT_ID ?? '',
  process.env.SPOTIFY_CLIENT_SECRET ?? '',
);

// In TEST_MODE the challenge window is much shorter to keep tests fast
const CHALLENGE_WINDOW_MS =
  process.env.TEST_MODE === 'true' ? 500 : DEFAULT_CHALLENGE_WINDOW_MS;
const FLIP_REVEAL_DISPLAY_MS =
  process.env.TEST_MODE === 'true' ? 300 : DEFAULT_FLIP_REVEAL_DISPLAY_MS;

// socketId → { sessionId, roomCode }
const socketSession = new Map<string, { sessionId: string; roomCode: string }>();

// roomCode → remaining deck
const liveDecks = new Map<string, ReturnType<typeof engine.drawCard>['remaining']>();

// roomCode → card drawn this turn (not yet flipped)
const pendingCards = new Map<string, ReturnType<typeof engine.drawCard>['card']>();

// roomCode → per-turn challenge list (separate from room state to avoid type pollution)
const pendingChallenges = new Map<string, Challenge[]>();

// roomCode → challenge window timer
const challengeTimers = new Map<string, ReturnType<typeof setTimeout>>();
const flipAdvanceTimers = new Map<string, ReturnType<typeof setTimeout>>();

// roomCode → pending empty-room deletion timer
const pendingDeletes = new Map<string, ReturnType<typeof setTimeout>>();
const EMPTY_ROOM_TTL_MS = process.env.TEST_MODE === 'true' ? 5_000 : 60_000;

// Disconnect: auto-skip after this delay if still in place phase
const TURN_TIMEOUT_MS = process.env.TEST_MODE === 'true' ? 3_000 : 15_000;

// Connected player: max time to place before auto-skip (full turn clock), from the round config.
// Fixed in TEST_MODE so Playwright can complete place flows before auto-skip.
function placeTimeoutMs(room: Room): number | null {
  if (process.env.TEST_MODE === 'true') return 25_000;
  const seconds = room.activeRound?.config.turnSeconds;
  return seconds ? seconds * 1000 : null;
}

// roomCode → place-phase turn timer (listen + place)
const placeTurnTimers = new Map<string, ReturnType<typeof setTimeout>>();

// roomCode → Spotify device playing the current turn's full song (absent = previews this turn)
const turnSpeakers = new Map<string, { deviceName: string }>();

// playerId → pending disconnect-skip timer (so it can be cancelled on reconnect)
const disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

// roomCode → player/team whose turn is due but was offline when it came up (no card drawn yet).
// Their return starts the turn; without this a quick rejoin cancelled the skip and the round hung.
const waitingTurns = new Map<string, string>();

// ---------------------------------------------------------------------------
// HTTP routes — API endpoints must be registered before the SPA catch-all
// ---------------------------------------------------------------------------

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', rooms: store.getAll().length });
});

app.get('/rooms', (_req, res) => {
  res.json(store.getSummaries());
});

app.get('/api/spotify/tracks/:trackId/embed-preview', async (req, res) => {
  const { trackId } = req.params;
  if (!isValidSpotifyTrackId(trackId)) {
    res.status(400).json({ error: 'Invalid Spotify track ID' });
    return;
  }
  try {
    const streamUrl = await fetchEmbedPreviewUrl(trackId);
    res.json({ streamUrl } satisfies { streamUrl: string | null });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to resolve embed preview';
    res.status(502).json({ error: message });
  }
});

// ── Spotify Connect (full songs on one device) ────────────────────────────────
// The room owner links a Premium account; tokens stay on the server (spotify/connect.ts).

function spotifyRedirectUri(req: express.Request): string {
  if (process.env.SPOTIFY_REDIRECT_URI) return process.env.SPOTIFY_REDIRECT_URI;
  const proto = (req.get('x-forwarded-proto') ?? req.protocol).split(',')[0].trim();
  return `${proto}://${req.get('host')}/api/spotify/connect/callback`;
}

function connectResultPage(res: express.Response, status: number, message: string): void {
  const safe = message.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
  res.status(status).type('html').send(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Hitster · Spotify</title>
<style>body{font-family:system-ui,sans-serif;background:#0b0b12;color:#e5e7eb;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;text-align:center}</style>
</head><body><div><p style="font-size:18px">${safe}</p><p style="color:#9ca3af">You can close this tab and go back to the game.</p></div>
<script>setTimeout(function(){window.close()},1500)</script></body></html>`);
}

app.get('/api/spotify/connect/login', (req, res) => {
  const roomCode = String(req.query.room ?? '').toUpperCase();
  const sessionId = String(req.query.session ?? '');
  const room = store.get(roomCode);
  if (!spotifyConnect.configured || process.env.TEST_MODE === 'true') {
    connectResultPage(res, 503, 'Spotify is not configured on this server.');
    return;
  }
  if (!room || room.ownerId !== sessionId) {
    connectResultPage(res, 403, 'Only the room owner can connect Spotify.');
    return;
  }
  res.redirect(spotifyConnect.beginLogin(roomCode, sessionId, spotifyRedirectUri(req)));
});

app.get('/api/spotify/connect/callback', async (req, res) => {
  const login = spotifyConnect.takeLogin(String(req.query.state ?? ''));
  if (!login) {
    connectResultPage(res, 400, 'This Spotify login expired. Try again from the lobby.');
    return;
  }
  if (req.query.error || !req.query.code) {
    connectResultPage(res, 400, 'Spotify login was cancelled.');
    return;
  }
  try {
    const accountName = await spotifyConnect.completeLogin(login, String(req.query.code));
    const room = store.get(login.roomCode);
    if (!room) {
      spotifyConnect.unlink(login.roomCode);
      connectResultPage(res, 404, 'The room no longer exists.');
      return;
    }
    const updated = engine.setSpotifyAccount(room, accountName);
    store.set(updated);
    io.to(room.code).emit('room:updated', updated);
    connectResultPage(res, 200, `Spotify connected as ${accountName}.`);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Spotify login failed';
    connectResultPage(res, 400, message);
  }
});

// Serve built React client if available, otherwise redirect to Vite dev server
function resolveClientDist(): string | null {
  const candidates = [
    join(__dirname, '../../client/dist'), // tsx dev (server/src)
    join(__dirname, '../../../../client/dist'), // compiled (server/dist/server/src)
    join(process.cwd(), 'client/dist'),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, 'index.html'))) return dir;
  }
  return null;
}

const clientDist = resolveClientDist();
if (clientDist) {
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => res.sendFile(join(clientDist, 'index.html')));
} else {
  const devUrl = process.env.CLIENT_URL || 'http://localhost:5173';
  app.get('/', (_req, res) => res.redirect(devUrl));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clearChallengeTimer(roomCode: string): void {
  const t = challengeTimers.get(roomCode);
  if (t !== undefined) { clearTimeout(t); challengeTimers.delete(roomCode); }
}

function clearFlipAdvanceTimer(roomCode: string): void {
  const t = flipAdvanceTimers.get(roomCode);
  if (t !== undefined) { clearTimeout(t); flipAdvanceTimers.delete(roomCode); }
}

function clearPlaceTurnTimer(roomCode: string): void {
  const t = placeTurnTimers.get(roomCode);
  if (t !== undefined) { clearTimeout(t); placeTurnTimers.delete(roomCode); }
}

function purgeRoomRuntime(roomCode: string): void {
  const room = store.get(roomCode);
  if (room) pauseSpeaker(room);
  spotifyConnect.unlink(roomCode);
  turnSpeakers.delete(roomCode);
  clearPlaceTurnTimer(roomCode);
  clearChallengeTimer(roomCode);
  clearFlipAdvanceTimer(roomCode);
  pendingCards.delete(roomCode);
  pendingChallenges.delete(roomCode);
  liveDecks.delete(roomCode);
  waitingTurns.delete(roomCode);
  const pendingDelete = pendingDeletes.get(roomCode);
  if (pendingDelete !== undefined) {
    clearTimeout(pendingDelete);
    pendingDeletes.delete(roomCode);
  }
}

function scheduleEmptyRoomDeletion(roomCode: string): void {
  const existing = pendingDeletes.get(roomCode);
  if (existing !== undefined) clearTimeout(existing);

  const t = setTimeout(() => {
    pendingDeletes.delete(roomCode);
    const cur = store.get(roomCode);
    if (!cur || !engine.allParticipantsOffline(cur)) return;
    purgeRoomRuntime(roomCode);
    store.delete(roomCode);
    console.log(`[room] deleted ${roomCode} (all participants offline)`);
  }, EMPTY_ROOM_TTL_MS);
  pendingDeletes.set(roomCode, t);
}

function autoSkipActiveTurn(
  roomCode: string,
  playerId: string,
  reason: 'disconnect' | 'timeout',
): void {
  clearPlaceTurnTimer(roomCode);
  clearChallengeTimer(roomCode);
  const card = pendingCards.get(roomCode);

  const cur = store.get(roomCode);
  if (!cur?.activeRound) return;
  if (cur.activeRound.turnOrder[cur.activeRound.turnIndex] !== playerId) return;
  // Either mid-turn (card drawn, place phase) or a turn that never started because they were offline
  const waiting = waitingTurns.get(roomCode) === playerId;
  if (!waiting && cur.activeRound.currentTurn?.phase !== 'place') return;
  waitingTurns.delete(roomCode);
  pendingCards.delete(roomCode);
  pendingChallenges.delete(roomCode);

  // Only turns missed while offline count towards removal — a slow player keeps their seat
  const logged = gameLog.logAutoSkip(cur, playerId, reason);
  const withMissed = reason === 'disconnect' ? engine.incrementMissedTurns(logged, playerId) : logged;
  const missed = withMissed.players[playerId]?.missedTurns ?? 0;

  io.to(roomCode).emit('turn:auto-skipped', { playerId, reason });

  const advance = (latest: Room) => {
    const next = reason === 'disconnect' && missed >= 2
      ? engine.removeFromTurnOrder(latest, playerId)
      : engine.advanceTurn(latest);
    store.set(next);
    io.to(roomCode).emit('room:updated', next);
    void startTurn(roomCode);
  };

  const turn = withMissed.activeRound?.currentTurn;
  if (!card || !turn || !withMissed.activeRound) { advance(withMissed); return; }

  // A drawn card is shown for the usual reveal time (marked wrong, at the spot it belonged)
  const ar = withMissed.activeRound;
  const entityId = engine.activeEntityId(withMissed, turn.activeId);
  const timeline = ar.timelines[entityId] ?? { ownerId: entityId, cards: [] };
  const position = timeline.cards.filter(c => c.releaseYear <= card.releaseYear).length;
  const revealed = gameLog.logFlip(
    { ...withMissed, activeRound: { ...ar, currentTurn: { ...turn, phase: 'flip' } } },
    card.title,
    false,
  );
  store.set(revealed);
  io.to(roomCode).emit('turn:flipped', {
    card,
    correct: false,
    activePlayerId: turn.activeId,
    placedPosition: position,
    updatedTimeline: timeline,
    timelines: ar.timelines,
    tokensUpdated: ar.tokens,
    challengeResults: [],
    timedOut: true,
  });
  io.to(roomCode).emit('room:updated', revealed);

  clearFlipAdvanceTimer(roomCode);
  const timer = setTimeout(() => {
    flipAdvanceTimers.delete(roomCode);
    const latest = store.get(roomCode);
    if (!latest?.activeRound || latest.status !== 'round_active') return;
    advance(latest);
  }, FLIP_REVEAL_DISPLAY_MS);
  flipAdvanceTimers.set(roomCode, timer);
}

function schedulePlaceTurnTimeout(roomCode: string, playerId: string, timeoutMs: number | null): void {
  clearPlaceTurnTimer(roomCode);
  if (timeoutMs === null) return;
  const timer = setTimeout(() => {
    placeTurnTimers.delete(roomCode);
    autoSkipActiveTurn(roomCode, playerId, 'timeout');
  }, timeoutMs);
  placeTurnTimers.set(roomCode, timer);
}

function scheduleDisconnectSkip(roomCode: string, playerId: string): void {
  const existing = disconnectTimers.get(playerId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    disconnectTimers.delete(playerId);
    autoSkipActiveTurn(roomCode, playerId, 'disconnect');
  }, TURN_TIMEOUT_MS);

  disconnectTimers.set(playerId, timer);
}

async function resolveTurnStreamUrl(card: {
  trackId: string;
  previewUrl: string;
  streamUrl?: string | null;
}): Promise<string | null> {
  if (card.streamUrl) return card.streamUrl;
  if (!isSpotifyTrackPageUrl(card.previewUrl)) return card.previewUrl;
  if (process.env.TEST_MODE === 'true') return null;
  try {
    return await fetchEmbedPreviewUrl(card.trackId);
  } catch (err) {
    console.warn(`[Spotify] embed preview failed for ${card.trackId}:`, err);
    return null;
  }
}

/** Stop the full song on the room's Spotify device, if one is playing. */
function pauseSpeaker(room: Room): void {
  turnSpeakers.delete(room.code);
  const deviceId = room.audio.spotify?.deviceId;
  if (deviceId) void spotifyConnect.pause(room.code, deviceId);
}

/**
 * Start the turn's full song on the room's Spotify device. Returns the device for the
 * turn:started payload, or null when the turn should use previews (mode off, or Spotify failed).
 */
async function playOnSpeaker(roomCode: string, card: Card): Promise<{ deviceName: string } | null> {
  turnSpeakers.delete(roomCode);
  const room = store.get(roomCode);
  const speaker = room ? engine.spotifySpeaker(room) : null;
  if (!room || !speaker) return null;
  try {
    await spotifyConnect.play(roomCode, speaker.deviceId, card.trackId);
    const result = { deviceName: speaker.deviceName };
    turnSpeakers.set(roomCode, result);
    return result;
  } catch (err) {
    console.warn(`[Spotify Connect] play failed in ${roomCode}:`, err);
    const latest = store.get(roomCode);
    if (latest) {
      const withLog = gameLog.logSpotifyFallback(latest, speaker.deviceName);
      store.set(withLog);
      io.to(roomCode).emit('room:updated', withLog);
    }
    return null;
  }
}

type TurnStartedPayload = Parameters<ServerToClientEvents['turn:started']>[0];

function buildTurnStartedPayload(
  room: Room,
  activeId: string,
  hidden: CardHidden,
  streamUrl: string | null,
  turnEndsAt: number | null,
  playAt: number,
  speaker: { deviceName: string } | null,
): TurnStartedPayload {
  return {
    activePlayerId: activeId,
    card: hidden,
    previewUrl: hidden.previewUrl,
    streamUrl,
    playAt,
    serverNow: Date.now(),
    timelineLength: engine.timelineLength(room, activeId),
    turnEndsAt,
    speaker,
  };
}

function turnEndsAtFor(room: Room): number | null {
  const ms = placeTimeoutMs(room);
  return ms === null ? null : Date.now() + ms;
}

/** Catch up joiners / reconnects who missed the room-wide turn:started broadcast. */
async function emitTurnSnapshot(
  socket: Socket<ClientToServerEvents, ServerToClientEvents>,
  room: Room,
): Promise<void> {
  const ar = room.activeRound;
  if (room.status !== 'round_active' || !ar?.currentCard || !ar.currentTurn) return;

  if (!pendingCards.get(room.code)) return;

  const activeId = ar.currentTurn.activeId;
  const speaker = turnSpeakers.get(room.code) ?? null;
  const streamUrl = speaker ? null : await resolveTurnStreamUrl(ar.currentCard);
  const inPlacePhase = ar.currentTurn.phase === 'place';

  socket.emit(
    'turn:started',
    buildTurnStartedPayload(
      room,
      activeId,
      ar.currentCard,
      streamUrl,
      turnEndsAtFor(room),
      inPlacePhase && !speaker ? Date.now() + 600 : 0,
      speaker,
    ),
  );
}

async function startTurn(roomCode: string): Promise<void> {
  const room = store.get(roomCode);
  if (!room?.activeRound) return;

  const deck = liveDecks.get(roomCode) ?? [];
  if (deck.length === 0) return;

  const activeId = room.activeRound.turnOrder[room.activeRound.turnIndex];

  // If player bought last turn, auto-skip their turn now
  if (room.activeRound.pendingSkips?.includes(activeId)) {
    const withoutSkip: Room = {
      ...room,
      activeRound: {
        ...room.activeRound,
        pendingSkips: room.activeRound.pendingSkips.filter(id => id !== activeId),
      },
    };
    const advanced = engine.advanceTurn(withoutSkip);
    store.set(advanced);
    io.to(roomCode).emit('turn:auto-skipped', { playerId: activeId, reason: 'buy' });
    io.to(roomCode).emit('room:updated', advanced);
    await startTurn(roomCode);
    return;
  }

  // If the player (or every member of the team) on turn is offline, wait for them or skip
  if (!engine.isEntityConnected(room, activeId)) {
    waitingTurns.set(roomCode, activeId);
    scheduleDisconnectSkip(roomCode, activeId);
    return;
  }
  waitingTurns.delete(roomCode);

  const { card, hidden: baseHidden, remaining } = engine.drawCard(deck);
  const speaker = await playOnSpeaker(roomCode, card);
  const streamUrl = speaker ? null : await resolveTurnStreamUrl(card);
  const hidden = { ...baseHidden, streamUrl };

  liveDecks.set(roomCode, remaining);
  pendingCards.set(roomCode, card);
  pendingChallenges.set(roomCode, []);

  // Re-read: the Spotify fallback may have appended a log line while we awaited
  const latest = store.get(roomCode);
  if (!latest?.activeRound) return;
  const updatedRoom = {
    ...latest,
    activeRound: {
      ...latest.activeRound,
      deckRemaining: remaining.length,
      currentCard: hidden,
      currentTurn: {
        activeId,
        phase: 'place' as const,
        challenges: [],
      },
    },
  };
  store.set(updatedRoom);

  const turnEndsAt = turnEndsAtFor(updatedRoom);
  schedulePlaceTurnTimeout(roomCode, activeId, placeTimeoutMs(updatedRoom));

  io.to(roomCode).emit(
    'turn:started',
    buildTurnStartedPayload(room, activeId, hidden, streamUrl, turnEndsAt, speaker ? 0 : Date.now() + 600, speaker),
  );
}

function resolveAndAdvance(roomCode: string): void {
  clearPlaceTurnTimer(roomCode);
  clearChallengeTimer(roomCode);

  const room = store.get(roomCode);
  const card = pendingCards.get(roomCode);
  if (!room?.activeRound?.currentTurn || !card) return;

  const activePlayerId = room.activeRound.currentTurn.activeId;
  const placedPosition = room.activeRound.currentTurn.placedPosition ?? 0;

  // Inject challenges into currentTurn before resolving
  const roomWithChallenges = {
    ...room,
    activeRound: {
      ...room.activeRound,
      currentTurn: {
        ...room.activeRound.currentTurn,
        challenges: pendingChallenges.get(roomCode) ?? [],
      },
    },
  };

  const { room: flippedRoom, correct, winnerId } = engine.resolveFlip(roomWithChallenges, card);
  pendingCards.delete(roomCode);
  pendingChallenges.delete(roomCode);

  const challenges = roomWithChallenges.activeRound?.currentTurn?.challenges ?? [];
  const challengeResults = challenges.map((c) => ({
    challengerId: c.challengerId,
    outcome: (correct ? 'lost_token' : 'stole_card') as 'stole_card' | 'lost_token',
  }));

  const flippedWithLog = gameLog.logFlipResolution(
    flippedRoom,
    activePlayerId,
    card,
    correct,
    challengeResults,
  );

  const entityId = engine.activeEntityId(flippedWithLog, activePlayerId);
  const updatedTimeline = flippedWithLog.activeRound?.timelines[entityId]
    ?? { ownerId: entityId, cards: [] };
  const tokensUpdated = flippedWithLog.activeRound?.tokens ?? {};
  const timelines = flippedWithLog.activeRound?.timelines ?? {};

  io.to(roomCode).emit('turn:flipped', {
    card,
    correct,
    activePlayerId,
    placedPosition,
    updatedTimeline,
    timelines,
    tokensUpdated,
    challengeResults,
  });

  if (winnerId || flippedWithLog.status === 'round_ended') {
    const summary = engine.buildRoundSummary(flippedWithLog, winnerId ?? null);
    const finalRoom = {
      ...flippedWithLog,
      status: 'round_ended' as const,
      roundHistory: [...flippedWithLog.roundHistory, summary],
    };
    store.set(finalRoom);
    pauseSpeaker(finalRoom);
    io.to(roomCode).emit('room:updated', finalRoom);
    io.to(roomCode).emit('round:ended', { winnerId: winnerId ?? null, summary });
    return;
  }

  // Store the flip now so joins and kicks during the reveal build on it
  store.set(flippedWithLog);
  clearFlipAdvanceTimer(roomCode);
  const timer = setTimeout(() => {
    flipAdvanceTimers.delete(roomCode);
    const current = store.get(roomCode);
    if (!current?.activeRound || current.status !== 'round_active') return;
    // Latest state, not the flip snapshot: players may have joined or been removed meanwhile
    const advancedRoom = engine.advanceTurn(current);
    store.set(advancedRoom);
    io.to(roomCode).emit('room:updated', advancedRoom);
    void startTurn(roomCode);
  }, FLIP_REVEAL_DISPLAY_MS);
  flipAdvanceTimers.set(roomCode, timer);
}

// ---------------------------------------------------------------------------
// Socket.io
// ---------------------------------------------------------------------------

io.on('connection', (socket) => {
  const auth = socket.handshake.auth as SocketAuth;
  // Reassigned when room:join takes over an offline player with the same name
  let sessionId = auth.sessionId;
  const displayName = (auth.displayName ?? '').trim().slice(0, 24) || 'Anonymous';

  console.log(`Client connected: ${socket.id} (session: ${sessionId}, name: ${displayName})`);

  // ------------------------------------------------------------------
  // room:create
  // ------------------------------------------------------------------
  socket.on('room:create', (data) => {
    try {
      const room = engine.createRoom(sessionId, displayName, data.topic);
      store.set(room);
      socket.join(room.code);
      socketSession.set(socket.id, { sessionId, roomCode: room.code });

      socket.emit('room:created', { roomCode: room.code, room, sessionId });
      io.to(room.code).emit('room:updated', room);
    } catch (err) {
      socket.emit('error', err instanceof Error ? err.message : 'Failed to create room');
    }
  });

  // ------------------------------------------------------------------
  // room:join
  // ------------------------------------------------------------------
  socket.on('room:join', (data) => {
    try {
      const existing = store.get(data.roomCode.toUpperCase());
      if (!existing) { socket.emit('error', 'Room not found'); return; }

      // The name is the identity within a room: an offline namesake is taken over
      // (timeline, tokens, team), an online one blocks the name.
      const namesake = engine.findPlayerByName(existing, displayName);
      if (namesake && namesake.id !== sessionId) {
        if (namesake.isConnected) {
          socket.emit('error', `The name "${namesake.displayName}" is already taken in this room`);
          return;
        }
        sessionId = namesake.id;
      }

      let updatedRoom: Room;
      if (existing.players[sessionId] && existing.status === 'round_active') {
        // Player reconnecting mid-game — just mark them connected again
        updatedRoom = engine.markReconnected(existing, sessionId);
      } else {
        updatedRoom = engine.addPlayer(existing, sessionId, displayName);
      }
      store.set(updatedRoom);
      socket.join(updatedRoom.code);
      socketSession.set(socket.id, { sessionId, roomCode: updatedRoom.code });

      // Cancel any pending deletion for this room
      const pendingDelete = pendingDeletes.get(updatedRoom.code);
      if (pendingDelete) { clearTimeout(pendingDelete); pendingDeletes.delete(updatedRoom.code); }

      // Cancel any pending disconnect-skip timer for this player
      const pendingDisconnect = disconnectTimers.get(sessionId);
      if (pendingDisconnect) {
        clearTimeout(pendingDisconnect);
        disconnectTimers.delete(sessionId);
      }

      socket.emit('room:joined', { roomCode: updatedRoom.code, room: updatedRoom, sessionId });
      io.to(updatedRoom.code).emit('room:updated', updatedRoom);

      // Their turn came up while they were away: start it now instead of waiting for the skip
      const waitingFor = waitingTurns.get(updatedRoom.code);
      if (waitingFor && engine.isEntityConnected(updatedRoom, waitingFor)) {
        waitingTurns.delete(updatedRoom.code);
        const skipTimer = disconnectTimers.get(waitingFor);
        if (skipTimer) { clearTimeout(skipTimer); disconnectTimers.delete(waitingFor); }
        void startTurn(updatedRoom.code);
        return;
      }
      void emitTurnSnapshot(socket, updatedRoom);
    } catch (err) {
      socket.emit('error', err instanceof Error ? err.message : 'Failed to join room');
    }
  });

  // ------------------------------------------------------------------
  // room:leave
  // ------------------------------------------------------------------
  socket.on('room:leave', () => {
    const session = socketSession.get(socket.id);
    if (!session) return;
    socketSession.delete(socket.id);
    socket.leave(session.roomCode);

    const room = store.get(session.roomCode);
    if (!room) return;
    const updatedRoom = engine.removePlayer(room, sessionId);
    if (Object.keys(updatedRoom.players).length === 0) {
      purgeRoomRuntime(session.roomCode);
      store.delete(session.roomCode);
      return;
    }
    store.set(updatedRoom);
    io.to(session.roomCode).emit('room:updated', updatedRoom);
    if (engine.allParticipantsOffline(updatedRoom)) {
      scheduleEmptyRoomDeletion(session.roomCode);
    } else if (
      updatedRoom.status === 'round_active' &&
      updatedRoom.activeRound?.turnOrder[updatedRoom.activeRound.turnIndex] === sessionId &&
      updatedRoom.activeRound.currentTurn?.phase === 'place'
    ) {
      scheduleDisconnectSkip(session.roomCode, sessionId);
    }
  });

  // ------------------------------------------------------------------
  // room:kick — owner removes a player, online or offline
  // ------------------------------------------------------------------
  socket.on('room:kick', (data) => {
    const session = socketSession.get(socket.id);
    if (!session) return;
    const room = store.get(session.roomCode);
    if (!room) return;
    if (room.ownerId !== sessionId) { socket.emit('error', 'Only the room owner can remove players'); return; }

    const target = room.players[data.playerId];
    let result: engine.KickResult;
    try {
      result = engine.kickPlayer(room, data.playerId);
    } catch (err) {
      socket.emit('error', err instanceof Error ? err.message : 'Failed to remove player');
      return;
    }

    const roomCode = room.code;
    const kickedId = data.playerId;
    let updated = result.room;
    if (room.status === 'round_active' && target) updated = gameLog.logKick(updated, target.displayName);

    const pendingDisconnect = disconnectTimers.get(kickedId);
    if (pendingDisconnect) { clearTimeout(pendingDisconnect); disconnectTimers.delete(kickedId); }
    const challenges = pendingChallenges.get(roomCode);
    if (challenges) pendingChallenges.set(roomCode, challenges.filter(c => c.challengerId !== kickedId));

    // Their turn ends unplayed: drop the drawn card and every timer, then start the next turn
    if (result.wasOnTurn) {
      if (result.removedEntityId) {
        const t = disconnectTimers.get(result.removedEntityId);
        if (t) { clearTimeout(t); disconnectTimers.delete(result.removedEntityId); }
      }
      clearPlaceTurnTimer(roomCode);
      clearChallengeTimer(roomCode);
      clearFlipAdvanceTimer(roomCode);
      pendingCards.delete(roomCode);
      pendingChallenges.delete(roomCode);
      waitingTurns.delete(roomCode);
    }

    store.set(updated);
    // Tell the room first (the kicked device listens for its own id), then detach its sockets
    io.to(roomCode).emit('player:kicked', { playerId: kickedId });
    for (const [socketId, s] of socketSession) {
      if (s.sessionId !== kickedId || s.roomCode !== roomCode) continue;
      socketSession.delete(socketId);
      io.sockets.sockets.get(socketId)?.leave(roomCode);
    }
    io.to(roomCode).emit('room:updated', updated);
    if (result.wasOnTurn && updated.status === 'round_active') void startTurn(roomCode);
  });

  // ------------------------------------------------------------------
  // round:start
  // ------------------------------------------------------------------
  socket.on('round:start', async (data) => {
    const session = socketSession.get(socket.id);
    if (!session) return;

    const room = store.get(session.roomCode);
    if (!room) { socket.emit('error', 'Room not found'); return; }
    if (room.ownerId !== sessionId) { socket.emit('error', 'Only the room owner can start the round'); return; }
    if (room.status !== 'lobby' && room.status !== 'round_ended') {
      socket.emit('error', 'Round already active'); return;
    }

    try {
      const requestedCards = Math.floor(Number(data.cardsToWin ?? CARDS_TO_WIN_DEFAULT));
      const cardsToWin = Number.isFinite(requestedCards)
        ? Math.max(CARDS_TO_WIN_MIN, requestedCards)
        : CARDS_TO_WIN_DEFAULT;
      const turnSeconds = data.turnSeconds === undefined || !TURN_SECONDS_OPTIONS.includes(data.turnSeconds)
        ? TURN_SECONDS_DEFAULT
        : data.turnSeconds;
      const config: RoundConfig = {
        playlistLabel: data.playlistLabel,
        mode: data.mode,
        cardsToWin,
        turnSeconds,
        tokensEnabled: data.tokensEnabled ?? true,
      };

      const cards = data.playlistLabel
        ? await spotify.getTracksForLabel(data.playlistLabel)
        : await spotify.getRandomTracks(50);

      if (cards.length < Object.keys(room.players).length + 5) {
        socket.emit('error', 'Not enough tracks available to start'); return;
      }

      const { room: initedRoom, deck } = engine.initRound(room, config, cards);
      const initedWithLog = gameLog.logRoundStarted(initedRoom);
      liveDecks.set(session.roomCode, deck);
      store.set(initedWithLog);

      io.to(session.roomCode).emit('round:started', { room: initedWithLog });
      io.to(session.roomCode).emit('room:updated', initedWithLog);

      await startTurn(session.roomCode);
    } catch (err) {
      socket.emit('error', err instanceof Error ? err.message : 'Failed to start round');
    }
  });

  // ------------------------------------------------------------------
  // playlist:preview
  // ------------------------------------------------------------------
  socket.on('playlist:preview', async (data) => {
    const session = socketSession.get(socket.id);
    if (!session) return;

    const room = store.get(session.roomCode);
    if (!room) { socket.emit('error', 'Room not found'); return; }
    if (room.ownerId !== sessionId) { socket.emit('error', 'Only the room owner can preview tracks'); return; }

    try {
      const cards = await spotify.getTracksForLabel(data.playlistLabel);
      socket.emit('playlist:previewed', { cards });
    } catch (err) {
      socket.emit('error', err instanceof Error ? err.message : 'Failed to fetch tracks for preview');
    }
  });

  // ------------------------------------------------------------------
  // turn:place
  // ------------------------------------------------------------------
  socket.on('turn:place', (data) => {
    const session = socketSession.get(socket.id);
    if (!session) return;

    const room = store.get(session.roomCode);
    if (!room?.activeRound) return;

    if (!engine.isActiveParticipant(room, sessionId)) { socket.emit('error', 'Not your turn'); return; }

    try {
      clearPlaceTurnTimer(session.roomCode);
      const challengeEndsAt = Date.now() + CHALLENGE_WINDOW_MS;
      const placedRoom = engine.applyPlacement(room, sessionId, data.position, CHALLENGE_WINDOW_MS);
      const placedWithLog = gameLog.logPlacement(placedRoom, sessionId);
      store.set(placedWithLog);

      io.to(session.roomCode).emit('turn:placed', {
        position: data.position,
        activePlayerId: sessionId,
        challengeEndsAt,
      });
      io.to(session.roomCode).emit('room:updated', placedWithLog);

      clearChallengeTimer(session.roomCode);
      const roomCode = session.roomCode;
      const timer = setTimeout(() => resolveAndAdvance(roomCode), CHALLENGE_WINDOW_MS);
      challengeTimers.set(roomCode, timer);
    } catch (err) {
      socket.emit('error', err instanceof Error ? err.message : 'Placement failed');
    }
  });

  // ------------------------------------------------------------------
  // turn:challenge
  // ------------------------------------------------------------------
  socket.on('turn:challenge', () => {
    const session = socketSession.get(socket.id);
    if (!session) return;

    const room = store.get(session.roomCode);
    if (!room?.activeRound?.currentTurn) return;

    const { currentTurn } = room.activeRound;
    if (currentTurn.phase !== 'challenge') { socket.emit('error', 'Not in challenge phase'); return; }
    if (room.players[sessionId]?.isSpectator) {
      socket.emit('error', 'Spectators cannot challenge');
      return;
    }
    if (engine.isActiveParticipant(room, sessionId)) { socket.emit('error', 'Cannot challenge your own placement'); return; }

    const challenges = pendingChallenges.get(session.roomCode) ?? [];
    if (challenges.some((c) => c.challengerId === sessionId)) {
      socket.emit('error', 'You already shouted HITSTER!');
      return;
    }
    challenges.push({ challengerId: sessionId });
    pendingChallenges.set(session.roomCode, challenges);

    // Mirror into room state so room:updated doesn't wipe the client's "already challenged"
    const withChallenge: Room = {
      ...room,
      activeRound: { ...room.activeRound, currentTurn: { ...currentTurn, challenges: [...challenges] } },
    };
    const withLog = gameLog.logChallenge(withChallenge, sessionId);
    store.set(withLog);
    io.to(session.roomCode).emit('turn:challenged', { challengerId: sessionId });
    io.to(session.roomCode).emit('room:updated', withLog);
  });

  // ------------------------------------------------------------------
  // turn:skip
  // ------------------------------------------------------------------
  socket.on('turn:skip', () => {
    const session = socketSession.get(socket.id);
    if (!session) return;

    const room = store.get(session.roomCode);
    if (!room?.activeRound) return;

    if (!engine.isActiveParticipant(room, sessionId)) { socket.emit('error', 'Not your turn'); return; }

    try {
      clearPlaceTurnTimer(session.roomCode);
      clearChallengeTimer(session.roomCode);
      const skippedRoom = engine.applySkip(room, sessionId);
      const skippedWithLog = gameLog.logSkip(skippedRoom, sessionId);
      pendingCards.delete(session.roomCode);
      store.set(skippedWithLog);
      io.to(session.roomCode).emit('room:updated', skippedWithLog);
      startTurn(session.roomCode);
    } catch (err) {
      socket.emit('error', err instanceof Error ? err.message : 'Skip failed');
    }
  });

  // ------------------------------------------------------------------
  // turn:name
  // ------------------------------------------------------------------
  socket.on('turn:name', (data) => {
    const session = socketSession.get(socket.id);
    if (!session) return;

    const room = store.get(session.roomCode);
    if (!room?.activeRound) return;

    const card = pendingCards.get(session.roomCode);
    if (!card) return;
    if (!engine.isActiveParticipant(room, sessionId)) { socket.emit('error', 'Not your turn'); return; }
    if (room.activeRound.currentTurn?.named) return; // already named this turn

    const titleArtistMatch = naming.titleMatches(data.title, card.title) && naming.artistMatches(data.artist, card.artist);
    const mode = room.activeRound.config.mode;

    // Expert requires exact year too
    const yearMatch = mode !== 'expert' || data.year === card.releaseYear;
    const correct = titleArtistMatch && yearMatch;

    if (correct) {
      const turn = room.activeRound.currentTurn;
      if (!turn) return;
      // Mark the turn as named: Pro/Expert need it to keep the card, and one bonus per turn
      const named: Room = { ...room, activeRound: { ...room.activeRound, currentTurn: { ...turn, named: true } } };
      const bonusAvailable = mode !== 'pro' && mode !== 'expert' && room.activeRound.config.tokensEnabled;
      if (!bonusAvailable) {
        const updatedRoom = gameLog.logNamed(named, sessionId, false, false);
        store.set(updatedRoom);
        io.to(session.roomCode).emit('room:updated', updatedRoom);
      } else {
        // Original/Cooperative: naming bonus (+1 token, max 5)
        const withBonus = engine.applyNamingBonus(named, sessionId);
        const before = room.activeRound.tokens;
        const after = withBonus.activeRound?.tokens ?? {};
        const gained = Object.keys(after).some(k => (after[k] ?? 0) > (before[k] ?? 0));
        const updatedRoom = gameLog.logNamed(withBonus, sessionId, gained, true);
        store.set(updatedRoom);
        io.to(session.roomCode).emit('turn:named', { playerId: sessionId, tokensUpdated: after });
        io.to(session.roomCode).emit('room:updated', updatedRoom);
      }
    }
  });

  // ------------------------------------------------------------------
  // turn:buy
  // ------------------------------------------------------------------
  socket.on('turn:buy', () => {
    const session = socketSession.get(socket.id);
    if (!session) return;

    const room = store.get(session.roomCode);
    if (!room?.activeRound) return;

    if (!engine.isActiveParticipant(room, sessionId)) { socket.emit('error', 'Not your turn'); return; }

    const card = pendingCards.get(session.roomCode);
    if (!card) { socket.emit('error', 'No card to buy'); return; }

    try {
      const bought = engine.applyBuy(room, sessionId, card);
      const updatedRoom = gameLog.logBuy(bought, room.activeRound.currentTurn?.activeId ?? sessionId);
      store.set(updatedRoom);
      pendingChallenges.set(session.roomCode, []);
      const tokensUpdated = updatedRoom.activeRound?.tokens ?? {};
      io.to(session.roomCode).emit('turn:bought', { playerId: sessionId, tokensUpdated });
      io.to(session.roomCode).emit('room:updated', updatedRoom);
      // The bought card is revealed in its spot right away — no challenge window
      resolveAndAdvance(session.roomCode);
    } catch (err) {
      socket.emit('error', err instanceof Error ? err.message : 'Buy failed');
    }
  });

  // ------------------------------------------------------------------
  // team:create
  // ------------------------------------------------------------------
  socket.on('team:create', (data) => {
    const session = socketSession.get(socket.id);
    if (!session) return;
    const room = store.get(session.roomCode);
    if (!room) return;
    try {
      const teamId = randomUUID().slice(0, 8);
      const updatedRoom = engine.createTeam(room, teamId, data.name, sessionId);
      store.set(updatedRoom);
      io.to(session.roomCode).emit('room:updated', updatedRoom);
    } catch (err) {
      socket.emit('error', err instanceof Error ? err.message : 'Failed to create team');
    }
  });

  // ------------------------------------------------------------------
  // team:join
  // ------------------------------------------------------------------
  socket.on('team:join', (data) => {
    const session = socketSession.get(socket.id);
    if (!session) return;
    const room = store.get(session.roomCode);
    if (!room) return;
    try {
      const updatedRoom = engine.joinTeam(room, data.teamId, sessionId);
      store.set(updatedRoom);
      io.to(session.roomCode).emit('room:updated', updatedRoom);
    } catch (err) {
      socket.emit('error', err instanceof Error ? err.message : 'Failed to join team');
    }
  });

  // ------------------------------------------------------------------
  // team:leave
  // ------------------------------------------------------------------
  socket.on('team:leave', () => {
    const session = socketSession.get(socket.id);
    if (!session) return;
    const room = store.get(session.roomCode);
    if (!room) return;
    try {
      const updatedRoom = engine.leaveTeam(room, sessionId);
      store.set(updatedRoom);
      io.to(session.roomCode).emit('room:updated', updatedRoom);
    } catch (err) {
      socket.emit('error', err instanceof Error ? err.message : 'Failed to leave team');
    }
  });

  // ------------------------------------------------------------------
  // room:end
  // ------------------------------------------------------------------
  socket.on('room:end', () => {
    const session = socketSession.get(socket.id);
    if (!session) return;
    const room = store.get(session.roomCode);
    if (!room) return;
    if (room.ownerId !== sessionId) { socket.emit('error', 'Only the room owner can end the game'); return; }
    const endedRoom = engine.endGame(room);
    store.set(endedRoom);
    pauseSpeaker(endedRoom);
    io.to(session.roomCode).emit('room:updated', endedRoom);
  });

  // ------------------------------------------------------------------
  // audio:* — owner picks previews on every device vs. full songs via Spotify
  // ------------------------------------------------------------------
  const ownedRoom = (): Room | null => {
    const session = socketSession.get(socket.id);
    const room = session ? store.get(session.roomCode) : undefined;
    if (!room) return null;
    if (room.ownerId !== sessionId) {
      socket.emit('error', 'Only the room owner can change the audio');
      return null;
    }
    return room;
  };

  socket.on('audio:set-mode', (data) => {
    const room = ownedRoom();
    if (!room) return;
    try {
      const updated = engine.setAudioMode(room, data.mode === 'spotify' ? 'spotify' : 'previews');
      if (updated.audio.mode === 'previews') pauseSpeaker(updated);
      store.set(updated);
      io.to(room.code).emit('room:updated', updated);
    } catch (err) {
      socket.emit('error', err instanceof Error ? err.message : 'Could not change audio');
    }
  });

  socket.on('audio:list-devices', async () => {
    const room = ownedRoom();
    if (!room) return;
    try {
      socket.emit('audio:devices', { devices: await spotifyConnect.listDevices(room.code) });
    } catch (err) {
      socket.emit('error', err instanceof Error ? err.message : 'Could not load Spotify devices');
    }
  });

  socket.on('audio:select-device', async (data) => {
    const room = ownedRoom();
    if (!room) return;
    try {
      const device = (await spotifyConnect.listDevices(room.code)).find(d => d.id === data.deviceId);
      if (!device) { socket.emit('error', 'That Spotify device is not available — open Spotify on it and refresh'); return; }
      const latest = store.get(room.code);
      if (!latest) return;
      const updated = engine.setSpotifyDevice(latest, device.id, device.name);
      store.set(updated);
      io.to(room.code).emit('room:updated', updated);
    } catch (err) {
      socket.emit('error', err instanceof Error ? err.message : 'Could not select the Spotify device');
    }
  });

  socket.on('audio:unlink', () => {
    const room = ownedRoom();
    if (!room) return;
    pauseSpeaker(room);
    spotifyConnect.unlink(room.code);
    const updated = engine.setSpotifyAccount(room, null);
    store.set(updated);
    io.to(room.code).emit('room:updated', updated);
  });

  // ------------------------------------------------------------------
  // disconnect
  // ------------------------------------------------------------------
  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id} (session: ${sessionId})`);

    const session = socketSession.get(socket.id);
    socketSession.delete(socket.id);
    if (!session) return;

    const room = store.get(session.roomCode);
    if (!room) return;

    // A stale socket closing late (phone dropped, player already rejoined) must not mark them offline
    const stillConnected = [...socketSession.values()].some(
      s => s.sessionId === sessionId && s.roomCode === session.roomCode,
    );
    if (stillConnected) return;

    const updatedRoom = engine.markDisconnected(room, sessionId);
    store.set(updatedRoom);
    io.to(session.roomCode).emit('room:updated', updatedRoom);

    if (engine.allParticipantsOffline(updatedRoom)) {
      scheduleEmptyRoomDeletion(session.roomCode);
    } else {
      // Auto-skip only while they must listen and place — not during the challenge window
      const currentTurn = updatedRoom.activeRound?.currentTurn;
      if (
        updatedRoom.status === 'round_active' &&
        updatedRoom.activeRound?.turnOrder[updatedRoom.activeRound.turnIndex] === sessionId &&
        currentTurn?.phase === 'place'
      ) {
        scheduleDisconnectSkip(session.roomCode, sessionId);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || '3000', 10);
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Hitster Online server running on port ${PORT}`);
});
