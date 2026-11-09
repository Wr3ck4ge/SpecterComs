// Member-facing text for billing API failures (BillingPanel). The shared API
// client (packages/shared-web/src/api.js) hands back only the server's message
// string, not the HTTP status, so this matches the messages billingController.ts
// actually sends:
//   503 'Payments are not enabled on this server'  — PAYMENTS_PROVIDER unset /
//        half-configured, OR the org is outside BILLING_BETA_ORGS (same answer)
//   403 'Forbidden'                                — not a member of the org
//   429 'Too many unfinished payments — …'         — maxPendingPerUserPerHour
//   409 'A payment for this invoice is already in progress — …'
//   404 'Invoice not found or already paid' / 'Organization not found'
//   400 amount / method validation (validateContributionAmount)
//   500 'Internal server error'                    — e.g. Stripe rejected the session
// 402 is never returned by the billing endpoints (only by a tier change in
// org settings), but is mapped in case one is added.
// Anything unrecognised passes through unchanged.

export function billingErrorMessage(raw) {
  const msg = String(raw || '').trim();
  if (!msg) return 'Payment could not be started. Please try again.';
  if (/payments are not enabled/i.test(msg)) {
    return "Funding isn't open for this server yet. Nothing was charged.";
  }
  if (/^forbidden$/i.test(msg) || /^HTTP 403/i.test(msg)) {
    return "You can't fund this server: you're not a member of it any more. Nothing was charged.";
  }
  if (/too many unfinished payments/i.test(msg) || /^HTTP 429/i.test(msg)) {
    return 'You have several unfinished checkouts. Finish one in your browser, or wait an hour and try again.';
  }
  if (/^HTTP 402/i.test(msg)) {
    return 'The server wallet needs more funds for that.';
  }
  if (/internal server error|^HTTP 5\d\d/i.test(msg)) {
    return "The server couldn't start a checkout. Nothing was charged. Try again in a minute; if it keeps failing, tell an admin.";
  }
  if (/failed to fetch|network error|networkerror/i.test(msg)) {
    return "Couldn't reach SpecterComs. Check your connection and try again.";
  }
  if (/must be at least (\d+)/i.test(msg)) {
    const cents = Number(msg.match(/at least (\d+)/i)[1]);
    return /card payments/i.test(msg)
      ? `Card payments start at $${(cents / 100).toFixed(2)}. Use a bank transfer for smaller amounts.`
      : `The minimum is $${(cents / 100).toFixed(2)}.`;
  }
  if (/must be at most (\d+)/i.test(msg)) {
    const cents = Number(msg.match(/at most (\d+)/i)[1]);
    return `The maximum is $${(cents / 100).toFixed(2)} per payment.`;
  }
  return msg;
}
