import { useState, useEffect } from 'react';
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  KeyboardSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import type { Card, CardHidden } from '../../../shared/types';

// ── Card tiles ───────────────────────────────────────────────────────────────

export interface FlipRevealState {
  position: number;
  card: Card;
  correct: boolean;
}

export function TimelineCard({ card, className = '' }: { card: Card; className?: string }) {
  return (
    <div className={`timeline-card placed-card ${className}`.trim()}>
      <div className="card-year">{card.releaseYear}</div>
      {card.albumArt ? (
        <img className="card-art" src={card.albumArt} alt="" />
      ) : (
        <div className="card-art card-art--placeholder">🎵</div>
      )}
      <div className="card-title">{card.title}</div>
      <div className="card-artist">{card.artist}</div>
    </div>
  );
}

function FlipRevealAtCard({ card, correct }: { card: Card; correct: boolean }) {
  return (
    <div
      className={`flip-reveal-slot${correct ? ' flip-reveal-slot--correct' : ' flip-reveal-slot--wrong'}`}
      data-testid="flip-reveal"
    >
      <div className={`flip-reveal-badge${correct ? ' flip-reveal-badge--correct' : ' flip-reveal-badge--wrong'}`}>
        {correct ? '✓ Correct!' : '✗ Wrong!'}
      </div>
      <div className="flip-reveal-ring" aria-hidden />
      <TimelineCard
        card={card}
        className={correct ? 'flip-reveal-card--correct' : 'flip-reveal-card--wrong'}
      />
    </div>
  );
}

export function FaceDownCard({ className = '' }: { className?: string }) {
  return (
    <div className={`timeline-card face-down ${className}`.trim()}>
      <div className="face-down-symbol">?</div>
      <div className="face-down-note" aria-hidden>
        🎵
      </div>
    </div>
  );
}

// ── DnD pieces ───────────────────────────────────────────────────────────────

function DraggablePendingCard() {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: 'pending-card',
  });

  return (
    <div
      ref={setNodeRef}
      className={`timeline-card-dock${isDragging ? ' dragging-source' : ''}`}
      {...listeners}
      {...attributes}
    >
      <FaceDownCard />
      <div className="timeline-card-dock-label">Drag into a gap — or tap a gap</div>
    </div>
  );
}

/** A player on this device who may challenge the current placement */
export interface LocalChallenger {
  id: string;
  label: string;
  doneLabel: string;
  hasChallenged: boolean;
}

interface ChallengeUnderCardProps {
  challengeSeconds: number;
  challengers: LocalChallenger[];
  onChallenge: (challengerId: string) => void;
}

function ChallengeUnderCard({ challengeSeconds, challengers, onChallenge }: ChallengeUnderCardProps) {
  return (
    <div className="timeline-challenge-panel">
      <span className="timeline-challenge-timer" aria-live="polite">
        {challengeSeconds}s
      </span>
      {challengers.map(c => (
        <button
          key={c.id}
          type="button"
          className="action-btn btn-challenge-timeline"
          onClick={() => onChallenge(c.id)}
          disabled={c.hasChallenged || challengeSeconds <= 0}
          data-testid="challenge-btn"
        >
          {c.hasChallenged ? c.doneLabel : c.label}
        </button>
      ))}
    </div>
  );
}

interface GapDropZoneProps {
  index: number;
  canPlace: boolean;
  isSelected: boolean;
  isPlaced: boolean;
  showFaceDown: boolean;
  showChallengeBelow: boolean;
  challengeSeconds: number;
  onChallenge?: (challengerId: string) => void;
  challengers: LocalChallenger[];
  onSelect: (index: number) => void;
}

