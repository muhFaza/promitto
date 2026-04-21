import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../api/client';
import * as schedulerApi from '../api/scheduler';
import { EditScheduleModal } from '../components/EditScheduleModal';
import { AppHeader } from '../components/ui/AppHeader';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Spinner } from '../components/ui/Spinner';
import { formatInZone } from '../lib/dates';
import type { ScheduledMessage, SentMessage } from '../lib/types';
import { useAuthStore } from '../stores/auth';
import { useUiStore } from '../stores/ui';

type TabStatus = 'upcoming' | 'recurring' | 'history' | 'failed';

const TAB_LABELS: Record<TabStatus, string> = {
  upcoming: 'Upcoming',
  recurring: 'Recurring',
  history: 'History',
  failed: 'Failed',
};

const TAB_IDS = Object.keys(TAB_LABELS) as TabStatus[];

export function Schedule() {
  const user = useAuthStore((s) => s.user);
  const pushToast = useUiStore((s) => s.pushToast);

  const [tab, setTab] = useState<TabStatus>('upcoming');
  const [scheduled, setScheduled] = useState<ScheduledMessage[]>([]);
  const [sent, setSent] = useState<SentMessage[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [editingMessage, setEditingMessage] = useState<ScheduledMessage | null>(null);

  const tz = user?.timezone ?? 'UTC';

  const loadTab = useCallback(
    async (t: TabStatus) => {
      setListLoading(true);
      try {
        const r = await schedulerApi.list(t);
        if (r.kind === 'scheduled') {
          setScheduled(r.items);
          setSent([]);
        } else {
          setSent(r.items);
          setScheduled([]);
        }
      } catch (err) {
        pushToast({
          message: err instanceof ApiError ? err.message : 'Failed to load',
          level: 'error',
        });
      } finally {
        setListLoading(false);
      }
    },
    [pushToast],
  );

  useEffect(() => {
    void loadTab(tab);
  }, [loadTab, tab]);

  async function handleCancel(id: string) {
    if (!confirm('Cancel this promise? History remains.')) return;
    try {
      await schedulerApi.cancel(id);
      pushToast({ message: 'Cancelled', level: 'success' });
      void loadTab(tab);
    } catch (err) {
      pushToast({
        message: err instanceof ApiError ? err.message : 'Cancel failed',
        level: 'error',
      });
    }
  }

  const tabRefs = useRef<Record<TabStatus, HTMLButtonElement | null>>({
    upcoming: null,
    recurring: null,
    history: null,
    failed: null,
  });

  function onTabKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const idx = TAB_IDS.indexOf(tab);
    let nextIdx = idx;
    if (e.key === 'ArrowRight') nextIdx = (idx + 1) % TAB_IDS.length;
    else if (e.key === 'ArrowLeft') nextIdx = (idx - 1 + TAB_IDS.length) % TAB_IDS.length;
    else if (e.key === 'Home') nextIdx = 0;
    else if (e.key === 'End') nextIdx = TAB_IDS.length - 1;
    else return;
    e.preventDefault();
    const next = TAB_IDS[nextIdx];
    setTab(next);
    tabRefs.current[next]?.focus();
  }

  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-5xl px-6 pb-24 pt-10">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="eyebrow">The ledger</div>
            <h1 className="mt-2 font-display text-4xl italic leading-none text-ink sm:text-[44px]">
              Scheduled promises
            </h1>
            <p className="mt-3 max-w-md text-sm text-ink-soft">
              Review, cancel, audit.{' '}
              <span className="font-mono text-[12px] text-ink-muted">· {tz}</span>
            </p>
          </div>
          <Link to="/app#compose">
            <Button variant="secondary">+ Compose a new one</Button>
          </Link>
        </header>

        <nav className="mt-10 border-b border-rule">
          <div
            role="tablist"
            aria-label="Schedule sections"
            onKeyDown={onTabKeyDown}
            className="flex flex-wrap"
          >
            {TAB_IDS.map((t) => {
              const active = tab === t;
              return (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  id={`schedule-tab-${t}`}
                  aria-selected={active}
                  aria-controls={`schedule-panel-${t}`}
                  tabIndex={active ? 0 : -1}
                  ref={(el) => {
                    tabRefs.current[t] = el;
                  }}
                  onClick={() => setTab(t)}
                  className={
                    active
                      ? 'relative -mb-px border-b-2 border-ink px-4 py-3 text-[11px] font-medium uppercase tracking-caps text-ink'
                      : 'px-4 py-3 text-[11px] font-medium uppercase tracking-caps text-ink-muted transition-colors hover:text-ink'
                  }
                >
                  {TAB_LABELS[t]}
                </button>
              );
            })}
          </div>
        </nav>

        <section
          className="mt-0"
          role="tabpanel"
          id={`schedule-panel-${tab}`}
          aria-labelledby={`schedule-tab-${tab}`}
        >
          {listLoading ? (
            <div className="flex items-center justify-center p-16 text-ink-muted">
              <Spinner size={24} />
            </div>
          ) : tab === 'upcoming' || tab === 'recurring' ? (
            scheduled.length === 0 ? (
              <EmptyState
                label={`No ${TAB_LABELS[tab].toLowerCase()} promises.`}
                sub="Compose one on the dashboard."
              />
            ) : (
              <ScheduledTable
                rows={scheduled}
                tz={tz}
                onEdit={setEditingMessage}
                onCancel={handleCancel}
              />
            )
          ) : sent.length === 0 ? (
            <EmptyState
              label={`No ${TAB_LABELS[tab].toLowerCase()} yet.`}
              sub=""
            />
          ) : (
            <SentTable rows={sent} tz={tz} />
          )}
        </section>
      </main>
      <EditScheduleModal
          message={editingMessage}
          timezone={tz}
          onClose={() => setEditingMessage(null)}
          onSaved={() => {
            setEditingMessage(null);
            void loadTab(tab);
          }}
        />
    </>
  );
}

