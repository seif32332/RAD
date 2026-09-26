// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadFontBundle } from '../src/fonts.mjs';
import { checkPng, checkSvg, RequestError, validateRenderRequest } from '../src/validate.mjs';
import { b64, FONTS_DIR, FONTS_LOCK, fixtureBody } from './helpers.mjs';

const { coverage } = await loadFontBundle(FONTS_DIR, FONTS_LOCK);

/** Asserts that validating `body` fails with `code` (and optional status). */
function rejects(body, code, status = 400) {
  assert.throws(
    () => validateRenderRequest(body, coverage),
    (e) => e instanceof RequestError && e.code === code && e.status === status,
    `expected ${status} ${code}`,
  );
}

test('the POC fixture is a valid request', () => {
  const job = validateRenderRequest(fixtureBody('F2-ar-en'), coverage);
  assert.equal(job.template.size, 1);
  assert.deepEqual([...job.assets.keys()].sort(), ['logo.png', 'qr.svg', 'signature.png', 'stamp.png']);
  assert.equal(job.creationTimestamp, 1790413200);
});

test('markup-looking data is data (F7): valid, rendered literally by the integration test', () => {
  validateRenderRequest(fixtureBody('F7-inject'), coverage);
});

test('envelope: unknown fields, template ref, timestamp, pdf standard', () => {
  rejects({ ...fixtureBody('F2-ar-en'), extra: 1 }, 'UNKNOWN_FIELDS');
  rejects(fixtureBody('F2-ar-en', { templateRef: '../x' }), 'INVALID_TEMPLATE_REF');
  rejects(fixtureBody('F2-ar-en', { creationTimestamp: 1.5 }), 'INVALID_TIMESTAMP');
  rejects(fixtureBody('F2-ar-en', { creationTimestamp: 100 }), 'INVALID_TIMESTAMP');
  rejects(fixtureBody('F2-ar-en', { pdfStandard: 'ua-1' }), 'INVALID_PDF_STANDARD');
  rejects(null, 'INVALID_BODY');
  rejects([], 'INVALID_BODY');
});

test('file names cannot escape or collide', () => {
  for (const name of ['../main.typ', 'a/b.typ', '.hidden.typ', 'Main.typ', 'main.txt', 'x.typ\u0000']) {
    rejects(fixtureBody('F2-ar-en', { template: { 'main.typ': b64('x'), [name]: b64('x') } }), 'INVALID_FILE_NAME');
  }
  for (const name of ['../logo.png', 'data.json', 'logo.jpg', 'main.typ']) {
    rejects(fixtureBody('F2-ar-en', { assets: { [name]: b64('x') } }), 'INVALID_FILE_NAME');
  }
  rejects(fixtureBody('F2-ar-en', { template: { 'other.typ': b64('x') } }), 'MISSING_MAIN_TYP');
});

test('strict base64 and UTF-8', () => {
  rejects(fixtureBody('F2-ar-en', { template: { 'main.typ': 'not base64!' } }), 'INVALID_BASE64');
  rejects(fixtureBody('F2-ar-en', { template: { 'main.typ': Buffer.from([0xff, 0xfe, 0x00]).toString('base64') } }), 'INVALID_TEXT', 400);
});

test('templates may not import packages or read sys.inputs', () => {
  rejects(fixtureBody('F2-ar-en', { template: { 'main.typ': b64('#import "@preview/tiaoma:0.3.0": qrcode') } }), 'TEMPLATE_FORBIDDEN', 422);
  rejects(fixtureBody('F2-ar-en', { template: { 'main.typ': b64("#import '@local/x:1.0.0'") } }), 'TEMPLATE_FORBIDDEN', 422);
  rejects(fixtureBody('F2-ar-en', { template: { 'main.typ': b64('#sys.inputs.at("x")') } }), 'TEMPLATE_FORBIDDEN', 422);
});

test('characters the fonts cannot draw are refused before rendering (POC §C1)', () => {
  const body = fixtureBody('F2-ar-en');
  body.data.employee.fullNameEn = 'Li Wei 李伟';
  assert.throws(
    () => validateRenderRequest(body, coverage),
    (e) => e instanceof RequestError && e.status === 422 && e.code === 'UNSUPPORTED_CHARACTERS'
      && JSON.stringify(e.detail) === JSON.stringify(['U+4F1F', 'U+674E']),
  );
  rejects(fixtureBody('F2-ar-en', { template: { 'main.typ': b64('中') } }), 'UNSUPPORTED_CHARACTERS', 422);
});

test('data: controls, depth, keys, non-finite numbers', () => {
  const ctl = fixtureBody('F2-ar-en');
  ctl.data.employee.fullNameAr = 'محمد\u0007';
  rejects(ctl, 'INVALID_DATA');
  /** @type {any} */
  let deep = {};
  const root = deep;
  for (let i = 0; i < 20; i++) deep = deep.x = {};
  rejects(fixtureBody('F2-ar-en', { data: root }), 'DATA_TOO_DEEP');
  rejects(fixtureBody('F2-ar-en', { data: { 'bad key': 1 } }), 'INVALID_DATA');
  rejects(fixtureBody('F2-ar-en', { data: [] }), 'INVALID_DATA');
});

test('PNG: signature, dimensions, truncation', () => {
  const png = Buffer.from(fixtureBody('F2-ar-en').assets['logo.png'], 'base64');
  checkPng(png, 'logo.png');
  assert.throws(() => checkPng(Buffer.from('GIF89a' + 'x'.repeat(100)), 'x.png'), /INVALID_PNG/);
  assert.throws(() => checkPng(png.subarray(0, png.length - 12), 'x.png'), /INVALID_PNG/);
  const huge = Buffer.from(png);
  huge.writeUInt32BE(50_000, 16);
  assert.throws(() => checkPng(huge, 'x.png'), /PNG_DIMENSIONS/);
});

test('SVG: the QR subset passes; references, entities, scripts and styles do not', () => {
  checkSvg(Buffer.from(fixtureBody('F2-ar-en').assets['qr.svg'], 'base64'), 'qr.svg');
  const cases = [
    '<!DOCTYPE svg [<!ENTITY a "x">]><svg xmlns="http://www.w3.org/2000/svg">&a;</svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///etc/passwd"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><path style="fill:red" d="M0 0"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><path fill="url(#g)" d="M0 0"/></svg>',
    "<svg xmlns='http://www.w3.org/2000/svg'><path d='M0 0'/></svg>",
    '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/>text</svg>',
    '<?xml-stylesheet href="x"?><svg xmlns="http://www.w3.org/2000/svg"/>',
    '<g><svg/></g>',
  ];
  for (const svg of cases) assert.throws(() => checkSvg(Buffer.from(svg), 'qr.svg'), /SVG_NOT_ALLOWED|INVALID_TEXT/, svg);
});
