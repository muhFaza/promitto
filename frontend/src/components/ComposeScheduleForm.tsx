import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
} from 'react';
import { ApiError } from '../api/client';
import * as schedulerApi from '../api/scheduler';
import {
  formatInZone,
  nowInZoneForInput,
  parseLocalInputInZone,
} from '../lib/dates';
import type { Contact } from '../lib/types';
import { useAuthStore } from '../stores/auth';
import { useUiStore } from '../stores/ui';
import { ContactPicker } from './ContactPicker';
import { Button } from './ui/Button';
import { Field } from './ui/Field';
import { Input } from './ui/Input';
import { Modal } from './ui/Modal';
import { Select } from './ui/Select';
import { Spinner } from './ui/Spinner';

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

type Props = {
  onCreated?: () => void;
};

export function ComposeScheduleForm({ onCreated }: Props) {
  const user = useAuthStore((s) => s.user);
  const pushToast = useUiStore((s) => s.pushToast);

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
  const [pendingCount, setPendingCount] = useState(0);

  const tz = user?.timezone ?? 'UTC';
  const cronExpression = isCustom ? customCron.trim() : preset;

  const refreshStats = useCallback(() => {
    schedulerApi
      .stats()
      .then((r) => setPendingCount(r.pendingCount))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshStats();
  }, [refreshStats]);

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
          pushToast({ message: 'Pick a future date/time', level: 'error' });
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
      refreshStats();
      onCreated?.();
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

  return (
    <>
      {pendingCount >= PENDING_WARNING_THRESHOLD && (
        <div className="mb-5 border border-amber-soft/50 bg-amber-soft-bg/60 px-4 py-3 text-xs text-ink-soft">
          <span className="eyebrow mr-2 text-amber-soft">Heads up</span>
          You have <span className="font-mono font-medium">{pendingCount}</span>{' '}
          pending one-time promises. Consider reviewing before adding more.
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        <Field label="To — recipient" hint="One contact per promise.">
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
            className="block w-full rounded-sm border border-rule bg-paper-raised px-3 py-2.5 text-sm text-ink placeholder:text-ink-muted transition-colors focus:border-ink focus:outline-none"
            placeholder="What do you want to send, and when it lands, what should it say?"
            required
          />
        </Field>

        <div>
          <div className="eyebrow mb-2">Cadence</div>
          <div className="inline-flex rounded-sm border border-rule bg-paper-raised p-0.5">
            <button
              type="button"
              onClick={() => setType('once')}
              className={
                type === 'once'
                  ? 'rounded-sm bg-ink px-4 py-1.5 text-[11px] font-medium uppercase tracking-caps text-paper-raised'
                  : 'px-4 py-1.5 text-[11px] font-medium uppercase tracking-caps text-ink-muted transition-colors hover:text-ink'
              }
            >
              Once
            </button>
            <button
              type="button"
              onClick={() => setType('recurring')}
              className={
                type === 'recurring'
                  ? 'rounded-sm bg-ink px-4 py-1.5 font-mono text-[11px] uppercase tracking-caps text-paper-raised'
                  : 'px-4 py-1.5 font-mono text-[11px] uppercase tracking-caps text-ink-muted transition-colors hover:text-ink'
              }
            >
              Recurring
            </button>
          </div>
        </div>

        {type === 'once' ? (
          <Field label={`When · ${tz}`}>
            <Input
              type="datetime-local"
              value={runAtLocal}
              onChange={(e) => setRunAtLocal(e.target.value)}
              required
            />
          </Field>
        ) : (
          <div className="space-y-4">
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
                  className="font-mono"
                />
              </Field>
            )}
            {previewRuns.length > 0 && (
              <div className="border-l-2 border-accent bg-accent-soft/40 px-4 py-3">
                <div className="eyebrow mb-1.5 text-accent">Next 5 runs</div>
                <ul className="space-y-0.5">
                  {previewRuns.map((r) => (
                    <li key={r} className="font-mono text-[12px] text-ink-soft">
                      {formatInZone(r, tz)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <div className="flex items-center justify-between border-t border-rule pt-5">
          <p className="max-w-sm text-[11px] text-ink-muted">
            Your message leaves only when the time comes. No drafts, no previews on the
            phone side.
          </p>
          <Button type="submit" disabled={!canSubmit || busy}>
            {busy ? (
              <Spinner />
            ) : type === 'once' ? (
              'Schedule →'
            ) : (
              'Create recurring →'
            )}
          </Button>
        </div>
      </form>

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Confirm the recurrence"
      >
        <div className="space-y-5">
          <p className="text-sm text-ink-soft">
            This promise will fire on the schedule below, repeatedly, until you
            cancel it. Make sure that's what you want.
          </p>
          <div className="border-l-2 border-accent bg-accent-soft/40 px-4 py-3">
            <div className="eyebrow mb-1.5 text-accent">Next 5 runs · {tz}</div>
            <ul className="space-y-0.5">
              {previewRuns.map((r) => (
                <li key={r} className="font-mono text-[12px] text-ink-soft">
                  {formatInZone(r, tz)}
                </li>
              ))}
            </ul>
          </div>
          <div className="flex justify-end gap-2 border-t border-rule pt-4">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setConfirmOpen(false)}
            >
              Back
            </Button>
            <Button
              type="button"
              onClick={() => void actuallySubmit()}
              disabled={busy}
            >
              {busy ? <Spinner /> : 'Create promise'}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
