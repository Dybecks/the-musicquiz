import { useEffect, useState } from 'react';
import type { Song } from '../game/engine';
import { loadArtwork, type Artwork } from '../facts/artwork';
import { useT } from '../i18n';

/** The song's picture (src/facts/artwork.ts), or null until found or if none is. */
export function useArtwork(song: Song): Artwork | null {
  const [art, setArt] = useState<{ id: string; art: Artwork | null } | null>(null);
  useEffect(() => {
    let live = true;
    loadArtwork(song).then((a) => live && setArt({ id: song.id, art: a }));
    return () => {
      live = false;
    };
  }, [song]);
  return art && art.id === song.id ? art.art : null;
}

/**
 * The picture for a song: the film, show, game or musical for soundtracks,
 * else the album cover. Big on the reveal, a thumbnail on timeline cards.
 * Shows nothing until found, if none is, or if the image fails to load.
 */
export function SongArt({ song, className }: { song: Song; className: string }) {
  const t = useT();
  const art = useArtwork(song);
  const [broken, setBroken] = useState<string | null>(null);
  if (!art || broken === art.url) return null;
  return (
    <img
      className={`${className} ${art.kind}`}
      src={art.url}
      alt={art.kind === 'work' && song.from ? t.game.artWork(song.from) : t.game.artAlbum(song.title, song.artist)}
      referrerPolicy="no-referrer"
      loading="lazy"
      onError={() => setBroken(art.url)}
    />
  );
}
