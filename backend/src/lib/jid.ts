const USER_JID_RE = /^[0-9]+@s\.whatsapp\.net$/;

export function isUserJid(jid: string): boolean {
  return USER_JID_RE.test(jid);
}

export function isGroupJid(jid: string): boolean {
  return jid.endsWith('@g.us');
}

export function phoneFromJid(jid: string): string | null {
  const match = /^([0-9]+)@s\.whatsapp\.net$/.exec(jid);
  return match ? `+${match[1]}` : null;
}
