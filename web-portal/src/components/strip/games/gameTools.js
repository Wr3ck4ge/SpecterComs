// P2C: per-game tools the strip's Games cabinet offers. Static metadata only
// (no component imports), so the Games cabinet stays in the main strip chunk
// and the tools themselves load lazily (./GameToolPanel).
//
// Star Citizen's tools are the personal hangar (ship list, global per-user)
// and the ship editor (seat locks, loadout overrides, combat stats/damage
// estimate) — the same REST endpoints the old main window's Settings → Hangar
// and ShipEditor used. The editor always works on a hangar ship, so it opens
// as a drill-in from the hangar list. (The mission map and ship composition
// belong to the operation planner, not here.)
export const GAME_TOOLS = {
  star_citizen: [
    { id: 'hangar', title: 'Hangar', subtitle: 'Your ships: add, rename, remove' },
    { id: 'editor', title: 'Ship editor', subtitle: 'Seats, loadouts and combat stats' },
  ],
};

export const GAME_BLURB = {
  star_citizen: 'Fleet tools for the ships you fly.',
};
