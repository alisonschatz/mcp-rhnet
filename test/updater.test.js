// Roda em processo próprio: aponta SPECS_DIR para uma pasta temporária antes dos imports.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-specs-'));
process.env.SPECS_DIR = dir;
process.env.SPEC_HISTORY_LIMIT = '2';
delete process.env.RHNET_SPEC_URL;

const { test, before, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const express = (await import('express')).default;
const { mountMcpRoutes } = await import('../src/web.js');
const { mountAdminRoutes } = await import('../src/admin.js');
const { compareSpecs, findSpecLinks, listBackups, specStatus, updateFromText, updateFromUrl } = await import('../src/updater.js');
const { loadSpec } = await import('../src/specs.js');

const pedidos = JSON.parse(fs.readFileSync(new URL('./fixtures/pedidos.json', import.meta.url)));
const v1 = structuredClone(pedidos);
const v2 = structuredClone(pedidos);
v2.paths['/novos'] = { get: { summary: 'Novo', responses: { 200: { description: 'ok' }, 400: { description: 'erro' } } } };
delete v2.paths['/health'];
v2.components.schemas.Extra = { type: 'object' };

let current = v1;
let fonte;
let admin;
let base;

before(async () => {
  fonte = http.createServer((req, res) => {
    if (req.url === '/spec.json') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(current));
    if (req.url === '/docs') return res.writeHead(200, { 'content-type': 'text/html' }).end('<html><script>SwaggerUIBundle({ url: "/spec.json", dom_id: "#swagger" })</script></html>');
    if (req.url === '/privado') return res.writeHead(302, { location: '/erro.php?erro=401' }).end();
    if (req.url === '/erro.php?erro=401') return res.writeHead(200, { 'content-type': 'text/html' }).end('Sem permissão');
    if (req.url === '/login') return res.writeHead(200, { 'content-type': 'text/html' }).end('<form><input name="u"><input type="password" name="s"></form>');
    if (req.url === '/quebrada') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ openapi: '3.0.0', info: {}, paths: {} }));
    res.writeHead(404).end();
  });
  await new Promise((r) => fonte.listen(0, '127.0.0.1', r));
  const f = `http://127.0.0.1:${fonte.address().port}`;
  base = f;

  const app = mountMcpRoutes(express(), { extraRoutes: (a) => mountAdminRoutes(a, { token: 'segredo' }) });
  await new Promise((r) => (admin = app.listen(0, '127.0.0.1', r)));
});
after(() => {
  fonte?.close();
  admin?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const adminUrl = () => `http://127.0.0.1:${admin.address().port}`;

test('acha o link do JSON em páginas do Swagger UI e l5-swagger', () => {
  assert.deepEqual(findSpecLinks('SwaggerUIBundle({ url: "/docs/api-docs.json" })', 'https://x.com/api/documentation'), ['https://x.com/docs/api-docs.json']);
  assert.ok(findSpecLinks(`const u = "https:\\/\\/x.com\\/docs?api-docs.json";`, 'https://x.com/').includes('https://x.com/docs?api-docs.json'));
});

test('compara operações e schemas', () => {
  const d = compareSpecs(v1, v2);
  assert.deepEqual(d.operacoes.adicionadas, ['GET /novos']);
  assert.deepEqual(d.operacoes.removidas, ['GET /health']);
  assert.deepEqual(d.schemas.adicionadas, ['Extra']);
});

test('primeira carga pela página do Swagger grava a spec e lembra a URL do JSON', async () => {
  const r = await updateFromUrl('rhnet', { url: `${base}/docs` });
  assert.equal(r.status, 'atualizada');
  assert.equal(r.urlUsada, `${base}/spec.json`);
  assert.equal(loadSpec('rhnet').spec.info.title, v1.info.title);
  assert.equal((await specStatus('rhnet')).fonte.url, `${base}/spec.json`);
});

test('sem mudanças não gera backup', async () => {
  const r = await updateFromUrl('rhnet');
  assert.equal(r.status, 'sem-mudancas');
  assert.equal((await listBackups('rhnet')).length, 0);
});

test('verificar mostra o diff sem gravar; atualizar grava e faz backup', async () => {
  current = v2;
  const check = await updateFromUrl('rhnet', { aplicar: false });
  assert.equal(check.status, 'nova-versao');
  assert.equal(check.aplicada, false);
  assert.ok(!loadSpec('rhnet').spec.paths['/novos']);

  const upd = await updateFromUrl('rhnet');
  assert.equal(upd.status, 'atualizada');
  assert.ok(upd.backup);
  assert.ok(loadSpec('rhnet').spec.paths['/novos'], 'MCP enxerga a versão nova sem reiniciar');
  assert.equal((await listBackups('rhnet')).length, 1);
});

test('spec inválida ou URL com login não substituem a atual', async () => {
  const ruim = await updateFromUrl('rhnet', { url: `${base}/quebrada` });
  assert.equal(ruim.status, 'invalida');
  assert.ok(loadSpec('rhnet').spec.paths['/novos']);
  await assert.rejects(updateFromUrl('rhnet', { url: `${base}/login` }), /tela de login/);
  await assert.rejects(updateFromUrl('rhnet', { url: `${base}/privado` }), (e) => /Acesso negado/.test(e.message) && /RHNET_SPEC_TOKEN/.test(e.dica));
  const fechado = http.createServer();
  await new Promise((r) => fechado.listen(0, '127.0.0.1', r));
  const porta = fechado.address().port;
  await new Promise((r) => fechado.close(r));
  await assert.rejects(updateFromUrl('rhnet', { url: `http://127.0.0.1:${porta}/x.json` }), (e) => /VPN/.test(e.dica));
});

test('upload manual e limite de backups', async () => {
  const v3 = structuredClone(v2);
  v3.info.version = '9.9.9';
  assert.equal((await updateFromText('rhnet', JSON.stringify(v3))).status, 'atualizada');
  const v4 = structuredClone(v3);
  v4.info.version = '10.0.0';
  assert.equal((await updateFromText('rhnet', JSON.stringify(v4))).status, 'atualizada');
  assert.equal((await listBackups('rhnet')).length, 2, 'respeita SPEC_HISTORY_LIMIT');
  await assert.rejects(updateFromText('rhnet', '<html>'), /não é um JSON OpenAPI/);
});

test('tela /admin: exige token, mostra status e restaura backup', async () => {
  const page = await fetch(`${adminUrl()}/admin`);
  assert.match(await page.text(), /Spec do RH Net/);
  assert.equal((await fetch(`${adminUrl()}/admin/api/status`)).status, 401);

  const h = { 'x-admin-token': 'segredo', 'Content-Type': 'application/json' };
  const status = await (await fetch(`${adminUrl()}/admin/api/status`, { headers: h })).json();
  const rh = status.apis.find((a) => a.apiId === 'rhnet');
  assert.equal(rh.atual.operacoes, Object.values(loadSpec('rhnet').spec.paths).flatMap(Object.keys).filter((k) => k !== 'parameters').length);
  assert.ok(rh.eventos.some((e) => e.tipo === 'atualizado'));

  const backup = rh.backups.at(-1).arquivo;
  const r = await (await fetch(`${adminUrl()}/admin/api/rhnet/restaurar`, { method: 'POST', headers: h, body: JSON.stringify({ arquivo: backup }) })).json();
  assert.equal(r.aplicada, true);

  const up = await fetch(`${adminUrl()}/admin/api/rhnet/enviar?aplicar=0`, { method: 'POST', headers: { 'x-admin-token': 'segredo', 'Content-Type': 'text/plain' }, body: JSON.stringify(v1) });
  assert.equal((await up.json()).status, 'nova-versao');

  const erro = await fetch(`${adminUrl()}/admin/api/rhnet/atualizar`, { method: 'POST', headers: h, body: JSON.stringify({ url: 'nao-e-url' }) });
  assert.equal(erro.status, 400);
  assert.match((await erro.json()).erro, /URL inválida/);
});
