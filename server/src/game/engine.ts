import type {
  Room,
  Player,
  Team,
  Card,
  Timeline,
  RoundConfig,
  RoundSummary,
  CardHidden,
} from '../../../shared/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Keep in sync with shared/constants.ts CHALLENGE_WINDOW_MS */
const DEFAULT_CHALLENGE_WINDOW_MS = 3_000;

function shuffleArray<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

const ROOM_CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** Generate a 4-char uppercase alphanumeric room code */
export function generateRoomCode(): string {
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  }
  return code;
}

/** Create a fresh room */
export function createRoom(ownerId: string, displayName: string, topic: string): Room {
  const owner: Player = {
    id: ownerId,
    displayName,
    isConnected: true,
    missedTurns: 0,
  };

  return {
    code: generateRoomCode(),
    ownerId,
    topic,
    status: 'lobby',
    players: { [ownerId]: owner },
    teams: {},
    useTeams: false,
    roundHistory: [],
  };
}

/** Add a player to an existing room; returns updated Room or throws Error */
export function addPlayer(room: Room, playerId: string, displayName: string): Room {
  if (room.players[playerId]) {
    // Re-joining (reconnect with same sessionId) — just mark connected
    return markReconnected(room, playerId);
  }
  if (room.status === 'game_over') {
    throw new Error('Cannot join a room that has ended');
  }
  if (Object.keys(room.players).length >= 12) {
    throw new Error('Room is full (max 12 players)');
  }
  const isSpectator = room.status === 'round_active';
  const player: Player = { id: playerId, displayName, isConnected: true, missedTurns: 0, isSpectator };
  return {
    ...room,
    players: { ...room.players, [playerId]: player },
  };
}

/** Names are compared trimmed and case-insensitive — "Anna" and " anna" are the same player. */
export function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/** Player in this room whose display name matches (see normalizeName) */
export function findPlayerByName(room: Room, displayName: string): Player | undefined {
  const wanted = normalizeName(displayName);
  return Object.values(room.players).find(p => normalizeName(p.displayName) === wanted);
}

/**
 * Player leaves for good. Between rounds they are removed (incl. teams; ownership passes to
 * the next connected player). Mid-round they stay on the board and are only marked offline,
 * so timelines and turn order remain consistent.
 */
export function removePlayer(room: Room, playerId: string): Room {
  if (!room.players[playerId]) return room;
  if (room.status === 'round_active') return markDisconnected(room, playerId);

  const { [playerId]: _removed, ...players } = room.players;
  const teams = Object.fromEntries(
    Object.entries(removePlayerFromTeams(room.teams, playerId)).filter(([, t]) => t.playerIds.length > 0)
  );
  let ownerId = room.ownerId;
  if (ownerId === playerId) {
    const next = Object.values(players).find(p => p.isConnected) ?? Object.values(players)[0];
    ownerId = next?.id ?? ownerId;
  }
  return { ...room, players, teams, useTeams: room.useTeams && Object.keys(teams).length > 0, ownerId };
}

/** Mark player disconnected; return updated room */
export function markDisconnected(room: Room, playerId: string): Room {
  if (!room.players[playerId]) return room;
  return {
    ...room,
    players: {
      ...room.players,
      [playerId]: { ...room.players[playerId], isConnected: false },
    },
  };
}

/** True when the room has players and every one is disconnected (socket gone). */
export function allParticipantsOffline(room: Room): boolean {
  const players = Object.values(room.players);
  return players.length > 0 && players.every((p) => !p.isConnected);
}

/** Mark player reconnected */
export function markReconnected(room: Room, playerId: string): Room {
  if (!room.players[playerId]) return room;
  return {
    ...room,
    players: {
      ...room.players,
      [playerId]: { ...room.players[playerId], isConnected: true, missedTurns: 0 },
    },
  };
}

// ---------------------------------------------------------------------------
// Team management (lobby only)
// ---------------------------------------------------------------------------

