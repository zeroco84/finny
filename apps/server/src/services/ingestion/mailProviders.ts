import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { one, run, setStatus } from '../../db/db.js';
import { nowIso } from '../../domain/util.js';
import { raiseAlert } from '../alerts.js';
import { GraphAuthError, graphFetch } from '../graph/graphClient.js';
import { ingestAttachment, safeAttachmentName } from './ingest.js';

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
  // Inline body content (signature logos, banners, tracking pixels) carries
  // isInline=true and a Content-ID that the HTML body references via cid:.
  isInline?: boolean;
  contentId?: string | null;
}

/** Largest image still treated as body furniture when a client omits isInline. */
const INLINE_IMAGE_MAX_BYTES = 64 * 1024;

/**
 * Signature logos, marketing banners and tracking pixels ride along in the
 * message body as inline attachments. They are never invoices, so ingesting
 * them produced junk invoices and false unreadable/extraction alerts.
 *
 * isInline is the authoritative signal and the only one safe to act on alone.
 * A Content-ID is NOT evidence of anything: Exchange Online stamps one
 * (<hex>@<region>.prod.outlook.com) on every attachment it relays, ordinary
 * invoice PDFs included. Treating contentId as "inline" silently discarded
 * every invoice in the shared mailbox for three weeks in July 2026.
 *
 * The fallback below only exists for clients that omit isInline while still
 * referencing a logo via cid:, and is deliberately narrow — a small image and
 * nothing else. The two failure modes are not symmetric: wrongly ingesting a
 * logo costs one junk row a human discards, wrongly skipping an invoice loses
 * it silently. When in doubt, ingest.
 */
export function isInlineAttachment(att: {
  isInline?: boolean;
  contentId?: string | null;
  contentType?: string | null;
  size?: number;
}): boolean {
  if (att.isInline) return true;
  if (!att.contentId) return false;
  return (
    Boolean(att.contentType?.startsWith('image/')) && (att.size ?? 0) <= INLINE_IMAGE_MAX_BYTES
  );
}

/**
 * How many polls a single message gets before Finny gives up on it, alerts, and
 * lets the watermark move past.
 *
 * The watermark only advances over messages that are finished, so anything that
 * fails permanently on one message — a Graph read that keeps 500ing, a full
 * disk, a malformed attachment — used to hold the watermark forever and stop
 * every invoice behind it in the mailbox. Silently: only auth errors alerted.
 * That is the July 2026 stall. A message is now retried a bounded number of
 * times, then parked with an alert so the mailbox keeps flowing.
 */
const MAX_MESSAGE_ATTEMPTS = 3;

function isMessageFinished(messageId: string): boolean {
  const ingested = one('SELECT 1 AS x FROM ingested_messages WHERE message_id = ?', messageId);
  if (ingested) return true;
  return Boolean(
    one('SELECT 1 AS x FROM mail_message_failures WHERE message_id = ? AND parked = 1', messageId),
  );
}

/**
 * Record a failed attempt at one message. Returns true once the retry budget is
 * spent and the message has been parked — alerted, never retried, no longer
 * holding the watermark.
 */
async function recordMessageFailure(msg: GraphMessage, err: unknown): Promise<boolean> {
  const error = err instanceof Error ? err.message : String(err);
  const now = nowIso();
  const previous = one<{ attempts: number }>(
    'SELECT attempts FROM mail_message_failures WHERE message_id = ?',
    msg.id,
  );
  const attempts = (previous?.attempts ?? 0) + 1;
  const parked = attempts >= MAX_MESSAGE_ATTEMPTS;
  run(
    `INSERT INTO mail_message_failures
       (message_id, subject, email_from, received_at, attempts, last_error, first_failed_at, last_attempt_at, parked)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET
       attempts = excluded.attempts,
       last_error = excluded.last_error,
       last_attempt_at = excluded.last_attempt_at,
       parked = excluded.parked`,
    msg.id,
    msg.subject,
    msg.from?.emailAddress?.address ?? null,
    msg.receivedDateTime,
    attempts,
    error,
    now,
    now,
    parked ? 1 : 0,
  );
  console.error(
    `[ingest] message ${msg.id} failed (attempt ${attempts}/${MAX_MESSAGE_ATTEMPTS})` +
      `${parked ? ' — parked, not retried again' : ''}: ${error}`,
  );
  if (parked) {
    await raiseAlert('mail_message_failed', {
      vendor: msg.from?.emailAddress?.address ?? null,
      attachmentName: msg.subject || '(no subject)',
      error,
      extra: `${attempts} attempts`,
    });
  }
  return parked;
}

