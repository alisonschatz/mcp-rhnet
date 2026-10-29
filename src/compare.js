import { deref, describeSchema, findOperation, flattenFields, inlineSchema, listOperations, operationParameters, pickContent, securityInfo } from './openapi.js';
import { compareSpecs, sha256 } from './spec-diff.js';

/**
 * Diferenças detalhadas entre duas specs, pensadas para QA.
 *
 * Cada diferença é um item:
 *   { categoria, impacto, local, mudanca, propriedade?, antes?, depois?, resumo }
 *
 * categoria: endpoint | seguranca | parametro | corpo | resposta | exemplo | texto
 * impacto:   quebra  (pode quebrar quem consome a API / testes existentes)
 *            atencao (comportamento novo ou diferente: vale testar)
 *            info    (só documentação: textos e exemplos)
 * mudanca:   adicionado | removido | alterado
 *
 * A comparação é sempre "de A para B" (A = antes/anterior/produção, B = depois/atual/homologação).
 */

export const CATEGORIAS = ['endpoint', 'seguranca', 'parametro', 'corpo', 'resposta', 'exemplo', 'texto'];
export const IMPACTOS = ['quebra', 'atencao', 'info'];
const PESO = { quebra: 3, atencao: 2, info: 1 };
export const maiorImpacto = (itens) => itens.reduce((m, i) => (PESO[i.impacto] > PESO[m] ? i.impacto : m), 'info');

const NOME_PROP = {
  tipo: 'tipo', format: 'formato', obrigatorio: 'obrigatoriedade', nullable: 'aceita null', enum: 'valores (enum)', rotulos: 'rótulos do enum',
  minLength: 'tamanho mínimo', maxLength: 'tamanho máximo', minimum: 'valor mínimo', maximum: 'valor máximo',
  exclusiveMinimum: 'mínimo exclusivo', exclusiveMaximum: 'máximo exclusivo', multipleOf: 'múltiplo de', pattern: 'padrão (regex)',
  minItems: 'mínimo de itens', maxItems: 'máximo de itens', uniqueItems: 'itens únicos', default: 'valor padrão', const: 'valor fixo',
  example: 'exemplo', descricao: 'descrição', deprecated: 'obsoleto', readOnly: 'somente leitura', writeOnly: 'somente escrita',
  itens: 'tipo dos itens', schema: 'schema', mediaType: 'tipo de conteúdo', resumo: 'resumo',
};
const TEXTO = new Set(['descricao', 'rotulos']);
const EXEMPLO = new Set(['example']);
const IGNORAR = new Set(['schema', 'observacao']); // nome do schema de origem não é contrato

