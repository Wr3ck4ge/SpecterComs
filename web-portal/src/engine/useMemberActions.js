import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { getDmMessages } from '../messageStore';
import { CMD, EV, STRIP_WINDOW, bridgeEmit, buildChatRows } from './bridge';
import { buildPeople, friendStatesById } from './people';
import { clampUserVolume, loadUserVolumes, saveUserVolumes, withUserVolume } from './userVolume';
import { dmConversationWith, onDmReceived, requestDmCatchUp, sendDm, subscribeChatRows } from './useChannelChat';
import {
  OVERLAY_DM_EVENT, OVERLAY_DM_REPLY_EVENT, OVERLAY_DM_REPLY_RESULT_EVENT, OVERLAY_WINDOW, OVERLAY_DMS_KEY,
  loadOverlayDmsEnabled, saveOverlayDmsEnabled, toastFromDm,
} from './overlayDm';

// PM: the engine side of the strip's per-member menu and the overlay's DM
// toasts. Mounted once by WarRoom, which hands it the state it already owns
// (members, friends, local mutes) and spreads `handlers` into the bridge.
//
//   const pm = useMemberActions({ user, members, voiceRoster, inVoice,
//     localMutedUsers, setLocalMutedUsers, friends, setFriends, isOverlay });
//   pm.people / pm.prefs   → buildEngineState({ people, prefs })
//   pm.userVolumes         → CommLink's userVolumes (per-user voice volume)
//   pm.handlers            → useEngineBridgeHost handlers
//
// DMs reuse the chat engine (engine/useChannelChat.js): it already receives,
// decrypts (MLS) and stores every DM; this only subscribes the strip's pane to
// one conversation's rows and sends through useChannelChat.sendDm.

const emitTo = (target, event, payload) => import('@tauri-apps/api/event')
  .then((mod) => (typeof mod.emitTo === 'function' ? mod.emitTo(target, event, payload) : mod.emit(event, payload)))
  .catch((err) => console.warn(`[pm] emit ${event} failed:`, err));

const friendUserId = (f) => f?.id ?? f?.user_id ?? null;

