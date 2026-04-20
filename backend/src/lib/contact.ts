import type { Contact } from '../db/schema.js';

export type ContactPublic = {
  id: string;
  jid: string;
  displayName: string;
  phone: string;
  source: 'synced' | 'manual';
  verifiedOnWhatsapp: boolean | null;
  createdAt: number;
  updatedAt: number;
};

export function serializeContact(c: Contact): ContactPublic {
  return {
    id: c.id,
    jid: c.jid,
    displayName: c.displayName,
    phone: c.phone,
    source: c.source,
    verifiedOnWhatsapp: c.verifiedOnWhatsapp,
    createdAt: c.createdAt.getTime(),
    updatedAt: c.updatedAt.getTime(),
  };
}
