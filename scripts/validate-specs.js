#!/usr/bin/env node
/**
 * Valida as specs em specs/ antes de commitar (ou no CI).
 * As regras ficam em src/validate.js (as mesmas usadas pela atualização automática).
 */
import fs from 'node:fs';
import { SPECS_DIR } from '../src/config.js';
import { listApiIds, specPath } from '../src/specs.js';
import { validateSpec } from '../src/validate.js';

const files = fs.existsSync(SPECS_DIR) ? fs.readdirSync(SPECS_DIR).filter((f) => f.endsWith('.json')) : [];
const ids = listApiIds();
let totalErrors = 0;

for (const file of files) {
  const id = file.slice(0, -5);
  if (!ids.includes(id)) {
    console.log(`\n✖ ${file}\n  - nome de arquivo inválido: use apenas letras, números, ".", "_" e "-"`);
    totalErrors++;
  }
}

for (const id of ids) {
  let spec;
  let result;
  try {
    const raw = fs.readFileSync(specPath(id), 'utf8');
    spec = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    result = validateSpec(spec);
  } catch (e) {
    result = { errors: [`JSON inválido: ${e.message}`], warnings: [], operations: 0 };
  }
  const { errors, warnings, operations } = result;
  console.log(`\n${errors.length ? '✖' : '✔'} ${id} — ${spec?.info?.title || '(sem título)'} (${operations} operações)`);
  errors.forEach((e) => console.log(`  ERRO  ${e}`));
  warnings.forEach((w) => console.log(`  aviso ${w}`));
  totalErrors += errors.length;
}

if (!files.length) console.log(`Nenhuma spec em ${SPECS_DIR} (normal: as specs são enviadas pela página).`);
console.log(`\n${totalErrors ? `✖ ${totalErrors} erro(s).` : '✔ Todas as specs válidas.'}`);
process.exit(totalErrors ? 1 : 0);
