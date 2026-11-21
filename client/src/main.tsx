import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { installAudioUnlock } from './audio/gameAudio';
import { LanguageProvider } from './i18n';
import './index.css';

installAudioUnlock();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LanguageProvider>
      <App />
    </LanguageProvider>
  </StrictMode>
);
