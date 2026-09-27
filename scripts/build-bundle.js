#!/usr/bin/env node
/** Gera src/specs.bundle.js com todas as specs, para deploy serverless (Vercel). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listApiIds, loadSpec } from '../src/specs.js';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'specs.bundle.js');
const bundle = {};
for (const id of listApiIds()) {
  const { spec, error } = loadSpec(id);
  if (error) {
    console.error(`✖ ${id}: ${error}`);
    process.exit(1);
  }
  bundle[id] = spec;
}
fs.writeFileSync(out, `// Gerado por scripts/build-bundle.js — não editar.\nexport default ${JSON.stringify(bundle)};\n`);
console.log(`✔ ${Object.keys(bundle).length} spec(s) empacotadas em src/specs.bundle.js`);
