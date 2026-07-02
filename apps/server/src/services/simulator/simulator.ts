import { ingestAttachment } from '../ingestion/ingest.js';
import { generateSampleInvoice, type Scenario } from './sampleInvoices.js';

/**
 * Dev/demo simulator (mock mail mode only): fabricates an inbound invoice
 * email and pushes it straight into the ingestion path.
 */
export async function simulateIncomingInvoice(opts: {
  scenario?: Scenario;
  vendorIndex?: number;
  receivedAt?: string;
  date?: Date;
} = {}): Promise<string> {
  const generated = await generateSampleInvoice({
    scenario: opts.scenario,
    vendorIndex: opts.vendorIndex,
    date: opts.date,
  });
  return ingestAttachment(generated.buffer, generated.filename, {
    source: 'simulated',
    emailFrom: generated.vendor.email,
    emailSubject: generated.subject,
    receivedAt: opts.receivedAt,
  });
}
