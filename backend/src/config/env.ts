import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_URL: z.string().url().default('http://localhost:3000'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  CSRF_SECRET: z
    .string()
    .min(32, 'CSRF_SECRET must be at least 32 characters')
    .optional(),
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
