import { Router } from 'express';
import { z } from 'zod';
import { serializeContact } from '../../lib/contact.js';
import { errors } from '../../lib/errors.js';
import { isUserJid } from '../../lib/jid.js';
import { normalizeToE164 } from '../../lib/phone.js';
import { requireAuth } from '../../middleware/auth.js';
import { sessionManager } from '../wa-sessions/manager.js';
import * as service from './service.js';

export const contactsRouter: Router = Router();
contactsRouter.use(requireAuth);

const ListQuery = z.object({
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

contactsRouter.get('/', (req, res, next) => {
  try {
    if (!req.user) throw errors.unauthorized();
    const query = ListQuery.parse(req.query);
    const rows = service.list({
      userId: req.user.id,
      search: query.search,
      limit: query.limit,
    });
    res.json({ contacts: rows.map(serializeContact) });
  } catch (err) {
    next(err);
  }
});

const CreateBody = z.object({
  phone: z.string().min(3).max(40),
  displayName: z.string().min(1).max(120),
});

contactsRouter.post('/', async (req, res, next) => {
  try {
    if (!req.user) throw errors.unauthorized();
    const body = CreateBody.parse(req.body);

    const normalized = normalizeToE164(body.phone);
    if (!normalized) throw errors.badRequest('Invalid phone number');
    if (!isUserJid(normalized.jid)) {
      throw errors.badRequest('Only user numbers are supported (no groups)');
    }

    const existing = service.findByJid(req.user.id, normalized.jid);
    if (existing) {
      throw errors.conflict('You already have a contact with that number');
    }

    const verified = await sessionManager.verifyOnWhatsapp(
      req.user.id,
      normalized.e164,
      5000,
    );

    const created = service.insertManual({
      userId: req.user.id,
      jid: normalized.jid,
      displayName: body.displayName,
      phone: normalized.e164,
      verifiedOnWhatsapp: verified,
    });
    res.status(201).json(serializeContact(created));
  } catch (err) {
    next(err);
  }
});

const UpdateBody = z.object({
  displayName: z.string().min(1).max(120),
});

contactsRouter.patch('/:id', (req, res, next) => {
  try {
    if (!req.user) throw errors.unauthorized();
    const body = UpdateBody.parse(req.body);
    const id = req.params.id;
    const existing = service.findById(req.user.id, id);
    if (!existing) throw errors.notFound('contact');
    const updated = service.rename(req.user.id, id, body.displayName);
    if (!updated) throw errors.notFound('contact');
    res.json(serializeContact(updated));
  } catch (err) {
    next(err);
  }
});

contactsRouter.delete('/:id', (req, res, next) => {
  try {
    if (!req.user) throw errors.unauthorized();
    const ok = service.remove(req.user.id, req.params.id);
    if (!ok) throw errors.notFound('contact');
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
