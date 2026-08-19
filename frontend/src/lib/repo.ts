/**
 * Single source of truth for the repo link, which now appears on the login
 * screen, the privacy page and Settings. The backend has its own copy in
 * modules/version/service.ts because it serves it in the version payload —
 * if this project ever moves, both change.
 */
export const REPO_URL = 'https://github.com/muhFaza/promitto';
