/**
 * Non-interactive helper for Phase 1 acceptance: performs the same DB mutation
 * the create-superuser CLI does, but without TTY prompts. Usage:
 *   tsx scripts/test-seed-superuser.ts <email> <password>
 */

import { sqlite } from '../src/db/client.js';
import {
  createUser,
  deleteUserById,
  findUserByEmailAnyRole,
} from '../src/modules/users/service.js';

const [, , emailArg, passwordArg] = process.argv;
if (!emailArg || !passwordArg) {
  console.error('Usage: tsx scripts/test-seed-superuser.ts <email> <password>');
  process.exit(1);
}

const email = emailArg.trim().toLowerCase();

const existing = findUserByEmailAnyRole(email);
if (existing) deleteUserById(existing.id);

const user = await createUser({ email, role: 'superuser', password: passwordArg });
console.log(`superuser_created id=${user.id} email=${user.email}`);

sqlite.close();
process.exit(0);
