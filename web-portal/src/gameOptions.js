// The list of games an operation can be tagged with. Its own module (re-
// exported by games.js) so lightweight surfaces like the tray strip can read
// it without pulling in games.js's settings modules (Hangar and friends).
// Mirrors the backend's SUPPORTED_GAMES set in eventsController.ts.
export const GAME_OPTIONS = [
  { v: 'none', l: 'GENERAL' },
  { v: 'star_citizen', l: 'STAR CITIZEN' },
];
