import { config } from '../config.js';
import { graphFetch } from './graph/graphClient.js';

/**
 * Reading the members of a Microsoft 365 / Entra security group via Graph.
 * Shared by the sign-in team directory (services/team.ts) and the approving-
 * managers directory (services/settings.ts) — each points at its own group id.
 * Needs the app-permission GroupMember.Read.All (admin-consented).
 */

export interface DirectoryPerson {
  name: string;
  email: string;
  /** Entra object id — used as the Teams user id when raising approvals. */
  entraId: string;
  accountEnabled: boolean;
}

/**
 * Whether the directories run against real Microsoft 365 (`graph`) or the
 * offline sample (`mock`). `TEAM_PROVIDER` forces it; otherwise it is `graph`
 * under Entra SSO and `mock` only in dev — so a real deployment NEVER seeds or
 * shows sample people, even before a group id is configured. Each feature still
 * needs its own group id for the actual sync to succeed.
 */
export function directoryMode(): 'mock' | 'graph' {
  if (config.team.provider === 'graph') return 'graph';
  if (config.team.provider === 'mock') return 'mock';
  return config.authProvider === 'entra' ? 'graph' : 'mock';
}

interface GraphDirectoryObject {
  '@odata.type'?: string;
  id: string;
  displayName?: string;
  mail?: string;
  userPrincipalName?: string;
  accountEnabled?: boolean;
}
interface GraphMembersPage {
  value: GraphDirectoryObject[];
  '@odata.nextLink'?: string;
}

/** Real member list of an Entra group (users only, paginated). */
export async function fetchEntraGroupMembers(groupId: string): Promise<DirectoryPerson[]> {
  const people: DirectoryPerson[] = [];
  let path: string | null =
    `/groups/${groupId}/members?$select=id,displayName,mail,userPrincipalName,accountEnabled&$top=999`;
  let base: string | undefined;
  for (let guard = 0; path && guard < 25; guard++) {
    const page: GraphMembersPage = await graphFetch<GraphMembersPage>(
      path,
      base !== undefined ? { base } : undefined,
    );
    for (const m of page.value ?? []) {
      // Skip nested groups / service principals — only real users.
      if (m['@odata.type'] && m['@odata.type'] !== '#microsoft.graph.user') continue;
      const email = (m.mail || m.userPrincipalName || '').trim();
      if (!email.includes('@')) continue;
      people.push({
        name: m.displayName?.trim() || email,
        email,
        entraId: m.id,
        accountEnabled: m.accountEnabled !== false,
      });
    }
    const next = page['@odata.nextLink'];
    path = next ?? null;
    base = ''; // nextLink is absolute — don't re-prefix the Graph base
  }
  return people;
}
