import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, session } from '../../api.js';
import { parseReturnParams, nextPollDelay, describeContribution } from './returnState.js';

// Landing page for Stripe Checkout's success_url / cancel_url:
//   ${BILLING_PORTAL_URL}/billing/return?org=…&contribution=…&result=success|cancel
// (portalUrls in services/identity-node/src/controllers/billingController.ts).
// Mounted as a public route in App.jsx; BILLING_PORTAL_URL=https://spectercoms.net.
//
// `result=success` only means the payer got to the end of the Stripe page. The
// pool is credited by the webhook, so when this browser has a SpecterComs
// session for the same account, the page polls
// GET /orgs/:org/billing/contributions/:cid (owner-only; 404 for anyone else)
// until the status settles. Checkout usually opens from the desktop app in a
// browser with no SpecterComs session; then the page says what to expect and
// points back to the app, whose wallet shows the authoritative status.

// Registered by the desktop installer (tauri.conf.json plugins.deep-link).
// Opening it starts SpecterComs or, via the single-instance plugin, brings the
// running app's strip forward; the path is not interpreted.
const APP_DEEP_LINK = 'specter://wallet';

const fmtUsd = (cents) => `$${(Number(cents || 0) / 100).toFixed(2)}`;

function Shell({ tone = 'muted', title, children }) {
  const toneClass = {
    ok: 'text-specter-state-success',
    warn: 'text-specter-state-warning',
    error: 'text-specter-state-error',
    info: 'text-specter-primary-cyan',
    muted: 'text-specter-text-muted',
  }[tone];
  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-8 bg-specter-bg-deep">
      <div className="max-w-md w-full rounded-2xl border border-specter-primary-dim p-6 space-y-4 bg-specter-bg-surface">
        <div className="text-center text-specter-primary-cyan font-mono text-sm font-bold tracking-[0.3em]">SPECTERCOMS</div>
        <div className={`text-center text-xs font-mono uppercase tracking-[0.25em] ${toneClass}`} role="status" aria-live="polite">
          {title}
        </div>
        {children}
      </div>
    </div>
  );
}

function BackToApp({ reference }) {
  return (
    <div className="space-y-2 pt-1 text-center">
      <a
        href={APP_DEEP_LINK}
        className="inline-block px-5 py-2 rounded text-xs font-bold tracking-wider uppercase font-mono bg-specter-primary-cyan text-specter-bg-surface hover:bg-specter-primary-neon"
      >
        Return to SpecterComs
      </a>
      <div className="text-xs text-specter-text-subtle">
        Or just close this tab. The server wallet in the app shows the up-to-date status.
      </div>
      {reference && (
        <div className="text-[11px] font-mono text-specter-text-subtle break-all">Reference: {reference}</div>
      )}
    </div>
  );
}

