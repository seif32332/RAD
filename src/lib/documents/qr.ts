// QR of the verification URL (DOC-06), produced by the engine and placed by the template.
// Error correction M, 4-module quiet zone; the output is the plain <svg><path/></svg> subset that
// radeef-render's SVG allow-list accepts.
import QRCode from 'qrcode';

export async function qrSvg(url: string): Promise<Buffer> {
  const svg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 4 });
  return Buffer.from(svg, 'utf8');
}

export function verifyUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/v/${token}`;
}
