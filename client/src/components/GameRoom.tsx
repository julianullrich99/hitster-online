import { useRef, useEffect, useState, useMemo } from 'react';
import {
  CARDS_TO_WIN_DEFAULT,
  CARDS_TO_WIN_MIN,
  CHALLENGE_WINDOW_MS,
  FLIP_REVEAL_DISPLAY_MS,
  TURN_SECONDS_DEFAULT,
  TURN_SECONDS_OPTIONS,
} from '../../../shared/constants';
import type { Room, Card, CardHidden, GameMode, Player, Team, AudioMode, SpotifyDevice } from '../../../shared/types';
import type { LocalPlayer } from '../game/useGame';
import TrackPreviewModal from './TrackPreviewModal';
import { PlaylistAutocomplete } from './PlaylistAutocomplete';
import { TimelineView } from './TimelineView';
import { renderGameLog } from '../game/gameLog';
import { fetchEmbedPreviewStream, turnPlayableStream } from '../spotify';
import { gameAudio, isDeviceMuted, setDeviceMuted } from '../audio/gameAudio';
import { useT, withNodes, type MessageKey, type TFunction } from '../i18n';
import { translateError } from '../i18n/errors';
import { LanguageSwitcher } from '../i18n/LanguageSwitcher';

// ── Helpers ──────────────────────────────────────────────────────────────────

const AVATAR_COLORS = [
  '#4ade80', '#a78bfa', '#fbbf24', '#f87171',
  '#60a5fa', '#fb923c', '#c084fc', '#34d399', '#f472b6',
];

export function avatarColor(name: string): string {
  let sum = 0;
  for (let i = 0; i < name.length; i++) sum += name.charCodeAt(i);
  return AVATAR_COLORS[sum % AVATAR_COLORS.length];
}

/** Timeline/token key for the player whose turn it is. */
export function activeEntityIdFromRoom(room: Room, activePlayerId: string): string {
  if (room.activeRound?.config.mode === 'cooperative') return 'cooperative';
  if (room.useTeams) {
    const teamEntry = Object.entries(room.teams).find(([, t]) =>
      t.playerIds.includes(activePlayerId),
    );
    return teamEntry?.[0] ?? activePlayerId;
  }
  return activePlayerId;
}

function sortPlayersMeFirst(players: Player[], sessionId: string): Player[] {
  return [...players].sort((a, b) => {
    if (a.id === sessionId) return -1;
    if (b.id === sessionId) return 1;
    return a.displayName.localeCompare(b.displayName);
  });
}

function sortTeamsMeFirst(teams: Team[], sessionId: string): Team[] {
  return [...teams].sort((a, b) => {
    const aMe = a.playerIds.includes(sessionId);
    const bMe = b.playerIds.includes(sessionId);
    if (aMe && !bMe) return -1;
    if (!aMe && bMe) return 1;
    return a.name.localeCompare(b.name);
  });
}

const MODE_NAME_KEYS: Record<GameMode, MessageKey> = {
  original: 'mode.original',
  pro: 'mode.pro',
  expert: 'mode.expert',
  cooperative: 'mode.cooperative',
};

/** Translated name of a game mode */
export function modeName(t: TFunction, mode: GameMode): string {
  return t(MODE_NAME_KEYS[mode]);
}

export function activePlayerDisplayName(room: Room, activePlayerId: string | null): string {
  if (!activePlayerId) return '...';
  if (room.players[activePlayerId]) return room.players[activePlayerId].displayName;
  if (room.teams[activePlayerId]) return room.teams[activePlayerId].name;
  return '...';
}

