// Cada arquivo de teste roda em processo próprio: dá para configurar o ambiente antes dos imports.
process.env.VERCEL = '1';
await import('./fixtures/env.js');

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

test('/mcp é público: responde 200 sem nenhum token', async () => {
  const r = await post('/mcp');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).result.serverInfo.name, 'mcp-rhnet');
});

test('GET /mcp -> 405 com Allow: POST', async () => {
  const r = await fetch(`${base}/mcp`);
  assert.equal(r.status, 405);
  assert.equal(r.headers.get('allow'), 'POST');
});

test('JSON inválido -> erro de parse JSON-RPC', async () => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{quebrado' });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.code, -32700);
});

test('só existem / e /mcp: /mcp/health não existe mais', async () => {
  assert.equal((await fetch(`${base}/mcp/health`)).status, 404);
  const st = await (await fetch(`${base}/api/status`)).json();
  assert.equal(st.apis.find((a) => a.apiId === 'rhnet-hml').atual.operacoes, 135);
  assert.match(st.versaoServidor, /^\d+\.\d+\.\d+$/);
});

test('cliente MCP real via HTTP lê as specs do bundle', async () => {
  const client = new Client({ name: 'teste-http', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const r = await client.callTool({ name: 'list_apis', arguments: {} });
  assert.ok(JSON.parse(r.content[0].text).apis.some((a) => a.id === 'rhnet-hml'));
  const cenarios = await client.callTool({ name: 'suggest_test_scenarios', arguments: { apiId: 'rhnet-hml', method: 'POST', path: '/api/v1/bancos' } });
  assert.equal(JSON.parse(cenarios.content[0].text).statusSucesso, '201');
  await client.close();
});
