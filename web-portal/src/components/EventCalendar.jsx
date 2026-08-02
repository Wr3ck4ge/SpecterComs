// EventCalendar.jsx â€” Org event calendar with RSVP
import React, { useState, useEffect } from 'react';
import { api } from '../api';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function formatDate(iso) {
  const d = new Date(iso);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function isToday(iso) {
  const d = new Date(iso), now = new Date();
  return d.getDate() === now.getDate() && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
}

function isUpcoming(iso) {
  return new Date(iso) > new Date();
}

export default function EventCalendar({ org, onClose }) {
  const [events, setEvents]         = useState([]);
  const [loading, setLoading]       = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm]             = useState({ name: '', start_time: '', end_time: '' });
  const [msg, setMsg]               = useState(null);
  const [rsvpd, setRsvpd]           = useState(new Set());
  const [expanded, setExpanded]     = useState(false);

  useEffect(() => {
    fetchEvents();
  }, [org.id]);

  const fetchEvents = () => {
    setLoading(true);
    api.getOrgEvents(org.id).then(({ data, error }) => {
      setLoading(false);
      if (!error && data?.events) setEvents(data.events);
    });
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    setMsg(null);
    const { data, error } = await api.createOrgEvent(org.id, {
      name:       form.name,
      start_time: new Date(form.start_time).toISOString(),
      end_time:   new Date(form.end_time).toISOString(),
    });
    if (error) return setMsg({ type: 'error', text: error });
    setEvents(prev => [...prev, data.event].sort((a, b) => new Date(a.start_time) - new Date(b.start_time)));
    setMsg({ type: 'success', text: `"${data.event.name}" scheduled.` });
    setShowCreate(false);
    setForm({ name: '', start_time: '', end_time: '' });
  };

  const handleRsvp = async (evId) => {
    const { error } = await api.rsvpEvent(org.id, evId);
    if (!error) setRsvpd(prev => new Set(prev).add(evId));
  };

  const upcomingEvents = events.filter(e => isUpcoming(e.start_time));
  const pastEvents     = events.filter(e => !isUpcoming(e.start_time));

  return (
    <div className="bg-specter-bg-panel border border-specter-primary-dim rounded-lg flex flex-col overflow-hidden">
      {/* Header â€” always visible */}
      <div className="px-3 py-2 border-b border-specter-primary-dim flex items-center gap-2">
        <span className="text-specter-primary-cyan font-mono text-xs font-bold tracking-widest uppercase flex-1">
          [ Calendar ]
        </span>
        {upcomingEvents.length > 0 && !expanded && (
          <span className="text-xs font-mono text-specter-primary-dim border border-specter-primary-dim/50 rounded px-1.5">
            {upcomingEvents.length} op{upcomingEvents.length !== 1 ? 's' : ''}
          </span>
        )}
        {expanded && (
          <button
            onClick={() => { setShowCreate(!showCreate); setMsg(null); }}
            className="text-xs font-mono text-specter-primary-cyan border border-specter-primary-dim rounded px-2 py-0.5 hover:border-specter-primary-cyan transition-colors">
            {showCreate ? 'Cancel' : '+ Schedule'}
          </button>
        )}
        <button
          onClick={() => { setExpanded(e => !e); setShowCreate(false); }}
          className="text-xs font-mono text-specter-text-muted hover:text-specter-primary-cyan transition-colors"
        >
          {expanded ? 'â–² FOLD' : 'â–¼ OPEN'}
        </button>
        {onClose && (
          <button onClick={onClose} className="text-specter-text-muted hover:text-white font-mono text-xs">âœ•</button>
        )}
      </div>

      {/* Collapsed: compact upcoming preview */}
      {!expanded && (
        <div className="p-2 space-y-1">
          {loading && <div className="text-specter-text-muted text-xs text-center py-2">Loading...</div>}
          {!loading && upcomingEvents.length === 0 && (
            <div className="text-specter-text-muted text-xs text-center py-2 italic">No ops scheduled.</div>
          )}
          {upcomingEvents.slice(0, 3).map(ev => {
            const today = isToday(ev.start_time);
            return (
              <div key={ev.id} className="flex items-center gap-2 py-1.5 border-b border-specter-primary-dim/20 last:border-0">
                <div className={`w-0.5 self-stretch rounded-full flex-shrink-0 ${today ? 'bg-specter-state-success' : 'bg-specter-primary-dim'}`} style={{ minHeight: 20 }} />
                <div className="flex-1 min-w-0">
                  <div className="text-white font-mono text-xs font-semibold truncate">{ev.name}</div>
                  <div className="text-specter-text-muted text-xs font-mono">
                    {new Date(ev.start_time).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    {' Â· '}
                    {new Date(ev.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
                <button
                  onClick={() => handleRsvp(ev.id)}
                  disabled={rsvpd.has(ev.id)}
                  className={`flex-shrink-0 px-1.5 py-0.5 text-xs font-mono rounded border transition-colors ${
                    rsvpd.has(ev.id)
                      ? 'border-green-700 text-green-400 bg-green-950/30 cursor-default'
                      : 'border-specter-primary-dim text-specter-primary-cyan hover:border-specter-primary-cyan'
                  }`}>
                  {rsvpd.has(ev.id) ? 'âœ“' : 'RSVP'}
                </button>
              </div>
            );
          })}
          {upcomingEvents.length > 3 && (
            <button onClick={() => setExpanded(true)} className="text-xs text-specter-text-muted hover:text-specter-primary-cyan transition-colors font-mono w-full text-left pt-0.5">
              +{upcomingEvents.length - 3} more â€” expand
            </button>
          )}
        </div>
      )}

      {/* Expanded: full view */}
      {expanded && (
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Alert */}
          {msg && (
            <div className={`border rounded px-3 py-2 text-xs font-mono ${
              msg.type === 'error' ? 'bg-red-950 border-red-700 text-red-300' : 'bg-green-950 border-green-700 text-green-300'
            }`}>{msg.text}</div>
          )}

          {/* Create Form */}
          {showCreate && (
            <form onSubmit={handleCreate} className="bg-black/50 border border-specter-primary-dim rounded p-4 space-y-3">
              <div className="text-xs text-specter-primary-cyan uppercase tracking-wider">New Operation</div>
              <input
                className="w-full bg-black border border-specter-primary-dim rounded px-3 py-1.5 text-sm font-mono text-white focus:outline-none focus:border-specter-primary-cyan"
                placeholder="Operation name"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                required
              />
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-xs text-specter-text-muted mb-1 font-mono uppercase">Start Time</div>
                  <input type="datetime-local"
                    className="w-full bg-black border border-specter-primary-dim rounded px-2 py-1.5 text-xs font-mono text-white focus:outline-none focus:border-specter-primary-cyan"
                    value={form.start_time}
                    onChange={e => setForm(f => ({ ...f, start_time: e.target.value }))}
                    required
                  />
                </div>
                <div>
                  <div className="text-xs text-specter-text-muted mb-1 font-mono uppercase">End Time</div>
                  <input type="datetime-local"
                    className="w-full bg-black border border-specter-primary-dim rounded px-2 py-1.5 text-xs font-mono text-white focus:outline-none focus:border-specter-primary-cyan"
                    value={form.end_time}
                    onChange={e => setForm(f => ({ ...f, end_time: e.target.value }))}
                    required
                  />
                </div>
              </div>
              <button type="submit"
                className="w-full py-2 bg-specter-primary-cyan text-specter-bg-surface font-mono font-bold text-xs rounded uppercase tracking-wider hover:bg-specter-primary-neon transition-colors">
                Broadcast Schedule
              </button>
            </form>
          )}

          {loading && <div className="text-specter-text-muted text-xs text-center py-6">Loading calendar...</div>}

          {/* Upcoming */}
          {upcomingEvents.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs text-specter-state-success uppercase tracking-widest">
                Upcoming â€” {upcomingEvents.length}
              </div>
              {upcomingEvents.map(ev => (
                <EventCard key={ev.id} ev={ev} rsvpd={rsvpd} onRsvp={handleRsvp} />
              ))}
            </div>
          )}

          {!loading && upcomingEvents.length === 0 && (
            <div className="text-center text-specter-text-muted text-xs py-6 border border-dashed border-specter-primary-dim rounded">
              No upcoming operations scheduled.
            </div>
          )}

          {/* Past */}
          {pastEvents.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs text-specter-text-muted uppercase tracking-widest">Past Operations</div>
              {pastEvents.slice(0, 5).map(ev => (
                <EventCard key={ev.id} ev={ev} rsvpd={rsvpd} past />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function EventCard({ ev, rsvpd, onRsvp, past = false }) {
  const today   = isToday(ev.start_time);
  return (
    <div className={`border rounded p-3 transition-colors ${
      past
        ? 'border-specter-primary-dim/30 bg-black/20 opacity-60'
        : today
          ? 'border-specter-state-success/60 bg-green-950/20'
          : 'border-specter-primary-dim bg-specter-bg-surface hover:border-specter-primary-cyan'
    }`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            {today && <span className="text-xs font-mono uppercase text-green-400 border border-green-700 rounded px-1">Today</span>}
            <span className="text-white font-mono text-sm font-semibold truncate">{ev.name}</span>
          </div>
          <div className="text-specter-text-muted text-xs font-mono">
            ðŸ•’ {formatDate(ev.start_time)}
            {ev.end_time && <span className="text-specter-text-muted/60"> â†’ {formatDate(ev.end_time)}</span>}
          </div>
          {ev.rsvp_count > 0 && (
            <div className="text-xs text-specter-primary-dim font-mono mt-1">
              {ev.rsvp_count} member{ev.rsvp_count !== 1 ? 's' : ''} attending
            </div>
          )}
        </div>
        {!past && (
          <button
            onClick={() => onRsvp?.(ev.id)}
            disabled={rsvpd.has(ev.id)}
            className={`flex-shrink-0 px-2 py-1 text-xs font-mono rounded border transition-colors ${
              rsvpd.has(ev.id)
                ? 'border-green-700 text-green-400 bg-green-950/30 cursor-default'
                : 'border-specter-primary-dim text-specter-primary-cyan hover:border-specter-primary-cyan hover:bg-specter-primary-dim/20'
            }`}>
            {rsvpd.has(ev.id) ? 'âœ“ Listed' : 'RSVP'}
          </button>
        )}
      </div>
    </div>
  );
}
