import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto';
import type { Lang, SpotifyDevice } from '../../../shared/types';

/*
 * Full-song playback through Spotify Connect.
 *
 * The only place the app uses a *user* token (Authorization Code Flow): the room owner links
 * a Premium account once, and the server then tells that account to play each turn's song on
 * the Connect device they picked (phone app, TV, speaker). Tokens stay in this module — never
 * in Room state, never sent to a client in usable form. Deck building keeps using Client Credentials.
 *
 * Remembered logins: after a login the server seals the refresh token (AES-256-GCM, key derived
 * from the client secret) and hands that opaque blob to the browser, which keeps it in
 * localStorage. Next time the browser sends the blob back and the server links the account to the
 * new room without another Spotify login. The browser can't read or use the blob; the server
 * keeps nothing between rooms (no persistence).
 */

const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_BASE = 'https://api.spotify.com/v1';
const SCOPES = ['user-read-private', 'user-read-playback-state', 'user-modify-playback-state'];
/** A login not finished within this time is dropped */
const LOGIN_TTL_MS = 10 * 60 * 1000;
/** Refresh this long before the access token expires */
const REFRESH_MARGIN_MS = 60 * 1000;
/** Connect devices often need a moment after a transfer before they accept play */
const TRANSFER_SETTLE_MS = 800;

export interface PendingLogin {
  roomCode: string;
  sessionId: string;
  redirectUri: string;
  /** Language of the page shown after the login */
  lang: Lang;
  createdAt: number;
}

/** A sealed, browser-stored login: opaque to the client, only this server can open it */
export interface SavedLogin {
  accountName: string;
  /** Sealed refresh token */
  link: string;
}

interface SealedPayload {
  v: 1;
  refreshToken: string;
  accountName: string;
}

interface Link {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

interface ProfileResponse {
  id: string;
  display_name: string | null;
  product?: string;
}

interface DevicesResponse {
  devices: Array<{ id: string | null; name: string; type: string; is_active: boolean; is_restricted: boolean }>;
}

/** What went wrong, so the result page can say it in the player's language */
export type SpotifyConnectErrorCode = 'not_premium' | 'not_allowed' | 'expired' | 'other';

export class SpotifyConnectError extends Error {
  constructor(message: string, readonly code: SpotifyConnectErrorCode = 'other') {
    super(message);
  }
}

type FetchFn = typeof fetch;

export class SpotifyConnect {
  private readonly pendingLogins = new Map<string, PendingLogin>();
  private readonly links = new Map<string, Link>();
  private readonly sealKey: Buffer;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly fetchFn: FetchFn = fetch,
    sealSecret: string = process.env.SPOTIFY_LINK_SECRET || clientSecret,
  ) {
    this.sealKey = Buffer.from(hkdfSync('sha256', sealSecret || 'unset', 'hitster', 'spotify-link-v1', 32));
  }

  get configured(): boolean {
    return Boolean(this.clientId && this.clientSecret);
  }

  /** Start a login for a player in the room; returns the Spotify consent URL. */
  beginLogin(roomCode: string, sessionId: string, redirectUri: string, lang: Lang = 'de'): string {
    this.dropExpiredLogins();
    const state = randomBytes(16).toString('hex');
    this.pendingLogins.set(state, { roomCode, sessionId, redirectUri, lang, createdAt: Date.now() });
    const params = new URLSearchParams({
      client_id: this.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: SCOPES.join(' '),
      state,
      show_dialog: 'true', // let a second person in the room pick their own account
    });
    return `${AUTHORIZE_URL}?${params}`;
  }

  /** Consume a login's state (one use). */
  takeLogin(state: string): PendingLogin | null {
    this.dropExpiredLogins();
    const login = this.pendingLogins.get(state) ?? null;
    this.pendingLogins.delete(state);
    return login;
  }

  /** Exchange the callback code, check Premium, and link the account to the room. */
  async completeLogin(login: PendingLogin, code: string): Promise<SavedLogin> {
    const token = await this.requestToken({
      grant_type: 'authorization_code',
      code,
      redirect_uri: login.redirectUri,
    });
    if (!token.refresh_token) throw new SpotifyConnectError('Spotify did not return a refresh token');

    const res = await this.fetchFn(`${API_BASE}/me`, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    if (!res.ok) {
      // 403 here usually means the account isn't on the app's allowlist (development mode)
      throw res.status === 403
        ? new SpotifyConnectError(
            'This Spotify account is not allowed to use the app yet (add it under User Management in the Spotify dashboard)',
            'not_allowed',
          )
        : new SpotifyConnectError(`Spotify profile request failed (${res.status})`);
    }
    const profile = (await res.json()) as ProfileResponse;
    if (profile.product && profile.product !== 'premium') {
      throw new SpotifyConnectError('Full songs need Spotify Premium', 'not_premium');
    }

    this.links.set(login.roomCode, {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: Date.now() + token.expires_in * 1000,
    });
    const accountName = profile.display_name || profile.id;
    return { accountName, link: this.seal({ v: 1, refreshToken: token.refresh_token, accountName }) };
  }

  /**
   * Link a remembered login (from the browser) to a room — no Spotify login page.
   * Returns the login to store again (the refresh token may have been rotated).
   * Throws SpotifyConnectError('expired') when the blob is invalid or Spotify revoked it.
   */
  async restoreLogin(roomCode: string, link: string): Promise<SavedLogin> {
    const payload = this.unseal(link);
    if (!payload) throw new SpotifyConnectError('Saved Spotify login is invalid', 'expired');
    let token: TokenResponse;
    try {
      token = await this.requestToken({ grant_type: 'refresh_token', refresh_token: payload.refreshToken });
    } catch {
      throw new SpotifyConnectError('Saved Spotify login expired', 'expired');
    }
    const refreshToken = token.refresh_token ?? payload.refreshToken;
    this.links.set(roomCode, {
      accessToken: token.access_token,
      refreshToken,
      expiresAt: Date.now() + token.expires_in * 1000,
    });
    const accountName = payload.accountName;
    return { accountName, link: this.seal({ v: 1, refreshToken, accountName }) };
  }

  private seal(payload: SealedPayload): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.sealKey, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
  }

