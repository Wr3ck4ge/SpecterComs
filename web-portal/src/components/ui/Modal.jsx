import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import IconButton from './IconButton';
import { cx } from './styles';

const SIZES = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-2xl',
};

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Dialog rendered into document.body.
 * open / onClose: controlled visibility. Escape, the close button and (unless
 *   dismissOnBackdrop is false) a backdrop click all call onClose.
 * title: heading text, also the dialog's accessible name.
 * footer: optional action row, right-aligned (e.g. Cancel / Confirm buttons).
 * size: sm | md | lg
 * initialFocusRef: element to focus on open; otherwise the first focusable
 *   element in the body, then the dialog itself.
 * Focus is trapped while open and returned to the previous element on close.
 */
export default function Modal({
  open, onClose, title, footer, size = 'md', dismissOnBackdrop = true, initialFocusRef, className = '', children,
}) {
  const titleId = useId();
  const dialogRef = useRef(null);
  const bodyRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement;
    const target =
      initialFocusRef?.current ||
      bodyRef.current?.querySelector(FOCUSABLE) ||
      dialogRef.current;
    target?.focus();
    return () => {
      if (previous && typeof previous.focus === 'function' && document.contains(previous)) previous.focus();
    };
    // Only on open/close — re-running on every render would steal focus while typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      // Keep window-level Escape handlers (e.g. WarRoom's) from also acting.
      e.stopPropagation();
      onClose?.();
      return;
    }
    if (e.key !== 'Tab') return;
    const nodes = Array.from(dialogRef.current?.querySelectorAll(FOCUSABLE) || []);
    if (nodes.length === 0) {
      e.preventDefault();
      return;
    }
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === dialogRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-specter-bg-deep/70 backdrop-blur-sm"
      // mousedown, not click, so a text drag that ends on the backdrop doesn't close it.
      onMouseDown={(e) => { if (dismissOnBackdrop && e.target === e.currentTarget) onClose?.(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={cx(
          'w-full flex flex-col max-h-[calc(100vh-2rem)] rounded-ui-lg font-ui text-specter-text-main focus:outline-none',
          'bg-specter-bg-surface/95 backdrop-blur-xl border border-specter-border-strong shadow-[0_20px_50px_rgba(0,0,0,0.6)]',
          SIZES[size] || SIZES.md,
          className,
        )}
      >
        <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-3">
          <h2 id={titleId} className="text-ui-lg font-semibold truncate">{title}</h2>
          <IconButton icon={<X size={16} />} label="Close" size="sm" onClick={onClose} />
        </div>
        <div ref={bodyRef} className="px-5 pb-5 overflow-y-auto text-ui-base">
          {children}
        </div>
        {footer && (
          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-specter-border-divider">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
