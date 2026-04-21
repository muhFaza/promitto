import { useEffect, useState } from 'react';
import { ApiError } from '../api/client';
import * as schedulerApi from '../api/scheduler';
import {
  epochToLocalInput,
  formatInZone,
  parseLocalInputInZone,
} from '../lib/dates';
import type { ScheduledMessage } from '../lib/types';
import { useUiStore } from '../stores/ui';
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

type Props = {
  message: ScheduledMessage | null;
  timezone: string;
  onClose: () => void;
  onSaved: () => void;
};

export function EditScheduleModal({ message, timezone, onClose, onSaved }: Props) {
  const pushToast = useUiStore((s) => s.pushToast);

  const [messageText, setMessageText] = useState('');
  const [runAtLocal, setRunAtLocal] = useState('');
  const [preset, setPreset] = useState('');
  const [customCron, setCustomCron] = useState('');
  const [isCustom, setIsCustom] = useState(false);
  const [previewRuns, setPreviewRuns] = useState<number[]>([]);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!message) return;
    setMessageText(message.messageText);
    if (message.scheduleType === 'once') {
      setRunAtLocal(epochToLocalInput(message.nextRunAt, timezone));
    } else {
      const existing = message.cronExpression ?? '';
      const matched = CRON_PRESETS.find((p) => p.value === existing && p.value !== '');
      if (matched) {
        setPreset(matched.value);
        setCustomCron('');
        setIsCustom(false);
      } else {
        setPreset('');
        setCustomCron(existing);
        setIsCustom(true);
      }
    }
    setPreviewRuns([]);
    setPreviewError(null);
  }, [message, timezone]);

  const cronExpression = isCustom ? customCron.trim() : preset;

  useEffect(() => {
    if (!message || message.scheduleType !== 'recurring' || !cronExpression) {
      setPreviewRuns([]);
      setPreviewError(null);
      return;
    }
    const t = setTimeout(() => {
      schedulerApi
        .preview(cronExpression, timezone, 5)
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
  }, [message, cronExpression, timezone]);

  if (!message) return null;

  const charCount = messageText.length;
  const tooLong = charCount > MAX_TEXT;

  const parsedRunAt = message.scheduleType === 'once'
    ? parseLocalInputInZone(runAtLocal, timezone)
    : null;
  const runAtFuture = parsedRunAt !== null && parsedRunAt > Date.now();

  const canSave =
    messageText.trim().length > 0 &&
    !tooLong &&
    (message.scheduleType === 'once'
      ? runAtLocal !== '' && runAtFuture
      : cronExpression !== '' && previewRuns.length > 0 && !previewError);

  async function handleSave() {
    if (!message || !canSave) return;
    setBusy(true);
    try {
      const patch: Parameters<typeof schedulerApi.update>[1] = {
        messageText: messageText.trim(),
      };
      if (message.scheduleType === 'once') {
        patch.nextRunAt = parsedRunAt!;
      } else {
        patch.cronExpression = cronExpression;
      }
      await schedulerApi.update(message.id, patch);
      pushToast({ message: 'Saved', level: 'success' });
      onSaved();
      onClose();
    } catch (err) {
      pushToast({
        message: err instanceof ApiError ? err.message : 'Save failed',
        level: 'error',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={true} onClose={onClose} title="Edit promise">
      <div className="space-y-5">
        <div className="border border-rule bg-paper px-3 py-2.5">
          <div className="text-sm font-medium text-ink">
            {message.recipientNameSnapshot}
          </div>
          <div className="mt-0.5 font-mono text-[11px] text-ink-muted">
            {message.recipientJid}
          </div>
        </div>

        <Field
          label="Message"
          error={tooLong ? `${charCount}/${MAX_TEXT} — too long` : undefined}
          hint={!tooLong ? `${charCount}/${MAX_TEXT}` : undefined}
        >
          <textarea
            className="block w-full rounded-sm border border-rule bg-paper-raised px-3 py-2 text-sm text-ink placeholder:text-ink-muted transition-colors focus:border-ink focus:outline-none disabled:bg-paper-deep disabled:text-ink-muted"
            rows={4}
            value={messageText}
            onChange={(e) => setMessageText(e.target.value)}
            disabled={busy}
          />
        </Field>

        {message.scheduleType === 'once' && (
          <Field
            label="Send at"
            error={
              runAtLocal !== '' && !runAtFuture
                ? 'Must be in the future'
                : undefined
            }
          >
            <Input
              type="datetime-local"
              value={runAtLocal}
              onChange={(e) => setRunAtLocal(e.target.value)}
              disabled={busy}
            />
          </Field>
        )}

        {message.scheduleType === 'recurring' && (
          <div className="space-y-3">
            <Field label="Schedule">
              <Select
                value={isCustom ? '' : preset}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val === '') {
                    setIsCustom(true);
                    setPreset('');
                  } else {
                    setIsCustom(false);
                    setPreset(val);
                  }
                }}
                disabled={busy}
              >
                {CRON_PRESETS.map((p) => (
                  <option key={p.label} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </Field>

            {isCustom && (
              <Field
                label="Cron expression"
                error={previewError ?? undefined}
              >
                <Input
                  type="text"
                  value={customCron}
                  onChange={(e) => setCustomCron(e.target.value)}
                  placeholder="*/5 * * * *"
                  disabled={busy}
                  className="font-mono"
                />
              </Field>
            )}

            {previewRuns.length > 0 && (
              <div className="border border-rule px-3 py-2.5">
                <div className="eyebrow mb-1.5">Next runs</div>
                <ol className="space-y-0.5">
                  {previewRuns.map((ms) => (
                    <li key={ms} className="font-mono text-[12px] text-ink-soft">
                      {formatInZone(ms, timezone)}
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        )}

        <div className="flex items-center justify-end gap-3 border-t border-rule pt-4">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleSave()}
            disabled={!canSave || busy}
          >
            {busy ? <Spinner size={16} /> : 'Save'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
