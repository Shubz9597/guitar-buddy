import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { cleanError } from "./bridge.ts";
import { typedSong, type SongMatch } from "./songs.ts";

/**
 * Search box that turns typing into a list of real songs to choose from.
 * Until a song is picked, the tone search cannot start.
 */
export function SongPicker({
  selected,
  disabled,
  onSelect,
  find,
  initialText = "",
}: {
  /** Text to start with, e.g. an example song the player clicked. */
  initialText?: string;
  selected?: SongMatch;
  disabled: boolean;
  onSelect: (song: SongMatch | undefined) => void;
  find: (term: string) => Promise<SongMatch[]>;
}) {
  const [text, setText] = useState(initialText);
  const [matches, setMatches] = useState<SongMatch[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [active, setActive] = useState(0);
  // The list opens only when the player is choosing (typing, focusing the box,
  // or pressing Change), never by itself after a pick or a finished search.
  const [listOpen, setListOpen] = useState(initialText.trim().length >= 2);
  const listId = useId();
  const term = text.trim();

  useEffect(() => {
    if (selected || !listOpen || term.length < 2) return;
    let live = true;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const found = await find(term);
        if (!live) return;
        setMatches(found.slice(0, 12));
        setActive(0);
        setError(undefined);
      } catch (e) {
        if (live) setError(cleanError(e));
      } finally {
        if (live) setLoading(false);
      }
    }, 350);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [term, selected, listOpen, find]);

  if (selected) {
    return (
      <div className="song-picked">
        <Artwork song={selected} />
        <div className="song-picked__text">
          <strong>{selected.title}</strong>
          <span className="tone-muted">
            {selected.artist ? songMeta(selected) : "Your own search text (not matched to a recording)"}
          </span>
        </div>
        <button
          type="button"
          className="button button--ghost"
          disabled={disabled}
          onClick={() => {
            setText(selected.artist ? `${selected.title} ${selected.artist}` : selected.title);
            setListOpen(true);
            onSelect(undefined);
          }}
        >
          Change
        </button>
      </div>
    );
  }

  const open = listOpen && term.length >= 2;
  const options = open ? [...matches, typedSong(term)] : [];
  const choose = (song: SongMatch) => {
    onSelect(song);
    setMatches([]);
    setListOpen(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!open) {
      if (event.key === "ArrowDown" && term.length >= 2) setListOpen(true);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i + step + options.length) % options.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (options[active]) choose(options[active]);
    } else if (event.key === "Escape") {
      setText("");
      setListOpen(false);
    }
  };

  return (
    <div className="song-picker">
      <input
        className="song-picker__input"
        type="search"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        aria-label="Song"
        placeholder="Search for a song or artist"
        value={text}
        disabled={disabled}
        autoFocus
        onChange={(e) => {
          setText(e.target.value);
          setListOpen(true);
        }}
        onFocus={() => setListOpen(true)}
        onBlur={() => setListOpen(false)}
        onKeyDown={onKeyDown}
      />
      {open && (
        <ul className="song-list" id={listId} role="listbox" aria-label="Matching songs" aria-busy={loading}>
          {error && <li className="song-list__note">Song lookup failed: {error}</li>}
          {loading && matches.length === 0 && <li className="song-list__note">Looking up songs…</li>}
          {options.map((song, i) => (
            <li
              key={song.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className="song-option"
              data-typed={!song.artist}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault(); // keep focus in the input
                choose(song);
              }}
            >
              {song.artist ? (
                <>
                  <Artwork song={song} />
                  <div className="song-option__text">
                    <strong>{song.title}</strong>
                    <span className="song-option__meta">
                      <span className="song-option__artist">{song.artist}</span>
                      {[song.album, song.year].filter(Boolean).map((part) => ` · ${part}`)}
                    </span>
                  </div>
                </>
              ) : (
                <span className="tone-muted">Not listed? Search “{song.title}” as typed</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function songMeta(song: SongMatch) {
  return [song.artist, song.album, song.year].filter(Boolean).join(" · ");
}

function Artwork({ song }: { song: SongMatch }) {
  return song.artwork ? (
    <img className="song-art" src={song.artwork} alt="" width={40} height={40} />
  ) : (
    <span className="song-art song-art--empty" aria-hidden="true">♪</span>
  );
}
