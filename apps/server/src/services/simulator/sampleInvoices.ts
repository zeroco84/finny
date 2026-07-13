import PDFDocument from 'pdfkit';

/**
 * Generates realistic supplier-invoice PDFs for the mock pipeline. Layouts
 * intentionally vary label wording per vendor so extraction has real work to
 * do. Used by the queue's "Simulate incoming invoice" button, the demo seed
 * script, and the extractor tests.
 */

export interface VendorTemplate {
  name: string;
  address: string;
  vatNumber: string;
  email: string;
  refPrefix: string;
  poChance: number;
  style: 'classic' | 'caps' | 'ref';
  items: [string, number][]; // description, typical unit price EUR
}

export const VENDOR_TEMPLATES: VendorTemplate[] = [
  {
    name: 'Hegarty Steel Ltd',
    address: 'Unit 4, Ballycoolin Business Park, Dublin 15',
    vatNumber: 'IE6388047V',
    email: 'accounts@hegartysteel.ie',
    refPrefix: 'HS-',
    poChance: 0.9,
    style: 'classic',
    items: [['Rebar 12mm (per length)', 41.5], ['Mesh sheet A393', 62.0], ['Steel delivery & offload', 180.0]],
  },
  {
    name: 'MidWest Plant Hire',
    address: 'Dock Road, Limerick',
    vatNumber: 'IE9823411K',
    email: 'invoices@midwestplant.ie',
    refPrefix: 'MWP',
    poChance: 0.8,
    style: 'caps',
    items: [['13t excavator hire (week)', 950.0], ['Dumper 6t hire (week)', 420.0], ['Fuel & delivery charge', 210.0]],
  },
  {
    name: 'Brady & Nolan Solicitors LLP',
    address: '14 Fitzwilliam Square, Dublin 2',
    vatNumber: 'IE4411290T',
    email: 'billing@bradynolan.ie',
    refPrefix: 'BN/',
    poChance: 0.1,
    style: 'ref',
    items: [['Professional fees — conveyancing', 1800.0], ['Land Registry outlay', 130.0], ['Counsel fees', 950.0]],
  },
  {
    name: 'ESB Networks',
    address: 'PO Box 29, Dublin 1',
    vatNumber: 'IE8231234H',
    email: 'noreply@esb.ie',
    refPrefix: 'EN',
    poChance: 0,
    style: 'classic',
    items: [['New connection charge — site supply', 2450.0], ['Meter installation', 310.0]],
  },
  {
    name: 'Dublin Skip & Waste Co',
    address: 'Greenhills Industrial Estate, Dublin 12',
    vatNumber: 'IE7719023L',
    email: 'accounts@dublinskips.ie',
    refPrefix: 'DSW-',
    poChance: 0.6,
    style: 'caps',
    items: [['14yd skip hire & collection', 320.0], ['Site waste disposal (per tonne)', 145.0]],
  },
  {
    name: 'Corrib Ready Mix Concrete',
    address: 'Tuam Road, Galway',
    vatNumber: 'IE5520981W',
    email: 'sales@corribreadymix.ie',
    refPrefix: 'CRM',
    poChance: 0.85,
    style: 'classic',
    items: [['C30/37 concrete (per m3)', 118.0], ['Pump hire (half day)', 480.0], ['Waiting time', 95.0]],
  },
  {
    name: 'Fastway Office Supplies',
    address: 'Park West, Dublin 12',
    vatNumber: 'IE3308871C',
    email: 'ar@fastwayoffice.ie',
    refPrefix: 'FOS-',
    poChance: 0.3,
    style: 'ref',
    items: [['A4 paper (box)', 28.5], ['Toner cartridges', 89.0], ['Site office stationery pack', 45.0]],
  },
];

export type Scenario = 'normal' | 'missing_po' | 'no_ref' | 'image' | 'corrupt' | 'statement' | 'payment_recommendation';

// Subcontractors on the internal cost-estimating team's monthly payment
// certificates (not suppliers — they never invoice the AP mailbox directly).
const SUBCONTRACTORS = ['Bracken Groundworks Ltd', 'Loughside Mechanical Ltd', 'Glenbeg Facades Ltd'];

