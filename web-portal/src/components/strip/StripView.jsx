import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Bell, CalendarClock, Check, ChevronDown, ChevronUp, RefreshCw, Settings, X,
  Gamepad2, // P2C
} from 'lucide-react';
import { Alert, Button, IconButton } from '../ui';
import { cx, focusRing } from '../ui/styles';
import { BrandMark } from '../auth/AuthLayout';
import LoginForm from '../auth/LoginForm';
import ForgotPasswordForm from '../auth/ForgotPasswordForm';
import HexBadge from '../HexBadge';
import { getOrgColor } from '../../utils/orgColors';
import { UPLOADS_BASE_URL } from '../../api';
// S10: Operations + Notifications cabinets and the op panel above them.
import OpsCabinet from './OpsCabinet';
import NotificationsCabinet from './NotificationsCabinet';
import { IconBadge } from './stripOpsUi';
// P2B: the op panel opens wide in the free work area (wideOpLayout).
import { stripOpsHeights, useViewportSize, wideOpLayout } from './stripOpsLayout';
import { CHANNELS_ICON } from './ChannelsCabinet'; // CH2
// BAR2: the bar's dynamic slot row.
import { BarSlots, PulseDot, SlotChip } from './StripBarSlots';
import { SLOT_PRIORITY } from './barSlots';
import { isOpLive } from '../../utils/opsEvents';

// A server's display name is its `callsign` (that's what /orgs/me returns
// and what WarRoom shows); `logo_url` is a path under the uploads host.
const orgName = (org) => org?.callsign || org?.name || '';
const orgLogo = (org) => (org?.logo_url ? `${UPLOADS_BASE_URL}${org.logo_url}` : null);

// Presentational tray strip: everything the strip window shows, driven by
// props. StripApp (the container) owns the data, Tauri calls and events; the
// dev preview (/strip-preview.html) renders this with canned props.
//
// Layout: the strip window is a fixed-size transparent window clipped to the
// elements marked `data-strip-region` (see src-tauri/src/strip.rs). Panels
// stack from the docked edge: the base panel (bar, or the login card) sits
// against the taskbar and the cabinet slides out of it — upward normally,
// downward when the taskbar is at the top (`grow="down"`). Anything stacked
// further from the bar (the first-run hint now, ambient cards later) goes
// before the cabinet in the markup.

const CABINETS = {
  channels:      { title: 'Channels',      Icon: CHANNELS_ICON }, // CH2: was Hash
  operations:    { title: 'Operations',    Icon: CalendarClock },
  notifications: { title: 'Notifications', Icon: Bell },
  games:         { title: 'Games',         Icon: Gamepad2 }, // P2C: Supported games → tools
  settings:      { title: 'Settings',      Icon: Settings },
};

const EXIT_MS = 140;

/**
 * Keeps the cabinet mounted through its exit animation and picks the
 * animation: slide in when opening from nothing, fade when swapping one
 * cabinet for another, slide out when closing. `instant` skips the exit
 * (the strip was hidden).
 */
function useCabinetTransition(cabinet, instant, onSettled) {
  const [shown, setShown] = useState(() => (cabinet ? { id: cabinet, anim: 'enter' } : null));

  useEffect(() => {
    setShown((prev) => {
      if (cabinet) {
        if (prev && prev.id === cabinet && prev.anim !== 'exit') return prev;
        return { id: cabinet, anim: prev && prev.anim !== 'exit' ? 'swap' : 'enter' };
      }
      if (!prev || instant) return null;
      return prev.anim === 'exit' ? prev : { ...prev, anim: 'exit' };
    });
  }, [cabinet, instant]);

  // animationend can't be relied on alone (a hidden window may not run the
  // animation at all), so the exit is also finished by a timer.
  useEffect(() => {
    if (shown?.anim !== 'exit') return undefined;
    const t = setTimeout(() => { setShown(null); onSettled?.(); }, EXIT_MS + 40);
    return () => clearTimeout(t);
  }, [shown, onSettled]);

  return shown;
}

