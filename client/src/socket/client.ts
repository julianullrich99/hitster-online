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
