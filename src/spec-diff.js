import crypto from 'node:crypto';
import { listOperations, resolvePointer } from './openapi.js';

export const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** Resumo de uma spec. O hash é do conteúdo (JSON.stringify), não da formatação do arquivo. */
export function summarize(spec, text) {
  return {
    titulo: spec.info?.title || null,
    versao: spec.info?.version || null,
    openapi: spec.openapi || spec.swagger || null,
    operacoes: spec.paths ? listOperations(spec).length : 0,
    schemas: Object.keys(spec.components?.schemas || {}).length,
    hash: sha256(JSON.stringify(spec)), // independe da formatação do arquivo
    tamanho: Buffer.byteLength(text),
  };
}

/**
 * Hash de uma operação que inclui os schemas/parâmetros referenciados ($ref), direta ou
 * indiretamente: uma mudança num schema usado pela operação conta como mudança nela.
 */
function operationHasher(spec) {
  const refHash = new Map();
  const collect = (node, refs) => {
    if (Array.isArray(node)) node.forEach((n) => collect(n, refs));
    else if (node && typeof node === 'object') {
      if (typeof node.$ref === 'string' && node.$ref.startsWith('#/') && !refs.has(node.$ref)) {
        refs.add(node.$ref);
        collect(resolvePointer(spec, node.$ref), refs);
      }
      for (const [k, v] of Object.entries(node)) if (k !== '$ref') collect(v, refs);
    }
  };
  const hashRef = (ref) => {
    if (!refHash.has(ref)) refHash.set(ref, sha256(JSON.stringify(resolvePointer(spec, ref) ?? null)));
    return refHash.get(ref);
  };
  return (op) => {
    const own = { shared: op.pathItem?.parameters, op: op.operation };
    const refs = new Set();
    collect(own, refs);
    return sha256(JSON.stringify({ own, deps: [...refs].sort().map((r) => [r, hashRef(r)]) }));
  };
}

function operationMap(spec) {
  const map = new Map();
  if (!spec?.paths) return map;
  const hashOf = operationHasher(spec);
  for (const op of listOperations(spec)) {
    const key = `${op.method.toUpperCase()} ${op.path}`;
    map.set(key, { hash: hashOf(op), summary: op.operation.summary || '', tag: op.operation.tags?.[0] || '' });
  }
  return map;
}

function diffKeys(oldMap, newMap) {
  const adicionadas = [];
  const removidas = [];
  const alteradas = [];
  for (const [k, v] of newMap) {
    if (!oldMap.has(k)) adicionadas.push(k);
    else if (oldMap.get(k).hash !== v.hash) alteradas.push(k);
  }
  for (const k of oldMap.keys()) if (!newMap.has(k)) removidas.push(k);
  return { adicionadas, removidas, alteradas };
}

/** O que mudou entre duas specs: operações e schemas adicionados, removidos e alterados. */
export function compareSpecs(oldSpec, newSpec) {
  const ops = diffKeys(operationMap(oldSpec), operationMap(newSpec));
  const schemaMap = (s) => new Map(Object.entries(s?.components?.schemas || {}).map(([k, v]) => [k, { hash: sha256(JSON.stringify(v)) }]));
  const schemas = diffKeys(schemaMap(oldSpec), schemaMap(newSpec));
  const total = ops.adicionadas.length + ops.removidas.length + ops.alteradas.length + schemas.adicionadas.length + schemas.removidas.length + schemas.alteradas.length;
  return { operacoes: ops, schemas, totalMudancas: total };
}

export const diffCounts = (d) => ({
  operacoes: { adicionadas: d.operacoes.adicionadas.length, removidas: d.operacoes.removidas.length, alteradas: d.operacoes.alteradas.length },
  schemas: { adicionados: d.schemas.adicionadas.length, removidos: d.schemas.removidas.length, alterados: d.schemas.alteradas.length },
});
