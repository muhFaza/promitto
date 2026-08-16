export type UserPublic = {
  id: string;
  email: string;
  role: 'user' | 'superuser';
  timezone: string;
  disabledAt: number | null;
  mustChangePassword: boolean;
  retentionDays: number;
  contactSyncEnabled: boolean;
  createdAt: number;
  updatedAt: number;
};

export type Contact = {
  id: string;
  jid: string;
  displayName: string;
  phone: string;
  source: 'synced' | 'manual';
  verifiedOnWhatsapp: boolean | null;
  // Read-only mirror of the chat's pin state on WhatsApp itself. Nothing in the
  // app sets it; the server just sorts pinned rows first in /recent.
  waPinnedAt: number | null;
  lastInteractionAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type ScheduleType = 'once' | 'recurring';
export type SendStatus = 'sent' | 'failed';

export type ScheduledMessage = {
  id: string;
  recipientJid: string;
  recipientNameSnapshot: string;
  messageText: string;
  scheduleType: ScheduleType;
  cronExpression: string | null;
  timezone: string;
  nextRunAt: number;
  lastRunAt: number | null;
  lastStatus: SendStatus | null;
  lastError: string | null;
  retryCount: number;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
};

export type SentMessage = {
  id: string;
  scheduledMessageId: string;
  recipientJid: string;
  messageTextSnapshot: string;
  status: SendStatus;
  error: string | null;
  sentAt: number;
};
