import { CronExpressionParser } from 'cron-parser';

export type CronValidationResult =
  | { valid: true; nextRunAt: Date }
  | { valid: false; error: string };

export function validateCron(expression: string, tz: string): CronValidationResult {
  try {
    const interval = CronExpressionParser.parse(expression, { tz });
    return { valid: true, nextRunAt: interval.next().toDate() };
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : 'Invalid cron expression',
    };
  }
}

export function computeNextRun(
  expression: string,
  tz: string,
  from: Date = new Date(),
): Date {
  const interval = CronExpressionParser.parse(expression, {
    tz,
    currentDate: from,
  });
  return interval.next().toDate();
}

export function previewNextRuns(
  expression: string,
  tz: string,
  count = 5,
): Date[] {
  const interval = CronExpressionParser.parse(expression, { tz });
  const out: Date[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(interval.next().toDate());
  }
  return out;
}
