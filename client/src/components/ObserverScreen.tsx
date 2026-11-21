import { useEffect, useMemo, useRef, useState } from 'react';
import { FLIP_REVEAL_DISPLAY_MS } from '../../../shared/constants';
import type { Card, CardHidden, Room } from '../../../shared/types';
import { TimelineView } from './TimelineView';
import { renderGameLog } from '../game/gameLog';
import {
  AudioPlayer,
  ChallengeBar,
  MuteToggle,
  TurnCountdown,
  TurnSplash,
  WinScreen,
  activeEntityIdFromRoom,
  activePlayerDisplayName,
  avatarColor,
} from './GameRoom';
import { useT, withNodes, type TFunction } from '../i18n';
import { LanguageSwitcher } from '../i18n/LanguageSwitcher';

/**
 * Observer screen (TV): the whole room at a glance, big enough to read from the sofa.
 * Holds no seat — it shows the active timeline, scores, the song reveal and the log,
 * and plays the turn audio like any other device.
 */

export interface ObserverScreenProps {
  room: Room;
  currentCard: CardHidden | null;
  activePlayerId: string | null;
  previewUrl: string | null;
  streamUrl: string | null;
  playAt: number | null;
  speaker: { deviceName: string } | null;
  turnEndsAt: number | null;
  lastFlip: {
    card: Card;
    correct: boolean;
    activePlayerId: string;
    placedPosition: number;
    timedOut: boolean;
  } | null;
  roundEnded: { winnerId: string | null } | null;
  onDismissRoundEnd: () => void;
  onLeave: () => void;
}

interface ScoreRow {
  id: string;
  name: string;
  cards: number;
  tokens: number;
  active: boolean;
  offline: boolean;
}

function scoreRows(room: Room, activeEntity: string | null, t: TFunction): ScoreRow[] {
  const round = room.activeRound;
  if (!round) {
    return Object.values(room.players)
      .filter(p => !p.isSpectator)
      .map(p => ({ id: p.id, name: p.displayName, cards: 0, tokens: 0, active: false, offline: !p.isConnected }));
  }
  if (round.config.mode === 'cooperative') {
    return [{
      id: 'cooperative',
      name: t('common.team'),
      cards: round.timelines.cooperative?.cards.length ?? 0,
      tokens: round.tokens.cooperative ?? 0,
      active: true,
      offline: false,
    }];
  }
  return round.turnOrder
    .map(id => {
      const team = room.teams[id];
      const player = room.players[id];
      const offline = team
        ? !team.playerIds.some(pid => room.players[pid]?.isConnected)
        : !player?.isConnected;
      return {
        id,
        name: team?.name ?? player?.displayName ?? '…',
        cards: round.timelines[id]?.cards.length ?? 0,
        tokens: round.tokens[id] ?? 0,
        active: id === activeEntity,
        offline,
      };
    })
    .sort((a, b) => b.cards - a.cards);
}

