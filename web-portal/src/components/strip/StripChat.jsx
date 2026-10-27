import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertCircle, Hash, Loader2, Send, X } from 'lucide-react';
import { IconButton } from '../ui';
import { cx, focusRing } from '../ui/styles';
import { fmtDayLabel, fmtTime } from '../../utils/format';

// The strip's text chat (P2A, feedback #4), the pane of the widened Channels
// cabinet. Presentational over plaintext rows: the engine owns MLS, decrypts
// and encrypts (src/engine/useChannelChat.js), and talks to this over the
// bridge — rows arrive as engine-chat, sends go out as chat.send.
//
// Sending: the text shows at once as a pending bubble and the box clears; the
// engine's own optimistic insert then arrives as a real row and the pending
// one goes away when chat.send acks. On failure nothing was sent: the text
// comes back into the box (unless something new was typed) with the error.
//
// Deferred (still only in the engine's own TextChat): report-to-admin, the
// external-link warning (links render as plain text here), image lightbox.

/**
 * channel      { id, name }
 * chat         engine-chat for this channel { loading, rows } or null (not yet)
 * onSend(text) → Promise (rejects with the send error)
 * onClose()
 */
export default function StripChat({ channel, chat, onSend, onClose, initialInput = '', initialError = null, initialPending = [] }) {
  const [input, setInput] = useState(initialInput);
  const [pending, setPending] = useState(initialPending); // [{ key, text }]
  const [error, setError] = useState(initialError);
  const scrollRef = useRef(null);
  const atBottomRef = useRef(true);
  const inputRef = useRef(null);
  const rows = chat?.rows || [];
  const loading = !chat || (chat.loading && !rows.length);

  useEffect(() => { inputRef.current?.focus(); }, [channel.id]);

  // Stick to the bottom unless the user scrolled up to read.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [rows.length, pending.length, loading]);
  // The pane grows while the cabinet's height animates: stay pinned then too.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => { if (atBottomRef.current) el.scrollTop = el.scrollHeight; });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const onScroll = () => {
    const el = scrollRef.current;
    if (el) atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const submit = (e) => {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setPending((p) => [...p, { key, text }]);
    setInput('');
    setError(null);
    atBottomRef.current = true;
    Promise.resolve(onSend?.(text)).then(
      () => setPending((p) => p.filter((x) => x.key !== key)),
      (err) => {
        setPending((p) => p.filter((x) => x.key !== key));
        setInput((cur) => (cur ? cur : text));
        setError(err?.message || 'Message failed to send. Try again.');
      },
    );
  };

  let lastDay = null;
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex items-center gap-2 px-4 pt-3 pb-2 border-b border-specter-border-divider">
        <Hash size={16} aria-hidden="true" className="shrink-0 text-specter-primary-neon" />
        <h2 className="flex-1 min-w-0 truncate text-ui-lg font-semibold text-specter-text-main">{channel.name}</h2>
        <IconButton icon={<X size={16} />} label="Close chat" size="sm" onClick={onClose} />
      </div>
      <div ref={scrollRef} onScroll={onScroll} className="strip-scroll min-h-0 flex-1 px-3 py-2 select-text" aria-live="polite">
        {loading && (
          <p className="py-8 flex items-center justify-center gap-2 text-ui-sm text-specter-text-subtle">
            <Loader2 size={14} aria-hidden="true" className="animate-spin" />Loading messages…
          </p>
        )}
        {!loading && !rows.length && !pending.length && (
          <p className="py-8 text-center text-ui-sm text-specter-text-subtle">No messages yet. Say hello.</p>
        )}
        {rows.map((m) => {
          const day = fmtDayLabel(m.timestamp);
          const divider = day !== lastDay;
          lastDay = day;
          return (
            <Fragment key={m.id}>
              {divider && (
                <div className="my-2 flex items-center gap-2 text-ui-xs text-specter-text-subtle" aria-hidden="true">
                  <span className="h-px flex-1 bg-specter-border-divider" />{day}<span className="h-px flex-1 bg-specter-border-divider" />
                </div>
              )}
              <div className="py-1">
                <div className="flex items-baseline gap-2">
                  <span className={cx('truncate text-ui-sm font-semibold', m.mine ? 'text-specter-primary-neon' : 'text-specter-text-main')}>
                    {m.callsign || 'Unknown'}
                  </span>
                  <span className="shrink-0 text-ui-xs tabular-nums text-specter-text-subtle">{fmtTime(m.timestamp)}</span>
                </div>
                {m.text != null ? (
                  <p className="text-ui-sm text-specter-text-muted whitespace-pre-wrap break-words">{m.text}</p>
                ) : (
                  // MR2: not readable yet — the engine retries on key changes
                  // and a peer's backfill replaces it. Never a blank row.
                  <p className="text-ui-sm italic text-specter-text-subtle" title="This message will appear once this device has its key">
                    Waiting for key…
                  </p>
                )}
                {m.imageUrl && (
                  <img src={m.imageUrl} alt="Attachment" loading="lazy"
                    className="mt-1 max-w-[240px] max-h-[180px] rounded-ui-sm border border-specter-border object-contain" />
                )}
              </div>
            </Fragment>
          );
        })}
        {pending.map((p) => (
          <div key={p.key} className="py-1 opacity-60" aria-label="Sending">
            <div className="flex items-baseline gap-2">
              <span className="text-ui-sm font-semibold text-specter-primary-neon">You</span>
              <span className="inline-flex items-center gap-1 text-ui-xs text-specter-text-subtle">
                <Loader2 size={11} aria-hidden="true" className="animate-spin" />Sending…
              </span>
            </div>
            <p className="text-ui-sm text-specter-text-muted whitespace-pre-wrap break-words">{p.text}</p>
          </div>
        ))}
      </div>
      {error && (
        <div role="alert" className="flex items-start gap-1.5 px-4 py-1.5 border-t border-specter-state-error/30 bg-specter-state-error/10 text-ui-xs text-red-300">
          <AlertCircle size={13} aria-hidden="true" className="shrink-0 mt-px" />
          <span className="flex-1 min-w-0">{error}</span>
          <button type="button" onClick={() => setError(null)} className={cx('shrink-0 text-red-300/80 hover:text-red-200', focusRing)} aria-label="Dismiss">
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      )}
      <form onSubmit={submit} className="flex items-center gap-2 px-3 py-2.5 border-t border-specter-border-divider">
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => { setInput(e.target.value); if (error) setError(null); }}
          placeholder={`Message #${channel.name}`}
          maxLength={4000}
          aria-label={`Message #${channel.name}`}
          className={cx(
            'flex-1 min-w-0 h-9 px-3 rounded-ui-row text-ui-sm text-specter-text-main placeholder:text-specter-text-subtle',
            'bg-specter-bg-deep/60 border border-specter-border hover:border-specter-border-strong focus:border-specter-primary-cyan focus:outline-none',
          )}
        />
        <IconButton type="submit" icon={<Send size={16} />} label="Send" disabled={!input.trim()} />
      </form>
    </div>
  );
}
