/**
 * Artist names as Spotify credits them, for artists that Wikidata or
 * Wikipedia name in another way (in full, or with a backing band).
 * scripts/source-candidates.ts and scripts/spotify-precompute.ts both use it,
 * so a song gets the same name everywhere.
 */
export const ARTIST_NAMES: Record<string, string> = {
  'Carola Häggkvist': 'Carola',
  'Toussaint Chiza': 'Tusse',
  'Mariette Hansson': 'Mariette',
  'Amy Deasismont': 'Amy Diamond',
  'Netta Barzilai': 'Netta',
  'Chanel Terrero': 'Chanel',
  'Louane Emera': 'Louane',
  'Felicia Eriksson': 'Felicia',
  'Emilia Rydberg': 'Emilia',
  'Daði Freyr Pétursson': 'Daði Freyr',
  'Björn & Benny, Agnetha & Anni-Frid': 'ABBA',
  'Charlotte Nilsson': 'Charlotte Perrelli',
  'The Nova': 'Malta',
  'Izhar Cohen and the Alphabeta': 'Izhar Cohen',
  'Lynsey de Paul and Mike Moran': 'Lynsey De Paul',
};

export const spotifyArtist = (artist: string): string => ARTIST_NAMES[artist] ?? artist;
