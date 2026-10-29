import fs from 'node:fs';
import path from 'node:path';
import { HISTORY_DIR, SPECS_DIR } from './config.js';

const VALID_ID = /^[A-Za-z0-9._-]+$/;
const fileCache = new Map();

/**
 * Em serverless (Vercel) o sistema de arquivos da função não é confiável para ler
 * specs/ em runtime, então o build gera src/specs.bundle.js com todas as specs e o
 * entrypoint registra aqui. Localmente (stdio/http) as specs são lidas do disco.
 */
let bundled = null;

/**
 * Versões carregadas de um armazenamento remoto (Vercel Blob). Têm prioridade sobre o
 * bundle e o disco, e são trocadas em memória quando a tela de admin aplica uma versão nova.
 */
const overrides = new Map();

export function setSpecOverride(apiId, spec) {
  if (VALID_ID.test(apiId) && spec && typeof spec === 'object') overrides.set(apiId, spec);
}

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
  const extra = [...overrides.keys()];
  if (bundled) return [...new Set([...Object.keys(bundled), ...extra])].filter((id) => VALID_ID.test(id)).sort();
  let entries;
  try {
    entries = fs.readdirSync(SPECS_DIR, { withFileTypes: true });
  } catch {
    return extra.sort();
  }
  const fromDisk = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.json')).map((e) => e.name.slice(0, -'.json'.length));
  return [...new Set([...fromDisk, ...extra])].filter((id) => VALID_ID.test(id)).sort();
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
  if (overrides.has(apiId)) return { spec: overrides.get(apiId) };
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
      atualizadaEm: lastUpdate(id),
    };
  });
}

/** Data da última atualização automática/pela tela (registrada em specs/.historico). */
function lastUpdate(apiId) {
  if (bundled || overrides.has(apiId)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, `${apiId}.meta.json`), 'utf8')).ultimaAtualizacao || null;
  } catch {
    return null;
  }
}
