export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];

const SCHEMA_REF = /^#\/(?:components\/schemas|definitions)\/(.+)$/;

// ---------------------------------------------------------------------------
// $ref
// ---------------------------------------------------------------------------

/** Resolve um JSON Pointer local ("#/components/..."). Refs externas retornam null. */
export function resolvePointer(spec, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  let node = spec;
  for (const raw of ref.slice(2).split('/')) {
    const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    if (node == null || typeof node !== 'object' || !(key in node)) return null;
    node = node[key];
  }
  return node;
}

/** Segue $ref até chegar em um objeto concreto (parâmetros, requestBodies, responses...). */
export function deref(spec, obj, maxHops = 10) {
  let current = obj;
  for (let i = 0; i < maxHops && current && typeof current.$ref === 'string'; i++) {
    const target = resolvePointer(spec, current.$ref);
    if (!target) return current;
    current = target;
  }
  return current;
}

export function refName(ref) {
  const m = SCHEMA_REF.exec(ref || '');
  return m ? decodeURIComponent(m[1]) : ref;
}

/** Reescreve "#/components/schemas/Nome" -> "Nome" sem seguir a referência. */
export function shortenRefs(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(shortenRefs);
  if (typeof schema.$ref === 'string') return { $ref: refName(schema.$ref) };
  const result = {};
  for (const [key, value] of Object.entries(schema)) result[key] = shortenRefs(value);
  return result;
}

/** Resolve só o primeiro nível; objetos aninhados continuam como ponteiros { $ref: "Nome" }. */
export function resolveOneLevel(spec, schema) {
  if (!schema) return null;
  if (typeof schema.$ref === 'string') {
    const target = resolvePointer(spec, schema.$ref);
    return shortenRefs(target || schema);
  }
  return shortenRefs(schema);
}

export function getSchemaByName(spec, name) {
  return spec.components?.schemas?.[name] ?? spec.definitions?.[name] ?? null;
}

export function listSchemaNames(spec) {
  return Object.keys(spec.components?.schemas || spec.definitions || {});
}

// ---------------------------------------------------------------------------
// Inline completo (para geração de exemplos e cenários de teste)
// ---------------------------------------------------------------------------

function mergeAllOf(parts) {
  const merged = {};
  const required = new Set();
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    for (const [k, v] of Object.entries(part)) {
      if (k === 'properties') merged.properties = { ...(merged.properties || {}), ...v };
      else if (k === 'required') v.forEach((r) => required.add(r));
      else if (merged[k] === undefined) merged[k] = v;
    }
  }
  if (required.size) merged.required = [...required];
  if (!merged.type && merged.properties) merged.type = 'object';
  return merged;
}

/**
 * Devolve o schema com todas as $ref locais expandidas e allOf mesclado.
 * Ciclos e profundidade excessiva viram { $ref: "Nome", _corte: "..." }.
 */
export function inlineSchema(spec, schema, maxDepth = 25, seen = [], depth = 0) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map((s) => inlineSchema(spec, s, maxDepth, seen, depth));

  if (typeof schema.$ref === 'string') {
    const name = refName(schema.$ref);
    if (seen.includes(schema.$ref)) return { $ref: name, _corte: 'referência cíclica' };
    if (depth >= maxDepth) return { $ref: name, _corte: 'profundidade máxima' };
    const target = resolvePointer(spec, schema.$ref);
    if (!target) return { $ref: name, _corte: 'referência não resolvida' };
    const { $ref, ...siblings } = schema;
    const resolved = inlineSchema(spec, target, maxDepth, [...seen, schema.$ref], depth + 1);
    return Object.keys(siblings).length ? { ...resolved, ...siblings, _schema: name } : { ...resolved, _schema: name };
  }

  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'properties' && v && typeof v === 'object') {
      out.properties = {};
      for (const [p, ps] of Object.entries(v)) out.properties[p] = inlineSchema(spec, ps, maxDepth, seen, depth + 1);
    } else if (k === 'example' || k === 'examples' || k === 'default' || k === 'enum' || k === 'const') {
      out[k] = v;
    } else if (v && typeof v === 'object') {
      out[k] = inlineSchema(spec, v, maxDepth, seen, depth + 1);
    } else {
      out[k] = v;
    }
  }
  if (Array.isArray(out.allOf)) {
    const { allOf, ...rest } = out;
    return mergeAllOf([...allOf, rest]);
  }
  return out;
}

/** Normaliza tipo e nulidade entre OpenAPI 3.0 (nullable) e 3.1 (type: [..., "null"]). */
export function typeInfo(schema) {
  if (!schema) return { type: null, nullable: false };
  let type = schema.type;
  let nullable = schema.nullable === true;
  if (Array.isArray(type)) {
    nullable = nullable || type.includes('null');
    type = type.find((t) => t !== 'null') || null;
  }
  if (!type) {
    if (schema.properties) type = 'object';
    else if (schema.items) type = 'array';
    else if (schema.oneOf || schema.anyOf) type = 'oneOf';
  }
  return { type: type || null, nullable };
}