/** Create a new team and add the creator to it */
export function createTeam(room: Room, teamId: string, teamName: string, creatorId: string): Room {
  if (room.status !== 'lobby') throw new Error('Cannot create teams after round has started');
  if (Object.keys(room.teams).length >= 6) {
    throw new Error('Maximum of 6 teams allowed');
  }
  const newTeam: Team = { id: teamId, name: teamName.trim(), playerIds: [creatorId] };
  // Remove creator from any existing teams
  const cleanedTeams = removePlayerFromTeams(room.teams, creatorId);
  return {
    ...room,
    teams: { ...cleanedTeams, [teamId]: newTeam },
    useTeams: true,
  };
}

/** Join a team; auto-leaves current team */
export function joinTeam(room: Room, teamId: string, playerId: string): Room {
  if (room.status !== 'lobby') throw new Error('Cannot change teams after round has started');
  const team = room.teams[teamId];
  if (!team) throw new Error('Team not found');
  const cleanedTeams = removePlayerFromTeams(room.teams, playerId);
  return {
    ...room,
    teams: {
      ...cleanedTeams,
      [teamId]: { ...cleanedTeams[teamId] ?? team, playerIds: [...(cleanedTeams[teamId]?.playerIds ?? team.playerIds), playerId] },
    },
  };
}

/** Leave current team */
export function leaveTeam(room: Room, playerId: string): Room {
  if (room.status !== 'lobby') throw new Error('Cannot leave teams after round has started');
  const updatedTeams = removePlayerFromTeams(room.teams, playerId);
  // Remove empty teams and disable useTeams if no teams have players
  const nonEmptyTeams = Object.fromEntries(
    Object.entries(updatedTeams).filter(([, t]) => t.playerIds.length > 0)
  );
  return { ...room, teams: nonEmptyTeams, useTeams: Object.keys(nonEmptyTeams).length > 0 };
}

function removePlayerFromTeams(teams: Record<string, Team>, playerId: string): Record<string, Team> {
  return Object.fromEntries(
    Object.entries(teams).map(([tid, team]) => [
      tid,
      { ...team, playerIds: team.playerIds.filter(pid => pid !== playerId) },
    ])
  );
}

/** Returns true if this player can act on the current turn (own turn, or team member's turn) */
export function isActiveParticipant(room: Room, playerId: string): boolean {
  if (!room.activeRound?.currentTurn) return false;
  const activeId = room.activeRound.currentTurn.activeId;
  if (activeId === playerId) return true;
  if (room.useTeams && room.teams[activeId]) {
    return room.teams[activeId].playerIds.includes(playerId);
  }
  return false;
}

const STARTING_TOKENS: Record<string, number> = {
  original: 2,
  pro: 5,
  expert: 3,
  cooperative: 5,
};

/**
 * Returns the entity key used for timeline/token lookups.
 * In cooperative mode: 'cooperative'. In team mode: the player's teamId. Else: playerId.
 */
export function activeEntityId(room: Room, playerId: string): string {
  if (!room.activeRound) return playerId;
  if (room.activeRound.config.mode === 'cooperative') return 'cooperative';
  if (room.useTeams) {
    const teamEntry = Object.entries(room.teams).find(([, t]) => t.playerIds.includes(playerId));
    return teamEntry?.[0] ?? playerId;
  }
  return playerId;
}

/**
 * Deal starting cards; populate timelines; determine turn order (oldest starting card goes first).
 * The deck is shuffled externally and passed in.
 */
