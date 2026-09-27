// Cada arquivo de teste roda em processo próprio: dá para configurar o ambiente antes dos imports.
process.env.MCP_AUTH_TOKEN = 'segredo-de-teste';
process.env.VERCEL = '1';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

let server;
let base;

before(async () => {
  // Simula o build da Vercel e sobe o mesmo entrypoint que ela usa.
  execFileSync(process.execPath, ['scripts/build-bundle.js'], { stdio: 'ignore' });
  const { default: app } = await import('../src/app.js');
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const initBody = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
};
const post = (path, headers = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(initBody),
  });

test('sem token -> 401', async () => {
  assert.equal((await post('/mcp')).status, 401);
  assert.equal((await post('/mcp', { Authorization: 'Bearer errado' })).status, 401);
  assert.equal((await post('/mcp?token=errado')).status, 401);
});

test('token no header ou na query -> 200', async () => {
  assert.equal((await post('/mcp', { Authorization: 'Bearer segredo-de-teste' })).status, 200);
  assert.equal((await post('/mcp?token=segredo-de-teste')).status, 200);
});

test('health é público e não expõe os ids das APIs', async () => {
  const { listApiIds } = await import('../src/specs.js');
  const body = await (await fetch(`${base}/mcp/health`)).json();
  assert.deepEqual(body, { status: 'ok', apis: listApiIds().length, autenticacao: true });
  assert.ok(body.apis >= 1);
});

test('cliente MCP real via HTTP lê as specs do bundle', async () => {
  const client = new Client({ name: 'teste-http', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?token=segredo-de-teste`)));
  const r = await client.callTool({ name: 'list_apis', arguments: {} });
  assert.ok(JSON.parse(r.content[0].text).apis.some((a) => a.id === 'exemplo-pedidos'));
  const cenarios = await client.callTool({ name: 'suggest_test_scenarios', arguments: { apiId: 'exemplo-pedidos', method: 'DELETE', path: '/pedidos/{id}' } });
  assert.equal(JSON.parse(cenarios.content[0].text).statusSucesso, '204');
  await client.close();
});
