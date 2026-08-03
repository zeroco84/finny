import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { closeDb, getStatus, one, openDb } from '../src/db/db.js';
import { seedDefaults } from '../src/services/settings.js';
import { listAlerts } from '../src/services/alerts.js';
import { GraphTimeoutError, graphFetch } from '../src/services/graph/graphClient.js';
import { pollGraphMailbox } from '../src/services/ingestion/mailProviders.js';

/**
 * A Graph call with no AbortSignal inherits Node/undici's ~300s header timeout,
 * so one hung request holds a 60s mail poll for five minutes. Every Graph call
 * is now capped at GRAPH_TIMEOUT_SECONDS; these tests use a few tens of
 * milliseconds so they cost nothing to run.
 */

const saved = {
  graph: { ...config.graph },
  attachmentsDir: config.attachmentsDir,
  webhook: config.alertWebhookUrl,
};

const TOKEN_OK = () =>
  new Response(JSON.stringify({ access_token: 't0ken', expires_in: 3600 }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

/** A fetch that never answers, and only settles when its signal aborts. */
function neverAnswers(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (!signal) return; // no signal = the bug this suite guards against: hangs forever
    signal.addEventListener('abort', () => reject(signal.reason));
  });
}

/** Token endpoint answers; everything else hangs until the timeout aborts it. */
function stubHungGraph(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
    if (String(url).includes('login.microsoftonline.com')) return TOKEN_OK();
    return neverAnswers(opts?.signal);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/**
 * Drop the module-level token cache so each test exercises a real token fetch.
 * A 401 from Graph is the code's own invalidation path; a 401 on the token call
 * itself simply leaves the cache empty.
 */
async function clearTokenCache(): Promise<void> {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{"error":"expired"}', { status: 401 })),
  );
  await graphFetch('/ping').catch(() => undefined);
}

beforeEach(async () => {
  closeDb();
  openDb(':memory:');
  seedDefaults();
  Object.assign(config.graph, {
    tenantId: 'tenant-1',
    clientId: 'client-1',
    clientSecret: 'secret-1',
    mailbox: 'ap@example.com',
    markRead: false,
    backfillDays: 0,
    timeoutMs: 40,
  });
  config.attachmentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finny-graphtimeout-'));
  config.alertWebhookUrl = ''; // stored only, no outbound post
  await clearTokenCache();
});

afterEach(() => {
  Object.assign(config.graph, saved.graph);
  config.attachmentsDir = saved.attachmentsDir;
  config.alertWebhookUrl = saved.webhook;
  vi.unstubAllGlobals();
});

describe('graphFetch — every Graph call is time-boxed', () => {
  it('aborts a hung request and reports it as a timeout', async () => {
    const fetchMock = stubHungGraph();

    await expect(graphFetch('/users/ap@example.com/messages')).rejects.toBeInstanceOf(
      GraphTimeoutError,
    );
    await expect(graphFetch('/users/ap@example.com/messages')).rejects.toThrow(
      /timed out after 40ms/,
    );
    // The error names the call, so mail_last_error tells an operator which one.
    await expect(graphFetch('/users/ap@example.com/messages')).rejects.toThrow(
      /\/users\/ap@example\.com\/messages/,
    );

    // The abort reached fetch: undici only cancels the in-flight request (and
    // its body stream) when a signal is actually passed through.
    const graphCall = fetchMock.mock.calls.find(
      ([url]) => !String(url).includes('login.microsoftonline.com'),
    )!;
    const signal = (graphCall[1] as RequestInit).signal!;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(true);
  });

  it('leaves a call that answers inside the budget alone', async () => {
    config.graph.timeoutMs = 2_000;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('login.microsoftonline.com')) return TOKEN_OK();
        await new Promise((r) => setTimeout(r, 10));
        return new Response(JSON.stringify({ value: [{ id: 'msg-1' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );

    const res = await graphFetch<{ value: { id: string }[] }>('/users/ap@example.com/messages');
    expect(res.value[0]!.id).toBe('msg-1');
  });

  it('caps the token request too — a hung sign-in stalls the poll just as hard', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, opts?: RequestInit) => neverAnswers(opts?.signal)),
    );

    await expect(graphFetch('/users/ap@example.com/messages')).rejects.toThrow(
      /token request timed out after 40ms/i,
    );
  });
});

describe('mail poll — a hung Graph call fails the poll instead of stalling it', () => {
  it('alerts when listing the mailbox hangs', async () => {
    stubHungGraph();

    await pollGraphMailbox();

    expect(getStatus('mail_last_error')).toContain('timed out');
    const alert = listAlerts().find((a) => a.type === 'mailbox_auth_failure');
    expect(alert).toBeDefined();
    expect(alert!.message).toContain('timed out');
  });

  it('charges a hung attachment read to that message, not the whole mailbox', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, opts?: RequestInit) => {
        const u = String(url);
        if (u.includes('login.microsoftonline.com')) return TOKEN_OK();
        if (u.includes('/mailFolders/inbox/messages')) {
          return new Response(
            JSON.stringify({
              value: [
                {
                  id: 'msg-slow',
                  subject: 'Invoice 2001',
                  receivedDateTime: '2026-07-10T09:00:00Z',
                  from: { emailAddress: { address: 'billing@supplier.example' } },
                  hasAttachments: true,
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return neverAnswers(opts?.signal); // the attachment read hangs
      }),
    );

    await pollGraphMailbox();

    // The existing bounded-retry machinery takes it from here: one attempt
    // spent, message not parked yet, watermark held so nothing is lost.
    const failure = one<{ attempts: number; parked: number; last_error: string }>(
      'SELECT attempts, parked, last_error FROM mail_message_failures WHERE message_id = ?',
      'msg-slow',
    )!;
    expect(failure.attempts).toBe(1);
    expect(failure.parked).toBe(0);
    expect(failure.last_error).toContain('timed out');
    expect(getStatus('graph_mail_watermark')).not.toBe('2026-07-10T09:00:00Z');
    // The mailbox itself is fine — the poll finished rather than hanging on it.
    expect(getStatus('mail_last_poll')).not.toBeNull();
    expect(getStatus('mail_last_error')).toBeNull();
  });
});
