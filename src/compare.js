import { findOperation, flattenFields, inlineSchema, operationParameters, requestBodyInfo, responsesInfo, describeSchema, deref } from './openapi.js';
import { compareSpecs } from './spec-diff.js';

/**
 * Comparação entre duas specs (ex.: homologação × produção).
 * - compareApis: o que existe só em uma, só na outra e o que mudou (operações e schemas).
 * - compareOperation: diferença campo a campo de uma operação (parâmetros, corpo, respostas).
 */

export function compareApis(specA, specB) {
  const d = compareSpecs(specA, specB);
  return {
    operacoes: { soEmB: d.operacoes.adicionadas, soEmA: d.operacoes.removidas, diferentes: d.operacoes.alteradas },
    schemas: { soEmB: d.schemas.adicionadas, soEmA: d.schemas.removidas, diferentes: d.schemas.alteradas },
    totalDiferencas: d.totalMudancas,
  };
}

const semDescricao = (o, incluir) => {
  if (incluir || !o || typeof o !== 'object') return o;
  const { descricao, description, ...rest } = o;
  return rest;
};

/** Mapa "chave → descrição comparável" de tudo que define o contrato de uma operação. */
function contrato(spec, op, incluirDescricoes) {
  const map = new Map();
  for (const p of operationParameters(spec, op.pathItem, op.operation)) {
    if (p.in === 'body') continue;
    const info = { obrigatorio: p.required === true, ...describeSchema(deref(spec, p.schema) || p) };
    if (p.description) info.descricao = p.description;
    map.set(`parametro ${p.in}.${p.name}`, semDescricao(info, incluirDescricoes));
  }
  const body = requestBodyInfo(spec, op);
  if (body?.schema) {
    map.set('corpo', semDescricao({ obrigatorio: body.required, mediaType: body.mediaType }, true));
    for (const f of flattenFields(inlineSchema(spec, body.schema), { context: 'request' })) {
      const { campo, ...rest } = f;
      map.set(`corpo.${campo}`, semDescricao(rest, incluirDescricoes));
    }
  }
  for (const [status, r] of Object.entries(responsesInfo(spec, op))) {
    map.set(`resposta ${status}`, semDescricao({ mediaType: r.mediaType, descricao: r.description }, incluirDescricoes));
    if (!r.schema) continue;
    for (const f of flattenFields(inlineSchema(spec, r.schema), { context: 'response' })) {
      const { campo, ...rest } = f;
      map.set(`resposta ${status}.${campo}`, semDescricao(rest, incluirDescricoes));
    }
  }
  return map;
}

export function compareOperation(specA, specB, method, path, { incluirDescricoes = false } = {}) {
  const opA = findOperation(specA, method, path);
  const opB = findOperation(specB, method, path);
  const label = `${method.toUpperCase()} ${path}`;
  if (!opA && !opB) return { operacao: label, existeEmA: false, existeEmB: false };
  if (!opA || !opB) return { operacao: label, existeEmA: Boolean(opA), existeEmB: Boolean(opB) };

  const a = contrato(specA, opA, incluirDescricoes);
  const b = contrato(specB, opB, incluirDescricoes);
  const soEmA = [];
  const soEmB = [];
  const diferentes = [];
  for (const [k, v] of a) {
    if (!b.has(k)) soEmA.push({ item: k, ...v });
    else if (JSON.stringify(v) !== JSON.stringify(b.get(k))) diferentes.push({ item: k, a: v, b: b.get(k) });
  }
  for (const [k, v] of b) if (!a.has(k)) soEmB.push({ item: k, ...v });
  const resumo = (o) => (o.summary || o.description || '').trim();
  return {
    operacao: label,
    existeEmA: true,
    existeEmB: true,
    ...(resumo(opA.operation) !== resumo(opB.operation) ? { resumoDiferente: { a: resumo(opA.operation), b: resumo(opB.operation) } } : {}),
    iguais: !soEmA.length && !soEmB.length && !diferentes.length,
    soEmA,
    soEmB,
    diferentes,
  };
}
