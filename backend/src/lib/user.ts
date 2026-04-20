import type { User } from '../db/schema.js';

export type UserPublic = {
  id: string;
  email: string;
  role: 'user' | 'superuser';
  timezone: string;
  disabledAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export function serializeUser(u: User): UserPublic {
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    timezone: u.timezone,
    disabledAt: u.disabledAt ? u.disabledAt.getTime() : null,
    createdAt: u.createdAt.getTime(),
    updatedAt: u.updatedAt.getTime(),
  };
}
