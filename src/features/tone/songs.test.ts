import { describe, expect, it } from "vitest";
import { parseSongSearch, songQuery, typedSong } from "./songs";

// Trimmed from a real iTunes response for "high hopes".
const RESPONSE = {
  resultCount: 6,
  results: [
    { kind: "song", trackId: 1, trackName: "High Hopes", artistName: "Panic! At the Disco", collectionName: "Pray for the Wicked", releaseDate: "2018-05-23T07:00:00Z", artworkUrl60: "https://x/1.jpg" },
    { kind: "song", trackId: 2, trackName: "High Hopes", artistName: "Pink Floyd", collectionName: "A Foot in the Door", releaseDate: "2011-11-07T08:00:00Z" },
    { kind: "song", trackId: 3, trackName: "High Hopes (White Panda Remix)", artistName: "Panic! At the Disco", collectionName: "Single", releaseDate: "2019-01-01T08:00:00Z" },
    { kind: "song", trackId: 4, trackName: "High Hopes", artistName: "Pink Floyd", collectionName: "The Division Bell", releaseDate: "1994-03-28T08:00:00Z" },
    { kind: "music-video", trackId: 5, trackName: "High Hopes", artistName: "Pink Floyd" },
    { kind: "song", trackId: 6, trackName: "High Hopes", artistName: "Frank Sinatra", collectionName: "Ultimate Sinatra", releaseDate: "1959-01-01T08:00:00Z" },
  ],
};

describe("parseSongSearch", () => {
  const songs = parseSongSearch(RESPONSE);

  it("keeps one entry per song and artist, in first-seen order", () => {
    expect(songs.map((s) => s.artist)).toEqual(["Panic! At the Disco", "Pink Floyd", "Frank Sinatra"]);
  });

  it("prefers the original release over compilations and remixes", () => {
    expect(songs[1]).toMatchObject({ title: "High Hopes", album: "The Division Bell", year: "1994" });
    expect(songs[0]).toMatchObject({ title: "High Hopes", album: "Pray for the Wicked", year: "2018", artwork: "https://x/1.jpg" });
  });

  it("copes with empty or odd responses", () => {
    expect(parseSongSearch({})).toEqual([]);
    expect(parseSongSearch(null)).toEqual([]);
  });
});

describe("songQuery", () => {
  it("names the exact recording for the researcher", () => {
    expect(songQuery(parseSongSearch(RESPONSE)[1])).toBe('"High Hopes" by Pink Floyd, from the album The Division Bell (1994)');
    expect(songQuery(typedSong("  some demo track "))).toBe("some demo track");
  });
});
