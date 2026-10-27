import Hangar from './components/Hangar';

// Single source of truth for "which games exist" — both the per-event game
// field (OperationPlanner.jsx's EventForm) and the per-user "my games"
// picker (SettingsUI's games tab) read from this instead of keeping their
// own separate lists. (Defined in gameOptions.js so the tray strip can use it
// without importing Hangar.)
export { GAME_OPTIONS } from './gameOptions';

// game key -> list of settings-page modules unlocked once the user has that
// game selected on their profile (see user_games / api.getMyGames). Adding a
// second game's module later is just a new entry here — nothing else in the
// settings shell needs to change.
export const GAME_MODULES = {
  star_citizen: [
    { key: 'hangar', label: 'HANGAR', component: Hangar },
  ],
};
