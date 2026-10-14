import {
  generateRoomCode,
  createRoom,
  addPlayer,
  markDisconnected,
  markReconnected,
  allParticipantsOffline,
  isPlacementCorrect,
  resolveFlip,
  advanceTurn,
  applyNamingBonus,
  applyBuy,
  incrementMissedTurns,
  removeFromTurnOrder,
  initRound,
  drawCard,
  applySkip,
  timelineLength,
  buildRoundSummary,
  activeEntityId,
  createTeam,
  joinTeam,
  leaveTeam,
  isActiveParticipant,
  endGame,
  findPlayerByName,
  removePlayer,
} from './engine';
import type { Room, Card, RoundConfig } from '../../../shared/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCard(trackId: string, year: number): Card {
  return {
    trackId,
    title: `Song ${trackId}`,
    artist: 'Artist',
    releaseYear: year,
    previewUrl: `mock://${trackId}`,
    albumArt: '',
  };
}

const defaultConfig: RoundConfig = {
  mode: 'original',
  cardsToWin: 6,
  turnSeconds: 60,
  tokensEnabled: true,
};

function makeRoomWithTurn(
  cards: Card[],
  cardToPlace: Card,
  position: number,
  cardsToWin = 6
): Room {
  const room = createRoom('player1', 'Alice', 'Test Room');
  const roomWithPlayer = addPlayer(room, 'player2', 'Bob');
  const config: RoundConfig = { ...defaultConfig, cardsToWin };

  // Build a deck that is large enough
  const deck = [...cards, cardToPlace, ...Array.from({ length: 20 }, (_, i) =>
    makeCard(`filler-${i}`, 2000 + i)
  )];

  const { room: initedRoom, deck: remainingDeck } = initRound(roomWithPlayer, config, deck);

  // Manually set up: player1 has `cards` as their timeline, about to place cardToPlace at `position`
  return {
    ...initedRoom,
    activeRound: {
      ...initedRoom.activeRound!,
      timelines: {
        ...initedRoom.activeRound!.timelines,
        player1: { ownerId: 'player1', cards },
      },
      currentTurn: {
        activeId: 'player1',
        phase: 'challenge',
        placedPosition: position,
        challengeDeadline: Date.now() + 10_000,
        challenges: [],
      },
      deckRemaining: remainingDeck.length,
    },
  };
}

// ---------------------------------------------------------------------------
// generateRoomCode
// ---------------------------------------------------------------------------

