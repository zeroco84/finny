import { config } from '../config.js';

/**
 * Shared Microsoft Teams webhook plumbing: URL validation (SSRF guard), the
 * Adaptive-Card envelope builder, control-character neutralisation, and the
 * POST itself. Used by both the operational-failure alerts (services/alerts.ts)
 * and the per-user event notifications (services/notifications.ts).
 */

/**
 * SSRF guard: webhook destinations are operator-/user-settable, so restrict to
 * https on a Microsoft-owned host suffix (Teams connector / Power Automate /
 * Power Platform / Logic Apps). This blocks localhost, cloud metadata and
 * internal hosts regardless of DNS, and no credentials may be embedded.
 */
export function isValidWebhookUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  return config.alertWebhookAllowedHosts.some((suffix) => host === suffix.replace(/^\./, '') || host.endsWith(suffix));
}

/** Host of the webhook for display/audit — never store or log the secret token path. */
export function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'webhook';
  }
}

/**
 * Neutralise Adaptive-Card / Markdown control characters so untrusted invoice
 * text (vendor, ref, filename, project, extractor error) cannot inject a
 * clickable phishing link or formatting into a card that appears to come from
 * Finny.
 */
export function cardSafe(value: string): string {
  return value.replace(/[[\]()`<>]/g, ' ').replace(/[ \t]+/g, ' ').trim();
}

type CardColor = 'Default' | 'Attention' | 'Warning' | 'Good' | 'Accent';

export interface TeamsCardSpec {
  /** Bold title line (include any leading emoji yourself). */
  title: string;
  titleColor?: CardColor;
  body: string;
  facts?: { title: string; value: string }[];
  /** Optional "Open" button target. */
  actionUrl?: string | null;
  actionTitle?: string;
}

/**
 * Build the Teams payload: an Adaptive Card wrapped for an Incoming Webhook —
 * the "Workflows → Post to a channel when a webhook request is received" flow a
 * user subscribes a channel or chat to.
 */
export function buildTeamsMessage(spec: TeamsCardSpec): unknown {
  const body: unknown[] = [
    {
      type: 'TextBlock',
      size: 'Large',
      weight: 'Bolder',
      wrap: true,
      color: spec.titleColor ?? 'Default',
      text: spec.title,
    },
    { type: 'TextBlock', wrap: true, text: spec.body },
  ];
  if (spec.facts && spec.facts.length > 0) {
    body.push({ type: 'FactSet', facts: spec.facts });
  }
  const card = {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4',
    msteams: { width: 'Full' },
    body,
    actions: spec.actionUrl
      ? [{ type: 'Action.OpenUrl', title: spec.actionTitle ?? 'Open in Finny', url: spec.actionUrl }]
      : [],
  };
  return {
    type: 'message',
    attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }],
  };
}

/** POST a prebuilt payload to a Teams webhook, re-validating the URL first. */
export async function postCardToWebhook(url: string, payload: unknown): Promise<void> {
  if (!isValidWebhookUrl(url)) {
    throw new Error('Refusing to post: the webhook URL is not an allowed Microsoft Teams endpoint');
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    // Don't follow a redirect off the validated host, and don't hang forever.
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    // Never surface the upstream body — echoed into a stored error it would be
    // an internal-response read oracle. Log it server-side only, return status.
    const body = await res.text().catch(() => '');
    if (body) console.error(`[teams] webhook ${urlHost(url)} error body:`, body.slice(0, 300));
    throw new Error(`Teams webhook returned HTTP ${res.status}`);
  }
}
