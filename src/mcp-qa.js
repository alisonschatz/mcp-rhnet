import { z } from 'zod';
import { CATEGORIAS, contrato, diffOperacao, diffSpecs, filtrarDiff, IMPACTOS, semItens } from './compare.js';
import { findOperation, getSchemaByName, listOperations, listSchemaNames, operationParameters, refName } from './openapi.js';
import { listApiIds, loadSpec } from './specs.js';
import { previousSpec } from './updater.js';

/**
 * Ferramentas de QA: comparação detalhada (por categoria e impacto), busca indexada em
 * toda a documentação, schemas e onde são usados, exemplos das operações.
 * Tudo paginado e cabendo no limite de resposta.
 */

const FILTROS = {
  categoria: z.enum(CATEGORIAS).optional().describe('Só diferenças desta categoria: endpoint, seguranca, parametro, corpo, resposta, exemplo, texto'),
  impacto: z.enum(IMPACTOS).optional().describe('Só diferenças deste impacto: quebra (pode quebrar consumidores/testes), atencao (vale testar), info (só documentação)'),
  situacao: z.enum(['nova', 'removida', 'alterada']).optional().describe('Só operações novas, removidas ou alteradas'),
  tag: z.string().optional().describe('Só operações deste grupo (tag), ex.: "Admissões"'),
  busca: z.string().optional().describe('Texto no caminho, resumo, grupo ou local do campo, ex.: "cpf"'),
  incluirItens: z.boolean().optional().describe('Trazer os itens de cada operação na lista (padrão: só contagens)'),
};

const LEGENDA =
  'impacto: quebra = pode quebrar consumidores e testes existentes; atencao = comportamento novo/diferente, vale testar; info = só documentação (textos/exemplos). ' +
  'antes = lado A, depois = lado B.';

// ---------------------------------------------------------------------------
// Índice de busca (por spec, em cache)
// ---------------------------------------------------------------------------

const indices = new WeakMap();
const ORDEM_TIPO = { operacao: 0, parametro: 1, campo: 2, resposta: 3, schema: 4, exemplo: 5 };

function indexar(spec) {
  if (indices.has(spec)) return indices.get(spec);
  const itens = [];
  for (const op of listOperations(spec)) {
    const M = op.method.toUpperCase();
    const base = { metodo: M, path: op.path };
    const o = op.operation;
    itens.push({ tipo: 'operacao', ...base, nome: `${M} ${op.path}`, local: o.tags?.[0] || '', texto: [o.operationId, o.summary, o.description, ...(o.tags || [])].join(' '), resumo: o.summary || '' });
    let c;
    try {
      c = contrato(spec, op);
    } catch {
      continue;
    }
    for (const [chave, p] of c.parametros) {
      const [onde, nome] = [chave.split('.')[0], chave.split('.').slice(1).join('.')];
      itens.push({ tipo: 'parametro', ...base, nome, local: `parâmetro ${onde}`, texto: [p.descricao, ...(p.enum || []), ...Object.values(p.rotulos || {})].join(' '), detalhe: resumoCampo(p) });
    }
    const campos = (mapa, local) => {
      for (const [campo, f] of mapa) {
        itens.push({ tipo: 'campo', ...base, nome: campo.split('.').pop().replace('[]', ''), local: `${local}.${campo}`, texto: [f.descricao, f.format, f.schema, ...(f.enum || []), ...Object.values(f.rotulos || {})].join(' '), detalhe: resumoCampo(f) });
      }
    };
    const exemplos = (ex, local) => {
      for (const [nome, valor] of Object.entries(ex || {})) itens.push({ tipo: 'exemplo', ...base, nome, local, texto: JSON.stringify(valor ?? '').slice(0, 4000) });
    };
    if (c.corpo) {
      campos(c.corpo.campos, 'corpo');
      exemplos(c.corpo.exemplos, 'corpo');
    }
    for (const [status, r] of c.respostas) {
      itens.push({ tipo: 'resposta', ...base, nome: status, local: `resposta ${status}`, texto: r.descricao });
      campos(r.campos, `resposta ${status}`);
      exemplos(r.exemplos, `resposta ${status}`);
    }
  }
  for (const nome of listSchemaNames(spec)) {
    const s = getSchemaByName(spec, nome) || {};
    itens.push({ tipo: 'schema', nome, local: 'components.schemas', texto: [s.description, s.title, ...Object.keys(s.properties || {})].join(' ') });
  }
  for (const i of itens) i._busca = { nome: String(i.nome).toLowerCase(), local: String(i.local).toLowerCase(), texto: String(i.texto || '').toLowerCase() };
  indices.set(spec, itens);
  return itens;
}

