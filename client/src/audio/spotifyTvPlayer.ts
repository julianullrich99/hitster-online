import { useCallback, useEffect, useRef, useState } from 'react';
import type { Room } from '../../../shared/types';
import { socket } from '../socket/client';
import { isDeviceMuted, onDeviceMutedChange } from './gameAudio';

/*
 * The TV screen as a Spotify Connect device: Spotify's Web Playback SDK plays the full songs
 * right in this browser tab, so the TV needs no Spotify app. The server hands this tab a
 * short-lived access token of the room's linked account (audio:player-token) and makes the
 * player the room's device once it is ready (audio:tv-ready). The server still starts every
 * song — this tab only plays what Spotify sends it.
 */

const SDK_URL = 'https://sdk.scdn.co/spotify-player.js';

// ── Minimal typings of the Web Playback SDK (only what we use) ──
interface SdkError { message: string }
interface SdkReady { device_id: string }
interface SpotifySdkPlayer {
  connect(): Promise<boolean>;
  disconnect(): void;
  activateElement(): Promise<void>;
  setVolume(volume: number): Promise<void>;
  addListener(event: 'ready' | 'not_ready', cb: (data: SdkReady) => void): boolean;
  addListener(
    event: 'initialization_error' | 'authentication_error' | 'account_error' | 'playback_error',
    cb: (err: SdkError) => void,
  ): boolean;
}
interface SpotifySdk {
  Player: new (options: {
    name: string;
    getOAuthToken: (cb: (token: string) => void) => void;
    volume?: number;
  }) => SpotifySdkPlayer;
}
declare global {
  interface Window {
    Spotify?: SpotifySdk;
    onSpotifyWebPlaybackSDKReady?: () => void;
  }
}

let sdkPromise: Promise<SpotifySdk> | null = null;

function loadSdk(): Promise<SpotifySdk> {
  if (window.Spotify) return Promise.resolve(window.Spotify);
  if (!sdkPromise) {
    sdkPromise = new Promise((resolve, reject) => {
      window.onSpotifyWebPlaybackSDKReady = () => (window.Spotify ? resolve(window.Spotify) : reject(new Error('sdk')));
      const script = document.createElement('script');
      script.src = SDK_URL;
      script.async = true;
      script.onerror = () => { sdkPromise = null; reject(new Error('sdk')); };
      document.head.appendChild(script);
    });
  }
  return sdkPromise;
}

export type TvPlayerStatus =
  | 'off'           // no Spotify account linked
  | 'starting'
  | 'ready'         // this tab is a Spotify device
  | 'unsupported'   // browser can't play Spotify (no DRM, e.g. phones, many smart-TV browsers)
  | 'reconnect'     // linked login lacks the playback permission — connect Spotify again
  | 'not_premium'
  | 'failed';

/** Runs the in-browser Spotify player while the room has a linked account. */
export function useSpotifyTvPlayer(room: Room): { status: TvPlayerStatus; activate: () => void } {
  const spotify = room.audio.spotify;
  // A new account (or a re-link) needs a fresh player
  const linkKey = spotify ? `${spotify.linkedBy}:${spotify.accountName}` : null;
  const [status, setStatus] = useState<TvPlayerStatus>('off');
  const playerRef = useRef<SpotifySdkPlayer | null>(null);
  const roomCode = room.code;

  useEffect(() => {
    if (!linkKey) { setStatus('off'); return; }
    let cancelled = false;
    setStatus('starting');

    const fail = (s: TvPlayerStatus) => { if (!cancelled) setStatus(s); };

    loadSdk()
      .then(sdk => {
        if (cancelled) return;
        const player = new sdk.Player({
          name: `Hitster TV (${roomCode})`,
          volume: isDeviceMuted() ? 0 : 1,
          getOAuthToken: cb => {
            socket.emit('audio:player-token', res => {
              if (res.ok) cb(res.accessToken);
              else fail(res.reason === 'missing_scope' ? 'reconnect' : 'failed');
            });
          },
        });
        player.addListener('ready', ({ device_id }) => {
          if (cancelled) return;
          setStatus('ready');
          socket.emit('audio:tv-ready', { deviceId: device_id, deviceName: `📺 Hitster TV` });
        });
        player.addListener('not_ready', () => fail('starting'));
        player.addListener('initialization_error', () => fail('unsupported'));
        player.addListener('authentication_error', () => fail('reconnect'));
        player.addListener('account_error', () => fail('not_premium'));
        player.addListener('playback_error', err => console.warn('[Spotify TV] playback error:', err.message));
        playerRef.current = player;
        void player.connect().then(ok => { if (!ok) fail('failed'); });
      })
      .catch(() => fail('failed'));

    const offMute = onDeviceMutedChange(muted => { void playerRef.current?.setVolume(muted ? 0 : 1); });

    return () => {
      cancelled = true;
      offMute();
      playerRef.current?.disconnect();
      playerRef.current = null;
    };
  }, [linkKey, roomCode]);

  /** Must run inside a click/key handler: browsers only let the player sound after a gesture */
  const activate = useCallback(() => { void playerRef.current?.activateElement(); }, []);

  return { status, activate };
}