  private unseal(link: string): SealedPayload | null {
    try {
      const raw = Buffer.from(link, 'base64url');
      if (raw.length < 29) return null;
      const decipher = createDecipheriv('aes-256-gcm', this.sealKey, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      const json = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
      const payload = JSON.parse(json) as Partial<SealedPayload>;
      if (payload.v !== 1 || typeof payload.refreshToken !== 'string' || typeof payload.accountName !== 'string') {
        return null;
      }
      return { v: 1, refreshToken: payload.refreshToken, accountName: payload.accountName };
    } catch {
      return null;
    }
  }

  isLinked(roomCode: string): boolean {
    return this.links.has(roomCode);
  }

  unlink(roomCode: string): void {
    this.links.delete(roomCode);
  }

  async listDevices(roomCode: string): Promise<SpotifyDevice[]> {
    const res = await this.api(roomCode, 'GET', '/me/player/devices');
    if (!res.ok) throw new SpotifyConnectError(`Could not load Spotify devices (${res.status})`);
    const body = (await res.json()) as DevicesResponse;
    return body.devices
      .filter((d): d is DevicesResponse['devices'][number] & { id: string } => d.id !== null && !d.is_restricted)
      .map(d => ({ id: d.id, name: d.name, type: d.type, isActive: d.is_active }));
  }

  /** Play a track from the start on the given device. Wakes the device via a transfer when needed. */
  async play(roomCode: string, deviceId: string, trackId: string): Promise<void> {
    const body = JSON.stringify({ uris: [`spotify:track:${trackId}`], position_ms: 0 });
    const path = `/me/player/play?device_id=${encodeURIComponent(deviceId)}`;
    let res = await this.api(roomCode, 'PUT', path, body);
    if (res.status === 404 || res.status === 502) {
      // Device asleep / not the active one — transfer playback to it, then retry once
      await this.api(roomCode, 'PUT', '/me/player', JSON.stringify({ device_ids: [deviceId], play: false }));
      await new Promise(r => setTimeout(r, TRANSFER_SETTLE_MS));
      res = await this.api(roomCode, 'PUT', path, body);
    }
    if (!res.ok) throw new SpotifyConnectError(`Spotify play failed (${res.status})`);
  }

  /** Best-effort pause (round over, room closed). */
  async pause(roomCode: string, deviceId: string): Promise<void> {
    if (!this.links.has(roomCode)) return;
    try {
      await this.api(roomCode, 'PUT', `/me/player/pause?device_id=${encodeURIComponent(deviceId)}`);
    } catch {
      // Already paused / device gone — nothing to do
    }
  }

  private async api(roomCode: string, method: string, path: string, body?: string): Promise<Response> {
    const accessToken = await this.accessToken(roomCode);
    return this.fetchFn(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body,
    });
  }

  private async accessToken(roomCode: string): Promise<string> {
    const link = this.links.get(roomCode);
    if (!link) throw new SpotifyConnectError('No Spotify account linked');
    if (Date.now() < link.expiresAt - REFRESH_MARGIN_MS) return link.accessToken;

    const token = await this.requestToken({ grant_type: 'refresh_token', refresh_token: link.refreshToken });
    const refreshed: Link = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? link.refreshToken,
      expiresAt: Date.now() + token.expires_in * 1000,
    };
    // Unlinked while refreshing — don't resurrect it
    if (this.links.has(roomCode)) this.links.set(roomCode, refreshed);
    return refreshed.accessToken;
  }

  private async requestToken(params: Record<string, string>): Promise<TokenResponse> {
    const res = await this.fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams(params).toString(),
    });
    if (!res.ok) throw new SpotifyConnectError(`Spotify login failed (${res.status})`);
    return (await res.json()) as TokenResponse;
  }

  private dropExpiredLogins(): void {
    const cutoff = Date.now() - LOGIN_TTL_MS;
    for (const [state, login] of this.pendingLogins) {
      if (login.createdAt < cutoff) this.pendingLogins.delete(state);
    }
  }
}
