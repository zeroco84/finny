import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { closeDb, openDb } from '../src/db/db.js';
import { seedDefaults } from '../src/services/settings.js';
import { alertsChannelName, listAlerts, raiseAlert } from '../src/services/alerts.js';

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
    config.alertWebhookUrl = 'https://example.com/webhook';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    await raiseAlert('mailbox_auth_failure', { error: 'token expired' });
    const alert = listAlerts()[0];
    expect(alert.delivery_status).toBe('failed');
    expect(alert.delivery_error).toContain('500');
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
