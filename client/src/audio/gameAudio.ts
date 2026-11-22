/**
 * One <audio> element for all turn playback.
 *
 * Browsers (iOS Safari above all) only allow play() without a fresh user gesture on an
 * element that has already been started from a gesture. Turn audio starts from a timer
 * (server-synced playAt), so we "unlock" this shared element with a silent clip on the
 * first tap/click/keypress anywhere on the page and reuse it for every turn.
 */

const SILENT_WAV =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=';

export const gameAudio: HTMLAudioElement | null =
  typeof Audio !== 'undefined' ? new Audio() : null;

if (gameAudio) gameAudio.preload = 'auto';

let unlocked = false;

function unlock(): void {
  const audio = gameAudio;
  if (unlocked || !audio) return;
  // A turn track is already loaded — the caller's own play() covers the unlock.
  if (audio.getAttribute('src') && audio.getAttribute('src') !== SILENT_WAV) return;
  audio.src = SILENT_WAV;
  void audio
    .play()
    .then(() => {
      unlocked = true;
      if (audio.getAttribute('src') === SILENT_WAV) {
        audio.pause();
        audio.removeAttribute('src');
      }
    })
    .catch(() => {
      // Not a qualifying gesture — try again on the next one.
    });
}

/** Install once at startup: unlocks the shared element on the first user gesture. */
export function installAudioUnlock(): void {
  if (typeof window === 'undefined') return;
  const handler = () => {
    unlock();
    if (unlocked) {
      window.removeEventListener('pointerdown', handler, true);
      window.removeEventListener('keydown', handler, true);
      window.removeEventListener('touchend', handler, true);
    }
  };
  window.addEventListener('pointerdown', handler, true);
  window.addEventListener('keydown', handler, true);
  window.addEventListener('touchend', handler, true);
}

// ── Per-device mute ──────────────────────────────────────────────────────────
// With a TV playing the songs, phones can stay quiet. Remembered per browser; the turn
// still "plays" (timers, progress), only the sound is off.

const MUTE_KEY = 'hitster_muted';

function readMuted(): boolean {
  try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; }
}

if (gameAudio) gameAudio.muted = readMuted();

export function isDeviceMuted(): boolean {
  return gameAudio?.muted ?? false;
}

const muteListeners = new Set<(muted: boolean) => void>();

export function setDeviceMuted(muted: boolean): void {
  if (gameAudio) gameAudio.muted = muted;
  try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch { /* storage blocked */ }
  muteListeners.forEach(fn => fn(muted));
}

/** Other players on this device (the TV's Spotify player) follow the mute toggle */
export function onDeviceMutedChange(fn: (muted: boolean) => void): () => void {
  muteListeners.add(fn);
  return () => { muteListeners.delete(fn); };
}
