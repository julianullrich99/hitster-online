import { useRef, useEffect, useState, useMemo } from 'react';
import {
  CARDS_TO_WIN_DEFAULT,
  CARDS_TO_WIN_MIN,
  CHALLENGE_WINDOW_MS,
  FLIP_REVEAL_DISPLAY_MS,
  TURN_SECONDS_DEFAULT,
  TURN_SECONDS_OPTIONS,
} from '../../../shared/constants';
import type { Room, Card, CardHidden, GameMode, Player, Team } from '../../../shared/types';
import type { LocalPlayer } from '../game/useGame';
import TrackPreviewModal from './TrackPreviewModal';
import { PlaylistAutocomplete } from './PlaylistAutocomplete';
import { TimelineView } from './TimelineView';
import { renderGameLog } from '../game/gameLog';
import { fetchEmbedPreviewStream, turnPlayableStream } from '../spotify';
import { gameAudio } from '../audio/gameAudio';

// ── Helpers ──────────────────────────────────────────────────────────────────

const AVATAR_COLORS = [
  '#4ade80', '#a78bfa', '#fbbf24', '#f87171',
  '#60a5fa', '#fb923c', '#c084fc', '#34d399', '#f472b6',
];

function avatarColor(name: string): string {
  let sum = 0;
  for (let i = 0; i < name.length; i++) sum += name.charCodeAt(i);
  return AVATAR_COLORS[sum % AVATAR_COLORS.length];
}

/** Timeline/token key for the player whose turn it is. */
function activeEntityIdFromRoom(room: Room, activePlayerId: string): string {
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

function activePlayerDisplayName(room: Room, activePlayerId: string | null): string {
  if (!activePlayerId) return '...';
  if (room.players[activePlayerId]) return room.players[activePlayerId].displayName;
  if (room.teams[activePlayerId]) return room.teams[activePlayerId].name;
  return '...';
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
}

function PlayerList({
  room,
  activePlayerId,
  activeTurnLabel,
  isMyTurn,
  sessionId,
  localIds,
}: PlayerListProps) {
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
            {isMe && !isHotSeat ? 'You' : p.displayName}
            {isActive && <span className="player-turn-badge">TURN</span>}
            {!p.isConnected && (
              <span className="player-disconnected-badge">⚡ offline</span>
            )}
          </div>
          <div className="player-score">{cardCount} card{cardCount !== 1 ? 's' : ''}</div>
          <div className="player-token-dots">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className={`token-dot${i >= tokens ? ' empty' : ''}`} />
            ))}
          </div>
        </div>
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
            <div className="sidebar-turn-who">
              {isMyTurn && !isHotSeat ? 'your turn' : `${activeTurnLabel}'s turn`}
            </div>
          </div>
        </div>
      )}

      <div className="panel-title">Players</div>

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
                <div className="player-team-header">No team</div>
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
          <div className="panel-title">Round</div>
          <div className="round-info-row">
            Mode: <span className="round-info-val">{round.config.mode}</span><br />
            Deck: <span className="round-info-val" style={{
              color: round.deckRemaining <= 3 ? '#ef4444' : round.deckRemaining <= 10 ? '#fbbf24' : undefined
            }}>{round.deckRemaining} left</span><br />
            Target: <span className="round-info-val-green">{round.config.cardsToWin} cards</span><br />
            Time: <span className="round-info-val">{round.config.turnSeconds ? `${round.config.turnSeconds}s` : 'no limit'}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── AudioPlayer ───────────────────────────────────────────────────────────────

type PlaybackStatus = 'idle' | 'resolving' | 'loading' | 'playing' | 'blocked' | 'ended' | 'unavailable';

const PREVIEW_SECONDS = 30;

interface AudioPlayerProps {
  previewUrl: string | null;
  streamUrl: string | null;
  playAt: number | null;
  currentCard: CardHidden | null;
  revealedCard: Card | null;
  isFlipped: boolean;
  isActivePlayer: boolean;
}

