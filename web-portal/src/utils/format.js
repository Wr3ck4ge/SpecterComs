// Shared formatting helpers for billing/usage displays (WarRoom sidebar bars,
// BillingPanel's usage tab). Kept here since both consume identical logic.

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