export default function useMemberActions({
  user, members = [], voiceRoster = [], inVoice = false,
  localMutedUsers, setLocalMutedUsers, friends = [], setFriends, isOverlay = false,
}) {
  const myId = user?.id ?? null;
  const myCallsign = user?.callsign || user?.username || null;

  // ── Per-user voice volume (persisted; CommLink applies it per lane) ─────
  const [userVolumes, setUserVolumes] = useState(() => loadUserVolumes());
  useEffect(() => { saveUserVolumes(userVolumes); }, [userVolumes]);

  // ── "Show DMs in overlay" ───────────────────────────────────────────────
  const [overlayDms, setOverlayDms] = useState(() => loadOverlayDmsEnabled());
  useEffect(() => { saveOverlayDmsEnabled(overlayDms); }, [overlayDms]);
  // Also follows a write to the key from elsewhere in this window (e.g. the
  // settings bridge, which dispatches `storage` events), so either way of
  // wiring the Settings toggle works.
  useEffect(() => {
    const onStorage = (e) => { if (!e.key || e.key === OVERLAY_DMS_KEY) setOverlayDms(loadOverlayDmsEnabled()); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const friendStates = useMemo(() => friendStatesById(friends, myId), [friends, myId]);
  const people = useMemo(() => (inVoice ? buildPeople({
    roster: voiceRoster, myCallsign, members, friendStates, localMuted: localMutedUsers || new Set(), volumes: userVolumes,
  }) : {}), [inVoice, voiceRoster, myCallsign, members, friendStates, localMutedUsers, userVolumes]);

  const refreshFriends = async () => {
    const { data, error } = await api.getFriends();
    if (error) throw new Error(typeof error === 'string' ? error : 'Could not load friends');
    setFriends?.(data?.friends || []);
  };

  // Who a user id is, for headers/toasts.
  const callsignOf = (uid) => {
    const m = members.find((x) => x.user_id === uid);
    if (m) return m.callsign || m.username || null;
    const f = friends.find((x) => friendUserId(x) === uid);
    return f?.callsign || null;
  };
  const callsignOfRef = useRef(callsignOf);
  callsignOfRef.current = callsignOf;

  // ── Strip DM pane subscription (dm.select) ──────────────────────────────
  const [dmPartner, setDmPartner] = useState(null);
  const [dmSeq, setDmSeq] = useState(0);
  useEffect(() => {
    if (!dmPartner || !myId) return undefined;
    const convId = dmConversationWith(dmPartner);
    if (!convId) return undefined;
    let cancelled = false;
    let timer = null;
    const callsign = callsignOfRef.current(dmPartner);
    const publish = (rows, loading) => bridgeEmit(STRIP_WINDOW, EV.DM, {
      userId: dmPartner, callsign, loading,
      rows: buildChatRows(rows, { userId: myId }),
    }).catch((err) => console.warn('[bridge] engine-dm emit failed:', err));
    const load = () => {
      getDmMessages(convId, 200).then((rows) => { if (!cancelled) publish(rows || [], false); })
        .catch(() => { if (!cancelled) publish([], false); });
    };
    publish([], true);
    load();
    requestDmCatchUp(dmPartner).catch(() => {});
    const unsubscribe = subscribeChatRows(convId, () => {
      if (timer) return;
      timer = setTimeout(() => { timer = null; load(); }, 30);
    });
    return () => { cancelled = true; if (timer) clearTimeout(timer); unsubscribe(); };
  }, [dmPartner, dmSeq, myId]);

  // ── Overlay DM toasts + inline replies ──────────────────────────────────
  const overlayOnRef = useRef(false);
  overlayOnRef.current = Boolean(isOverlay && overlayDms);
  useEffect(() => onDmReceived((note) => {
    // The Settings toggle is written into this window's localStorage by the
    // settings bridge, and a 'storage' event never fires in the writing
    // window, so read the stored value at delivery time, not just the state.
    if (!overlayOnRef.current || !loadOverlayDmsEnabled()) return;
    const toast = toastFromDm({ ...note, callsign: note.callsign || callsignOfRef.current(note.partnerId) });
    if (toast) emitTo(OVERLAY_WINDOW, OVERLAY_DM_EVENT, { toast });
  }), []);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.__TAURI_INTERNALS__) return undefined;
    let unlisten = null;
    let stopped = false;
    import('@tauri-apps/api/event').then(({ listen }) => listen(OVERLAY_DM_REPLY_EVENT, (e) => {
      const { requestId, userId, text } = e.payload || {};
      const answer = (ok, error) => emitTo(OVERLAY_WINDOW, OVERLAY_DM_REPLY_RESULT_EVENT, { requestId, ok, error: error || null });
      if (!userId || typeof text !== 'string' || !text.trim()) { answer(false, 'Nothing to send'); return; }
      // Same E2E path as the strip's DM pane.
      sendDm(userId, text).then(() => answer(true), (err) => answer(false, err?.message || 'Send failed'));
    })).then((fn) => { if (stopped) fn(); else unlisten = fn; }).catch(() => {});
    return () => { stopped = true; if (unlisten) unlisten(); };
  }, []);

  const requireOther = (userId) => {
    if (!userId || typeof userId !== 'string') throw new Error('Unknown member');
    if (userId === myId) throw new Error("That's you");
  };

  const handlers = {
    [CMD.MEMBER_SET_LOCAL_MUTE]: ({ userId, muted }) => {
      requireOther(userId);
      setLocalMutedUsers((prev) => {
        if (prev.has(userId) === Boolean(muted)) return prev;
        const next = new Set(prev);
        if (muted) next.add(userId); else next.delete(userId);
        return next;
      });
    },
    [CMD.MEMBER_SET_VOLUME]: ({ userId, volume }) => {
      requireOther(userId);
      const n = Number(volume);
      if (!Number.isFinite(n)) throw new Error('Invalid volume');
      setUserVolumes((prev) => withUserVolume(prev, userId, clampUserVolume(n)));
    },
    [CMD.FRIEND_REQUEST]: async ({ userId }) => {
      requireOther(userId);
      if (friendStates[userId] === 'friends' || friendStates[userId] === 'outgoing') return;
      const { error } = await api.sendFriendRequest(userId);
      if (error) throw new Error(typeof error === 'string' ? error : 'Friend request failed');
      await refreshFriends().catch(() => {});
    },
    [CMD.FRIEND_ACCEPT]: async ({ userId }) => {
      requireOther(userId);
      if (friendStates[userId] === 'friends') return;
      const { error } = await api.acceptFriendRequest(userId);
      if (error) throw new Error(typeof error === 'string' ? error : 'Could not accept the request');
      await refreshFriends().catch(() => {});
    },
    [CMD.FRIENDS_REFRESH]: () => refreshFriends(),
    [CMD.DM_SELECT]: ({ userId }) => {
      if (!userId) { setDmPartner(null); return; }
      requireOther(userId);
      setDmPartner(userId);
      setDmSeq((n) => n + 1); // re-send rows even if it was already selected
    },
    [CMD.DM_SEND]: async ({ userId, text }) => {
      requireOther(userId);
      if (friendStates[userId] !== 'friends') {
        // Maybe they accepted since the list was fetched; the server's
        // friendship gate is authoritative either way.
        const { data } = await api.getFriends();
        if (data?.friends) setFriends?.(data.friends);
        if (friendStatesById(data?.friends || [], myId)[userId] !== 'friends') {
          throw new Error('You can only message friends. Add them as a friend first.');
        }
      }
      const row = await sendDm(userId, text);
      return { id: row.id, timestamp: row.timestamp };
    },
    [CMD.PREFS_SET_OVERLAY_DMS]: ({ enabled }) => { setOverlayDms(Boolean(enabled)); },
  };

  return { people, prefs: { overlayDms }, userVolumes, handlers };
}
