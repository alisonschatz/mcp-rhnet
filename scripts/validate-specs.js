#!/usr/bin/env node
/**
 * Valida as specs em specs/ antes de commitar (ou no CI).
 * Erros (exit 1): JSON inválido, sem versão OpenAPI, sem paths, $ref local quebrada, operationId duplicado.
 * Avisos: Swagger 2.0, operação sem summary, sem respostas 4xx, sem exemplos, $ref externa.
 */
import fs from 'node:fs';
import { SPECS_DIR } from '../src/config.js';
import { listApiIds, specPath } from '../src/specs.js';
import { listOperations, requestBodyInfo, resolvePointer } from '../src/openapi.js';

function collectRefs(node, out = [], where = '#') {
  if (Array.isArray(node)) node.forEach((n, i) => collectRefs(n, out, `${where}/${i}`));
  else if (node && typeof node === 'object') {
    if (typeof node.$ref === 'string') out.push({ ref: node.$ref, where });
    for (const [k, v] of Object.entries(node)) if (k !== '$ref') collectRefs(v, out, `${where}/${k}`);
  }
  return out;
}

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
  const errors = [];
  const warnings = [];
  let spec;
  try {
    const raw = fs.readFileSync(specPath(id), 'utf8');
    spec = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (e) {
    errors.push(`JSON inválido: ${e.message}`);
  }

  if (spec) {
    if (spec.swagger) warnings.push(`Swagger ${spec.swagger}: suportado parcialmente; prefira converter para OpenAPI 3 (ex.: npx swagger2openapi).`);
    else if (!/^3\./.test(String(spec.openapi || ''))) errors.push('Campo "openapi" ausente ou não é 3.x.');
    if (!spec.paths || !Object.keys(spec.paths).length) errors.push('Nenhum "paths" definido.');

    for (const { ref, where } of collectRefs(spec)) {
      if (!ref.startsWith('#/')) warnings.push(`$ref externa não suportada em ${where}: ${ref} (embuta o conteúdo na spec).`);
      else if (resolvePointer(spec, ref) == null) errors.push(`$ref quebrada em ${where}: ${ref}`);
    }

    const seenIds = new Map();
    let semSummary = 0;
    let sem4xx = 0;
    let semExemplo = 0;
    const ops = listOperations(spec);
    for (const op of ops) {
      const label = `${op.method.toUpperCase()} ${op.path}`;
      const opId = op.operation.operationId;
      if (opId) {
        if (seenIds.has(opId)) errors.push(`operationId "${opId}" duplicado (${seenIds.get(opId)} e ${label}).`);
        seenIds.set(opId, label);
      }
      if (!op.operation.responses || !Object.keys(op.operation.responses).length) errors.push(`${label}: sem "responses".`);
      if (!op.operation.summary && !op.operation.description) semSummary++;
      if (!Object.keys(op.operation.responses || {}).some((s) => /^4/.test(s))) sem4xx++;
      const body = requestBodyInfo(spec, op);
      if (body && body.example === undefined && body.schema?.example === undefined) semExemplo++;
    }
    if (semSummary) warnings.push(`${semSummary} operação(ões) sem summary/description.`);
    if (sem4xx) warnings.push(`${sem4xx} operação(ões) sem nenhuma resposta 4xx documentada.`);
    if (semExemplo) warnings.push(`${semExemplo} corpo(s) de requisição sem exemplo.`);
    console.log(`\n${errors.length ? '✖' : '✔'} ${id} — ${spec.info?.title || '(sem título)'} (${ops.length} operações)`);
  } else {
    console.log(`\n✖ ${id}`);
  }

  errors.forEach((e) => console.log(`  ERRO  ${e}`));
  [...new Set(warnings)].forEach((w) => console.log(`  aviso ${w}`));
  totalErrors += errors.length;
}

if (!files.length) console.log(`Nenhuma spec encontrada em ${SPECS_DIR}.`);
console.log(`\n${totalErrors ? `✖ ${totalErrors} erro(s).` : '✔ Todas as specs válidas.'}`);
process.exit(totalErrors ? 1 : 0);
