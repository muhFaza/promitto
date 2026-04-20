import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from 'react';
import { ApiError } from '../api/client';
import * as schedulerApi from '../api/scheduler';
import { ContactPicker } from '../components/ContactPicker';
import { AppHeader } from '../components/ui/AppHeader';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Field } from '../components/ui/Field';
import { Input } from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { Select } from '../components/ui/Select';
import { Spinner } from '../components/ui/Spinner';
import {
  formatInZone,
  nowInZoneForInput,
  parseLocalInputInZone,
} from '../lib/dates';
import type {
  Contact,
  ScheduledMessage,
  SentMessage,
} from '../lib/types';
import { useAuthStore } from '../stores/auth';
import { useUiStore } from '../stores/ui';

type TabStatus = 'upcoming' | 'recurring' | 'history' | 'failed';

const TAB_LABELS: Record<TabStatus, string> = {
  upcoming: 'Upcoming',
  recurring: 'Recurring',
  history: 'History',
  failed: 'Failed',
};

const CRON_PRESETS: Array<{ label: string; value: string }> = [
  { label: 'Every 5 minutes', value: '*/5 * * * *' },
  { label: 'Every hour (on the hour)', value: '0 * * * *' },
  { label: 'Daily at 09:00', value: '0 9 * * *' },
  { label: 'Weekdays at 09:00', value: '0 9 * * 1-5' },
  { label: 'Weekly (Monday 09:00)', value: '0 9 * * 1' },
  { label: 'Custom…', value: '' },
];

const MAX_TEXT = 4000;
const PENDING_WARNING_THRESHOLD = 10;

