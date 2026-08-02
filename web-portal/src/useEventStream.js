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
    const token = localStorage.getItem('specter_token');
    if (!token) return;            // not logged in — nothing to subscribe to

    let es;
    let retryDelay = 1000;         // start at 1 s
    let cancelled = false;

    const connect = () => {
      if (cancelled) return;

      // EventSource doesn't support custom headers, so pass token as query param.
      // The SSE endpoint must accept ?token= as an alternative to the Authorization header.
      es = new EventSource(`${API_BASE_URL}/events/stream?token=${encodeURIComponent(token)}`);

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