function CabinetHeader({ title, subtitle, onClose }) {
  return (
    <div className="flex items-start justify-between gap-3 px-4 pt-3 pb-2">
      <div className="min-w-0">
        <h2 className="text-ui-lg font-semibold text-specter-text-main">{title}</h2>
        {subtitle && <p className="text-ui-sm text-specter-text-subtle">{subtitle}</p>}
      </div>
      <IconButton icon={<X size={16} />} label="Close" size="sm" onClick={onClose} />
    </div>
  );
}

function PlaceholderCabinet({ id, onClose }) {
  const { title } = CABINETS[id];
  return (
    <div className="pb-4">
      <CabinetHeader title={title} onClose={onClose} />
      <div className="px-4">
        <p className="text-ui-sm text-specter-text-muted">Coming next.</p>
      </div>
    </div>
  );
}

/**
 * MR2: "Resync encryption" for the current server: force-heals every MLS
 * group of that server in the engine (server.resyncEncryption) and shows the
 * result. resync = { orgId, busy, ok, message } | null (StripApp keeps it, so
 * it survives the cabinet closing).
 */
function ResyncEncryption({ org, resync, onResync }) {
  if (!org || !onResync) return null;
  const mine = resync?.orgId === org.id ? resync : null;
  const busy = Boolean(mine?.busy);
  return (
    <div className="mx-2 mt-1 px-2 pt-2 pb-1 border-t border-specter-border-divider">
      <div className="flex items-center gap-2">
        <span className="flex-1 min-w-0">
          <span className="block text-ui-sm font-medium text-specter-text-main">Encryption</span>
          <span className="block text-ui-xs text-specter-text-subtle">
            Messages stuck on &ldquo;Waiting for key&rdquo;? Re-sync this server&apos;s keys.
          </span>
        </span>
        <Button size="sm" variant="secondary" className="shrink-0" disabled={busy} onClick={() => onResync(org.id)}
          icon={<RefreshCw size={14} className={busy ? 'animate-spin' : undefined} />}>
          {busy ? 'Re-syncing…' : 'Resync encryption'}
        </Button>
      </div>
      {mine && !busy && mine.message && (
        <p role="status" className={cx('mt-1 text-ui-xs', mine.ok ? 'text-specter-primary-neon' : 'text-red-300')}>
          {mine.message}
        </p>
      )}
    </div>
  );
}

