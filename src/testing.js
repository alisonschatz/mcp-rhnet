import {
  describeSchema,
  flattenFields,
  inlineSchema,
  operationParameters,
  requestBodyInfo,
  responsesInfo,
  securityInfo,
  typeInfo,
} from './openapi.js';

// ---------------------------------------------------------------------------
// Payload de exemplo
// ---------------------------------------------------------------------------

const FORMAT_EXAMPLES = {
  email: 'qa.teste@example.com',
  uuid: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
  date: '2026-01-15',
  'date-time': '2026-01-15T10:30:00Z',
  time: '10:30:00',
  uri: 'https://example.com/recurso',
  url: 'https://example.com/recurso',
  hostname: 'example.com',
  ipv4: '192.168.0.10',
  ipv6: '2001:db8::1',
  byte: 'dGVzdGU=',
  password: 'Senha@Teste123',
};

// Heurísticas por nome de campo, úteis para APIs brasileiras. Os documentos são válidos (dígitos verificadores ok).
const NAME_HINTS = [
  [/cpf/i, ['52998224725', '529.982.247-25']],
  [/cnpj/i, ['11222333000181', '11.222.333/0001-81']],
  [/\bcep\b|cep$/i, ['01001000', '01001-000']],
  [/telefone|celular|phone/i, ['11999998888', '(11) 99999-8888']],
  [/e-?mail/i, ['qa.teste@example.com']],
  [/^nome$|name$/i, ['Nome Teste QA']],
];

function matchesPattern(value, pattern) {
  try {
    return new RegExp(pattern, 'u').test(value);
  } catch {
    return true; // pattern que o JS não entende: não bloqueia
  }
}

function numericBounds(s, step) {
  let min = s.minimum;
  let max = s.maximum;
  let exMin = false;
  let exMax = false;
  if (typeof s.exclusiveMinimum === 'number') [min, exMin] = [s.exclusiveMinimum, true];
  else if (s.exclusiveMinimum === true) exMin = true;
  if (typeof s.exclusiveMaximum === 'number') [max, exMax] = [s.exclusiveMaximum, true];
  else if (s.exclusiveMaximum === true) exMax = true;
  const round = (n) => Math.round(n * 1e6) / 1e6;
  return {
    min,
    max,
    validMin: min === undefined ? undefined : round(exMin ? min + step : min),
    invalidMin: min === undefined ? undefined : round(exMin ? min : min - step),
    validMax: max === undefined ? undefined : round(exMax ? max - step : max),
    invalidMax: max === undefined ? undefined : round(exMax ? max : max + step),
  };
}

function stepFor(schema, type) {
  if (typeof schema.multipleOf === 'number') return schema.multipleOf;
  return type === 'integer' ? 1 : 0.01;
}

/**
 * Gera um valor válido para o schema (já inline).
 * mode "completo" preenche todos os campos; "minimo" só os obrigatórios.
 */
