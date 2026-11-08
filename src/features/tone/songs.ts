// Song lookup, so the researcher gets one exact recording ("High Hopes" by
// Pink Floyd, not Panic! at the Disco). Results come from the iTunes Search
// API (free, no key), fetched by the main process.

export interface SongMatch {
  id: string;
  title: string;
  /** Empty when the player chose to search their own text. */
  artist: string;
  album?: string;
  year?: string;
  artwork?: string;
}

interface ItunesTrack {
  kind?: string;
  trackId?: number;
  trackName?: string;
  artistName?: string;
  collectionName?: string;
  releaseDate?: string;
  artworkUrl60?: string;
}

// "High Hopes (2011 Remaster)", "High Hopes - Live" and "High Hopes" are one song.
const songKey = (s: string) =>
  s
    .toLowerCase()
    .replace(/\s*[([].*?[)\]]/g, "")
    .replace(/\s+-\s+.*$/, "")
    .replace(/[^a-z0-9]+/g, "");

/**
 * Turns an iTunes search response into one entry per song and artist,
 * keeping the earliest release (usually the original album rather than a
 * remaster or compilation) at the position the song first appeared.
 */
export function parseSongSearch(raw: unknown): SongMatch[] {
  const results = (raw as { results?: ItunesTrack[] } | null)?.results ?? [];
  const songs = new Map<string, SongMatch>();
  for (const track of results) {
    if ((track.kind && track.kind !== "song") || !track.trackName || !track.artistName) continue;
    const key = `${songKey(track.trackName)}|${songKey(track.artistName)}`;
    const year = track.releaseDate?.slice(0, 4);
    const existing = songs.get(key);
    if (existing && (!year || (existing.year !== undefined && existing.year <= year))) continue;
    songs.set(key, {
      id: String(track.trackId ?? key),
      title: existing?.title ?? track.trackName,
      artist: track.artistName,
      album: track.collectionName,
      year,
      artwork: track.artworkUrl60,
    });
  }
  return [...songs.values()];
}

/** A song the player typed themselves, for anything the catalog doesn't know. */
export function typedSong(text: string): SongMatch {
  return { id: `typed:${text}`, title: text.trim(), artist: "" };
}

/** What the researcher is told, e.g. "High Hopes" by Pink Floyd, from the album The Division Bell (1994). */
export function songQuery(song: SongMatch): string {
  if (!song.artist) return song.title;
  const album = song.album ? `, from the album ${song.album}` : "";
  const year = song.year ? ` (${song.year})` : "";
  return `"${song.title}" by ${song.artist}${album}${year}`;
}

export function songLabel(song: SongMatch): string {
  return song.artist ? `${song.title} - ${song.artist}` : song.title;
}
