import { AlertTriangle, Download, Loader2, X } from 'lucide-react';
import { Button, IconButton } from './ui';
import { cx, glassPanel } from './ui/styles';

/**
 * Floating "update ready" notice, top-centre, above every screen (login
 * included). Presentational: App.jsx owns the updater state and the
 * install_update_and_restart call.
 *
 * version      the downloaded version
 * installing   installer is running (hides the actions)
 * error        install error text; the action becomes "Retry"
 * onInstall()  "Restart to update" / "Retry"
 * onDismiss()  hide until the next update-ready event
 * offsetTop    true when the custom title bar (28px) is showing
 */
export default function UpdateBanner({ version, installing = false, error = null, onInstall, onDismiss, offsetTop = false }) {
  let icon = <Download size={16} aria-hidden="true" className="text-specter-primary-neon shrink-0" />;
  let message = <>Update ready <span className="text-specter-text-subtle">— v{version}</span></>;
  if (installing) {
    icon = <Loader2 size={16} aria-hidden="true" className="text-specter-primary-neon shrink-0 animate-spin" />;
    message = <>Installing update v{version}…</>;
  } else if (error) {
    icon = <AlertTriangle size={16} aria-hidden="true" className="text-amber-300 shrink-0" />;
    message = <>Update failed <span className="text-specter-text-subtle">— {error}</span></>;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className={cx(
        'fixed left-1/2 -translate-x-1/2 z-[9998] w-max max-w-[calc(100vw-24px)]',
        offsetTop ? 'top-9' : 'top-2',
        'flex items-center gap-3 pl-3 pr-1.5 py-1.5 rounded-ui-md font-ui text-ui-sm text-specter-text-main',
        glassPanel,
        error && '!border-specter-state-warning/50',
      )}
    >
      {icon}
      <span className="min-w-0 truncate">{message}</span>
      {!installing && (
        <div className="flex items-center gap-1 shrink-0">
          <Button size="sm" onClick={onInstall}>{error ? 'Retry' : 'Restart to update'}</Button>
          <IconButton size="sm" icon={<X size={14} />} label="Dismiss" onClick={onDismiss} />
        </div>
      )}
    </div>
  );
}
