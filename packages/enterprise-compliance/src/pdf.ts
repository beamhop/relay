// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Minimal PDF 1.4 writer (no dependencies): A4 pages of monospaced text lines using the
 * built-in Courier font. Enough for tabular reports; WinAnsi-safe (non-Latin-1 → "?").
 */
function esc(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 63;
    const safe = c >= 32 && c <= 255 ? ch : '?';
    out += safe === '\\' || safe === '(' || safe === ')' ? `\\${safe}` : safe;
  }
  return out;
}

export interface PdfDoc {
  title: string;
  /** Lines of text; long documents are split across pages. */
  lines: string[];
}

export function renderPdf(doc: PdfDoc): Uint8Array {
  const perPage = 60;
  const pages: string[][] = [];
  for (let i = 0; i < Math.max(1, doc.lines.length); i += perPage)
    pages.push(doc.lines.slice(i, i + perPage));
  const objects: string[] = [];
  // 1 catalog, 2 pages, 3 font, 4 info, then (page, content) pairs.
  const pageIds = pages.map((_, i) => 5 + i * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>';
  objects[4] = `<< /Title (${esc(doc.title)}) /Producer (Beamhop) >>`;
  pages.forEach((lines, i) => {
    const pid = pageIds[i]!;
    const cid = pid + 1;
    const body = [
      'BT',
      '/F1 9 Tf',
      '11 TL',
      '40 800 Td',
      ...(i === 0 ? ['/F1 13 Tf', `(${esc(doc.title)}) Tj`, 'T*', 'T*', '/F1 9 Tf'] : []),
      ...lines.map((l) => `(${esc(l)}) Tj T*`),
      'ET',
    ].join('\n');
    objects[pid] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${cid} 0 R >>`;
    objects[cid] = `<< /Length ${latin1Len(body)} >>\nstream\n${body}\nendstream`;
  });
  let out = '%PDF-1.4\n%âãÏÓ\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = latin1Len(out);
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = latin1Len(out);
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++)
    out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return latin1(out);
}

function latin1Len(s: string): number {
  return s.length;
}

function latin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[i] = c <= 255 ? c : 63;
  }
  return out;
}