function resumoCampo(f) {
  const d = { tipo: f.tipo, obrigatorio: f.obrigatorio };
  for (const k of ['format', 'nullable', 'minLength', 'maxLength', 'minimum', 'maximum', 'pattern', 'default', 'deprecated']) if (f[k] !== undefined) d[k] = f[k];
  if (f.enum) d.enum = f.enum.length > 15 ? [...f.enum.slice(0, 15), '…'] : f.enum;
  if (f.descricao) d.descricao = f.descricao.length > 160 ? `${f.descricao.slice(0, 159)}…` : f.descricao;
  return d;
}

function pontuar(i, termo) {
  const { nome, local, texto } = i._busca;
  if (nome === termo) return 100;
  if (nome.startsWith(termo)) return 70;
  if (nome.includes(termo)) return 50;
  if (local.includes(termo)) return 30;
  if (texto.includes(termo)) return 10;
  return 0;
}

// ---------------------------------------------------------------------------
// Uso de schemas
// ---------------------------------------------------------------------------

const usos = new WeakMap();

/** Para cada schema, as operações que o usam (direta ou indiretamente). */
function mapaDeUso(spec) {
  if (usos.has(spec)) return usos.get(spec);
  const porSchema = new Map();
  const resolver = (ref) => ref.split('/').slice(1).reduce((o, k) => (o == null ? o : o[k.replace(/~1/g, '/').replace(/~0/g, '~')]), spec);
  for (const op of listOperations(spec)) {
    const vistos = new Set();
    const onde = new Map(); // schema → locais
    const visitar = (node, local) => {
      if (Array.isArray(node)) return node.forEach((n) => visitar(n, local));
      if (!node || typeof node !== 'object') return;
      if (typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
        if (node.$ref.startsWith('#/components/schemas/')) {
          const n = refName(node.$ref);
          if (!onde.has(n)) onde.set(n, new Set());
          onde.get(n).add(local);
        }
        if (!vistos.has(node.$ref)) {
          vistos.add(node.$ref);
          visitar(resolver(node.$ref), local);
        }
      }
      for (const [k, v] of Object.entries(node)) if (k !== '$ref') visitar(v, local);
    };
    const o = op.operation;
    visitar([...(op.pathItem?.parameters || []), ...(o.parameters || [])], 'parâmetros');
    visitar(o.requestBody, 'corpo');
    for (const [status, r] of Object.entries(o.responses || {})) visitar(r, `resposta ${status}`);
    for (const [n, locais] of onde) {
      if (!porSchema.has(n)) porSchema.set(n, []);
      porSchema.get(n).push({ metodo: op.method.toUpperCase(), path: op.path, resumo: o.summary || '', onde: [...locais] });
    }
  }
  usos.set(spec, porSchema);
  return porSchema;
}

// ---------------------------------------------------------------------------
// Registro
// ---------------------------------------------------------------------------