function AudioPlayer({
  previewUrl,
  streamUrl,
  playAt,
  currentCard,
  revealedCard,
  isFlipped,
  isActivePlayer,
}: AudioPlayerProps) {
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
  }, [previewUrl, streamUrl, playAt, currentCard?.trackId]);

  const statusMessage = (() => {
    if (playbackStatus === 'resolving' || playbackStatus === 'loading') return 'Loading preview…';
    if (playbackStatus === 'unavailable') return 'Preview unavailable for this track.';
    if (playbackStatus === 'blocked') return 'Your browser blocked autoplay.';
    if (playbackStatus === 'ended') return 'Preview finished.';
    if (playbackStatus === 'playing') {
      return isActivePlayer ? 'Song is playing…' : 'Song is playing for all…';
    }
    return isActivePlayer ? 'Starting preview…' : 'Starting preview for all…';
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
              <img src={albumArt} alt="Album art" />
              {!isFlipped && <div className="album-art-blur">🎵</div>}
            </>
          ) : (
            <div className="album-art-blur">🎵</div>
          )}
        </div>

        <div className="song-info">
          <div className="song-label">
            {isFlipped
              ? 'REVEALED'
              : isActivePlayer
                ? 'NOW PLAYING — PLACE THIS CARD'
                : 'NOW PLAYING'}
          </div>
          {showDetails && revealedCard ? (
            <>
              <div className="song-title">{revealedCard.title}</div>
              <div className="song-artist">{revealedCard.artist}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
                <div className="song-year">{revealedCard.releaseYear}</div>
              </div>
            </>
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
                  ▶ Tap to play
                </button>
              )}
            </div>
          )}
        </div>

        {playbackStatus === 'playing' && (
          <div className="song-timer-wrap">
            <div className="song-timer-label">TIME LEFT</div>
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

function ChallengeBar({ deadline }: ChallengeBarProps) {
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
      <div className="challenge-timer-count">{seconds}s</div>
      <div className="challenge-timer-label">Challenge window</div>
    </div>
  );
}

// ── WinScreen ─────────────────────────────────────────────────────────────────

interface WinScreenProps {
  winnerId: string | null;
  room: Room;
  sessionId: string;
  onBackToLobby: () => void;
  onLeave: () => void;
  onEndGame: () => void;
}

function WinScreen({ winnerId, room, sessionId, onBackToLobby, onLeave, onEndGame }: WinScreenProps) {
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
    title = 'Team Wins!';
    subtitle = `You reached ${cardsToWin} cards together!`;
  } else if (isCoopLoss) {
    title = 'Team Lost';
    subtitle = 'The shared token pool ran out.';
  } else if (winnerTeam) {
    title = isMyTeam ? 'Your Team Wins!' : `${winnerTeam.name} Wins!`;
    subtitle = `${winnerTeam.name} reached ${cardsToWin} cards first.`;
  } else if (isMe) {
    title = 'You Win!';
    subtitle = 'You built the perfect timeline!';
  } else if (winner) {
    title = `${winner.displayName} Wins!`;
    subtitle = `${winner.displayName} reached ${cardsToWin} cards first.`;
  } else {
    title = 'Game Over!';
    subtitle = 'The deck ran out.';
  }

  const isOwner = room.ownerId === sessionId;

  return (
    <div className="win-screen">
      <div className="scanlines" />
      <div className="win-trophy">{isCoopLoss ? '💀' : '🏆'}</div>
      <div className="win-title">{title}</div>
      <div className="win-subtitle">{subtitle}</div>

      {/* Round history */}
      {room.roundHistory.length > 0 && (
        <div className="win-history">
          <div className="win-history-title">Round History</div>
          {room.roundHistory.map((r, i) => {
            const rWinner = r.winnerId && room.players[r.winnerId]
              ? room.players[r.winnerId].displayName
              : r.winnerId === 'cooperative' ? 'Team' : r.winnerId && room.teams[r.winnerId]
                ? room.teams[r.winnerId].name
                : 'No winner';
            return (
              <div key={i} className="win-history-row">
                <span className="win-history-round">Round {r.roundNumber}</span>
                <span className="win-history-mode">{r.mode}</span>
                <span className="win-history-winner">{rWinner}</span>
              </div>
            );
          })}
        </div>
      )}

      <div className="win-actions">
        <button className="win-play-again" onClick={onBackToLobby}>
          {isOwner ? '⊕ Back to Lobby' : '← Back to Lobby'}
        </button>
        <button className="win-leave" onClick={onLeave}>
          Leave Room
        </button>
        {isOwner && (
          <button className="win-end-game" onClick={onEndGame}>
            ✕ End Game
          </button>
        )}
      </div>
    </div>
  );
}

// ── Lobby screen ──────────────────────────────────────────────────────────────

const MODES: { value: GameMode; label: string; desc: string }[] = [
  { value: 'original', label: 'Original', desc: '2 starting tokens, naming bonus on' },
  { value: 'pro',      label: 'Pro',      desc: '5 starting tokens, no naming bonus' },
  { value: 'expert',   label: 'Expert',   desc: '3 starting tokens, no naming bonus' },
  { value: 'cooperative', label: 'Cooperative', desc: 'Shared timeline & tokens, reach target together' },
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
}

