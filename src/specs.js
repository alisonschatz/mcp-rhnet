import fs from 'node:fs';
import path from 'node:path';
import { SPECS_DIR } from './config.js';

const VALID_ID = /^[A-Za-z0-9._-]+$/;
const fileCache = new Map();

/**
 * Em serverless (Vercel) o sistema de arquivos da função não é confiável para ler
 * specs/ em runtime, então o build gera src/specs.bundle.js com todas as specs e o
 * entrypoint registra aqui. Localmente (stdio/http) as specs são lidas do disco.
 */
let bundled = null;

export function useBundledSpecs(bundle) {
  bundled = bundle && typeof bundle === 'object' ? bundle : null;
}

/** Lê e faz parse de um arquivo, reaproveitando o cache enquanto o mtime não mudar. */
function readJsonCached(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  const cached = fileCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.data;
  const raw = fs.readFileSync(filePath, 'utf8');
  const data = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  fileCache.set(filePath, { mtimeMs: stat.mtimeMs, data });
  return data;
}

/** O id de cada API é o nome do arquivo sem ".json" (ex.: specs/pedidos.json -> "pedidos"). */
export function listApiIds() {
  if (bundled) return Object.keys(bundled).filter((id) => VALID_ID.test(id)).sort();
  let entries;
  try {
    entries = fs.readdirSync(SPECS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.json'))
    .map((e) => e.name.slice(0, -'.json'.length))
    .filter((id) => VALID_ID.test(id))
    .sort();
}

export function specPath(apiId) {
  return path.join(SPECS_DIR, `${apiId}.json`);
}

/**
 * Carrega a spec de uma API. Retorna { spec } ou { error } — nunca lança,
 * para que um JSON quebrado em uma API não derrube as outras.
 */
export function loadSpec(apiId) {
  if (typeof apiId !== 'string' || !VALID_ID.test(apiId) || !listApiIds().includes(apiId)) {
    return { error: `API "${apiId}" não encontrada. Use list_apis para ver os ids válidos.` };
  }
  if (bundled) return { spec: bundled[apiId] };
  try {
    const spec = readJsonCached(specPath(apiId));
    if (!spec || typeof spec !== 'object') return { error: `Spec "${apiId}" está vazia ou inválida.` };
    return { spec };
  } catch (e) {
    return { error: `Falha ao ler a spec "${apiId}": ${e.message}` };
  }
}

export function listApis() {
  return listApiIds().map((id) => {
    const { spec, error } = loadSpec(id);
    if (error) return { id, title: id, error };
    return {
      id,
      title: spec.info?.title || id,
      version: spec.info?.version || null,
      openapi: spec.openapi || spec.swagger || null,
    };
  });
}
