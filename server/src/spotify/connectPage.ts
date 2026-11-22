import type { Lang } from '../../../shared/types';
import type { SavedLogin } from './connect';

/** localStorage key of the remembered login — same as client/src/spotify.ts */
export const SAVED_LOGIN_KEY = 'hitster_spotify_login';

/*
 * The small HTML page shown in the tab that ran the Spotify Connect login. It is rendered by
 * the server, so it carries its own texts in both UI languages (German is the default).
 */

export type ConnectPageMessage =
  | 'not_configured'
  | 'owner_only'
  | 'expired'
  | 'cancelled'
  | 'room_gone'
  | 'connected'
  | 'not_premium'
  | 'not_allowed'
  | 'failed';

const TEXT: Record<Lang, Record<ConnectPageMessage | 'close_hint', string>> = {
  de: {
    not_configured: 'Spotify ist auf diesem Server nicht eingerichtet.',
    owner_only: 'Du kannst Spotify hier gerade nicht verbinden – du bist nicht im Raum, oder jemand anderes hat Spotify schon verbunden.',
    expired: 'Diese Spotify-Anmeldung ist abgelaufen. Versuch es in der Lobby noch mal.',
    cancelled: 'Die Spotify-Anmeldung wurde abgebrochen.',
    room_gone: 'Den Raum gibt es nicht mehr.',
    connected: 'Spotify verbunden als {name}.',
    not_premium: 'Ganze Songs brauchen Spotify Premium.',
    not_allowed:
      'Dieses Spotify-Konto darf die App noch nicht nutzen (im Spotify-Dashboard unter „User Management“ hinzufügen).',
    failed: 'Die Spotify-Anmeldung hat nicht geklappt.',
    close_hint: 'Du kannst diesen Tab schließen und zurück ins Spiel gehen.',
  },
  en: {
    not_configured: 'Spotify is not configured on this server.',
    owner_only: 'You can\'t connect Spotify here right now — you\'re not in the room, or someone else already connected Spotify.',
    expired: 'This Spotify login expired. Try again from the lobby.',
    cancelled: 'Spotify login was cancelled.',
    room_gone: 'The room no longer exists.',
    connected: 'Spotify connected as {name}.',
    not_premium: 'Full songs need Spotify Premium.',
    not_allowed:
      'This Spotify account is not allowed to use the app yet (add it under User Management in the Spotify dashboard).',
    failed: 'Spotify login failed.',
    close_hint: 'You can close this tab and go back to the game.',
  },
};

/** `lang` query value → UI language; anything but English falls back to German. */
export function parseLang(value: unknown): Lang {
  return value === 'en' ? 'en' : 'de';
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}

/** Full HTML document for a login result; `name` fills the account name of `connected`. */
export function connectResultHtml(
  lang: Lang,
  message: ConnectPageMessage,
  params: { name?: string; saved?: SavedLogin } = {},
): string {
  const text = TEXT[lang];
  // Remember the sealed login in this browser (same origin as the game) so the next room skips the login
  const remember = params.saved
    ? `try{localStorage.setItem(${JSON.stringify(SAVED_LOGIN_KEY)},${JSON.stringify(JSON.stringify(params.saved)).replace(/</g, '\\u003c')})}catch(e){}`
    : '';
  const line = escapeHtml(text[message]).replace('{name}', escapeHtml(params.name ?? ''));
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Hitster · Spotify</title>
<style>body{font-family:system-ui,sans-serif;background:#0b0b12;color:#e5e7eb;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;text-align:center}</style>
</head><body><div><p style="font-size:18px">${line}</p><p style="color:#9ca3af">${escapeHtml(text.close_hint)}</p></div>
<script>${remember}setTimeout(function(){window.close()},1500)</script></body></html>`;
}