export function initRound(
  room: Room,
  config: RoundConfig,
  deck: Card[]
): { room: Room; deck: Card[] } {
  const clearedRoom: Room = {
    ...room,
    players: Object.fromEntries(
      Object.entries(room.players).map(([id, p]) => [id, { ...p, isSpectator: false }])
    ),
  };
  const playerIds = Object.keys(clearedRoom.players);
  const remaining = [...deck];

  const timelines: Record<string, Timeline> = {};
  const tokens: Record<string, number> = {};
  const startingCards: Record<string, Card> = {};

  const startTokens = STARTING_TOKENS[config.mode] ?? 2;

  if (config.mode === 'cooperative') {
    // All starting cards go to the shared timeline; turn order still uses player IDs
    const sharedCards: Card[] = [];
    for (const playerId of playerIds) {
      const startCard = remaining.shift();
      if (!startCard) throw new Error('Not enough cards in the deck to deal starting cards');
      sharedCards.push(startCard);
      startingCards[playerId] = startCard;
    }
    timelines['cooperative'] = {
      ownerId: 'cooperative',
      cards: sharedCards.sort((a, b) => a.releaseYear - b.releaseYear),
    };
    tokens['cooperative'] = startTokens;
  } else if (clearedRoom.useTeams) {
    // Team mode: one timeline + token pool per team; turn order = teamIds
    const activeTeamIds = Object.keys(clearedRoom.teams).filter(
      tid => clearedRoom.teams[tid].playerIds.length > 0
    );
    if (activeTeamIds.length < 2) throw new Error('Need at least 2 teams with players to start');
    for (const teamId of activeTeamIds) {
      const startCard = remaining.shift();
      if (!startCard) throw new Error('Not enough cards in the deck to deal starting cards');
      timelines[teamId] = { ownerId: teamId, cards: [startCard] };
      tokens[teamId] = startTokens;
      startingCards[teamId] = startCard;
    }
    // Reuse sortedPlayerIds variable name for teams
    const sortedTeamIds = shuffleArray(activeTeamIds).sort(
      (a, b) => startingCards[a].releaseYear - startingCards[b].releaseYear
    );
    return {
      room: {
        ...clearedRoom,
        status: 'round_active',
        activeRound: {
          config,
          roundNumber: clearedRoom.roundHistory.length + 1,
          turnOrder: sortedTeamIds,
          turnIndex: 0,
          timelines,
          tokens,
          deckRemaining: remaining.length,
        },
      },
      deck: remaining,
    };
  } else {
    for (const playerId of playerIds) {
      const startCard = remaining.shift();
      if (!startCard) throw new Error('Not enough cards in the deck to deal starting cards');
      timelines[playerId] = { ownerId: playerId, cards: [startCard] };
      tokens[playerId] = startTokens;
      startingCards[playerId] = startCard;
    }
  }

  // Sort players by starting card releaseYear ascending (oldest goes first)
  // Ties broken by random shuffle
  const sortedPlayerIds = shuffleArray(playerIds).sort(
    (a, b) => startingCards[a].releaseYear - startingCards[b].releaseYear
  );

  const roundNumber = clearedRoom.roundHistory.length + 1;

  const updatedRoom: Room = {
    ...clearedRoom,
    status: 'round_active',
    activeRound: {
      config,
      roundNumber,
      turnOrder: sortedPlayerIds,
      turnIndex: 0,
      timelines,
      tokens,
      deckRemaining: remaining.length,
      gameLog: [],
    },
  };

  return { room: updatedRoom, deck: remaining };
}

/** Draw the next card for a turn; return hidden version + updated deck */
export function drawCard(deck: Card[]): { card: Card; hidden: CardHidden; remaining: Card[] } {
  if (deck.length === 0) {
    throw new Error('Deck is empty');
  }
  const [card, ...remaining] = deck;
  const hidden: CardHidden = {
    trackId: card.trackId,
    previewUrl: card.previewUrl,
    albumArt: card.albumArt,
    streamUrl: card.streamUrl ?? null,
  };
  return { card, hidden, remaining };
}