export default function BillingReturnPage() {
  const params = useMemo(
    () => parseReturnParams(typeof window !== 'undefined' ? window.location.search : ''),
    []
  );
  const canPoll = params.ok && params.result === 'success' && session.hasSession();

  const [contribution, setContribution] = useState(null);
  const [lookupError, setLookupError] = useState(null); // 'not_found' | 'signed_out' | 'network'
  const [timedOut, setTimedOut] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    if (!canPoll) return undefined;
    let cancelled = false;
    let attempt = 0;
    let last = null;

    const poll = async () => {
      const { data, error } = await api.getContribution(params.orgId, params.contributionId);
      if (cancelled) return;
      if (data) {
        last = data;
        setContribution(data);
        setLookupError(null);
      } else if (!session.hasSession()) {
        // The refresh token was rejected: nothing more this page can check.
        setLookupError('signed_out');
        return;
      } else if (/not found|forbidden/i.test(error || '')) {
        // Another account's contribution, or a mangled id. Don't keep asking.
        setLookupError('not_found');
        return;
      } else {
        setLookupError('network');
      }
      const delay = nextPollDelay(attempt++, last);
      if (delay == null) { setTimedOut(true); return; }
      timer.current = setTimeout(poll, delay);
    };

    poll();
    return () => { cancelled = true; clearTimeout(timer.current); };
  }, [canPoll, params]);

  // ── Bad link ────────────────────────────────────────────────────────────────
  if (!params.ok) {
    return (
      <Shell tone="warn" title={params.reason === 'missing' ? 'Nothing to show' : 'Link not recognised'}>
        <p className="text-sm text-specter-text-main text-center">
          {params.reason === 'missing'
            ? 'This page is where Stripe sends you after a server-wallet payment. There is no payment in this link.'
            : 'This payment link is incomplete or damaged, so we can\'t look up its status here.'}
        </p>
        <p className="text-xs text-specter-text-muted text-center">
          Nothing is charged by opening this page. Check the server wallet in SpecterComs for the status of any payment you made.
        </p>
        <BackToApp />
      </Shell>
    );
  }

  // ── Canceled ────────────────────────────────────────────────────────────────
  if (params.result === 'cancel') {
    return (
      <Shell title="Checkout canceled">
        <p className="text-sm text-specter-text-main text-center">
          No payment was taken. You can start again from the server wallet in SpecterComs whenever you like.
        </p>
        <BackToApp reference={params.contributionId} />
      </Shell>
    );
  }

  // ── Success redirect, but this browser can't confirm it ────────────────────
  if (!canPoll || lookupError === 'signed_out' || lookupError === 'not_found') {
    return (
      <Shell tone="info" title="Payment submitted">
        <p className="text-sm text-specter-text-main text-center">
          Thanks. Stripe has your payment. The server wallet is credited once Stripe confirms it:
          usually within a minute for cards, and after 3 to 5 business days for bank transfers (ACH).
        </p>
        {lookupError === 'not_found' && (
          <p className="text-xs text-specter-text-muted text-center">
            This browser is signed in to a different SpecterComs account, so the status can't be shown here.
          </p>
        )}
        <BackToApp reference={params.contributionId} />
      </Shell>
    );
  }

  // ── Live status ─────────────────────────────────────────────────────────────
  const view = describeContribution(contribution, { timedOut });
  const amount = contribution ? fmtUsd(contribution.amount_cents) : null;
  const charged = contribution && Number(contribution.charge_cents) > Number(contribution.amount_cents)
    ? fmtUsd(contribution.charge_cents) : null;

  const content = {
    confirming: {
      tone: 'info', title: 'Confirming payment…',
      body: 'Waiting for Stripe to confirm the payment. This usually takes a few seconds.',
    },
    slow: {
      tone: 'warn', title: 'Still confirming',
      body: 'Stripe hasn\'t confirmed this payment yet. If Stripe showed it as successful, the wallet will update as soon as the confirmation arrives. If it hasn\'t after an hour, contact your server admin with the reference below.',
    },
    processing: {
      tone: 'info', title: 'Bank transfer processing',
      body: `Your bank payment${amount ? ` of ${amount}` : ''} has been submitted. Bank transfers (ACH) take 3 to 5 business days to clear. The server wallet is credited when it does; you don't need to keep this page open.`,
    },
    confirmed: {
      tone: 'ok', title: 'Payment confirmed',
      body: `${amount} has been added to the server wallet.${charged ? ` You were charged ${charged} including the card processing fee.` : ''}`,
    },
    refunded: {
      tone: 'muted', title: 'Refunded',
      body: 'This payment has been refunded.',
    },
    failed: {
      tone: 'error', title: 'Payment failed',
      body: 'The payment didn\'t go through, and the wallet was not credited. You can try again from the server wallet in SpecterComs.',
    },
    canceled: {
      tone: 'muted', title: 'Checkout closed',
      body: 'This checkout was closed without a payment. You can start a new one from the server wallet in SpecterComs.',
    },
  }[view.kind];

  return (
    <Shell tone={content.tone} title={content.title}>
      <p className="text-sm text-specter-text-main text-center">{content.body}</p>
      {view.disputed && (
        <p className="text-xs text-specter-state-warning text-center">This payment is under dispute with the card issuer.</p>
      )}
      {view.message && view.kind !== 'confirmed' && (
        <p className="text-xs text-specter-text-muted text-center">Last message from the payment processor: {view.message}</p>
      )}
      {lookupError === 'network' && (
        <p className="text-xs text-specter-text-muted text-center">Couldn't reach SpecterComs to check. Retrying…</p>
      )}
      <BackToApp reference={params.contributionId} />
    </Shell>
  );
}
