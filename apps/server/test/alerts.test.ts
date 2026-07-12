import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { closeDb, openDb } from '../src/db/db.js';
import { seedDefaults } from '../src/services/settings.js';
import { alertsChannelName, isValidWebhookUrl, listAlerts, raiseAlert } from '../src/services/alerts.js';

const savedWebhook = config.alertWebhookUrl;
const savedAppUrl = config.appUrl;

beforeEach(() => {
  closeDb();
  openDb(':memory:');
  seedDefaults();
  config.alertWebhookUrl = '';
  config.appUrl = 'https://finny.example.com';
});

afterEach(() => {
  config.alertWebhookUrl = savedWebhook;
  config.appUrl = savedAppUrl;
  vi.unstubAllGlobals();
});

describe('alerts → Teams webhook', () => {
  it('stores the alert and posts an Adaptive Card when a webhook is configured', async () => {
    config.alertWebhookUrl = 'https://prod-x.westeurope.logic.azure.com/workflows/abc?sig=secret';
    const fetchMock = vi.fn(async (_url: string, _opts: RequestInit) => new Response('1', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(alertsChannelName()).toBe('webhook');

    const id = await raiseAlert('extraction_failure', { invoiceId: 'inv-1', vendor: 'Acme Ltd' });
    expect(id).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(config.alertWebhookUrl);
    const payload = JSON.parse(String(opts.body));
    expect(payload.type).toBe('message');
    const card = payload.attachments[0].content;
    expect(card.type).toBe('AdaptiveCard');
    expect(card.body[0].text).toContain('Extraction failed');
    expect(card.body[0].color).toBe('Attention'); // critical
    expect(card.actions[0]).toMatchObject({ type: 'Action.OpenUrl', url: 'https://finny.example.com/invoices/inv-1' });

    const alert = listAlerts()[0];
    expect(alert.delivery_status).toBe('sent');
    // Only the host is stored — never the secret token in the URL path.
    expect(alert.delivery_target).toBe('prod-x.westeurope.logic.azure.com');
  });

  it('marks delivery failed (but still stores the alert) when the webhook errors', async () => {
    config.alertWebhookUrl = 'https://tenant.webhook.office.com/webhookb2/abc';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    await raiseAlert('mailbox_auth_failure', { error: 'token expired' });
    const alert = listAlerts()[0];
    expect(alert.delivery_status).toBe('failed');
    expect(alert.delivery_error).toContain('500');
    // The upstream body is never echoed into the stored error (SSRF read oracle).
    expect(alert.delivery_error).not.toContain('nope');
  });

  it('refuses to post to a non-Microsoft / internal webhook host (SSRF guard)', async () => {
    config.alertWebhookUrl = 'http://169.254.169.254/latest/meta-data/';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await raiseAlert('mailbox_auth_failure', { error: 'x' });
    expect(fetchMock).not.toHaveBeenCalled(); // blocked before any request
    expect(listAlerts()[0].delivery_status).toBe('failed');
  });

  it('neutralises injected Markdown links in untrusted invoice fields on the card', async () => {
    config.alertWebhookUrl = 'https://tenant.webhook.office.com/webhookb2/abc';
    let card: Record<string, unknown> = {};
    vi.stubGlobal('fetch', vi.fn(async (_url: string, opts: RequestInit) => {
      card = JSON.parse(String(opts.body)).attachments[0].content;
      return new Response('1', { status: 200 });
    }));
    await raiseAlert('extraction_failure', { invoiceId: 'inv-9', vendor: 'Acme [Verify now](https://evil/phish)' });
    const text = JSON.stringify(card);
    expect(text).not.toContain('](https://evil');
    expect(text).not.toContain('[Verify now]');
  });
});

describe('isValidWebhookUrl (SSRF allowlist)', () => {
  it('allows https on Microsoft Teams / Power Automate / Power Platform hosts', () => {
    expect(isValidWebhookUrl('https://prod-1.westeurope.logic.azure.com/workflows/x?sig=y')).toBe(true);
    expect(isValidWebhookUrl('https://tenant.webhook.office.com/webhookb2/z')).toBe(true);
    expect(isValidWebhookUrl('https://default42.3e.environment.api.powerplatform.com/powerautomate/x')).toBe(true);
  });
  it('rejects http, credentials, and internal / off-tenant hosts', () => {
    expect(isValidWebhookUrl('http://tenant.webhook.office.com/x')).toBe(false); // not https
    expect(isValidWebhookUrl('https://169.254.169.254/latest/meta-data/')).toBe(false);
    expect(isValidWebhookUrl('https://localhost/webhook')).toBe(false);
    expect(isValidWebhookUrl('https://evil.com/webhook.office.com')).toBe(false); // path, not host
    expect(isValidWebhookUrl('https://user:pass@tenant.webhook.office.com/x')).toBe(false);
    expect(isValidWebhookUrl('not a url')).toBe(false);
  });

  it('stores only (logged) and never calls fetch when no webhook is set', async () => {
    expect(alertsChannelName()).toBe('off');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await raiseAlert('extraction_failure', { invoiceId: 'inv-2' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(listAlerts()[0].delivery_status).toBe('logged');
  });
});