const isNullSchema = (s) => Boolean(s) && (s.type === 'null' || (Array.isArray(s.type) && s.type.length === 1 && s.type[0] === 'null'));

const CONSTRAINT_KEYS = [
  'format', 'enum', 'const', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum',
  'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minItems', 'maxItems', 'uniqueItems',
  'default', 'example', 'readOnly', 'writeOnly', 'deprecated',
];

/** Extrai tipo, nulidade e restrições de um schema já inline. */
export function describeSchema(schema) {
  const { type, nullable } = typeInfo(schema);
  const d = { tipo: type };
  if (nullable) d.nullable = true;
  for (const key of CONSTRAINT_KEYS) if (schema?.[key] !== undefined) d[key] = schema[key];
  const rotulos = enumLabels(schema);
  if (rotulos) {
    if (d.enum === undefined) d.enum = (schema.oneOf || schema.anyOf).filter((v) => !isNullSchema(v)).map((v) => singleValue(v)[0]);
    d.rotulos = rotulos;
    if (d.tipo === 'oneOf') d.tipo = typeof d.enum[0] === 'number' ? (Number.isInteger(d.enum[0]) ? 'integer' : 'number') : typeof d.enum[0];
  }
  if (schema?._schema) d.schema = schema._schema;
  if (schema?.description) d.descricao = schema.description;
  return d;
}

const singleValue = (v) => (v?.const !== undefined ? [v.const] : Array.isArray(v?.enum) && v.enum.length === 1 ? v.enum : null);

/**
 * "Enum rotulado": oneOf/anyOf em que cada variante é um único valor com title
 * (ex.: { title: "0 - Empregado...", enum: [0] }). Devolve { valor: rótulo } ou null.
 */
export function enumLabels(schema) {
  const list = (schema?.oneOf || schema?.anyOf || []).filter((v) => !isNullSchema(v));
  if (list.length < 2 || !list.every((v) => singleValue(v) && !v.properties)) return null;
  return Object.fromEntries(list.map((v) => [String(singleValue(v)[0]), v.title || v.description || null]));
}

/** Variantes relevantes de um oneOf/anyOf (ignora a variante só-null de OpenAPI 3.1 e enums rotulados). */
export function schemaVariants(schema) {
  if (!schema || schema.properties || enumLabels(schema)) return [];
  const list = schema.oneOf || schema.anyOf;
  return Array.isArray(list) ? list.filter((v) => !isNullSchema(v)) : [];
}

/**
 * Se o schema raiz é oneOf/anyOf, devolve a variante escolhida (padrão 0) e a lista
 * de variantes para informar à IA; senão devolve o próprio schema.
 */
export function selectVariant(schema, index = 0) {
  const variants = schemaVariants(schema);
  if (!variants.length) return { schema, variantes: [], indice: null };
  const i = Number.isInteger(index) && index >= 0 && index < variants.length ? index : 0;
  const { oneOf, anyOf, ...rest } = schema;
  return {
    schema: { ...rest, ...variants[i] },
    variantes: variants.map((v, n) => ({ indice: n, schema: v._schema || v.title || `variante ${n}`, ...(v.description ? { descricao: v.description } : {}) })),
    indice: i,
  };
}

/**
 * Achata um schema em uma lista de campos com caminho ("cliente.endereco.cep", "itens[].sku"),
 * obrigatoriedade e restrições — o formato mais útil para montar casos de teste.
 * Em contexto "request" ignora readOnly; em "response" ignora writeOnly.
 * oneOf/anyOf aninhados usam a primeira variante e são sinalizados só no campo pai.
 */
export function flattenFields(schema, { context = 'request', maxDepth = 5 } = {}) {
  const fields = [];
  const unwrap = (node) => {
    const variants = schemaVariants(node);
    if (!variants.length) return { node, total: 0 };
    const { oneOf, anyOf, ...rest } = node;
    return { node: { ...rest, ...variants[0] }, total: variants.length };
  };
  const walk = (raw, prefix, depth) => {
    if (!raw || depth > maxDepth) return;
    const { node } = unwrap(raw);
    const required = new Set(node.required || []);
    for (const [name, rawProp] of Object.entries(node.properties || {})) {
      const { node: prop, total } = unwrap(rawProp);
      if (context === 'request' && prop.readOnly) continue;
      if (context === 'response' && prop.writeOnly) continue;
      const campo = prefix ? `${prefix}.${name}` : name;
      const d = { campo, obrigatorio: required.has(name), ...describeSchema(prop) };
      if (rawProp.nullable || isNullSchema((rawProp.oneOf || rawProp.anyOf || []).find(isNullSchema))) d.nullable = true;
      if (total > 1) d.observacao = `${total} variantes (oneOf/anyOf); listada a primeira`;
      if (prop._corte) {
        d.tipo = 'object';
        d.observacao = `${prop._corte}: detalhe com get_schema_definition("${prop.$ref}")`;
      }
      fields.push(d);
      const { type } = typeInfo(prop);
      if (type === 'object') walk(prop, campo, depth + 1);
      if (type === 'array' && prop.items) {
        const { node: items } = unwrap(prop.items);
        if (typeInfo(items).type === 'object') walk(items, `${campo}[]`, depth + 1);
        else d.itens = describeSchema(items);
      }
    }
  };
  walk(schema, '', 0);
  return fields;
}