export function buildExample(schema, mode = 'completo', ctx = { avisos: [] }, fieldName = '', path = '', depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 10) return null;
  if (schema._corte) {
    ctx.avisos.push(`${path || '(raiz)'}: ${schema._corte} (${schema.$ref}); valor omitido.`);
    return null;
  }
  if (schema.example !== undefined) return schema.example;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  if (schema.const !== undefined) return schema.const;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum.find((v) => v !== null) ?? schema.enum[0];

  const variants = schema.oneOf || schema.anyOf;
  if (variants?.length && !schema.properties) {
    if (variants.length > 1) ctx.avisos.push(`${path || '(raiz)'}: oneOf/anyOf com ${variants.length} variantes; usada a primeira.`);
    return buildExample({ ...schema, oneOf: undefined, anyOf: undefined, ...variants[0] }, mode, ctx, fieldName, path, depth + 1);
  }

  const { type } = typeInfo(schema);
  switch (type) {
    case 'object': {
      const required = new Set(schema.required || []);
      const obj = {};
      for (const [name, prop] of Object.entries(schema.properties || {})) {
        if (prop.readOnly) continue;
        if (mode === 'minimo' && !required.has(name)) continue;
        obj[name] = buildExample(prop, mode, ctx, name, path ? `${path}.${name}` : name, depth + 1);
      }
      if (!schema.properties && schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        obj.chave = buildExample(schema.additionalProperties, mode, ctx, 'chave', `${path}.chave`, depth + 1);
      }
      return obj;
    }
    case 'array': {
      const count = Math.max(1, schema.minItems || 0);
      return Array.from({ length: count }, () => buildExample(schema.items || {}, mode, ctx, fieldName, `${path}[]`, depth + 1));
    }
    case 'integer':
    case 'number': {
      const b = numericBounds(schema, stepFor(schema, type));
      if (b.validMin !== undefined) return b.validMin;
      if (b.validMax !== undefined) return Math.min(b.validMax, type === 'integer' ? 1 : 10.5);
      return type === 'integer' ? 1 : 10.5;
    }
    case 'boolean':
      return true;
    case 'string': {
      const candidates = [];
      if (FORMAT_EXAMPLES[schema.format]) candidates.push(FORMAT_EXAMPLES[schema.format]);
      for (const [re, values] of NAME_HINTS) if (re.test(fieldName)) candidates.push(...values);
      candidates.push(`${fieldName || 'valor'}-teste`);
      let value = schema.pattern
        ? candidates.find((c) => matchesPattern(c, schema.pattern))
        : candidates[0];
      if (value === undefined) {
        ctx.avisos.push(`${path}: não foi possível gerar valor que atenda o pattern ${schema.pattern}; ajuste manualmente.`);
        value = candidates[0];
      }
      if (schema.minLength && value.length < schema.minLength) value = value.padEnd(schema.minLength, 'x');
      if (schema.maxLength !== undefined && value.length > schema.maxLength) value = value.slice(0, schema.maxLength);
      return value;
    }
    default:
      return null;
  }
}

export function examplePayload(spec, op, mode = 'completo') {
  const body = requestBodyInfo(spec, op);
  const ctx = { avisos: [] };
  const params = {};
  for (const p of operationParameters(spec, op.pathItem, op.operation)) {
    if (p.in === 'body') continue;
    if (mode === 'minimo' && !p.required) continue;
    const schema = inlineSchema(spec, paramSchema(p));
    params[p.in] ??= {};
    params[p.in][p.name] = p.example ?? buildExample(schema, mode, ctx, p.name, `${p.in}.${p.name}`);
  }
  let corpo = null;
  let origemCorpo = null;
  if (body) {
    if (body.example !== undefined && mode === 'completo') {
      corpo = body.example;
      origemCorpo = 'exemplo declarado na spec';
    } else if (body.schema) {
      corpo = buildExample(inlineSchema(spec, body.schema), mode, ctx, '', '');
      origemCorpo = 'gerado a partir do schema';
    }
  }
  return { parametros: params, contentType: body?.mediaType || null, corpo, origemCorpo, avisos: ctx.avisos };
}

// Swagger 2 descreve parâmetros não-body sem "schema".
function paramSchema(p) {
  if (p.schema) return p.schema;
  const { name, in: _in, required, description, ...rest } = p;
  return rest;
}

// ---------------------------------------------------------------------------
// Contexto de teste (visão achatada da operação)
// ---------------------------------------------------------------------------

export function testContext(spec, op) {
  const params = operationParameters(spec, op.pathItem, op.operation)
    .filter((p) => p.in !== 'body')
    .map((p) => ({
      nome: p.name,
      in: p.in,
      obrigatorio: p.required === true,
      ...describeSchema(inlineSchema(spec, paramSchema(p))),
      ...(p.description ? { descricao: p.description } : {}),
    }));

  const body = requestBodyInfo(spec, op);
  const corpo = body
    ? {
        obrigatorio: body.required,
        contentType: body.mediaType,
        schema: body.schema?.$ref ? body.schema.$ref.split('/').pop() : null,
        campos: body.schema ? flattenFields(inlineSchema(spec, body.schema), { context: 'request' }) : [],
        temExemplo: body.example !== undefined,
      }
    : null;

  const respostas = {};
  for (const [status, r] of Object.entries(responsesInfo(spec, op))) {
    respostas[status] = {
      descricao: r.description,
      schema: r.schema?.$ref ? r.schema.$ref.split('/').pop() : r.schema ? '(inline)' : null,
      campos: r.schema ? flattenFields(inlineSchema(spec, r.schema), { context: 'response', maxDepth: 2 }) : [],
    };
  }

  return {
    operacao: `${op.method.toUpperCase()} ${op.path}`,
    operationId: op.operation.operationId || null,
    resumo: op.operation.summary || null,
    descricao: op.operation.description || null,
    deprecated: op.operation.deprecated === true,
    seguranca: securityInfo(spec, op),
    parametros: params,
    corpo,
    respostas,
  };
}

