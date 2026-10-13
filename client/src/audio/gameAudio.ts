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
