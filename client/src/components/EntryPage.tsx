import { useState, useEffect, useCallback, useRef } from 'react';
import type { Room, RoomSummary } from '../../../shared/types';
import { getSavedDisplayName, saveDisplayName, getLastRoom, type LastRoom } from '../socket/client';
import { useT, type MessageKey } from '../i18n';
import { translateError } from '../i18n/errors';
import { LanguageSwitcher } from '../i18n/LanguageSwitcher';

interface EntryPageProps {
  onConnectAndCreateRoom: (displayName: string, topic: string, companions: string[]) => void;
  onConnectAndJoinRoom: (displayName: string, roomCode: string, companions: string[]) => void;
  onRejoinLastRoom: (lastRoom: LastRoom) => void;
  /** Open this device as the room's TV / observer screen */
  onObserveRoom: (roomCode: string) => void;
  serverUrl?: string;
  serverError?: string | null;
  roomJoined?: Room | null;
}

const AVATAR_COLORS = [
  '#4ade80', '#a78bfa', '#fbbf24', '#f87171',
  '#60a5fa', '#fb923c', '#c084fc', '#34d399', '#f472b6',
];

function avatarColor(name: string): string {
  let sum = 0;
  for (let i = 0; i < name.length; i++) sum += name.charCodeAt(i);
  return AVATAR_COLORS[sum % AVATAR_COLORS.length];
}

function statusBadgeClass(status: string): string {
  if (status === 'lobby') return 'badge-lobby';
  if (status === 'round_active') return 'badge-active';
  return 'badge-over';
}

function statusBadgeKey(status: string): MessageKey {
  if (status === 'lobby') return 'entry.status.lobby';
  if (status === 'round_active') return 'entry.status.live';
  return 'entry.status.ended';
}

function isRoomJoinable(status: string): boolean {
  return status === 'lobby' || status === 'round_ended' || status === 'round_active';
}

