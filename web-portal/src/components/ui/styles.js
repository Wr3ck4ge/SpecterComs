// Shared class fragments for components/ui.

// Join class names, skipping falsy entries.
export const cx = (...parts) => parts.filter(Boolean).join(' ');

// Keyboard focus ring. Uses `outline` rather than Tailwind's `ring-*` because
// ring is a box-shadow, and index.css's legacy `button:hover` glow (a
// box-shadow) would wipe it out on a hovered button. That glow now skips
// buttons in or under `.font-ui`, but outline keeps this safe anywhere.
export const focusRing =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-specter-border-focus';

// Glass panel surface. Uses the `/opacity` form of the bg colour on purpose:
// index.css restyles the bare `.bg-specter-bg-panel` class with !important.
export const glassPanel =
  'bg-specter-bg-panel/70 backdrop-blur-md border border-specter-border shadow-[0_8px_32px_rgba(0,0,0,0.34)]';