const str = (v) => (v === undefined ? '—' : typeof v === 'string' ? v : JSON.stringify(v));
const curto = (v, n = 80) => {
  const s = str(v);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------------
// Regras de impacto
// ---------------------------------------------------------------------------

const MAXIMOS = new Set(['maxLength', 'maximum', 'exclusiveMaximum', 'maxItems']);
const MINIMOS = new Set(['minLength', 'minimum', 'exclusiveMinimum', 'minItems']);

/** Ficou mais restritivo? (só para limites numéricos) */
function maisRestrito(prop, antes, depois) {
  if (MAXIMOS.has(prop)) return depois !== undefined && (antes === undefined || depois < antes);
  if (MINIMOS.has(prop)) return depois !== undefined && (antes === undefined || depois > antes);
  return false;
}

/**
 * Impacto de uma propriedade alterada.
 * entrada = dado que o cliente ENVIA (parâmetros, corpo); saida = dado que o cliente RECEBE (respostas).
 */
function impactoPropriedade(prop, antes, depois, lado) {
  if (TEXTO.has(prop) || EXEMPLO.has(prop)) return 'info';
  if (prop === 'tipo' || prop === 'format' || prop === 'itens' || prop === 'const' || prop === 'mediaType') return 'quebra';
  if (prop === 'pattern') return lado === 'entrada' ? 'quebra' : 'atencao';
  if (prop === 'obrigatorio') {
    if (lado === 'entrada') return depois ? 'quebra' : 'atencao';
    return depois ? 'atencao' : 'quebra'; // na resposta, deixar de ser obrigatório = pode não vir
  }
  if (prop === 'nullable') {
    if (lado === 'entrada') return depois ? 'atencao' : 'quebra';
    return depois ? 'quebra' : 'atencao'; // na resposta, passar a aceitar null = cliente pode receber null
  }
  if (prop === 'enum') {
    const a = new Set((antes || []).map(String));
    const b = new Set((depois || []).map(String));
    const removidos = [...a].some((v) => !b.has(v)) || (antes === undefined && depois !== undefined);
    const adicionados = [...b].some((v) => !a.has(v));
    if (lado === 'entrada') return removidos ? 'quebra' : 'atencao';
    return adicionados ? 'quebra' : 'atencao';
  }
  if (MAXIMOS.has(prop) || MINIMOS.has(prop)) return lado === 'entrada' && maisRestrito(prop, antes, depois) ? 'quebra' : 'atencao';
  return 'atencao'; // default, deprecated, uniqueItems, readOnly...
}

function resumoPropriedade(prop, antes, depois) {
  const nome = NOME_PROP[prop] || prop;
  if (prop === 'obrigatorio') return depois ? 'passou a ser obrigatório' : 'deixou de ser obrigatório';
  if (prop === 'nullable') return depois ? 'passou a aceitar null' : 'deixou de aceitar null';
  if (prop === 'deprecated') return depois ? 'marcado como obsoleto' : 'deixou de ser obsoleto';
  if (prop === 'enum' && Array.isArray(antes) && Array.isArray(depois)) {
    const a = new Set(antes.map(String));
    const b = new Set(depois.map(String));
    const add = [...b].filter((v) => !a.has(v));
    const rem = [...a].filter((v) => !b.has(v));
    return [add.length && `valores novos: ${add.join(', ')}`, rem.length && `valores removidos: ${rem.join(', ')}`].filter(Boolean).join(' · ') || 'ordem dos valores mudou';
  }
  if (antes === undefined) return `${nome} definido: ${curto(depois)}`;
  if (depois === undefined) return `${nome} removido (era ${curto(antes)})`;
  return `${nome}: ${curto(antes)} → ${curto(depois)}`;
}

// ---------------------------------------------------------------------------
// Contrato de uma operação
// ---------------------------------------------------------------------------

const camposDe = (spec, schema, context) => {
  const map = new Map();
  if (!schema) return map;
  for (const f of flattenFields(inlineSchema(spec, schema), { context, maxDepth: 8 })) {
    const { campo, ...rest } = f;
    map.set(campo, rest);
  }
  return map;
};

function exemplosDe(content) {
  const c = pickContent(content);
  if (!c) return {};
  const out = {};
  if (c.examples?.length) for (const e of c.examples) out[e.nome] = e.value;
  else if (c.example !== undefined) out.exemplo = c.example;
  return out;
}

export function contrato(spec, op) {
  const o = op.operation;
  const seg = securityInfo(spec, op);
  const parametros = new Map();
  for (const p of operationParameters(spec, op.pathItem, o)) {
    if (p.in === 'body') continue;
    const schema = inlineSchema(spec, p.schema || {});
    const d = { obrigatorio: p.required === true, ...describeSchema(schema) };
    if (p.description) d.descricao = p.description;
    else delete d.descricao;
    if (p.example !== undefined) d.example = p.example;
    if (p.deprecated) d.deprecated = true;
    parametros.set(`${p.in}.${p.name}`, d);
  }
  const rb = deref(spec, o.requestBody);
  const bodyContent = rb ? pickContent(rb.content) : null;
  const corpo = rb
    ? { obrigatorio: rb.required === true, mediaType: bodyContent?.mediaType || null, campos: camposDe(spec, bodyContent?.schema, 'request'), exemplos: exemplosDe(rb.content) }
    : null;
  const respostas = new Map();
  for (const [status, raw] of Object.entries(o.responses || {})) {
    const r = deref(spec, raw) || {};
    const c = pickContent(r.content);
    respostas.set(status, { descricao: r.description || '', mediaType: c?.mediaType || null, campos: camposDe(spec, c?.schema ?? r.schema, 'response'), exemplos: exemplosDe(r.content) });
  }
  return {
    resumo: o.summary || '',
    descricao: o.description || '',
    tags: o.tags || [],
    operationId: o.operationId || '',
    deprecated: o.deprecated === true,
    seguranca: { exige: seg.exigeAutenticacao, esquemas: seg.esquemas.map((e) => e.nome).sort() },
    parametros,
    corpo,
    respostas,
  };
}

// ---------------------------------------------------------------------------
// Diferença de uma operação
// ---------------------------------------------------------------------------

function compararCampos(itens, mapaA, mapaB, { categoria, prefixo, lado }) {
  for (const [campo, a] of mapaA) {
    const local = `${prefixo}${campo}`;
    const b = mapaB.get(campo);
    if (!b) {
      itens.push({ categoria, impacto: lado === 'saida' ? 'quebra' : 'atencao', local, mudanca: 'removido', antes: a, resumo: `campo removido${a.obrigatorio ? ' (era obrigatório)' : ''}` });
      continue;
    }
    const props = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const prop of props) {
      if (IGNORAR.has(prop) || igual(a[prop], b[prop])) continue;
      const cat = TEXTO.has(prop) ? 'texto' : EXEMPLO.has(prop) ? 'exemplo' : categoria;
      itens.push({ categoria: cat, impacto: impactoPropriedade(prop, a[prop], b[prop], lado), local, mudanca: 'alterado', propriedade: prop, antes: a[prop], depois: b[prop], resumo: resumoPropriedade(prop, a[prop], b[prop]) });
    }
  }
  for (const [campo, b] of mapaB) {
    if (mapaA.has(campo)) continue;
    const impacto = lado === 'entrada' ? (b.obrigatorio ? 'quebra' : 'atencao') : 'atencao';
    itens.push({ categoria, impacto, local: `${prefixo}${campo}`, mudanca: 'adicionado', depois: b, resumo: `campo novo${b.obrigatorio ? ' obrigatório' : ' opcional'}` });
  }
}

