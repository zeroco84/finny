declare module 'pdf-parse/lib/pdf-parse.js' {
  interface PdfParseResult {
    numpages: number;
    text: string;
    info: Record<string, unknown>;
  }
  interface PdfParseOptions {
    /** Max pages to render (0 = all). Bounds a huge-page-count parse. */
    max?: number;
    /** Which bundled pdf.js build to load, e.g. 'v2.0.550' (past CVE-2018-5158). */
    version?: string;
  }
  function pdfParse(buffer: Buffer, options?: PdfParseOptions): Promise<PdfParseResult>;
  export default pdfParse;
}
