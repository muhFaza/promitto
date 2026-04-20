import type { ScheduledMessage, SentMessage } from '../db/schema.js';

export type ScheduledMessagePublic = {
  id: string;
  recipientJid: string;
  recipientNameSnapshot: string;
  messageText: string;
  scheduleType: 'once' | 'recurring';
  cronExpression: string | null;
  timezone: string;
  nextRunAt: number;
  lastRunAt: number | null;
  lastStatus: 'sent' | 'failed' | null;
  lastError: string | null;
  retryCount: number;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
};

export function serializeScheduled(m: ScheduledMessage): ScheduledMessagePublic {
  return {
    id: m.id,
    recipientJid: m.recipientJid,
    recipientNameSnapshot: m.recipientNameSnapshot,
    messageText: m.messageText,
    scheduleType: m.scheduleType,
    cronExpression: m.cronExpression,
    timezone: m.timezone,
    nextRunAt: m.nextRunAt.getTime(),
    lastRunAt: m.lastRunAt ? m.lastRunAt.getTime() : null,
    lastStatus: m.lastStatus,
    lastError: m.lastError,
    retryCount: m.retryCount,
    isActive: m.isActive,
    createdAt: m.createdAt.getTime(),
    updatedAt: m.updatedAt.getTime(),
  };
}

export type SentMessagePublic = {
  id: string;
  scheduledMessageId: string;
  recipientJid: string;
  messageTextSnapshot: string;
  status: 'sent' | 'failed';
  error: string | null;
  sentAt: number;
};

export function serializeSent(m: SentMessage): SentMessagePublic {
  return {
    id: m.id,
    scheduledMessageId: m.scheduledMessageId,
    recipientJid: m.recipientJid,
    messageTextSnapshot: m.messageTextSnapshot,
    status: m.status,
    error: m.error,
    sentAt: m.sentAt.getTime(),
  };
}
