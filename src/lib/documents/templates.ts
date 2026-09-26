// Template bundles (ADR DOC-01 / DOC-07). A bundle is the type's main file + the shared layout,
// sent to radeef-render as { 'main.typ', 'letter.typ' }. Its identity (templateSha256) is the
// SHA-256 of the canonical list of "<name> <sha256>" lines, so it changes with any file.
import 'server-only';
import { readFile } from 'fs/promises';
import path from 'path';
import { sha256Hex } from './core';
import type { DocumentLanguage, DocumentTypeDefinition } from './types';

/**
 * Where the .typ files live. next.config.ts traces this directory into the standalone build
 * (outputFileTracingIncludes), so the path is the same in dev, `next start` and standalone.
 */
export function templatesDir(): string {
  return path.join(process.cwd(), 'src', 'lib', 'documents', 'templates');
}

export interface TemplateBundle {
  templateRef: string; // typst:<template>/<language>@<version>
  files: Record<string, Buffer>;
  sha256: string;
}

const cache = new Map<string, TemplateBundle>();

export function bundleHash(files: Record<string, Buffer>): string {
  const lines = Object.keys(files).sort().map((name) => `${name} ${sha256Hex(files[name])}\n`).join('');
  return sha256Hex(lines);
}

export async function loadTemplate(def: DocumentTypeDefinition, language: DocumentLanguage): Promise<TemplateBundle> {
  const templateRef = `typst:${def.template}/${language}@${def.templateVersion}`;
  const hit = cache.get(templateRef);
  if (hit && process.env.NODE_ENV === 'production') return hit;
  const dir = templatesDir();
  const files = {
    'main.typ': await readFile(path.join(dir, `${def.template}.typ`)),
    'letter.typ': await readFile(path.join(dir, 'letter.typ')),
  };
  const bundle = { templateRef, files, sha256: bundleHash(files) };
  cache.set(templateRef, bundle);
  return bundle;
}
