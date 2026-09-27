// Shared by the seal tests: a renderer-like one-page PDF and an independent OpenSSL check of the seal.
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { X509Certificate } from 'crypto';

export const hasOpenssl = (() => {
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();


/** A one-page PDF laid out like the renderer's output (classic xref, catalog and page as plain dictionaries). */
export function minimalPdf(): Buffer {
  const objs = [
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Catalog/Pages 1 0 R/Lang(ar)>>',
    '<</Type/Page/Parent 1 0 R/MediaBox[0 0 595 842]/Contents 4 0 R>>',
    '<</Length 8>>\nstream\nBT ET q Q\nendstream',
    '<</Title(Test)>>',
  ];
  let out = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f\r\n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n\r\n`).join('')}`;
  out += `trailer\n<</Size ${objs.length + 1}/Root 2 0 R/Info 5 0 R/ID[(abc)(def)]>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export function byteRange(pdf: Buffer): number[] {
  const m = /\/ByteRange\[(\d+) (\d+) (\d+) (\d+)\]/.exec(pdf.toString('latin1'));
  if (!m) throw new Error('no ByteRange');
  return m.slice(1).map(Number);
}

/** Verifies the CMS over the signed ranges with OpenSSL, trusting the seal certificate. */
export function opensslVerify(pdf: Buffer, certDer: Buffer): boolean {
  const [a, b, c, d] = byteRange(pdf);
  const hex = pdf.subarray(b + 1, c - 1).toString('latin1').replace(/(00)+$/, '');
  const dir = mkdtempSync(path.join(tmpdir(), 'seal-'));
  try {
    writeFileSync(path.join(dir, 'sig.der'), Buffer.from(hex, 'hex'));
    writeFileSync(path.join(dir, 'content.bin'), Buffer.concat([pdf.subarray(a, a + b), pdf.subarray(c, c + d)]));
    writeFileSync(path.join(dir, 'ca.pem'), new X509Certificate(certDer).toString());
    execFileSync('openssl', ['cms', '-verify', '-binary', '-inform', 'DER', '-in', path.join(dir, 'sig.der'), '-content', path.join(dir, 'content.bin'),
      '-CAfile', path.join(dir, 'ca.pem'), '-purpose', 'any', '-out', path.join(dir, 'out.bin')], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
