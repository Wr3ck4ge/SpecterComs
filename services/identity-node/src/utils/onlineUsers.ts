/**
 * Who has the app connected right now: one count per open event stream
 * (GET /events/stream). Every signed-in client holds exactly one while it's
 * running, so "has a stream" = online. In-memory, like channel presence: this
 * service runs as a single instance, and a restart drops every stream anyway
 * (clients reconnect within seconds).
 *
 * Nothing here is persisted or logged.
 */
const streams = new Map<string, number>();

export function markStreamOpen(userId: string): void {
  streams.set(userId, (streams.get(userId) ?? 0) + 1);
}

export function markStreamClosed(userId: string): void {
  const n = (streams.get(userId) ?? 0) - 1;
  if (n > 0) streams.set(userId, n);
  else streams.delete(userId);
}

export function isUserOnline(userId: string): boolean {
  return (streams.get(userId) ?? 0) > 0;
}

/** Test hook. */
export function resetOnlineUsers(): void {
  streams.clear();
}
