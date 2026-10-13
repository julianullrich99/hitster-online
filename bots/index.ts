/**
 * Hitster Bot Runner
 *
 * Usage:
 *   npm start                              — bots join/create rooms autonomously
 *   npm start -- --room XXXX              — join an existing room (no auto-start unless owner)
 *   npm start -- --count 3                — use only first 3 profiles
 *   npm start -- --url http://server:3000
 *   npm start -- --mode pro               — game mode (original/pro/expert/cooperative)
 *   npm start -- --genre "90s Pop"        — playlist label / genre for round
 *
 * Autonomous mode (default): each bot prefers joining lobbies with fewer than 3
 * players, otherwise creates a room. The room owner starts when 3+ players are present.
 *
 * Profiles are loaded from ./profiles.yaml. Edit that file to change bot behaviour.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';
import type { RoomSummary } from '../shared/types';
import { Bot } from './bot';
import {
  effectivePlayerCount,
  fetchRoomSummaries,
  pickJoinRoom,
  randomTopic,
  shouldJoinOverCreate,
} from './roomPicker';
import { BotProfile, ProfilesFile } from './types';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseArgs(): {
  serverUrl: string;
  roomCode?: string;
  count?: number;
  mode: 'original' | 'pro' | 'expert' | 'cooperative';
  genre?: string;
} {
  const args = process.argv.slice(2);
  const port = process.env.PORT || '3000';
  let serverUrl = process.env.SERVER_URL ?? `http://localhost:${port}`;
  let roomCode: string | undefined;
  let count: number | undefined;
  let mode: 'original' | 'pro' | 'expert' | 'cooperative' = 'original';
  let genre: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url'   && args[i + 1]) serverUrl = args[++i];
    if (args[i] === '--room'  && args[i + 1]) roomCode  = args[++i].toUpperCase();
    if (args[i] === '--count' && args[i + 1]) count     = parseInt(args[++i], 10);
    if (args[i] === '--genre' && args[i + 1]) genre     = args[++i];
    if (args[i] === '--mode'  && args[i + 1]) {
      const m = args[++i];
      if (['original', 'pro', 'expert', 'cooperative'].includes(m)) {
        mode = m as typeof mode;
      }
    }
  }

  return { serverUrl, roomCode, count, mode, genre };
}

function loadProfiles(): BotProfile[] {
  const raw = readFileSync(join(__dirname, 'profiles.yaml'), 'utf-8');
  const file = parse(raw) as ProfilesFile;
  return file.bots;
}

function pickProfiles(profiles: BotProfile[], count?: number): BotProfile[] {
  if (!count) return profiles;
  const result: BotProfile[] = [];
  for (let i = 0; i < count; i++) {
    const profile = profiles[i % profiles.length];
    const round = Math.floor(i / profiles.length);
    // Names identify players within a room, so repeated profiles need distinct names
    result.push(round === 0 ? profile : { ...profile, name: `${profile.name} ${round + 1}` });
  }
  return result;
}

async function placeBotInLobby(
  bot: Bot,
  profile: BotProfile,
  serverUrl: string,
  localCounts: Map<string, number>
): Promise<string> {
  const summaries = await fetchRoomSummaries(serverUrl);
  const countFor = (room: RoomSummary) => effectivePlayerCount(room, localCounts);
  const joinable = summaries.filter(
    r => countFor(r) < 3 && (r.status === 'lobby' || r.status === 'round_ended')
  );

  if (shouldJoinOverCreate(joinable.length > 0, profile.join_willingness)) {
    const target = pickJoinRoom(joinable, countFor);
    if (target) {
      const code = target.code;
      bot.joinRoom(code);
      localCounts.set(code, countFor(target) + 1);
      return code;
    }
  }

  const topic = randomTopic();
  const code = await new Promise<string>(resolve => {
    bot.onRoomCode(resolve);
    bot.createRoom(topic);
  });
  localCounts.set(code, 1);
  return code;
}

async function main(): Promise<void> {
  const { serverUrl, roomCode: existingRoom, count, mode, genre } = parseArgs();
  const allProfiles = loadProfiles();
  const profiles = pickProfiles(allProfiles, count);

  console.log(`\nHitster Bot Runner`);
  console.log(`Server:  ${serverUrl}`);
  console.log(`Room:    ${existingRoom ?? '(autonomous join/create)'}`);
  console.log(`Mode:    ${mode}`);
  console.log(`Genre:   ${genre ?? '(random)'}`);
  console.log(`Bots:    ${profiles.map(p => p.name).join(', ')}`);
  console.log(`────────────────────────────────────\n`);

  const bots = profiles.map(profile => new Bot(serverUrl, profile));
  bots.forEach(b => b.enableAutoStart(mode, genre));

  process.on('SIGINT', () => {
    console.log('\nShutting down bots...');
    bots.forEach(b => b.disconnect());
    process.exit(0);
  });

  if (existingRoom) {
    for (let i = 0; i < bots.length; i++) {
      bots[i].connect();
      await delay(150);
      bots[i].joinRoom(existingRoom);
    }
    console.log(`All bots joined ${existingRoom}. Owner starts at 3+ players.`);
    return;
  }

  const localCounts = new Map<string, number>();

  for (let i = 0; i < bots.length; i++) {
    const bot = bots[i];
    const profile = profiles[i];
    bot.connect();
    await delay(250);

    const code = await placeBotInLobby(bot, profile, serverUrl, localCounts);
    console.log(`${profile.name} → ${code}`);
    await delay(200);
  }

  console.log('\nBots placed. Owners will start rounds when lobbies reach 3 players.');
}

main().catch(err => {
  console.error('Bot runner failed:', err);
  process.exit(1);
});
