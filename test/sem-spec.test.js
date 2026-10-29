// Começo do zero: sem nenhuma spec de homologação até alguém enviar pela página.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-vazio-'));
process.env.SPECS_DIR = dir;
process.env.SPEC_AUTO_UPDATE_MINUTES = '0';
delete process.env.VERCEL;

const { test, before, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const express = (await import('express')).default;
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { mountMcpRoutes } = await import('../src/web.js');

const spec = fs.readFileSync(new URL('./fixtures/specs/rhnet-hml.json', import.meta.url), 'utf8');
let server;
let base;
before(async () => {
  await new Promise((r) => (server = mountMcpRoutes(express()).listen(0, '127.0.0.1', r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const status = () => fetch(`${base}/api/status`).then((r) => r.json()).then((s) => s.apis.find((a) => a.apiId === 'rhnet-hml'));
async function tool(name, args) {
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const r = await c.callTool({ name, arguments: args });
  await c.close();
  return r;
}

test('sem spec: página, comparação e MCP explicam o que fazer', async () => {
  const st = await status();
  assert.equal(st.atual, null);
  assert.equal(st.ultimaMudanca, null);
  const cmp = await fetch(`${base}/api/comparar?a=rhnet-hml&b=rhnet-prd`);
  assert.equal(cmp.status, 400);
  assert.match((await cmp.json()).erro, /Envie a spec de homologação/);
  const lista = await tool('list_apis', {});
  assert.equal(lista.isError, true);
  const ops = await tool('list_operations', { apiId: 'rhnet-hml' });
  assert.match(ops.content[0].text, /Envie o arquivo pela página/);
});

test('primeiro envio vira a versão em uso (primeira carga)', async () => {
  const r = await fetch(`${base}/api/rhnet-hml/enviar`, { method: 'POST', headers: { 'Content-Type': 'text/plain', 'x-arquivo': 'docs.json' }, body: spec }).then((x) => x.json());
  assert.equal(r.status, 'atualizada');
  const st = await status();
  assert.equal(st.atual.operacoes, 135);
  assert.equal(st.ultimaMudanca.primeiraCarga, true);
  assert.equal(st.versaoAnterior, null);
  assert.deepEqual(await fetch(`${base}/api/rhnet-hml/mudancas`).then((x) => x.json()), { semAnterior: true });
  const ops = JSON.parse((await tool('list_operations', { apiId: 'rhnet-hml', tag: 'Bancos' })).content[0].text);
  assert.equal(ops.totalItems, 4);
});