export default function EntryPage({
  onConnectAndCreateRoom,
  onConnectAndJoinRoom,
  onRejoinLastRoom,
  onObserveRoom,
  serverUrl,
  serverError,
  roomJoined,
}: EntryPageProps) {
  const t = useT();
  const [displayName, setDisplayName] = useState(getSavedDisplayName);
  const [nameError, setNameError] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [joinTopic, setJoinTopic] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [roomsLoading, setRoomsLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  // More people sharing this phone — each gets their own seat, turns pass around on this device
  const [companions, setCompanions] = useState<string[]>([]);
  const [companionName, setCompanionName] = useState('');
  const [showCompanions, setShowCompanions] = useState(false);
  const topicInputRef = useRef<HTMLInputElement>(null);
  // Read on every render: a kick or leave clears it while this page is shown
  const lastRoom = getLastRoom();

  // Clear connecting spinner when room is joined or an error arrives
  useEffect(() => {
    if (roomJoined || serverError) {
      setConnecting(false);
    }
  }, [roomJoined, serverError]);

  const resolvedName = displayName.trim();
  const nameValid = resolvedName.length > 0;

  // Fetch rooms every 10s
  const fetchRooms = useCallback(async () => {
    const base = serverUrl ?? '';
    try {
      const res = await fetch(`${base}/rooms`);
      if (res.ok) {
        const data = await res.json() as RoomSummary[];
        setRooms(data);
      }
    } catch {
      // ignore network errors — keep showing old data
    } finally {
      setRoomsLoading(false);
    }
  }, [serverUrl]);

  useEffect(() => {
    void fetchRooms();
    const interval = setInterval(() => { void fetchRooms(); }, 2000);
    return () => clearInterval(interval);
  }, [fetchRooms]);

  function handleNameChange(v: string) {
    setDisplayName(v);
    saveDisplayName(v);
    setNameError(false);
  }

  function handleCreateClick() {
    if (!nameValid) {
      setNameError(true);
      return;
    }
    setShowCreateModal(true);
    setTimeout(() => topicInputRef.current?.focus(), 50);
  }

  function handleJoinRoom(roomCode: string) {
    if (!nameValid) {
      setNameError(true);
      return;
    }
    if (connecting || !roomCode.trim()) return;
    setConnecting(true);
    onConnectAndJoinRoom(resolvedName, roomCode, companions);
  }

  function handleCreateSubmit() {
    if (!nameValid || !joinTopic.trim()) return;
    setConnecting(true);
    onConnectAndCreateRoom(resolvedName, joinTopic.trim(), companions);
    setShowCreateModal(false);
    setJoinTopic('');
  }

  function addCompanion() {
    const name = companionName.trim();
    if (!name) return;
    const taken = [resolvedName, ...companions].some(n => n.toLowerCase() === name.toLowerCase());
    if (!taken) setCompanions(prev => [...prev, name]);
    setCompanionName('');
  }

  function handleRejoin(saved: LastRoom) {
    if (connecting) return;
    setConnecting(true);
    setDisplayName(saved.displayName);
    onRejoinLastRoom(saved);
  }

  // Offer the rejoin only while that room still exists
  const rejoinable = lastRoom
    ? rooms.find(r => r.code === lastRoom.roomCode && isRoomJoinable(r.status)) ?? null
    : null;

  const openRoomCount = rooms.filter(r => r.status !== 'game_over').length;

  return (
    <div className="entry-root">
      {/* Scanlines overlay */}
      <div className="scanlines" />

      {/* Header */}
      <header className="entry-header">
        <div className="logo">
          HITSTER
          <span className="cursor-blink" />
        </div>
        <div className="entry-header-actions">
          <div className="live-dot">
            <span className="dot-pulse" />
            {t('header.live')}
          </div>
          <LanguageSwitcher />
        </div>
      </header>

      {/* Split layout */}
      <div className="entry-split">
        {/* LEFT: Form */}
        <div className="form-col">
          <div className="hero-title">
            HIT<span className="hero-title-green">STER</span>
          </div>
          <div className="hero-sub">
            {t('entry.tagline')}
          </div>

          {/* Name — the only identity: rejoin a room under the same name to get your seat back */}
          <div className="field">
            <div className="field-label">
              <span className="req-dot" />
              {t('entry.nameLabel')}
            </div>
            <input
              className={`form-input${nameValid ? ' valid' : ''}${nameError ? ' err' : ''}`}
              type="text"
              placeholder={t('entry.namePlaceholder')}
              autoComplete="nickname"
              maxLength={24}
              value={displayName}
              onChange={e => handleNameChange(e.target.value)}
              data-testid="display-name-input"
            />
            {nameError && (
              <div className="err-msg">{t('entry.nameRequired')}</div>
            )}
            <div className="field-hint">
              {t('entry.nameHint')}
            </div>
          </div>

          {/* Shared phone: more players on this device */}
          <div className="field companions-field">
            {companions.length > 0 && (
              <div className="companion-chips">
                {companions.map(name => (
                  <span key={name} className="companion-chip">
                    {name}
                    <button
                      type="button"
                      aria-label={t('entry.removeCompanion', { name })}
                      onClick={() => setCompanions(prev => prev.filter(n => n !== name))}
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            )}
            {showCompanions || companions.length > 0 ? (
              <div className="companion-add-row">
                <input
                  className="form-input"
                  type="text"
                  placeholder={t('entry.companionPlaceholder')}
                  maxLength={24}
                  value={companionName}
                  onChange={e => setCompanionName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addCompanion()}
                  data-testid="companion-name-input"
                />
                <button
                  type="button"
                  className="btn-companion-add"
                  disabled={!companionName.trim()}
                  onClick={addCompanion}
                  data-testid="companion-add-btn"
                >
                  {t('common.add')}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn-companion-toggle"
                onClick={() => setShowCompanions(true)}
                data-testid="companion-toggle-btn"
              >
                {t('entry.companionToggle')}
              </button>
            )}
            {(showCompanions || companions.length > 0) && (
              <div className="field-hint">
                {t('entry.companionHint')}
              </div>
            )}
          </div>

          {lastRoom && rejoinable && (
            <button
              className="btn btn-rejoin"
              disabled={connecting}
              onClick={() => handleRejoin(lastRoom)}
              data-testid="rejoin-btn"
            >
              {t('entry.rejoin', { code: lastRoom.roomCode, name: lastRoom.displayName })}
              {(lastRoom.localPlayers?.length ?? 0) > 0 && ` +${lastRoom.localPlayers?.length}`}
              <span className="btn-rejoin-sub">{rejoinable.topic}</span>
            </button>
          )}

          <hr className="form-divider" />

          {/* Create button */}
          <button
            className="btn btn-create"
            disabled={connecting}
            onClick={handleCreateClick}
          >
            {connecting ? t('entry.connecting') : t('entry.createRoom')}
          </button>

          <div className="join-code-row">
            <input
              className="form-input"
              type="text"
              placeholder={t('entry.roomCodePlaceholder')}
              maxLength={4}
              autoCapitalize="characters"
              value={joinCode}
              onChange={e => setJoinCode(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === 'Enter' && handleJoinRoom(joinCode)}
              data-testid="join-code-input"
            />
            <button
              className="btn btn-join-code"
              disabled={connecting || joinCode.trim().length !== 4}
              onClick={() => handleJoinRoom(joinCode)}
              data-testid="join-code-btn"
            >
              {t('common.join')}
            </button>
          </div>

          <button
            type="button"
            className="btn-tv-open"
            disabled={connecting || joinCode.trim().length !== 4}
            onClick={() => onObserveRoom(joinCode)}
            data-testid="open-tv-btn"
            title={t('entry.openTvTitle')}
          >
            {t('entry.openTv')}
          </button>

          {/* Server error banner */}
          {serverError && (
            <div className="server-error-msg" role="alert">
              {translateError(serverError, t)}
            </div>
          )}

        </div>

        {/* RIGHT: Room Browser */}
        <div className="rooms-col">
          <div className="rooms-header">
            <div className="rooms-title">{t('entry.activeRooms')}</div>
            <div className="rooms-count">
              {roomsLoading ? t('entry.loading') : t('entry.roomsOpen', { count: openRoomCount })}
            </div>
          </div>

          {!roomsLoading && rooms.length === 0 && (
            <div className="no-rooms">
              <div className="no-rooms-icon">🎮</div>
              <div className="no-rooms-text">{t('entry.noRooms')}<br />{t('entry.noRoomsCta')}</div>
            </div>
          )}

          {rooms.map(room => (
            <div
              key={room.code}
              className={`room-card${room.status === 'lobby' ? ' lobby' : ''}${room.status === 'game_over' ? ' over' : ''}`}
              data-testid={isRoomJoinable(room.status) ? 'room-card-joinable' : undefined}
              role={isRoomJoinable(room.status) ? 'button' : undefined}
              tabIndex={isRoomJoinable(room.status) ? 0 : undefined}
              onClick={() => {
                if (isRoomJoinable(room.status)) handleJoinRoom(room.code);
              }}
              onKeyDown={(e) => {
                if (
                  isRoomJoinable(room.status) &&
                  (e.key === 'Enter' || e.key === ' ')
                ) {
                  e.preventDefault();
                  handleJoinRoom(room.code);
                }
              }}
              style={{ cursor: isRoomJoinable(room.status) ? 'pointer' : 'default' }}
              title={
                isRoomJoinable(room.status)
                  ? room.status === 'round_active'
                    ? t('entry.clickToSpectate')
                    : t('entry.clickToJoin')
                  : undefined
              }
            >
              <div className="rc-top">
                <div>
                  <div className="rc-code">{room.code}</div>
                  <div className="rc-topic">{room.topic}</div>
                  {room.genre && <div className="rc-genre">{room.genre}</div>}
                </div>
                <div className={`status-badge ${statusBadgeClass(room.status)}`}>
                  {t(statusBadgeKey(room.status))}
                </div>
              </div>

              <div className="rc-players">
                {Array.from({ length: room.playerCount }, (_, i) => {
                  const initial = room.leaderName ? room.leaderName[0].toUpperCase() : '?';
                  const col = avatarColor(room.leaderName ?? String(i));
                  return (
                    <div key={i} className="player-chip">
                      <div
                        className="chip-ava"
                        style={{ background: col + '22', border: `1px solid ${col}`, color: col }}
                      >
                        {i === 0 && room.leaderName ? room.leaderName[0].toUpperCase() : initial}
                      </div>
                      {i === 0 && room.leaderName ? room.leaderName : t('entry.playerChip', { n: i + 1 })}
                    </div>
                  );
                })}
              </div>

              <div className="rc-progress">
                {room.roundNumber && room.leaderCards !== undefined && room.cardsToWin ? (
                  <>
                    <div className="rp-label">{t('entry.roundProgress', { round: room.roundNumber })}</div>
                    <div className="rp-leader">
                      {t('entry.leaderProgress', { name: room.leaderName ?? '', cards: room.leaderCards, count: room.cardsToWin })}
                    </div>
                    <div className="rp-bar-wrap">
                      <div
                        className="rp-bar"
                        style={{ width: `${(room.leaderCards / room.cardsToWin) * 100}%` }}
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <div className="rp-label">{t('entry.waitingToStart')}</div>
                    <div className="rp-waiting">
                      {t('entry.playersInLobby', { count: room.playerCount })}
                    </div>
                  </>
                )}
              </div>

              {isRoomJoinable(room.status) && (
                <div className="rc-join-hint">
                  {(room.status === 'round_active' ? t('entry.clickToSpectate') : t('entry.clickToJoin')).toUpperCase()}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Create Room Modal */}
      {showCreateModal && (
        <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="modal-title">{t('entry.createTitle')}</div>
            <div className="field">
              <div className="field-label">{t('entry.topicLabel')}</div>
              <input
                ref={topicInputRef}
                className="form-input"
                type="text"
                placeholder={t('entry.topicPlaceholder')}
                maxLength={40}
                value={joinTopic}
                onChange={e => setJoinTopic(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleCreateSubmit()}
              />
            </div>
            <div className="modal-actions">
              <button
                className="btn btn-create"
                disabled={!joinTopic.trim()}
                onClick={handleCreateSubmit}
              >
                {t('entry.create')}
              </button>
              <button className="btn-cancel" onClick={() => setShowCreateModal(false)}>
                {t('common.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