export function Schedule() {
  const user = useAuthStore((s) => s.user);
  const pushToast = useUiStore((s) => s.pushToast);

  const [tab, setTab] = useState<TabStatus>('upcoming');
  const [scheduled, setScheduled] = useState<ScheduledMessage[]>([]);
  const [sent, setSent] = useState<SentMessage[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);

  const [recipient, setRecipient] = useState<Contact | null>(null);
  const [messageText, setMessageText] = useState('');
  const [type, setType] = useState<'once' | 'recurring'>('once');
  const [runAtLocal, setRunAtLocal] = useState(
    user ? nowInZoneForInput(user.timezone, 5) : '',
  );
  const [preset, setPreset] = useState<string>(CRON_PRESETS[0]!.value);
  const [customCron, setCustomCron] = useState('');
  const [isCustom, setIsCustom] = useState(false);
  const [previewRuns, setPreviewRuns] = useState<number[]>([]);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const tz = user?.timezone ?? 'UTC';
  const cronExpression = isCustom ? customCron.trim() : preset;

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

  useEffect(() => {
    schedulerApi
      .stats()
      .then((r) => setPendingCount(r.pendingCount))
      .catch(() => {});
  }, [scheduled, sent]);

  // Preview next runs for recurring
  useEffect(() => {
    if (type !== 'recurring' || !cronExpression) {
      setPreviewRuns([]);
      setPreviewError(null);
      return;
    }
    const t = setTimeout(() => {
      schedulerApi
        .preview(cronExpression, tz, 5)
        .then((r) => {
          setPreviewRuns(r.runs);
          setPreviewError(null);
        })
        .catch((err: unknown) => {
          setPreviewRuns([]);
          setPreviewError(
            err instanceof ApiError ? err.message : 'Invalid cron expression',
          );
        });
    }, 250);
    return () => clearTimeout(t);
  }, [type, cronExpression, tz]);

  const charCount = messageText.length;
  const tooLong = charCount > MAX_TEXT;
  const canSubmit =
    !!recipient &&
    messageText.trim().length > 0 &&
    !tooLong &&
    (type === 'once' ? !!runAtLocal : !!cronExpression && previewRuns.length > 0);

  function resetForm() {
    setRecipient(null);
    setMessageText('');
    setType('once');
    setRunAtLocal(user ? nowInZoneForInput(user.timezone, 5) : '');
    setPreset(CRON_PRESETS[0]!.value);
    setCustomCron('');
    setIsCustom(false);
  }

  async function actuallySubmit() {
    if (!recipient) return;
    setBusy(true);
    try {
      if (type === 'once') {
        const utcMs = parseLocalInputInZone(runAtLocal, tz);
        if (utcMs === null) {
          pushToast({ message: 'Invalid date/time', level: 'error' });
          return;
        }
        if (utcMs <= Date.now()) {
          pushToast({
            message: 'Pick a future date/time',
            level: 'error',
          });
          return;
        }
        await schedulerApi.create({
          recipientJid: recipient.jid,
          messageText,
          scheduleType: 'once',
          nextRunAt: utcMs,
          timezone: tz,
        });
        pushToast({ message: 'Scheduled', level: 'success' });
      } else {
        await schedulerApi.create({
          recipientJid: recipient.jid,
          messageText,
          scheduleType: 'recurring',
          cronExpression,
          timezone: tz,
        });
        pushToast({ message: 'Recurring schedule created', level: 'success' });
      }
      resetForm();
      void loadTab(tab);
    } catch (err) {
      pushToast({
        message: err instanceof ApiError ? err.message : 'Create failed',
        level: 'error',
      });
    } finally {
      setBusy(false);
      setConfirmOpen(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    if (type === 'recurring') {
      setConfirmOpen(true);
      return;
    }
    await actuallySubmit();
  }

  async function handleCancel(id: string) {
    if (!confirm('Cancel this schedule? History remains.')) return;
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

  const scheduledItems = useMemo(() => scheduled, [scheduled]);
  const sentItems = useMemo(() => sent, [sent]);

  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-5xl p-6">
        <header className="flex items-baseline justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900">Schedule</h1>
            <p className="mt-1 text-sm text-slate-500">
              One-time and recurring text messages.{' '}
              <span className="text-slate-400">
                Timezone: <span className="font-mono">{tz}</span>
              </span>
            </p>
          </div>
        </header>

        <section className="mt-6 rounded-xl border border-slate-200 bg-white p-6">
          {pendingCount >= PENDING_WARNING_THRESHOLD && (
            <div className="mb-4 rounded-md bg-amber-50 p-3 text-xs text-amber-800">
              You have {pendingCount} pending one-time schedules. Consider
              reviewing before adding more.
            </div>
          )}
          <form onSubmit={handleSubmit} className="space-y-4">
            <Field label="Recipient" hint="One contact per schedule.">
              <ContactPicker value={recipient} onChange={setRecipient} />
            </Field>

            <Field
              label="Message"
              hint={`${charCount} / ${MAX_TEXT}`}
              error={tooLong ? 'Message is too long' : undefined}
            >
              <textarea
                value={messageText}
                onChange={(e) => setMessageText(e.target.value)}
                rows={4}
                className="block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
                placeholder="Hi there..."
                required
              />
            </Field>

            <div className="flex gap-2">
              <Button
                type="button"
                variant={type === 'once' ? 'primary' : 'secondary'}
                onClick={() => setType('once')}
              >
                Once
              </Button>
              <Button
                type="button"
                variant={type === 'recurring' ? 'primary' : 'secondary'}
                onClick={() => setType('recurring')}
              >
                Recurring
              </Button>
            </div>

            {type === 'once' ? (
              <Field label={`When (${tz})`}>
                <Input
                  type="datetime-local"
                  value={runAtLocal}
                  onChange={(e) => setRunAtLocal(e.target.value)}
                  required
                />
              </Field>
            ) : (
              <div className="space-y-3">
                <Field label="Preset">
                  <Select
                    value={isCustom ? '' : preset}
                    onChange={(e) => {
                      if (e.target.value === '') {
                        setIsCustom(true);
                      } else {
                        setIsCustom(false);
                        setPreset(e.target.value);
                      }
                    }}
                  >
                    {CRON_PRESETS.map((p) => (
                      <option key={p.label} value={p.value}>
                        {p.label}
                        {p.value ? `  (${p.value})` : ''}
                      </option>
                    ))}
                  </Select>
                </Field>
                {isCustom && (
                  <Field
                    label="Cron expression"
                    error={previewError ?? undefined}
                    hint={previewError ? undefined : 'standard 5-field cron'}
                  >
                    <Input
                      type="text"
                      value={customCron}
                      onChange={(e) => setCustomCron(e.target.value)}
                      placeholder="*/15 * * * *"
                    />
                  </Field>
                )}
                {previewRuns.length > 0 && (
                  <div className="rounded-md bg-slate-50 p-3 text-xs text-slate-600">
                    <div className="mb-1 font-medium text-slate-700">
                      Next 5 runs
                    </div>
                    <ul className="space-y-0.5">
                      {previewRuns.map((r) => (
                        <li key={r} className="font-mono">
                          {formatInZone(r, tz)}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            <div>
              <Button type="submit" disabled={!canSubmit || busy}>
                {busy ? <Spinner /> : type === 'once' ? 'Schedule' : 'Create recurring'}
              </Button>
            </div>
          </form>
        </section>

        <nav className="mt-8 border-b border-slate-200">
          <ul className="flex gap-1">
            {(Object.keys(TAB_LABELS) as TabStatus[]).map((t) => (
              <li key={t}>
                <button
                  type="button"
                  onClick={() => setTab(t)}
                  className={
                    tab === t
                      ? 'border-b-2 border-slate-900 px-3 py-2 text-sm font-medium text-slate-900'
                      : 'px-3 py-2 text-sm font-medium text-slate-500 hover:text-slate-900'
                  }
                >
                  {TAB_LABELS[t]}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <section className="mt-4 overflow-x-auto rounded-xl border border-slate-200 bg-white">
          {listLoading ? (
            <div className="flex items-center justify-center p-12 text-slate-400">
              <Spinner size={24} />
            </div>
          ) : tab === 'upcoming' || tab === 'recurring' ? (
            scheduledItems.length === 0 ? (
              <div className="p-6 text-sm text-slate-500">
                No {TAB_LABELS[tab].toLowerCase()} schedules.
              </div>
            ) : (
              <ScheduledTable
                rows={scheduledItems}
                tz={tz}
                onCancel={handleCancel}
              />
            )
          ) : sentItems.length === 0 ? (
            <div className="p-6 text-sm text-slate-500">
              No {TAB_LABELS[tab].toLowerCase()} yet.
            </div>
          ) : (
            <SentTable rows={sentItems} tz={tz} />
          )}
        </section>
      </main>

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Confirm recurring schedule"
      >
        <div className="space-y-4">
          <p className="text-sm text-slate-700">
            This will fire repeatedly on the schedule below. Make sure that's
            what you want.
          </p>
          <div className="rounded-md bg-slate-50 p-3 text-xs text-slate-600">
            <div className="mb-1 font-medium text-slate-700">
              Next 5 runs ({tz})
            </div>
            <ul className="space-y-0.5">
              {previewRuns.map((r) => (
                <li key={r} className="font-mono">
                  {formatInZone(r, tz)}
                </li>
              ))}
            </ul>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setConfirmOpen(false)}
            >
              Back
            </Button>
            <Button type="button" onClick={() => void actuallySubmit()} disabled={busy}>
              {busy ? <Spinner /> : 'Create'}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

function ScheduledTable({
  rows,
  tz,
  onCancel,
}: {
  rows: ScheduledMessage[];
  tz: string;
  onCancel: (id: string) => void;
}) {
  return (
    <table className="min-w-full divide-y divide-slate-200 text-sm">
      <thead className="bg-slate-50">
        <tr>
          <th className="px-4 py-3 text-left font-medium text-slate-700">Recipient</th>
          <th className="px-4 py-3 text-left font-medium text-slate-700">Message</th>
          <th className="px-4 py-3 text-left font-medium text-slate-700">Next run</th>
          <th className="px-4 py-3 text-left font-medium text-slate-700">State</th>
          <th className="px-4 py-3 text-right font-medium text-slate-700">Actions</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-200">
        {rows.map((r) => (
          <tr key={r.id}>
            <td className="px-4 py-3">
              <div className="font-medium text-slate-900">
                {r.recipientNameSnapshot}
              </div>
              <div className="font-mono text-[11px] text-slate-500">
                {r.recipientJid}
              </div>
            </td>
            <td className="max-w-xs px-4 py-3 text-slate-700">
              <div className="truncate">{r.messageText}</div>
            </td>
            <td className="px-4 py-3 font-mono text-xs text-slate-700">
              {formatInZone(r.nextRunAt, tz)}
              {r.cronExpression && (
                <div className="mt-0.5 text-slate-400">{r.cronExpression}</div>
              )}
            </td>
            <td className="px-4 py-3">
              {r.retryCount > 0 ? (
                <Badge tone="warning">
                  retry {r.retryCount} / 3
                </Badge>
              ) : r.lastStatus === 'sent' ? (
                <Badge tone="success">last: sent</Badge>
              ) : r.lastStatus === 'failed' ? (
                <Badge tone="danger">last: failed</Badge>
              ) : (
                <Badge tone="neutral">pending</Badge>
              )}
              {r.lastError && r.retryCount > 0 && (
                <div className="mt-1 max-w-[200px] truncate text-[11px] text-red-600">
                  {r.lastError}
                </div>
              )}
            </td>
            <td className="px-4 py-3 text-right">
              <Button variant="danger" onClick={() => onCancel(r.id)}>
                Cancel
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SentTable({ rows, tz }: { rows: SentMessage[]; tz: string }) {
  return (
    <table className="min-w-full divide-y divide-slate-200 text-sm">
      <thead className="bg-slate-50">
        <tr>
          <th className="px-4 py-3 text-left font-medium text-slate-700">Recipient</th>
          <th className="px-4 py-3 text-left font-medium text-slate-700">Message</th>
          <th className="px-4 py-3 text-left font-medium text-slate-700">At</th>
          <th className="px-4 py-3 text-left font-medium text-slate-700">Status</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-200">
        {rows.map((r) => (
          <tr key={r.id}>
            <td className="px-4 py-3 font-mono text-[11px] text-slate-700">
              {r.recipientJid}
            </td>
            <td className="max-w-xs px-4 py-3 text-slate-700">
              <div className="truncate">{r.messageTextSnapshot}</div>
            </td>
            <td className="px-4 py-3 font-mono text-xs text-slate-700">
              {formatInZone(r.sentAt, tz)}
            </td>
            <td className="px-4 py-3">
              {r.status === 'sent' ? (
                <Badge tone="success">sent</Badge>
              ) : (
                <Badge tone="danger">failed</Badge>
              )}
              {r.error && (
                <div className="mt-1 max-w-[220px] truncate text-[11px] text-red-600">
                  {r.error}
                </div>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
