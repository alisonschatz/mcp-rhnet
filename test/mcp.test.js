import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '../src/mcp.js';

let client;
before(async () => {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await buildMcpServer().connect(serverSide);
  client = new Client({ name: 'teste', version: '1.0.0' });
  await client.connect(clientSide);
});
after(() => client?.close());

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { ...r, json: r.isError ? null : JSON.parse(r.content[0].text) };
};

test('expõe as tools, prompts e resources esperados', async () => {
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, [
    'generate_example_payload', 'get_api_overview', 'get_operation_docs', 'get_operation_schema',
    'get_operation_test_context', 'get_schema_definition', 'list_apis', 'list_operations',
    'search_documentation', 'suggest_test_scenarios',
  ]);
  const prompts = (await client.listPrompts()).prompts.map((p) => p.name).sort();
  assert.deepEqual(prompts, ['casos_de_teste_operacao', 'plano_de_testes_api']);
  const resources = (await client.listResources()).resources.map((r) => r.uri);
  assert.ok(resources.includes('docs://index'));
  assert.ok(resources.includes('openapi://exemplo-pedidos'));
});

test('fluxo de navegação', async () => {
  const apis = (await call('list_apis')).json;
  assert.ok(apis.apis.some((a) => a.id === 'exemplo-pedidos'));
  const ops = (await call('list_operations', { apiId: 'exemplo-pedidos', tag: 'Pedidos' })).json;
  assert.equal(ops.totalItems, 4);
  const schema = (await call('get_operation_schema', { apiId: 'exemplo-pedidos', method: 'post', path: '/pedidos' })).json;
  assert.deepEqual(schema.requestBody.schema.properties.cliente, { $ref: 'Cliente' });
  const def = (await call('get_schema_definition', { apiId: 'exemplo-pedidos', schemaName: 'Cliente' })).json;
  assert.deepEqual(def.schema.properties.endereco, { $ref: 'Endereco' });
});

test('erros amigáveis', async () => {
  const semApi = await call('list_operations', { apiId: '../package' });
  assert.equal(semApi.isError, true);
  const semOp = await call('get_operation_docs', { apiId: 'exemplo-pedidos', method: 'PUT', path: '/pedidos/{id}' });
  assert.match(semOp.content[0].text, /GET, DELETE/);
});

test('suggest_test_scenarios pagina e filtra, e cada página é JSON válido', async () => {
  const args = { apiId: 'exemplo-pedidos', method: 'POST', path: '/pedidos', pageSize: 30 };
  const p1 = (await call('suggest_test_scenarios', args)).json;
  assert.ok(p1.totalPages >= 2);
  for (let page = 2; page <= p1.totalPages; page++) {
    assert.ok((await call('suggest_test_scenarios', { ...args, page })).json.cenarios.length > 0);
  }
  const altas = (await call('suggest_test_scenarios', { ...args, prioridade: 'alta' })).json;
  assert.ok(altas.cenarios.every((c) => c.prioridade === 'alta'));
});

test('prompt monta instruções com a operação', async () => {
  const p = await client.getPrompt({ name: 'casos_de_teste_operacao', arguments: { apiId: 'exemplo-pedidos', method: 'post', path: '/pedidos', formato: 'jest' } });
  assert.match(p.messages[0].content.text, /POST \/pedidos/);
  assert.match(p.messages[0].content.text, /jest/);
});
