/** A remembered Spotify login, sealed by the server (the browser can't read the token). */
export interface SavedSpotifyLogin {
  accountName: string;
  link: string;
}

/** Same key as server/src/spotify/connectPage.ts (the login result page writes it) */
const SAVED_LOGIN_KEY = 'hitster_spotify_login';

export function getSavedSpotifyLogin(): SavedSpotifyLogin | null {
  try {
    const raw = localStorage.getItem(SAVED_LOGIN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedSpotifyLogin>;
    return typeof parsed.accountName === 'string' && typeof parsed.link === 'string'
      ? { accountName: parsed.accountName, link: parsed.link }
      : null;
  } catch {
    return null;
  }
}

export function saveSpotifyLogin(login: SavedSpotifyLogin): void {
  try { localStorage.setItem(SAVED_LOGIN_KEY, JSON.stringify(login)); } catch { /* storage blocked */ }
}

export function forgetSpotifyLogin(): void {
  try { localStorage.removeItem(SAVED_LOGIN_KEY); } catch { /* storage blocked */ }
}

/** True when playback uses a Spotify play link (not an in-browser MP3 preview). */
export function isSpotifyTrackPageUrl(url: string): boolean {
  return /^https:\/\/open\.spotify\.com\/track\//.test(url);
}

/** MP3 stream URL when available (playlist preview); not the turn play-page link. */
export function cardStreamUrl(card: { previewUrl: string; streamUrl?: string | null }): string | null {
  if (card.streamUrl) return card.streamUrl;
  if (!isSpotifyTrackPageUrl(card.previewUrl)) return card.previewUrl;
  return null;
}

/** In-game / turn playback URL from server fields (before client embed fallback). */
export function turnPlayableStream(
  previewUrl: string,
  streamUrl: string | null | undefined,
): string | null {
  if (streamUrl) return streamUrl;
  if (!isSpotifyTrackPageUrl(previewUrl)) return previewUrl;
  return null;
}

/** Resolve 30s preview MP3 via server-side Spotify embed HTML (when Web API has no preview_url). */
export async function fetchEmbedPreviewStream(trackId: string): Promise<string | null> {
  const res = await fetch(`/api/spotify/tracks/${encodeURIComponent(trackId)}/embed-preview`);
  if (!res.ok) {
    throw new Error(`Embed preview failed (${res.status})`);
  }
  const data = (await res.json()) as { streamUrl: string | null };
  return data.streamUrl;
}
