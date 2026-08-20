import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { updateChecker } from './service.js';

export const versionRouter = Router();

/**
 * Behind `requireAuth` on purpose. The repo is public so the source is no
 * secret, but the exact version a *running* instance is on tells an unauthed
 * scanner which advisories to try. Everyone who has a reason to care about
 * being up to date has an account.
 */
versionRouter.use(requireAuth);

versionRouter.get('/', (_req, res) => {
  // Fire-and-forget: serves the cached answer immediately and refreshes behind
  // the response, so a slow or dead GitHub can never make Settings hang.
  updateChecker.maybeRefresh();
  res.json(updateChecker.info);
});
