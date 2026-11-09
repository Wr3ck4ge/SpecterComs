import { Lock } from 'lucide-react';
import { cx, focusRing } from '../ui/styles';

// Shared pieces for the signed-out screens (login, register, recovery,
// unsupported browser) and the startup splash.

const LOGO_SRC = '/android-chrome-192x192.png';

/**
 * SpecterComs logo + wordmark.
 * size: lg (full auth screens, splash) | sm (compact strip header)
 */
export function BrandMark({ size = 'lg', tagline = 'Secure voice and text', className = '' }) {
  if (size === 'sm') {
    return (
      <div className={cx('flex items-center gap-2.5 font-ui', className)}>
        <img src={LOGO_SRC} alt="" aria-hidden="true" className="h-8 w-8 rounded-ui-sm border border-specter-border" />
        <div className="min-w-0 leading-tight">
          <div className="text-ui-base font-semibold text-specter-text-main">SpecterComs</div>
          {tagline && <div className="text-ui-xs text-specter-text-subtle">{tagline}</div>}
        </div>
      </div>
    );
  }
  return (
    <div className={cx('flex flex-col items-center gap-3 text-center font-ui', className)}>
      <img
        src={LOGO_SRC}
        alt=""
        aria-hidden="true"
        className="h-20 w-20 rounded-ui-lg border border-specter-border-strong shadow-[0_0_28px_rgba(6,182,212,0.22)]"
      />
      <div className="space-y-0.5">
        <h1 className="text-[26px] leading-8 font-semibold tracking-[0.04em] text-specter-text-main">
          Specter<span className="text-specter-primary-neon">Coms</span>
        </h1>
        {tagline && <p className="text-ui-sm text-specter-text-subtle">{tagline}</p>}
      </div>
    </div>
  );
}

/** Small "Zero-trust · end-to-end encrypted" line under the auth panel. */
export function TrustNote({ className = '' }) {
  return (
    <p className={cx('flex items-center justify-center gap-1.5 font-ui text-ui-xs text-specter-text-subtle', className)}>
      <Lock size={12} aria-hidden="true" />
      Zero-trust. End-to-end encrypted.
    </p>
  );
}

/** Inline text button used for "Forgot password?", "Create account", etc. */
export function TextLink({ children, className = '', ...props }) {
  return (
    <button
      type="button"
      className={cx(
        'rounded-ui-sm font-ui text-ui-sm text-specter-primary-neon hover:text-specter-text-main hover:underline underline-offset-4',
        'transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
        focusRing,
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

/**
 * Full-window signed-out layout: holo background, centred column with the
 * brand on top and the trust note underneath. `width` caps the column.
 */
export default function AuthLayout({ children, width = 'max-w-[380px]', showBrand = true, showTrustNote = true }) {
  return (
    <main className="holo-viewport min-h-screen flex items-center justify-center px-4 pt-12 pb-10 font-ui text-specter-text-main bg-grid-pattern bg-[size:40px_40px]">
      <div className={cx('w-full space-y-6', width)}>
        {showBrand && <BrandMark />}
        {children}
        {showTrustNote && <TrustNote />}
      </div>
    </main>
  );
}
