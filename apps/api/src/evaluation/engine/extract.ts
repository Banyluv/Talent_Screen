import mammoth from 'mammoth';

// pdfjs-dist is ESM-only; load it with a real dynamic import from this CommonJS build.
const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;
let pdfjs: any;

async function pdfText(buf: Buffer): Promise<string> {
  pdfjs ??= await esmImport('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, useSystemFonts: true, verbosity: 0 }).promise;
  let out = '';
  try {
    for (let p = 1; p <= Math.min(doc.numPages, 30); p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      let lastY: number | null = null;
      for (const it of tc.items as any[]) {
        const y = it.transform?.[5];
        if (lastY !== null && y !== undefined && Math.abs(y - lastY) > 2 && !out.endsWith('\n')) out += '\n';
        out += it.str;
        if (it.hasEOL) out += '\n';
        if (y !== undefined) lastY = y;
      }
      out += '\n';
    }
  } finally { await doc.destroy(); }
  return out;
}

export const ACCEPTED = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/plain': 'txt',
} as const;

/** Decide the file type from extension AND content; never trust the client-supplied MIME type alone. */
export function detectType(fileName: string, _mime: string, buf: Buffer): 'pdf' | 'docx' | 'txt' | null {
  const ext = fileName.toLowerCase().split('.').pop();
  if (ext === 'pdf') return buf.subarray(0, 5).toString('latin1') === '%PDF-' ? 'pdf' : null;
  if (ext === 'docx') return buf[0] === 0x50 && buf[1] === 0x4b ? 'docx' : null;   // ZIP container
  if (ext === 'txt') return buf.includes(0) ? null : 'txt';                           // binary data is not text
  return null;
}

export class UnreadableCvError extends Error {}

export async function extractText(buf: Buffer, type: 'pdf' | 'docx' | 'txt'): Promise<string> {
  let text = '';
  if (type === 'pdf') text = await pdfText(buf);
  else if (type === 'docx') text = (await mammoth.extractRawText({ buffer: buf })).value;
  else text = buf.toString('utf8');
  text = text.replace(/\r/g, '').replace(/ /g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (text.replace(/\s/g, '').length < 80) {
    throw new UnreadableCvError(type === 'pdf'
      ? 'No readable text in this PDF. It is probably a scanned image; run OCR or upload a text-based copy.'
      : 'The file contains too little text to be a CV.');
  }
  return text;
}