function compararExemplos(itens, a, b, local) {
  const nomes = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const nome of nomes) {
    const va = a?.[nome];
    const vb = b?.[nome];
    if (igual(va, vb)) continue;
    const mudanca = va === undefined ? 'adicionado' : vb === undefined ? 'removido' : 'alterado';
    const rotulo = nome === 'exemplo' ? 'exemplo' : `exemplo "${nome}"`;
    itens.push({ categoria: 'exemplo', impacto: 'info', local, mudanca, propriedade: 'example', antes: va, depois: vb, resumo: `${rotulo} ${mudanca}` });
  }
}

function texto(itens, local, prop, antes, depois) {
  if (antes === depois) return;
  const fem = prop === 'descricao';
  const verbo = !antes ? 'adicionad' : !depois ? 'removid' : 'alterad';
  itens.push({ categoria: 'texto', impacto: 'info', local, mudanca: !antes ? 'adicionado' : !depois ? 'removido' : 'alterado', propriedade: prop, antes, depois, resumo: `${NOME_PROP[prop] || prop} ${verbo}${fem ? 'a' : 'o'}` });
}

/** Itens de diferença de uma operação que existe nos dois lados. */
export function diffContrato(ca, cb) {
  const itens = [];
  texto(itens, 'operação', 'resumo', ca.resumo, cb.resumo);
  texto(itens, 'operação', 'descricao', ca.descricao, cb.descricao);
  if (!igual(ca.tags, cb.tags)) itens.push({ categoria: 'endpoint', impacto: 'info', local: 'operação', mudanca: 'alterado', propriedade: 'tags', antes: ca.tags, depois: cb.tags, resumo: `grupo: ${ca.tags.join(', ') || '—'} → ${cb.tags.join(', ') || '—'}` });
  if (ca.operationId !== cb.operationId) itens.push({ categoria: 'endpoint', impacto: 'info', local: 'operação', mudanca: 'alterado', propriedade: 'operationId', antes: ca.operationId, depois: cb.operationId, resumo: `operationId: ${ca.operationId || '—'} → ${cb.operationId || '—'}` });
  if (ca.deprecated !== cb.deprecated) itens.push({ categoria: 'endpoint', impacto: 'atencao', local: 'operação', mudanca: 'alterado', propriedade: 'deprecated', antes: ca.deprecated, depois: cb.deprecated, resumo: resumoPropriedade('deprecated', ca.deprecated, cb.deprecated) });

  if (!igual(ca.seguranca, cb.seguranca)) {
    const passouAExigir = !ca.seguranca.exige && cb.seguranca.exige;
    const resumo = ca.seguranca.exige !== cb.seguranca.exige
      ? cb.seguranca.exige ? 'passou a exigir autenticação' : 'deixou de exigir autenticação'
      : `esquemas de autenticação: ${ca.seguranca.esquemas.join(', ') || '—'} → ${cb.seguranca.esquemas.join(', ') || '—'}`;
    itens.push({ categoria: 'seguranca', impacto: passouAExigir || ca.seguranca.exige === cb.seguranca.exige ? 'quebra' : 'atencao', local: 'autenticação', mudanca: 'alterado', antes: ca.seguranca, depois: cb.seguranca, resumo });
  }

  compararCampos(itens, ca.parametros, cb.parametros, { categoria: 'parametro', prefixo: 'parâmetro ', lado: 'entrada' });

  if (ca.corpo && !cb.corpo) itens.push({ categoria: 'corpo', impacto: 'atencao', local: 'corpo', mudanca: 'removido', resumo: 'a operação deixou de receber corpo' });
  else if (!ca.corpo && cb.corpo) itens.push({ categoria: 'corpo', impacto: cb.corpo.obrigatorio ? 'quebra' : 'atencao', local: 'corpo', mudanca: 'adicionado', resumo: `a operação passou a receber corpo${cb.corpo.obrigatorio ? ' obrigatório' : ''}` });
  if (ca.corpo && cb.corpo) {
    if (ca.corpo.obrigatorio !== cb.corpo.obrigatorio) itens.push({ categoria: 'corpo', impacto: cb.corpo.obrigatorio ? 'quebra' : 'atencao', local: 'corpo', mudanca: 'alterado', propriedade: 'obrigatorio', antes: ca.corpo.obrigatorio, depois: cb.corpo.obrigatorio, resumo: cb.corpo.obrigatorio ? 'corpo passou a ser obrigatório' : 'corpo deixou de ser obrigatório' });
    if (ca.corpo.mediaType !== cb.corpo.mediaType) itens.push({ categoria: 'corpo', impacto: 'quebra', local: 'corpo', mudanca: 'alterado', propriedade: 'mediaType', antes: ca.corpo.mediaType, depois: cb.corpo.mediaType, resumo: resumoPropriedade('mediaType', ca.corpo.mediaType, cb.corpo.mediaType) });
    compararCampos(itens, ca.corpo.campos, cb.corpo.campos, { categoria: 'corpo', prefixo: 'corpo.', lado: 'entrada' });
    compararExemplos(itens, ca.corpo.exemplos, cb.corpo.exemplos, 'corpo');
  } else if (cb.corpo) {
    compararCampos(itens, new Map(), cb.corpo.campos, { categoria: 'corpo', prefixo: 'corpo.', lado: 'entrada' });
  }

  for (const [status, ra] of ca.respostas) {
    const rb = cb.respostas.get(status);
    const local = `resposta ${status}`;
    if (!rb) {
      itens.push({ categoria: 'resposta', impacto: /^2/.test(status) ? 'quebra' : 'atencao', local, mudanca: 'removido', resumo: `status ${status} deixou de ser documentado` });
      continue;
    }
    if (ra.mediaType !== rb.mediaType) itens.push({ categoria: 'resposta', impacto: 'quebra', local, mudanca: 'alterado', propriedade: 'mediaType', antes: ra.mediaType, depois: rb.mediaType, resumo: resumoPropriedade('mediaType', ra.mediaType, rb.mediaType) });
    texto(itens, local, 'descricao', ra.descricao, rb.descricao);
    compararCampos(itens, ra.campos, rb.campos, { categoria: 'resposta', prefixo: `${local}.`, lado: 'saida' });
    compararExemplos(itens, ra.exemplos, rb.exemplos, local);
  }
  for (const [status, rb] of cb.respostas) {
    if (ca.respostas.has(status)) continue;
    itens.push({ categoria: 'resposta', impacto: 'atencao', local: `resposta ${status}`, mudanca: 'adicionado', resumo: `status ${status} passou a ser documentado${rb.descricao ? `: ${curto(rb.descricao, 60)}` : ''}` });
  }
  return itens;
}

