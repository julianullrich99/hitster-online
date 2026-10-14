import { useState, useEffect, useCallback, useRef } from 'react';
import {
  socket,
  createGameSocket,
  getPrimarySessionId,
  saveDisplayName,
  setPrimarySessionId,
  type GameSocket,
} from '../socket/client';
import type { Room, Card, CardHidden, GameMode } from '../../../shared/types';

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
  connectAndCreateRoom: (displayName: string, topic: string) => void;
  connectAndJoinRoom: (displayName: string, roomCode: string) => void;
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
  const localSocketsRef = useRef(new Map<string, GameSocket>());

  useEffect(() => {
    const adoptIdentity = (id: string, code: string) => {
      roomCodeRef.current = code;
      setPrimarySessionId(id);
      setSessionId(id);
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

    socket.on('round:started', ({ room: r }) => {
      setRoom(r);
      setSocketError(null);
      setCurrentCard(null);
      setActivePlayerId(null);
      setPreviewUrl(null);
      setStreamUrl(null);
      setPlayAt(null);
      setTurnEndsAt(null);
      setLastFlip(null);
      setRoundEnded(null);
    });

    socket.on('turn:started', ({ activePlayerId: pid, card, previewUrl: url, streamUrl: su, playAt: pa, serverNow, timelineLength: tl, turnEndsAt: te }) => {
      setActivePlayerId(pid);
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
      setTurnEndsAt(null);
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
      socket.off('round:started');
      socket.off('turn:started');
      socket.off('turn:placed');
      socket.off('turn:challenged');
      socket.off('turn:flipped');
      socket.off('turn:bought');
      socket.off('turn:named');
      socket.off('round:ended');
      socket.off('playlist:previewed');
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

  return {
    room,
    currentCard,
    activePlayerId,
    previewUrl,
    streamUrl,
    playAt,
    turnEndsAt,
    timelineLength,
    lastFlip,
    roundEnded,
    sessionId,
    localPlayers,
    socketError,
    playlistPreviewCards,
    playlistPreviewLoading,
    connectAndCreateRoom,
    connectAndJoinRoom,
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
