import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { DEFAULT_PLAYLIST_LABEL, PLAYLIST_SUGGESTIONS } from '../data/playlistSuggestions';
import { useT } from '../i18n';

const MAX_SUGGESTIONS = 10;

interface PlaylistAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  'data-testid'?: string;
}

export function PlaylistAutocomplete({
  value,
  onChange,
  disabled,
  'data-testid': testId,
}: PlaylistAutocompleteProps) {
  const t = useT();
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const suggestions = useMemo(() => {
    const q = value.trim().toLowerCase();
    const pool = q
      ? PLAYLIST_SUGGESTIONS.filter(s => s.toLowerCase().includes(q))
      : [...PLAYLIST_SUGGESTIONS];
    return pool.slice(0, MAX_SUGGESTIONS);
  }, [value]);

  useEffect(() => {
    setActiveIndex(0);
  }, [value, suggestions.length]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  function pick(suggestion: string) {
    onChange(suggestion);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      setOpen(true);
      return;
    }
    if (!open || suggestions.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex(i => (i + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex(i => (i - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === 'Enter' && suggestions[activeIndex]) {
      e.preventDefault();
      pick(suggestions[activeIndex]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  const showList = open && suggestions.length > 0 && !disabled;

  return (
    <div className="playlist-autocomplete" ref={rootRef}>
      <input
        className="form-input"
        type="text"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        placeholder={t('playlist.placeholder', { example: DEFAULT_PLAYLIST_LABEL })}
        value={value}
        disabled={disabled}
        onChange={e => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        data-testid={testId}
        autoComplete="off"
      />
      {showList && (
        <ul id={listId} className="playlist-autocomplete-list" role="listbox">
          {suggestions.map((s, i) => (
            <li key={s} role="option" aria-selected={i === activeIndex}>
              <button
                type="button"
                className={`playlist-autocomplete-option${i === activeIndex ? ' is-active' : ''}`}
                onMouseDown={e => e.preventDefault()}
                onClick={() => pick(s)}
                onMouseEnter={() => setActiveIndex(i)}
              >
                {s}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
