// BRAND: the SpecterComs UI icon pack (24×24, 2px stroke, currentColor) as
// inline-SVG React components with Lucide-like props, so they drop in next to
// lucide-react icons. The source SVGs sit beside this file; this file is
// generated from them (keep the two in sync if an icon changes).
//
// Props: size (24), color ('currentColor'), strokeWidth (2), className,
// aria-label (sets role="img"; otherwise the icon is aria-hidden), and any
// other SVG attribute.

import { forwardRef } from 'react';

function makeIcon(displayName, body) {
  const Icon = forwardRef(function Icon(
    { size = 24, color = 'currentColor', strokeWidth = 2, className, 'aria-label': ariaLabel, 'aria-hidden': ariaHidden, children, ...rest },
    ref,
  ) {
    return (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        color={color === 'currentColor' ? undefined : color}
        role={ariaLabel ? 'img' : undefined}
        aria-label={ariaLabel}
        aria-hidden={ariaLabel ? ariaHidden : (ariaHidden ?? true)}
        {...rest}
      >
        {body}
        {children}
      </svg>
    );
  });
  Icon.displayName = displayName;
  return Icon;
}

export const ScChannels = makeIcon('ScChannels', (
  <>
    <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/>
    <path d="M8.7 8.7a4.7 4.7 0 0 0 0 6.6"/>
    <path d="M15.3 8.7a4.7 4.7 0 0 1 0 6.6"/>
    <path d="M5.8 5.8a8.8 8.8 0 0 0 0 12.4"/>
    <path d="M18.2 5.8a8.8 8.8 0 0 1 0 12.4"/>
  </>
));

export const ScDeafened = makeIcon('ScDeafened', (
  <>
    <path d="M4 14v-3a8 8 0 0 1 13-6.2"/>
    <path d="M20 11v3"/>
    <rect x="3" y="13" width="4" height="7" rx="2"/>
    <rect x="17" y="13" width="4" height="7" rx="2"/>
    <path d="M3 3l18 18"/>
  </>
));

export const ScEncryptedVerified = makeIcon('ScEncryptedVerified', (
  <>
    <path d="M12 2.5 20 6v5.3c0 4.9-3.1 8.4-8 10.2-4.9-1.8-8-5.3-8-10.2V6Z"/>
    <rect x="9" y="11" width="6" height="5.2" rx="1"/>
    <path d="M10.5 11V9.4a1.5 1.5 0 0 1 3 0V11"/>
  </>
));

export const ScFriends = makeIcon('ScFriends', (
  <>
    <circle cx="9" cy="8" r="3"/>
    <path d="M3.5 20v-2a5.5 5.5 0 0 1 11 0v2"/>
    <path d="M16 5.4a3 3 0 0 1 0 5.7M18 14a4.5 4.5 0 0 1 2.5 4v2"/>
  </>
));

export const ScGameHud = makeIcon('ScGameHud', (
  <>
    <rect x="3" y="4" width="18" height="16" rx="3"/>
    <path d="M12 7v3M12 14v3M7 12h3M14 12h3"/>
    <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/>
  </>
));

export const ScMicMuted = makeIcon('ScMicMuted', (
  <>
    <path d="M9 8v4a3 3 0 0 0 5.7 1.2M15 8V6a3 3 0 0 0-5.7-1.3"/>
    <path d="M6 11a6 6 0 0 0 10.5 4M12 17v4M8 21h8M3 3l18 18"/>
  </>
));

export const ScMicOn = makeIcon('ScMicOn', (
  <>
    <rect x="9" y="3" width="6" height="12" rx="3"/>
    <path d="M6 11a6 6 0 0 0 12 0M12 17v4M8 21h8"/>
  </>
));

export const ScNotifications = makeIcon('ScNotifications', (
  <>
    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/>
    <path d="M10 21h4"/>
    <circle cx="19" cy="4.4" r="2.4" fill="currentColor" stroke="none"/>
  </>
));