/**
 * Return true if placing `card` at `position` in `timeline` is correct.
 *
 * position is 0-indexed insert point:
 *   0        = before all cards
 *   n        = after all cards (n = timeline.length)
 *
 * Correct if:
 *   (position === 0 || card.releaseYear >= timeline[position-1].releaseYear)
 *   && (position === timeline.length || card.releaseYear <= timeline[position].releaseYear)
 */
export function isPlacementCorrect(timeline: Card[], card: Card, position: number): boolean {
  const leftOk =
    position === 0 || card.releaseYear >= timeline[position - 1].releaseYear;
  const rightOk =
    position === timeline.length || card.releaseYear <= timeline[position].releaseYear;
  return leftOk && rightOk;
}

/** Apply a placement: update room's currentTurn phase to 'challenge' */
export function applyPlacement(
  room: Room,
  playerId: string,
  position: number,
  challengeWindowMs: number = DEFAULT_CHALLENGE_WINDOW_MS,
): Room {
  if (!room.activeRound) throw new Error('No active round');
  const currentTurn = room.activeRound.currentTurn;
  if (!currentTurn) throw new Error('No current turn');
  if (!isActiveParticipant(room, playerId)) throw new Error('Not your turn');

  return {
    ...room,
    activeRound: {
      ...room.activeRound,
      currentTurn: {
        ...currentTurn,
        phase: 'challenge',
        placedPosition: position,
        challengeDeadline: Date.now() + challengeWindowMs,
      },
    },
  };
}

/**
 * Resolve the flip: move card to timeline (or discard), update tokens, advance turn phase.
 * Returns updated room, whether placement was correct, and winnerId if someone won.
 */
