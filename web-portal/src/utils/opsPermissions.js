// Client-side operation permission gates, shared by WarRoom and the tray
// strip so both show the same buttons. These only decide what UI to offer;
// the server (eventsController.ts) is authoritative and re-checks every call.
// `org` is an entry from GET /orgs/me (owner_id, role_name, permissions);
// `user` is the signed-in user ({ id }).

// Org admin in WarRoom's sense: Commander role, owner, or channel manager.
export function isOrgCommander(org, user) {
  return org?.role_name === 'Commander' || org?.owner_id === user?.id
    || org?.permissions?.can_manage_channels === true;
}

// Schedule a new operation: org admin, or a role with create-events.
export function canScheduleOps(org, user) {
  if (!org) return false;
  return isOrgCommander(org, user) || org.permissions?.can_create_events === true;
}

// See the calendar: owner, or a role with view-calendar / create-events.
// (The server also lets an op's creator, commander and planners in.)
export function canViewOpsCalendar(org, user) {
  return org?.owner_id === user?.id
    || org?.permissions?.can_view_calendar === true
    || org?.permissions?.can_create_events === true;
}

// Launch an op that hasn't launched yet.
export function canLaunchOp(org, user, ev) {
  if (!org || !ev || ev.launched) return false;
  const uid = user?.id;
  if (!uid) return false;
  if (org.owner_id === uid) return true;
  if (org.permissions?.can_create_events === true) return true;
  if (org.permissions?.can_manage_channels === true) return true;
  if (org.role_name === 'Commander') return true;
  if (ev.creator_id === uid) return true;
  if (ev.commander_user_id === uid) return true;
  if ((ev.planners || []).some(p => p.user_id === uid)) return true;
  return false;
}

// Edit an op's details and plan: owner, the op's creator, or one of its
// planners (OperationPlanner's canEdit / WarRoom's canEditOperationEvent).
export function canEditOp(org, user, ev) {
  const uid = user?.id;
  if (!uid || !ev) return false;
  if (org?.owner_id === uid) return true;
  if (ev.creator_id === uid) return true;
  return (ev.planners || []).some(p => p.user_id === uid);
}