export const ScOperationTree = makeIcon('ScOperationTree', (
  <>
    <rect x="9" y="2.5" width="6" height="5" rx="1"/>
    <rect x="2" y="17" width="6" height="4.5" rx="1"/>
    <rect x="9" y="17" width="6" height="4.5" rx="1"/>
    <rect x="16" y="17" width="6" height="4.5" rx="1"/>
    <path d="M12 7.5V12M5 17v-5h14v5M12 12v5"/>
  </>
));

export const ScOperations = makeIcon('ScOperations', (
  <>
    <rect x="3" y="4.5" width="18" height="16" rx="2"/>
    <path d="M7 3v4M17 3v4M3 9h18"/>
    <circle cx="14.8" cy="15.1" r="3.1"/>
    <path d="M14.8 13.6v1.7l1.3.8"/>
  </>
));

export const ScPushToTalk = makeIcon('ScPushToTalk', (
  <>
    <rect x="3" y="4" width="18" height="16" rx="3"/>
    <rect x="10" y="7" width="4" height="7" rx="2"/>
    <path d="M7.5 11a4.5 4.5 0 0 0 9 0M12 15.5v2"/>
  </>
));

export const ScRecord = makeIcon('ScRecord', (
  <>
    <circle cx="12" cy="12" r="9"/>
    <circle cx="12" cy="12" r="4.2" fill="currentColor" stroke="none"/>
  </>
));

export const ScScreenShare = makeIcon('ScScreenShare', (
  <>
    <rect x="3" y="4" width="18" height="15" rx="2"/>
    <path d="M9 21h6M12 19v2M9 14l6-6M11 8h4v4"/>
  </>
));

export const ScServerSwitch = makeIcon('ScServerSwitch', (
  <>
    <rect x="3" y="3" width="12" height="6" rx="2"/>
    <rect x="3" y="12" width="12" height="6" rx="2"/>
    <path d="M6.5 6h.01M6.5 15h.01M17 11l4 4-4 4M21 15h-4"/>
  </>
));

export const ScSettings = makeIcon('ScSettings', (
  <>
    <circle cx="12" cy="12" r="3"/>
    <path d="M12 2.6v2M12 19.4v2M2.6 12h2M19.4 12h2M5.35 5.35l1.42 1.42M17.23 17.23l1.42 1.42M18.65 5.35l-1.42 1.42M6.77 17.23l-1.42 1.42"/>
  </>
));

export const ScStandbyOffline = makeIcon('ScStandbyOffline', (
  <>
    <path d="M12 2.8v9.6"/>
    <path d="M7 5.8a8 8 0 1 0 10 0"/>
  </>
));

export const ScStreamingLive = makeIcon('ScStreamingLive', (
  <>
    <rect x="3" y="5" width="17" height="13" rx="2"/>
    <path d="M9 18v3M14 18v3M7 21h9"/>
    <path d="m10 9 4 2.5-4 2.5z"/>
    <path d="M21.2 3.5v3M19.7 5h3"/>
  </>
));

export const ScUnverified = makeIcon('ScUnverified', (
  <>
    <path d="M12 2.5 20 6v5.3c0 4.9-3.1 8.4-8 10.2-4.9-1.8-8-5.3-8-10.2V6Z"/>
    <path d="m9 10 6 6m0-6-6 6"/>
  </>
));

export const ScVoiceActive = makeIcon('ScVoiceActive', (
  <>
    <path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4"/>
  </>
));

export const ScWaitingForKey = makeIcon('ScWaitingForKey', (
  <>
    <circle cx="8" cy="12" r="4"/>
    <path d="M11 14.6 14 17.5h2v2h2v-2h2.5"/>
    <path d="M16.8 4.2a4.4 4.4 0 0 1 4.2 4.4"/>
    <path d="M21 6v2.6h-2.6"/>
  </>
));

export const ScWatchingStream = makeIcon('ScWatchingStream', (
  <>
    <rect x="2.5" y="4" width="19" height="15" rx="2"/>
    <path d="M9 21h6M12 19v2"/>
    <path d="M6.8 11.7S9 9 12 9s5.2 2.7 5.2 2.7S15 14.4 12 14.4s-5.2-2.7-5.2-2.7Z"/>
    <circle cx="12" cy="11.7" r="1"/>
  </>
));