// ---------------------------------------------------------------------------
// Cenários de teste derivados da spec
// ---------------------------------------------------------------------------

const PRIORIDADE = { alta: 0, media: 1, baixa: 2 };
const CATEGORIA_ORDEM = ['positivo', 'seguranca', 'recurso', 'validacao', 'limite', 'erro-documentado', 'idempotencia'];
const IGNORED_HEADERS = new Set(['authorization', 'content-type', 'accept']);

function sizedString(n) {
  return n <= 40 ? 'a'.repeat(n) : { $gerar: 'string', tamanho: n };
}

function wrongTypeValue(type) {
  return { string: 12345, integer: 'abc', number: 'abc', boolean: 'talvez', array: { nao: 'lista' }, object: 'texto' }[type];
}

const INVALID_FORMAT = {
  email: 'email-invalido',
  uuid: '123-nao-e-uuid',
  date: '2026-13-45',
  'date-time': '31/12/2026 10:00',
  time: '25:61:00',
  uri: 'nao e uma url',
  url: 'nao e uma url',
  ipv4: '999.1.1.1',
  byte: '%%%',
};

function statusPicker(responses, covered) {
  const codes = Object.keys(responses);
  return (candidates) => {
    for (const c of candidates) {
      if (codes.includes(c)) {
        covered.add(c);
        return c;
      }
    }
    for (const c of candidates) {
      const range = `${c[0]}XX`;
      if (codes.includes(range)) return range;
    }
    if (codes.includes('default')) return `default (spec não detalha; provável ${candidates[0]})`;
    return `${candidates[0]} (não documentado na spec — confirmar com o time)`;
  };
}

/** Cenários de limite/formato/enum para um campo ou parâmetro já descrito por describeSchema. */
function constraintScenarios(d, alvo, campo, add, validation) {
  const rotulo = `${alvo === 'body' ? 'Campo' : `Parâmetro ${alvo}`} "${campo}"`;
  const invalido = (titulo, valor, extra = {}) =>
    add({ categoria: extra.categoria || 'limite', prioridade: extra.prioridade || 'media', titulo: `${rotulo}: ${titulo}`, alteracao: { alvo, campo, acao: 'definir', valor }, esperado: { status: validation } });
  const valido = (titulo, valor) =>
    add({ categoria: 'limite', prioridade: 'baixa', titulo: `${rotulo}: ${titulo}`, alteracao: { alvo, campo, acao: 'definir', valor }, esperado: { status: 'sucesso', observacao: 'valor no limite deve ser aceito' } });

  if (Array.isArray(d.enum) && d.enum.length) {
    const sample = d.enum.find((v) => v !== null);
    const fora = typeof sample === 'number' ? Math.max(...d.enum.filter((v) => typeof v === 'number')) + 1 : `${sample}_INVALIDO`;
    invalido(`valor fora do enum (${d.enum.slice(0, 8).join(', ')}${d.enum.length > 8 ? ', ...' : ''})`, fora, { categoria: 'validacao' });
    if (typeof sample === 'string' && sample.toLowerCase() !== sample.toUpperCase()) {
      const trocado = sample === sample.toUpperCase() ? sample.toLowerCase() : sample.toUpperCase();
      if (!d.enum.includes(trocado)) invalido(`enum com caixa diferente ("${trocado}") — confirmar se é case-sensitive`, trocado, { categoria: 'validacao', prioridade: 'baixa' });
    }
    return; // com enum, limites de tamanho/format são redundantes
  }

  if (d.tipo === 'string') {
    if (d.minLength > 0) {
      invalido(`abaixo do minLength (${d.minLength - 1} caracteres)`, sizedString(d.minLength - 1));
      valido(`exatamente no minLength (${d.minLength})`, sizedString(d.minLength));
    }
    if (d.maxLength !== undefined) {
      valido(`exatamente no maxLength (${d.maxLength})`, sizedString(d.maxLength));
      invalido(`acima do maxLength (${d.maxLength + 1} caracteres)`, sizedString(d.maxLength + 1));
    }
    if (d.pattern) invalido(`não atende o pattern ${d.pattern}`, '!!valor-invalido!!', { categoria: 'validacao' });
    if (INVALID_FORMAT[d.format]) invalido(`formato ${d.format} inválido`, INVALID_FORMAT[d.format], { categoria: 'validacao' });
  }

  if (d.tipo === 'integer' || d.tipo === 'number') {
    const b = numericBounds(d, stepFor(d, d.tipo));
    if (b.validMin !== undefined) {
      valido(`no limite mínimo (${b.validMin})`, b.validMin);
      invalido(`abaixo do mínimo (${b.invalidMin})`, b.invalidMin);
    }
    if (b.validMax !== undefined) {
      valido(`no limite máximo (${b.validMax})`, b.validMax);
      invalido(`acima do máximo (${b.invalidMax})`, b.invalidMax);
    }
    if (d.tipo === 'integer') invalido('valor decimal em campo inteiro', 1.5, { categoria: 'validacao', prioridade: 'baixa' });
  }

  if (d.tipo === 'array') {
    if (d.minItems > 0) invalido(`lista com ${d.minItems - 1} itens (minItems ${d.minItems})`, d.minItems - 1 === 0 ? [] : { $gerar: 'lista', itens: d.minItems - 1 });
    if (d.maxItems !== undefined) invalido(`lista com ${d.maxItems + 1} itens (maxItems ${d.maxItems})`, { $gerar: 'lista', itens: d.maxItems + 1 });
    if (d.uniqueItems) invalido('lista com itens duplicados (uniqueItems)', { $gerar: 'lista-duplicada' }, { categoria: 'validacao' });
    if (d.itens?.enum) invalido('item da lista fora do enum', [`${d.itens.enum[0]}_INVALIDO`], { categoria: 'validacao' });
  }
}

