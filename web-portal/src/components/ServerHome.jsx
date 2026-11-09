// ServerHome.jsx — Server landing page shown when an org is selected but no channel is active
//
// The ops calendar is owned entirely by the OPERATIONS pill in WarRoom.jsx's
// header (gated by `opsViewOpen`), rendered as a single inline panel
// regardless of whether this landing page or a channel is showing
// underneath — it does not render its own copy here.
import { cx, glassPanel } from './ui/styles';

// WarRoom also passes events/members/permission props; they're unused here
// since the ops calendar moved to the header.
export default function ServerHome({ org }) {
  return (
    <div className="flex-1 overflow-y-auto font-ui text-specter-text-main">
      {org?.banner_url && (
        <div className="relative w-full max-h-[150px] overflow-hidden flex-shrink-0">
          <img
            src={org.banner_url}
            alt="Server banner"
            className="block w-full h-[160px] object-cover"
          />
          <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg, rgba(2,8,16,0.08), rgba(2,8,16,0.72))' }} />
        </div>
      )}

      <div className="px-7 pt-6 pb-7">
        {org?.landing_description && (
          <section className="mb-4 max-w-[1100px]">
            <h2 className="mb-2 text-ui-xs font-semibold text-specter-text-subtle">Briefing and rules</h2>
            <div className={cx('rounded-ui-lg px-4 py-3.5 text-ui-base leading-relaxed text-specter-text-muted whitespace-pre-wrap', glassPanel)}>
              {org.landing_description}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
