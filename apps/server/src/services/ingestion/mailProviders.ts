import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { one, run, setStatus } from '../../db/db.js';
import { nowIso } from '../../domain/util.js';
import { raiseAlert } from '../alerts.js';
import { GraphAuthError, graphFetch } from '../graph/graphClient.js';
import { ingestAttachment } from './ingest.js';

/**
 * Mock provider: watches $DATA_DIR/inbox. Drop a PDF/PNG/JPG in and it is
 * ingested as if it arrived by email (spec acceptance: attachment appears in
 * the review queue without a manual download).
 */
export async function pollMockInbox(): Promise<void> {
  let entries: string[];
  try {
    entries = fs.readdirSync(config.inboxDir);
  } catch (err) {
    setStatus('mail_last_error', `inbox directory unreadable: ${err instanceof Error ? err.message : err}`);
    await raiseAlert('mailbox_auth_failure', { error: `Local inbox directory unreadable: ${config.inboxDir}` });
    return;
  }
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const full = path.join(config.inboxDir, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    // Skip files still being written (mtime within the last second).
    if (Date.now() - stat.mtimeMs < 1000) continue;
    const buffer = fs.readFileSync(full);
    fs.unlinkSync(full);
    await ingestAttachment(buffer, name, {
      source: 'mock_inbox',
      emailFrom: 'dropped-file@local',
      emailSubject: name,
    });
    console.log(`[ingest] picked up ${name} from inbox folder`);
  }
  setStatus('mail_last_poll', nowIso());
  setStatus('mail_last_error', null);
}

interface GraphMessage {
  id: string;
  subject: string | null;
  receivedDateTime: string;
  from?: { emailAddress?: { address?: string; name?: string } };
  hasAttachments: boolean;
}

interface GraphAttachment {
  '@odata.type': string;
  id: string;
  name: string;
  contentType: string | null;
  contentBytes?: string;
  size: number;
}

/**
 * Graph provider: polls the shared mailbox for new mail with attachments.
 * Watermark (last processed receivedDateTime) is persisted in system_status;
 * message ids are deduped in ingested_messages. Auth failures raise the
 * mailbox_auth_failure alert immediately.
 */
export async function pollGraphMailbox(): Promise<void> {
  if (!config.graph.mailbox) {
    setStatus('mail_last_error', 'GRAPH_MAILBOX is not set');
    await raiseAlert('mailbox_auth_failure', {
      error: 'MAIL_PROVIDER=graph but GRAPH_MAILBOX is not set — Finny does not know which shared mailbox to poll',
    });
    return;
  }
  const mailbox = encodeURIComponent(config.graph.mailbox);
  let watermark = one<{ value: string }>(
    `SELECT value FROM system_status WHERE key = 'graph_mail_watermark'`,
  )?.value;
  if (!watermark) {
    // First ever poll: start from now (minus the optional backfill window)
    // rather than ingesting the mailbox's entire history — the team has
    // already processed everything that predates Finny.
    watermark = new Date(Date.now() - config.graph.backfillDays * 86_400_000).toISOString();
    setStatus('graph_mail_watermark', watermark);
    console.log(`[ingest] graph mailbox watermark initialised to ${watermark} (GRAPH_BACKFILL_DAYS=${config.graph.backfillDays})`);
  }

  try {
    const filter = `receivedDateTime gt ${watermark} and hasAttachments eq true`;
    const list = await graphFetch<{ value: GraphMessage[] }>(
      `/users/${mailbox}/mailFolders/inbox/messages?$filter=${encodeURIComponent(filter)}` +
        `&$orderby=receivedDateTime asc&$top=25&$select=id,subject,receivedDateTime,from,hasAttachments`,
    );

    for (const msg of list.value) {
      const seen = one('SELECT 1 AS x FROM ingested_messages WHERE message_id = ?', msg.id);
      if (!seen) {
        const atts = await graphFetch<{ value: GraphAttachment[] }>(
          `/users/${mailbox}/messages/${msg.id}/attachments`,
        );
        for (const att of atts.value) {
          if (att['@odata.type'] !== '#microsoft.graph.fileAttachment' || !att.contentBytes) continue;
          await ingestAttachment(Buffer.from(att.contentBytes, 'base64'), att.name, {
            source: 'graph_mail',
            emailFrom: msg.from?.emailAddress?.address ?? null,
            emailSubject: msg.subject,
            emailMessageId: msg.id,
            receivedAt: msg.receivedDateTime,
          });
        }
        run('INSERT INTO ingested_messages (message_id, processed_at) VALUES (?, ?)', msg.id, nowIso());
        if (config.graph.markRead) {
          await graphFetch(`/users/${mailbox}/messages/${msg.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ isRead: true }),
          }).catch(() => undefined);
        }
      }
      setStatus('graph_mail_watermark', msg.receivedDateTime);
    }
    setStatus('mail_last_poll', nowIso());
    setStatus('mail_last_error', null);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setStatus('mail_last_error', message);
    if (err instanceof GraphAuthError) {
      await raiseAlert('mailbox_auth_failure', { error: message });
    } else {
      console.error('[ingest] graph poll failed:', message);
    }
  }
}

export async function pollMail(): Promise<void> {
  if (config.mailProvider === 'graph') return pollGraphMailbox();
  return pollMockInbox();
}