// ---------------------------------------------------------------------------
// Operações
// ---------------------------------------------------------------------------

/** Parâmetros do path-item + da operação (a operação sobrescreve por name+in), já resolvidos. */
export function operationParameters(spec, pathItem, operation) {
  const byKey = new Map();
  for (const raw of [...(pathItem?.parameters || []), ...(operation?.parameters || [])]) {
    const p = deref(spec, raw);
    if (!p || !p.name) continue;
    byKey.set(`${p.in}:${p.name}`, p);
  }
  return [...byKey.values()];
}

export function listOperations(spec) {
  const ops = [];
  for (const [opPath, rawItem] of Object.entries(spec.paths || {})) {
    const pathItem = deref(spec, rawItem);
    for (const method of HTTP_METHODS) {
      const operation = pathItem?.[method];
      if (operation) ops.push({ method, path: opPath, pathItem, operation });
    }
  }
  return ops;
}

export function findOperation(spec, method, opPath) {
  const m = String(method || '').toLowerCase();
  const pathItem = deref(spec, spec.paths?.[opPath]);
  const operation = pathItem?.[m];
  return operation ? { method: m, path: opPath, pathItem, operation } : null;
}

export function operationNotFoundMessage(spec, apiId, method, opPath) {
  const samePath = spec.paths?.[opPath]
    ? HTTP_METHODS.filter((m) => deref(spec, spec.paths[opPath])?.[m]).map((m) => m.toUpperCase())
    : [];
  const hint = samePath.length
    ? ` O caminho existe com os métodos: ${samePath.join(', ')}.`
    : ' Confira o caminho exato com list_operations.';
  return `Operação "${String(method).toUpperCase()} ${opPath}" não encontrada em "${apiId}".${hint}`;
}

/** Escolhe a entrada de content, preferindo JSON. */
export function pickContent(content) {
  if (!content || typeof content !== 'object') return null;
  const types = Object.keys(content);
  const preferred =
    types.find((t) => t === 'application/json') ||
    types.find((t) => /[/+]json\b/.test(t)) ||
    types[0];
  if (!preferred) return null;
  const entry = content[preferred] || {};
  const examples =
    entry.examples && typeof entry.examples === 'object'
      ? Object.entries(entry.examples).map(([nome, ex]) => ({ nome, resumo: ex?.summary || null, value: ex?.value }))
      : [];
  const example = entry.example !== undefined ? entry.example : examples[0]?.value;
  return { mediaType: preferred, schema: entry.schema, example, examples, mediaTypes: types };
}

/** Corpo da requisição (OpenAPI 3 requestBody ou Swagger 2 parâmetro in: body). */
export function requestBodyInfo(spec, op) {
  const rb = deref(spec, op.operation.requestBody);
  if (rb) {
    const c = pickContent(rb.content);
    return {
      required: rb.required === true,
      description: rb.description || null,
      mediaType: c?.mediaType || null,
      mediaTypes: c?.mediaTypes || [],
      schema: c?.schema,
      example: c?.example,
      examples: c?.examples || [],
    };
  }
  const bodyParam = operationParameters(spec, op.pathItem, op.operation).find((p) => p.in === 'body');
  if (bodyParam) {
    const consumes = op.operation.consumes || spec.consumes || ['application/json'];
    return {
      required: bodyParam.required === true,
      description: bodyParam.description || null,
      mediaType: consumes[0],
      mediaTypes: consumes,
      schema: bodyParam.schema,
      example: bodyParam['x-example'],
      examples: [],
    };
  }
  return null;
}

export function responsesInfo(spec, op) {
  const result = {};
  for (const [status, raw] of Object.entries(op.operation.responses || {})) {
    const response = deref(spec, raw) || {};
    const c = pickContent(response.content);
    const schema = c?.schema ?? response.schema; // Swagger 2 coloca schema direto na response
    result[status] = {
      description: response.description || null,
      mediaType: c?.mediaType || null,
      schema,
      example: c?.example ?? response.examples?.['application/json'],
    };
  }
  return result;
}

/** Requisitos de segurança efetivos (operação sobrescreve o global; [] = pública). */
export function securityInfo(spec, op) {
  const requirements = op.operation.security ?? spec.security ?? [];
  const schemes = spec.components?.securitySchemes || spec.securityDefinitions || {};
  const usados = new Set(requirements.flatMap((r) => Object.keys(r)));
  const detalhes = [...usados].map((name) => {
    const s = deref(spec, schemes[name]) || {};
    return {
      nome: name,
      tipo: s.type || null,
      scheme: s.scheme || null,
      in: s.in || null,
      header: s.type === 'apiKey' ? s.name : null,
      bearerFormat: s.bearerFormat || null,
    };
  });
  return {
    exigeAutenticacao: requirements.length > 0 && !requirements.some((r) => Object.keys(r).length === 0),
    declarada: op.operation.security !== undefined || spec.security !== undefined,
    esquemas: detalhes,
    escopos: requirements,
  };
}
