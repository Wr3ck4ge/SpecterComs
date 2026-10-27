// useEventStream.js — SSE hook for real-time state updates from identity-node
import { useEffect, useRef, useCallback } from 'react';
import { API_BASE_URL } from './apiBase.js';
import { getToken, refreshAfterUnauthorized } from './auth/tokenStore.js';

/**
 * Opens a persistent SSE connection to /events/stream and dispatches
 * incoming NATS-backed events to the provided handler map.
 *
 * Usage:
 *   useEventStream({
 *     channel_created:  (payload) => refreshChannels(),
 *     member_joined:    (payload) => refreshMembers(),
 *     orgs_changed:     ()        => refetchOrgs(),
 *   });
 *
 * Automatically reconnects on drop with exponential back-off (max 30 s).
 *
 * options.enabled (default true): while false no connection is held; flipping
 * it connects/disconnects (the tray strip only listens while it's on screen).
 */
export default function useEventStream(handlers, { enabled = true } = {}) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!enabled) return undefined;
    let es;
    let retryDelay = 1000;         // start at 1 s
    let cancelled = false;

    const connect = async () => {
      if (cancelled) return;

      // Ask fresh on every attempt, not once at mount — the access token is
      // only ~30 min-lived (identity-node's authController.ts
      // ACCESS_TOKEN_TTL), and auth/tokenStore.js (Rust on desktop) hands
      // back a refreshed one when it's near expiry. Missing entirely is
      // treated as transient too: it can briefly be true while App.jsx's
      // launch restore is still in flight, and retrying picks it up as soon
      // as it lands instead of this hook giving up for the rest of the mount.
      const token = await getToken().catch(() => null);
      if (!token) {
        if (cancelled) return;
        setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30_000);
        return;
      }

      // EventSource cannot send custom headers, so we first mint a short-lived
      // purpose-bound SSE ticket over an authenticated header-based request.
      let sseTicket = null;
      try {
        const resp = await fetch(`${API_BASE_URL}/events/ticket`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });

        const json = await resp.json().catch(() => ({}));
        if (!resp.ok || !json.ticket) {
          if (resp.status === 401) {
            // This specific token is dead. Ask for one shared refresh (a
            // dead refresh token logs every window out via auth-changed) —
            // but keep retrying here too (fall through to the catch's
            // backoff-retry below) rather than giving up for good; the next
            // attempt's getToken() returns the refreshed token.
            await refreshAfterUnauthorized(token).catch(() => null);
          }
          throw new Error(json.message || `SSE ticket request failed (${resp.status})`);
        }

        sseTicket = json.ticket;
      } catch {
        if (cancelled) return;
        setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30_000);
        return;
      }

      // Torn down while the ticket was in flight: don't open a stream nobody
      // will close.
      if (cancelled) return;
      es = new EventSource(`${API_BASE_URL}/events/stream?token=${encodeURIComponent(sseTicket)}`);

      es.onopen = () => {
        retryDelay = 1000;         // reset back-off on successful connect
      };

      es.onmessage = (evt) => {
        try {
          const payload = JSON.parse(evt.data);
          const handler = handlersRef.current[payload.type];
          if (handler) handler(payload);
        } catch { /* ignore malformed */ }
      };

      es.onerror = () => {
        es.close();
        if (cancelled) return;
        // Exponential back-off capped at 30 s
        setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30_000);
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (es) es.close();
    };
  }, [enabled]);    // once per enable — handlers are accessed via ref
}
