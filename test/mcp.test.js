import './fixtures/env.js';
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
    'compare_apis', 'compare_previous_version', 'generate_example_payload', 'get_api_overview', 'get_operation_docs', 'get_operation_schema',
    'get_operation_test_context', 'get_schema_definition', 'list_apis', 'list_operations',
    'search_documentation', 'suggest_test_scenarios',
  ]);
  const prompts = (await client.listPrompts()).prompts.map((p) => p.name).sort();
  assert.deepEqual(prompts, ['casos_de_teste_operacao', 'plano_de_testes_api']);
  const resources = (await client.listResources()).resources.map((r) => r.uri);
  assert.ok(resources.includes('docs://index'));
  assert.ok(resources.includes('openapi://rhnet-hml'));
});

test('só a API do RH Net é exposta', async () => {
  const apis = (await call('list_apis')).json;
  assert.deepEqual(apis.apis.map((a) => a.id), ['rhnet-hml']);
});

test('fluxo de navegação', async () => {
  const ops = (await call('list_operations', { apiId: 'rhnet-hml', tag: 'Bancos' })).json;
  assert.equal(ops.totalItems, 4);
  const schema = (await call('get_operation_schema', { apiId: 'rhnet-hml', method: 'post', path: '/api/v1/bancos' })).json;
  assert.deepEqual(schema.requestBody.schema.properties.dados.items, { $ref: 'BancoStoreItem' });
  const def = (await call('get_schema_definition', { apiId: 'rhnet-hml', schemaName: 'BancoStoreItem' })).json;
  assert.equal(def.schema.type, 'object');
});

test('erros amigáveis', async () => {
  const semApi = await call('list_operations', { apiId: '../package' });
  assert.equal(semApi.isError, true);
  const exemploRemovido = await call('list_operations', { apiId: 'exemplo-pedidos' });
  assert.equal(exemploRemovido.isError, true);
  const semOp = await call('get_operation_docs', { apiId: 'rhnet-hml', method: 'PATCH', path: '/api/v1/bancos' });
  assert.match(semOp.content[0].text, /GET, POST, PUT, DELETE/);
});

test('suggest_test_scenarios pagina e filtra, e cada página é JSON válido', async () => {
  const args = { apiId: 'rhnet-hml', method: 'POST', path: '/api/v1/admissoes', pageSize: 30 };
  const p1 = (await call('suggest_test_scenarios', args)).json;
  assert.ok(p1.totalPages >= 2);
  for (let page = 2; page <= p1.totalPages; page++) {
    assert.ok((await call('suggest_test_scenarios', { ...args, page })).json.cenarios.length > 0);
  }
  const altas = (await call('suggest_test_scenarios', { ...args, prioridade: 'alta' })).json;
  assert.ok(altas.cenarios.every((c) => c.prioridade === 'alta'));
});

test('prompt monta instruções com a operação', async () => {
  const p = await client.getPrompt({ name: 'casos_de_teste_operacao', arguments: { apiId: 'rhnet-hml', method: 'post', path: '/api/v1/bancos', formato: 'jest' } });
  assert.match(p.messages[0].content.text, /POST \/api\/v1\/bancos/);
  assert.match(p.messages[0].content.text, /jest/);
});

test('get_operation_test_context nunca devolve JSON truncado nas operações do RH Net', async () => {
  const { totalPages } = (await call('list_operations', { apiId: 'rhnet-hml', pageSize: 50 })).json;
  for (let page = 1; page <= totalPages; page++) {
    for (const op of (await call('list_operations', { apiId: 'rhnet-hml', pageSize: 50, page })).json.operations) {
      const r = await call('get_operation_test_context', { apiId: 'rhnet-hml', method: op.method, path: op.path });
      assert.ok(r.json, `${op.method} ${op.path} devolveu JSON inválido`);
    }
  }
});

test('operação grande vem resumida e navega por seção/página', async () => {
  const args = { apiId: 'rhnet-hml', method: 'POST', path: '/api/v1/admissoes' };
  const resumo = (await call('get_operation_test_context', args)).json;
  assert.match(resumo.aviso, /secao/);
  assert.ok(resumo.corpo.totalCampos > 60);
  assert.equal(resumo.corpo.variantes.opcoes.length, 2);

  const req = (await call('get_operation_test_context', { ...args, secao: 'requisicao' })).json;
  assert.equal(req.totalItems, resumo.corpo.totalCampos);
  assert.ok(req.hasNextPage);
  assert.ok(req.campos.every((c) => !/variantes/.test(c.observacao || '')), 'aviso de variante não deve repetir em todo campo');

  const resp = (await call('get_operation_test_context', { ...args, secao: 'respostas', status: '400' })).json;
  assert.ok(resp.campos.every((c) => c.status === '400'));
  const semStatus = await call('get_operation_test_context', { ...args, secao: 'respostas', status: '418' });
  assert.equal(semStatus.isError, true);
});

test('variante e exemplos nomeados no corpo', async () => {
  const args = { apiId: 'rhnet-hml', method: 'POST', path: '/api/v1/admissoes' };
  const v0 = (await call('get_operation_test_context', { ...args, secao: 'requisicao', pageSize: 120 })).json;
  const v1 = (await call('get_operation_test_context', { ...args, secao: 'requisicao', pageSize: 120, variante: 1 })).json;
  assert.notEqual(v0.corpo.schema, v1.corpo.schema);

  const padrao = (await call('generate_example_payload', args)).json;
  assert.ok(padrao.exemplosDisponiveis.some((e) => e.nome === 'contribuinte_estrangeiro'));
  const escolhido = (await call('generate_example_payload', { ...args, exemplo: 'contribuinte_estrangeiro' })).json;
  assert.match(escolhido.origemCorpo, /contribuinte_estrangeiro/);
  assert.equal(escolhido.corpo.tipo, 'contribuinte');
  const gerado = (await call('generate_example_payload', { ...args, modo: 'minimo', variante: 1 })).json;
  assert.equal(gerado.variantes.usada, 1);
});