describe('generateRoomCode', () => {
  it('returns a 4-character string', () => {
    const code = generateRoomCode();
    expect(code).toHaveLength(4);
  });

  it('contains only uppercase alphanumeric characters', () => {
    for (let i = 0; i < 50; i++) {
      const code = generateRoomCode();
      expect(code).toMatch(/^[A-Z0-9]{4}$/);
    }
  });

  it('generates different codes over multiple calls (probabilistic)', () => {
    const codes = new Set(Array.from({ length: 20 }, () => generateRoomCode()));
    expect(codes.size).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// isPlacementCorrect
// ---------------------------------------------------------------------------

describe('isPlacementCorrect', () => {
  it('is always correct on an empty timeline', () => {
    const card = makeCard('c1', 1990);
    expect(isPlacementCorrect([], card, 0)).toBe(true);
  });

  it('correctly places before a later card', () => {
    const timeline = [makeCard('c1', 2000)];
    const card = makeCard('c2', 1990);
    expect(isPlacementCorrect(timeline, card, 0)).toBe(true);
  });

  it('incorrectly places before a later card when card is newer', () => {
    const timeline = [makeCard('c1', 2000)];
    const card = makeCard('c2', 2010);
    expect(isPlacementCorrect(timeline, card, 0)).toBe(false);
  });

  it('correctly places after an earlier card', () => {
    const timeline = [makeCard('c1', 1990)];
    const card = makeCard('c2', 2000);
    expect(isPlacementCorrect(timeline, card, 1)).toBe(true);
  });

  it('incorrectly places after an earlier card when card is older', () => {
    const timeline = [makeCard('c1', 1990)];
    const card = makeCard('c2', 1980);
    expect(isPlacementCorrect(timeline, card, 1)).toBe(false);
  });

  it('correctly places between two cards', () => {
    const timeline = [makeCard('c1', 1990), makeCard('c2', 2010)];
    const card = makeCard('c3', 2000);
    expect(isPlacementCorrect(timeline, card, 1)).toBe(true);
  });

  it('incorrectly places between two cards when year is outside range', () => {
    const timeline = [makeCard('c1', 1990), makeCard('c2', 2010)];
    const card = makeCard('c3', 1980);
    expect(isPlacementCorrect(timeline, card, 1)).toBe(false);
  });

  it('same year adjacent — placing before is correct', () => {
    const timeline = [makeCard('c1', 1995)];
    const card = makeCard('c2', 1995);
    // Place before (position 0): card.year (1995) <= timeline[0].year (1995) → correct
    expect(isPlacementCorrect(timeline, card, 0)).toBe(true);
  });

  it('same year adjacent — placing after is correct', () => {
    const timeline = [makeCard('c1', 1995)];
    const card = makeCard('c2', 1995);
    // Place after (position 1): card.year (1995) >= timeline[0].year (1995) → correct
    expect(isPlacementCorrect(timeline, card, 1)).toBe(true);
  });

  it('boundary: place at beginning of multi-card timeline', () => {
    const timeline = [makeCard('c1', 1990), makeCard('c2', 2000), makeCard('c3', 2010)];
    const card = makeCard('c4', 1985);
    expect(isPlacementCorrect(timeline, card, 0)).toBe(true);
  });

  it('boundary: place at end of multi-card timeline', () => {
    const timeline = [makeCard('c1', 1990), makeCard('c2', 2000), makeCard('c3', 2010)];
    const card = makeCard('c4', 2020);
    expect(isPlacementCorrect(timeline, card, 3)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveFlip — correct placement adds to timeline
// ---------------------------------------------------------------------------

describe('resolveFlip', () => {
  it('correct placement adds card to timeline', () => {
    const existingCards = [makeCard('c1', 1990), makeCard('c2', 2010)];
    const newCard = makeCard('new', 2000);
    // Position 1 is between 1990 and 2010 — correct
    const room = makeRoomWithTurn(existingCards, newCard, 1);

    const { room: updatedRoom, correct } = resolveFlip(room, newCard);
    expect(correct).toBe(true);
    const timeline = updatedRoom.activeRound!.timelines['player1'];
    expect(timeline.cards).toHaveLength(3);
    expect(timeline.cards[1].trackId).toBe('new');
  });

  it('incorrect placement discards the card', () => {
    const existingCards = [makeCard('c1', 1990), makeCard('c2', 2010)];
    const newCard = makeCard('new', 2020);
    // Position 1 would be between 1990 and 2010, but card is 2020 — incorrect
    const room = makeRoomWithTurn(existingCards, newCard, 1);

    const { room: updatedRoom, correct } = resolveFlip(room, newCard);
    expect(correct).toBe(false);
    const timeline = updatedRoom.activeRound!.timelines['player1'];
    // Card should NOT be on the timeline
    expect(timeline.cards).toHaveLength(2);
    expect(timeline.cards.find((c) => c.trackId === 'new')).toBeUndefined();
  });

  it('win detection: correct placement on 5-card timeline triggers win', () => {
    const existingCards = Array.from({ length: 5 }, (_, i) =>
      makeCard(`c${i}`, 1990 + i)
    );
    // Place card at the end (year 1994 + 1 = 2000 > 1994)
    const newCard = makeCard('winner', 2000);
    const room = makeRoomWithTurn(existingCards, newCard, 5, 6);

    const { winnerId, correct } = resolveFlip(room, newCard);
    expect(correct).toBe(true);
    expect(winnerId).toBe('player1');
  });

  it('win detection: incorrect placement on 5-card timeline does NOT trigger win', () => {
    const existingCards = Array.from({ length: 5 }, (_, i) =>
      makeCard(`c${i}`, 1990 + i)
    );
    // Place card at position 0, but card year is newer than timeline[0] — incorrect
    const newCard = makeCard('notWinner', 2020);
    const room = makeRoomWithTurn(existingCards, newCard, 0, 6);

    const { winnerId, correct } = resolveFlip(room, newCard);
    expect(correct).toBe(false);
    expect(winnerId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// advanceTurn
// ---------------------------------------------------------------------------

describe('advanceTurn', () => {
  it('increments turnIndex', () => {
    const room = createRoom('player1', 'Alice', 'Test');
    const room2 = addPlayer(room, 'player2', 'Bob');
    const deck = Array.from({ length: 10 }, (_, i) => makeCard(`d${i}`, 1990 + i));
    const { room: initedRoom } = initRound(room2, defaultConfig, deck);

    expect(initedRoom.activeRound!.turnIndex).toBe(0);
    const advanced = advanceTurn(initedRoom);
    expect(advanced.activeRound!.turnIndex).toBe(1);
  });

  it('wraps around from last player to first', () => {
    const room = createRoom('player1', 'Alice', 'Test');
    const room2 = addPlayer(room, 'player2', 'Bob');
    const deck = Array.from({ length: 10 }, (_, i) => makeCard(`d${i}`, 1990 + i));
    const { room: initedRoom } = initRound(room2, defaultConfig, deck);

    // Move to last player (index 1 with 2 players)
    const atLast = { ...initedRoom, activeRound: { ...initedRoom.activeRound!, turnIndex: 1 } };
    const wrapped = advanceTurn(atLast);
    expect(wrapped.activeRound!.turnIndex).toBe(0);
  });

  it('clears currentTurn after advancing', () => {
    const room = createRoom('player1', 'Alice', 'Test');
    const deck = Array.from({ length: 5 }, (_, i) => makeCard(`d${i}`, 1990 + i));
    const { room: initedRoom } = initRound(room, defaultConfig, deck);

    const withTurn: Room = {
      ...initedRoom,
      activeRound: {
        ...initedRoom.activeRound!,
        currentTurn: {
          activeId: 'player1',
          phase: 'flip',
          challenges: [],
        },
      },
    };

    const advanced = advanceTurn(withTurn);
    expect(advanced.activeRound!.currentTurn).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Token cap at 5
// ---------------------------------------------------------------------------

describe('applyNamingBonus', () => {
  function makeRoomWithTokens(playerId: string, tokens: number): Room {
    const room = createRoom(playerId, 'Alice', 'Test');
    const deck = Array.from({ length: 5 }, (_, i) => makeCard(`d${i}`, 1990 + i));
    const { room: initedRoom } = initRound(room, defaultConfig, deck);
    return {
      ...initedRoom,
      activeRound: {
        ...initedRoom.activeRound!,
        tokens: { [playerId]: tokens },
      },
    };
  }

  it('awards +1 token normally', () => {
    const room = makeRoomWithTokens('player1', 2);
    const updated = applyNamingBonus(room, 'player1');
    expect(updated.activeRound!.tokens['player1']).toBe(3);
  });

  it('caps tokens at 5', () => {
    const room = makeRoomWithTokens('player1', 5);
    const updated = applyNamingBonus(room, 'player1');
    expect(updated.activeRound!.tokens['player1']).toBe(5);
  });

  it('does not exceed 5 when at 4', () => {
    const room = makeRoomWithTokens('player1', 4);
    const updated = applyNamingBonus(room, 'player1');
    expect(updated.activeRound!.tokens['player1']).toBe(5);
  });

  it('applySkip deducts 1 token', () => {
    const room = makeRoomWithTokens('player1', 3);
    const updated = applySkip(room, 'player1');
    expect(updated.activeRound!.tokens['player1']).toBe(2);
  });

  it('applySkip throws when tokens < 1', () => {
    const room = makeRoomWithTokens('player1', 0);
    expect(() => applySkip(room, 'player1')).toThrow('Not enough tokens');
  });
});

// ---------------------------------------------------------------------------
// applyBuy
// ---------------------------------------------------------------------------

describe('applyBuy', () => {
  function roomWithTokens(tokens: number): Room {
    const room = createRoom('player1', 'Alice', 'Test Room');
    const roomWith2 = addPlayer(room, 'player2', 'Bob');
    const deck = Array.from({ length: 15 }, (_, i) => makeCard(`c${i}`, 2000 + i));
    const { room: initedRoom } = initRound(roomWith2, defaultConfig, deck);
    return {
      ...initedRoom,
      activeRound: {
        ...initedRoom.activeRound!,
        tokens: { ...initedRoom.activeRound!.tokens, player1: tokens },
        turnOrder: ['player1', 'player2'],
        turnIndex: 0,
        currentTurn: {
          activeId: 'player1',
          phase: 'place',
          challenges: [],
        },
      },
    };
  }

  it('deducts 3 tokens', () => {
    const room = roomWithTokens(3);
    const result = applyBuy(room, 'player1');
    expect(result.activeRound!.tokens['player1']).toBe(0);
  });

  it('deducts 3 from a higher balance', () => {
    const room = roomWithTokens(5);
    const result = applyBuy(room, 'player1');
    expect(result.activeRound!.tokens['player1']).toBe(2);
  });

  it('throws when player has fewer than 3 tokens', () => {
    const room = roomWithTokens(2);
    expect(() => applyBuy(room, 'player1')).toThrow('Not enough tokens');
  });

  it('throws when it is not the player\'s turn', () => {
    const room = roomWithTokens(3);
    expect(() => applyBuy(room, 'player2')).toThrow('Not your turn');
  });

  it('throws when not in place phase', () => {
    const room = roomWithTokens(3);
    const challenged: Room = {
      ...room,
      activeRound: {
        ...room.activeRound!,
        currentTurn: { ...room.activeRound!.currentTurn!, phase: 'challenge' },
      },
    };
    expect(() => applyBuy(challenged, 'player1')).toThrow('place phase');
  });

  it('adds player to pendingSkips', () => {
    const room = roomWithTokens(3);
    const result = applyBuy(room, 'player1');
    expect(result.activeRound!.pendingSkips).toContain('player1');
  });

  it('does not add player to pendingSkips twice', () => {
    const room = roomWithTokens(5);
    const once = applyBuy(room, 'player1');
    // Simulate calling again (shouldn't happen in practice but guard it)
    const alreadyIn: Room = {
      ...once,
      activeRound: {
        ...once.activeRound!,
        tokens: { ...once.activeRound!.tokens, player1: 3 },
      },
    };
    const twice = applyBuy(alreadyIn, 'player1');
    const skips = twice.activeRound!.pendingSkips ?? [];
    expect(skips.filter(id => id === 'player1')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// incrementMissedTurns
// ---------------------------------------------------------------------------

describe('incrementMissedTurns', () => {
  it('increments from 0 to 1', () => {
    const room = createRoom('player1', 'Alice', 'Test Room');
    const result = incrementMissedTurns(room, 'player1');
    expect(result.players['player1'].missedTurns).toBe(1);
  });

  it('increments from 1 to 2', () => {
    const room = createRoom('player1', 'Alice', 'Test Room');
    const once = incrementMissedTurns(room, 'player1');
    const twice = incrementMissedTurns(once, 'player1');
    expect(twice.players['player1'].missedTurns).toBe(2);
  });

  it('returns room unchanged when player does not exist', () => {
    const room = createRoom('player1', 'Alice', 'Test Room');
    const result = incrementMissedTurns(room, 'unknown');
    expect(result).toBe(room);
  });
});

// ---------------------------------------------------------------------------
// removeFromTurnOrder
// ---------------------------------------------------------------------------

describe('removeFromTurnOrder', () => {
  function roomWithOrder(order: string[], index: number): Room {
    const base = createRoom('player1', 'Alice', 'Test Room');
    const withPlayers = order
      .slice(1)
      .reduce((r, id) => addPlayer(r, id, id), base);
    const deck = Array.from({ length: 20 }, (_, i) => makeCard(`c${i}`, 2000 + i));
    const { room: initedRoom } = initRound(withPlayers, defaultConfig, deck);
    return {
      ...initedRoom,
      activeRound: {
        ...initedRoom.activeRound!,
        turnOrder: order,
        turnIndex: index,
      },
    };
  }

  it('removes a player from the turn order', () => {
    const room = roomWithOrder(['A', 'B', 'C'], 0);
    const result = removeFromTurnOrder(room, 'B');
    expect(result.activeRound!.turnOrder).toEqual(['A', 'C']);
  });

  it('keeps turnIndex when removing a player after current', () => {
    // Current is A (index 0), removing C (index 2) → index stays 0
    const room = roomWithOrder(['A', 'B', 'C'], 0);
    const result = removeFromTurnOrder(room, 'C');
    expect(result.activeRound!.turnIndex).toBe(0);
  });

  it('decrements turnIndex when removing a player before current', () => {
    // Current is C (index 2), removing A (index 0) → index shifts to 1
    const room = roomWithOrder(['A', 'B', 'C'], 2);
    const result = removeFromTurnOrder(room, 'A');
    expect(result.activeRound!.turnIndex).toBe(1);
    expect(result.activeRound!.turnOrder[1]).toBe('C');
  });

  it('keeps turnIndex pointing to next player when removing current', () => {
    // Current is B (index 1), removing B → new order ['A','C'], index stays 1 (C is next)
    const room = roomWithOrder(['A', 'B', 'C'], 1);
    const result = removeFromTurnOrder(room, 'B');
    expect(result.activeRound!.turnOrder).toEqual(['A', 'C']);
    expect(result.activeRound!.turnIndex).toBe(1);
    expect(result.activeRound!.turnOrder[1]).toBe('C');
  });

  it('wraps turnIndex when the last player in the array is the current', () => {
    // Current is C (index 2), removing C → new order ['A','B'], index wraps to 0
    const room = roomWithOrder(['A', 'B', 'C'], 2);
    const result = removeFromTurnOrder(room, 'C');
    expect(result.activeRound!.turnOrder).toEqual(['A', 'B']);
    expect(result.activeRound!.turnIndex).toBe(0);
  });

  it('returns room unchanged when player is not in the turn order', () => {
    const room = roomWithOrder(['A', 'B', 'C'], 0);
    const result = removeFromTurnOrder(room, 'X');
    expect(result).toBe(room);
  });

  it('clears currentTurn when the current active player is removed', () => {
    const room = roomWithOrder(['A', 'B', 'C'], 1);
    const withTurn: Room = {
      ...room,
      activeRound: {
        ...room.activeRound!,
        currentTurn: { activeId: 'B', phase: 'place', challenges: [] },
      },
    };
    const result = removeFromTurnOrder(withTurn, 'B');
    expect(result.activeRound!.currentTurn).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// drawCard
// ---------------------------------------------------------------------------

describe('drawCard', () => {
  it('draws the first card and returns the rest', () => {
    const deck = [makeCard('a', 2000), makeCard('b', 2001), makeCard('c', 2002)];
    const { card, hidden, remaining } = drawCard(deck);
    expect(card.trackId).toBe('a');
    expect(hidden.trackId).toBe('a');
    expect((hidden as { releaseYear?: number }).releaseYear).toBeUndefined();
    expect(remaining).toHaveLength(2);
  });

  it('throws when deck is empty', () => {
    expect(() => drawCard([])).toThrow('Deck is empty');
  });
});

// ---------------------------------------------------------------------------
// timelineLength
// ---------------------------------------------------------------------------

describe('timelineLength', () => {
  it('returns 0 when no active round', () => {
    const room = createRoom('player1', 'Alice', 'Test');
    expect(timelineLength(room, 'player1')).toBe(0);
  });

  it('returns correct count during active round', () => {
    const room = createRoom('player1', 'Alice', 'Test');
    const deck = Array.from({ length: 5 }, (_, i) => makeCard(`d${i}`, 1990 + i));
    const { room: initedRoom } = initRound(room, defaultConfig, deck);
    // After initRound, player1 has 1 starting card
    expect(timelineLength(initedRoom, 'player1')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// markDisconnected / markReconnected
// ---------------------------------------------------------------------------

describe('markDisconnected / markReconnected', () => {
  it('marks a player as disconnected', () => {
    const room = createRoom('p1', 'Alice', 'Test');
    const updated = markDisconnected(room, 'p1');
    expect(updated.players['p1'].isConnected).toBe(false);
  });

  it('marks a disconnected player as reconnected', () => {
    const room = createRoom('p1', 'Alice', 'Test');
    const disc = markDisconnected(room, 'p1');
    const recon = markReconnected(disc, 'p1');
    expect(recon.players['p1'].isConnected).toBe(true);
  });

  it('is a no-op for unknown player id', () => {
    const room = createRoom('p1', 'Alice', 'Test');
    const updated = markDisconnected(room, 'nobody');
    expect(updated).toEqual(room);
  });

  it('all players disconnected when last player leaves lobby', () => {
    const room = createRoom('p1', 'Alice', 'Test');
    const room2 = addPlayer(room, 'p2', 'Bob');
    const d1 = markDisconnected(room2, 'p1');
    const d2 = markDisconnected(d1, 'p2');
    expect(allParticipantsOffline(d2)).toBe(true);
  });

  it('allParticipantsOffline is false when any player is connected', () => {
    const room = createRoom('p1', 'Alice', 'Test');
    const room2 = addPlayer(room, 'p2', 'Bob');
    const d1 = markDisconnected(room2, 'p1');
    expect(allParticipantsOffline(d1)).toBe(false);
  });

  it('resets missedTurns to 0', () => {
    const room = createRoom('player1', 'Alice', 'Test Room');
    const disconnected = markDisconnected(room, 'player1');
    const withMissed = incrementMissedTurns(disconnected, 'player1');
    const reconnected = markReconnected(withMissed, 'player1');
    expect(reconnected.players['player1'].missedTurns).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildRoundSummary
// ---------------------------------------------------------------------------

describe('buildRoundSummary', () => {
  it('returns correct mode and roundNumber', () => {
    const room = createRoom('p1', 'Alice', 'Test');
    const deck = Array.from({ length: 5 }, (_, i) => makeCard(`d${i}`, 1990 + i));
    const { room: initedRoom } = initRound(room, defaultConfig, deck);
    const summary = buildRoundSummary(initedRoom, 'p1');
    expect(summary.winnerId).toBe('p1');
    expect(summary.mode).toBe('original');
    expect(summary.roundNumber).toBe(1);
  });

  it('roundNumber increments with round history', () => {
    const room = createRoom('p1', 'Alice', 'Test');
    const deck = Array.from({ length: 5 }, (_, i) => makeCard(`d${i}`, 1990 + i));
    const { room: initedRoom } = initRound(room, defaultConfig, deck);
    const prevSummary = buildRoundSummary(initedRoom, 'p1');
    const roomWithHistory = { ...initedRoom, roundHistory: [prevSummary] };
    const summary2 = buildRoundSummary(roomWithHistory, 'p1');
    expect(summary2.roundNumber).toBe(2);
  });

  it('supports null winnerId (cooperative loss / tie)', () => {
    const room = createRoom('p1', 'Alice', 'Test');
    const deck = Array.from({ length: 5 }, (_, i) => makeCard(`d${i}`, 1990 + i));
    const { room: initedRoom } = initRound(room, defaultConfig, deck);
    const summary = buildRoundSummary(initedRoom, null);
    expect(summary.winnerId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// addPlayer
// ---------------------------------------------------------------------------

describe('addPlayer', () => {
  it('adds a new player to a lobby room', () => {
    const room = createRoom('p1', 'Alice', 'Test');
    const updated = addPlayer(room, 'p2', 'Bob');
    expect(Object.keys(updated.players)).toHaveLength(2);
    expect(updated.players['p2'].displayName).toBe('Bob');
    expect(updated.players['p2'].isConnected).toBe(true);
  });

  it('reconnects an existing player instead of duplicating', () => {
    const room = createRoom('p1', 'Alice', 'Test');
    const disc = markDisconnected(room, 'p1');
    const recon = addPlayer(disc, 'p1', 'Alice');
    expect(Object.keys(recon.players)).toHaveLength(1);
    expect(recon.players['p1'].isConnected).toBe(true);
  });

  it('throws when room is game_over', () => {
    const room = { ...createRoom('p1', 'Alice', 'Test'), status: 'game_over' as const };
    expect(() => addPlayer(room, 'p2', 'Bob')).toThrow('Cannot join a room that has ended');
  });

  it('addPlayer throws when room has 12 players', () => {
    // createRoom creates owner (p1) = 1 player; add p2–p12 = 11 more → 12 total
    let room = createRoom('p1', 'Alice', 'Test');
    for (let i = 2; i <= 12; i++) {
      room = addPlayer(room, `p${i}`, `Player${i}`);
    }
    expect(Object.keys(room.players)).toHaveLength(12);
    expect(() => addPlayer(room, 'p13', 'Player13')).toThrow('Room is full (max 12 players)');
  });
});

// ---------------------------------------------------------------------------
// initRound — deck size validation (server emits error when too few tracks)
// ---------------------------------------------------------------------------

// Note: minimum deck size is enforced in the socket handler (index.ts), not in the engine.
// These tests cover engine behaviour for round initialisation.
describe('initRound deck size and card distribution', () => {
  it('distributes 1 starting card to each player', () => {
    let room = createRoom('p1', 'Alice', 'Test');
    room = addPlayer(room, 'p2', 'Bob');
    const deck = Array.from({ length: 15 }, (_, i) => makeCard(`t${i}`, 1980 + i));
    const { room: started } = initRound(room, defaultConfig, deck);
    expect(started.activeRound?.timelines['p1'].cards).toHaveLength(1);
    expect(started.activeRound?.timelines['p2'].cards).toHaveLength(1);
    expect(started.activeRound?.gameLog).toEqual([]);
  });

  it('remaining deck excludes starting cards', () => {
    let room = createRoom('p1', 'Alice', 'Test');
    room = addPlayer(room, 'p2', 'Bob');
    const deck = Array.from({ length: 15 }, (_, i) => makeCard(`t${i}`, 1980 + i));
    const { deck: remaining } = initRound(room, defaultConfig, deck);
    // 2 players × 1 starting card = 2 consumed
    expect(remaining).toHaveLength(13);
  });

  it('sets room status to round_active', () => {
    let room = createRoom('p1', 'Alice', 'Test');
    room = addPlayer(room, 'p2', 'Bob');
    const deck = Array.from({ length: 15 }, (_, i) => makeCard(`t${i}`, 1980 + i));
    const { room: started } = initRound(room, defaultConfig, deck);
    expect(started.status).toBe('round_active');
    expect(started.activeRound?.gameLog).toEqual([]);
  });

  it('stores playlistLabel as genre in config', () => {
    let room = createRoom('p1', 'Alice', 'Test');
    room = addPlayer(room, 'p2', 'Bob');
    const deck = Array.from({ length: 15 }, (_, i) => makeCard(`t${i}`, 1980 + i));
    const config: RoundConfig = { ...defaultConfig, playlistLabel: "90's rock" };
    const { room: started } = initRound(room, config, deck);
    expect(started.activeRound?.config.playlistLabel).toBe("90's rock");
  });
});

// ---------------------------------------------------------------------------
// Mode-specific starting tokens
// ---------------------------------------------------------------------------

describe('initRound — starting tokens by mode', () => {
  function startTokensForMode(mode: RoundConfig['mode']): number {
    let room = createRoom('p1', 'Alice', 'Test');
    room = addPlayer(room, 'p2', 'Bob');
    const deck = Array.from({ length: 15 }, (_, i) => makeCard(`t${i}`, 1980 + i));
    const config: RoundConfig = { mode, cardsToWin: 6, turnSeconds: 60, tokensEnabled: true };
    const { room: started } = initRound(room, config, deck);
    if (mode === 'cooperative') return started.activeRound!.tokens['cooperative'];
    return started.activeRound!.tokens['p1'];
  }

  it('original mode starts with 2 tokens', () => {
    expect(startTokensForMode('original')).toBe(2);
  });

  it('pro mode starts with 5 tokens', () => {
    expect(startTokensForMode('pro')).toBe(5);
  });

  it('expert mode starts with 3 tokens', () => {
    expect(startTokensForMode('expert')).toBe(3);
  });

  it('cooperative mode starts with 5 shared tokens', () => {
    expect(startTokensForMode('cooperative')).toBe(5);
  });

  it('cooperative mode creates shared timeline', () => {
    let room = createRoom('p1', 'Alice', 'Test');
    room = addPlayer(room, 'p2', 'Bob');
    const deck = Array.from({ length: 15 }, (_, i) => makeCard(`t${i}`, 1980 + i));
    const config: RoundConfig = { mode: 'cooperative', cardsToWin: 6, turnSeconds: 60, tokensEnabled: true };
    const { room: started } = initRound(room, config, deck);
    expect(started.activeRound!.timelines['cooperative']).toBeDefined();
    expect(started.activeRound!.timelines['p1']).toBeUndefined();
    // Shared timeline should have one starting card per player (2 players)
    expect(started.activeRound!.timelines['cooperative'].cards).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// activeEntityId
// ---------------------------------------------------------------------------

describe('activeEntityId', () => {
  it('returns playerId in non-cooperative modes', () => {
    let room = createRoom('p1', 'Alice', 'Test');
    room = addPlayer(room, 'p2', 'Bob');
    const deck = Array.from({ length: 15 }, (_, i) => makeCard(`t${i}`, 1980 + i));
    const { room: started } = initRound(room, defaultConfig, deck);
    expect(activeEntityId(started, 'p1')).toBe('p1');
  });

  it('returns "cooperative" in cooperative mode', () => {
    let room = createRoom('p1', 'Alice', 'Test');
    room = addPlayer(room, 'p2', 'Bob');
    const deck = Array.from({ length: 15 }, (_, i) => makeCard(`t${i}`, 1980 + i));
    const config: RoundConfig = { mode: 'cooperative', cardsToWin: 6, turnSeconds: 60, tokensEnabled: true };
    const { room: started } = initRound(room, config, deck);
    expect(activeEntityId(started, 'p1')).toBe('cooperative');
  });
});

// ---------------------------------------------------------------------------
// applyNamingBonus — mode restrictions
// ---------------------------------------------------------------------------

describe('applyNamingBonus — mode restrictions', () => {
  function roomWithMode(mode: RoundConfig['mode']): Room {
    let room = createRoom('p1', 'Alice', 'Test');
    room = addPlayer(room, 'p2', 'Bob');
    const deck = Array.from({ length: 15 }, (_, i) => makeCard(`t${i}`, 1980 + i));
    const config: RoundConfig = { mode, cardsToWin: 6, turnSeconds: 60, tokensEnabled: true };
    const { room: started } = initRound(room, config, deck);
    return started;
  }

  it('original: awards +1 token', () => {
    const room = roomWithMode('original');
    const before = room.activeRound!.tokens['p1'];
    const after = applyNamingBonus(room, 'p1');
    expect(after.activeRound!.tokens['p1']).toBe(before + 1);
  });

  it('pro: naming bonus is a no-op', () => {
    const room = roomWithMode('pro');
    const tokensBefore = { ...room.activeRound!.tokens };
    const after = applyNamingBonus(room, 'p1');
    expect(after.activeRound!.tokens).toEqual(tokensBefore);
  });

  it('expert: naming bonus is a no-op', () => {
    const room = roomWithMode('expert');
    const tokensBefore = { ...room.activeRound!.tokens };
    const after = applyNamingBonus(room, 'p1');
    expect(after.activeRound!.tokens).toEqual(tokensBefore);
  });

  it('tokensEnabled=false: naming bonus is a no-op', () => {
    let room = createRoom('p1', 'Alice', 'Test');
    room = addPlayer(room, 'p2', 'Bob');
    const deck = Array.from({ length: 15 }, (_, i) => makeCard(`t${i}`, 1980 + i));
    const config: RoundConfig = { mode: 'original', cardsToWin: 6, turnSeconds: 60, tokensEnabled: false };
    const { room: started } = initRound(room, config, deck);
    const tokensBefore = { ...started.activeRound!.tokens };
    const after = applyNamingBonus(started, 'p1');
    expect(after.activeRound!.tokens).toEqual(tokensBefore);
  });
});

// ---------------------------------------------------------------------------
// Cooperative resolveFlip
// ---------------------------------------------------------------------------

describe('resolveFlip — cooperative mode', () => {
  function makeCoopRoom(sharedCards: Card[], cardToPlace: Card, position: number): Room {
    let room = createRoom('p1', 'Alice', 'Test');
    room = addPlayer(room, 'p2', 'Bob');
    const deck = Array.from({ length: 20 }, (_, i) => makeCard(`f${i}`, 2000 + i));
    const config: RoundConfig = { mode: 'cooperative', cardsToWin: 5, turnSeconds: 60, tokensEnabled: true };
    const { room: initedRoom } = initRound(room, config, deck);
    return {
      ...initedRoom,
      activeRound: {
        ...initedRoom.activeRound!,
        timelines: { cooperative: { ownerId: 'cooperative', cards: sharedCards } },
        tokens: { cooperative: 3 },
        currentTurn: {
          activeId: 'p1',
          phase: 'challenge',
          placedPosition: position,
          challengeDeadline: Date.now() + 10_000,
          challenges: [],
        },
        deckRemaining: 10,
      },
    };
  }

  it('correct placement adds card to shared timeline', () => {
    const existing = [makeCard('a', 1980), makeCard('b', 2000)];
    const card = makeCard('c', 1990);
    const room = makeCoopRoom(existing, card, 1); // between 1980 and 2000
    const { correct, room: result } = resolveFlip(room, card);
    expect(correct).toBe(true);
    expect(result.activeRound!.timelines['cooperative'].cards).toHaveLength(3);
  });

  it('wrong placement deducts 1 shared token', () => {
    const existing = [makeCard('a', 1980), makeCard('b', 2000)];
    const card = makeCard('c', 1990);
    const room = makeCoopRoom(existing, card, 0); // wrong — before 1980 but year is 1990
    const { correct, room: result } = resolveFlip(room, card);
    expect(correct).toBe(false);
    expect(result.activeRound!.tokens['cooperative']).toBe(2); // was 3
  });

  it('cooperative win when shared timeline reaches cardsToWin', () => {
    const existing = [makeCard('a', 1970), makeCard('b', 1980), makeCard('c', 1990), makeCard('d', 2000)];
    const card = makeCard('e', 2010);
    const room = makeCoopRoom(existing, card, 4); // append at end
    const { winnerId } = resolveFlip(room, card);
    expect(winnerId).toBe('cooperative');
  });

  it('cooperative loss when tokens drop to 0', () => {
    const existing = [makeCard('a', 1980), makeCard('b', 2000)];
    const card = makeCard('c', 1990);
    // Set tokens to 1 so wrong placement drives to 0
    let room = makeCoopRoom(existing, card, 0); // wrong placement
    room = { ...room, activeRound: { ...room.activeRound!, tokens: { cooperative: 1 } } };
    const { room: result, winnerId } = resolveFlip(room, card);
    expect(result.activeRound!.tokens['cooperative']).toBe(0);
    expect(result.status).toBe('round_ended');
    expect(winnerId).toBeUndefined(); // null winner = loss
  });
});

// ---------------------------------------------------------------------------
// applySkip / applyBuy — tokensEnabled guard
// ---------------------------------------------------------------------------

describe('applySkip — tokensEnabled guard', () => {
  it('throws when tokensEnabled is false', () => {
    let room = createRoom('p1', 'Alice', 'Test');
    room = addPlayer(room, 'p2', 'Bob');
    const deck = Array.from({ length: 15 }, (_, i) => makeCard(`t${i}`, 1980 + i));
    const config: RoundConfig = { mode: 'original', cardsToWin: 6, turnSeconds: 60, tokensEnabled: false };
    const { room: started } = initRound(room, config, deck);
    expect(() => applySkip(started, 'p1')).toThrow('Tokens are disabled');
  });
});

describe('applyBuy — tokensEnabled guard', () => {
  it('throws when tokensEnabled is false', () => {
    let room = createRoom('p1', 'Alice', 'Test');
    room = addPlayer(room, 'p2', 'Bob');
    const deck = Array.from({ length: 15 }, (_, i) => makeCard(`t${i}`, 1980 + i));
    const config: RoundConfig = { mode: 'original', cardsToWin: 6, turnSeconds: 60, tokensEnabled: false };
    const { room: started } = initRound(room, config, deck);
    // Give player 3 tokens and set up a place-phase turn
    const withTurn: Room = {
      ...started,
      activeRound: {
        ...started.activeRound!,
        tokens: { p1: 3, p2: 3 },
        currentTurn: { activeId: 'p1', phase: 'place', challenges: [] },
      },
    };
    expect(() => applyBuy(withTurn, 'p1')).toThrow('Tokens are disabled');
  });
});


// ---------------------------------------------------------------------------
// Team management
// ---------------------------------------------------------------------------

describe('createTeam', () => {
  it('creates a team and adds creator to it', () => {
    const room = createRoom('p1', 'Alice', 'Test');
    const result = createTeam(room, 'team1', 'Red Team', 'p1');
    expect(result.teams['team1']).toBeDefined();
    expect(result.teams['team1'].name).toBe('Red Team');
    expect(result.teams['team1'].playerIds).toContain('p1');
    expect(result.useTeams).toBe(true);
  });

  it('moves creator out of previous team', () => {
    let room = createRoom('p1', 'Alice', 'Test');
    room = createTeam(room, 'team1', 'Red Team', 'p1');
    room = createTeam(room, 'team2', 'Blue Team', 'p1');
    expect(room.teams['team1'].playerIds).not.toContain('p1');
    expect(room.teams['team2'].playerIds).toContain('p1');
  });

  it('throws if room is not in lobby', () => {
    let room = createRoom('p1', 'Alice', 'Test');
    room = addPlayer(room, 'p2', 'Bob');
    const deck = Array.from({ length: 15 }, (_, i) => makeCard(`t${i}`, 1980 + i));
    const { room: started } = initRound(room, defaultConfig, deck);
    expect(() => createTeam(started, 'team1', 'Red Team', 'p1')).toThrow();
  });

  it('createTeam throws when room has 6 teams', () => {
    let room = createRoom('p1', 'Alice', 'Test');
    for (let i = 1; i <= 6; i++) {
      room = createTeam(room, `team${i}`, `Team ${i}`, 'p1');
    }
    expect(Object.keys(room.teams)).toHaveLength(6);
    expect(() => createTeam(room, 'team7', 'Team 7', 'p1')).toThrow('Maximum of 6 teams allowed');
  });
});

describe('joinTeam', () => {
  it('adds player to team and removes from previous team', () => {
    let room = createRoom('p1', 'Alice', 'Test');
    room = addPlayer(room, 'p2', 'Bob');
    room = createTeam(room, 'team1', 'Red', 'p1');
    room = createTeam(room, 'team2', 'Blue', 'p2');
    room = joinTeam(room, 'team1', 'p2');
    expect(room.teams['team1'].playerIds).toContain('p2');
    expect(room.teams['team2'].playerIds).not.toContain('p2');
  });

  it('throws on unknown team', () => {
    const room = createRoom('p1', 'Alice', 'Test');
    expect(() => joinTeam(room, 'nonexistent', 'p1')).toThrow('Team not found');
  });
});

describe('leaveTeam', () => {
  it('removes player from team', () => {
    let room = createRoom('p1', 'Alice', 'Test');
    room = createTeam(room, 'team1', 'Red', 'p1');
    room = leaveTeam(room, 'p1');
    expect(Object.keys(room.teams)).toHaveLength(0);
    expect(room.useTeams).toBe(false);
  });
});

describe('isActiveParticipant', () => {
  it('returns true when it is the player\'s turn (solo)', () => {
    let room = createRoom('p1', 'Alice', 'Test');
    room = addPlayer(room, 'p2', 'Bob');
    const deck = Array.from({ length: 15 }, (_, i) => makeCard(`t${i}`, 1980 + i));
    const { room: started } = initRound(room, defaultConfig, deck);
    const withTurn = {
      ...started,
      activeRound: {
        ...started.activeRound!,
        currentTurn: { activeId: 'p1', phase: 'place' as const, challenges: [] },
      },
    };
    expect(isActiveParticipant(withTurn, 'p1')).toBe(true);
    expect(isActiveParticipant(withTurn, 'p2')).toBe(false);
  });

  it('returns true for any team member when team is active', () => {
    let room = createRoom('p1', 'Alice', 'Test');
    room = addPlayer(room, 'p2', 'Bob');
    room = addPlayer(room, 'p3', 'Carol');
    room = createTeam(room, 'teamA', 'Alpha', 'p1');
    room = joinTeam(room, 'teamA', 'p2');
    room = createTeam(room, 'teamB', 'Beta', 'p3');
    const deck = Array.from({ length: 20 }, (_, i) => makeCard(`t${i}`, 1970 + i));
    const config: RoundConfig = { mode: 'original', cardsToWin: 6, turnSeconds: 60, tokensEnabled: true };
    const { room: started } = initRound(room, config, deck);
    const withTurn = {
      ...started,
      activeRound: {
        ...started.activeRound!,
        currentTurn: { activeId: 'teamA', phase: 'place' as const, challenges: [] },
      },
    };
    expect(isActiveParticipant(withTurn, 'p1')).toBe(true);
    expect(isActiveParticipant(withTurn, 'p2')).toBe(true);
    expect(isActiveParticipant(withTurn, 'p3')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pro/Expert naming requirement
// ---------------------------------------------------------------------------

describe('resolveFlip — Pro/Expert naming requirement', () => {
  function makeRoomWithTurnAndMode(
    cards: Card[],
    cardToPlace: Card,
    position: number,
    mode: RoundConfig['mode'],
    named?: boolean,
  ): Room {
    const room = createRoom('player1', 'Alice', 'Test Room');
    const roomWithPlayer = addPlayer(room, 'player2', 'Bob');
    const config: RoundConfig = { mode, cardsToWin: 6, turnSeconds: 60, tokensEnabled: true };

    const deck = [
      ...cards,
      cardToPlace,
      ...Array.from({ length: 20 }, (_, i) => makeCard(`filler-${i}`, 2000 + i)),
    ];

    const { room: initedRoom, deck: remainingDeck } = initRound(roomWithPlayer, config, deck);

    return {
      ...initedRoom,
      activeRound: {
        ...initedRoom.activeRound!,
        timelines: {
          ...initedRoom.activeRound!.timelines,
          player1: { ownerId: 'player1', cards },
        },
        currentTurn: {
          activeId: 'player1',
          phase: 'challenge',
          placedPosition: position,
          challengeDeadline: Date.now() + 10_000,
          challenges: [],
          named,
        },
        deckRemaining: remainingDeck.length,
      },
    };
  }

  it('Pro mode: correctly placed card is discarded if not named', () => {
    const existingCards = [makeCard('c1', 1990), makeCard('c2', 2010)];
    const newCard = makeCard('new', 2000);
    const room = makeRoomWithTurnAndMode(existingCards, newCard, 1, 'pro', undefined);

    const { room: updatedRoom, correct } = resolveFlip(room, newCard);
    expect(correct).toBe(true); // raw placement is correct
    const timeline = updatedRoom.activeRound!.timelines['player1'];
    expect(timeline.cards).toHaveLength(2); // card was NOT kept
    expect(timeline.cards.find(c => c.trackId === 'new')).toBeUndefined();
  });

  it('Pro mode: correctly placed card stays if named', () => {
    const existingCards = [makeCard('c1', 1990), makeCard('c2', 2010)];
    const newCard = makeCard('new', 2000);
    const room = makeRoomWithTurnAndMode(existingCards, newCard, 1, 'pro', true);

    const { room: updatedRoom, correct } = resolveFlip(room, newCard);
    expect(correct).toBe(true);
    const timeline = updatedRoom.activeRound!.timelines['player1'];
    expect(timeline.cards).toHaveLength(3); // card was kept
    expect(timeline.cards[1].trackId).toBe('new');
  });

  it('Expert mode: named but wrong year discards card', () => {
    // named=false simulates correct title+artist but wrong year (or simply not named)
    const existingCards = [makeCard('c1', 1990), makeCard('c2', 2010)];
    const newCard = makeCard('new', 2000);
    const room = makeRoomWithTurnAndMode(existingCards, newCard, 1, 'expert', false);

    const { room: updatedRoom, correct } = resolveFlip(room, newCard);
    expect(correct).toBe(true); // raw placement correct
    const timeline = updatedRoom.activeRound!.timelines['player1'];
    expect(timeline.cards).toHaveLength(2); // card discarded
  });

  it('Expert mode: named with correct year keeps card', () => {
    const existingCards = [makeCard('c1', 1990), makeCard('c2', 2010)];
    const newCard = makeCard('new', 2000);
    const room = makeRoomWithTurnAndMode(existingCards, newCard, 1, 'expert', true);

    const { room: updatedRoom, correct } = resolveFlip(room, newCard);
    expect(correct).toBe(true);
    const timeline = updatedRoom.activeRound!.timelines['player1'];
    expect(timeline.cards).toHaveLength(3); // card kept
    expect(timeline.cards[1].trackId).toBe('new');
  });
});

// ---------------------------------------------------------------------------
// addPlayer — spectator mode
// ---------------------------------------------------------------------------

describe('addPlayer — spectator mode', () => {
  it('adds player as spectator when room is round_active', () => {
    const room = createRoom('owner', 'Owner', 'test');
    const activeRoom = { ...room, status: 'round_active' as const };
    const updated = addPlayer(activeRoom, 'p2', 'Player2');
    expect(updated.players['p2'].isSpectator).toBe(true);
  });

  it('throws when joining a game_over room', () => {
    const room = { ...createRoom('owner', 'Owner', 'test'), status: 'game_over' as const };
    expect(() => addPlayer(room, 'p2', 'Player2')).toThrow('Cannot join a room that has ended');
  });
});

// ---------------------------------------------------------------------------
// initRound — clears spectators
// ---------------------------------------------------------------------------

describe('initRound — clears spectators', () => {
  it('converts spectators to participants at round start', () => {
    const room = createRoom('owner', 'Owner', 'test');
    const withSpectator: Room = {
      ...room,
      players: {
        ...room.players,
        'spec1': { id: 'spec1', displayName: 'Spec', isConnected: true, missedTurns: 0, isSpectator: true },
      },
    };
    const deck = Array.from({ length: 10 }, (_, i) => makeCard(`d${i}`, 1990 + i));
    const { room: started } = initRound(withSpectator, defaultConfig, deck);
    expect(started.players['spec1'].isSpectator).toBe(false);
    expect(started.players['owner'].isSpectator).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// endGame
// ---------------------------------------------------------------------------

describe('endGame', () => {
  it('sets room status to game_over', () => {
    const room = createRoom('owner', 'Owner', 'test');
    const ended = endGame(room);
    expect(ended.status).toBe('game_over');
  });
});

describe('initRound with teams', () => {
  it('uses teamIds for turnOrder and creates team timelines', () => {
    let room = createRoom('p1', 'Alice', 'Test');
    room = addPlayer(room, 'p2', 'Bob');
    room = createTeam(room, 'teamA', 'Alpha', 'p1');
    room = createTeam(room, 'teamB', 'Beta', 'p2');
    const deck = Array.from({ length: 20 }, (_, i) => makeCard(`t${i}`, 1970 + i));
    const config: RoundConfig = { mode: 'original', cardsToWin: 6, turnSeconds: 60, tokensEnabled: true };
    const { room: started } = initRound(room, config, deck);
    expect(started.activeRound!.turnOrder).toEqual(expect.arrayContaining(['teamA', 'teamB']));
    expect(started.activeRound!.timelines['teamA']).toBeDefined();
    expect(started.activeRound!.timelines['teamB']).toBeDefined();
    expect(started.activeRound!.timelines['p1']).toBeUndefined();
  });

  it('throws if fewer than 2 teams have players', () => {
    let room = createRoom('p1', 'Alice', 'Test');
    room = createTeam(room, 'teamA', 'Alpha', 'p1');
    const deck = Array.from({ length: 15 }, (_, i) => makeCard(`t${i}`, 1980 + i));
    const config: RoundConfig = { mode: 'original', cardsToWin: 6, turnSeconds: 60, tokensEnabled: true };
    expect(() => initRound(room, config, deck)).toThrow('Need at least 2 teams');
  });
});

// ---------------------------------------------------------------------------
// Helper for spectator / endGame tests
// ---------------------------------------------------------------------------

function mockDeck(n: number): Card[] {
  return Array.from({ length: n }, (_, i) => makeCard(`mock-${i}`, 1980 + i));
}

// ---------------------------------------------------------------------------
// addPlayer — spectator mode
// ---------------------------------------------------------------------------

describe('addPlayer — spectator mode', () => {
  it('adds player as spectator when room is round_active', () => {
    const room = createRoom('owner', 'Owner', 'test');
    const activeRoom = { ...room, status: 'round_active' as const };
    const updated = addPlayer(activeRoom, 'p2', 'Player2');
    expect(updated.players['p2'].isSpectator).toBe(true);
  });

  it('throws when joining a game_over room', () => {
    const room = { ...createRoom('owner', 'Owner', 'test'), status: 'game_over' as const };
    expect(() => addPlayer(room, 'p2', 'Player2')).toThrow('Cannot join a room that has ended');
  });
});

// ---------------------------------------------------------------------------
// initRound — clears spectators
// ---------------------------------------------------------------------------

describe('initRound — clears spectators', () => {
  it('converts spectators to participants at round start', () => {
    // create room with a spectator player
    const room = createRoom('owner', 'Owner', 'test');
    const withSpectator: Room = {
      ...room,
      players: {
        ...room.players,
        'spec1': { id: 'spec1', displayName: 'Spec', isConnected: true, missedTurns: 0, isSpectator: true },
      },
    };
    const { room: started } = initRound(withSpectator, defaultConfig, mockDeck(10));
    expect(started.players['spec1'].isSpectator).toBe(false);
    expect(started.players['owner'].isSpectator).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// endGame
// ---------------------------------------------------------------------------

describe('endGame', () => {
  it('sets room status to game_over', () => {
    const room = createRoom('owner', 'Owner', 'test');
    const ended = endGame(room);
    expect(ended.status).toBe('game_over');
  });
});

// ---------------------------------------------------------------------------
// findPlayerByName / removePlayer
// ---------------------------------------------------------------------------

describe('findPlayerByName', () => {
  it('matches trimmed and case-insensitive', () => {
    const room = addPlayer(createRoom('owner', 'Owner', 'test'), 'p2', 'Anna');
    expect(findPlayerByName(room, '  anna ')?.id).toBe('p2');
    expect(findPlayerByName(room, 'Ann')).toBeUndefined();
  });
});

describe('removePlayer', () => {
  it('removes the player and their team membership in the lobby', () => {
    let room = addPlayer(createRoom('owner', 'Owner', 'test'), 'p2', 'Anna');
    room = createTeam(room, 't1', 'Red', 'p2');
    const updated = removePlayer(room, 'p2');
    expect(updated.players['p2']).toBeUndefined();
    expect(updated.teams['t1']).toBeUndefined();
    expect(updated.useTeams).toBe(false);
  });

  it('hands ownership to the next connected player', () => {
    let room = addPlayer(createRoom('owner', 'Owner', 'test'), 'p2', 'Anna');
    room = addPlayer(room, 'p3', 'Ben');
    room = markDisconnected(room, 'p2');
    expect(removePlayer(room, 'owner').ownerId).toBe('p3');
  });

  it('only marks the player offline mid-round', () => {
    const room = addPlayer(createRoom('owner', 'Owner', 'test'), 'p2', 'Anna');
    const { room: started } = initRound(room, defaultConfig, mockDeck(10));
    const updated = removePlayer({ ...started, status: 'round_active' }, 'p2');
    expect(updated.players['p2'].isConnected).toBe(false);
    expect(updated.activeRound?.timelines['p2']).toBeDefined();
  });
});