export function registerQaTools(server, h) {
  const { toolText, toolError, paginateFitting, PAGE_PARAMS, API_ID, readOnly } = h;

  /** Resposta comum das comparações (lista de operações ou itens de uma operação). */
  function responderComparacao(specA, specB, header, args) {
    const { method, path, categoria, impacto, situacao, tag, busca, incluirItens, page, pageSize } = args;
    if (method && path) {
      const d = diffOperacao(specA, specB, method, path);
      if (!d) return toolError(`Operação ${method.toUpperCase()} ${path} não existe em nenhum dos lados.`);
      const itens = d.itens.filter((i) => (!categoria || i.categoria === categoria) && (!impacto || i.impacto === impacto));
      const { itens: _todos, ...cab } = d;
      return toolText(paginateFitting(itens, page || 1, pageSize || 40, (slice, meta) => ({ ...header, legenda: LEGENDA, ...cab, ...meta, itens: slice })));
    }
    const diff = diffSpecs(specA, specB);
    const ops = filtrarDiff(diff, { categoria, impacto, situacao, tag, busca });
    const lista = incluirItens ? ops : ops.map(semItens);
    return toolText(
      paginateFitting(lista, page || 1, pageSize || 25, (slice, meta) => ({
        ...header,
        legenda: LEGENDA,
        resumo: diff.resumo,
        filtros: { categoria, impacto, situacao, tag, busca },
        ...meta,
        operacoes: slice,
        dica: incluirItens ? undefined : 'Detalhe de uma operação: repita com method e path. Para ver os itens junto da lista, use incluirItens: true.',
      }))
    );
  }

  const PARAMS_COMPARACAO = {
    method: z.string().optional().describe('Método HTTP: com path, traz o detalhe da operação'),
    path: z.string().optional().describe('Caminho da operação'),
    ...FILTROS,
    ...PAGE_PARAMS,
  };

  server.registerTool(
    'compare_apis',
    {
      title: 'Comparar ambientes',
      description:
        'Diferenças entre duas APIs/ambientes, de A para B (ex.: A "rhnet-prd" → B "rhnet-hml" = o que muda quando homologação for para produção). ' +
        'Cada diferença tem categoria (endpoint, seguranca, parametro, corpo, resposta, exemplo, texto), impacto (quebra, atencao, info), local (ex.: "corpo.dados[].cpf") e antes → depois. ' +
        'Sem method/path: resumo + operações diferentes, paginadas e filtráveis. Com method/path: todos os itens da operação.',
      inputSchema: { apiIdA: API_ID, apiIdB: API_ID, ...PARAMS_COMPARACAO },
      annotations: readOnly,
    },
    async ({ apiIdA, apiIdB, ...args }) => {
      const a = loadSpec(apiIdA);
      if (a.error) return toolError(a.error);
      const b = loadSpec(apiIdB);
      if (b.error) return toolError(b.error);
      return responderComparacao(a.spec, b.spec, { a: apiIdA, b: apiIdB }, args);
    }
  );

  server.registerTool(
    'compare_previous_version',
    {
      title: 'O que mudou na última versão',
      description:
        'O que mudou da versão anterior para a atual de uma API (ex.: "rhnet-hml" depois de uma spec nova). Mesmo formato de compare_apis: categoria, impacto, local, antes → depois. ' +
        'Use impacto "quebra" para achar o que pode quebrar testes existentes e categoria "exemplo"/"texto" para revisar a documentação.',
      inputSchema: { apiId: API_ID, ...PARAMS_COMPARACAO },
      annotations: readOnly,
    },
    async ({ apiId, ...args }) => {
      const atual = loadSpec(apiId);
      if (atual.error) return toolError(atual.error);
      let anterior;
      try {
        anterior = await previousSpec(apiId);
      } catch (e) {
        return toolError(e.message);
      }
      if (!anterior) return toolText({ apiId, semAnterior: true, mensagem: 'Ainda não há versão anterior guardada para comparar.' });
      return responderComparacao(anterior.spec, atual.spec, { apiId, a: `anterior (${anterior.salvoEm})`, b: 'atual' }, args);
    }
  );

  server.registerTool(
    'search_documentation',
    {
      title: 'Buscar na documentação',
      description:
        'Busca em toda a documentação: operações (caminho, resumo, descrição, operationId, grupo), parâmetros, campos do corpo e das respostas (nome, caminho, descrição, enum, formato), ' +
        'status de resposta, schemas e valores dos exemplos. Resultados ordenados por relevância e paginados; filtre por tipo, método ou grupo.',
      inputSchema: {
        query: z.string().min(2).describe('Termo, ex.: "cpf", "data_admissao", "liberado", "Admissões"'),
        apiId: API_ID.optional().describe('Só nesta API (padrão: todas)'),
        tipo: z.enum(['operacao', 'parametro', 'campo', 'resposta', 'schema', 'exemplo']).optional().describe('Só este tipo de resultado'),
        method: z.string().optional().describe('Só operações deste método'),
        tag: z.string().optional().describe('Só operações deste grupo'),
        ...PAGE_PARAMS,
      },
      annotations: readOnly,
    },
    async ({ query, apiId, tipo, method, tag, page, pageSize }) => {
      const termo = query.toLowerCase().trim();
      const ids = apiId ? [apiId] : listApiIds();
      const resultados = [];
      const porTipo = {};
      for (const id of ids) {
        const { spec, error } = loadSpec(id);
        if (error) {
          if (apiId) return toolError(error);
          continue;
        }
        const tagOps = tag ? new Set(listOperations(spec).filter((o) => o.operation.tags?.includes(tag)).map((o) => `${o.method.toUpperCase()} ${o.path}`)) : null;
        for (const i of indexar(spec)) {
          if (method && i.metodo !== method.toUpperCase()) continue;
          if (tagOps && !tagOps.has(`${i.metodo} ${i.path}`)) continue;
          const score = pontuar(i, termo);
          if (!score) continue;
          porTipo[i.tipo] = (porTipo[i.tipo] || 0) + 1;
          if (tipo && i.tipo !== tipo) continue;
          const { _busca, texto, ...r } = i;
          if (i.tipo === 'exemplo') r.trecho = trecho(texto, termo);
          resultados.push({ apiId: id, score, ...r });
        }
      }
      if (!resultados.length) return toolText({ mensagem: `Nenhum resultado para "${query}".`, contagemPorTipo: porTipo });
      resultados.sort((x, y) => y.score - x.score || ORDEM_TIPO[x.tipo] - ORDEM_TIPO[y.tipo] || String(x.path).localeCompare(String(y.path)));
      return toolText(paginateFitting(resultados.map(({ score, ...r }) => r), page || 1, pageSize || 25, (slice, meta) => ({ query, contagemPorTipo: porTipo, ...meta, resultados: slice })));
    }
  );

  server.registerTool(
    'list_schemas',
    {
      title: 'Listar schemas',
      description: 'Lista os schemas (modelos de dados) da API com descrição, quantidade de campos e quantas operações usam cada um. Filtre pelo nome.',
      inputSchema: { apiId: API_ID, filtro: z.string().optional().describe('Parte do nome, ex.: "Admissao"'), ...PAGE_PARAMS },
      annotations: readOnly,
    },
    async ({ apiId, filtro, page, pageSize }) => {
      const { spec, error } = loadSpec(apiId);
      if (error) return toolError(error);
      const uso = mapaDeUso(spec);
      const f = (filtro || '').toLowerCase();
      const lista = listSchemaNames(spec)
        .filter((n) => !f || n.toLowerCase().includes(f))
        .map((nome) => {
          const s = getSchemaByName(spec, nome) || {};
          return {
            nome,
            tipo: s.type || (s.allOf ? 'allOf' : s.oneOf ? 'oneOf' : s.enum ? 'enum' : null),
            campos: Object.keys(s.properties || {}).length,
            ...(s.enum ? { valores: s.enum.length } : {}),
            usadoPor: uso.get(nome)?.length || 0,
            ...(s.description ? { descricao: s.description.length > 120 ? `${s.description.slice(0, 119)}…` : s.description } : {}),
          };
        });
      return toolText(paginateFitting(lista, page || 1, pageSize || 40, (slice, meta) => ({ apiId, ...meta, schemas: slice })));
    }
  );

  server.registerTool(
    'get_schema_usages',
    {
      title: 'Onde um schema é usado',
      description: 'Lista as operações que usam um schema (direta ou indiretamente) e onde: parâmetros, corpo ou resposta de qual status. Útil para avaliar o impacto de uma mudança no schema.',
      inputSchema: { apiId: API_ID, schemaName: z.string().describe('Nome do schema, ex.: "BancoStoreItem"'), ...PAGE_PARAMS },
      annotations: readOnly,
    },
    async ({ apiId, schemaName, page, pageSize }) => {
      const { spec, error } = loadSpec(apiId);
      if (error) return toolError(error);
      if (!getSchemaByName(spec, schemaName)) return toolError(`Schema "${schemaName}" não encontrado. Use list_schemas.`);
      const lista = mapaDeUso(spec).get(schemaName) || [];
      return toolText(paginateFitting(lista, page || 1, pageSize || 40, (slice, meta) => ({ apiId, schema: schemaName, ...meta, operacoes: slice })));
    }
  );

  server.registerTool(
    'get_operation_examples',
    {
      title: 'Exemplos de uma operação',
      description: 'Exemplos documentados de uma operação: corpo da requisição (incluindo exemplos nomeados) e respostas por status, além dos exemplos de parâmetros. Paginado por exemplo.',
      inputSchema: {
        apiId: API_ID,
        method: z.string().describe('Método HTTP'),
        path: z.string().describe('Caminho da operação'),
        onde: z.enum(['corpo', 'resposta', 'parametro']).optional().describe('Só exemplos do corpo, das respostas ou dos parâmetros'),
        status: z.string().optional().describe('Só a resposta deste status, ex.: "201"'),
        ...PAGE_PARAMS,
      },
      annotations: readOnly,
    },
    async ({ apiId, method, path, onde, status, page, pageSize }) => {
      const { spec, error } = loadSpec(apiId);
      if (error) return toolError(error);
      const op = findOperation(spec, method, path);
      if (!op) return toolError(`Operação ${method.toUpperCase()} ${path} não encontrada em "${apiId}".`);
      const c = contrato(spec, op);
      const lista = [];
      if (!onde || onde === 'parametro') {
        for (const p of operationParameters(spec, op.pathItem, op.operation)) {
          const ex = p.example ?? p.schema?.example;
          if (ex !== undefined) lista.push({ onde: `parâmetro ${p.in}.${p.name}`, valor: ex });
        }
      }
      if ((!onde || onde === 'corpo') && c.corpo) for (const [nome, valor] of Object.entries(c.corpo.exemplos)) lista.push({ onde: 'corpo', nome, valor });
      if (!onde || onde === 'resposta') {
        for (const [st, r] of c.respostas) {
          if (status && st !== status) continue;
          for (const [nome, valor] of Object.entries(r.exemplos)) lista.push({ onde: `resposta ${st}`, nome, valor });
        }
      }
      if (!lista.length) return toolText({ apiId, operacao: `${method.toUpperCase()} ${path}`, mensagem: 'A spec não traz exemplos para esta seleção. generate_example_payload gera um a partir do schema.' });
      return toolText(paginateFitting(lista, page || 1, pageSize || 5, (slice, meta) => ({ apiId, operacao: `${method.toUpperCase()} ${path}`, ...meta, exemplos: slice })));
    }
  );

  server.registerPrompt(
    'revisar_mudancas',
    {
      title: 'Revisar mudanças da spec (QA)',
      description: 'Analisa o que mudou (versão anterior × atual, ou produção × homologação) e monta o plano de reteste e de testes novos.',
      argsSchema: {
        apiId: z.string().optional().describe('Comparar a versão anterior com a atual desta API (padrão: rhnet-hml)'),
        compararAmbientes: z.string().optional().describe('"sim" para comparar produção (A) × homologação (B) em vez da versão anterior'),
      },
    },
    ({ apiId, compararAmbientes }) => {
      const ambientes = /^s/i.test(compararAmbientes || '');
      const chamada = ambientes ? 'compare_apis com apiIdA "rhnet-prd" e apiIdB "rhnet-hml"' : `compare_previous_version com apiId "${apiId || 'rhnet-hml'}"`;
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: [
                `Revise as mudanças da documentação como QA usando ${chamada}.`,
                '',
                '1. Chame a ferramenta sem filtros para o resumo; depois percorra impacto "quebra" e "atencao" (todas as páginas). Para cada operação relevante, chame de novo com method/path para ver os itens.',
                '2. Para mudanças em schemas compartilhados, use get_schema_usages para achar todas as operações afetadas.',
                '3. Monte o relatório por categoria (endpoint, segurança, parâmetros, corpo, respostas, exemplos, textos) com: o que mudou (antes → depois), impacto e por quê.',
                '4. Liste os testes existentes que precisam ser revistos (quebras) e os testes novos a criar (campos/valores/status novos), com prioridade. Use get_operation_test_context e suggest_test_scenarios nas operações novas ou muito alteradas.',
                '5. Aponte inconsistências da documentação (exemplos que não batem com o schema, descrições vagas, status sem descrição).',
              ].join('\n'),
            },
          },
        ],
      };
    }
  );
}

function trecho(texto, termo) {
  const i = texto.toLowerCase().indexOf(termo);
  if (i < 0) return texto.slice(0, 120);
  return `${i > 40 ? '…' : ''}${texto.slice(Math.max(0, i - 40), i + termo.length + 60)}${i + termo.length + 60 < texto.length ? '…' : ''}`;
}
