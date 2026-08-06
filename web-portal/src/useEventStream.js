// useEventStream.js — SSE hook for real-time state updates from identity-node
import { useEffect, useRef, useCallback } from 'react';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8082';

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
 */
export default function useEventStream(handlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    let es;
    let retryDelay = 1000;         // start at 1 s
    let cancelled = false;

    const connect = async () => {
      if (cancelled) return;

      // Read fresh on every attempt, not once at mount — this token is only
      // ~30 min-lived (see identity-node's authController.ts ACCESS_TOKEN_TTL),
      // so a connection that drops after that needs the *current* localStorage
      // value on reconnect, not whatever was true when this effect first ran.
      // Missing entirely (not just stale) is treated as transient too: this
      // can briefly be true while App.jsx's launch/silent-refresh flow is
      // still in flight, and retrying picks it up as soon as it lands instead
      // of this hook giving up for the rest of the mount.
      const token = localStorage.getItem('specter_token');
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
            // This specific token is dead. Clear it and let App.jsx's
            // specter:auth-expired handler silently refresh in the
            // background — but keep retrying here too (fall through to the
            // catch's backoff-retry below) rather than giving up for good;
            // by the next attempt localStorage likely has a fresh token from
            // that refresh.
            localStorage.removeItem('specter_token');
            localStorage.removeItem('specter_user');
            window.dispatchEvent(new CustomEvent('specter:auth-expired'));
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
  }, []);    // mount once — handlers are accessed via ref
}
