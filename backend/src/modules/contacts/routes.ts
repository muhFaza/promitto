import { Router } from 'express';
import { z } from 'zod';
import { serializeContact } from '../../lib/contact.js';
import { errors } from '../../lib/errors.js';
import { isUserJid } from '../../lib/jid.js';
import { normalizeToE164 } from '../../lib/phone.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireCsrf } from '../../middleware/csrf.js';
import { requirePasswordRotated } from '../../middleware/password-gate.js';
import { sessionManager } from '../wa-sessions/manager.js';
import * as service from './service.js';

export const contactsRouter: Router = Router();
contactsRouter.use(requireAuth, requirePasswordRotated, requireCsrf);

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

const RecentQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

contactsRouter.get('/recent', (req, res, next) => {
  try {
    if (!req.user) throw errors.unauthorized();
    const query = RecentQuery.parse(req.query);
    const rows = service.listRecent(req.user.id, query.limit);
    res.json({ contacts: rows.map(serializeContact) });
  } catch (err) {
    next(err);
  }
});

// Above every `/:id` route so the literal path wins the match.
contactsRouter.post('/purge-synced', (req, res, next) => {
  try {
    if (!req.user) throw errors.unauthorized();
    res.json(service.purgeSynced(req.user.id));
  } catch (err) {
    next(err);
  }
});

function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

// Registered ahead of anything matching `/:id`, though nothing here actually
// collides: `/recent` is one segment and this is two. The redirect target is a
// short-lived signed WhatsApp CDN URL, so it is never persisted — the manager
// caches it in memory and re-fetches when it ages out.
contactsRouter.get('/:id/avatar', async (req, res, next) => {
  try {
    if (!req.user) throw errors.unauthorized();
    const contact = service.findById(req.user.id, req.params.id);
    if (!contact) throw errors.notFound('contact');
    const url = await sessionManager.getAvatarUrl(req.user.id, contact.jid);
    // No avatar is the ordinary case, not an error: the session may be
    // disconnected, or the contact's privacy settings hide the picture.
    //
    // The target is validated before it is handed to res.redirect, even though
    // it comes from Baileys rather than from user input: an open redirect to an
    // arbitrary scheme is not something to be one upstream change away from.
    // Anything that isn't a parseable https URL takes the same 404 path as null.
    if (!url || !isHttpsUrl(url)) throw errors.notFound('avatar');
    // Let the browser reuse the redirect for a few minutes. The Dashboard's
    // recent-contacts row can mount ~48 of these at once, and without this every
    // remount re-asks the server, which re-asks Baileys, for a URL that has not
    // changed. `private` because the target is scoped to one user's session.
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.redirect(302, url);
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
    const updated = service.rename(req.user.id, req.params.id, body.displayName);
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
