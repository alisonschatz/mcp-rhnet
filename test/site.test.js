// Servidor local (sem Vercel): a spec atualizada fica numa pasta temporária.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-specs-'));

// "Produção" falsa: serve uma cópia da spec sem uma operação e com um campo a mais.
const hml = JSON.parse(fs.readFileSync(new URL('./fixtures/specs/rhnet-hml.json', import.meta.url), 'utf8'));
const prd = structuredClone(hml);
delete prd.paths['/api/v1/verbas'];
prd.components.schemas.BancoStoreItem.properties.campo_novo = { type: 'string', maxLength: 10 };
let prdHits = 0;
const prdServer = http.createServer((req, res) => {
  prdHits++;
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(prd));
});
await new Promise((r) => prdServer.listen(0, '127.0.0.1', r));
process.env.RHNET_PRD_SPEC_URL = `http://127.0.0.1:${prdServer.address().port}/docs?api-docs.json`;
fs.copyFileSync(new URL('./fixtures/specs/rhnet-hml.json', import.meta.url), path.join(dir, 'rhnet-hml.json'));
process.env.SPECS_DIR = dir;
delete process.env.VERCEL;

const { test, before, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const express = (await import('express')).default;
const { mountMcpRoutes } = await import('../src/web.js');
const { compareSpecs } = await import('../src/updater.js');
const { loadSpec } = await import('../src/specs.js');

const original = JSON.parse(fs.readFileSync(path.join(dir, 'rhnet-hml.json'), 'utf8'));
const versao = (n) => {
  const s = structuredClone(original);
  s.info.version = String(n);
  if (n === 2) s.paths['/api/v1/novo'] = { get: { summary: 'Novo', responses: { 200: { description: 'ok' }, 400: { description: 'e' } } } };
  return s;
};

let server;
let base;
before(async () => {
  await new Promise((r) => (server = mountMcpRoutes(express()).listen(0, '127.0.0.1', r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server?.close();
  prdServer.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const enviar = (body, type = 'application/json') => fetch(`${base}/api/rhnet-hml/enviar`, { method: 'POST', headers: { 'Content-Type': type }, body }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
const status = () => fetch(`${base}/api/status`).then((r) => r.json()).then((s) => s.apis.find((a) => a.apiId === 'rhnet-hml'));

test('compara operações e schemas', () => {
  const d = compareSpecs(original, versao(2));
  assert.deepEqual(d.operacoes.adicionadas, ['GET /api/v1/novo']);
  assert.equal(d.operacoes.removidas.length, 0);
});

test('página, status e armazenamento em disco', async () => {
  assert.match(await (await fetch(base)).text(), /Homologação/);
  const st = await status();
  assert.equal(st.armazenamento.tipo, 'disco');
  assert.equal(st.atual.operacoes, 135);
  assert.equal(st.specUrl, 'https://api-rhnet-hml.sci.com.br/docs?api-docs.json');
});

test('envio atualiza o arquivo, guarda backup e o MCP enxerga sem reiniciar', async () => {
  assert.equal((await enviar(JSON.stringify(original))).status, 'sem-mudancas');
  const r = await enviar(JSON.stringify(versao(2)));
  assert.equal(r.status, 'atualizada');
  assert.ok(loadSpec('rhnet-hml').spec.paths['/api/v1/novo']);
  const st = await status();
  assert.ok(st.versaoAnterior);
  assert.deepEqual(st.ultimaMudanca.diff.operacoes.adicionadas, ['GET /api/v1/novo']);
  assert.equal(st.ultimaMudanca.origem, 'arquivo');
});

test('conteúdo inválido não altera nada', async () => {
  const html = await enviar('<html>login</html>', 'text/plain');
  assert.equal(html.status, 400);
  const quebrada = await enviar(JSON.stringify({ openapi: '3.0.0', info: {}, paths: {} }));
  assert.equal(quebrada.status, 'invalida');
  assert.ok(loadSpec('rhnet-hml').spec.paths['/api/v1/novo']);
});

test('guarda só a versão anterior e restaura', async () => {
  await enviar(JSON.stringify(versao(3)));
  await enviar(JSON.stringify(versao(4)));
  const arquivos = fs.readdirSync(path.join(dir, '.historico')).filter((f) => f.startsWith('rhnet-hml-'));
  assert.equal(arquivos.length, 1, 'só a anterior fica guardada');
  const st = await status();
  const r = await fetch(`${base}/api/rhnet-hml/restaurar`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ arquivo: st.versaoAnterior.arquivo }) }).then((x) => x.json());
  assert.equal(r.status, 'atualizada');
  assert.equal(loadSpec('rhnet-hml').spec.info.version, '3');
  assert.equal((await status()).versaoAnterior.arquivo !== st.versaoAnterior.arquivo, true, 'a que estava em uso virou a anterior');
});

test('API desconhecida é recusada', async () => {
  const r = await fetch(`${base}/api/outra/atualizar`, { method: 'POST' });
  assert.equal(r.status, 400);
});

test('produção é baixada sozinha pelo servidor e só uma vez dentro do intervalo', async () => {
  const st = await fetch(`${base}/api/status`).then((r) => r.json());
  const p = st.apis.find((a) => a.apiId === 'rhnet-prd');
  assert.equal(p.modo, 'automatico');
  assert.equal(p.atual.operacoes, 131);
  assert.ok(p.verificadaEm);
  const hits = prdHits;
  await fetch(`${base}/api/status`);
  assert.equal(prdHits, hits, 'não baixa de novo antes do intervalo');
  const manual = await fetch(`${base}/api/rhnet-prd/atualizar`, { method: 'POST' }).then((r) => r.json());
  assert.equal(manual.status, 'sem-mudancas');
});

test('comparar ambientes pela API da página e pela tool do MCP', async () => {
  const d = await fetch(`${base}/api/comparar?a=rhnet-hml&b=rhnet-prd`).then((r) => r.json());
  assert.ok(d.operacoes.soEmA.some((o) => o.metodo === 'GET' && o.path === '/api/v1/verbas' && o.resumo));

  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const ids = JSON.parse((await c.callTool({ name: 'list_apis', arguments: {} })).content[0].text).apis.map((a) => a.id);
  assert.deepEqual(ids, ['rhnet-hml', 'rhnet-prd']);
  const resumo = JSON.parse((await c.callTool({ name: 'compare_apis', arguments: { apiIdA: 'rhnet-hml', apiIdB: 'rhnet-prd' } })).content[0].text);
  assert.ok(resumo.operacoes.soEmA.length >= 4);
  const op = JSON.parse((await c.callTool({ name: 'compare_apis', arguments: { apiIdA: 'rhnet-hml', apiIdB: 'rhnet-prd', method: 'POST', path: '/api/v1/verbas' } })).content[0].text);
  assert.equal(op.existeEmB, false);
  const campos = JSON.parse((await c.callTool({ name: 'compare_apis', arguments: { apiIdA: 'rhnet-hml', apiIdB: 'rhnet-prd', method: 'POST', path: '/api/v1/bancos' } })).content[0].text);
  assert.deepEqual(campos.diferencas.map((d) => [d.situacao, d.item]), [['só em rhnet-prd', 'corpo.dados[].campo_novo']]);
  await c.close();
});