function EmptyState({ label, sub }: { label: string; sub: string }) {
  return (
    <div className="border-b border-rule px-6 py-16 text-center">
      <div className="font-display text-xl italic text-ink">{label}</div>
      {sub && <div className="eyebrow mt-2">{sub}</div>}
    </div>
  );
}

function ScheduledTable({
  rows,
  tz,
  onEdit,
  onCancel,
}: {
  rows: ScheduledMessage[];
  tz: string;
  onEdit: (row: ScheduledMessage) => void;
  onCancel: (id: string) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="border-b border-rule">
            <th className="eyebrow px-4 py-3 text-left">Recipient</th>
            <th className="eyebrow px-4 py-3 text-left">Message</th>
            <th className="eyebrow px-4 py-3 text-left">Next run</th>
            <th className="eyebrow px-4 py-3 text-left">State</th>
            <th className="eyebrow px-4 py-3 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              className="border-b border-rule/60 transition-colors hover:bg-paper-raised"
            >
              <td className="px-4 py-4 align-top">
                <div className="font-medium text-ink">
                  {r.recipientNameSnapshot}
                </div>
                <div className="font-mono text-[11px] text-ink-muted">
                  {r.recipientJid}
                </div>
              </td>
              <td className="max-w-xs px-4 py-4 align-top text-ink-soft">
                <div className="truncate">{r.messageText}</div>
              </td>
              <td className="px-4 py-4 align-top font-mono text-[12px] text-ink-soft">
                {formatInZone(r.nextRunAt, tz)}
                {r.cronExpression && (
                  <div className="mt-0.5 text-[11px] text-accent">
                    {r.cronExpression}
                  </div>
                )}
              </td>
              <td className="px-4 py-4 align-top">
                {r.retryCount > 0 ? (
                  <Badge tone="warning">
                    retry {r.retryCount} / 3
                  </Badge>
                ) : r.lastStatus === 'sent' ? (
                  <Badge tone="success">sent</Badge>
                ) : r.lastStatus === 'failed' ? (
                  <Badge tone="danger">failed</Badge>
                ) : (
                  <Badge tone="neutral">pending</Badge>
                )}
                {r.lastError && r.retryCount > 0 && (
                  <div className="mt-1.5 max-w-[220px] truncate text-[12px] text-accent-warm">
                    {r.lastError}
                  </div>
                )}
              </td>
              <td className="px-4 py-4 text-right align-top">
                <div className="flex items-center justify-end gap-2">
                  <Button variant="ghost" onClick={() => onEdit(r)}>
                    Edit
                  </Button>
                  <Button variant="ghost" onClick={() => onCancel(r.id)}>
                    Cancel
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SentTable({ rows, tz }: { rows: SentMessage[]; tz: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="border-b border-rule">
            <th className="eyebrow px-4 py-3 text-left">Recipient</th>
            <th className="eyebrow px-4 py-3 text-left">Message</th>
            <th className="eyebrow px-4 py-3 text-left">At</th>
            <th className="eyebrow px-4 py-3 text-left">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              className="border-b border-rule/60 transition-colors hover:bg-paper-raised"
            >
              <td className="px-4 py-4 align-top font-mono text-[11px] text-ink-soft">
                {r.recipientJid}
              </td>
              <td className="max-w-xs px-4 py-4 align-top text-ink-soft">
                <div className="truncate">{r.messageTextSnapshot}</div>
              </td>
              <td className="px-4 py-4 align-top font-mono text-[12px] text-ink-soft">
                {formatInZone(r.sentAt, tz)}
              </td>
              <td className="px-4 py-4 align-top">
                {r.status === 'sent' ? (
                  <Badge tone="success">sent</Badge>
                ) : (
                  <Badge tone="danger">failed</Badge>
                )}
                {r.error && (
                  <div className="mt-1.5 max-w-[240px] truncate text-[12px] text-accent-warm">
                    {r.error}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