const contagem = (itens) => {
  const porCategoria = Object.fromEntries(CATEGORIAS.map((c) => [c, 0]));
  const porImpacto = Object.fromEntries(IMPACTOS.map((i) => [i, 0]));
  for (const i of itens) {
    porCategoria[i.categoria]++;
    porImpacto[i.impacto]++;
  }
  return { porCategoria, porImpacto };
};

/** Diferença de uma operação (existindo em um ou nos dois lados). */
export function diffOperacao(specA, specB, method, path) {
  const opA = findOperation(specA, method, path);
  const opB = findOperation(specB, method, path);
  const operacao = `${String(method).toUpperCase()} ${path}`;
  const info = (op) => ({ resumo: op.operation.summary || '', tag: op.operation.tags?.[0] || '' });
  if (!opA && !opB) return null;
  if (!opA || !opB) {
    const nova = !opA;
    const item = {
      categoria: 'endpoint',
      impacto: nova ? 'atencao' : 'quebra',
      local: 'operação',
      mudanca: nova ? 'adicionado' : 'removido',
      resumo: nova ? 'operação nova' : 'operação removida',
    };
    const itens = [item];
    return { operacao, metodo: operacao.split(' ')[0], path, ...info(opA || opB), situacao: nova ? 'nova' : 'removida', impacto: item.impacto, ...contagem(itens), itens };
  }
  const itens = diffContrato(contrato(specA, opA), contrato(specB, opB));
  const ordem = (i) => -PESO[i.impacto] * 10 + CATEGORIAS.indexOf(i.categoria);
  itens.sort((x, y) => ordem(x) - ordem(y));
  return {
    operacao,
    metodo: operacao.split(' ')[0],
    path,
    ...info(opB),
    situacao: itens.length ? 'alterada' : 'igual',
    impacto: itens.length ? maiorImpacto(itens) : null,
    ...contagem(itens),
    itens,
  };
}

