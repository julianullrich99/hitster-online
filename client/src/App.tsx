import { useGame } from './game/useGame';
import { getServerUrl } from './config';
import EntryPage from './components/EntryPage';
import GameRoom from './components/GameRoom';

export default function App() {
  const game = useGame();

  const serverUrl = getServerUrl();

  if (!game.room) {
    return (
      <EntryPage
        serverUrl={serverUrl}
        onConnectAndCreateRoom={game.connectAndCreateRoom}
        onConnectAndJoinRoom={game.connectAndJoinRoom}
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
      timelineLength={game.timelineLength}
      lastFlip={game.lastFlip}
      roundEnded={game.roundEnded}
      myTokens={game.myTokens}
      sessionId={game.sessionId}
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
      onLeave={game.leaveRoom}
    />
  );
}
