import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

/**
 * PDF text extraction for the mailbox's untrusted attachments.
 *
 * Two properties matter more than speed here. The engine is a maintained
 * pdf.js (pdfjs-dist), not the 2018 build pdf-parse bundled, and it runs with
 * `isEvalSupported: false` so no PDF-supplied PostScript or font program is
 * ever compiled with `new Function` — the CVE-2024-4367 class. And every parse
 * runs in its own worker thread with a hard deadline and a memory ceiling: a
 * crafted PDF that sends the parser into a long loop used to stall the single
 * Node event loop, and with it the API, the mail poller and the approval
 * callback. Now it stalls a worker that gets terminated.
 *
 * Output format is pdf-parse's: items sharing a baseline are concatenated,
 * each new baseline starts a new line, pages are separated by a blank line.
 * The mock extractor's regexes and the document-steering title rules were
 * written against that shape.
 */

export interface PdfTextOptions {
  /** Pages to read from the start of the document (default: all, up to 50). */
  maxPages?: number;
  /** Deadline for the whole parse; the worker is terminated at expiry. */
  timeoutMs?: number;
}

export interface PdfTextResult {
  text: string;
  numPages: number;
}

export class PdfTimeoutError extends Error {}

const DEFAULT_MAX_PAGES = 50;
const DEFAULT_TIMEOUT_MS = 20_000;
const WORKER_HEAP_MB = 512;

const require = createRequire(import.meta.url);
// Resolved here, on the main thread, so the worker (an eval'd script with no
// file of its own) imports the engine by absolute URL rather than by a bare
// specifier whose resolution base would be the process cwd.
const PDFJS_URL = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href;

// Plain JavaScript, evaluated inside the worker. Kept as a string so it runs
// identically under tsx in dev, under vitest, and in production — none of
// which can hand a .ts worker file to `new Worker()` without extra loaders.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const pdfjs = await import(workerData.pdfjsUrl);
  const task = pdfjs.getDocument({
    data: workerData.data,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  const doc = await task.promise;
  const pages = Math.min(doc.numPages, workerData.maxPages);
  let text = '';
  for (let i = 1; i <= pages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let lastY;
    let pageText = '';
    for (const item of content.items) {
      if (typeof item.str !== 'string') continue;
      const y = item.transform[5];
      if (lastY === undefined || lastY === y) pageText += item.str;
      else pageText += '\\n' + item.str;
      lastY = y;
    }
    text += (i > 1 ? '\\n\\n' : '') + pageText;
    page.cleanup();
  }
  const numPages = doc.numPages;
  await task.destroy();
  parentPort.postMessage({ ok: true, text, numPages });
})().catch((err) => {
  parentPort.postMessage({ ok: false, error: err && err.message ? String(err.message) : String(err) });
});
`;

type WorkerReply = { ok: true; text: string; numPages: number } | { ok: false; error: string };

/**
 * Read the text layer of a PDF. Rejects with PdfTimeoutError at the deadline
 * and with a plain Error for anything the engine could not parse.
 */
export function extractPdfText(buffer: Buffer | Uint8Array, opts: PdfTextOptions = {}): Promise<PdfTextResult> {
  const maxPages = Math.max(1, opts.maxPages ?? DEFAULT_MAX_PAGES);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // An exact-bounds copy: the worker gets its own ArrayBuffer (structured
  // clone would otherwise ship the whole shared pool slab a Buffer sits in).
  const data = new Uint8Array(buffer);

  return new Promise<PdfTextResult>((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { pdfjsUrl: PDFJS_URL, data, maxPages },
      transferList: [data.buffer],
      resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
      stdout: true,
      stderr: true,
    });
    // Worker output is captured rather than forwarded, so an engine warning
    // about a supplier's odd font never lands in the server log; drain the
    // streams so a chatty worker cannot block on an unread pipe.
    worker.stdout.resume();
    worker.stderr.resume();
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      void worker.terminate();
    };
    const timer = setTimeout(
      () => finish(() => reject(new PdfTimeoutError(`PDF parse exceeded ${timeoutMs} ms and was stopped`))),
      timeoutMs,
    );
    worker.on('message', (reply: WorkerReply) => {
      finish(() => (reply.ok ? resolve({ text: reply.text, numPages: reply.numPages }) : reject(new Error(reply.error))));
    });
    worker.on('error', (err) => finish(() => reject(err)));
    worker.on('exit', (code) => {
      if (code !== 0) finish(() => reject(new Error(`PDF parser exited with code ${code}`)));
    });
  });
}
