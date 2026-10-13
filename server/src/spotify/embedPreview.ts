const EMBED_TRACK_URL =
  'https://open.spotify.com/embed/track';
const SPOTIFY_TRACK_ID = /^[A-Za-z0-9]{22}$/;
const PREVIEW_MP3 = /^https:\/\/p\.scdn\.co\/mp3-preview\//;

/** Parse audioPreview.url from Spotify embed SSR HTML (__NEXT_DATA__). */
export function extractEmbedPreviewUrl(html: string): string | null {
  const match = html.match(
    /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
  );
  if (!match) return null;

  try {
    const data = JSON.parse(match[1]) as {
      props?: {
        pageProps?: {
          state?: {
            data?: {
              entity?: {
                audioPreview?: { url?: string };
              };
            };
          };
        };
      };
    };
    const url = data?.props?.pageProps?.state?.data?.entity?.audioPreview?.url;
    if (typeof url === 'string' && PREVIEW_MP3.test(url)) return url;
    return null;
  } catch {
    return null;
  }
}

export function isValidSpotifyTrackId(trackId: string): boolean {
  return SPOTIFY_TRACK_ID.test(trackId);
}

export function isSpotifyTrackPageUrl(url: string): boolean {
  return /^https:\/\/open\.spotify\.com\/track\//.test(url);
}

export async function fetchEmbedPreviewUrl(trackId: string): Promise<string | null> {
  if (!isValidSpotifyTrackId(trackId)) {
    throw new Error('Invalid Spotify track ID');
  }

  const url = `${EMBED_TRACK_URL}/${trackId}?utm_source=generator`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; HitsterOnline/1.0)',
      Accept: 'text/html',
    },
  });

  if (!res.ok) {
    throw new Error(`Spotify embed fetch failed: ${res.status}`);
  }

  const html = await res.text();
  return extractEmbedPreviewUrl(html);
}

/** Spotify throttles embed requests (HTTP 429) — callers should pause, not retry. */
export class EmbedRateLimitError extends Error {
  constructor() {
    super('Spotify is throttling requests right now — try again in a few minutes.');
    this.name = 'EmbedRateLimitError';
  }
}

/** Track reference from a playlist embed page (no release year — look that up via the API). */
export interface EmbedPlaylistTrack {
  trackId: string;
  title: string;
  artist: string;
  previewUrl: string | null;
}

/**
 * Parse trackList from Spotify playlist embed SSR HTML. The Web API no longer returns
 * playlist contents to Client Credentials dev apps; the public embed lists up to 100 tracks.
 */
export function extractEmbedPlaylistTracks(html: string): EmbedPlaylistTrack[] {
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return [];
  try {
    const data = JSON.parse(match[1]) as {
      props?: { pageProps?: { state?: { data?: { entity?: { trackList?: Array<{
        uri?: string;
        title?: string;
        subtitle?: string;
        audioPreview?: { url?: string };
      }> } } } } };
    };
    const list = data?.props?.pageProps?.state?.data?.entity?.trackList ?? [];
    const tracks: EmbedPlaylistTrack[] = [];
    for (const item of list) {
      const trackId = item.uri?.match(/^spotify:track:([A-Za-z0-9]{22})$/)?.[1];
      if (!trackId || !item.title) continue;
      const preview = item.audioPreview?.url;
      tracks.push({
        trackId,
        title: item.title,
        artist: item.subtitle ?? '',
        previewUrl: typeof preview === 'string' && PREVIEW_MP3.test(preview) ? preview : null,
      });
    }
    return tracks;
  } catch {
    return [];
  }
}

export async function fetchEmbedPlaylistTracks(playlistId: string): Promise<EmbedPlaylistTrack[]> {
  if (!/^[A-Za-z0-9]{22}$/.test(playlistId)) {
    throw new Error('Invalid Spotify playlist ID');
  }
  const res = await fetch(`https://open.spotify.com/embed/playlist/${playlistId}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; HitsterOnline/1.0)',
      Accept: 'text/html',
    },
  });
  if (res.status === 429) throw new EmbedRateLimitError();
  if (!res.ok) {
    throw new Error(`Spotify playlist embed fetch failed: ${res.status}`);
  }
  return extractEmbedPlaylistTracks(await res.text());
}

/** Track metadata from the public track embed page — costs no Web API quota. */
export interface EmbedTrack {
  trackId: string;
  title: string;
  artists: string[];
  releaseYear: number | null;
  albumArt: string;
  previewUrl: string | null;
}

export function extractEmbedTrack(html: string): EmbedTrack | null {
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return null;
  try {
    const data = JSON.parse(match[1]) as {
      props?: { pageProps?: { state?: { data?: { entity?: {
        id?: string;
        name?: string;
        title?: string;
        artists?: Array<{ name?: string }>;
        releaseDate?: { isoString?: string };
        audioPreview?: { url?: string };
        visualIdentity?: { image?: Array<{ url?: string; maxWidth?: number }> };
      } } } } };
    };
    const entity = data?.props?.pageProps?.state?.data?.entity;
    const trackId = entity?.id;
    const title = entity?.name ?? entity?.title;
    if (!trackId || !title) return null;

    const year = parseInt(entity.releaseDate?.isoString?.slice(0, 4) ?? '', 10);
    const images = [...(entity.visualIdentity?.image ?? [])].sort((a, b) => (b.maxWidth ?? 0) - (a.maxWidth ?? 0));
    const preview = entity.audioPreview?.url;
    return {
      trackId,
      title,
      artists: (entity.artists ?? []).map(a => a.name ?? '').filter(Boolean),
      releaseYear: Number.isNaN(year) ? null : year,
      albumArt: images[0]?.url ?? '',
      previewUrl: typeof preview === 'string' && PREVIEW_MP3.test(preview) ? preview : null,
    };
  } catch {
    return null;
  }
}

export async function fetchEmbedTrack(trackId: string): Promise<EmbedTrack | null> {
  if (!isValidSpotifyTrackId(trackId)) return null;
  const res = await fetch(`${EMBED_TRACK_URL}/${trackId}?utm_source=generator`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; HitsterOnline/1.0)',
      Accept: 'text/html',
    },
  });
  if (res.status === 429) throw new EmbedRateLimitError();
  if (!res.ok) return null;
  return extractEmbedTrack(await res.text());
}
