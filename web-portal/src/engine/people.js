// The strip's per-member action menu (send message, add friend, mute for me,
// volume) — the pure parts the engine and the strip share.
//
// Friend state comes from GET /friends (identity-node friendController
// getFriends): one row per friendship the user is part of,
//   { id: <the OTHER user's id>, callsign, global_tag, status: 0 | 1,
//     initiated_by: <user id>, created_at }
// status 1 = accepted; status 0 = pending, sent by `initiated_by`. (The old
// WarRoom UI read `user_id` off these rows; they carry `id`. Both are accepted
// here.) DMs are only relayed between accepted friends (dmController's
// friendship gate), so "Send message" needs FRIEND.FRIENDS.

export const FRIEND = Object.freeze({
  NONE: 'none',
  FRIENDS: 'friends',
  OUTGOING: 'outgoing', // I sent a request, they haven't answered
  INCOMING: 'incoming', // they sent me one: I can accept
});

const friendRowUserId = (f) => f?.id ?? f?.user_id ?? null;

/** /friends rows → { [userId]: FRIEND.* } (only known relationships). */
export function friendStatesById(friends = [], myUserId = null) {
  const out = {};
  for (const f of friends || []) {
    const uid = friendRowUserId(f);
    if (!uid || uid === myUserId) continue;
    if (Number(f.status) === 1) out[uid] = FRIEND.FRIENDS;
    else if (myUserId && f.initiated_by === myUserId) out[uid] = FRIEND.OUTGOING;
    else out[uid] = FRIEND.INCOMING;
  }
  return out;
}

/** The menu's friend row: label, whether it's actionable and what it does. */
export function friendAction(state) {
  switch (state) {
    case FRIEND.FRIENDS: return { label: 'Friends', action: null };
    case FRIEND.OUTGOING: return { label: 'Friend request sent', action: null };
    case FRIEND.INCOMING: return { label: 'Accept friend request', action: 'accept' };
    default: return { label: 'Add friend', action: 'request' };
  }
}

/**
 * Engine side: EngineState.people — one entry per OTHER member of my voice
 * channel, keyed by callsign (what the roster carries):
 *   { [callsign]: { userId: string | null, friend: FRIEND.*, localMuted, volume } }
 * userId is null when the callsign can't be resolved to a member of the
 * selected server (e.g. a cascaded priority speaker from elsewhere): the menu
 * then offers nothing that needs one.
 */
export function buildPeople({
  roster = [], myCallsign = null, members = [], friendStates = {}, localMuted = new Set(), volumes = {},
} = {}) {
  const byCallsign = new Map();
  for (const m of members || []) {
    const cs = m?.callsign || m?.username;
    if (cs && m.user_id && !byCallsign.has(cs)) byCallsign.set(cs, m.user_id);
  }
  const out = {};
  for (const cs of roster || []) {
    if (!cs || cs === myCallsign) continue;
    const userId = byCallsign.get(cs) ?? null;
    out[cs] = {
      userId,
      friend: (userId && friendStates[userId]) || FRIEND.NONE,
      localMuted: Boolean(userId && localMuted.has(userId)),
      volume: userId && volumes[userId] != null ? volumes[userId] : 1,
    };
  }
  return out;
}

/** "150%" — the row badge when a user's volume isn't 100 %. */
export const fmtVolumePct = (v) => `${Math.round((Number(v) || 0) * 100)}%`;