function LobbyScreen({ room, sessionId, onStartRound, onCreateTeam, onJoinTeam, onLeaveTeam, onLeave, socketError, onPreviewPlaylist, onClearPlaylistPreview, playlistPreviewCards, playlistPreviewLoading, localPlayers, onAddLocalPlayer, onRemoveLocalPlayer }: LobbyScreenProps) {
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
                <span className="lobby-local-badge" title="Plays on this device">📺</span>
              )}
              {!p.isConnected && (
                <span className="player-disconnected-badge">offline</span>
              )}
            </div>
          );
        })}
      </div>

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
              {playlistPreviewLoading ? '…' : '🔍 Preview'}
            </button>
          </div>

          {playlistPreviewCards && (
            <TrackPreviewModal
              cards={playlistPreviewCards}
              onClose={onClearPlaylistPreview}
            />
          )}

          <div className="lobby-config-section">
            <div className="lobby-config-label">Game Mode</div>
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
                  <div className="lobby-mode-name">{m.label}</div>
                  <div className="lobby-mode-desc">{m.desc}</div>
                </label>
              ))}
            </div>

            <div className="lobby-config-row">
              <label className="lobby-config-label" htmlFor="cards-to-win">
                Cards to Win
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
                Time per Turn
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
                    {s ? `${s} seconds` : 'No limit'}
                  </option>
                ))}
              </select>
            </div>

            <div className="lobby-config-row">
              <label className="lobby-config-label" htmlFor="tokens-enabled">
                Tokens Enabled
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

      {/* ── Hot-seat: more players on this device ── */}
      <div className="lobby-teams-section" data-testid="local-players-section">
        <div className="lobby-config-label">Players on this device</div>
        <div className="lobby-local-hint">
          Playing together on one screen (TV, laptop)? Add everyone here — turns are passed
          around on this device. Others can still join online.
        </div>
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
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="lobby-create-team-row">
          <input
            className="form-input"
            type="text"
            placeholder="Player name…"
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
            + Add
          </button>
        </div>
      </div>

      {/* ── Teams section ── */}
      <div className="lobby-teams-section">
        <div className="lobby-config-label">Teams (optional)</div>

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
                      Join
                    </button>
                  ) : (
                    <button
                      className="lobby-team-btn leave"
                      onClick={onLeaveTeam}
                      data-testid="leave-team-btn"
                    >
                      Leave
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
            placeholder="New team name…"
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
            + Create
          </button>
        </div>
      </div>

      {socketError && (
        <div className="server-error-msg">{socketError}</div>
      )}

      {isOwner ? (
        <button
          className="lobby-start-btn"
          disabled={players.length < 1 || starting}
          onClick={handleStart}
          data-testid="start-round-btn"
        >
          {starting ? 'Starting…' : '▶ Start Round'}
        </button>
      ) : (
        <div className="lobby-waiting">
          Waiting for {room.players[room.ownerId]?.displayName ?? 'host'} to start...
        </div>
      )}

      <button className="lobby-leave-btn" onClick={onLeave} data-testid="leave-btn">
        ← Leave Room
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
  timelineLength: number;
  lastFlip: {
    card: Card;
    correct: boolean;
    activePlayerId: string;
    placedPosition: number;
    challengeResults: Array<{ challengerId: string; outcome: 'stole_card' | 'lost_token' }>;
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
}

export default function GameRoom({
  room,
  currentCard,
  activePlayerId,
  previewUrl,
  streamUrl,
  playAt,
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
}: GameRoomProps) {
  const [selectedPosition, setSelectedPosition] = useState<number | null>(null);
  const [showFlipResult, setShowFlipResult] = useState(false);
  const [flipRevealSnapshot, setFlipRevealSnapshot] = useState<{
    position: number;
    card: Card;
    correct: boolean;
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
  const viewerName = room.players[sessionId]?.displayName ?? 'You';

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
  const placeHint = placedPosition === null ? 'Drag the card into a gap, or tap a gap' : 'placed';
  const mainTimelineLabel = watchingOther
    ? `${activeName.toUpperCase()}'S TIMELINE — watch where they place`
    : isActivePlayer
      ? isHotSeat && !isCooperative
        ? `${activeName.toUpperCase()}'S TIMELINE — ${placeHint}`
        : `YOUR TIMELINE — ${placeHint}`
      : 'TIMELINE';
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
        }
      : null;

  const logEntries = useMemo(
    () => renderGameLog(round?.gameLog),
    [round?.gameLog],
  );

  // Everyone on this device who may shout HITSTER! on the current placement
  const challengers =
    isInChallengePhase && !isCooperative
      ? localIds
          .filter(id => room.players[id] && !room.players[id].isSpectator)
          .filter(id => !isParticipantOf(id, resolvedActivePlayerId))
          .map(id => ({
            id,
            label: isHotSeat ? `Challenge: ${room.players[id].displayName}` : 'Challenge',
            doneLabel: isHotSeat ? `${room.players[id].displayName} ✓` : 'Challenged ✓',
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
        <div className="win-title">Game Over</div>
        <div className="win-subtitle">Thanks for playing!</div>
        {room.roundHistory.length > 0 && (
          <div className="win-history">
            <div className="win-history-title">Round History</div>
            {room.roundHistory.map((r, i) => {
              const rWinner = r.winnerId && room.players[r.winnerId]
                ? room.players[r.winnerId].displayName
                : r.winnerId === 'cooperative' ? 'Team'
                : r.winnerId && room.teams[r.winnerId] ? room.teams[r.winnerId].name
                : 'No winner';
              return (
                <div key={i} className="win-history-row">
                  <span className="win-history-round">Round {r.roundNumber}</span>
                  <span className="win-history-mode">{r.mode}</span>
                  <span className="win-history-winner">{rWinner}</span>
                </div>
              );
            })}
          </div>
        )}
        <div className="win-actions">
          <button className="win-leave" onClick={onLeave}>← Leave</button>
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
          <div className="room-code-badge">ROOM: {room.code}</div>
          <button type="button" className="header-leave-btn" onClick={onLeave} data-testid="leave-btn">
            Leave
          </button>
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

      {/* Header */}
      <header className="game-header">
        <HitsterLogo />
        <div className="room-code-badge">ROOM: {room.code}</div>
        <div className="game-header-actions">
          {!isSpectator && round?.config.tokensEnabled !== false && (
            <TokenPanel
              myTokens={myTokens}
              label={isHotSeat && !isCooperative ? `${viewerName}'s tokens` : 'Your tokens'}
            />
          )}
          <button type="button" className="header-leave-btn" onClick={onLeave} data-testid="leave-btn">
            Leave
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
        />

        {/* CENTER: Gameplay */}
        <div className={`center-col${showFlipResult ? ' center-col--reveal-active' : ''}`}>
          {isHotSeat && activeLocalId && currentTurn?.phase === 'place' && (
            <div className="hotseat-banner" role="status" aria-live="polite" data-testid="hotseat-banner">
              🎮 {viewerName}&apos;s turn
            </div>
          )}
          {isSpectator && (
            <div className="spectator-banner" role="status" aria-live="polite">
              <div className="spectator-banner__title">
                <span className="spectator-banner__icon" aria-hidden>
                  👁
                </span>
                Spectator mode
              </div>
              <p className="spectator-banner__hint">
                You&apos;re watching this round. You&apos;ll play when the next round starts.
              </p>
            </div>
          )}
          <AudioPlayer
            previewUrl={previewUrl}
            streamUrl={streamUrl}
            playAt={playAt}
            currentCard={currentCard}
            revealedCard={revealedCard}
            isFlipped={isFlipped}
            isActivePlayer={isActivePlayer}
          />

          {isCooperative && round && (round.tokens['cooperative'] ?? 0) <= 2 && (
            <div className="coop-token-warning">
              ⚠ Only {round.tokens['cooperative'] ?? 0} shared token{(round.tokens['cooperative'] ?? 0) !== 1 ? 's' : ''} left!
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
                label={isHotSeat ? `${viewerName.toUpperCase()}'S TIMELINE — not your turn` : 'YOUR TIMELINE — not your turn'}
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
                CONFIRM PLACE
              </button>
            )}

            {isActivePlayer && currentCard && !isInChallengePhase && (
              <button
                className="action-btn btn-skip-action"
                data-testid="skip-btn"
                disabled={myTokens < 1}
                onClick={() => onSkipCard(sessionId)}
              >
                SKIP (1🪙)
              </button>
            )}

            {isActivePlayer && currentCard && !isInChallengePhase && currentTurn?.phase === 'place' && (
              <button
                className="action-btn btn-buy-action"
                data-testid="buy-btn"
                disabled={myTokens < 3}
                onClick={() => onBuyCard(sessionId)}
                title="Spend 3 tokens to place without hearing — your next turn will be skipped"
              >
                BUY (3🪙)
              </button>
            )}

          </div>
        </div>

        {/* RIGHT: Game log + challenge timer */}
        <div className="right-side-panel">
          <div className="panel-title">Game Log</div>

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
              <div style={{ color: '#374151', fontSize: 12 }}>Game log will appear here.</div>
            )}
          </div>

          {/* Name song panel */}
          {isActivePlayer && currentCard && !isInChallengePhase && (
            <div style={{ marginTop: 24 }}>
              <div className="panel-title">
                {round?.config.mode === 'pro' || round?.config.mode === 'expert'
                  ? 'Name the Song (required to score)'
                  : 'Name the Song (+1🪙)'}
              </div>
              <div className="name-song-form">
                <input
                  className="name-song-input"
                  data-testid="name-song-title"
                  placeholder="Title"
                  value={nameSongTitle}
                  onChange={e => setNameSongTitle(e.target.value)}
                />
              </div>
              <div className="name-song-form" style={{ marginTop: 6 }}>
                <input
                  className="name-song-input"
                  data-testid="name-song-artist"
                  placeholder="Artist"
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
                    placeholder="Year"
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
                  Submit
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

    </div>
  );
}