function GapDropZone({
  index,
  canPlace,
  isSelected,
  isPlaced,
  showFaceDown,
  showChallengeBelow,
  challengeSeconds,
  onChallenge,
  challengers,
  onSelect,
}: GapDropZoneProps) {
  const { isOver, setNodeRef } = useDroppable({
    id: `gap-${index}`,
    disabled: !canPlace,
  });

  if (showFaceDown) {
    return (
      <div className="timeline-placement-column">
        <div className="timeline-gap-slot timeline-gap-slot--filled">
          <FaceDownCard className={isPlaced ? 'placed-in-gap' : 'selected-in-gap'} />
        </div>
        {showChallengeBelow && onChallenge && (
          <ChallengeUnderCard
            challengeSeconds={challengeSeconds}
            challengers={challengers}
            onChallenge={onChallenge}
          />
        )}
      </div>
    );
  }

  return (
    <div
      ref={setNodeRef}
      className={`drop-zone${isSelected ? ' selected-zone' : ''}${isPlaced ? ' selected-zone' : ''}${isOver ? ' drop-zone-over' : ''}`}
      onClick={() => canPlace && onSelect(index)}
      style={{ cursor: canPlace ? 'pointer' : 'default' }}
      data-testid={canPlace ? `timeline-gap-${index}` : undefined}
    >
      <div className="drop-zone-placeholder" aria-hidden>
        +
      </div>
    </div>
  );
}

// ── Timeline ─────────────────────────────────────────────────────────────────

export interface TimelineViewProps {
  cards: Card[];
  pendingCard: CardHidden | null;
  label: string;
  readOnly?: boolean;
  isActivePlayer?: boolean;
  placedPosition: number | null;
  selectedPosition: number | null;
  onSelectPosition: (pos: number) => void;
  isInChallengePhase: boolean;
  showPlacementToAll?: boolean;
  testId?: string;
  /** Show HITSTER! under the face-down card at the placed gap (spectator watch timeline) */
  showHitsterUnderPlacement?: boolean;
  challengeDeadline?: number | null;
  onChallenge?: (challengerId: string) => void;
  /** Players on this device who can challenge (one button each) */
  challengers?: LocalChallenger[];
  /** Inline correct/wrong animation at the placed card index */
  flipReveal?: FlipRevealState | null;
}

