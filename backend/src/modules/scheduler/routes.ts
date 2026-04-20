import { Router } from 'express';
import { z } from 'zod';
import { previewNextRuns, validateCron } from '../../lib/cron.js';
import { errors } from '../../lib/errors.js';
import { isUserJid } from '../../lib/jid.js';
import {
  serializeScheduled,
  serializeSent,
} from '../../lib/scheduled-message.js';
import { requireAuth } from '../../middleware/auth.js';
import * as contactsService from '../contacts/service.js';
import * as service from './service.js';

export const schedulerRouter: Router = Router();
schedulerRouter.use(requireAuth);

const CreateBody = z
  .object({
    recipientJid: z.string().min(1).max(256),
    messageText: z.string().min(1).max(4000),
    scheduleType: z.enum(['once', 'recurring']),
    nextRunAt: z.number().int().positive().optional(),
    cronExpression: z.string().min(1).max(200).optional(),
    timezone: z.string().min(1).max(128).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.scheduleType === 'once' && data.nextRunAt === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nextRunAt'],
        message: 'nextRunAt required for once schedules',
      });
    }
    if (data.scheduleType === 'recurring' && !data.cronExpression) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cronExpression'],
        message: 'cronExpression required for recurring schedules',
      });
    }
  });

schedulerRouter.post('/', (req, res, next) => {
  try {
    if (!req.user) throw errors.unauthorized();
    const body = CreateBody.parse(req.body);

    if (!isUserJid(body.recipientJid)) {
      throw errors.badRequest('recipientJid must be a user JID (no groups)');
    }

    const timezone = body.timezone ?? req.user.timezone;

    // Snapshot contact display name if we can find one.
    const contact = contactsService.findByJid(req.user.id, body.recipientJid);
    const recipientNameSnapshot =
      contact?.displayName ??
      body.recipientJid.replace(/@s\.whatsapp\.net$/, '');

    let nextRunAt: Date;
    let cronExpression: string | null = null;

    if (body.scheduleType === 'once') {
      nextRunAt = new Date(body.nextRunAt!);
      if (nextRunAt.getTime() <= Date.now()) {
        throw errors.badRequest('nextRunAt must be in the future');
      }
    } else {
      cronExpression = body.cronExpression!;
      const v = validateCron(cronExpression, timezone);
      if (!v.valid) {
        throw errors.badRequest(`Invalid cron expression: ${v.error}`);
      }
      nextRunAt = v.nextRunAt;
    }

    const created = service.create({
      userId: req.user.id,
      recipientJid: body.recipientJid,
      recipientNameSnapshot,
      messageText: body.messageText,
      scheduleType: body.scheduleType,
      cronExpression,
      timezone,
      nextRunAt,
    });

    res.status(201).json(serializeScheduled(created));
  } catch (err) {
    next(err);
  }
});

const ListQuery = z.object({
  status: z.enum(['upcoming', 'recurring', 'history', 'failed']).default('upcoming'),
});

schedulerRouter.get('/', (req, res, next) => {
  try {
    if (!req.user) throw errors.unauthorized();
    const { status } = ListQuery.parse(req.query);
    const userId = req.user.id;

    switch (status) {
      case 'upcoming':
        res.json({
          items: service.listUpcoming(userId).map(serializeScheduled),
          kind: 'scheduled',
        });
        return;
      case 'recurring':
        res.json({
          items: service.listRecurring(userId).map(serializeScheduled),
          kind: 'scheduled',
        });
        return;
      case 'history':
        res.json({
          items: service.listHistory(userId).map(serializeSent),
          kind: 'sent',
        });
        return;
      case 'failed':
        res.json({
          items: service.listFailed(userId).map(serializeSent),
          kind: 'sent',
        });
        return;
    }
  } catch (err) {
    next(err);
  }
});

schedulerRouter.get('/stats', (req, res, next) => {
  try {
    if (!req.user) throw errors.unauthorized();
    res.json({ pendingCount: service.countPendingOnce(req.user.id) });
  } catch (err) {
    next(err);
  }
});

const PreviewBody = z.object({
  cronExpression: z.string().min(1).max(200),
  timezone: z.string().min(1).max(128),
  count: z.number().int().min(1).max(20).default(5),
});

schedulerRouter.post('/preview', (req, res, next) => {
  try {
    if (!req.user) throw errors.unauthorized();
    const body = PreviewBody.parse(req.body);
    const v = validateCron(body.cronExpression, body.timezone);
    if (!v.valid) throw errors.badRequest(`Invalid cron expression: ${v.error}`);
    const runs = previewNextRuns(body.cronExpression, body.timezone, body.count);
    res.json({ runs: runs.map((d) => d.getTime()) });
  } catch (err) {
    next(err);
  }
});

const UpdateBody = z
  .object({
    messageText: z.string().min(1).max(4000).optional(),
    nextRunAt: z.number().int().positive().optional(),
    cronExpression: z.string().min(1).max(200).optional(),
    timezone: z.string().min(1).max(128).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'no fields to update',
  });

schedulerRouter.patch('/:id', (req, res, next) => {
  try {
    if (!req.user) throw errors.unauthorized();
    const existing = service.findById(req.user.id, req.params.id);
    if (!existing) throw errors.notFound('scheduled message');
    if (!existing.isActive) {
      throw errors.badRequest('Cannot edit a cancelled or completed schedule');
    }
    const body = UpdateBody.parse(req.body);

    const tz = body.timezone ?? existing.timezone;
    let nextRunAt: Date | undefined;
    let cronExpression: string | undefined | null = undefined;

    if (existing.scheduleType === 'once') {
      if (body.nextRunAt !== undefined) {
        nextRunAt = new Date(body.nextRunAt);
        if (nextRunAt.getTime() <= Date.now()) {
          throw errors.badRequest('nextRunAt must be in the future');
        }
      }
      if (body.cronExpression !== undefined) {
        throw errors.badRequest('Once schedules do not use a cron expression');
      }
    } else {
      // recurring
      if (body.nextRunAt !== undefined) {
        throw errors.badRequest('Recurring schedules derive nextRunAt from cron');
      }
      const cron = body.cronExpression ?? existing.cronExpression;
      if (!cron) throw errors.badRequest('cronExpression required');
      const v = validateCron(cron, tz);
      if (!v.valid) throw errors.badRequest(`Invalid cron expression: ${v.error}`);
      if (body.cronExpression !== undefined) cronExpression = body.cronExpression;
      nextRunAt = v.nextRunAt;
    }

    const updated = service.updateActive(req.user.id, req.params.id, {
      messageText: body.messageText,
      cronExpression: cronExpression === undefined ? undefined : cronExpression,
      timezone: body.timezone,
      nextRunAt,
    });
    if (!updated) throw errors.notFound('scheduled message');
    res.json(serializeScheduled(updated));
  } catch (err) {
    next(err);
  }
});

schedulerRouter.delete('/:id', (req, res, next) => {
  try {
    if (!req.user) throw errors.unauthorized();
    const ok = service.cancel(req.user.id, req.params.id);
    if (!ok) throw errors.notFound('scheduled message');
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
