import { z } from 'zod';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MAX_RESPONSE_CHARS,
  MAX_SEARCH_MATCHES_PER_API,
  SERVER_NAME,
  SERVER_VERSION,
} from './config.js';
import { listApiIds, listApis, loadSpec } from './specs.js';
import {
  findOperation,
  getSchemaByName,
  listOperations,
  listSchemaNames,
  operationNotFoundMessage,
  operationParameters,
  requestBodyInfo,
  resolveOneLevel,
  responsesInfo,
  securityInfo,
  shortenRefs,
} from './openapi.js';
import { deriveTestScenarios, examplePayload, testContext } from './testing.js';

// ---------------------------------------------------------------------------
// Helpers de resposta
// ---------------------------------------------------------------------------

function boundedJsonText(value) {
  const pretty = JSON.stringify(value, null, 2);
  if (pretty.length <= MAX_RESPONSE_CHARS) return pretty;
  const text = JSON.stringify(value); // sem indentação cabe bem mais
  if (text.length <= MAX_RESPONSE_CHARS) return text;
  return `${text.slice(0, MAX_RESPONSE_CHARS)}\n\n... [resultado truncado em ${MAX_RESPONSE_CHARS} caracteres — use paginação ou filtros]`;
}

const toolText = (value) => ({ content: [{ type: 'text', text: boundedJsonText(value) }] });
const toolError = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

function paginate(items, page, pageSize) {
  const size = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(pageSize || DEFAULT_PAGE_SIZE)));
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / size));
  const current = Math.min(Math.max(1, Math.floor(page || 1)), totalPages);
  return {
    items: items.slice((current - 1) * size, current * size),
    meta: { page: current, pageSize: size, totalItems, totalPages, hasNextPage: current < totalPages },
  };
}

const PAGE_PARAMS = {
  page: z.number().int().min(1).optional().describe('Página a consultar (padrão 1)'),
  pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).optional().describe(`Itens por página (padrão ${DEFAULT_PAGE_SIZE}, máximo ${MAX_PAGE_SIZE})`),
};

const API_ID = z.string().describe('Id retornado por list_apis (nome do arquivo em specs/ sem .json)');
const OPERATION_PARAMS = {
  apiId: API_ID,
  method: z.string().describe('Método HTTP, ex.: "POST"'),
  path: z.string().describe('Caminho exatamente como retornado por list_operations, ex.: "/pedidos/{id}"'),
};

/** Carrega spec + operação ou devolve o erro pronto para a tool. */
function withOperation(apiId, method, opPath, fn) {
  const { spec, error } = loadSpec(apiId);
  if (error) return toolError(error);
  const op = findOperation(spec, method, opPath);
  if (!op) return toolError(operationNotFoundMessage(spec, apiId, method, opPath));
  return fn(spec, op);
}

function withSpec(apiId, fn) {
  const { spec, error } = loadSpec(apiId);
  if (error) return toolError(error);
  return fn(spec);
}

// ---------------------------------------------------------------------------
// Servidor
// ---------------------------------------------------------------------------

