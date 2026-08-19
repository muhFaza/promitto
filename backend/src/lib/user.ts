import type { User } from '../db/schema.js';

export type UserPublic = {
  id: string;
  email: string;
  role: 'user' | 'superuser';
  timezone: string;
  disabledAt: number | null;
  mustChangePassword: boolean;
  retentionDays: number;
  contactSyncEnabled: boolean;
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
    mustChangePassword: u.mustChangePassword,
    retentionDays: u.retentionDays,
    contactSyncEnabled: u.contactSyncEnabled,
    createdAt: u.createdAt.getTime(),
    updatedAt: u.updatedAt.getTime(),
  };
}
