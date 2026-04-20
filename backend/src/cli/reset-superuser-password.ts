import { confirm, input, password } from '@inquirer/prompts';
import { sqlite } from '../db/client.js';
import { deleteAllSessionsForUser } from '../modules/auth/service.js';
import { findSuperuserByEmail, setPassword } from '../modules/users/service.js';

async function main() {
  console.log('Promitto — reset superuser password\n');

  const email = await input({
    message: 'Superuser email:',
    validate: (v) => (/.+@.+\..+/.test(v.trim()) ? true : 'Please enter a valid email'),
  });
  const normalized = email.trim().toLowerCase();

  const user = findSuperuserByEmail(normalized);
  if (!user) {
    console.error(`\nNo superuser with email "${normalized}" found.`);
    process.exit(1);
  }

  const pw = await password({
    message: 'New password (min 12 chars):',
    mask: '*',
    validate: (v) => (v.length >= 12 ? true : 'Password must be at least 12 characters'),
  });
  const pwConfirm = await password({ message: 'Confirm new password:', mask: '*' });
  if (pw !== pwConfirm) {
    console.error('Passwords do not match.');
    process.exit(1);
  }

  const proceed = await confirm({
    message: `Reset password for "${normalized}" and invalidate all its sessions?`,
    default: true,
  });
  if (!proceed) {
    console.log('Cancelled.');
    process.exit(0);
  }

  await setPassword(user.id, pw);
  deleteAllSessionsForUser(user.id);

  console.log(`\nReset password for ${user.email}. All sessions revoked.`);
  sqlite.close();
  process.exit(0);
}

main().catch((err: unknown) => {
  if (err instanceof Error && err.name === 'ExitPromptError') {
    console.error('\nAborted.');
    process.exit(130);
  }
  console.error('Error:', err);
  process.exit(1);
});
