import { io, Socket } from 'socket.io-client';
import type { ServerToClientEvents, ClientToServerEvents, SocketAuth } from '../../../shared/types';
import { getServerUrl } from '../config';

export type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const SESSION_KEY = 'hitster_session_id';
const NAME_KEY = 'hitster_display_name';

function getOrCreateSessionId(): string {
  let id = sessionStorage.getItem(SESSION_KEY);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(SESSION_KEY, id);
  }
  return id;
}

/** Last used name — kept across tabs and visits so rejoining is one click. */
export function getSavedDisplayName(): string {
  return localStorage.getItem(NAME_KEY) ?? '';
}

export function saveDisplayName(name: string): void {
  localStorage.setItem(NAME_KEY, name);
}

const LAST_ROOM_KEY = 'hitster_last_room';

/**
 * The room this browser was last in, kept across reloads and closed tabs so the entry
 * page can offer a one-click rejoin. The session id lets the rejoin take the seat back
 * even while the server still holds the old (dropped) connection.
 */
export interface LastRoom {
  roomCode: string;
  sessionId: string;
  displayName: string;
}

export function getLastRoom(): LastRoom | null {
  try {
    const raw = localStorage.getItem(LAST_ROOM_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LastRoom>;
    if (typeof parsed.roomCode !== 'string' || typeof parsed.sessionId !== 'string' || typeof parsed.displayName !== 'string') {
      return null;
    }
    return { roomCode: parsed.roomCode, sessionId: parsed.sessionId, displayName: parsed.displayName };
  } catch {
    return null;
  }
}

export function saveLastRoom(lastRoom: LastRoom): void {
  try { localStorage.setItem(LAST_ROOM_KEY, JSON.stringify(lastRoom)); } catch { /* storage blocked */ }
}

export function clearLastRoom(): void {
  try { localStorage.removeItem(LAST_ROOM_KEY); } catch { /* storage blocked */ }
}

/** Persist the identity the server bound us to (changes when we took over a namesake). */
export function setPrimarySessionId(id: string): void {
  sessionStorage.setItem(SESSION_KEY, id);
  socket.auth = { ...(socket.auth as SocketAuth), sessionId: id };
}

export function getPrimarySessionId(): string {
  return getOrCreateSessionId();
}

export function createGameSocket(auth: SocketAuth): GameSocket {
  return io(getServerUrl(), { auth, autoConnect: false });
}

/** This device's main player. Extra hot-seat players get their own socket via createGameSocket. */
export const socket: GameSocket = createGameSocket({
  sessionId: getOrCreateSessionId(),
  displayName: getSavedDisplayName(),
});