// Kept aligned with the seeded settings (entities / projects) so the mock
// extractor's list-matching has realistic work to do. Projects are drawn per
// entity — a real supplier bills an entity for one of ITS jobs, and the
// review flow now rejects cross-entity confirms.
const ENTITY_PROJECTS: Record<string, [string, string][]> = {
  'Meadowvale Developments Ltd': [
    ['Clongriffin Phase 3', 'CLON3'],
    ['Santry Cross', 'SANTX'],
  ],
  'Meadowvale Construction Ltd': [['Dock Mill', 'DOCKM']],
  'Meadowvale Asset Management Ltd': [], // overheads only — no site projects
};
const BILLED_ENTITIES = Object.keys(ENTITY_PROJECTS);

export interface GeneratedInvoice {
  buffer: Buffer;
  filename: string;
  vendor: VendorTemplate;
  ref: string;
  subject: string;
}

// 1×1 transparent PNG — a valid image with nothing to extract, which routes
// the invoice to human review (the spec's non-standard-document fallback).
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

function money(n: number): string {
  return n.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export async function generateSampleInvoice(opts: {
  vendorIndex?: number;
  scenario?: Scenario;
  date?: Date;
  rng?: () => number;
} = {}): Promise<GeneratedInvoice> {
  const rng = opts.rng ?? Math.random;
  const scenario = opts.scenario ?? 'normal';
  const vendor =
    VENDOR_TEMPLATES[opts.vendorIndex ?? Math.floor(rng() * VENDOR_TEMPLATES.length)] ??
    VENDOR_TEMPLATES[0];
  const refNumber = 1000 + Math.floor(rng() * 9000);
  const ref = `${vendor.refPrefix}${refNumber}`;
  const date = opts.date ?? new Date();

  if (scenario === 'corrupt') {
    const junk = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from(Array.from({ length: 400 }, () => Math.floor(rng() * 256)))]);
    return { buffer: junk, filename: `invoice-${ref}.pdf`, vendor, ref, subject: `Invoice ${ref} from ${vendor.name}` };
  }
  if (scenario === 'image') {
    return { buffer: TINY_PNG, filename: `scan-${ref}.png`, vendor, ref, subject: `Scanned invoice ${ref} — ${vendor.name}` };
  }
  if (scenario === 'statement') {
    // Month-end statement of account — what suppliers routinely send to the
    // AP mailbox alongside invoices. Not a bill; Finny should file it.
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const finished = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
    const dateText = date.toLocaleDateString('en-IE', { day: 'numeric', month: 'long', year: 'numeric' });
    const balance = Math.round((2000 + rng() * 30000) * 100) / 100;
    doc.fontSize(18).text(vendor.name);
    doc.fontSize(9).fillColor('#555').text(vendor.address);
    doc.text(`VAT Reg No: ${vendor.vatNumber}`);
    doc.moveDown(1.2);
    doc.fillColor('#000').fontSize(15).text('STATEMENT OF ACCOUNT');
    doc.fontSize(11).text(`Statement Date: ${dateText}`);
    doc.moveDown(0.8);
    doc.fontSize(10).fillColor('#333');
    doc.text('Date            Reference        Debit           Credit          Balance');
    doc.text('-----------------------------------------------------------------------');
    doc.text(`Opening balance                                                €${money(balance * 0.4)}`);
    doc.text(`Invoices this period                    €${money(balance * 0.6)}`);
    doc.moveDown(1);
    doc.fontSize(11).fillColor('#000').text(`Balance Outstanding: €${money(balance)}`);
    doc.moveDown(1);
    doc.fontSize(9).fillColor('#555')
      .text('This is a statement of your account, not a request for payment of a specific invoice.')
      .text('Please contact accounts if any item does not agree with your records.');
    doc.end();
    const buffer = await finished;
    return {
      buffer,
      filename: `statement-${date.toISOString().slice(0, 7)}.pdf`,
      vendor,
      ref,
      subject: `Statement of account — ${vendor.name}`,
    };
  }

  if (scenario === 'payment_recommendation') {
    // Internal cost-estimating monthly payment certificate for a subcontractor
    // claim — payable, so Finny must queue it for review, not flag it "other".
    const subbie = SUBCONTRACTORS[Math.floor(rng() * SUBCONTRACTORS.length)];
    const withProjects = BILLED_ENTITIES.filter((e) => ENTITY_PROJECTS[e].length > 0);
    const entity = withProjects[Math.floor(rng() * withProjects.length)];
    const projects = ENTITY_PROJECTS[entity];
    const [projectName] = projects[Math.floor(rng() * projects.length)];
    const claimNo = 2 + Math.floor(rng() * 8);
    const po = String(900 + Math.floor(rng() * 100));
    const contractSum = Math.round((500_000 + rng() * 1_500_000) * 100) / 100;
    const valueToDate = Math.round(contractSum * (0.2 + rng() * 0.6) * 100) / 100;
    const retention = Math.round(valueToDate * 5) / 100;
    const recommendedToDate = Math.round((valueToDate - retention) * 100) / 100;
    const previously = Math.round(recommendedToDate * (0.5 + rng() * 0.4) * 100) / 100;
    const nowRecommended = Math.round((recommendedToDate - previously) * 100) / 100;
    const dateText = date.toLocaleDateString('en-IE', { day: 'numeric', month: 'long', year: 'numeric' });
    const claimMonth = date.toLocaleDateString('en-IE', { month: 'long' });

    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const finished = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
    doc.fontSize(14).text('SUBCONTRACTOR MONTHLY PAYMENT RECOMMENDATION');
    doc.moveDown(0.8);
    doc.fontSize(10).fillColor('#333');
    doc.text(`Contract :  ${projectName}`);
    doc.text(`PO Number :  ${po}`);
    doc.text(`Contractor :  ${subbie}`);
    doc.text(`Claim No :  ${claimNo}`);
    doc.text(`Claim Mth :  ${claimMonth}`);
    doc.text(`Contract Sum :  ${money(contractSum)}`);
    doc.moveDown(1);
    doc.text(`Value of Works to Date   €${money(valueToDate)}`);
    doc.text(`Less retention @ 5%   -€${money(retention)}`);
    doc.text(`Recommended to date   €${money(recommendedToDate)}`);
    doc.text(`Less previously recommended   €${money(previously)}`);
    doc.moveDown(0.5);
    doc.fontSize(11).fillColor('#000').text(`Now recommended   €${money(nowRecommended)}`);
    doc.text(`Amount Recommended for Certificate No. ${claimNo}   €${money(nowRecommended)}`);
    doc.fontSize(9).fillColor('#555').text('VAT to be accounted for by the Principal Contractor');
    doc.moveDown(1.5);
    doc.fontSize(10).fillColor('#000').text(`Signed:  ____________________  for ${entity}`);
    doc.text(`Date:  ${dateText}`);
    doc.moveDown(1);
    doc.fontSize(8).fillColor('#777')
      .text('Amount recommended is subject to approval of workmanship and materials by the Architect/Assigned Certifier.');
    doc.end();
    const buffer = await finished;
    const ref = String(claimNo);
    return {
      buffer,
      filename: `payment-recommendation-claim-${claimNo}.pdf`,
      vendor: {
        name: subbie,
        address: '',
        vatNumber: '',
        email: 'estimating@example.com',
        refPrefix: 'CERT',
        poChance: 1,
        style: 'classic',
        items: [],
      },
      ref,
      subject: `Monthly payment recommendation — ${subbie} (Claim ${claimNo})`,
    };
  }

  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const finished = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const itemCount = 1 + Math.floor(rng() * Math.min(3, vendor.items.length));
  const chosen = vendor.items.slice(0, itemCount);
  let net = 0;
  const rows = chosen.map(([desc, unit]) => {
    const qty = 1 + Math.floor(rng() * 24);
    const jitter = 0.9 + rng() * 0.2;
    const unitPrice = Math.round(unit * jitter * 100) / 100;
    const total = Math.round(qty * unitPrice * 100) / 100;
    net += total;
    return { desc, qty, unitPrice, total };
  });
  net = Math.round(net * 100) / 100;
  const vatRate = vendor.name.includes('Solicitors') || rng() < 0.15 ? 13.5 : 23;
  const vat = Math.round(net * vatRate) / 100;
  const gross = Math.round((net + vat) * 100) / 100;
  const hasPo = scenario !== 'missing_po' && rng() < vendor.poChance;
  const po = `TW-PO-${4000 + Math.floor(rng() * 900)}`;
  const dateText = date.toLocaleDateString('en-IE', { day: 'numeric', month: 'long', year: 'numeric' });
  // Payment terms vary by supplier (14/30/60 days) so the due-date extraction
  // and the due-date notification rule have realistic spread to work with.
  const termDays = [14, 30, 30, 60][Math.floor(rng() * 4)] ?? 30;
  const dueDate = new Date(date.getTime() + termDays * 86_400_000);
  const dueText = dueDate.toLocaleDateString('en-IE', { day: 'numeric', month: 'long', year: 'numeric' });

  const labels =
    vendor.style === 'caps'
      ? { invoice: 'INVOICE #', date: 'DATE', due: 'PAYMENT DUE', po: 'PURCHASE ORDER', total: 'AMOUNT DUE' }
      : vendor.style === 'ref'
        ? { invoice: 'Our Ref', date: 'Invoice Date', due: 'Due Date', po: 'Your Order Ref', total: 'Balance Due' }
        : { invoice: 'Invoice No', date: 'Invoice Date', due: 'Due Date', po: 'PO Number', total: 'Total Due (incl. VAT)' };

  const entity = BILLED_ENTITIES[Math.floor(rng() * BILLED_ENTITIES.length)];
  const entityProjects = ENTITY_PROJECTS[entity];
  // Some invoices (overheads etc.) reference no project — and an entity with
  // no projects of its own never does.
  const projectRef =
    entityProjects.length > 0 && rng() < 0.65
      ? entityProjects[Math.floor(rng() * entityProjects.length)]
      : null;

  doc.fontSize(18).text(vendor.name);
  doc.fontSize(9).fillColor('#555').text(vendor.address);
  doc.text(`VAT Reg No: ${vendor.vatNumber}`);
  doc.moveDown(1.2);
  doc.fillColor('#000').fontSize(11);
  doc.text(`Bill To:  ${entity}, Clongriffin, Dublin 13`);
  doc.moveDown(0.8);
  if (scenario !== 'no_ref') doc.text(`${labels.invoice}: ${ref}`);
  doc.text(`${labels.date}: ${dateText}`);
  doc.text(`${labels.due}: ${dueText}`);
  if (hasPo) doc.text(`${labels.po}: ${po}`);
  if (projectRef) {
    doc.text(
      vendor.style === 'caps'
        ? `SITE/JOB: ${projectRef[1]}`
        : `Project: ${projectRef[0]} (${projectRef[1]})`,
    );
  }
  doc.moveDown(1);

  doc.fontSize(10).fillColor('#333');
  doc.text('Description                                Qty        Unit        Total');
  doc.text('----------------------------------------------------------------------');
  for (const row of rows) {
    const desc = row.desc.padEnd(38, ' ').slice(0, 38);
    doc.text(`${desc}   ${String(row.qty).padStart(3)}    €${money(row.unitPrice).padStart(9)}    €${money(row.total).padStart(10)}`);
  }
  doc.moveDown(1);
  doc.fontSize(11).fillColor('#000');
  doc.text(`Net Total: €${money(net)}`);
  doc.text(`VAT @ ${vatRate}%: €${money(vat)}`);
  doc.fontSize(13).text(`${labels.total}: €${money(gross)}`);
  doc.moveDown(1.5);
  doc.fontSize(8).fillColor('#777').text(`Payment within 30 days to ${vendor.name}. Queries: ${vendor.email}`);
  doc.end();

  const buffer = await finished;
  return {
    buffer,
    filename: `invoice-${ref}.pdf`,
    vendor,
    ref,
    subject: `Invoice ${ref} from ${vendor.name}`,
  };
}
