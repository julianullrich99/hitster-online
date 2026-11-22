import { useGame } from './game/useGame';
import { getServerUrl } from './config';
import EntryPage from './components/EntryPage';
import GameRoom from './components/GameRoom';
import ObserverScreen from './components/ObserverScreen';
import { useEffect } from 'react';

/** Room code from a TV link (?tv=ABCD) */
function tvCodeFromUrl(): string | null {
  try {
    const code = new URLSearchParams(window.location.search).get('tv');
    return code && /^[A-Za-z0-9]{4}$/.test(code) ? code.toUpperCase() : null;
  } catch {
    return null;
  }
}

function closeObserver(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete('tv');
  window.location.replace(url.toString());
}

export default function App() {
  const game = useGame();

  const serverUrl = getServerUrl();
  const { observeRoom } = game;

  // A TV opened with ?tv=ABCD goes straight to the observer screen
  useEffect(() => {
    const code = tvCodeFromUrl();
    if (code) observeRoom(code);
  }, [observeRoom]);

  if (game.room && game.isObserver) {
    return (
      <ObserverScreen
        room={game.room}
        currentCard={game.currentCard}
        activePlayerId={game.activePlayerId}
        previewUrl={game.previewUrl}
        streamUrl={game.streamUrl}
        playAt={game.playAt}
        speaker={game.speaker}
        turnEndsAt={game.turnEndsAt}
        lastFlip={game.lastFlip}
        roundEnded={game.roundEnded}
        onDismissRoundEnd={game.dismissRoundEnd}
        onLeave={closeObserver}
      />
    );
  }

  if (!game.room) {
    return (
      <EntryPage
        serverUrl={serverUrl}
        onConnectAndCreateRoom={game.connectAndCreateRoom}
        onConnectAndJoinRoom={game.connectAndJoinRoom}
        onRejoinLastRoom={game.rejoinLastRoom}
        onObserveRoom={game.observeRoom}
        serverError={game.socketError}
        roomJoined={game.room}
      />
    );
  }

  return (
    <GameRoom
      room={game.room}
      currentCard={game.currentCard}
      activePlayerId={game.activePlayerId}
      previewUrl={game.previewUrl}
      streamUrl={game.streamUrl}
      playAt={game.playAt}
      speaker={game.speaker}
      timelineLength={game.timelineLength}
      turnEndsAt={game.turnEndsAt}
      lastFlip={game.lastFlip}
      roundEnded={game.roundEnded}
      sessionId={game.sessionId}
      localPlayers={game.localPlayers}
      onAddLocalPlayer={game.addLocalPlayer}
      onRemoveLocalPlayer={game.removeLocalPlayer}
      onKickPlayer={game.kickPlayer}
      socketError={game.socketError}
      onStartRound={game.startRound}
      onPlaceCard={game.placeCard}
      onChallengeCard={game.challengeCard}
      onSkipCard={game.skipCard}
      onNameSong={game.nameSong}
      onBuyCard={game.buyCard}
      onDismissRoundEnd={game.dismissRoundEnd}
      onCreateTeam={game.createTeam}
      onJoinTeam={game.joinTeam}
      onLeaveTeam={game.leaveTeam}
      onPreviewPlaylist={game.previewPlaylist}
      onClearPlaylistPreview={game.clearPlaylistPreview}
      playlistPreviewCards={game.playlistPreviewCards}
      playlistPreviewLoading={game.playlistPreviewLoading}
      onEndGame={game.endGame}
      audioControls={{
        spotifyDevices: game.spotifyDevices,
        onSetAudioMode: game.setAudioMode,
        onConnectSpotify: game.connectSpotify,
        savedSpotifyAccount: game.savedSpotifyAccount,
        onListSpotifyDevices: game.listSpotifyDevices,
        onSelectSpotifyDevice: game.selectSpotifyDevice,
        onUnlinkSpotify: game.unlinkSpotify,
      }}
      onLeave={game.leaveRoom}
    />
  );
}