export default function ObserverScreen({
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
  onDismissRoundEnd,
  onLeave,
}: ObserverScreenProps) {
  const t = useT();
  const round = room.activeRound;
  const currentTurn = round?.currentTurn;
  const resolvedActive = activePlayerId ?? currentTurn?.activeId ?? null;
  const activeEntity = resolvedActive ? activeEntityIdFromRoom(room, resolvedActive) : null;
  const activeName = activePlayerDisplayName(room, resolvedActive);
  const joinHost = window.location.host;

  // TVs need one click/remote press before the browser lets them play sound
  const [needsTap, setNeedsTap] = useState(true);
  useEffect(() => {
    const onGesture = () => setNeedsTap(false);
    window.addEventListener('pointerdown', onGesture, { once: true });
    window.addEventListener('keydown', onGesture, { once: true });
    return () => {
      window.removeEventListener('pointerdown', onGesture);
      window.removeEventListener('keydown', onGesture);
    };
  }, []);

  // Reveal snapshot, shown for the reveal time (same as on the phones)
  const [reveal, setReveal] = useState<{ card: Card; correct: boolean; position: number; timedOut: boolean; entity: string } | null>(null);
  useEffect(() => {
    if (!lastFlip) return;
    setReveal({
      card: lastFlip.card,
      correct: lastFlip.correct,
      position: lastFlip.placedPosition,
      timedOut: lastFlip.timedOut,
      entity: activeEntityIdFromRoom(room, lastFlip.activePlayerId),
    });
    const t = setTimeout(() => setReveal(null), FLIP_REVEAL_DISPLAY_MS);
    return () => clearTimeout(t);
  }, [lastFlip]); // eslint-disable-line react-hooks/exhaustive-deps

  // Turn splash on every new turn
  const phase = currentTurn?.phase;
  const prevRef = useRef<{ id: string | null; phase: string | undefined }>({ id: null, phase: undefined });
  const [splash, setSplash] = useState<{ key: number; text: string } | null>(null);
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = { id: resolvedActive, phase };
    if (room.status !== 'round_active' || phase !== 'place' || !resolvedActive) return;
    if (prev.phase === 'place' && prev.id === resolvedActive) return;
    setSplash(s => ({ key: (s?.key ?? 0) + 1, text: t('turn.other', { name: activePlayerDisplayName(room, resolvedActive) }) }));
  }, [resolvedActive, phase]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!splash) return;
    const t = setTimeout(() => setSplash(null), 1400);
    return () => clearTimeout(t);
  }, [splash]);

  // Win screen stays until the owner starts the next round
  useEffect(() => {
    if (roundEnded && room.status === 'round_active') onDismissRoundEnd();
  }, [room.status, roundEnded, onDismissRoundEnd]);

  const logEntries = useMemo(() => renderGameLog(round?.gameLog, t).slice(0, 14), [round?.gameLog, t]);

  if (roundEnded) {
    return <WinScreen winnerId={roundEnded.winnerId} room={room} sessionId="" />;
  }

  const header = (
    <header className="tv-header">
      <div className="logo">HITSTER</div>
      <div className="tv-join">
        {withNodes(t('tv.joinOn'), {
          host: <strong>{joinHost}</strong>,
          code: <span className="tv-code">{room.code}</span>,
        })}
      </div>
      <div className="game-header-actions">
        <LanguageSwitcher />
        <MuteToggle />
        <button type="button" className="header-leave-btn" onClick={onLeave}>{t('common.close')}</button>
      </div>
    </header>
  );

  const tapBanner = needsTap && (
    <div className="tv-tap-banner" role="status">{t('tv.tapForSound')}</div>
  );

  // Lobby / between rounds: big join instructions
  if (room.status !== 'round_active' || !round) {
    const players = Object.values(room.players);
    return (
      <div className="tv-root" data-testid="observer-screen">
        <div className="scanlines" />
        {header}
        {tapBanner}
        <div className="tv-lobby">
          <div className="tv-lobby-title">{room.topic}</div>
          <div className="tv-lobby-join">
            <div>{withNodes(t('tv.open'), { host: <strong>{joinHost}</strong> })}</div>
            <div>{t('tv.enterCode')}</div>
            <div className="tv-lobby-code">{room.code}</div>
          </div>
          <div className="tv-lobby-players">
            {players.map(p => {
              const color = avatarColor(p.displayName);
              return (
                <div key={p.id} className="tv-lobby-player" style={{ borderColor: color, color }}>
                  {p.displayName}
                </div>
              );
            })}
          </div>
          <div className="tv-lobby-wait">
            {players.length === 0 ? t('tv.waitingPlayers') : t('tv.waitingHost')}
          </div>
        </div>
      </div>
    );
  }

  const isCooperative = round.config.mode === 'cooperative';
  // During a reveal keep showing the timeline it happened on, even if the next turn already began
  const timelineEntity = isCooperative ? 'cooperative' : (reveal?.entity ?? activeEntity);
  const cards = timelineEntity ? round.timelines[timelineEntity]?.cards ?? [] : [];
  const isChallenge = phase === 'challenge';
  const placedPosition = isChallenge && currentTurn?.placedPosition !== undefined ? currentTurn.placedPosition : null;
  const flipReveal = reveal && reveal.entity === timelineEntity
    ? { position: reveal.position, card: reveal.card, correct: reveal.correct, timedOut: reveal.timedOut }
    : null;
  const isFlipped = phase === 'flip' || reveal !== null;
  const rows = scoreRows(room, activeEntity, t);
  const cardsToWin = round.config.cardsToWin;

  return (
    <div className="tv-root" data-testid="observer-screen">
      <div className="scanlines" />
      {splash && <TurnSplash key={splash.key} text={splash.text} mine={false} />}
      {header}
      {tapBanner}

      <div className="tv-main">
        <aside className="tv-scores">
          <div className="panel-title">{t('tv.scores', { count: cardsToWin })}</div>
          {rows.map((r, i) => (
            <div
              key={r.id}
              className={`tv-score-row${r.active ? ' tv-score-row--active' : ''}${r.offline ? ' tv-score-row--offline' : ''}`}
            >
              <span className="tv-score-rank">{i + 1}</span>
              <span className="tv-score-name">{r.name}</span>
              <span className="tv-score-cards" key={r.cards}>{r.cards}</span>
              {round.config.tokensEnabled && (
                <span className="tv-score-tokens" aria-label={t('common.coins', { count: r.tokens })}>
                  {Array.from({ length: 5 }, (_, k) => (
                    <span key={k} className={`token-dot${k >= r.tokens ? ' empty' : ''}`} />
                  ))}
                </span>
              )}
              <span className="tv-score-bar" aria-hidden>
                <span style={{ width: `${Math.min(100, (r.cards / cardsToWin) * 100)}%` }} />
              </span>
            </div>
          ))}
        </aside>

        <section className="tv-center">
          <div className="tv-turn">
            <div className="tv-turn-name" key={activeName}>
              {isCooperative ? t('turn.team') : t('turn.other', { name: activeName })}
            </div>
            {phase === 'place' && turnEndsAt !== null && (
              <div className="tv-turn-countdown">
                <TurnCountdown endsAt={turnEndsAt} totalSeconds={round.config.turnSeconds} />
              </div>
            )}
            {isChallenge && <ChallengeBar deadline={currentTurn?.challengeDeadline ?? null} />}
          </div>

          <AudioPlayer
            previewUrl={previewUrl}
            streamUrl={streamUrl}
            playAt={playAt}
            speaker={speaker}
            currentCard={currentCard}
            revealedCard={lastFlip?.card ?? null}
            isFlipped={isFlipped}
            isActivePlayer={false}
          />

          <div className="tv-timeline">
            <TimelineView
              cards={cards}
              pendingCard={null}
              label={isCooperative
                ? t('timeline.team')
                : t('timeline.of', { name: activePlayerDisplayName(room, timelineEntity).toUpperCase() })}
              readOnly
              placedPosition={placedPosition}
              selectedPosition={null}
              onSelectPosition={() => {}}
              isInChallengePhase={isChallenge}
              showPlacementToAll
              testId="tv-timeline"
              flipReveal={flipReveal}
            />
          </div>
        </section>

        <aside className="tv-log">
          <div className="panel-title">{t('log.title')}</div>
          <div className="game-log">
            {logEntries.map(entry => (
              <div key={entry.id} className="log-entry" dangerouslySetInnerHTML={{ __html: entry.html }} />
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}