export function resolveFlip(
  room: Room,
  card: Card
): { room: Room; correct: boolean; winnerId?: string } {
  if (!room.activeRound) throw new Error('No active round');
  const { currentTurn, timelines, tokens, config, turnOrder } = room.activeRound;
  if (!currentTurn) throw new Error('No current turn');

  const playerId = currentTurn.activeId;
  // In team/coop mode activeId is the teamId/'cooperative'; in solo mode it's a playerId
  const entityId = config.mode === 'cooperative' ? 'cooperative' : playerId;
  const position = currentTurn.placedPosition ?? 0;
  const timeline = timelines[entityId];

  const correct = isPlacementCorrect(timeline.cards, card, position);

  // In Pro/Expert mode, a correct placement only keeps the card if the player named the song
  const effectivelyCorrect = correct &&
    (config.mode !== 'pro' && config.mode !== 'expert' || currentTurn.named === true);

  let updatedCards: Card[];
  if (effectivelyCorrect) {
    updatedCards = [
      ...timeline.cards.slice(0, position),
      card,
      ...timeline.cards.slice(position),
    ];
  } else {
    updatedCards = timeline.cards;
  }

  const updatedTimelines: Record<string, Timeline> = {
    ...timelines,
    [entityId]: {
      ...timeline,
      cards: updatedCards,
    },
  };

  let updatedTokens = { ...tokens };

  if (config.mode === 'cooperative') {
    // Wrong placement costs 1 shared token in cooperative
    if (!correct && config.tokensEnabled) {
      updatedTokens['cooperative'] = Math.max(0, (updatedTokens['cooperative'] ?? 0) - 1);
    }
  } else {
    // Handle challenges — no challenges in cooperative
    for (const challenge of (currentTurn.challenges ?? [])) {
      // In team mode, challengerId is the player's teamId; in solo mode it's the playerId
      const challengerEntityId = room.useTeams
        ? (Object.entries(room.teams).find(([, t]) => t.playerIds.includes(challenge.challengerId))?.[0] ?? challenge.challengerId)
        : challenge.challengerId;
      if (!correct) {
        // Opponent was wrong → challenger steals the card
        const challengerTimeline = updatedTimelines[challengerEntityId];
        if (challengerTimeline) {
          updatedTimelines[challengerEntityId] = {
            ...challengerTimeline,
            cards: [...challengerTimeline.cards, card].sort(
              (a, b) => a.releaseYear - b.releaseYear
            ),
          };
        }
      } else {
        // Opponent was right → challenger loses a token
        const cTokens = updatedTokens[challengerEntityId] ?? 0;
        updatedTokens[challengerEntityId] = Math.max(0, cTokens - 1);
      }
    }
  }

  const updatedRoom: Room = {
    ...room,
    activeRound: {
      ...room.activeRound,
      timelines: updatedTimelines,
      tokens: updatedTokens,
      currentTurn: {
        ...currentTurn,
        phase: 'flip',
      },
    },
  };

  const cardsToWin = config.cardsToWin;

  if (config.mode === 'cooperative') {
    // Cooperative loss: shared token pool depleted
    if (config.tokensEnabled && updatedTokens['cooperative'] <= 0) {
      return { room: { ...updatedRoom, status: 'round_ended' }, correct };
    }
    // Cooperative win: shared timeline reaches cardsToWin
    if (updatedTimelines['cooperative'].cards.length >= cardsToWin) {
      return { room: updatedRoom, correct, winnerId: 'cooperative' };
    }
  } else {
    // Check for individual win
    for (const pid of turnOrder) {
      const tl = updatedTimelines[pid];
      if (tl && tl.cards.length >= cardsToWin) {
        return { room: updatedRoom, correct, winnerId: pid };
      }
    }
  }

  // Check if deck is empty
  if (room.activeRound.deckRemaining === 0) {
    if (config.mode === 'cooperative') {
      // Cooperative deck-empty: no winner (loss by default)
      return { room: { ...updatedRoom, status: 'round_ended' }, correct };
    }

    // Find winner by most cards, tiebreak by avg release year
    let winnerId: string | undefined;
    let maxCards = -1;
    let maxAvgYear = -1;

    for (const pid of turnOrder) {
      const tl = updatedTimelines[pid];
      const cardCount = tl?.cards.length ?? 0;
      const avgYear =
        cardCount > 0
          ? tl.cards.reduce((sum, c) => sum + c.releaseYear, 0) / cardCount
          : 0;

      if (
        cardCount > maxCards ||
        (cardCount === maxCards && avgYear > maxAvgYear)
      ) {
        maxCards = cardCount;
        maxAvgYear = avgYear;
        winnerId = pid;
      }
    }

    return { room: { ...updatedRoom, status: 'round_ended' }, correct, winnerId };
  }

  return { room: updatedRoom, correct };
}

/**
 * Advance to the next turn (increment turnIndex, wrap around).
 * Returns updated room with phase reset.
 */
export function advanceTurn(room: Room): Room {
  if (!room.activeRound) throw new Error('No active round');
  const { turnOrder, turnIndex } = room.activeRound;
  const nextIndex = (turnIndex + 1) % turnOrder.length;
  return {
    ...room,
    activeRound: {
      ...room.activeRound,
      turnIndex: nextIndex,
      currentTurn: undefined,
    },
  };
}

/** Spend 1 token to skip; draw next card without placing. Returns updated room (token deducted). */
export function applySkip(room: Room, playerId: string): Room {
  if (!room.activeRound) throw new Error('No active round');
  const { tokens, config } = room.activeRound;
  if (!config.tokensEnabled) throw new Error('Tokens are disabled in this game');

  const entityId = config.mode === 'cooperative' ? 'cooperative' : playerId;
  const currentTokens = tokens[entityId] ?? 0;
  if (currentTokens < 1) throw new Error('Not enough tokens to skip');

  return {
    ...room,
    activeRound: {
      ...room.activeRound,
      tokens: { ...tokens, [entityId]: currentTokens - 1 },
    },
  };
}

/**
 * Spend 3 tokens to "buy" the current card placement.
 * The player still places the card themselves; their NEXT turn is auto-skipped.
 */
