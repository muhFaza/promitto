/**
 * Non-interactive helper for Phase 1 acceptance: performs the same DB mutations
 * the reset-superuser-password CLI does (update hash + revoke all sessions).
 * Usage: tsx scripts/test-reset-superuser.ts <email> <newPassword>
 */

import { sqlite } from '../src/db/client.js';
import { deleteAllSessionsForUser } from '../src/modules/auth/service.js';
import { findSuperuserByEmail, setPassword } from '../src/modules/users/service.js';

const [, , emailArg, passwordArg] = process.argv;
if (!emailArg || !passwordArg) {
  console.error('Usage: tsx scripts/test-reset-superuser.ts <email> <newPassword>');
  process.exit(1);
}

const email = emailArg.trim().toLowerCase();
const user = findSuperuserByEmail(email);
if (!user) {
  console.error(`no_superuser email=${email}`);
  process.exit(1);
}

await setPassword(user.id, passwordArg);
deleteAllSessionsForUser(user.id);
console.log(`superuser_password_reset id=${user.id}`);

sqlite.close();
process.exit(0);
