#!/usr/bin/env node
/**
 * Gera, para deploy serverless (Vercel):
 * - src/specs.bundle.js  as specs de specs/ (versão inicial; as atualizações vão para o Blob)
 * - src/site.bundle.js   a página (/)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listApiIds, loadSpec } from '../src/specs.js';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const bundle = {};
for (const id of listApiIds()) {
  const { spec, error } = loadSpec(id);
  if (error) {
    console.error(`✖ ${id}: ${error}`);
    process.exit(1);
  }
  bundle[id] = spec;
}
const header = '// Gerado por scripts/build-bundle.js — não editar.\n';
const read = (f) => fs.readFileSync(path.join(src, f), 'utf8');
fs.writeFileSync(path.join(src, 'specs.bundle.js'), `${header}export default ${JSON.stringify(bundle)};\n`);
fs.writeFileSync(path.join(src, 'site.bundle.js'), `${header}export default ${JSON.stringify({ page: read('site.html') })};\n`);
console.log(`✔ ${Object.keys(bundle).length} spec(s), e a página empacotadas`);
