// B3 (S1): channel_audience_narrowed → re-key that channel's MLS group.
//
// The server sends the event to every member still allowed on a channel after
// its audience shrank (visibility raised, a demotion, a rank lowered/deleted,
// a kick / ban — services/identity-node/src/utils/audienceNarrowing.ts). Any
// one of them re-running the channel's reconcile (mlsSession ensureChannelGroup
// → reconcileGroupDevices against /mls/members) commits the removal, which
// advances the epoch: a new key the removed devices never get. Media keys
// re-export on that commit through onGroupStateChange, as for any commit.
//
// Several members get the event at once. Safe without coordination because the
// reconcile catches up first and recomputes its diff inside the commit queue:
// whoever commits second finds nobody left to remove (or loses the epoch race
// with a 409 and catches up). This helper only keeps that herd small:
//   - devices that don't hold the group skip it (they reconcile on next open),
//   - a random delay (0..jitterMs) spreads the members out, so usually the
//     first commit has landed before the others look,
//   - one pending run per channel (a burst of events coalesces).

export const NARROWING_JITTER_MS = 2000;

/**
 * → onNarrowed(payload, userId): schedules one reconcile for payload.channelId,
 * returns true when it did.
 *   isHeld(channelId)                  does this device hold the channel's group?
 *   reconcile(orgId, channelId, userId) the existing per-channel reconcile
 */
export function createNarrowingReconciler({
  isHeld,
  reconcile,
  jitterMs = NARROWING_JITTER_MS,
  random = Math.random,
  schedule = (fn, ms) => setTimeout(fn, ms),
}) {
  const pending = new Set();
  return function onNarrowed(payload, userId) {
    const orgId = payload?.orgId;
    const channelId = payload?.channelId;
    if (!orgId || !channelId || !userId) return false;
    if (pending.has(channelId)) return false;
    if (!isHeld(channelId)) return false;
    pending.add(channelId);
    schedule(async () => {
      pending.delete(channelId);
      try {
        await reconcile(orgId, channelId, userId);
      } catch { /* the next event / channel open reconciles again */ }
    }, Math.floor(random() * jitterMs));
    return true;
  };
}