function nonExistentId(d) {
  if (d.format === 'uuid') return '00000000-0000-0000-0000-000000000000';
  if (d.tipo === 'integer' || d.tipo === 'number') return 999999999;
  return 'id-inexistente-qa';
}

/**
 * Deriva uma lista determinística de cenários a partir da spec. Serve como checklist
 * de cobertura: a IA completa com regras de negócio que a spec não descreve.
 */
export function deriveTestScenarios(spec, op) {
  const method = op.method;
  const responses = responsesInfo(spec, op);
  const covered = new Set();
  const pick = statusPicker(responses, covered);
  const cenarios = [];
  const lacunas = [];
  const add = (c) => cenarios.push(c);

  const successCodes = Object.keys(responses).filter((s) => /^2/.test(s));
  const sucesso = successCodes[0] || `${method === 'post' ? '201' : '200'} (não documentado — confirmar)`;
  successCodes.forEach((c) => covered.add(c));
  const validation = pick(['400', '422']);
  const successSchema = responses[successCodes[0]]?.schema;
  const successSchemaName = successSchema?.$ref ? successSchema.$ref.split('/').pop() : successSchema ? '(inline)' : null;
  const contrato = successSchemaName ? `validar o corpo da resposta contra o schema ${successSchemaName}` : undefined;

  const body = requestBodyInfo(spec, op);
  const bodySchema = body?.schema ? inlineSchema(spec, body.schema) : null;
  const campos = bodySchema ? flattenFields(bodySchema, { context: 'request' }) : [];

  // --- positivos
  const temParametros = operationParameters(spec, op.pathItem, op.operation).some((p) => p.in !== 'path' && p.in !== 'body');
  add({ categoria: 'positivo', prioridade: 'alta', titulo: body || temParametros ? 'Requisição válida com todos os campos preenchidos' : 'Requisição válida', alteracao: { base: 'payload completo (generate_example_payload modo "completo")' }, esperado: { status: sucesso, observacao: contrato } });
  const temOpcional = campos.some((c) => !c.obrigatorio) || operationParameters(spec, op.pathItem, op.operation).some((p) => !p.required && p.in !== 'body');
  if (temOpcional) add({ categoria: 'positivo', prioridade: 'alta', titulo: 'Requisição válida apenas com campos e parâmetros obrigatórios', alteracao: { base: 'payload mínimo (generate_example_payload modo "minimo")' }, esperado: { status: sucesso, observacao: contrato } });
  for (const extra of successCodes.slice(1)) {
    add({ categoria: 'positivo', prioridade: 'media', titulo: `Cenário que retorna ${extra}: ${responses[extra].description || ''}`.trim(), alteracao: { observacao: 'definir condição a partir da regra de negócio' }, esperado: { status: extra } });
  }

  // --- segurança
  const sec = securityInfo(spec, op);
  if (sec.exigeAutenticacao) {
    const esquemas = sec.esquemas.map((e) => e.header ? `${e.nome} (header ${e.header})` : `${e.nome} (${e.scheme || e.tipo})`).join(', ');
    const unauthorized = pick(['401']);
    add({ categoria: 'seguranca', prioridade: 'alta', titulo: `Requisição sem credencial (${esquemas})`, alteracao: { alvo: 'header', acao: 'remover credencial' }, esperado: { status: unauthorized } });
    add({ categoria: 'seguranca', prioridade: 'alta', titulo: 'Requisição com credencial inválida ou expirada', alteracao: { alvo: 'header', acao: 'definir credencial inválida' }, esperado: { status: unauthorized } });
    if (responses['403']) add({ categoria: 'seguranca', prioridade: 'alta', titulo: 'Credencial válida sem permissão/escopo para a operação', alteracao: { alvo: 'header', acao: 'usar usuário sem permissão' }, esperado: { status: pick(['403']) } });
  } else if (!sec.declarada) {
    lacunas.push('Nenhuma segurança declarada (nem global nem na operação): confirmar se a operação é pública.');
  }

  // --- parâmetros
  for (const p of operationParameters(spec, op.pathItem, op.operation)) {
    if (p.in === 'body') continue;
    if (p.in === 'header' && IGNORED_HEADERS.has(p.name.toLowerCase())) continue;
    const d = describeSchema(inlineSchema(spec, paramSchema(p)));
    if (p.in === 'path') {
      add({ categoria: 'recurso', prioridade: 'alta', titulo: `Path "${p.name}" de recurso inexistente`, alteracao: { alvo: 'path', campo: p.name, acao: 'definir', valor: nonExistentId(d) }, esperado: { status: pick(['404']) } });
      if (d.tipo === 'integer' || d.tipo === 'number') {
        add({ categoria: 'validacao', prioridade: 'media', titulo: `Path "${p.name}" com tipo inválido`, alteracao: { alvo: 'path', campo: p.name, acao: 'definir', valor: 'abc' }, esperado: { status: pick(['400', '404']) } });
      }
      constraintScenarios(d, 'path', p.name, add, pick(['400', '404']));
      continue;
    } else {
      if (p.required) add({ categoria: 'validacao', prioridade: 'alta', titulo: `Parâmetro ${p.in} obrigatório "${p.name}" ausente`, alteracao: { alvo: p.in, campo: p.name, acao: 'remover' }, esperado: { status: validation } });
      if (['integer', 'number', 'boolean'].includes(d.tipo)) add({ categoria: 'validacao', prioridade: 'media', titulo: `Parâmetro ${p.in} "${p.name}" com tipo inválido`, alteracao: { alvo: p.in, campo: p.name, acao: 'definir', valor: wrongTypeValue(d.tipo) }, esperado: { status: validation } });
    }
    constraintScenarios(d, p.in, p.name, add, validation);
  }

  // --- corpo
  if (body) {
    if (body.required) add({ categoria: 'validacao', prioridade: 'alta', titulo: 'Requisição sem corpo', alteracao: { alvo: 'body', acao: 'omitir-corpo' }, esperado: { status: validation } });
    if (/json/.test(body.mediaType || '')) {
      add({ categoria: 'validacao', prioridade: 'baixa', titulo: 'Corpo com JSON malformado', alteracao: { alvo: 'body', acao: 'corpo-bruto', valor: '{"campo": ' }, esperado: { status: pick(['400']) } });
      add({ categoria: 'validacao', prioridade: 'baixa', titulo: 'Content-Type não suportado (text/plain)', alteracao: { alvo: 'header', campo: 'Content-Type', acao: 'definir', valor: 'text/plain' }, esperado: { status: pick(['415', '400']) } });
    }
    for (const c of campos) {
      if (c.obrigatorio) add({ categoria: 'validacao', prioridade: 'alta', titulo: `Campo obrigatório "${c.campo}" ausente`, alteracao: { alvo: 'body', campo: c.campo, acao: 'remover' }, esperado: { status: validation } });
      const aninhado = c.campo.includes('.') || c.campo.includes('[]');
      if (c.obrigatorio && !c.nullable && c.tipo) add({ categoria: 'validacao', prioridade: aninhado ? 'baixa' : 'media', titulo: `Campo obrigatório "${c.campo}" com null`, alteracao: { alvo: 'body', campo: c.campo, acao: 'definir', valor: null }, esperado: { status: validation } });
      if (c.tipo === 'string' && c.obrigatorio && !c.enum && !c.pattern && !c.format && !(c.minLength > 0)) add({ categoria: 'validacao', prioridade: 'media', titulo: `Campo obrigatório "${c.campo}" com string vazia — confirmar regra`, alteracao: { alvo: 'body', campo: c.campo, acao: 'definir', valor: '' }, esperado: { status: `${validation} (provável; spec não define minLength)` } });
      const errado = wrongTypeValue(c.tipo);
      if (errado !== undefined) add({ categoria: 'validacao', prioridade: aninhado ? 'baixa' : 'media', titulo: `Campo "${c.campo}" com tipo inválido (esperado ${c.tipo})`, alteracao: { alvo: 'body', campo: c.campo, acao: 'definir', valor: errado }, esperado: { status: validation } });
      constraintScenarios(c, 'body', c.campo, add, validation);
    }
    const semMax = campos.filter((c) => c.tipo === 'string' && c.maxLength === undefined && !c.enum && !c.format).map((c) => c.campo);
    if (semMax.length) lacunas.push(`Campos string sem maxLength (limite superior não testável pela spec): ${semMax.join(', ')}.`);
    if (body.example === undefined) lacunas.push('Corpo da requisição sem exemplo declarado; o payload será gerado a partir do schema.');
    if (!body.schema) lacunas.push('Corpo da requisição sem schema.');
  } else if (['post', 'put', 'patch'].includes(method)) {
    lacunas.push(`${method.toUpperCase()} sem corpo de requisição declarado: confirmar se é intencional.`);
  }

  // --- idempotência
  const hasPathParam = operationParameters(spec, op.pathItem, op.operation).some((p) => p.in === 'path');
  if (method === 'delete' && hasPathParam) add({ categoria: 'idempotencia', prioridade: 'baixa', titulo: 'Excluir o mesmo recurso duas vezes', alteracao: { observacao: 'repetir a mesma chamada após sucesso' }, esperado: { status: pick(['404', '204']), observacao: 'segunda chamada' } });
  if (method === 'put') add({ categoria: 'idempotencia', prioridade: 'baixa', titulo: 'Repetir o mesmo PUT deve manter o estado e o resultado', alteracao: { observacao: 'enviar a mesma requisição duas vezes' }, esperado: { status: sucesso } });

  // --- respostas documentadas ainda não cobertas
  for (const [status, r] of Object.entries(responses)) {
    if (covered.has(status) || status === 'default') continue;
    add({ categoria: 'erro-documentado', prioridade: 'media', titulo: `Provocar ${status}: ${r.description || '(sem descrição)'}`, alteracao: { observacao: 'definir a condição a partir da regra de negócio' }, esperado: { status } });
  }

  // --- lacunas gerais
  if (!Object.keys(responses).some((s) => /^4/.test(s))) lacunas.push('Nenhuma resposta 4xx documentada: os status esperados dos cenários negativos são suposições.');
  if (successCodes.length && !successSchema && !successCodes.every((c) => c === '204')) lacunas.push(`Resposta de sucesso ${successCodes[0]} sem schema: não dá para validar contrato.`);
  if (!op.operation.description && !op.operation.summary) lacunas.push('Operação sem summary/description: regra de negócio precisa vir do time.');
  if (JSON.stringify(bodySchema || {}).includes('referência não resolvida')) lacunas.push('Há $ref que não resolve dentro da spec (possível ref externa).');

  cenarios.sort((a, b) => CATEGORIA_ORDEM.indexOf(a.categoria) - CATEGORIA_ORDEM.indexOf(b.categoria) || PRIORIDADE[a.prioridade] - PRIORIDADE[b.prioridade]);
  cenarios.forEach((c, i) => {
    c.id = `CT-${String(i + 1).padStart(3, '0')}`;
    if (c.esperado.status === 'sucesso') c.esperado.status = sucesso;
    if (c.esperado.observacao === undefined) delete c.esperado.observacao;
  });

  return {
    operacao: `${method.toUpperCase()} ${op.path}`,
    statusSucesso: sucesso,
    statusValidacao: validation,
    cenarios: cenarios.map(({ id, ...rest }) => ({ id, ...rest })),
    lacunasDaSpec: lacunas,
  };
}