/** Time left to place, counted on this device's clock (turnEndsAt is already converted). */
export function TurnCountdown({ endsAt, totalSeconds }: { endsAt: number; totalSeconds: number | null }) {
  const t = useT();
  const [msLeft, setMsLeft] = useState(() => Math.max(0, endsAt - Date.now()));

  useEffect(() => {
    const tick = () => setMsLeft(Math.max(0, endsAt - Date.now()));
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [endsAt]);

  const seconds = Math.ceil(msLeft / 1000);
  const label = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const fraction = totalSeconds ? Math.min(1, msLeft / (totalSeconds * 1000)) : null;
  const urgent = seconds <= 10;

  return (
    <div className={`turn-countdown${urgent ? ' turn-countdown--urgent' : ''}`} data-testid="turn-countdown">
      <span className="turn-countdown-time" aria-label={t('countdown.secondsLeft', { count: seconds })}>{label}</span>
      {fraction !== null && (
        <span className="turn-countdown-bar" aria-hidden>
          <span className="turn-countdown-fill" style={{ width: `${fraction * 100}%` }} />
        </span>
      )}
    </div>
  );
}

/** Short "YOUR TURN" / "ANNA'S TURN" splash when a new turn starts — overlays, never blocks input. */
export function TurnSplash({ text, mine }: { text: string; mine: boolean }) {
  return (
    <div className={`turn-splash${mine ? ' turn-splash--mine' : ''}`} role="status" aria-live="polite">
      <div className="turn-splash-text">{text}</div>
    </div>
  );
}

const CONFETTI_COLORS = ['#fbbf24', '#4ade80', '#a78bfa', '#f472b6', '#60a5fa', '#fb923c'];

/** CSS-only confetti burst; positions come from the index so renders are stable. */
export function Confetti({ pieces = 60 }: { pieces?: number }) {
  return (
    <div className="confetti" aria-hidden>
      {Array.from({ length: pieces }, (_, i) => {
        const left = (i * 37) % 100;
        const delay = ((i * 53) % 100) / 100 * 1.2;
        const duration = 2.4 + ((i * 29) % 100) / 100 * 1.6;
        const drift = ((i * 41) % 61) - 30;
        const spin = ((i * 67) % 720) - 360;
        return (
          <span
            key={i}
            className={`confetti-piece${i % 3 === 0 ? ' confetti-piece--round' : ''}`}
            style={{
              left: `${left}%`,
              background: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
              animationDelay: `${delay}s`,
              animationDuration: `${duration}s`,
              ['--drift' as string]: `${drift}vw`,
              ['--spin' as string]: `${spin}deg`,
            }}
          />
        );
      })}
    </div>
  );
}

/** How to put the game on a TV: open the observer URL there. */
function TvHint({ room }: { room: Room }) {
  const tvUrl = `${window.location.origin}/?tv=${room.code}`;
  const count = room.observers ?? 0;
  const t = useT();
  return (
    <div className="lobby-tv-hint" data-testid="tv-hint">
      <span className="lobby-tv-icon" aria-hidden>📺</span>
      <div>
        {count > 0 ? (
          <div className="lobby-tv-title">{t('tvHint.connected', { count })}</div>
        ) : (
          <div className="lobby-tv-title">{t('tvHint.show')}</div>
        )}
        <div className="lobby-tv-url">
          {withNodes(t('tvHint.open'), { url: <strong>{tvUrl.replace(/^https?:\/\//, '')}</strong> })}
        </div>
      </div>
    </div>
  );
}

/** Sound on/off for this device only (e.g. phones stay quiet while the TV plays). */
export function MuteToggle() {
  const [muted, setMuted] = useState(isDeviceMuted);
  const t = useT();
  return (
    <button
      type="button"
      className={`mute-toggle${muted ? ' mute-toggle--muted' : ''}`}
      aria-pressed={muted}
      aria-label={muted ? t('mute.offLabel') : t('mute.onLabel')}
      title={muted ? t('mute.offTitle') : t('mute.onTitle')}
      data-testid="mute-toggle"
      onClick={() => { setDeviceMuted(!muted); setMuted(!muted); }}
    >
      {muted ? '🔇' : '🔊'}
    </button>
  );
}

/** Owner-only remove button; asks first because it also removes players who are still here. */
function KickButton({ player, onKick }: { player: Player; onKick: (playerId: string) => void }) {
  const t = useT();
  const name = player.displayName;
  return (
    <button
      type="button"
      className="kick-btn"
      title={t('kick.title', { name })}
      aria-label={t('kick.aria', { name })}
      data-testid="kick-player-btn"
      onClick={(e) => {
        e.stopPropagation();
        if (window.confirm(t('kick.confirm', { name }))) onKick(player.id);
      }}
    >
      ✕
    </button>
  );
}

function HitsterLogo() {
  return (
    <div className="logo">
      HITSTER
      <span className="cursor-blink" aria-hidden />
    </div>
  );
}

// ── PlayerList ────────────────────────────────────────────────────────────────

interface PlayerListProps {
  room: Room;
  activePlayerId: string | null;
  activeTurnLabel: string;
  isMyTurn: boolean;
  sessionId: string;
  /** All players on this device (main + hot-seat) */
  localIds: string[];
  /** Set for the room owner: remove another player */
  onKick?: (playerId: string) => void;
  /** Local-clock deadline while the card is being placed; null without a limit or after placing */
  turnEndsAt: number | null;
}

function PlayerList({
  room,
  activePlayerId,
  activeTurnLabel,
  isMyTurn,
  sessionId,
  localIds,
  onKick,
  turnEndsAt,
}: PlayerListProps) {
  const t = useT();
  const isHotSeat = localIds.length > 1;
  const players = Object.values(room.players).filter((p) => !p.isSpectator);
  const round = room.activeRound;

  const renderPlayer = (p: typeof players[number]) => {
    const pTeamId = Object.entries(room.teams).find(([, t]) => t.playerIds.includes(p.id))?.[0];
    const isActive = round?.config.mode === 'cooperative'
      ? false
      : room.useTeams && pTeamId
        ? activePlayerId === pTeamId
        : p.id === activePlayerId;
    const isMe = localIds.includes(p.id);
    const entityKey = round?.config.mode === 'cooperative' ? 'cooperative'
      : (room.useTeams && pTeamId ? pTeamId : p.id);
    const timeline = round?.timelines[entityKey];
    const cardCount = timeline?.cards.length ?? 0;
    const tokens = round?.tokens[entityKey] ?? 0;

    return (
      <div
        key={p.id}
        className={`player-item${isMe ? ' is-me pinned' : ''}${isActive ? ' active-player' : ''}${!p.isConnected ? ' disconnected' : ''}`}
      >
        <div className="player-avatar">
          {p.displayName[0]?.toUpperCase() ?? '?'}
        </div>
        <div className="player-info">
          <div className="player-name">
            {isMe && !isHotSeat ? t('players.you') : p.displayName}
            {isActive && <span className="player-turn-badge">{t('players.turnBadge')}</span>}
            {!p.isConnected && (
              <span className="player-disconnected-badge">{t('players.offline')}</span>
            )}
          </div>
          <div className="player-score" key={cardCount}>{t('common.cards', { count: cardCount })}</div>
          <div className="player-token-dots">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className={`token-dot${i >= tokens ? ' empty' : ''}`} />
            ))}
          </div>
        </div>
        {onKick && p.id !== room.ownerId && <KickButton player={p} onKick={onKick} />}
      </div>
    );
  };

  const teams = sortTeamsMeFirst(Object.values(room.teams), sessionId);
  const hasTeams = room.useTeams && teams.length > 0;
  const sortedPlayers = sortPlayersMeFirst(players, sessionId);

  return (
    <div className="side-panel">
      {round && activePlayerId && (
        <div
          className={`sidebar-turn-status${isMyTurn ? ' sidebar-turn-status--you' : ''}`}
          data-testid="sidebar-turn-status"
        >
          <div className="sidebar-turn-status-main">
            <div className="sidebar-turn-who" key={activeTurnLabel}>
              {isMyTurn && !isHotSeat ? t('turn.yours') : t('turn.other', { name: activeTurnLabel })}
            </div>
            {turnEndsAt !== null && (
              <TurnCountdown endsAt={turnEndsAt} totalSeconds={round.config.turnSeconds} />
            )}
          </div>
        </div>
      )}

      <div className="panel-title">{t('players.title')}</div>

      {hasTeams ? (
        <>
          {teams.map(team => {
            const teamPlayers = sortPlayersMeFirst(
              players.filter(p => team.playerIds.includes(p.id)),
              sessionId,
            );
            return (
              <div key={team.id}>
                <div className="player-team-header">{team.name}</div>
                {teamPlayers.map(p => renderPlayer(p))}
              </div>
            );
          })}
          {(() => {
            const unteamedPlayers = sortPlayersMeFirst(
              players.filter(p => !teams.some(t => t.playerIds.includes(p.id))),
              sessionId,
            );
            return unteamedPlayers.length > 0 ? (
              <div>
                <div className="player-team-header">{t('players.noTeam')}</div>
                {unteamedPlayers.map(p => renderPlayer(p))}
              </div>
            ) : null;
          })()}
        </>
      ) : (
        sortedPlayers.map(p => renderPlayer(p))
      )}

      {round && (
        <div className="round-info">
          <div className="panel-title">{t('round.title')}</div>
          <div className="round-info-row">
            {t('round.mode')}: <span className="round-info-val">{modeName(t, round.config.mode)}</span><br />
            {t('round.deck')}: <span className="round-info-val" style={{
              color: round.deckRemaining <= 3 ? '#ef4444' : round.deckRemaining <= 10 ? '#fbbf24' : undefined
            }}>{t('round.deckLeft', { count: round.deckRemaining })}</span><br />
            {t('round.target')}: <span className="round-info-val-green">{t('common.cards', { count: round.config.cardsToWin })}</span><br />
            {t('round.time')}: <span className="round-info-val">{round.config.turnSeconds ? t('common.secondsShort', { count: round.config.turnSeconds }) : t('round.noLimit')}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── AudioPlayer ───────────────────────────────────────────────────────────────

type PlaybackStatus = 'idle' | 'resolving' | 'loading' | 'playing' | 'blocked' | 'ended' | 'unavailable' | 'speaker';

const PREVIEW_SECONDS = 30;

interface AudioPlayerProps {
  previewUrl: string | null;
  streamUrl: string | null;
  playAt: number | null;
  speaker: { deviceName: string } | null;
  currentCard: CardHidden | null;
  revealedCard: Card | null;
  isFlipped: boolean;
  isActivePlayer: boolean;
}

export function AudioPlayer({
  previewUrl,
  streamUrl,
  playAt,
  speaker,
  currentCard,
  revealedCard,
  isFlipped,
  isActivePlayer,
}: AudioPlayerProps) {
  const t = useT();
  const waveformRef = useRef<HTMLDivElement>(null);
  const waveIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const retryPlayRef = useRef<(() => void) | null>(null);
  const [timeLeft, setTimeLeft] = useState(PREVIEW_SECONDS);
  const [progress, setProgress] = useState(0);
  const [playbackStatus, setPlaybackStatus] = useState<PlaybackStatus>('idle');

  // Waveform animation
  useEffect(() => {
    if (!waveformRef.current) return;
    waveformRef.current.innerHTML = '';
    const bars: HTMLDivElement[] = [];
    for (let i = 0; i < 60; i++) {
      const bar = document.createElement('div');
      bar.className = 'waveform-bar';
      bar.style.height = `${Math.random() * 28 + 4}px`;
      waveformRef.current.appendChild(bar);
      bars.push(bar);
    }

    waveIntervalRef.current = setInterval(() => {
      bars.forEach(b => {
        b.style.height = `${Math.random() * 28 + 4}px`;
      });
    }, 150);

    return () => {
      if (waveIntervalRef.current) clearInterval(waveIntervalRef.current);
    };
  }, []);

  // Resolve MP3 (API streamUrl or embed HTML) and start synced playback at playAt.
  // Uses the shared, gesture-unlocked element so timer-started play() isn't blocked.
  useEffect(() => {
    // Full song plays on the room's Spotify device — this device stays silent
    if (speaker && currentCard) {
      setPlaybackStatus('speaker');
      return;
    }
    if (!previewUrl || !playAt || !currentCard) {
      setPlaybackStatus('idle');
      return;
    }

    const audio = gameAudio;
    if (!audio) return;

    let cancelled = false;
    let playTimer: ReturnType<typeof setTimeout> | null = null;

    const onPlaying = () => { if (!cancelled) setPlaybackStatus('playing'); };
    const onEnded = () => { if (!cancelled) setPlaybackStatus('ended'); };
    const onError = () => { if (!cancelled && audio.getAttribute('src')) setPlaybackStatus('unavailable'); };
    const onTimeUpdate = () => {
      if (cancelled) return;
      const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : PREVIEW_SECONDS;
      setProgress(Math.min((audio.currentTime / duration) * 100, 100));
      setTimeLeft(Math.max(duration - audio.currentTime, 0));
    };
    audio.addEventListener('playing', onPlaying);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);
    audio.addEventListener('timeupdate', onTimeUpdate);

    // Late start (slow resolve, tap-to-play): seek so every device hears the same moment
    const syncPosition = () => {
      const offset = (Date.now() - playAt) / 1000;
      if (offset > 0.5 && offset < PREVIEW_SECONDS) {
        try { audio.currentTime = offset; } catch { /* metadata not loaded yet */ }
      }
    };

    const tryPlay = () => {
      if (cancelled) return;
      retryPlayRef.current = null;
      if (audio.readyState >= 1) syncPosition();
      else audio.addEventListener('loadedmetadata', syncPosition, { once: true });
      audio.play().catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof DOMException && err.name === 'NotAllowedError') {
          // Autoplay blocked — next tap anywhere (or the button) starts it
          retryPlayRef.current = tryPlay;
          setPlaybackStatus('blocked');
        } else if (err instanceof DOMException && err.name === 'AbortError') {
          // Superseded by a newer load — ignore
        } else {
          setPlaybackStatus('unavailable');
        }
      });
    };

    const onGesture = () => { retryPlayRef.current?.(); };
    window.addEventListener('pointerdown', onGesture);

    const run = async () => {
      let url = turnPlayableStream(previewUrl, streamUrl);
      if (!url) {
        setPlaybackStatus('resolving');
        try {
          url = await fetchEmbedPreviewStream(currentCard.trackId);
        } catch {
          url = null;
        }
      }
      if (cancelled) return;
      if (!url) {
        setPlaybackStatus('unavailable');
        return;
      }
      audio.src = url;
      audio.load();
      setPlaybackStatus('loading');
      playTimer = setTimeout(tryPlay, Math.max(0, playAt - Date.now()));
    };

    void run();

    return () => {
      cancelled = true;
      retryPlayRef.current = null;
      if (playTimer) clearTimeout(playTimer);
      window.removeEventListener('pointerdown', onGesture);
      audio.removeEventListener('playing', onPlaying);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('loadedmetadata', syncPosition);
      audio.pause();
      audio.removeAttribute('src');
      setTimeLeft(PREVIEW_SECONDS);
      setProgress(0);
      setPlaybackStatus('idle');
    };
  }, [previewUrl, streamUrl, playAt, currentCard?.trackId, speaker?.deviceName]);

  const statusMessage = (() => {
    if (playbackStatus === 'speaker' && speaker) return t('audio.playingOn', { device: speaker.deviceName });
    if (playbackStatus === 'resolving' || playbackStatus === 'loading') return t('audio.loading');
    if (playbackStatus === 'unavailable') return t('audio.unavailable');
    if (playbackStatus === 'blocked') return t('audio.blocked');
    if (playbackStatus === 'ended') return t('audio.ended');
    if (playbackStatus === 'playing') {
      return isActivePlayer ? t('audio.playing') : t('audio.playingAll');
    }
    return isActivePlayer ? t('audio.starting') : t('audio.startingAll');
  })();

  const showDetails = isFlipped && revealedCard;
  const albumArt =
    showDetails && revealedCard
      ? revealedCard.albumArt
      : isActivePlayer && !isFlipped
        ? (currentCard?.albumArt ?? null)
        : null;

  return (
    <>
      <div className="now-playing">
        <div className="album-art-wrap">
          {albumArt ? (
            <>
              <img key={albumArt} className="album-art-img" src={albumArt} alt={t('audio.albumArt')} />
              <div className={`album-art-blur${isFlipped ? ' album-art-blur--gone' : ''}`}>🎵</div>
            </>
          ) : (
            <div className="album-art-blur">🎵</div>
          )}
        </div>

        <div className="song-info">
          <div className="song-label">
            {isFlipped
              ? t('audio.revealed')
              : isActivePlayer
                ? t('audio.nowPlayingPlace')
                : t('audio.nowPlaying')}
          </div>
          {showDetails && revealedCard ? (
            <div className="song-reveal" key={revealedCard.trackId}>
              <div className="song-title">{revealedCard.title}</div>
              <div className="song-artist">{revealedCard.artist}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
                <div className="song-year">{revealedCard.releaseYear}</div>
              </div>
            </div>
          ) : (
            <div className="now-playing-status" data-testid="now-playing-status">
              {statusMessage}
              {playbackStatus === 'blocked' && (
                <button
                  type="button"
                  className="tap-to-play-btn"
                  onClick={() => retryPlayRef.current?.()}
                  data-testid="tap-to-play-btn"
                >
                  {t('audio.tapToPlay')}
                </button>
              )}
            </div>
          )}
        </div>

        {playbackStatus === 'playing' && (
          <div className="song-timer-wrap">
            <div className="song-timer-label">{t('audio.timeLeft')}</div>
            <div className="song-timer">
              0:{String(Math.ceil(timeLeft)).padStart(2, '0')}
            </div>
          </div>
        )}
      </div>

      <div className="waveform" ref={waveformRef} />
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${progress}%` }} />
      </div>
    </>
  );
}

// ── ChallengeBar ──────────────────────────────────────────────────────────────

interface ChallengeBarProps {
  deadline: number | null;
}

export function ChallengeBar({ deadline }: ChallengeBarProps) {
  const t = useT();
  const [seconds, setSeconds] = useState<number>(CHALLENGE_WINDOW_MS / 1000);

  useEffect(() => {
    if (!deadline) return;
    const tick = () => {
      const rem = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setSeconds(rem);
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [deadline]);

  if (!deadline) return null;

  return (
    <div className="challenge-timer-box challenge-timer-box--compact" aria-live="polite">
      <div className="challenge-timer-count">{t('common.secondsShort', { count: seconds })}</div>
      <div className="challenge-timer-label">{t('challenge.window')}</div>
    </div>
  );
}

// ── RoundHistory ──────────────────────────────────────────────────────────────

/** Past rounds with their mode and winner (win screen and game-over screen). */
function RoundHistory({ room }: { room: Room }) {
  const t = useT();
  if (room.roundHistory.length === 0) return null;
  return (
    <div className="win-history">
      <div className="win-history-title">{t('win.history')}</div>
      {room.roundHistory.map((r, i) => {
        const rWinner = r.winnerId && room.players[r.winnerId]
          ? room.players[r.winnerId].displayName
          : r.winnerId === 'cooperative' ? t('common.team')
          : r.winnerId && room.teams[r.winnerId] ? room.teams[r.winnerId].name
          : t('win.noWinner');
        return (
          <div key={i} className="win-history-row">
            <span className="win-history-round">{t('win.round', { round: r.roundNumber })}</span>
            <span className="win-history-mode">{modeName(t, r.mode)}</span>
            <span className="win-history-winner">{rWinner}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── WinScreen ─────────────────────────────────────────────────────────────────

interface WinScreenProps {
  winnerId: string | null;
  room: Room;
  sessionId: string;
  /** Omitted on the observer screen (TV), which shows no buttons */
  onBackToLobby?: () => void;
  onLeave?: () => void;
  onEndGame?: () => void;
}

export function WinScreen({ winnerId, room, sessionId, onBackToLobby, onLeave, onEndGame }: WinScreenProps) {
  const t = useT();
  const isCoopWin = winnerId === 'cooperative';
  const isCoopLoss = !winnerId && room.activeRound?.config.mode === 'cooperative';
  const isTeamWin = winnerId && room.teams[winnerId] !== undefined;
  const winner = !isCoopWin && !isTeamWin && winnerId ? room.players[winnerId] : null;
  const winnerTeam = isTeamWin && winnerId ? room.teams[winnerId] : null;
  const isMe = winnerId === sessionId;
  const isMyTeam = winnerId !== null && room.teams[winnerId ?? '']?.playerIds.includes(sessionId);
  const cardsToWin = room.activeRound?.config.cardsToWin ?? CARDS_TO_WIN_DEFAULT;

  let title: string;
  let subtitle: string;
  if (isCoopWin) {
    title = t('win.teamWins');
    subtitle = t('win.reachedTogether', { count: cardsToWin });
  } else if (isCoopLoss) {
    title = t('win.teamLost');
    subtitle = t('win.poolEmpty');
  } else if (winnerTeam) {
    title = isMyTeam ? t('win.yourTeamWins') : t('win.nameWins', { name: winnerTeam.name });
    subtitle = t('win.reachedFirst', { name: winnerTeam.name, count: cardsToWin });
  } else if (isMe) {
    title = t('win.youWin');
    subtitle = t('win.perfectTimeline');
  } else if (winner) {
    title = t('win.nameWins', { name: winner.displayName });
    subtitle = t('win.reachedFirst', { name: winner.displayName, count: cardsToWin });
  } else {
    title = t('win.gameOver');
    subtitle = t('win.deckEmpty');
  }

  const isOwner = room.ownerId === sessionId;

  return (
    <div className="win-screen">
      <div className="scanlines" />
      {!isCoopLoss && <Confetti />}
      <div className="win-trophy">{isCoopLoss ? '💀' : '🏆'}</div>
      <div className="win-title">{title}</div>
      <div className="win-subtitle">{subtitle}</div>

      {/* Round history */}
      <RoundHistory room={room} />

      {onBackToLobby && onLeave && <div className="win-actions">
        <button className="win-play-again" onClick={onBackToLobby}>
          {isOwner ? t('win.backToLobbyOwner') : t('win.backToLobby')}
        </button>
        <button className="win-leave" onClick={onLeave}>
          {t('win.leaveRoom')}
        </button>
        {isOwner && onEndGame && (
          <button className="win-end-game" onClick={onEndGame}>
            {t('win.endGame')}
          </button>
        )}
      </div>}
    </div>
  );
}

// ── Audio settings (lobby) ────────────────────────────────────────────────────

/** Owner-side Spotify controls, passed down from useGame */
export interface AudioControls {
  spotifyDevices: SpotifyDevice[] | null;
  onSetAudioMode: (mode: AudioMode) => void;
  onConnectSpotify: () => void;
  onListSpotifyDevices: () => void;
  onSelectSpotifyDevice: (deviceId: string) => void;
  onUnlinkSpotify: () => void;
}

const DEVICE_ICONS: Record<string, string> = {
  Smartphone: '📱', Computer: '💻', Speaker: '🔈', TV: '📺', Tablet: '📱', CastAudio: '🔈', CastVideo: '📺',
};

function AudioSettings({ room, isOwner, controls }: { room: Room; isOwner: boolean; controls: AudioControls }) {
  const { mode, spotify } = room.audio;
  const { spotifyDevices, onListSpotifyDevices } = controls;
  const linked = Boolean(spotify);
  const t = useT();

  // Load the device list once the account is linked
  useEffect(() => {
    if (isOwner && linked && spotifyDevices === null) onListSpotifyDevices();
  }, [isOwner, linked, spotifyDevices, onListSpotifyDevices]);

  if (!isOwner) {
    return mode === 'spotify' && spotify?.deviceName ? (
      <div className="lobby-audio-note" data-testid="audio-note">
        {withNodes(t('audioSettings.note'), { device: <strong>{spotify.deviceName}</strong> })}
      </div>
    ) : null;
  }

  return (
    <div className="lobby-config-section" data-testid="audio-settings">
      <div className="lobby-config-label">{t('audioSettings.title')}</div>
      <div className="lobby-mode-grid">
        {([
          { value: 'previews', label: t('audioSettings.previews'), desc: t('audioSettings.previewsDesc') },
          { value: 'spotify', label: t('audioSettings.full'), desc: t('audioSettings.fullDesc') },
        ] as const).map(o => (
          <label
            key={o.value}
            className={`lobby-mode-option${mode === o.value ? ' selected' : ''}`}
            data-testid={`audio-option-${o.value}`}
          >
            <input
              type="radio"
              name="audio-mode"
              value={o.value}
              checked={mode === o.value}
              onChange={() => (o.value === 'spotify' && !linked ? controls.onConnectSpotify() : controls.onSetAudioMode(o.value))}
              style={{ display: 'none' }}
            />
            <div className="lobby-mode-name">{o.label}</div>
            <div className="lobby-mode-desc">{o.desc}</div>
          </label>
        ))}
      </div>

      {!linked && (
        <div className="lobby-local-hint">
          {t('audioSettings.connectHint')}{' '}
          <button type="button" className="lobby-team-btn" onClick={controls.onConnectSpotify} data-testid="connect-spotify-btn">
            {t('audioSettings.connect')}
          </button>
        </div>
      )}

      {linked && spotify && mode === 'spotify' && (
        <>
          <div className="lobby-local-hint">
            {withNodes(t('audioSettings.connectedAs'), { name: <strong>{spotify.accountName}</strong> })}
          </div>
          <div className="lobby-teams-list">
            {(spotifyDevices ?? []).map(d => (
              <div
                key={d.id}
                className={`lobby-team-row${d.id === spotify.deviceId ? ' my-team' : ''}`}
                data-testid="spotify-device-row"
              >
                <div className="lobby-team-name">
                  {DEVICE_ICONS[d.type] ?? '🎵'} {d.name}
                </div>
                {d.id === spotify.deviceId ? (
                  <span className="lobby-team-member">{t('audioSettings.playingHere')}</span>
                ) : (
                  <button type="button" className="lobby-team-btn" onClick={() => controls.onSelectSpotifyDevice(d.id)}>
                    {t('audioSettings.use')}
                  </button>
                )}
              </div>
            ))}
            {spotifyDevices?.length === 0 && (
              <div className="lobby-local-hint">{t('audioSettings.noDevices')}</div>
            )}
          </div>
          <div className="lobby-create-team-row">
            <button type="button" className="lobby-team-btn" onClick={onListSpotifyDevices} data-testid="refresh-devices-btn">
              {t('audioSettings.refresh')}
            </button>
            <button type="button" className="lobby-team-btn leave" onClick={controls.onUnlinkSpotify}>
              {t('audioSettings.disconnect')}
            </button>
          </div>
          {!spotify.deviceId && (
            <div className="server-error-msg">{t('audioSettings.pickDevice')}</div>
          )}
          <div className="lobby-local-hint">
            {t('audioSettings.tip')}
          </div>
        </>
      )}
    </div>
  );
}

// ── Lobby screen ──────────────────────────────────────────────────────────────

const MODES: { value: GameMode; desc: MessageKey }[] = [
  { value: 'original', desc: 'mode.original.desc' },
  { value: 'pro', desc: 'mode.pro.desc' },
  { value: 'expert', desc: 'mode.expert.desc' },
  { value: 'cooperative', desc: 'mode.cooperative.desc' },
];

interface LobbyScreenProps {
  room: Room;
  sessionId: string;
  onStartRound: (mode: GameMode, playlistLabel?: string, cardsToWin?: number, turnSeconds?: number | null, tokensEnabled?: boolean) => void;
  onCreateTeam: (name: string) => void;
  onJoinTeam: (teamId: string) => void;
  onLeaveTeam: () => void;
  onLeave: () => void;
  socketError?: string | null;
  onPreviewPlaylist: (playlistLabel: string) => void;
  onClearPlaylistPreview: () => void;
  playlistPreviewCards: Card[] | null;
  playlistPreviewLoading: boolean;
  localPlayers: LocalPlayer[];
  onAddLocalPlayer: (name: string) => void;
  onRemoveLocalPlayer: (id: string) => void;
  onKickPlayer: (playerId: string) => void;
  audioControls: AudioControls;
}

function LobbyScreen({ room, sessionId, onStartRound, onCreateTeam, onJoinTeam, onLeaveTeam, onLeave, socketError, onPreviewPlaylist, onClearPlaylistPreview, playlistPreviewCards, playlistPreviewLoading, localPlayers, onAddLocalPlayer, onRemoveLocalPlayer, onKickPlayer, audioControls }: LobbyScreenProps) {
  const t = useT();
  const isOwner = room.ownerId === sessionId;
  const players = Object.values(room.players);
  const [playlistLabel, setPlaylistLabel] = useState('');
  const [mode, setMode] = useState<GameMode>('original');
  const [cardsToWin, setCardsToWin] = useState(CARDS_TO_WIN_DEFAULT);
  const [turnSeconds, setTurnSeconds] = useState<number | null>(TURN_SECONDS_DEFAULT);
  const [tokensEnabled, setTokensEnabled] = useState(true);
  const [starting, setStarting] = useState(false);
  const [newTeamName, setNewTeamName] = useState('');
  const [newLocalName, setNewLocalName] = useState('');
  const localIds = new Set([sessionId, ...localPlayers.map(p => p.id)]);

  useEffect(() => {
    if (socketError) setStarting(false);
  }, [socketError]);

  const myTeam = Object.values(room.teams).find(t => t.playerIds.includes(sessionId));
  const teams = Object.values(room.teams);

  function handleStart() {
    setStarting(true);
    onStartRound(mode, playlistLabel.trim() || undefined, cardsToWin, turnSeconds, tokensEnabled);
  }

  function handleAddLocal() {
    const name = newLocalName.trim();
    if (!name) return;
    onAddLocalPlayer(name);
    setNewLocalName('');
  }

  function handleCreateTeam() {
    const name = newTeamName.trim();
    if (!name) return;
    onCreateTeam(name);
    setNewTeamName('');
  }

  return (
    <div className="lobby-screen" data-testid="lobby-screen">
      <div className="lobby-topic">{room.topic}</div>

      <div className="lobby-player-list">
        {players.map(p => {
          const color = avatarColor(p.displayName);
          return (
            <div key={p.id} className="lobby-player-chip" data-testid="lobby-player">
              <div
                className="player-avatar"
                style={{ background: color + '22', color, width: 24, height: 24, fontSize: 8 }}
              >
                {p.displayName[0]?.toUpperCase()}
              </div>
              <span data-testid="lobby-player-name">{p.displayName}</span>
              {p.id === room.ownerId && (
                <span style={{ fontSize: 10, color: '#fbbf24' }}>★</span>
              )}
              {localIds.size > 1 && localIds.has(p.id) && (
                <span className="lobby-local-badge" title={t('lobby.localBadge')}>👥</span>
              )}
              {!p.isConnected && (
                <span className="player-disconnected-badge">{t('lobby.offline')}</span>
              )}
              {isOwner && p.id !== room.ownerId && <KickButton player={p} onKick={onKickPlayer} />}
            </div>
          );
        })}
      </div>

      <TvHint room={room} />

      {isOwner && (
        <>
          <div className="lobby-playlist-field">
            <PlaylistAutocomplete
              value={playlistLabel}
              onChange={setPlaylistLabel}
              data-testid="playlist-label-input"
            />
            <button
              className="lobby-preview-btn"
              disabled={!playlistLabel.trim() || playlistPreviewLoading}
              onClick={() => onPreviewPlaylist(playlistLabel.trim())}
              data-testid="preview-tracks-btn"
            >
              {playlistPreviewLoading ? '…' : t('lobby.preview')}
            </button>
          </div>

          {playlistPreviewCards && (
            <TrackPreviewModal
              cards={playlistPreviewCards}
              onClose={onClearPlaylistPreview}
            />
          )}

          <div className="lobby-config-section">
            <div className="lobby-config-label">{t('lobby.gameMode')}</div>
            <div className="lobby-mode-grid" data-testid="mode-selector">
              {MODES.map(m => (
                <label
                  key={m.value}
                  className={`lobby-mode-option${mode === m.value ? ' selected' : ''}`}
                  data-testid={`mode-option-${m.value}`}
                >
                  <input
                    type="radio"
                    name="game-mode"
                    value={m.value}
                    checked={mode === m.value}
                    onChange={() => setMode(m.value)}
                    style={{ display: 'none' }}
                  />
                  <div className="lobby-mode-name">{modeName(t, m.value)}</div>
                  <div className="lobby-mode-desc">{t(m.desc)}</div>
                </label>
              ))}
            </div>

            <div className="lobby-config-row">
              <label className="lobby-config-label" htmlFor="cards-to-win">
                {t('lobby.cardsToWin')}
              </label>
              <input
                id="cards-to-win"
                className="form-input"
                type="number"
                min={CARDS_TO_WIN_MIN}
                value={cardsToWin}
                onChange={e =>
                  setCardsToWin(Math.max(CARDS_TO_WIN_MIN, Math.floor(Number(e.target.value)) || CARDS_TO_WIN_MIN))
                }
                data-testid="cards-to-win-input"
                style={{ width: 72 }}
              />
            </div>

            <div className="lobby-config-row">
              <label className="lobby-config-label" htmlFor="turn-seconds">
                {t('lobby.timePerTurn')}
              </label>
              <select
                id="turn-seconds"
                className="form-input"
                value={turnSeconds ?? ''}
                onChange={e => setTurnSeconds(e.target.value ? Number(e.target.value) : null)}
                data-testid="turn-seconds-select"
                style={{ width: 'auto' }}
              >
                {TURN_SECONDS_OPTIONS.map(s => (
                  <option key={s ?? 'none'} value={s ?? ''}>
                    {s ? t('lobby.seconds', { count: s }) : t('lobby.noLimit')}
                  </option>
                ))}
              </select>
            </div>

            <div className="lobby-config-row">
              <label className="lobby-config-label" htmlFor="tokens-enabled">
                {t('lobby.tokensEnabled')}
              </label>
              <input
                id="tokens-enabled"
                type="checkbox"
                checked={tokensEnabled}
                onChange={e => setTokensEnabled(e.target.checked)}
                data-testid="tokens-enabled-toggle"
              />
            </div>
          </div>
        </>
      )}

      <AudioSettings room={room} isOwner={isOwner} controls={audioControls} />

      {/* ── Hot-seat: more players on this device ── */}
      <div className="lobby-teams-section" data-testid="local-players-section">
        <div className="lobby-config-label">{t('lobby.localTitle')}</div>
        <div className="lobby-local-hint">{t('lobby.localHint')}</div>
        {localPlayers.length > 0 && (
          <div className="lobby-teams-list">
            {localPlayers.map(lp => (
              <div key={lp.id} className="lobby-team-row" data-testid="local-player-row">
                <div className="lobby-team-name">{lp.name}</div>
                <button
                  className="lobby-team-btn leave"
                  onClick={() => onRemoveLocalPlayer(lp.id)}
                  data-testid="remove-local-player-btn"
                >
                  {t('common.remove')}
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="lobby-create-team-row">
          <input
            className="form-input"
            type="text"
            placeholder={t('lobby.playerNamePlaceholder')}
            maxLength={24}
            value={newLocalName}
            onChange={e => setNewLocalName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAddLocal()}
            data-testid="local-player-name-input"
            style={{ flex: 1, minWidth: 0 }}
          />
          <button
            className="lobby-team-btn"
            disabled={!newLocalName.trim()}
            onClick={handleAddLocal}
            data-testid="add-local-player-btn"
          >
            {t('common.add')}
          </button>
        </div>
      </div>

      {/* ── Teams section ── */}
      <div className="lobby-teams-section">
        <div className="lobby-config-label">{t('lobby.teamsTitle')}</div>

        {teams.length > 0 && (
          <div className="lobby-teams-list" data-testid="teams-list">
            {teams.map(team => {
              const isMyTeamRow = team.id === myTeam?.id;
              return (
                <div key={team.id} className={`lobby-team-row${isMyTeamRow ? ' my-team' : ''}`} data-testid="team-row">
                  <div className="lobby-team-name">{team.name}</div>
                  <div className="lobby-team-members">
                    {team.playerIds.map(pid => (
                      <span key={pid} className="lobby-team-member">
                        {room.players[pid]?.displayName ?? pid}
                      </span>
                    ))}
                  </div>
                  {!isMyTeamRow ? (
                    <button
                      className="lobby-team-btn"
                      onClick={() => onJoinTeam(team.id)}
                      data-testid="join-team-btn"
                    >
                      {t('common.join')}
                    </button>
                  ) : (
                    <button
                      className="lobby-team-btn leave"
                      onClick={onLeaveTeam}
                      data-testid="leave-team-btn"
                    >
                      {t('common.leave')}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="lobby-create-team-row">
          <input
            className="form-input"
            type="text"
            placeholder={t('lobby.newTeamPlaceholder')}
            maxLength={20}
            value={newTeamName}
            onChange={e => setNewTeamName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreateTeam()}
            data-testid="new-team-name-input"
            style={{ flex: 1, minWidth: 0 }}
          />
          <button
            className="lobby-team-btn"
            disabled={!newTeamName.trim()}
            onClick={handleCreateTeam}
            data-testid="create-team-btn"
          >
            {t('lobby.createTeam')}
          </button>
        </div>
      </div>

      {socketError && (
        <div className="server-error-msg">{translateError(socketError, t)}</div>
      )}

      {isOwner ? (
        <button
          className="lobby-start-btn"
          disabled={players.length < 1 || starting}
          onClick={handleStart}
          data-testid="start-round-btn"
        >
          {starting ? t('lobby.starting') : t('lobby.start')}
        </button>
      ) : (
        <div className="lobby-waiting">
          {t('lobby.waitingFor', { name: room.players[room.ownerId]?.displayName ?? t('lobby.host') })}
        </div>
      )}

      <button className="lobby-leave-btn" onClick={onLeave} data-testid="leave-btn">
        {t('lobby.leaveRoom')}
      </button>
    </div>
  );
}

// ── TokenPanel ────────────────────────────────────────────────────────────────

interface TokenPanelProps {
  myTokens: number;
  label: string;
}

function TokenPanel({ myTokens, label }: TokenPanelProps) {
  return (
    <div className="token-panel-header">
      <span className="token-panel-label">{label}</span>
      <div className="token-row">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className={`token-circle${i >= myTokens ? ' empty' : ''}`}>
            {i < myTokens ? '🪙' : ''}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main GameRoom component ───────────────────────────────────────────────────

export interface GameRoomProps {
  room: Room;
  currentCard: CardHidden | null;
  activePlayerId: string | null;
  previewUrl: string | null;
  streamUrl: string | null;
  playAt: number | null;
  speaker: { deviceName: string } | null;
  timelineLength: number;
  /** Local-clock deadline of the current turn (null = no limit) */
  turnEndsAt: number | null;
  lastFlip: {
    card: Card;
    correct: boolean;
    activePlayerId: string;
    placedPosition: number;
    challengeResults: Array<{ challengerId: string; outcome: 'stole_card' | 'lost_token' }>;
    timedOut: boolean;
  } | null;
  roundEnded: { winnerId: string | null } | null;
  /** This device's main player */
  sessionId: string;
  /** Extra hot-seat players on this device */
  localPlayers: LocalPlayer[];
  socketError?: string | null;
  onStartRound: (mode: GameMode, playlistLabel?: string, cardsToWin?: number, turnSeconds?: number | null, tokensEnabled?: boolean) => void;
  onPlaceCard: (actorId: string, position: number) => void;
  onChallengeCard: (actorId: string) => void;
  onSkipCard: (actorId: string) => void;
  onNameSong: (actorId: string, title: string, artist: string, year?: number) => void;
  onBuyCard: (actorId: string) => void;
  onAddLocalPlayer: (name: string) => void;
  onRemoveLocalPlayer: (id: string) => void;
  /** Owner removes a player from the room */
  onKickPlayer: (playerId: string) => void;
  onDismissRoundEnd: () => void;
  onCreateTeam: (name: string) => void;
  onJoinTeam: (teamId: string) => void;
  onLeaveTeam: () => void;
  onEndGame: () => void;
  onLeave: () => void;
  onPreviewPlaylist: (playlistLabel: string) => void;
  onClearPlaylistPreview: () => void;
  playlistPreviewCards: Card[] | null;
  playlistPreviewLoading: boolean;
  audioControls: AudioControls;
}

export default function GameRoom({
  room,
  currentCard,
  activePlayerId,
  previewUrl,
  streamUrl,
  playAt,
  speaker,
  turnEndsAt,
  lastFlip,
  roundEnded,
  sessionId: primaryId,
  localPlayers,
  socketError,
  onStartRound,
  onPlaceCard,
  onChallengeCard,
  onSkipCard,
  onNameSong,
  onBuyCard,
  onAddLocalPlayer,
  onRemoveLocalPlayer,
  onKickPlayer,
  onDismissRoundEnd,
  onCreateTeam,
  onJoinTeam,
  onLeaveTeam,
  onEndGame,
  onLeave,
  onPreviewPlaylist,
  onClearPlaylistPreview,
  playlistPreviewCards,
  playlistPreviewLoading,
  audioControls,
}: GameRoomProps) {
  const t = useT();
  const [selectedPosition, setSelectedPosition] = useState<number | null>(null);
  const [showFlipResult, setShowFlipResult] = useState(false);
  const [flipRevealSnapshot, setFlipRevealSnapshot] = useState<{
    position: number;
    card: Card;
    correct: boolean;
    timedOut: boolean;
    timelineEntityId: string;
  } | null>(null);
  const [nameSongTitle, setNameSongTitle] = useState('');
  const [nameSongArtist, setNameSongArtist] = useState('');
  const [nameSongYear, setNameSongYear] = useState('');

  const round = room.activeRound;
  const isCooperative = round?.config.mode === 'cooperative';
  const resolvedActivePlayerId =
    activePlayerId ?? round?.currentTurn?.activeId ?? null;

  // Hot-seat: the screen shows the perspective of whichever local player is on turn,
  // otherwise the main player's. All "my …" values below refer to that viewer.
  const localIds = useMemo(
    () => [primaryId, ...localPlayers.map(p => p.id)],
    [primaryId, localPlayers],
  );
  const isHotSeat = localIds.length > 1;
  const isParticipantOf = (playerId: string, entityId: string | null) =>
    entityId !== null && (entityId === playerId || (room.teams[entityId]?.playerIds.includes(playerId) ?? false));
  const activeLocalId = isCooperative
    ? undefined
    : localIds.find(id => isParticipantOf(id, resolvedActivePlayerId));
  const sessionId = activeLocalId ?? primaryId;
  const viewerName = room.players[sessionId]?.displayName ?? t('players.you');

  const myTeamId = Object.entries(room.teams).find(([, t]) => t.playerIds.includes(sessionId))?.[0];
  const isSpectator = room.players[sessionId]?.isSpectator === true;
  const isActivePlayer = !isSpectator && (isCooperative
    ? resolvedActivePlayerId !== null  // anyone can act in cooperative (handled server-side)
    : room.useTeams && myTeamId
      ? resolvedActivePlayerId === myTeamId
      : resolvedActivePlayerId === sessionId);
  const timelineKey = isCooperative ? 'cooperative' : (room.useTeams && myTeamId ? myTeamId : sessionId);
  const myTokens = round?.tokens[timelineKey] ?? 0;
  const myTimeline = round?.timelines[timelineKey];
  const myCards = myTimeline?.cards ?? [];
  const activeEntityId =
    resolvedActivePlayerId && round
      ? activeEntityIdFromRoom(room, resolvedActivePlayerId)
      : null;
  const activeTimeline =
    activeEntityId && round ? round.timelines[activeEntityId] : undefined;
  const activeCards = activeTimeline?.cards ?? [];
  const watchingOther =
    room.status === 'round_active' &&
    (isSpectator || (!isCooperative && !isActivePlayer));

  // Current turn phase
  const currentTurn = round?.currentTurn;
  const isInChallengePhase = currentTurn?.phase === 'challenge';
  const isInFlipPhase = currentTurn?.phase === 'flip';
  const placedPosition =
    currentTurn?.placedPosition !== undefined && currentTurn?.placedPosition !== null
      ? currentTurn.placedPosition
      : null;
  const challengeDeadline = isInChallengePhase ? (currentTurn?.challengeDeadline ?? null) : null;

  const activeName = activePlayerDisplayName(room, resolvedActivePlayerId);
  const placeHint = placedPosition === null ? t('timeline.placeHint') : t('timeline.placed');
  const mainTimelineLabel = watchingOther
    ? t('timeline.watchOther', { name: activeName.toUpperCase() })
    : isActivePlayer
      ? isHotSeat && !isCooperative
        ? t('timeline.namedHint', { name: activeName.toUpperCase(), hint: placeHint })
        : t('timeline.yoursHint', { hint: placeHint })
      : t('timeline.plain');
  const mainCards = watchingOther ? activeCards : myCards;
  const mainTimelineEntityId = watchingOther ? activeEntityId : timelineKey;
  const flipReveal =
    showFlipResult &&
    flipRevealSnapshot &&
    flipRevealSnapshot.timelineEntityId === mainTimelineEntityId
      ? {
          position: flipRevealSnapshot.position,
          card: flipRevealSnapshot.card,
          correct: flipRevealSnapshot.correct,
          timedOut: flipRevealSnapshot.timedOut,
        }
      : null;

  const logEntries = useMemo(
    () => renderGameLog(round?.gameLog, t),
    [round?.gameLog, t],
  );

  // Everyone on this device who may shout HITSTER! on the current placement
  const challengers =
    isInChallengePhase && !isCooperative
      ? localIds
          .filter(id => room.players[id] && !room.players[id].isSpectator)
          .filter(id => !isParticipantOf(id, resolvedActivePlayerId))
          .map(id => ({
            id,
            label: isHotSeat ? t('challenge.buttonNamed', { name: room.players[id].displayName }) : t('challenge.button'),
            doneLabel: isHotSeat ? t('challenge.doneNamed', { name: room.players[id].displayName }) : t('challenge.done'),
            hasChallenged: currentTurn?.challenges?.some(c => c.challengerId === id) ?? false,
          }))
      : [];

  // Show flip result for FLIP_REVEAL_DISPLAY_MS (survives turn:started clearing lastFlip)
  useEffect(() => {
    if (!lastFlip || !round) return;
    const timelineEntityId = activeEntityIdFromRoom(room, lastFlip.activePlayerId);
    setFlipRevealSnapshot({
      position: lastFlip.placedPosition,
      card: lastFlip.card,
      correct: lastFlip.correct,
      timedOut: lastFlip.timedOut,
      timelineEntityId,
    });
    setShowFlipResult(true);
    setSelectedPosition(null);
  }, [lastFlip]);

  useEffect(() => {
    if (!showFlipResult) return;
    const dismiss = () => {
      setShowFlipResult(false);
      setFlipRevealSnapshot(null);
    };
    const timer = setTimeout(dismiss, FLIP_REVEAL_DISPLAY_MS);
    const handler = () => dismiss();
    window.addEventListener('keydown', handler);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', handler);
    };
  }, [showFlipResult]);

  // Hot-seat hand-over: drop a half-made selection when the screen switches players
  useEffect(() => {
    setSelectedPosition(null);
  }, [sessionId]);

  // Turn splash: when a turn enters its place phase for a new player (or after a reveal)
  const turnPhase = currentTurn?.phase;
  const prevTurnRef = useRef<{ id: string | null; phase: string | undefined }>({ id: null, phase: undefined });
  const [splash, setSplash] = useState<{ key: number; text: string; mine: boolean } | null>(null);
  useEffect(() => {
    const prev = prevTurnRef.current;
    prevTurnRef.current = { id: resolvedActivePlayerId, phase: turnPhase };
    if (room.status !== 'round_active' || turnPhase !== 'place' || !resolvedActivePlayerId) return;
    if (prev.phase === 'place' && prev.id === resolvedActivePlayerId) return; // same turn (e.g. skip)
    const mine = isActivePlayer && !isSpectator;
    const text = mine
      ? (isHotSeat ? t('turn.other', { name: viewerName }) : t('turn.yours'))
      : t('turn.other', { name: activePlayerDisplayName(room, resolvedActivePlayerId) });
    setSplash(s => ({ key: (s?.key ?? 0) + 1, text, mine }));
  }, [resolvedActivePlayerId, turnPhase]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!splash) return;
    const t = setTimeout(() => setSplash(null), window.matchMedia('(max-width: 640px)').matches ? 1100 : 1400);
    return () => clearTimeout(t);
  }, [splash]);

  function handleSelectPosition(pos: number) {
    setSelectedPosition(pos);
  }

  function handleConfirmPlace() {
    if (selectedPosition === null) return;
    onPlaceCard(sessionId, selectedPosition);
    setSelectedPosition(null);
  }

  function handleChallenge(challengerId: string) {
    if (challengers.find(c => c.id === challengerId)?.hasChallenged) return;
    onChallengeCard(challengerId);
  }

  // Game over screen — room permanently ended by owner
  if (room.status === 'game_over') {
    return (
      <div className="win-screen">
        <div className="scanlines" />
        <div className="win-trophy">🎮</div>
        <div className="win-title">{t('gameOver.title')}</div>
        <div className="win-subtitle">{t('gameOver.thanks')}</div>
        <RoundHistory room={room} />
        <div className="win-actions">
          <button className="win-leave" onClick={onLeave}>{t('gameOver.leave')}</button>
        </div>
      </div>
    );
  }

  // Win screen — shown first so dismiss → lobby transition works
  if (roundEnded) {
    return (
      <WinScreen
        winnerId={roundEnded.winnerId}
        room={room}
        sessionId={sessionId}
        onBackToLobby={onDismissRoundEnd}
        onLeave={onLeave}
        onEndGame={onEndGame}
      />
    );
  }

  // In lobby (or round_ended after dismissing win screen)
  if (room.status === 'lobby' || room.status === 'round_ended') {
    return (
      <div className="game-root">
        <div className="scanlines" />
        <header className="game-header">
          <HitsterLogo />
          <div className="room-code-badge">{t('header.room', { code: room.code })}</div>
          <div className="game-header-actions">
            <LanguageSwitcher />
            <MuteToggle />
            <button type="button" className="header-leave-btn" onClick={onLeave} data-testid="leave-btn">
              {t('common.leave')}
            </button>
          </div>
        </header>
        <LobbyScreen
          room={room}
          sessionId={sessionId}
          onStartRound={onStartRound}
          onLeave={onLeave}
          onCreateTeam={onCreateTeam}
          onJoinTeam={onJoinTeam}
          onLeaveTeam={onLeaveTeam}
          socketError={socketError}
          onPreviewPlaylist={onPreviewPlaylist}
          onClearPlaylistPreview={onClearPlaylistPreview}
          playlistPreviewCards={playlistPreviewCards}
          playlistPreviewLoading={playlistPreviewLoading}
          localPlayers={localPlayers}
          onAddLocalPlayer={onAddLocalPlayer}
          onRemoveLocalPlayer={onRemoveLocalPlayer}
          onKickPlayer={onKickPlayer}
          audioControls={audioControls}
        />
      </div>
    );
  }

  // Active round
  const isFlipped = isInFlipPhase || showFlipResult;
  const revealedCard = lastFlip?.card ?? null;

  return (
    <div className="game-root" data-testid="round-active">
      <div className="scanlines" />
      {splash && <TurnSplash key={splash.key} text={splash.text} mine={splash.mine} />}

      {/* Header */}
      <header className="game-header">
        <HitsterLogo />
        <div className="room-code-badge">{t('header.room', { code: room.code })}</div>
        <div className="game-header-actions">
          {!isSpectator && round?.config.tokensEnabled !== false && (
            <TokenPanel
              myTokens={myTokens}
              label={isHotSeat && !isCooperative ? t('tokens.named', { name: viewerName }) : t('tokens.yours')}
            />
          )}
          <LanguageSwitcher />
          <MuteToggle />
          <button type="button" className="header-leave-btn" onClick={onLeave} data-testid="leave-btn">
            {t('common.leave')}
          </button>
        </div>
      </header>

      <div className="game-main">
        {/* LEFT: Player list */}
        <PlayerList
          room={room}
          activePlayerId={resolvedActivePlayerId}
          activeTurnLabel={activeName}
          isMyTurn={isActivePlayer && !isSpectator}
          sessionId={sessionId}
          localIds={localIds}
          onKick={room.ownerId === primaryId ? onKickPlayer : undefined}
          turnEndsAt={currentTurn?.phase === 'place' ? turnEndsAt : null}
        />

        {/* CENTER: Gameplay */}
        <div className={`center-col${showFlipResult ? ' center-col--reveal-active' : ''}`}>
          {isHotSeat && activeLocalId && currentTurn?.phase === 'place' && (
            <div className="hotseat-banner" role="status" aria-live="polite" data-testid="hotseat-banner">
              🎮 {t('turn.other', { name: viewerName })}
            </div>
          )}
          {isSpectator && (
            <div className="spectator-banner" role="status" aria-live="polite">
              <div className="spectator-banner__title">
                <span className="spectator-banner__icon" aria-hidden>
                  👁
                </span>
                {t('spectator.title')}
              </div>
              <p className="spectator-banner__hint">{t('spectator.hint')}</p>
            </div>
          )}
          <AudioPlayer
            previewUrl={previewUrl}
            streamUrl={streamUrl}
            playAt={playAt}
            speaker={speaker}
            currentCard={currentCard}
            revealedCard={revealedCard}
            isFlipped={isFlipped}
            isActivePlayer={isActivePlayer}
          />

          {isCooperative && round && (round.tokens['cooperative'] ?? 0) <= 2 && (
            <div className="coop-token-warning">
              {t('coop.fewTokens', { count: round.tokens['cooperative'] ?? 0 })}
            </div>
          )}

          <div className={watchingOther ? 'center-timeline-stack' : undefined}>
            <TimelineView
              cards={mainCards}
              pendingCard={isActivePlayer ? currentCard : null}
              label={mainTimelineLabel}
              readOnly={watchingOther}
              isActivePlayer={isActivePlayer}
              placedPosition={placedPosition}
              selectedPosition={selectedPosition}
              onSelectPosition={handleSelectPosition}
              isInChallengePhase={isInChallengePhase}
              showPlacementToAll={watchingOther || isInChallengePhase}
              testId={watchingOther ? 'watch-timeline' : 'main-timeline'}
              showHitsterUnderPlacement={challengers.length > 0}
              challengeDeadline={challengeDeadline}
              onChallenge={handleChallenge}
              challengers={challengers}
              flipReveal={flipReveal}
            />

            {watchingOther && !isSpectator && (
              <TimelineView
                cards={myCards}
                pendingCard={null}
                label={isHotSeat
                  ? t('timeline.namedNotYourTurn', { name: viewerName.toUpperCase() })
                  : t('timeline.yoursNotYourTurn')}
                readOnly
                placedPosition={null}
                selectedPosition={null}
                onSelectPosition={() => {}}
                isInChallengePhase={false}
                testId="my-timeline-disabled"
              />
            )}
          </div>

          {/* Actions bar */}
          <div className="actions-bar">
            {isActivePlayer && currentCard && placedPosition === null && (
              <button
                className="action-btn btn-confirm"
                disabled={selectedPosition === null}
                onClick={handleConfirmPlace}
              >
                {t('actions.confirm')}
              </button>
            )}

            {isActivePlayer && currentCard && !isInChallengePhase && (
              <button
                className="action-btn btn-skip-action"
                data-testid="skip-btn"
                disabled={myTokens < 1}
                onClick={() => onSkipCard(sessionId)}
              >
                {t('actions.skip')}
              </button>
            )}

            {isActivePlayer && currentCard && !isInChallengePhase && currentTurn?.phase === 'place' && (
              <button
                className="action-btn btn-buy-action"
                data-testid="buy-btn"
                disabled={myTokens < 3}
                onClick={() => onBuyCard(sessionId)}
                title={t('actions.buyTitle')}
              >
                {t('actions.buy')}
              </button>
            )}

          </div>
        </div>

        {/* RIGHT: Game log + challenge timer */}
        <div className="right-side-panel">
          <div className="panel-title">{t('log.title')}</div>

          {isInChallengePhase && !isCooperative && !isSpectator && (
            <ChallengeBar deadline={challengeDeadline} />
          )}

          <div className="game-log game-log--prominent">
            {logEntries.map(entry => (
              <div
                key={entry.id}
                className="log-entry"
                dangerouslySetInnerHTML={{ __html: entry.html }}
              />
            ))}
            {logEntries.length === 0 && (
              <div style={{ color: '#374151', fontSize: 12 }}>{t('log.empty')}</div>
            )}
          </div>

          {/* Name song panel */}
          {isActivePlayer && currentCard && !isInChallengePhase && (
            <div style={{ marginTop: 24 }}>
              <div className="panel-title">
                {round?.config.mode === 'pro' || round?.config.mode === 'expert'
                  ? t('name.titleRequired')
                  : t('name.titleBonus')}
              </div>
              <div className="name-song-form">
                <input
                  className="name-song-input"
                  data-testid="name-song-title"
                  placeholder={t('name.title')}
                  value={nameSongTitle}
                  onChange={e => setNameSongTitle(e.target.value)}
                />
              </div>
              <div className="name-song-form" style={{ marginTop: 6 }}>
                <input
                  className="name-song-input"
                  data-testid="name-song-artist"
                  placeholder={t('name.artist')}
                  value={nameSongArtist}
                  onChange={e => setNameSongArtist(e.target.value)}
                />
              </div>
              {round?.config.mode === 'expert' && (
                <div className="name-song-form" style={{ marginTop: 6 }}>
                  <input
                    className="name-song-input"
                    data-testid="name-song-year"
                    type="number"
                    placeholder={t('name.year')}
                    value={nameSongYear}
                    onChange={e => setNameSongYear(e.target.value)}
                  />
                </div>
              )}
              <div className="name-song-form" style={{ marginTop: 6 }}>
                <button
                  className="name-song-submit"
                  data-testid="name-song-submit"
                  disabled={
                    !nameSongTitle.trim() ||
                    !nameSongArtist.trim() ||
                    (round?.config.mode === 'expert' && !nameSongYear)
                  }
                  onClick={() => {
                    const year = round?.config.mode === 'expert' ? Number(nameSongYear) : undefined;
                    onNameSong(sessionId, nameSongTitle.trim(), nameSongArtist.trim(), year);
                    setNameSongTitle('');
                    setNameSongArtist('');
                    setNameSongYear('');
                  }}
                >
                  {t('name.submit')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

    </div>
  );
}
