import { confirm, input, password } from '@inquirer/prompts';
import { sqlite } from '../db/client.js';
import { createUser, findUserByEmailAnyRole } from '../modules/users/service.js';

async function main() {
  console.log('Promitto — create superuser\n');

  const email = await input({
    message: 'Superuser email:',
    validate: (v) => (/.+@.+\..+/.test(v.trim()) ? true : 'Please enter a valid email'),
  });
  const normalized = email.trim().toLowerCase();

  const existing = findUserByEmailAnyRole(normalized);
  if (existing) {
    if (existing.role === 'superuser') {
      console.error(`\nA superuser with email "${normalized}" already exists.`);
      console.error('Run "npm run cli:reset-superuser-password" to change its password.');
    } else {
      console.error(
        `\nA user with email "${normalized}" already exists (role: ${existing.role}).`,
      );
      console.error('Remove or rename that user first.');
    }
    process.exit(1);
  }

  const pw = await password({
    message: 'Password (min 12 chars):',
    mask: '*',
    validate: (v) => (v.length >= 12 ? true : 'Password must be at least 12 characters'),
  });
  const pwConfirm = await password({ message: 'Confirm password:', mask: '*' });
  if (pw !== pwConfirm) {
    console.error('Passwords do not match.');
    process.exit(1);
  }

  const proceed = await confirm({
    message: `Create superuser "${normalized}"?`,
    default: true,
  });
  if (!proceed) {
    console.log('Cancelled.');
    process.exit(0);
  }

  const user = await createUser({
    email: normalized,
    role: 'superuser',
    password: pw,
  });

  console.log(`\nCreated superuser ${user.email} (id: ${user.id}).`);
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