// ---------------------------------------------------------------------------
// Diferença de duas specs inteiras (com cache)
// ---------------------------------------------------------------------------

const cache = new Map();
const hashSpec = new WeakMap();
const hashOf = (spec) => {
  if (!hashSpec.has(spec)) hashSpec.set(spec, sha256(JSON.stringify(spec)));
  return hashSpec.get(spec);
};

/**
 * Todas as operações diferentes entre A e B, cada uma com seus itens.
 * Usa o hash das operações para só detalhar as que mudaram.
 */
export function diffSpecs(specA, specB) {
  const chave = `${hashOf(specA)}:${hashOf(specB)}`;
  if (cache.has(chave)) return cache.get(chave);
  const geral = compareSpecs(specA, specB); // inclui textos
  const keys = [...geral.operacoes.removidas, ...geral.operacoes.adicionadas, ...geral.operacoes.alteradas];
  const operacoes = [];
  for (const k of keys) {
    const [m, ...p] = k.split(' ');
    const d = diffOperacao(specA, specB, m, p.join(' '));
    if (d && d.situacao !== 'igual') operacoes.push(d);
  }
  const ordemSit = { removida: 0, alterada: 1, nova: 2 };
  operacoes.sort((x, y) => PESO[y.impacto] - PESO[x.impacto] || ordemSit[x.situacao] - ordemSit[y.situacao] || x.path.localeCompare(y.path));
  const todos = operacoes.flatMap((o) => o.itens);
  const resultado = {
    resumo: {
      operacoes: {
        novas: operacoes.filter((o) => o.situacao === 'nova').length,
        removidas: operacoes.filter((o) => o.situacao === 'removida').length,
        alteradas: operacoes.filter((o) => o.situacao === 'alterada').length,
      },
      ...contagem(todos),
      operacoesPorImpacto: Object.fromEntries(IMPACTOS.map((i) => [i, operacoes.filter((o) => o.impacto === i).length])),
      schemas: { novos: geral.schemas.adicionadas, removidos: geral.schemas.removidas, alterados: geral.schemas.alteradas },
    },
    operacoes,
  };
  if (cache.size > 6) cache.delete(cache.keys().next().value);
  cache.set(chave, resultado);
  return resultado;
}

/** Filtra operações/itens por categoria, impacto, situação, tag e texto. */
export function filtrarDiff(diff, { categoria, impacto, situacao, tag, busca } = {}) {
  const termo = (busca || '').toLowerCase().trim();
  const okItem = (i) => (!categoria || i.categoria === categoria) && (!impacto || i.impacto === impacto);
  return diff.operacoes
    .filter((o) => (!situacao || o.situacao === situacao) && (!tag || o.tag === tag))
    .filter((o) => !termo || `${o.operacao} ${o.resumo} ${o.tag} ${o.itens.map((i) => i.local).join(' ')}`.toLowerCase().includes(termo))
    .map((o) => ({ ...o, itens: o.itens.filter(okItem) }))
    .filter((o) => o.itens.length);
}

/** Visão compacta de uma operação (sem os itens), para listas. */
export const semItens = ({ itens, ...o }) => o;

/** Para listar operações sem diferença de contrato (só textos/exemplos). */
export const soDocumentacao = (o) => o.itens.every((i) => i.impacto === 'info');

export { listOperations };
