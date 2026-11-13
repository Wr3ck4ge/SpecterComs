import { AlertTriangle, MessageSquare } from 'lucide-react';
import { SLOT_PRIORITY } from './barSlots';
import { SlotChip } from './StripBarSlots';

/**
 * NET: the bar's "Voice can't connect" chip, shown while CommLink reports a
 * classified connect problem (state.voice.connectIssue). Opens Settings on the
 * Repair panel. Ranks right after the speaker chip, so it stays visible.
 */
export function repairSlot(issue, onOpen) {
  const label = `${issue.message} Run Repair`;
  return {
    id: 'voice-repair',
    priority: SLOT_PRIORITY.speaker + 5,
    minWidth: 116,
    node: (
      <SlotChip tone="warn" onClick={onOpen} label={label} title={label} icon={<AlertTriangle size={12} />}>
        Can&apos;t connect: Repair
      </SlotChip>
    ),
  };
}

/**
 * The owner replied to one of this user's bug reports. Opens Settings on
 * About & diagnostics, where "Your reports" shows the reply.
 */
export function bugReplySlot(unread, onOpen) {
  const label = `The SpecterComs team replied to your bug report${unread === 1 ? '' : 's'}. Open Settings → About & diagnostics.`;
  return {
    id: 'bug-report-reply',
    priority: SLOT_PRIORITY.update + 1,
    minWidth: 84,
    node: (
      <SlotChip tone="accent" onClick={onOpen} label={label} title={label} icon={<MessageSquare size={12} />}>
        {unread === 1 ? 'Reply' : `${unread} replies`}
      </SlotChip>
    ),
  };
}

/**
 * S3: the bar's "Encryption out of sync" chip, shown while the engine reports
 * stuck MLS groups (state.mls.stuck). Detection only: it opens Settings on
 * About & diagnostics, where Resync encryption lives.
 */
export function encryptionSyncSlot(stuck, onOpen, repairing = []) {
  const n = stuck.length;
  // S4: an automatic repair ladder is running for one of them.
  const busy = Array.isArray(repairing) && repairing.some((id) => stuck.includes(id));
  const label = busy
    ? `Repairing encryption on this device (${n} group${n === 1 ? '' : 's'} out of sync). Open Settings → About & diagnostics.`
    : `Encryption out of sync on this device (${n} group${n === 1 ? '' : 's'}): messages or audio can't be decrypted. Open Settings → About & diagnostics → Resync encryption.`;
  return {
    id: 'mls-out-of-sync',
    priority: SLOT_PRIORITY.speaker + 6,
    minWidth: 132,
    node: (
      <SlotChip tone="warn" onClick={onOpen} label={label} title={label} icon={<AlertTriangle size={12} />}>
        {busy ? 'Repairing encryption…' : 'Encryption out of sync'}
      </SlotChip>
    ),
  };
}
