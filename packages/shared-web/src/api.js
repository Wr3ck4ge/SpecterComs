// Shared API client factory used by both website/ and web-portal/.
//
// Each app supplies its own base-URL default: website falls back to a
// relative "/api" (its nginx proxy setup, and it has no VITE_API_URL set in
// any .env), web-portal falls back to an absolute localhost URL (a Tauri
// webview has nothing behind a relative path). That's a genuine per-deploy
// difference, so it stays a parameter here rather than a hardcoded default —
// hardcoding either app's default would silently change the other's fallback
// behavior. web-portal also layers its own Tauri-only extras (misconduct
// report buffer, diagnostics) on top of what this returns; see web-portal's
// local src/api.js.
export function createApi(API_BASE_URL) {
  const UPLOADS_BASE_URL = API_BASE_URL.replace(/\/api$/, '');

  async function fetchWithAuth(endpoint, options = {}, tokenOverride) {
    // tokenOverride lets callers (e.g. the admin portal, which keeps its
    // session in a separate specter_admin_token) use a token other than the
    // regular user session's specter_token.
    const token = tokenOverride || localStorage.getItem("specter_token");

    const isFormData = options.body instanceof FormData;

    const headers = {
      ...(isFormData ? {} : { "Content-Type": "application/json" }),
      ...(token ? { "Authorization": `Bearer ${token}` } : {}),
      ...options.headers,
    };

    try {
      const response = await fetch(`${API_BASE_URL}${endpoint}`, {
        ...options,
        headers,
        body: isFormData ? options.body : JSON.stringify(options.body),
      });

      // Parse response body regardless of status code (error details may be in body)
      const json = await response.json().catch(() => ({}));

      if (!response.ok) {
        // 401 means the token itself is invalid/expired — log out. 403 means the
        // token is fine but the action isn't permitted (e.g. missing a mod
        // permission) — that must NOT clear the session, or every permission
        // check that correctly denies an action would boot the user out of the app.
        if (response.status === 401) {
          localStorage.removeItem('specter_token');
          localStorage.removeItem('specter_user');
          window.dispatchEvent(new CustomEvent('specter:auth-expired'));
        }
        const fieldErrors = Array.isArray(json.errors) && json.errors.length
          ? json.errors.map(e => e.message).join(' · ')
          : null;
        throw new Error(fieldErrors || json.message || `HTTP ${response.status}: ${response.statusText}`);
      }

      return { data: json, error: null };
    } catch (err) {
      console.error(`API Call Failed [${endpoint}]:`, err);
      return { data: null, error: err.message || "Network Error" };
    }
  }

  const api = {
    // Auth
    register: (body) => fetchWithAuth("/auth/register", { method: "POST", body }),
    login: (body) => fetchWithAuth("/auth/login", { method: "POST", body }),
    forgotPassword: (email) => fetchWithAuth('/auth/forgot-password', { method: 'POST', body: { email } }),
    resetPassword:  (resetToken, password) => fetchWithAuth('/auth/reset-password', { method: 'POST', body: { token: resetToken, password } }),

    // Users
    updatePresence: (status, gameActivity) => fetchWithAuth("/users/presence", { method: "PUT", body: { status, gameActivity } }),
    getMyProfile: () => fetchWithAuth("/users/me"),
    updateProfile: (body) => fetchWithAuth("/users/profile", { method: "PUT", body: body }),
    getMyGames: () => fetchWithAuth("/users/games"),
    updateMyGames: (games) => fetchWithAuth("/users/games", { method: "PUT", body: { games } }),
    uploadIntroSound: (formData) => fetchWithAuth("/users/intro-sound", { method: "POST", body: formData }),
    deleteIntroSound: () => fetchWithAuth("/users/intro-sound", { method: "DELETE" }),
    getIntroSoundByCallsign: (callsign) => fetchWithAuth(`/users/intro-sound/${encodeURIComponent(callsign)}`),
    uploadAvatar: (formData) => fetchWithAuth("/users/avatar", { method: "POST", body: formData }),
    searchUsers: (q) => fetchWithAuth(`/users/search?q=${encodeURIComponent(q)}`),
    getMyTransactions: (limit = 50, offset = 0) => fetchWithAuth(`/users/me/transactions?limit=${limit}&offset=${offset}`),

    // Organizations
    createOrg:    (body)   => fetchWithAuth("/orgs",                          { method: "POST", body: body }),
    getMyOrgs:    ()       => fetchWithAuth("/orgs/me"),
    getPublicOrgs: ()      => fetchWithAuth("/orgs/public"),
    redeemInvite: (code)   => fetchWithAuth(`/orgs/invite/${code}/redeem`,    { method: "POST" }),
    joinOrg:      (orgId)  => fetchWithAuth(`/orgs/${orgId}/join`,             { method: "POST", body: {} }),
    getOrgToken:  (orgId, channelId)  => fetchWithAuth(`/orgs/${orgId}/token`,  { method: "POST", body: { channel_id: channelId } }),
    updateOrgProfile: (orgId, body) => fetchWithAuth(`/orgs/${orgId}/profile`, { method: "PUT", body: body }),
    updateOrgSettings: (orgId, body) => fetchWithAuth(`/orgs/${orgId}/settings`, { method: "PUT", body: body }),
    updateOrgLanding: (orgId, data) => fetchWithAuth(`/orgs/${orgId}/landing`, { method: "PUT", body: data }),
    uploadOrgLogo: (orgId, formData) => fetchWithAuth(`/orgs/${orgId}/logo`, { method: "POST", body: formData }),

    // Channels
    getChannels:   (orgId)          => fetchWithAuth(`/orgs/${orgId}/channels`),
    createChannel: (orgId, body)    => fetchWithAuth(`/orgs/${orgId}/channels`, { method: "POST", body: body }),
    deleteChannel: (orgId, chanId)  => fetchWithAuth(`/orgs/${orgId}/channels/${chanId}`, { method: "DELETE" }),
    joinChannelPresence:  (orgId, channelId) => fetchWithAuth(`/orgs/${orgId}/channels/${channelId}/presence`, { method: "POST",   body: {} }),
    pingChannelPresence:  (orgId, channelId) => fetchWithAuth(`/orgs/${orgId}/channels/${channelId}/presence/ping`, { method: "POST", body: {} }),
    leaveChannelPresence: (orgId, channelId) => fetchWithAuth(`/orgs/${orgId}/channels/${channelId}/presence`, { method: "DELETE", body: {} }),

    // Roles
    getRoles:      (orgId)          => fetchWithAuth(`/orgs/${orgId}/roles`),
    createRole:    (orgId, body)    => fetchWithAuth(`/orgs/${orgId}/roles`, { method: "POST", body: body }),
    updateRole:    (orgId, roleId, body) => fetchWithAuth(`/orgs/${orgId}/roles/${roleId}`, { method: "PUT", body: body }),
    deleteRole:    (orgId, roleId)  => fetchWithAuth(`/orgs/${orgId}/roles/${roleId}`, { method: "DELETE" }),

    // Member management
    getOrgMembers:     (orgId)              => fetchWithAuth(`/orgs/${orgId}/members`),
    assignMemberRole:  (orgId, userId, roleId) => fetchWithAuth(`/orgs/${orgId}/members/${userId}/role`, { method: "PUT", body: { role_id: roleId } }),
    kickMember:        (orgId, userId)      => fetchWithAuth(`/orgs/${orgId}/members/${userId}/kick`,   { method: "POST", body: {} }),
    kickFromChannel:   (orgId, userId, channelId) => fetchWithAuth(`/orgs/${orgId}/members/${userId}/kick-channel`, { method: "POST", body: { channel_id: channelId } }),
    banMember:         (orgId, userId, reason, expiresAt) => fetchWithAuth(`/orgs/${orgId}/members/${userId}/ban`,    { method: "POST", body: { reason, expiresAt } }),
    unbanMember:       (orgId, userId) => fetchWithAuth(`/orgs/${orgId}/members/${userId}/unban`, { method: "POST", body: {} }),
    getOrgBans:        (orgId)         => fetchWithAuth(`/orgs/${orgId}/bans`),
    muteMember:        (orgId, userId, mute, durationMin) => fetchWithAuth(`/orgs/${orgId}/members/${userId}/mute`,   { method: "POST", body: { mute, duration_minutes: durationMin } }),
    unmuteMember:      (orgId, userId)      => fetchWithAuth(`/orgs/${orgId}/members/${userId}/unmute`, { method: "POST", body: {} }),
    moveMember:        (orgId, userId, channelId) => fetchWithAuth(`/orgs/${orgId}/members/${userId}/move`,   { method: "POST", body: { channel_id: channelId } }),

    // Invites
    createInvite:  (orgId)          => fetchWithAuth(`/orgs/${orgId}/invites`, { method: "POST", body: {} }),

    // Billing
    getOrgBilling: (orgId) => fetchWithAuth(`/orgs/${orgId}/billing`),
    getOrgBillingTransactions: (orgId, limit = 50, offset = 0) => fetchWithAuth(`/orgs/${orgId}/billing/transactions?limit=${limit}&offset=${offset}`),
    contributeToOrg: (orgId, body) => fetchWithAuth(`/orgs/${orgId}/billing/contribute`, { method: "POST", body: body }),
    getContribution: (orgId, contributionId) => fetchWithAuth(`/orgs/${orgId}/billing/contributions/${contributionId}`),
    getOrgUsageDaily: (orgId, months = 6) => fetchWithAuth(`/orgs/${orgId}/billing/usage-daily?months=${months}`),
    getOrgBillingInfo: (orgId) => fetchWithAuth(`/orgs/${orgId}/billing/info`),
    updateOrgBillingInfo: (orgId, body) => fetchWithAuth(`/orgs/${orgId}/billing/info`, { method: "PUT", body: body }),
    getOrgInvoices: (orgId) => fetchWithAuth(`/orgs/${orgId}/billing/invoices`),
    payOrgInvoice: (orgId, contributionId, body) => fetchWithAuth(`/orgs/${orgId}/billing/invoices/${contributionId}/pay`, { method: "POST", body: body }),

    // Friends
    getFriends:         ()             => fetchWithAuth("/friends"),
    sendFriendRequest:  (target_id)    => fetchWithAuth("/friends/request",  { method: "POST", body: { target_id } }),
    acceptFriendRequest:(target_id)    => fetchWithAuth("/friends/accept",   { method: "POST", body: { target_id } }),
    declineFriendRequest:(target_id)   => fetchWithAuth("/friends/decline",  { method: "POST", body: { target_id } }),
    removeFriend:       (target_id)    => fetchWithAuth("/friends/remove",   { method: "POST", body: { target_id } }),

    // Events
    getOrgEvents:       (orgId)        => fetchWithAuth(`/orgs/${orgId}/events`),
    getOrgEventHistory: (orgId)        => fetchWithAuth(`/orgs/${orgId}/events/history`),
    createOrgEvent:     (orgId, body)  => fetchWithAuth(`/orgs/${orgId}/events`,                    { method: "POST", body: body }),
    updateOrgEvent:     (orgId, evId, body) => fetchWithAuth(`/orgs/${orgId}/events/${evId}`,       { method: "PUT", body: body }),
    deleteOrgEvent:     (orgId, evId)  => fetchWithAuth(`/orgs/${orgId}/events/${evId}`,             { method: "DELETE" }),
    rsvpEvent:          (orgId, evId)  => fetchWithAuth(`/orgs/${orgId}/events/${evId}/rsvp`,        { method: "POST", body: { priority: 0 } }),
    getEventGroups:     (orgId, evId)  => fetchWithAuth(`/orgs/${orgId}/events/${evId}/groups`),
    saveEventGroups:    (orgId, evId, payload) => fetchWithAuth(`/orgs/${orgId}/events/${evId}/groups`, { method: "PUT", body: payload }),
    getEventFrequencies: (orgId, evId) => fetchWithAuth(`/orgs/${orgId}/events/${evId}/frequencies`),

    // Game ship catalog (e.g. Star Citizen, via a local cache synced from fleetyards.net)
    getGameShips: (game, q = '') => fetchWithAuth(`/game-ships?game=${encodeURIComponent(game)}&q=${encodeURIComponent(q)}`),
    // Per-seat crew data + stock loadout, cached from StarCitizenWiki/scunpacked-data
    getShipCrewRoles: (game, slug) => fetchWithAuth(`/game-ships/crew-roles?game=${encodeURIComponent(game)}&slug=${encodeURIComponent(slug)}`),
    getShipSeats:     (game, slug) => fetchWithAuth(`/game-ships/seats?game=${encodeURIComponent(game)}&slug=${encodeURIComponent(slug)}`),
    getShipLoadout:   (game, slug) => fetchWithAuth(`/game-ships/loadout?game=${encodeURIComponent(game)}&slug=${encodeURIComponent(slug)}`),
    getShipComponents: (game, type, size, q = '', dmgType = '', family = '') => fetchWithAuth(`/game-ships/components?game=${encodeURIComponent(game)}&type=${encodeURIComponent(type || '')}&size=${encodeURIComponent(size ?? '')}&q=${encodeURIComponent(q)}&dmg_type=${encodeURIComponent(dmgType)}&family=${encodeURIComponent(family)}`),
    getShipComponentDetails: (game, classNames) => fetchWithAuth(`/game-ships/component-details?game=${encodeURIComponent(game)}&class_names=${encodeURIComponent(classNames.join(','))}`),
    getShipCombatStats: (game, slug) => fetchWithAuth(`/game-ships/combat-stats?game=${encodeURIComponent(game)}&slug=${encodeURIComponent(slug)}`),
    getShipDimensions: (game, slug) => fetchWithAuth(`/game-ships/dimensions?game=${encodeURIComponent(game)}&slug=${encodeURIComponent(slug)}`),
    getDamageEstimate: (game, attackerLoadout, targetSlug) => fetchWithAuth(`/game-ships/damage-estimate`, { method: "POST", body: { game, attacker_loadout: attackerLoadout, target_slug: targetSlug } }),
    launchEvent:        (orgId, evId)  => fetchWithAuth(`/orgs/${orgId}/events/${evId}/launch`,      { method: "POST", body: {} }),
    getEventChannelTree: (orgId, evId)  => fetchWithAuth(`/orgs/${orgId}/events/${evId}/tree`),
    getEventPlanners:   (orgId, evId)  => fetchWithAuth(`/orgs/${orgId}/events/${evId}/planners`),
    setEventPlanners:   (orgId, evId, planner_ids) => fetchWithAuth(`/orgs/${orgId}/events/${evId}/planners`, { method: "PUT", body: { planner_ids } }),
    joinEventGroup:     (orgId, evId, groupId) => fetchWithAuth(`/orgs/${orgId}/events/${evId}/groups/${groupId}/join`, { method: "POST", body: {} }),
    leaveEventGroup:    (orgId, evId, groupId) => fetchWithAuth(`/orgs/${orgId}/events/${evId}/groups/${groupId}/leave`, { method: "POST", body: {} }),
    joinEventRole:         (orgId, evId, groupId, roleId, claimedShipId = null, seatLabel = null) => fetchWithAuth(`/orgs/${orgId}/events/${evId}/groups/${groupId}/roles/${roleId}/join`, { method: "POST", body: { claimed_ship_id: claimedShipId, seat_label: seatLabel } }),
    leaveEventRole:        (orgId, evId, groupId, roleId) => fetchWithAuth(`/orgs/${orgId}/events/${evId}/groups/${groupId}/roles/${roleId}/join`, { method: "DELETE" }),
    getGroupShipMatch:     (orgId, evId, groupId) => fetchWithAuth(`/orgs/${orgId}/events/${evId}/groups/${groupId}/ship-match`),
    getGroupDpsEstimate:   (orgId, evId, groupId) => fetchWithAuth(`/orgs/${orgId}/events/${evId}/groups/${groupId}/dps-estimate`),
    getClaimableShips:     (orgId, evId, groupId) => fetchWithAuth(`/orgs/${orgId}/events/${evId}/groups/${groupId}/claimable-ships`),
    claimShipSlot:         (orgId, evId, groupId, shipSlug, slotIndex, userShipId) => fetchWithAuth(`/orgs/${orgId}/events/${evId}/groups/${groupId}/ships/${shipSlug}/claim`, { method: "POST", body: { slot_index: slotIndex, user_ship_id: userShipId } }),
    releaseShipSlot:       (orgId, evId, groupId, shipSlug) => fetchWithAuth(`/orgs/${orgId}/events/${evId}/groups/${groupId}/ships/${shipSlug}/claim`, { method: "DELETE" }),
    getEventMapLayout:     (orgId, evId) => fetchWithAuth(`/orgs/${orgId}/events/${evId}/map-layout`),
    saveEventMapLayout:    (orgId, evId, layout) => fetchWithAuth(`/orgs/${orgId}/events/${evId}/map-layout`, { method: "PUT", body: { layout } }),
    uploadEventMapModel:   (orgId, evId, formData) => fetchWithAuth(`/orgs/${orgId}/events/${evId}/map-models`, { method: "POST", body: formData }),

    // Personal hangar (global per-user, not per-org)
    getHangar:        () => fetchWithAuth(`/hangar`),
    addHangarShip:    (shipSlug) => fetchWithAuth(`/hangar`, { method: "POST", body: { ship_slug: shipSlug } }),
    updateHangarShip: (id, payload) => fetchWithAuth(`/hangar/${id}`, { method: "PATCH", body: payload }),
    removeHangarShip: (id) => fetchWithAuth(`/hangar/${id}`, { method: "DELETE" }),
    approveGroupMember:    (orgId, evId, groupId, userId) => fetchWithAuth(`/orgs/${orgId}/events/${evId}/groups/${groupId}/members/${userId}/approve`, { method: "POST", body: {} }),
    approveAllGroupMembers:(orgId, evId, groupId) => fetchWithAuth(`/orgs/${orgId}/events/${evId}/groups/${groupId}/members/approve-all`, { method: "POST", body: {} }),
    removeGroupMember:     (orgId, evId, groupId, userId) => fetchWithAuth(`/orgs/${orgId}/events/${evId}/groups/${groupId}/members/${userId}`, { method: "DELETE" }),
    quickJoinEvent:        (orgId, evId) => fetchWithAuth(`/orgs/${orgId}/events/${evId}/join-quick`, { method: "POST", body: {} }),
    leaveMyEventSignup:    (orgId, evId) => fetchWithAuth(`/orgs/${orgId}/events/${evId}/my-signup`, { method: "DELETE" }),
    respondEventAssignment: (orgId, evId, accept) => fetchWithAuth(`/orgs/${orgId}/events/${evId}/respond`, { method: "POST", body: { accept } }),
    pingPresence:   (orgId, evId) => fetchWithAuth(`/orgs/${orgId}/events/${evId}/presence`, { method: "POST", body: {} }),
    clearPresence:  (orgId, evId) => fetchWithAuth(`/orgs/${orgId}/events/${evId}/presence`, { method: "DELETE" }),

    // Channel layout presets
    getEventPresets:    (orgId)              => fetchWithAuth(`/orgs/${orgId}/events/presets`),
    saveEventPreset:    (orgId, name, layout) => fetchWithAuth(`/orgs/${orgId}/events/presets`, { method: "POST", body: { name, layout } }),
    deleteEventPreset:  (orgId, presetId)    => fetchWithAuth(`/orgs/${orgId}/events/presets/${presetId}`, { method: "DELETE" }),
    getMyEventAssignment: (orgId, evId)      => fetchWithAuth(`/orgs/${orgId}/events/${evId}/my-assignment`),
    endOperation:       (orgId, evId, mode) =>
      fetchWithAuth(`/orgs/${orgId}/events/${evId}/end`, { method: "POST", body: { mode } }),

    // DMs / channel messages — relay-only (no server history; clients store locally)
    sendDmMessage: (userId, encrypted_content) =>
      fetchWithAuth(`/dm/${userId}/messages`, { method: 'POST', body: { encrypted_content } }),
    sendMessage: (orgId, chanId, encrypted_content, image_url = null) =>
      fetchWithAuth(`/orgs/${orgId}/channels/${chanId}/messages`, { method: "POST", body: { encrypted_content, ...(image_url ? { image_url } : {}) } }),

    // Peer backfill sync — server has no history to serve, so these just fan
    // requests/answers out to other online members over the existing relay.
    // See messageController.ts / dmController.ts for the full explanation.
    requestChannelSync: (orgId, chanId, since) =>
      fetchWithAuth(`/orgs/${orgId}/channels/${chanId}/messages/sync-request`, { method: 'POST', body: { since } }),
    respondChannelSync: (orgId, chanId, toUserId, messages) =>
      fetchWithAuth(`/orgs/${orgId}/channels/${chanId}/messages/sync-response`, { method: 'POST', body: { to_user_id: toUserId, messages } }),
    requestDmSync: (userId, since) =>
      fetchWithAuth(`/dm/${userId}/sync-request`, { method: 'POST', body: { since } }),
    respondDmSync: (userId, messages) =>
      fetchWithAuth(`/dm/${userId}/sync-response`, { method: 'POST', body: { messages } }),

    // MLS device identity / group commits — see deviceController.ts /
    // mlsGroupController.ts. KeyPackages are public key material by design
    // (no different a security boundary than fetching someone's public key).
    registerDevice: (deviceId, keyPackageB64, credentialB64, publicKeyB64 = null) =>
      fetchWithAuth(`/devices`, { method: 'POST', body: { device_id: deviceId, key_package: keyPackageB64, credential: credentialB64, public_key: publicKeyB64 } }),
    getUserDeviceKeyPackages: (userId) =>
      fetchWithAuth(`/devices/${userId}/key-packages`, { method: 'GET' }),
    submitDmCommit: (userId, epoch, commitB64, welcomeB64 = null) =>
      fetchWithAuth(`/dm/${userId}/mls/commit`, { method: 'POST', body: { epoch, commit: commitB64, welcome: welcomeB64 } }),
    submitChannelCommit: (orgId, chanId, epoch, commitB64, welcomeB64 = null, welcomedUserIds = []) =>
      fetchWithAuth(`/orgs/${orgId}/channels/${chanId}/mls/commit`, { method: 'POST', body: { epoch, commit: commitB64, welcome: welcomeB64, welcomed_user_ids: welcomedUserIds } }),
    submitEventGroupCommit: (orgId, eventId, epoch, commitB64, welcomeB64 = null, welcomedUserIds = []) =>
      fetchWithAuth(`/orgs/${orgId}/events/${eventId}/mls/commit`, { method: 'POST', body: { epoch, commit: commitB64, welcome: welcomeB64, welcomed_user_ids: welcomedUserIds } }),
    // Every accepted participant across an event's groups — the membership
    // source for the event-scoped cascade MLS group (see ensureEventGroup in
    // mlsSession.js). Superset of any single frequency's role-based grant.
    getEventParticipants: (orgId, eventId) =>
      fetchWithAuth(`/orgs/${orgId}/events/${eventId}/participants`),

    // Abuse reports
    sendAbuseReport: (body) =>
      fetchWithAuth('/abuse-reports', { method: 'POST', body: body }),
    sendVoiceReport: (body) =>
      fetchWithAuth('/voice-reports', { method: 'POST', body: body }),

    // Diagnostics — bundles capture perf/error/breadcrumb logs. Callsign is
    // attached server-side from the auth token, not sent in the body.
    submitDiagnostics: (body) =>
      fetchWithAuth('/diag/perf-report', { method: 'POST', body: body }),

    // Admin — all calls (except login) take the admin JWT as an explicit first
    // argument rather than relying on fetchWithAuth's localStorage default, since
    // the admin token is stored separately (specter_admin_token) from the regular
    // user session token (specter_token) that fetchWithAuth reads by default.
    adminLogin:       (body)                        => fetchWithAuth("/admin/login", { method: "POST", body: body }),
    adminGetStats:    (token)                       => fetchWithAuth("/admin/stats", {}, token),
    adminGetOverview: (token)                       => fetchWithAuth("/admin/overview", {}, token),
    adminGetUsers:    (token, q = '', page = 1)     => fetchWithAuth(`/admin/users?q=${encodeURIComponent(q)}&page=${page}`, {}, token),
    adminGetUser:     (token, id)                   => fetchWithAuth(`/admin/users/${id}`, {}, token),
    adminBanUser:     (token, id, ban, reason = '') => fetchWithAuth(`/admin/users/${id}/ban`, { method: "POST", body: { ban, reason } }, token),
    adminGetOrgs:     (token, q = '', page = 1)     => fetchWithAuth(`/admin/orgs?q=${encodeURIComponent(q)}&page=${page}`, {}, token),
    adminDissolveOrg: (token, orgId)                => fetchWithAuth(`/admin/orgs/${orgId}`, { method: "DELETE" }, token),
    adminGetHwidBans: (token)                       => fetchWithAuth("/admin/hwid-bans", {}, token),
    adminRemoveHwidBan: (token, hwid)               => fetchWithAuth(`/admin/hwid-bans/${encodeURIComponent(hwid)}`, { method: "DELETE" }, token),

    // Media Nodes (Phase A of multi-tenant infra)
    adminGetNodes:        (token)                => fetchWithAuth('/admin/nodes', {}, token),
    adminUpdateNode:      (token, nodeId, body)   => fetchWithAuth(`/admin/nodes/${encodeURIComponent(nodeId)}`, { method: "PUT", body }, token),
    adminAssignOrgNode:   (token, orgId, nodeId)  => fetchWithAuth(`/admin/orgs/${orgId}/node`, { method: "POST", body: { node_id: nodeId } }, token),
    adminUnassignOrgNode: (token, orgId)          => fetchWithAuth(`/admin/orgs/${orgId}/node`, { method: "DELETE" }, token),

    // Node Provisioning (Phase B of multi-tenant infra)
    adminProvisionNode:   (token, region, nodeId) => fetchWithAuth('/admin/nodes/provision',   { method: "POST", body: { region, node_id: nodeId } }, token),
    adminGetProvisioning: (token)                 => fetchWithAuth('/admin/nodes/provisioning', {}, token),

    // Voice misconduct reports — audio evidence stays encrypted at rest
    // server-side; adminGetVoiceReportAudioUrl only returns the URL (the
    // caller fetches it with the admin token itself, since this needs to
    // stay a plain URL usable by an <audio> element's src, not a fetch call).
    adminGetVoiceReports:  (token, status = null) => fetchWithAuth(`/admin/voice-reports${status ? `?status=${encodeURIComponent(status)}` : ''}`, {}, token),
    adminGetVoiceReportAudioUrl: (id) => `${API_BASE_URL}/admin/voice-reports/${id}/audio`,
    adminUpdateVoiceReport: (token, id, status, adminNotes = null) =>
      fetchWithAuth(`/admin/voice-reports/${id}`, { method: "PATCH", body: { status, admin_notes: adminNotes } }, token),
  };

  return { api, fetchWithAuth, API_BASE_URL, UPLOADS_BASE_URL };
}
