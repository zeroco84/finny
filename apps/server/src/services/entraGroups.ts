import { config } from '../config.js';
import { graphConfigured, graphFetch } from './graph/graphClient.js';

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
 * Are we wired to talk to Graph at all? `TEAM_PROVIDER` forces it either way;
 * otherwise the directories go live once Entra sign-in and Graph credentials
 * are present. Each feature still needs its own group id to actually sync.
 */
export function graphWired(): boolean {
  if (config.team.provider === 'graph') return true;
  if (config.team.provider === 'mock') return false;
  return config.authProvider === 'entra' && graphConfigured();
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
