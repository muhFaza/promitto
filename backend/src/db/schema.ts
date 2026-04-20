import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ['user', 'superuser'] })
    .notNull()
    .default('user'),
  timezone: text('timezone').notNull(),
  disabledAt: integer('disabled_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    userAgent: text('user_agent'),
    ip: text('ip'),
  },
  (t) => ({
    userIdIdx: index('sessions_user_id_idx').on(t.userId),
  }),
);

export const waConnections = sqliteTable('wa_connections', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  jid: text('jid'),
  status: text('status', {
    enum: [
      'disconnected',
      'connecting',
      'qr_pending',
      'connected',
      'logged_out',
      'failed',
    ],
  })
    .notNull()
    .default('disconnected'),
  lastConnectedAt: integer('last_connected_at', { mode: 'timestamp_ms' }),
  lastError: text('last_error'),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export const contacts = sqliteTable(
  'contacts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    jid: text('jid').notNull(),
    displayName: text('display_name').notNull(),
    phone: text('phone').notNull(),
    source: text('source', { enum: ['synced', 'manual'] }).notNull(),
    verifiedOnWhatsapp: integer('verified_on_whatsapp', { mode: 'boolean' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    userJidUnique: uniqueIndex('contacts_user_jid_unique').on(t.userId, t.jid),
    userSearchIdx: index('contacts_user_search_idx').on(t.userId, t.displayName),
  }),
);

export const scheduledMessages = sqliteTable(
  'scheduled_messages',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    recipientJid: text('recipient_jid').notNull(),
    recipientNameSnapshot: text('recipient_name_snapshot').notNull(),
    messageText: text('message_text').notNull(),
    scheduleType: text('schedule_type', { enum: ['once', 'recurring'] }).notNull(),
    cronExpression: text('cron_expression'),
    timezone: text('timezone').notNull(),
    nextRunAt: integer('next_run_at', { mode: 'timestamp_ms' }).notNull(),
    lastRunAt: integer('last_run_at', { mode: 'timestamp_ms' }),
    lastStatus: text('last_status', { enum: ['sent', 'failed'] }),
    lastError: text('last_error'),
    retryCount: integer('retry_count').notNull().default(0),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    pickedAt: integer('picked_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    dueIdx: index('scheduled_messages_due_idx').on(t.isActive, t.nextRunAt),
    userIdx: index('scheduled_messages_user_idx').on(t.userId),
  }),
);

export const sentMessages = sqliteTable(
  'sent_messages',
  {
    id: text('id').primaryKey(),
    scheduledMessageId: text('scheduled_message_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    recipientJid: text('recipient_jid').notNull(),
    messageTextSnapshot: text('message_text_snapshot').notNull(),
    status: text('status', { enum: ['sent', 'failed'] }).notNull(),
    error: text('error'),
    sentAt: integer('sent_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    userSentIdx: index('sent_messages_user_idx').on(t.userId, t.sentAt),
    scheduledIdx: index('sent_messages_scheduled_idx').on(t.scheduledMessageId),
  }),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type WaConnection = typeof waConnections.$inferSelect;
export type WaStatus = WaConnection['status'];
export type Contact = typeof contacts.$inferSelect;
export type ContactSource = Contact['source'];
export type ScheduledMessage = typeof scheduledMessages.$inferSelect;
export type NewScheduledMessage = typeof scheduledMessages.$inferInsert;
export type SentMessage = typeof sentMessages.$inferSelect;
export type NewSentMessage = typeof sentMessages.$inferInsert;
export type ScheduleType = ScheduledMessage['scheduleType'];
export type SendStatus = SentMessage['status'];