export function applyBuy(room: Room, playerId: string): Room {
  if (!room.activeRound) throw new Error('No active round');
  const { tokens, currentTurn, config } = room.activeRound;
  if (!config.tokensEnabled) throw new Error('Tokens are disabled in this game');
  if (!currentTurn) throw new Error('No current turn');
  if (!isActiveParticipant(room, playerId)) throw new Error('Not your turn');
  if (currentTurn.phase !== 'place') throw new Error('Can only buy during place phase');

  const entityId = config.mode === 'cooperative' ? 'cooperative' : playerId;
  const current = tokens[entityId] ?? 0;
  if (current < 3) throw new Error('Not enough tokens to buy (need 3)');

  const pendingSkips = room.activeRound.pendingSkips ?? [];
  return {
    ...room,
    activeRound: {
      ...room.activeRound,
      tokens: { ...tokens, [entityId]: current - 3 },
      pendingSkips: pendingSkips.includes(playerId) ? pendingSkips : [...pendingSkips, playerId],
    },
  };
}

/** Increment a player's missedTurns counter */
export function incrementMissedTurns(room: Room, playerId: string): Room {
  if (!room.players[playerId]) return room;
  return {
    ...room,
    players: {
      ...room.players,
      [playerId]: {
        ...room.players[playerId],
        missedTurns: (room.players[playerId].missedTurns ?? 0) + 1,
      },
    },
  };
}

/**
 * Remove a player from the active turn order (called after 2 consecutive missed turns).
 * Adjusts turnIndex so the current position keeps pointing to the correct next player.
 */
export function removeFromTurnOrder(room: Room, playerId: string): Room {
  if (!room.activeRound) return room;
  const { turnOrder, turnIndex } = room.activeRound;
  const idx = turnOrder.indexOf(playerId);
  if (idx === -1) return room;

  const newTurnOrder = turnOrder.filter(id => id !== playerId);
  if (newTurnOrder.length === 0) return room; // last player — caller handles game-end

  let newTurnIndex = turnIndex;
  if (idx < turnIndex) {
    newTurnIndex = turnIndex - 1;
  } else if (idx === turnIndex) {
    newTurnIndex = turnIndex % newTurnOrder.length;
  }
  // idx > turnIndex: index unchanged

  return {
    ...room,
    activeRound: {
      ...room.activeRound,
      turnOrder: newTurnOrder,
      turnIndex: newTurnIndex,
      currentTurn: idx === turnIndex ? undefined : room.activeRound.currentTurn,
    },
  };
}

/** Award +1 token for correctly naming song (max 5). No-op in pro/expert modes. */
export function applyNamingBonus(room: Room, playerId: string): Room {
  if (!room.activeRound) throw new Error('No active round');
  const { tokens, config } = room.activeRound;
  // Pro and expert disable the naming bonus
  if (!config.tokensEnabled || config.mode === 'pro' || config.mode === 'expert') return room;

  const entityId = config.mode === 'cooperative' ? 'cooperative' : playerId;
  const currentTokens = tokens[entityId] ?? 0;
  return {
    ...room,
    activeRound: {
      ...room.activeRound,
      tokens: { ...tokens, [entityId]: Math.min(5, currentTokens + 1) },
    },
  };
}

/** Get the number of cards on the active entity's timeline */
export function timelineLength(room: Room, playerId: string): number {
  const entityId = room.activeRound?.config.mode === 'cooperative' ? 'cooperative' : playerId;
  return room.activeRound?.timelines[entityId]?.cards.length ?? 0;
}

/** Build a RoundSummary for game history */
export function buildRoundSummary(
  room: Room,
  winnerId: string | null
): RoundSummary {
  return {
    winnerId,
    mode: room.activeRound?.config.mode ?? 'original',
    roundNumber: room.roundHistory.length + 1,
  };
}

/** Room owner explicitly ends the game — locks the room from new joins. */
export function endGame(room: Room): Room {
  return { ...room, status: 'game_over' };
}
