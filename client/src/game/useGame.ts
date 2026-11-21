import { useState, useEffect, useCallback, useRef } from 'react';
import {
  socket,
  createGameSocket,
  getPrimarySessionId,
  saveDisplayName,
  setPrimarySessionId,
  saveLastRoom,
  clearLastRoom,
  type GameSocket,
  type LastRoom,
} from '../socket/client';
import type { SocketAuth, Room, Card, CardHidden, GameMode, AudioMode, SpotifyDevice } from '../../../shared/types';
import { getServerUrl } from '../config';

/** Extra player sharing this device (hot-seat). Has its own socket and server identity. */
export interface LocalPlayer {
  id: string;
  name: string;
}

export interface GameState {
  room: Room | null;
  currentCard: CardHidden | null;
  activePlayerId: string | null;
  previewUrl: string | null;
  streamUrl: string | null;
  playAt: number | null;
  /** Set when this turn's full song plays on the room's Spotify device (this device stays silent) */
  speaker: { deviceName: string } | null;
  turnEndsAt: number | null;
  timelineLength: number;
  lastFlip: {
    card: Card;
    correct: boolean;
    activePlayerId: string;
    placedPosition: number;
    challengeResults: Array<{ challengerId: string; outcome: 'stole_card' | 'lost_token' }>;
  } | null;
  roundEnded: { winnerId: string | null } | null;
  /** Server identity of this device's main player */
  sessionId: string;
  localPlayers: LocalPlayer[];
  socketError: string | null;
  playlistPreviewCards: Card[] | null;
  playlistPreviewLoading: boolean;
  /** Spotify Connect devices of the linked account (owner only, after listSpotifyDevices) */
  spotifyDevices: SpotifyDevice[] | null;
  setAudioMode: (mode: AudioMode) => void;
  connectSpotify: () => void;
  listSpotifyDevices: () => void;
  selectSpotifyDevice: (deviceId: string) => void;
  unlinkSpotify: () => void;
  connectAndCreateRoom: (displayName: string, topic: string) => void;
  connectAndJoinRoom: (displayName: string, roomCode: string) => void;
  /** Take back the seat from the last room this browser was in */
  rejoinLastRoom: (lastRoom: LastRoom) => void;
  /** Owner removes a player from the room */
  kickPlayer: (playerId: string) => void;
  addLocalPlayer: (name: string) => void;
  removeLocalPlayer: (id: string) => void;
  leaveRoom: () => void;
  startRound: (mode: GameMode, playlistLabel?: string, cardsToWin?: number, turnSeconds?: number | null, tokensEnabled?: boolean) => void;
  // Turn actions take the acting player's id (main player or a local hot-seat player)
  placeCard: (actorId: string, position: number) => void;
  challengeCard: (actorId: string) => void;
  skipCard: (actorId: string) => void;
  nameSong: (actorId: string, title: string, artist: string, year?: number) => void;
  buyCard: (actorId: string) => void;
  dismissRoundEnd: () => void;
  createTeam: (name: string) => void;
  joinTeam: (teamId: string) => void;
  leaveTeam: () => void;
  previewPlaylist: (playlistLabel: string) => void;
  clearPlaylistPreview: () => void;
  endGame: () => void;
}

/** Restore turn UI when joining or reconnecting mid-round (before turn:started snapshot). */
function hydrateTurnFromRoom(r: Room): {
  activePlayerId: string | null;
  currentCard: CardHidden | null;
  previewUrl: string | null;
  streamUrl: string | null;
} {
  const ar = r.activeRound;
  if (r.status !== 'round_active' || !ar?.currentTurn?.activeId) {
    return { activePlayerId: null, currentCard: null, previewUrl: null, streamUrl: null };
  }
  const card = ar.currentCard ?? null;
  return {
    activePlayerId: ar.currentTurn.activeId,
    currentCard: card,
    previewUrl: card?.previewUrl ?? null,
    streamUrl: card?.streamUrl ?? null,
  };
}

