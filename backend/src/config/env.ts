import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_URL: z.string().url().default('http://localhost:3000'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  // Empty string is normalized to "unset" before validation: docker-compose
  // renders an unset `${CSRF_SECRET:-}` as an empty env var rather than
  // omitting it, and a bare .optional() would fail that on min(32) and
  // process.exit(1) the container on boot.
  CSRF_SECRET: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().min(32, 'CSRF_SECRET must be at least 32 characters').optional(),
  ),
  DATABASE_PATH: z.string().default('./data/promitto.db'),
  SESSIONS_DIR: z.string().default('./data/sessions'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  BAILEYS_LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('silent'),
  DEFAULT_TIMEZONE: z.string().default('Asia/Jakarta'),
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  RETENTION_DRY_RUN: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // Baked in by the Dockerfile from a build arg. Absent in dev, which is why
  // it is optional rather than defaulted to a lie like 'unknown'.
  GIT_SHA: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  // The one outbound call this app makes. Off is a supported way to run it:
  // an air-gapped or paranoid host should not have to patch code to stop it.
  UPDATE_CHECK: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

type ParsedEnv = z.infer<typeof EnvSchema>;
export type Env = Omit<ParsedEnv, 'CSRF_SECRET'> & { CSRF_SECRET: string };

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment variables:');
  console.error(JSON.stringify(parsed.error.flatten().fieldErrors, null, 2));
  process.exit(1);
}

// CSRF_SECRET is optional; when unset it falls back to SESSION_SECRET so existing
// deployments keep working. Setting a distinct value separates the HMAC keyspace
// from cookie signing and invalidates outstanding CSRF tokens on next login.
export const env: Env = {
  ...parsed.data,
  CSRF_SECRET: parsed.data.CSRF_SECRET ?? parsed.data.SESSION_SECRET,
};
