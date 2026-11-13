import { forwardRef } from 'react';
import { cx, focusRing } from './styles';

const VARIANTS = {
  ghost:     'text-specter-text-muted hover:text-specter-text-main hover:bg-white/5',
  secondary: 'text-specter-text-muted hover:text-specter-text-main bg-specter-bg-panel/80 border border-specter-border hover:border-specter-border-strong',
  danger:    'text-red-300 hover:text-red-200 hover:bg-specter-state-error/15',
  // BRAND: a framed tile (the strip bar's buttons): 1px steel hairline on a
  // near-black well, lighter on hover; cyan border + soft glow only when active.
  tile:      'border', // idle / active looks below (no hover overrides on the active tile)
};

// Active (pressed / selected) look. The tile gets the brand's cyan frame.
const ACTIVE = 'text-specter-primary-neon bg-specter-primary-cyan/15';
const ACTIVE_TILE = 'border-specter-brand-cyan text-specter-brand-cyan bg-specter-brand-cyan/10 shadow-[0_0_10px_rgba(0,229,255,0.35)]';
const IDLE_TILE = 'border-specter-brand-tile text-specter-text-muted bg-specter-brand-night/50 hover:border-specter-brand-tile-hover hover:text-specter-text-main hover:bg-white/5';

const SIZES = {
  sm: 'h-7 w-7',
  md: 'h-8 w-8',
};

/**
 * Square icon-only button. `label` is required: it becomes aria-label and
 * the hover tooltip.
 * variant: ghost | secondary | danger | tile (BRAND: framed bar tile)
 * size:    sm (28px) | md (32px)
 * active:  shows the pressed/selected state (sets aria-pressed)
 */
const IconButton = forwardRef(function IconButton(
  { icon, label, variant = 'ghost', size = 'md', active, type = 'button', className = '', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      aria-pressed={active === undefined ? undefined : active}
      className={cx(
        'inline-flex items-center justify-center shrink-0 rounded-ui-row transition-colors duration-150',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        focusRing,
        VARIANTS[variant] || VARIANTS.ghost,
        SIZES[size] || SIZES.md,
        variant === 'tile' ? (active ? ACTIVE_TILE : IDLE_TILE) : active && ACTIVE,
        className,
      )}
      {...props}
    >
      <span aria-hidden="true" className="inline-flex">{icon}</span>
    </button>
  );
});

export default IconButton;