export function useGame(): GameState {
  const [room, setRoom] = useState<Room | null>(null);
  const [currentCard, setCurrentCard] = useState<CardHidden | null>(null);
  const [activePlayerId, setActivePlayerId] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [playAt, setPlayAt] = useState<number | null>(null);
  const [speaker, setSpeaker] = useState<{ deviceName: string } | null>(null);
  const [spotifyDevices, setSpotifyDevices] = useState<SpotifyDevice[] | null>(null);
  const [turnEndsAt, setTurnEndsAt] = useState<number | null>(null);
  const [timelineLength, setTimelineLength] = useState(0);
  const [lastFlip, setLastFlip] = useState<GameState['lastFlip']>(null);
  const [roundEnded, setRoundEnded] = useState<{ winnerId: string | null } | null>(null);
  const [sessionId, setSessionId] = useState(getPrimarySessionId);
  const [localPlayers, setLocalPlayers] = useState<LocalPlayer[]>([]);
  const [socketError, setSocketError] = useState<string | null>(null);
  const [playlistPreviewCards, setPlaylistPreviewCards] = useState<Card[] | null>(null);
  const [playlistPreviewLoading, setPlaylistPreviewLoading] = useState(false);

  // Room we are in — used to rejoin automatically after the socket reconnects
  // (phone screen lock, flaky Wi-Fi), otherwise the player would stay "offline".
  const roomCodeRef = useRef<string | null>(null);
  const sessionIdRef = useRef(sessionId);
  const localSocketsRef = useRef(new Map<string, GameSocket>());

  useEffect(() => {
    const adoptIdentity = (id: string, code: string) => {
      roomCodeRef.current = code;
      sessionIdRef.current = id;
      setPrimarySessionId(id);
      setSessionId(id);
      const displayName = (socket.auth as SocketAuth | undefined)?.displayName ?? '';
      saveLastRoom({ roomCode: code, sessionId: id, displayName });
    };

    const dropLocalPlayer = (id: string) => {
      const localSocket = localSocketsRef.current.get(id);
      if (!localSocket) return;
      localSocketsRef.current.delete(id);
      localSocket.removeAllListeners();
      localSocket.disconnect();
      setLocalPlayers(prev => prev.filter(p => p.id !== id));
    };

    socket.on('connect', () => {
      if (roomCodeRef.current) socket.emit('room:join', { roomCode: roomCodeRef.current });
    });

    socket.on('room:created', ({ room: r, roomCode, sessionId: id }) => {
      adoptIdentity(id, roomCode);
      setRoom(r);
      setRoundEnded(null);
      setLastFlip(null);
      setSocketError(null);
    });

    socket.on('room:joined', ({ room: r, roomCode, sessionId: id }) => {
      adoptIdentity(id, roomCode);
      setRoom(r);
      setRoundEnded(null);
      setLastFlip(null);
      setSocketError(null);
      const hydrated = hydrateTurnFromRoom(r);
      setActivePlayerId(hydrated.activePlayerId);
      setCurrentCard(hydrated.currentCard);
      setPreviewUrl(hydrated.previewUrl);
      setStreamUrl(hydrated.streamUrl);
      setPlayAt(null);
      setTurnEndsAt(null);
    });

    socket.on('room:updated', (r) => {
      setRoom(r);
    });

    socket.on('player:kicked', ({ playerId }) => {
      if (localSocketsRef.current.has(playerId)) {
        dropLocalPlayer(playerId);
        return;
      }
      if (playerId !== sessionIdRef.current) return;
      // Removed by the host: back to the entry page, no automatic rejoin
      roomCodeRef.current = null;
      clearLastRoom();
      for (const id of [...localSocketsRef.current.keys()]) dropLocalPlayer(id);
      setRoom(null);
      setCurrentCard(null);
      setActivePlayerId(null);
      setPreviewUrl(null);
      setStreamUrl(null);
      setPlayAt(null);
      setSpeaker(null);
      setTurnEndsAt(null);
      setLastFlip(null);
      setRoundEnded(null);
      setSocketError('You were removed from the room by the host.');
    });

    socket.on('round:started', ({ room: r }) => {
      setRoom(r);
      setSocketError(null);
      setCurrentCard(null);
      setActivePlayerId(null);
      setPreviewUrl(null);
      setStreamUrl(null);
      setPlayAt(null);
      setSpeaker(null);
      setTurnEndsAt(null);
      setLastFlip(null);
      setRoundEnded(null);
    });

    socket.on('turn:started', ({ activePlayerId: pid, card, previewUrl: url, streamUrl: su, playAt: pa, serverNow, timelineLength: tl, turnEndsAt: te, speaker: sp }) => {
      setActivePlayerId(pid);
      setSpeaker(sp ?? null);
      setCurrentCard(card);
      setPreviewUrl(url);
      setStreamUrl(su ?? null);
      // Convert to the local clock: device clocks are often off by seconds, and comparing
      // server time against Date.now() delayed or dropped playback entirely.
      setPlayAt(pa > 0 ? Date.now() + Math.min(Math.max(0, pa - serverNow), 5_000) : null);
      setTurnEndsAt(te);
      setTimelineLength(tl);
      setLastFlip(null);
      // New turns start in place phase; mid-turn join snapshots must keep challenge/flip state.
      setRoom(prev => {
        if (!prev?.activeRound) return prev;
        const serverTurn = prev.activeRound.currentTurn;
        if (
          serverTurn?.activeId === pid &&
          (serverTurn.phase === 'challenge' || serverTurn.phase === 'flip')
        ) {
          return {
            ...prev,
            activeRound: {
              ...prev.activeRound,
              currentCard: card,
            },
          };
        }
        return {
          ...prev,
          activeRound: {
            ...prev.activeRound,
            currentCard: card,
            currentTurn: { activeId: pid, phase: 'place' as const, challenges: [] },
          },
        };
      });
    });

    socket.on('turn:placed', ({ activePlayerId: pid, position, challengeEndsAt }) => {
      setActivePlayerId(pid);
      setRoom((prev) => {
        if (!prev?.activeRound?.currentTurn) return prev;
        return {
          ...prev,
          activeRound: {
            ...prev.activeRound,
            currentTurn: {
              ...prev.activeRound.currentTurn,
              activeId: pid,
              phase: 'challenge' as const,
              placedPosition: position,
              challengeDeadline: challengeEndsAt,
              challenges: prev.activeRound.currentTurn.challenges ?? [],
            },
          },
        };
      });
    });

    socket.on('turn:challenged', ({ challengerId }) => {
      setRoom((prev) => {
        if (!prev?.activeRound?.currentTurn) return prev;
        const existing = prev.activeRound.currentTurn.challenges ?? [];
        if (existing.some((c) => c.challengerId === challengerId)) return prev;
        return {
          ...prev,
          activeRound: {
            ...prev.activeRound,
            currentTurn: {
              ...prev.activeRound.currentTurn,
              challenges: [...existing, { challengerId }],
            },
          },
        };
      });
    });

    socket.on('turn:flipped', ({
      card,
      correct,
      activePlayerId: flipActiveId,
      placedPosition: flipPosition,
      timelines,
      tokensUpdated,
      challengeResults,
    }) => {
      setLastFlip({
        card,
        correct,
        activePlayerId: flipActiveId,
        placedPosition: flipPosition,
        challengeResults,
      });
      setCurrentCard(null);
      setTurnEndsAt(null);
      setRoom((prev) => {
        if (!prev || !prev.activeRound) return prev;
        const turn = prev.activeRound.currentTurn;
        return {
          ...prev,
          activeRound: {
            ...prev.activeRound,
            timelines,
            tokens: tokensUpdated,
            currentTurn: turn
              ? { ...turn, phase: 'flip' as const, placedPosition: undefined }
              : turn,
          },
        };
      });
    });

    socket.on('turn:bought', ({ tokensUpdated }) => {
      setRoom((prev) => {
        if (!prev || !prev.activeRound) return prev;
        return { ...prev, activeRound: { ...prev.activeRound, tokens: tokensUpdated } };
      });
    });

    socket.on('turn:named', ({ tokensUpdated }) => {
      setRoom((prev) => {
        if (!prev || !prev.activeRound) return prev;
        return {
          ...prev,
          activeRound: {
            ...prev.activeRound,
            tokens: tokensUpdated,
          },
        };
      });
    });

    socket.on('round:ended', ({ winnerId }) => {
      setRoundEnded({ winnerId });
      setCurrentCard(null);
      setActivePlayerId(null);
      setPreviewUrl(null);
      setStreamUrl(null);
      setPlayAt(null);
      setSpeaker(null);
      setTurnEndsAt(null);
    });

    socket.on('audio:devices', ({ devices }) => {
      setSpotifyDevices(devices);
    });

    socket.on('playlist:previewed', ({ cards }) => {
      setPlaylistPreviewCards(cards);
      setPlaylistPreviewLoading(false);
    });

    socket.on('error', (msg) => {
      console.error('[hitster socket error]', msg);
      setSocketError(typeof msg === 'string' ? msg : (msg as { message?: string })?.message ?? 'An error occurred');
      setPlaylistPreviewLoading(false);
    });

    return () => {
      socket.off('connect');
      socket.off('room:created');
      socket.off('room:joined');
      socket.off('room:updated');
      socket.off('player:kicked');
      socket.off('round:started');
      socket.off('turn:started');
      socket.off('turn:placed');
      socket.off('turn:challenged');
      socket.off('turn:flipped');
      socket.off('turn:bought');
      socket.off('turn:named');
      socket.off('round:ended');
      socket.off('playlist:previewed');
      socket.off('audio:devices');
      socket.off('error');
    };
  }, []);

  const applySocketAuth = useCallback((displayName: string) => {
    saveDisplayName(displayName);
    socket.auth = { sessionId: getPrimarySessionId(), displayName };
  }, []);

  const ensureConnected = useCallback((onConnected: () => void) => {
    if (socket.connected) {
      onConnected();
      return;
    }
    socket.once('connect', onConnected);
    if (!socket.active) {
      socket.connect();
    }
  }, []);

  const connectAndCreateRoom = useCallback((displayName: string, topic: string) => {
    applySocketAuth(displayName);
    const trimmed = topic.trim();
    ensureConnected(() => socket.emit('room:create', { topic: trimmed }));
  }, [applySocketAuth, ensureConnected]);

  const connectAndJoinRoom = useCallback((displayName: string, roomCode: string) => {
    applySocketAuth(displayName);
    const code = roomCode.trim().toUpperCase();
    ensureConnected(() => socket.emit('room:join', { roomCode: code }));
  }, [applySocketAuth, ensureConnected]);

  const rejoinLastRoom = useCallback((lastRoom: LastRoom) => {
    // The server binds the identity at handshake — reconnect if this socket has another one
    const reconnect = socket.connected && (socket.auth as SocketAuth | undefined)?.sessionId !== lastRoom.sessionId;
    setPrimarySessionId(lastRoom.sessionId);
    sessionIdRef.current = lastRoom.sessionId;
    setSessionId(lastRoom.sessionId);
    applySocketAuth(lastRoom.displayName);
    if (reconnect) socket.disconnect();
    ensureConnected(() => socket.emit('room:join', { roomCode: lastRoom.roomCode }));
  }, [applySocketAuth, ensureConnected]);

  const kickPlayer = useCallback((playerId: string) => {
    socket.emit('room:kick', { playerId });
  }, []);

  /** Socket that acts for the given player — the main socket or a hot-seat player's socket. */
  const socketFor = useCallback(
    (actorId: string): GameSocket => localSocketsRef.current.get(actorId) ?? socket,
    [],
  );

  const addLocalPlayer = useCallback((name: string) => {
    const roomCode = roomCodeRef.current;
    const displayName = name.trim();
    if (!roomCode || !displayName) return;

    const localSocket = createGameSocket({ sessionId: crypto.randomUUID(), displayName });
    let joinedId: string | null = null;

    localSocket.on('connect', () => {
      if (roomCodeRef.current) localSocket.emit('room:join', { roomCode: roomCodeRef.current });
    });
    localSocket.on('room:joined', ({ sessionId: id }) => {
      if (joinedId) return; // reconnect — identity unchanged
      joinedId = id;
      localSocket.auth = { sessionId: id, displayName };
      localSocketsRef.current.set(id, localSocket);
      setSocketError(null);
      setLocalPlayers(prev => (prev.some(p => p.id === id) ? prev : [...prev, { id, name: displayName }]));
    });
    localSocket.on('error', (msg) => {
      setSocketError(typeof msg === 'string' ? msg : 'An error occurred');
      if (!joinedId) {
        localSocket.removeAllListeners();
        localSocket.disconnect();
      }
    });
    localSocket.connect();
  }, []);

  const removeLocalPlayer = useCallback((id: string) => {
    const localSocket = localSocketsRef.current.get(id);
    if (!localSocket) return;
    localSocket.emit('room:leave');
    localSocketsRef.current.delete(id);
    setLocalPlayers(prev => prev.filter(p => p.id !== id));
    // Give the leave packet a moment to flush before closing the connection
    setTimeout(() => {
      localSocket.removeAllListeners();
      localSocket.disconnect();
    }, 300);
  }, []);

  const leaveRoom = useCallback(() => {
    roomCodeRef.current = null;
    clearLastRoom();
    socket.emit('room:leave');
    for (const localSocket of localSocketsRef.current.values()) localSocket.emit('room:leave');
    setTimeout(() => window.location.reload(), 200);
  }, []);

  const startRound = useCallback((mode: GameMode, playlistLabel?: string, cardsToWin?: number, turnSeconds?: number | null, tokensEnabled?: boolean) => {
    socket.emit('round:start', { mode, playlistLabel, cardsToWin, turnSeconds, tokensEnabled });
  }, []);

  const placeCard = useCallback((actorId: string, position: number) => {
    socketFor(actorId).emit('turn:place', { position });
  }, [socketFor]);

  const challengeCard = useCallback((actorId: string) => {
    socketFor(actorId).emit('turn:challenge');
  }, [socketFor]);

  const skipCard = useCallback((actorId: string) => {
    socketFor(actorId).emit('turn:skip');
  }, [socketFor]);

  const nameSong = useCallback((actorId: string, title: string, artist: string, year?: number) => {
    socketFor(actorId).emit('turn:name', { title, artist, year });
  }, [socketFor]);

  const buyCard = useCallback((actorId: string) => {
    socketFor(actorId).emit('turn:buy');
  }, [socketFor]);

  const dismissRoundEnd = useCallback(() => {
    setRoundEnded(null);
  }, []);

  const createTeam = useCallback((name: string) => {
    socket.emit('team:create', { name });
  }, []);

  const joinTeam = useCallback((teamId: string) => {
    socket.emit('team:join', { teamId });
  }, []);

  const leaveTeam = useCallback(() => {
    socket.emit('team:leave');
  }, []);

  const previewPlaylist = useCallback((playlistLabel: string) => {
    setPlaylistPreviewLoading(true);
    setPlaylistPreviewCards(null);
    socket.emit('playlist:preview', { playlistLabel });
  }, []);

  const clearPlaylistPreview = useCallback(() => {
    setPlaylistPreviewCards(null);
    setPlaylistPreviewLoading(false);
  }, []);

  const endGame = useCallback(() => {
    socket.emit('room:end');
  }, []);

  const setAudioMode = useCallback((mode: AudioMode) => {
    socket.emit('audio:set-mode', { mode });
  }, []);

  /** Opens Spotify's login in a new tab — must run inside the click handler (popup blockers). */
  const connectSpotify = useCallback(() => {
    const roomCode = roomCodeRef.current;
    if (!roomCode) return;
    const params = new URLSearchParams({ room: roomCode, session: getPrimarySessionId() });
    window.open(`${getServerUrl()}/api/spotify/connect/login?${params}`, '_blank');
  }, []);

  const listSpotifyDevices = useCallback(() => {
    socket.emit('audio:list-devices');
  }, []);

  const selectSpotifyDevice = useCallback((deviceId: string) => {
    socket.emit('audio:select-device', { deviceId });
  }, []);

  const unlinkSpotify = useCallback(() => {
    setSpotifyDevices(null);
    socket.emit('audio:unlink');
  }, []);

  return {
    room,
    currentCard,
    activePlayerId,
    previewUrl,
    streamUrl,
    playAt,
    speaker,
    turnEndsAt,
    timelineLength,
    lastFlip,
    roundEnded,
    sessionId,
    localPlayers,
    socketError,
    playlistPreviewCards,
    playlistPreviewLoading,
    spotifyDevices,
    setAudioMode,
    connectSpotify,
    listSpotifyDevices,
    selectSpotifyDevice,
    unlinkSpotify,
    connectAndCreateRoom,
    connectAndJoinRoom,
    rejoinLastRoom,
    kickPlayer,
    addLocalPlayer,
    removeLocalPlayer,
    leaveRoom,
    startRound,
    placeCard,
    challengeCard,
    skipCard,
    nameSong,
    buyCard,
    dismissRoundEnd,
    createTeam,
    joinTeam,
    leaveTeam,
    previewPlaylist,
    clearPlaylistPreview,
    endGame,
  };
}