export function buildMcpServer() {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Servidor com as specs OpenAPI das APIs do time, voltado a documentação e criação de casos de teste. ' +
        'Fluxo sugerido: list_apis -> list_operations -> get_operation_test_context -> suggest_test_scenarios -> generate_example_payload. ' +
        'Os cenários sugeridos vêm só da spec: complemente com regras de negócio e aponte as lacunas encontradas.',
    }
  );
  const readOnly = { readOnlyHint: true, openWorldHint: false, idempotentHint: true };

  // ----- Navegação -----------------------------------------------------------

  server.registerTool(
    'list_apis',
    {
      title: 'Listar APIs',
      description: 'Lista as APIs disponíveis (uma por arquivo em specs/), com id, título e versão. Ponto de entrada antes das demais ferramentas.',
      inputSchema: { ...PAGE_PARAMS },
      annotations: readOnly,
    },
    async ({ page, pageSize }) => {
      const apis = listApis();
      if (!apis.length) return toolError('Nenhuma spec encontrada na pasta specs/.');
      const { items, meta } = paginate(apis, page, pageSize);
      return toolText({ ...meta, apis: items });
    }
  );

  server.registerTool(
    'get_api_overview',
    {
      title: 'Visão geral da API',
      description: 'Retorna descrição, servidores, tags e esquemas de segurança de uma API. Não lista endpoints — use list_operations.',
      inputSchema: { apiId: API_ID },
      annotations: readOnly,
    },
    async ({ apiId }) =>
      withSpec(apiId, (spec) => {
        const schemes = spec.components?.securitySchemes || spec.securityDefinitions || {};
        return toolText({
          title: spec.info?.title || apiId,
          version: spec.info?.version || null,
          overview: spec.info?.description || '(sem descrição cadastrada)',
          servers: (spec.servers || []).map((s) => ({ url: s.url, description: s.description || null })),
          tags: (spec.tags || []).map((t) => ({ name: t.name, description: t.description || null })),
          securitySchemes: Object.entries(schemes).map(([name, s]) => ({ name, type: s.type, scheme: s.scheme || null, in: s.in || null, paramName: s.name || null })),
          totalOperations: listOperations(spec).length,
        });
      })
  );

  server.registerTool(
    'list_operations',
    {
      title: 'Listar operações',
      description: 'Lista as operações de uma API (método, caminho, resumo, tag), com filtro por tag e paginação.',
      inputSchema: {
        apiId: API_ID,
        tag: z.string().optional().describe('Filtra só as operações dessa tag'),
        ...PAGE_PARAMS,
      },
      annotations: readOnly,
    },
    async ({ apiId, tag, page, pageSize }) =>
      withSpec(apiId, (spec) => {
        const ops = listOperations(spec)
          .filter(({ operation }) => !tag || (operation.tags || []).includes(tag))
          .map(({ method, path, operation }) => ({
            method: method.toUpperCase(),
            path,
            operationId: operation.operationId || null,
            tag: operation.tags?.[0] || null,
            summary: operation.summary || null,
            deprecated: operation.deprecated === true,
          }));
        const { items, meta } = paginate(ops, page, pageSize);
        return toolText({ ...meta, operations: items });
      })
  );

  server.registerTool(
    'get_operation_docs',
    {
      title: 'Documentação de uma operação',
      description: 'Descrição funcional da operação e de seus parâmetros, sem detalhes de schema. Para tipos e estrutura, use get_operation_schema.',
      inputSchema: OPERATION_PARAMS,
      annotations: readOnly,
    },
    async ({ apiId, method, path }) =>
      withOperation(apiId, method, path, (spec, op) =>
        toolText({
          summary: op.operation.summary || null,
          description: op.operation.description || null,
          deprecated: op.operation.deprecated === true,
          security: securityInfo(spec, op),
          parameters: operationParameters(spec, op.pathItem, op.operation).map((p) => ({
            name: p.name,
            in: p.in,
            required: Boolean(p.required),
            description: p.description || null,
          })),
          requestBody: requestBodyInfo(spec, op)?.description ?? null,
          responses: Object.fromEntries(Object.entries(responsesInfo(spec, op)).map(([s, r]) => [s, r.description])),
        })
      )
  );

  server.registerTool(
    'get_operation_schema',
    {
      title: 'Schema de uma operação',
      description:
        'Parâmetros, corpo e respostas de uma operação, resolvidos em um nível. Objetos aninhados vêm como ponteiros {"$ref": "Nome"}; use get_schema_definition para detalhá-los.',
      inputSchema: OPERATION_PARAMS,
      annotations: readOnly,
    },
    async ({ apiId, method, path }) =>
      withOperation(apiId, method, path, (spec, op) => {
        const body = requestBodyInfo(spec, op);
        const responses = {};
        for (const [status, r] of Object.entries(responsesInfo(spec, op))) {
          responses[status] = { schema: r.schema ? resolveOneLevel(spec, r.schema) : null, example: r.example ?? null };
        }
        return toolText({
          parameters: operationParameters(spec, op.pathItem, op.operation)
            .filter((p) => p.in !== 'body')
            .map((p) => ({ name: p.name, in: p.in, required: Boolean(p.required), schema: resolveOneLevel(spec, p.schema || { type: p.type, format: p.format, enum: p.enum }) })),
          requestBody: body
            ? { required: body.required, contentType: body.mediaType, schema: body.schema ? resolveOneLevel(spec, body.schema) : null, example: body.example ?? null }
            : null,
          responses,
        });
      })
  );

  server.registerTool(
    'get_schema_definition',
    {
      title: 'Definição de um schema',
      description: 'Retorna um schema nomeado (components/schemas), permitindo navegar por objetos aninhados um nível por vez.',
      inputSchema: { apiId: API_ID, schemaName: z.string().describe('Nome do schema, ex.: "Pedido"') },
      annotations: readOnly,
    },
    async ({ apiId, schemaName }) =>
      withSpec(apiId, (spec) => {
        const schema = getSchemaByName(spec, schemaName);
        if (!schema) {
          const available = listSchemaNames(spec);
          return toolError(`Schema "${schemaName}" não encontrado em "${apiId}". Disponíveis: ${available.join(', ') || '(nenhum)'}.`);
        }
        return toolText({ name: schemaName, schema: shortenRefs(schema) });
      })
  );

  server.registerTool(
    'search_documentation',
    {
      title: 'Buscar na documentação',
      description: 'Busca textual em caminhos, operationIds, resumos, descrições, parâmetros e nomes de schema de todas as APIs (ou de uma).',
      inputSchema: {
        query: z.string().min(2).describe('Termo a buscar, ex.: "cancelamento", "cpf"'),
        apiId: API_ID.optional(),
        ...PAGE_PARAMS,
      },
      annotations: readOnly,
    },
    async ({ query, apiId, page, pageSize }) => {
      const needle = query.toLowerCase();
      const hit = (...texts) => texts.some((t) => typeof t === 'string' && t.toLowerCase().includes(needle));
      const results = [];
      for (const id of apiId ? [apiId] : listApiIds()) {
        const { spec } = loadSpec(id);
        if (!spec) continue;
        const matches = [];
        for (const op of listOperations(spec)) {
          const params = operationParameters(spec, op.pathItem, op.operation);
          if (hit(op.path, op.operation.operationId, op.operation.summary, op.operation.description, ...params.map((p) => p.name), ...params.map((p) => p.description))) {
            matches.push({ tipo: 'operacao', method: op.method.toUpperCase(), path: op.path, summary: op.operation.summary || null });
          }
        }
        for (const name of listSchemaNames(spec)) {
          const s = getSchemaByName(spec, name);
          if (hit(name, s?.description, ...Object.keys(s?.properties || {}))) matches.push({ tipo: 'schema', nome: name });
        }
        if (matches.length) results.push({ apiId: id, totalMatches: matches.length, matches: matches.slice(0, MAX_SEARCH_MATCHES_PER_API) });
      }
      if (!results.length) return toolText({ message: `Nenhum resultado para "${query}".` });
      const { items, meta } = paginate(results, page, pageSize);
      return toolText({ ...meta, results: items });
    }
  );

  // ----- Testes --------------------------------------------------------------

  server.registerTool(
    'get_operation_test_context',
    {
      title: 'Contexto de teste de uma operação',
      description:
        'Visão achatada e completa de uma operação para escrever testes: segurança, parâmetros e campos do corpo com caminho ("cliente.endereco.cep", "itens[].sku"), obrigatoriedade e restrições (enum, min/max, pattern, format), e os campos de cada resposta. Todas as $ref já vêm resolvidas.',
      inputSchema: OPERATION_PARAMS,
      annotations: readOnly,
    },
    async ({ apiId, method, path }) => withOperation(apiId, method, path, (spec, op) => toolText(testContext(spec, op)))
  );

  server.registerTool(
    'suggest_test_scenarios',
    {
      title: 'Sugerir cenários de teste',
      description:
        'Deriva da spec uma lista determinística de cenários (positivos, segurança, recurso inexistente, validação, valores-limite, erros documentados, idempotência), cada um com a alteração a aplicar sobre o payload base e o status esperado, além das lacunas da spec. ' +
        'Valores {"$gerar": "string", "tamanho": N} significam uma string de N caracteres. É um checklist de cobertura: complemente com regras de negócio.',
      inputSchema: {
        ...OPERATION_PARAMS,
        categoria: z
          .enum(['positivo', 'seguranca', 'recurso', 'validacao', 'limite', 'erro-documentado', 'idempotencia'])
          .optional()
          .describe('Filtra por categoria'),
        prioridade: z.enum(['alta', 'media', 'baixa']).optional().describe('Filtra por prioridade'),
        page: PAGE_PARAMS.page,
        pageSize: z.number().int().min(1).max(30).optional().describe('Cenários por página (padrão 20, máximo 30)'),
      },
      annotations: readOnly,
    },
    async ({ apiId, method, path, categoria, prioridade, page, pageSize }) =>
      withOperation(apiId, method, path, (spec, op) => {
        const result = deriveTestScenarios(spec, op);
        const filtered = result.cenarios.filter((c) => (!categoria || c.categoria === categoria) && (!prioridade || c.prioridade === prioridade));
        const { items, meta } = paginate(filtered, page, Math.min(pageSize || 20, 30));
        const porCategoria = {};
        for (const c of result.cenarios) porCategoria[c.categoria] = (porCategoria[c.categoria] || 0) + 1;
        return toolText({
          operacao: result.operacao,
          statusSucesso: result.statusSucesso,
          statusValidacao: result.statusValidacao,
          totalPorCategoria: porCategoria,
          ...meta,
          cenarios: items,
          lacunasDaSpec: meta.page === 1 ? result.lacunasDaSpec : undefined,
        });
      })
  );

  server.registerTool(
    'generate_example_payload',
    {
      title: 'Gerar payload de exemplo',
      description:
        'Gera parâmetros e corpo válidos para a operação: usa exemplos da spec quando existem; senão gera a partir do schema respeitando enum, format, min/max e pattern. Modo "completo" preenche tudo; "minimo" só o obrigatório. É o payload base para os cenários de suggest_test_scenarios.',
      inputSchema: {
        ...OPERATION_PARAMS,
        modo: z.enum(['completo', 'minimo']).optional().describe('Padrão "completo"'),
      },
      annotations: readOnly,
    },
    async ({ apiId, method, path, modo }) => withOperation(apiId, method, path, (spec, op) => toolText(examplePayload(spec, op, modo || 'completo')))
  );

  // ----- Prompts -------------------------------------------------------------

  server.registerPrompt(
    'casos_de_teste_operacao',
    {
      title: 'Criar casos de teste para uma operação',
      description: 'Gera casos de teste completos para um endpoint usando as ferramentas deste servidor.',
      argsSchema: {
        apiId: z.string().describe('Id da API'),
        method: z.string().describe('Método HTTP'),
        path: z.string().describe('Caminho da operação'),
        formato: z.string().optional().describe('gherkin | tabela | jest | postman | restassured (padrão: gherkin)'),
        regrasDeNegocio: z.string().optional().describe('Regras que a spec não descreve (opcional)'),
      },
    },
    ({ apiId, method, path, formato, regrasDeNegocio }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Crie os casos de teste da operação ${method.toUpperCase()} ${path} da API "${apiId}".`,
              '',
              'Passos:',
              '1. Chame get_operation_test_context para entender parâmetros, campos, restrições, segurança e respostas.',
              '2. Chame generate_example_payload nos modos "completo" e "minimo" para ter os payloads base.',
              '3. Chame suggest_test_scenarios (percorra todas as páginas) para o checklist de cobertura.',
              '4. Escreva os casos finais: para cada cenário, pré-condição, requisição concreta (payload base + alteração), status e validações esperadas no corpo da resposta.',
              '5. Acrescente cenários de regra de negócio que a spec não cobre e liste separadamente as lacunas da spec e as dúvidas para o time.',
              '',
              `Formato de saída: ${formato || 'gherkin (Funcionalidade/Cenário/Dado/Quando/Então) em português'}.`,
              'Agrupe por categoria, mantenha os ids CT-xxx e marque a prioridade. Não invente status que a spec não documenta sem sinalizar.',
              regrasDeNegocio ? `\nRegras de negócio informadas pelo time:\n${regrasDeNegocio}` : '',
            ].join('\n'),
          },
        },
      ],
    })
  );

  server.registerPrompt(
    'plano_de_testes_api',
    {
      title: 'Plano de testes de uma API',
      description: 'Monta um plano de testes priorizado cobrindo todas as operações de uma API.',
      argsSchema: {
        apiId: z.string().describe('Id da API'),
        tag: z.string().optional().describe('Restringe a uma tag (opcional)'),
      },
    },
    ({ apiId, tag }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Monte um plano de testes para a API "${apiId}"${tag ? ` (somente a tag "${tag}")` : ''}.`,
              '',
              '1. Use get_api_overview e list_operations (todas as páginas) para mapear as operações.',
              '2. Para cada operação, chame suggest_test_scenarios com prioridade "alta" para estimar a cobertura mínima.',
              '3. Entregue: tabela operação x quantidade de cenários por categoria, ordem de execução sugerida (considerando dependências, ex.: criar antes de consultar/excluir), dados de teste necessários e a lista consolidada de lacunas da spec.',
              'Não escreva todos os casos em detalhe; isso é feito operação a operação com o prompt casos_de_teste_operacao.',
            ].join('\n'),
          },
        },
      ],
    })
  );

  // ----- Resources -----------------------------------------------------------

  server.registerResource(
    'indice-apis',
    'docs://index',
    { title: 'Índice das APIs', mimeType: 'text/markdown' },
    async (uri) => {
      const lines = ['# APIs disponíveis', ''];
      for (const api of listApis()) lines.push(`- **${api.title}** (\`${api.id}\`, versão ${api.version ?? '?'})${api.error ? ` — ERRO: ${api.error}` : ''}`);
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: lines.join('\n') }] };
    }
  );

  server.registerResource(
    'spec-openapi',
    new ResourceTemplate('openapi://{apiId}', {
      list: async () => ({
        resources: listApis().map((a) => ({ uri: `openapi://${a.id}`, name: a.id, title: a.title, mimeType: 'application/json' })),
      }),
      complete: { apiId: (value) => listApiIds().filter((id) => id.startsWith(value || '')) },
    }),
    { title: 'Spec OpenAPI completa', description: 'JSON bruto da spec (pode ser grande).', mimeType: 'application/json' },
    async (uri, { apiId }) => {
      const { spec, error } = loadSpec(String(apiId));
      if (error) throw new Error(error);
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(spec, null, 2) }] };
    }
  );

  return server;
}
