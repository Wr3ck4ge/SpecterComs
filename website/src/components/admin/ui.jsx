import React, { useState } from 'react';

// ─── Design primitives (shared by every admin section) ────────────────────────

export const RBtn = ({ children, onClick, variant = 'default', disabled = false, small = false, type = 'button', title }) => {
  const pad  = small ? 'px-2 py-0.5 text-xs' : 'px-3 py-1.5 text-xs';
  const vars = {
    default: 'border border-gray-300 bg-white text-gray-700 hover:bg-gray-100',
    danger:  'border border-red-300 bg-red-50 text-red-700 hover:bg-red-100',
    success: 'border border-green-300 bg-green-50 text-green-700 hover:bg-green-100',
    ghost:   'text-gray-500 hover:text-gray-800',
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`${pad} rounded font-medium tracking-wide transition-colors ${vars[variant]} ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      {children}
    </button>
  );
};

export const StatCard = ({ label, value, sub }) => (
  <div className="border border-gray-200 bg-white rounded-lg p-4 shadow-sm space-y-1">
    <div className="text-xs uppercase tracking-widest text-gray-500 font-medium">{label}</div>
    <div className="text-4xl font-bold text-gray-800">{value ?? '—'}</div>
    {sub && <div className="text-xs text-gray-400">{sub}</div>}
  </div>
);

/**
 * cols: array of strings or { key, label, sortable } objects. When `sort`/
 * `onSort` are given, sortable headers toggle server-side sorting.
 */
export const Table = ({ cols, children, empty = 'No records.', loading = false, error = null, sort, dir, onSort }) => {
  const normCols = cols.map((c) => (typeof c === 'string' ? { key: c, label: c } : c));
  const count = React.Children.toArray(children).length;
  const stateRow = (text, cls = 'text-gray-400') => (
    <tr><td colSpan={normCols.length} className={`px-4 py-6 text-center text-sm ${cls}`}>{text}</td></tr>
  );
  return (
    // Scrolls horizontally on narrow screens instead of squashing columns or
    // breaking the page-level layout.
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm min-w-[640px]">
        <thead>
          <tr className="border-b border-gray-200 text-gray-500 text-xs uppercase tracking-wider">
            {normCols.map((c) => (
              <th key={c.key} className="px-4 py-3 font-medium whitespace-nowrap">
                {c.sortable && onSort ? (
                  <button
                    type="button"
                    className="uppercase tracking-wider hover:text-gray-800"
                    onClick={() => onSort(c.key, sort === c.key && dir === 'desc' ? 'asc' : 'desc')}
                  >
                    {c.label}{sort === c.key ? (dir === 'asc' ? ' ▲' : ' ▼') : ''}
                  </button>
                ) : c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? stateRow('Loading…')
            : error ? stateRow(`Could not load: ${error}`, 'text-red-600')
            : count === 0 ? stateRow(empty)
            : children}
        </tbody>
      </table>
    </div>
  );
};

export const SearchBar = ({ value, onChange, placeholder = 'Search...', className = 'w-64' }) => (
  <input
    className={`bg-white border border-gray-300 rounded focus:border-gray-500 focus:outline-none px-3 py-1.5 text-gray-800 text-sm placeholder-gray-400 ${className}`}
    value={value}
    maxLength={64}
    onChange={(e) => onChange(e.target.value)}
    placeholder={placeholder}
  />
);

export const Alert = ({ children, onDismiss, type = 'error' }) => {
  const styles = type === 'error'
    ? 'bg-red-50 border-red-300 text-red-700'
    : type === 'warn'
      ? 'bg-amber-50 border-amber-300 text-amber-800'
      : 'bg-green-50 border-green-300 text-green-700';
  return (
    <div className={`border rounded px-4 py-2 text-sm flex items-center justify-between ${styles}`}>
      <span>{children}</span>
      {onDismiss && <button onClick={onDismiss} className="ml-4 opacity-60 hover:opacity-100">&times;</button>}
    </div>
  );
};

export const Pagination = ({ page, limit, total, onPage }) => {
  const totalPages = Math.max(1, Math.ceil((total || 0) / (limit || 50)));
  if (!total || totalPages <= 1) return null;
  return (
    <div className="flex items-center gap-3 text-sm text-gray-500">
      <RBtn small disabled={page <= 1} onClick={() => onPage(page - 1)}>← Prev</RBtn>
      <span>Page {page} of {totalPages.toLocaleString()}</span>
      <RBtn small disabled={page >= totalPages} onClick={() => onPage(page + 1)}>Next →</RBtn>
    </div>
  );
};

export const Modal = ({ title, children, onClose, wide = false }) => (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
    <div
      className={`border border-gray-200 bg-white rounded-lg shadow-xl w-full ${wide ? 'max-w-2xl' : 'max-w-md'} max-h-[90vh] overflow-y-auto p-6 space-y-4`}
      onClick={(e) => e.stopPropagation()}
      role="dialog"
      aria-modal="true"
    >
      <div className="flex justify-between items-center border-b border-gray-200 pb-3">
        <span className="font-semibold text-gray-800">{title}</span>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none" aria-label="Close">&times;</button>
      </div>
      {children}
    </div>
  </div>
);

export const Field = ({ label, children, hint }) => (
  <div>
    <label className="text-xs text-gray-500 uppercase tracking-wider block mb-1">{label}</label>
    {children}
    {hint && <div className="text-xs text-gray-400 mt-1">{hint}</div>}
  </div>
);

export const TextInput = (props) => (
  <input
    {...props}
    className="w-full bg-white border border-gray-300 rounded focus:border-gray-500 focus:outline-none p-2 text-gray-800 text-sm"
  />
);

export const Badge = ({ children, tone = 'gray' }) => {
  const tones = {
    gray:  'bg-gray-100 text-gray-600',
    red:   'bg-red-100 text-red-700',
    green: 'bg-green-100 text-green-700',
    amber: 'bg-amber-100 text-amber-800',
    blue:  'bg-blue-100 text-blue-700',
  };
  return <span className={`px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap ${tones[tone] || tones.gray}`}>{children}</span>;
};

// ─── Formatting (null-safe, timezone explicit) ────────────────────────────────

const parse = (ts) => {
  if (!ts) return null;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Local time with the zone name; full UTC ISO on hover via `title`.
 * Explicit fields, not dateStyle/timeStyle: Intl throws a TypeError when
 * those are combined with timeZoneName, which crashed every section with a
 * timestamp row.
 */
export const fmtDateTime = (ts) => {
  const d = parse(ts);
  return d ? d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }) : '—';
};

export const fmtDate = (ts) => {
  const d = parse(ts);
  return d ? d.toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—';
};

export const Time = ({ ts, dateOnly = false }) => {
  const d = parse(ts);
  if (!d) return <span>—</span>;
  return <time dateTime={d.toISOString()} title={`${d.toISOString()} (UTC)`}>{dateOnly ? fmtDate(ts) : fmtDateTime(ts)}</time>;
};

export const ROLE_RANK = { viewer: 1, operator: 2, owner: 3 };
export const can = (role, required) => (ROLE_RANK[role] || 0) >= ROLE_RANK[required];

/** Debounced text state for server-side search boxes. */
export function useDebounced(value, ms = 400) {
  const [v, setV] = useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export class SectionBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error) {
    // No props/state in the log — they can contain personal data.
    console.error('[admin] section crashed:', error?.message);
  }
  render() {
    if (this.state.error) {
      return (
        <Alert>
          This section failed to render. <button className="underline ml-2" onClick={() => this.setState({ error: null })}>Retry</button>
        </Alert>
      );
    }
    return this.props.children;
  }
}