function ServerCabinet({ orgs, orgsLoading, orgsError, activeOrgId, onSelectOrg, onClose, resync, onResyncEncryption }) {
  let body;
  if (orgsLoading && !orgs.length) {
    body = <p className="px-4 py-3 text-ui-sm text-specter-text-subtle">Loading servers…</p>;
  } else if (orgsError && !orgs.length) {
    body = <div className="px-4 py-2"><Alert variant="error">{orgsError}</Alert></div>;
  } else if (!orgs.length) {
    body = <p className="px-4 py-3 text-ui-sm text-specter-text-subtle">You aren&apos;t in any servers yet.</p>;
  } else {
    body = (
      <ul className="px-2 space-y-0.5" aria-label="Servers">
        {orgs.map((org, i) => {
          const active = org.id === activeOrgId;
          return (
            <li key={org.id}>
              <button
                type="button"
                onClick={() => onSelectOrg(org)}
                aria-current={active || undefined}
                className={cx(
                  'w-full flex items-center gap-3 px-2 py-2 rounded-ui-row text-left transition-colors',
                  focusRing,
                  active ? 'bg-specter-primary-cyan/10' : 'hover:bg-white/5',
                )}
              >
                <HexBadge letter={orgName(org)[0] || '?'} colorKey={getOrgColor(i)} size={30} imageUrl={orgLogo(org)} active={active} />
                <span className="flex-1 min-w-0">
                  <span className="block truncate text-ui-base font-medium text-specter-text-main">{orgName(org)}</span>
                  {org.member_count != null && (
                    <span className="block text-ui-xs text-specter-text-subtle">
                      {org.member_count} {org.member_count === 1 ? 'member' : 'members'}
                    </span>
                  )}
                </span>
                {active && <Check size={16} className="shrink-0 text-specter-primary-neon" aria-label="Current server" />}
              </button>
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <div className="flex flex-col max-h-[460px]">
      <CabinetHeader title="Servers" subtitle="Switch the server you're working in" onClose={onClose} />
      <div className="strip-scroll min-h-0 flex-1 pb-2">
        {body}
        <ResyncEncryption org={orgs.find((o) => o.id === activeOrgId) || null} resync={resync} onResync={onResyncEncryption} />
      </div>
    </div>
  );
}

// ── BAR2: the main bar ─────────────────────────────────────────────────────
//   ┌──────┬───────────────────────────┬──────────────────────┐
//   │      │ [● Nova +1] [▣] [◫]  slots │                      │
//   │ LOGO ├───────────────────────────┤  #  📅  🔔  🎮  ⚙   │
//   │      │ Ghost Fleet ˅      server │                      │
//   └──────┴───────────────────────────┴──────────────────────┘
// The logo spans both rows; the upper row is the dynamic slot row
// (StripBarSlots: speaker, stream, overlay, live op, update — whatever fits,
// by priority); the lower row is the server name, which opens the server
// switcher like the logo does. Taskbar on top (grow 'down') keeps the same
// row order.
const BAR_LOGO = 58;
const BAR_LOGO_COMPACT = 46; // narrow work area: a smaller logo and icons leave the name room
const BAR_COMPACT_BELOW = 400; // px of bar width
const BAR_HEIGHT = 'h-[68px]'; // logo + 5px above and below

// The bar's own width (it follows the strip column, not the window).
function useWidth(ref) {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    setW(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

/** BAR2: "Restart to update" as a slot chip (was a row above the bar). */
function UpdateChip({ update, installing, error, onInstall }) {
  const label = error
    ? `Update to ${update.version} failed: ${error}. Try again`
    : `Version ${update.version} is ready. Restart to update`;
  return (
    <SlotChip tone={error ? 'warn' : 'accent'} onClick={onInstall} disabled={installing} label={label}
      icon={<RefreshCw size={12} className={installing ? 'animate-spin' : undefined} />}>
      {installing ? 'Restarting…' : error ? 'Retry update' : 'Update'}
    </SlotChip>
  );
}

/** BAR2: an op on this server is live right now; opens it in the Operations cabinet. */
function LiveOpChip({ event, onOpen }) {
  return (
    <SlotChip tone="live" onClick={onOpen} icon={<PulseDot className="text-red-400" />}
      label={`Live now: ${event.name}. Open in Operations`} title={`Live now: ${event.name}`}>
      <span className="font-semibold tracking-wide">LIVE</span> {event.name}
    </SlotChip>
  );
}

function Bar({ activeOrg, activeOrgIndex, cabinet, onToggleCabinet, grow, badges = {}, slots = [], channelsIcon: ChannelsIconOverride = null /* CH2 */ }) {
  const serverOpen = cabinet === 'server';
  const Chevron = (grow === 'down') === serverOpen ? ChevronUp : ChevronDown;
  const members = activeOrg?.member_count;
  const ref = useRef(null);
  const width = useWidth(ref);
  const compact = width > 0 && width < BAR_COMPACT_BELOW;
  const logo = compact ? BAR_LOGO_COMPACT : BAR_LOGO;
  return (
    <div ref={ref} className={cx('flex items-center pl-[5px] pr-1.5', compact ? 'gap-1.5' : 'gap-2', BAR_HEIGHT)}>
      {/* The logo opens the server switcher too (mouse only: the name button
          below is the keyboard/screen-reader control for it). */}
      <div aria-hidden="true" onClick={() => onToggleCabinet('server')}
        className={cx('shrink-0 cursor-pointer rounded-ui-row transition-transform duration-150', !serverOpen && 'hover:scale-[1.03]')}>
        <HexBadge
          letter={orgName(activeOrg)[0] || '?'}
          colorKey={getOrgColor(Math.max(0, activeOrgIndex))}
          size={logo}
          imageUrl={orgLogo(activeOrg)}
          active={serverOpen}
        />
      </div>
      <div className="flex-1 min-w-0 flex flex-col justify-center gap-0.5" style={{ height: BAR_LOGO }}>
        <BarSlots
          slots={slots}
          className="h-7 shrink-0"
          empty={members != null ? (
            <span className="px-0.5 text-ui-xs text-specter-text-subtle truncate">{members} {members === 1 ? 'member' : 'members'}</span>
          ) : null}
        />
        <button
          type="button"
          onClick={() => onToggleCabinet('server')}
          aria-expanded={serverOpen}
          aria-label={activeOrg ? `Server: ${orgName(activeOrg)}. Switch server` : 'Choose a server'}
          title={activeOrg ? orgName(activeOrg) : undefined}
          className={cx(
            'h-7 shrink-0 max-w-full self-start flex items-center gap-1 pl-0.5 pr-1.5 -ml-0.5 rounded-ui-row text-left transition-colors',
            focusRing,
            serverOpen ? 'bg-specter-primary-cyan/15' : 'hover:bg-white/5',
          )}
        >
          <span className="min-w-0 truncate text-ui-base font-semibold text-specter-text-main">
            {activeOrg ? orgName(activeOrg) : 'No server'}
          </span>
          <Chevron size={15} aria-hidden="true" className="shrink-0 text-specter-text-subtle" />
        </button>
      </div>
      <div className="shrink-0 flex items-center gap-0.5">
        {Object.entries(CABINETS).map(([id, { title, Icon }]) => (
          <span key={id} className="relative inline-flex">
            <IconButton
              size={compact ? 'sm' : 'md'}
              icon={id === 'channels' && ChannelsIconOverride ? <ChannelsIconOverride size={compact ? 16 : 18} /> : <Icon size={compact ? 16 : 18} /> /* CH2 */}
              label={badges[id]?.label ? `${title} (${badges[id].label})` : title}
              active={cabinet === id}
              onClick={() => onToggleCabinet(id)}
            />
            {/* P2A: a badge may bring its own element (the red unread count). */}
            {badges[id]?.element ?? <IconBadge kind={badges[id]?.kind} count={badges[id]?.count} />}
          </span>
        ))}
      </div>
    </div>
  );
}

function FirstRunHint({ onDismiss }) {
  return (
    <div data-strip-region className="relative strip-panel px-4 py-3 ml-2 mr-10" role="status">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-ui-base font-semibold text-specter-text-main">SpecterComs now lives here</div>
          <p className="text-ui-sm text-specter-text-subtle">
            Click the tray icon to open this bar.
          </p>
        </div>
        <Button size="sm" variant="secondary" onClick={onDismiss}>Got it</Button>
      </div>
      <span className="strip-hint-arrow" aria-hidden="true" />
    </div>
  );
}

/**
 * grow             'up' | 'down' — which way cabinets open (from strip.rs)
 * auth             'loading' | 'out' | 'in'
 * loggedOutView    'login' | 'forgot'
 * login / forgot   form state objects (see StripApp)
 * orgs, activeOrgId, orgsLoading, orgsError, onSelectOrg
 * resync, onResyncEncryption(orgId)  MR2: the server cabinet's Resync encryption
 * cabinet          null | 'server' | keyof CABINETS
 * instantClose     close the cabinet without its exit animation
 * update           { version } when a downloaded update is waiting (BAR2: shown as a bar slot)
 * barSlots         BAR2: the container's slots for the bar's upper row (see StripBarSlots)
 * showHint         first-run "SpecterComs now lives here"
 * onRegionChange() called after an exit animation unmounts something
 * renderCabinet(id, { onClose, maxHeight })  body for a cabinet built in its own file
 *                  (e.g. ChannelsCabinet); return null for the placeholder
 * ops              useStripOps() result (S10) — drives the Operations and
 *                  Notifications cabinets and their bar badges
 * opPanel          { target, open(ev, orgId), schedule(date), render(layoutFor) }
 *                  — the op view / planner. P2B: it opens as a wide panel in
 *                  the free work area (position: fixed, from the measured bar
 *                  rect and the window size — see wideOpLayout); the cabinet
 *                  under it is hidden (kept mounted) while it's open.
 */
export default function StripView({
  grow = 'up',
  auth,
  loggedOutView = 'login',
  login,
  forgot,
  orgs = [],
  activeOrgId = null,
  orgsLoading = false,
  orgsError = null,
  onSelectOrg,
  resync = null,             // MR2
  onResyncEncryption = null, // MR2
  cabinet = null,
  instantClose = false,
  onToggleCabinet,
  onCloseCabinet,
  update = null,
  updateInstalling = false,
  updateError = null,
  onInstallUpdate,
  showHint = false,
  onDismissHint,
  onRegionChange,
  renderCabinet,
  ops = null,
  opPanel = null,
  viewportHeight, // dev preview only: the frame's height instead of the window's
  // ── P2A (channels/voice/chat pass) ──
  barSlots = null,          // BAR2: slots for the bar's upper row (StripBarSlots; voice: speaker, stream, overlay)
  channelsBadge = null,     // { element, label } for the Channels icon (unread total)
  stackPanel = null,        // a panel stacked above the cabinet slot (screenshare picker); carries its own data-strip-region
  cabinetSlotStyle,         // inline style for the cabinet slot (fluid sideways expansion, useFluidExpand)
  onCabinetSlotTransitionEnd,
  viewportWidth,  // P2B dev preview only: the frame's width
  opsCabinetInitial, // P2B dev preview only: { initialTab, initialDay } for OpsCabinet
  channelsIcon = null, // CH2 dev preview only: override the Channels bar icon (icon candidates)
  // SV: the stream viewer, as ({ mode, bar, vw, vh, grow }) => node (StripStreamViewer).
  // mode: 'full' (panel above the bar) | 'mini' (a cabinet / the picker is open:
  // a row stacked above it) | 'hidden' (the wide op panel is open).
  streamViewer = null,
  collapsed = false, // SV: pinned + unfocused (strip.rs): only the viewer is in the region
}) {
  const shown = useCabinetTransition(auth === 'in' ? cabinet : null, instantClose, onRegionChange);
  // P2B: window size + the main bar's rect drive the wide op panel.
  const measured = useViewportSize();
  const vh = viewportHeight ?? measured.h;
  const vw = viewportWidth ?? measured.w;
  const opsCabinetShown = shown && (shown.id === 'operations' || shown.id === 'notifications') && shown.anim !== 'exit';
  const panelOpen = !!(ops && opPanel?.target && opsCabinetShown);
  const heights = stripOpsHeights(vh, false);
  const rootRef = useRef(null);
  const barRef = useRef(null);
  const originRef = useRef(null);
  const [barRect, setBarRect] = useState(null);
  // P2B: measure the bar relative to the fixed-position origin (the window;
  // in the dev preview, the transformed frame). Runs after every render on
  // purpose (the bar moves with cabinets, updates, fonts); the setter bails
  // out when the rect is unchanged, so it settles after one extra render.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const o = originRef.current?.getBoundingClientRect() || { left: 0, top: 0 };
    const next = { left: Math.round(r.left - o.left), top: Math.round(r.top - o.top), right: Math.round(r.right - o.left), bottom: Math.round(r.bottom - o.top) };
    setBarRect((prev) => (prev && prev.left === next.left && prev.top === next.top && prev.right === next.right && prev.bottom === next.bottom ? prev : next));
  });
  // Fallback before the first measurement: bar at the bottom-right.
  const bar = barRect || { left: vw - 426, right: vw - 6, top: vh - 64, bottom: vh - 6 };
  // OPGROW: + onRegion — the op panel grows / shrinks without a render here.
  const layoutFor = (kind) => ({ ...wideOpLayout({ vw, vh, bar, grow, kind }), onRegion: onRegionChange });

  // The window region must be re-measured after every render of THIS
  // component: the cabinet is mounted by useCabinetTransition's own state one
  // render after the container's, so a measurement taken only when the
  // container renders sees no cabinet and clips it away. Panels also change
  // size without a render here (server list loading, fonts), hence the
  // ResizeObserver on every region element.
  useLayoutEffect(() => { onRegionChange?.(); });
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => onRegionChange?.());
    root.querySelectorAll('[data-strip-region]').forEach((el) => ro.observe(el));
    return () => ro.disconnect();
  });

  const activeOrgIndex = orgs.findIndex((o) => o.id === activeOrgId);
  const activeOrg = activeOrgIndex >= 0 ? orgs[activeOrgIndex] : null;

  let base;
  if (auth === 'loading') {
    base = <div className="px-4 py-3"><BrandMark size="sm" tagline="Starting…" /></div>;
  } else if (auth === 'out') {
    base = loggedOutView === 'forgot' ? (
      <div key="forgot" className="p-4 strip-cabinet-swap">
        <ForgotPasswordForm
          compact
          email={forgot.email}
          onEmailChange={forgot.onEmailChange}
          onSubmit={forgot.onSubmit}
          loading={forgot.loading}
          error={forgot.error}
          success={forgot.success}
          onBack={forgot.onBack}
        />
      </div>
    ) : (
      <div key="login" className="p-4 space-y-4 strip-cabinet-swap">
        <BrandMark size="sm" tagline="Log in to continue" />
        <LoginForm
          compact
          idPrefix="strip-login"
          email={login.email}
          password={login.password}
          onEmailChange={login.onEmailChange}
          onPasswordChange={login.onPasswordChange}
          onSubmit={login.onSubmit}
          loading={login.loading}
          error={login.error}
          notice={login.notice}
          onForgotPassword={login.onForgotPassword}
          onCreateAccount={login.onCreateAccount}
        />
      </div>
    );
  } else {
    // BAR2: the slot row = the container's slots + the built-in live-op and
    // update ones (their data already lives here).
    const liveOp = ops?.events?.find((ev) => isOpLive(ev)) || null;
    const slots = [
      ...(barSlots || []),
      liveOp && {
        id: 'live-op',
        priority: SLOT_PRIORITY.liveOp,
        minWidth: 84,
        grow: true,
        node: (
          <LiveOpChip event={liveOp} onOpen={() => {
            if (cabinet !== 'operations') onToggleCabinet('operations');
            if (opPanel && opPanel.target?.eventId !== liveOp.id) opPanel.open(liveOp, activeOrgId);
          }} />
        ),
      },
      update && {
        id: 'update',
        priority: SLOT_PRIORITY.update,
        minWidth: updateInstalling ? 92 : updateError ? 96 : 72,
        node: <UpdateChip update={update} installing={updateInstalling} error={updateError} onInstall={onInstallUpdate} />,
      },
    ].filter(Boolean);
    base = (
      <>
        <Bar
          activeOrg={activeOrg}
          activeOrgIndex={activeOrgIndex}
          cabinet={cabinet}
          onToggleCabinet={onToggleCabinet}
          grow={grow}
          badges={ops ? {
            operations: ops.badge && {
              kind: ops.badge.kind,
              count: ops.badge.count,
              label: ops.badge.kind === 'count' ? `${ops.badge.count} upcoming` : ops.badge.kind === 'live' ? 'live now' : 'starting soon',
            },
            notifications: ops.unreadCount > 0 && { kind: 'count', count: ops.unreadCount, label: `${ops.unreadCount} new` },
            channels: channelsBadge, // P2A
          } : { channels: channelsBadge }}
          slots={slots /* BAR2 */}
          channelsIcon={channelsIcon /* CH2 */}
        />
      </>
    );
  }

  let cabinetBody = null;
  if (shown) {
    const activeOrgForOps = orgs.find((o) => o.id === activeOrgId);
    if (ops && shown.id === 'operations') {
      cabinetBody = (
        <OpsCabinet
          ops={ops}
          orgId={activeOrgId}
          orgName={activeOrgForOps ? orgName(activeOrgForOps) : ''}
          selectedEventId={opPanel?.target?.eventId}
          onOpenEvent={(ev) => opPanel?.open(ev, activeOrgId)}
          onSchedule={opPanel ? (date) => opPanel.schedule(date) : null}
          onClose={onCloseCabinet}
          maxHeight={heights.cabinet}
          {...opsCabinetInitial}
        />
      );
    } else if (ops && shown.id === 'notifications') {
      cabinetBody = (
        <NotificationsCabinet
          ops={ops}
          onOpenEvent={(ev, evOrgId) => opPanel?.open(ev, evOrgId)}
          onClose={onCloseCabinet}
          maxHeight={heights.cabinet}
        />
      );
    } else cabinetBody = shown.id === 'server' ? (
      <ServerCabinet
        orgs={orgs}
        orgsLoading={orgsLoading}
        orgsError={orgsError}
        activeOrgId={activeOrgId}
        onSelectOrg={onSelectOrg}
        onClose={onCloseCabinet}
        resync={resync}
        onResyncEncryption={onResyncEncryption}
      />
    ) : (
      // P2C: maxHeight so Settings / Games size from the window like ops do.
      renderCabinet?.(shown.id, { onClose: onCloseCabinet, maxHeight: heights.cabinet })
        ?? <PlaceholderCabinet id={shown.id} onClose={onCloseCabinet} />
    );
  }

  const animClass = shown
    ? { enter: 'strip-cabinet-enter', swap: 'strip-cabinet-swap', exit: 'strip-cabinet-exit' }[shown.anim]
    : '';

  return (
    <div
      ref={rootRef}
      className={cx(
        'h-full flex p-1.5 gap-2 font-ui text-specter-text-main',
        grow === 'down' ? 'strip-grow-down flex-col-reverse justify-end' : 'strip-grow-up flex-col justify-end',
      )}
    >
      <div ref={originRef} aria-hidden="true" className="fixed left-0 top-0 w-0 h-0 pointer-events-none" />
      {showHint && !shown && !collapsed /* SV */ && <FirstRunHint onDismiss={onDismissHint} />}
      {/* SV: the stream viewer (fixed above the bar, or a row above the cabinet). */}
      {auth === 'in' && streamViewer?.({ mode: collapsed ? 'full' /* POLISH */ : panelOpen ? 'hidden' : shown || stackPanel ? 'mini' : 'full', bar, vw, vh, grow, onRegion: onRegionChange })}
      {/* POLISH: collapsed (SV) no longer closes the op panel / picker /
          cabinet: they stay mounted but invisible and out of the window region
          (data-region-off), and come back as they were on strip-shown. */}
      <div className="contents" data-region-off={collapsed ? '' : undefined} aria-hidden={collapsed || undefined}
        style={collapsed ? { visibility: 'hidden' } : undefined}>
        {/* P2B: the wide op panel (fixed-positioned; its own region rects). */}
        {panelOpen && <div key={opPanel.target.seq} className="contents">{opPanel.render(layoutFor)}</div>}
        {stackPanel /* P2A */}
      </div>
      {shown && (
        <div data-strip-region={panelOpen || collapsed ? undefined : ''} aria-hidden={collapsed || undefined}
          className={cx('strip-cabinet-slot', panelOpen && 'hidden', collapsed && 'invisible')}
          style={shown.id === 'channels' ? cabinetSlotStyle : undefined}
          onTransitionEnd={shown.id === 'channels' ? onCabinetSlotTransitionEnd : undefined}>
          <section key={shown.id} aria-label={shown.id === 'server' ? 'Servers' : CABINETS[shown.id].title}
            className={cx('strip-panel', animClass)}>
            {cabinetBody}
          </section>
        </div>
      )}
      {/* SV: collapsed keeps the bar's place (so the viewer doesn't move) but out of sight and the region. */}
      <div ref={barRef} data-strip-region={collapsed ? undefined : ''} aria-hidden={collapsed || undefined}
        className={cx('strip-panel overflow-hidden shrink-0', collapsed && 'invisible')}>
        {base}
      </div>
    </div>
  );
}