export function TimelineView({
  cards,
  pendingCard,
  label,
  readOnly = false,
  isActivePlayer = false,
  placedPosition,
  selectedPosition,
  onSelectPosition,
  isInChallengePhase,
  showPlacementToAll = false,
  testId,
  showHitsterUnderPlacement = false,
  challengeDeadline = null,
  onChallenge,
  challengers = [],
  flipReveal = null,
}: TimelineViewProps) {
  const canPlace =
    !readOnly &&
    isActivePlayer &&
    pendingCard !== null &&
    placedPosition === null &&
    !isInChallengePhase;

  const showPlacedGap =
    isInChallengePhase &&
    placedPosition !== null &&
    (isActivePlayer || showPlacementToAll);
  const showSelectedGap =
    !isInChallengePhase &&
    selectedPosition !== null &&
    selectedPosition !== placedPosition &&
    isActivePlayer;

  const showPendingDock =
    canPlace && selectedPosition === null && placedPosition === null;

  const [challengeSeconds, setChallengeSeconds] = useState(0);

  useEffect(() => {
    if (!challengeDeadline || !showHitsterUnderPlacement) {
      setChallengeSeconds(0);
      return;
    }
    const tick = () => {
      setChallengeSeconds(Math.max(0, Math.ceil((challengeDeadline - Date.now()) / 1000)));
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [challengeDeadline, showHitsterUnderPlacement]);

  const [activeDrag, setActiveDrag] = useState(false);
  // Touch: short hold starts a drag so a quick tap still selects a gap and the page scrolls
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveDrag(false);
    const { over } = event;
    if (!over || typeof over.id !== 'string' || !over.id.startsWith('gap-')) return;
    const index = parseInt(over.id.slice(4), 10);
    if (!Number.isNaN(index)) onSelectPosition(index);
  };

  const isWatchTimeline = readOnly && showPlacementToAll;

  const renderChallengeControls = () =>
    showHitsterUnderPlacement && onChallenge ? (
      <ChallengeUnderCard
        challengeSeconds={challengeSeconds}
        challengers={challengers}
        onChallenge={onChallenge}
      />
    ) : null;

  const renderFaceDownInGap = (isPlaced: boolean) => (
    <div className="timeline-gap-slot timeline-gap-slot--filled">
      <FaceDownCard className={isPlaced ? 'placed-in-gap' : 'selected-in-gap'} />
    </div>
  );

  const watchTrack = (
    <div className="timeline-track timeline-track--watch">
      {Array.from({ length: cards.length + 1 }, (_, i) => {
        const isFlipHere = flipReveal?.position === i;
        const flipCorrect = isFlipHere && flipReveal?.correct;
        const showPlacementHere = showPlacedGap && placedPosition === i && !isFlipHere;

        return (
          <div key={`watch-slot-${i}`} className="timeline-watch-slot">
            {showPlacementHere && (
              <div className="timeline-placement-column">
                {renderFaceDownInGap(true)}
                {showHitsterUnderPlacement && renderChallengeControls()}
              </div>
            )}
            {isFlipHere && flipReveal && (
              <FlipRevealAtCard card={flipReveal.card} correct={flipReveal.correct} />
            )}
            {cards[i] && !flipCorrect && <TimelineCard card={cards[i]} />}
          </div>
        );
      })}
      {flipReveal?.position === cards.length && (
        <div key="watch-flip-end" className="timeline-watch-slot">
          <FlipRevealAtCard card={flipReveal.card} correct={flipReveal.correct} />
        </div>
      )}
    </div>
  );

  const interactiveTrack = (
    <div className="timeline-track">
      {Array.from({ length: cards.length + 1 }, (_, i) => {
        const isSelected = selectedPosition === i;
        const isPlaced = placedPosition === i;
        const showFaceDown =
          (showPlacedGap && isPlaced) || (showSelectedGap && isSelected);
        const isFlipHere = flipReveal?.position === i;
        const flipCorrect = isFlipHere && flipReveal?.correct;

        return (
          <div key={`slot-${i}`} className="timeline-slot">
            {isFlipHere && flipReveal ? (
              <FlipRevealAtCard card={flipReveal.card} correct={flipReveal.correct} />
            ) : (
              <GapDropZone
                index={i}
                canPlace={canPlace}
                isSelected={isSelected}
                isPlaced={isPlaced}
                showFaceDown={showFaceDown}
                showChallengeBelow={showHitsterUnderPlacement && isPlaced && showFaceDown}
                challengeSeconds={challengeSeconds}
                onChallenge={onChallenge}
                challengers={challengers}
                onSelect={onSelectPosition}
              />
            )}
            {cards[i] && !flipCorrect && <TimelineCard card={cards[i]} />}
          </div>
        );
      })}
    </div>
  );

  const track = isWatchTimeline ? watchTrack : interactiveTrack;

  const sectionClass = [
    'timeline-section',
    readOnly ? 'timeline-readonly' : '',
    readOnly && showPlacementToAll ? 'timeline-watch-mode' : '',
    showPlacedGap || showSelectedGap ? 'timeline-has-pending' : '',
    showHitsterUnderPlacement ? 'timeline-has-hitster-slot' : '',
    flipReveal ? 'timeline-section--flip-reveal' : '',
  ]
    .filter(Boolean)
    .join(' ');

  if (canPlace) {
    return (
      <div className={sectionClass} data-testid={testId}>
        <div className="timeline-label">{label}</div>
        <DndContext
          sensors={sensors}
          onDragStart={() => setActiveDrag(true)}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setActiveDrag(false)}
        >
          <div className="timeline-active-layout">
            {track}
            {showPendingDock && (
              <div className="timeline-pending-below">
                <DraggablePendingCard />
              </div>
            )}
          </div>
          <DragOverlay>
            {activeDrag ? <FaceDownCard /> : null}
          </DragOverlay>
        </DndContext>
      </div>
    );
  }

  return (
    <div className={sectionClass} data-testid={testId}>
      <div className="timeline-label">{label}</div>
      {track}
    </div>
  );
}