/**
 * Ingest every real attachment on one message, then mark the message done.
 * Attachments already stored by an earlier attempt are skipped, so a retry
 * after a part-way failure cannot create duplicate invoices.
 */
async function ingestGraphMessage(mailbox: string, msg: GraphMessage): Promise<void> {
  const atts = await graphFetch<{ value: GraphAttachment[] }>(
    `/users/${mailbox}/messages/${msg.id}/attachments`,
  );
  for (const att of atts.value) {
    if (att['@odata.type'] !== '#microsoft.graph.fileAttachment' || !att.contentBytes) continue;
    if (isInlineAttachment(att)) {
      console.log(
        `[ingest] skipped inline attachment "${att.name}" (${att.contentType ?? 'unknown'}, ${att.size ?? 0}B) on message ${msg.id}`,
      );
      continue;
    }
    const already = one(
      'SELECT 1 AS x FROM invoices WHERE email_message_id = ? AND attachment_name = ?',
      msg.id,
      safeAttachmentName(att.name),
    );
    if (already) continue;
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

/**
 * Graph provider: polls the shared mailbox for new mail with attachments.
 * Watermark (last processed receivedDateTime) is persisted in system_status;
 * message ids are deduped in ingested_messages. A message that keeps failing is
 * parked after MAX_MESSAGE_ATTEMPTS rather than blocking the mailbox. Any poll
 * failure raises the mailbox alert — ingestion never stops quietly.
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

    // The watermark may only advance across a contiguous run of finished
    // messages: the moment one is still owed a retry we stop moving it. The
    // rest of the batch is still processed, so a bad email delays only itself.
    let holdWatermark = false;

    for (const msg of list.value) {
      if (!isMessageFinished(msg.id)) {
        try {
          await ingestGraphMessage(mailbox, msg);
          run('DELETE FROM mail_message_failures WHERE message_id = ?', msg.id);
        } catch (err) {
          // Auth failure is a whole-mailbox problem, not this message's fault —
          // don't spend its retry budget; let the outer handler alert instead.
          if (err instanceof GraphAuthError) throw err;
          if (!(await recordMessageFailure(msg, err))) holdWatermark = true;
        }
      }
      if (!holdWatermark) setStatus('graph_mail_watermark', msg.receivedDateTime);
    }
    setStatus('mail_last_poll', nowIso());
    setStatus('mail_last_error', null);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setStatus('mail_last_error', message);
    console.error('[ingest] graph poll failed:', message);
    // Every poll failure alerts, not just auth: whatever the cause, the outcome
    // is the same — invoices are arriving in the mailbox and Finny is not
    // picking them up. raiseAlert dedupes to one open alert per hour.
    await raiseAlert('mailbox_auth_failure', { error: message });
  }
}

let polling = false;

/**
 * The poll entry point the worker timer drives, guarded against overlapping
 * runs.
 *
 * setInterval fires on a fixed schedule regardless of how long the previous
 * poll took, so a slow poll (a hung Graph call, a big attachment batch) used to
 * start a second one on top of it. Two polls read the same watermark, ingest the
 * same messages and race their `graph_mail_watermark` writes — the loser can
 * push the watermark *backwards* onto an older message, and every extra poll
 * piles more concurrent Graph calls onto an already struggling mailbox. Skipping
 * the tick is the right answer: the next one is only MAIL_POLL_SECONDS away, and
 * the in-flight poll is already doing the work.
 */
export async function pollMail(): Promise<void> {
  if (polling) {
    console.warn('[ingest] previous mail poll still running — skipping this tick');
    return;
  }
  polling = true;
  try {
    // `return await`, not `return`: a bare return hands back the promise and
    // lets finally clear the flag before the poll has actually finished.
    if (config.mailProvider === 'graph') return await pollGraphMailbox();
    return await pollMockInbox();
  } finally {
    polling = false;
  }
}
