import { useState, useEffect, useCallback, useRef } from 'react';
import type { Room, RoomSummary } from '../../../shared/types';
import { getSavedDisplayName, saveDisplayName } from '../socket/client';

interface EntryPageProps {
  onConnectAndCreateRoom: (displayName: string, topic: string) => void;
  onConnectAndJoinRoom: (displayName: string, roomCode: string) => void;
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

function statusBadgeText(status: string): string {
  if (status === 'lobby') return 'LOBBY';
  if (status === 'round_active') return 'LIVE';
  return 'ENDED';
}

function isRoomJoinable(status: string): boolean {
  return status === 'lobby' || status === 'round_ended' || status === 'round_active';
}

export default function EntryPage({
  onConnectAndCreateRoom,
  onConnectAndJoinRoom,
  serverUrl,
  serverError,
  roomJoined,
}: EntryPageProps) {
  const [displayName, setDisplayName] = useState(getSavedDisplayName);
  const [nameError, setNameError] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [joinTopic, setJoinTopic] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [roomsLoading, setRoomsLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const topicInputRef = useRef<HTMLInputElement>(null);

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
    onConnectAndJoinRoom(resolvedName, roomCode);
  }

  function handleCreateSubmit() {
    if (!nameValid || !joinTopic.trim()) return;
    setConnecting(true);
    onConnectAndCreateRoom(resolvedName, joinTopic.trim());
    setShowCreateModal(false);
    setJoinTopic('');
  }

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
        <div className="live-dot">
          <span className="dot-pulse" />
          LIVE
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
            Build your timeline. Guess the decade. First to 6 songs wins.
          </div>

          {/* Name — the only identity: rejoin a room under the same name to get your seat back */}
          <div className="field">
            <div className="field-label">
              <span className="req-dot" />
              Your name
            </div>
            <input
              className={`form-input${nameValid ? ' valid' : ''}${nameError ? ' err' : ''}`}
              type="text"
              placeholder="e.g. Anna"
              autoComplete="nickname"
              maxLength={24}
              value={displayName}
              onChange={e => handleNameChange(e.target.value)}
              data-testid="display-name-input"
            />
            {nameError && (
              <div className="err-msg">Enter your name first</div>
            )}
            <div className="field-hint">
              Lost connection? Join the same room with the same name to continue.
            </div>
          </div>

          <hr className="form-divider" />

          {/* Create button */}
          <button
            className="btn btn-create"
            disabled={connecting}
            onClick={handleCreateClick}
          >
            {connecting ? '⏳ Connecting…' : '⊕ Create a room'}
          </button>

          <div className="join-code-row">
            <input
              className="form-input"
              type="text"
              placeholder="Room code"
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
              Join
            </button>
          </div>

          {/* Server error banner */}
          {serverError && (
            <div className="server-error-msg" role="alert">
              {serverError}
            </div>
          )}

        </div>

        {/* RIGHT: Room Browser */}
        <div className="rooms-col">
          <div className="rooms-header">
            <div className="rooms-title">Active Rooms</div>
            <div className="rooms-count">
              {roomsLoading ? 'Loading…' : `${openRoomCount} room${openRoomCount !== 1 ? 's' : ''} open`}
            </div>
          </div>

          {!roomsLoading && rooms.length === 0 && (
            <div className="no-rooms">
              <div className="no-rooms-icon">🎮</div>
              <div className="no-rooms-text">No rooms yet.<br />Be the first to create one!</div>
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
                    ? 'Click to spectate'
                    : 'Click to join'
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
                  {statusBadgeText(room.status)}
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
                      {i === 0 && room.leaderName ? room.leaderName : `P${i + 1}`}
                    </div>
                  );
                })}
              </div>

              <div className="rc-progress">
                {room.roundNumber && room.leaderCards !== undefined && room.cardsToWin ? (
                  <>
                    <div className="rp-label">Round {room.roundNumber} · Progress</div>
                    <div className="rp-leader">
                      {room.leaderName} — {room.leaderCards} / {room.cardsToWin} cards
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
                    <div className="rp-label">Waiting to start</div>
                    <div className="rp-waiting">
                      {room.playerCount} player{room.playerCount !== 1 ? 's' : ''} in lobby
                    </div>
                  </>
                )}
              </div>

              {isRoomJoinable(room.status) && (
                <div className="rc-join-hint">
                  {room.status === 'round_active' ? 'CLICK TO SPECTATE' : 'CLICK TO JOIN'}
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
            <div className="modal-title">Create a Room</div>
            <div className="field">
              <div className="field-label">Room Topic / Theme</div>
              <input
                ref={topicInputRef}
                className="form-input"
                type="text"
                placeholder="e.g. 90s Night, Pop Classics…"
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
                ⊕ Create
              </button>
              <button className="btn-cancel" onClick={() => setShowCreateModal(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
