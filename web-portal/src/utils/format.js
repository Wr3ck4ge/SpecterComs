// Shared formatting helpers. Billing/usage displays (WarRoom sidebar bars,
// BillingPanel's usage tab) plus the date/time formatters that used to live
// as local copies in WarRoom, OpsCalendarPanel and BillingPanel. Each one keeps
// its original output exactly — they look alike but format differently, so
// they stay as separate exports rather than one configurable helper.

export const barColor = (pct) => {
  if (pct >= 90) return { label: '#f87171', bar: 'linear-gradient(90deg, #b91c1c, #f87171)' };
  if (pct >= 70) return { label: '#fbbf24', bar: 'linear-gradient(90deg, #b45309, #fbbf24)' };
  return null;
};

export const fmtBytes = (b) =>
  b >= 1e9 ? (b / 1e9).toFixed(1) + 'GB' :
  b >= 1e6 ? (b / 1e6).toFixed(0) + 'MB' :
  b >= 1e3 ? (b / 1e3).toFixed(0) + 'KB' :
  b + 'B';

export const fmtUsd = (cents) => `$${(cents / 100).toFixed(2)}`;

// "05:30 PM" — chat message timestamps.
export const fmtTime = (ts) => {
  try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
};

// "Today" / "Yesterday" / "Oct 23" — chat day separators.
export const fmtDayLabel = (ts) => {
  try {
    const d = new Date(ts);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return 'Today';
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  } catch { return ''; }
};

// "Oct 23 · 05:30 PM" — scheduled-operation start times (date is always en-US).
export const fmtEventTime = (ts) => {
  try {
    const d = new Date(ts);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' · ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return ts;
  }
};

// "Oct 23, 05:30 PM" — billing transactions and invoices.
export const fmtDateTime = (d) => new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
