import { apiRequest } from './client';

export type VersionInfo = {
  version: string;
  commit: string | null;
  repoUrl: string;
  latest: string | null;
  /** `null` means the check has not succeeded yet — not that you are current. */
  updateAvailable: boolean | null;
  checkedAt: number | null;
  checkEnabled: boolean;
};

export function getVersion() {
  return apiRequest<VersionInfo>('/api/version');
}
