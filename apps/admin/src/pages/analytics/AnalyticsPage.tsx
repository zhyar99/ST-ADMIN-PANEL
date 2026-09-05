import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import BoostsTab from './BoostsTab';
import OverviewTab from './OverviewTab';
import TrendingTab from './TrendingTab';

type Tab = 'overview' | 'trending' | 'boosts';

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'trending', label: 'Trending' },
  { id: 'boosts', label: 'Recommendation Boosts' },
];

/**
 * Device analytics (Phase 15).
 *
 * All three tabs are readable by a VIEWER — they describe the platform, not any
 * individual device. The per-device pages this section links to are ADMIN-only,
 * and a VIEWER who reaches one is sent back here with the notice below.
 */
export default function AnalyticsPage() {
  const [tab, setTab] = useState<Tab>('overview');
  const [periodDays, setPeriodDays] = useState(30);

  const location = useLocation();
  const navigate = useNavigate();

  /**
   * The message a redirected VIEWER arrives with.
   *
   * Rendered as a banner rather than a toast: this SPA has no toast host, and
   * one component's worth of feedback is not a reason to introduce one.
   */
  const notice = (location.state as { notice?: string } | null)?.notice;

  return (
    <div className="p-6">
      <header className="mb-5">
        <h1 className="text-lg font-semibold text-slate-100">Analytics</h1>
        <p className="mt-1 text-sm text-slate-400">
          Anonymous device activity, trending content and editorial ranking controls.
        </p>
      </header>

      {notice && (
        <div className="mb-4 flex items-center justify-between gap-4 rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-sm text-amber-200">
          <span>{notice}</span>
          <button
            type="button"
            onClick={() => navigate(location.pathname, { replace: true, state: null })}
            className="text-xs underline-offset-2 hover:underline"
          >
            Dismiss
          </button>
        </div>
      )}

      <div role="tablist" className="mb-5 flex gap-1 border-b border-slate-800">
        {TABS.map((entry) => {
          const isActive = entry.id === tab;
          return (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setTab(entry.id)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm transition ${
                isActive
                  ? 'border-slate-100 text-slate-100'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              {entry.label}
            </button>
          );
        })}
      </div>

      {tab === 'overview' && (
        <OverviewTab periodDays={periodDays} onPeriodChange={setPeriodDays} />
      )}
      {tab === 'trending' && <TrendingTab />}
      {tab === 'boosts' && <BoostsTab />}
    </div>
  );
}
