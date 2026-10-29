// Servidor local (sem Vercel): a spec atualizada fica numa pasta temporária.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-specs-'));
fs.copyFileSync(new URL('../specs/rhnet.json', import.meta.url), path.join(dir, 'rhnet.json'));
process.env.SPECS_DIR = dir;
process.env.SPEC_HISTORY_LIMIT = '2';
delete process.env.VERCEL;

const { test, before, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const express = (await import('express')).default;
const { mountMcpRoutes } = await import('../src/web.js');
const { compareSpecs } = await import('../src/updater.js');
const { loadSpec } = await import('../src/specs.js');

const original = JSON.parse(fs.readFileSync(path.join(dir, 'rhnet.json'), 'utf8'));
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
  fs.rmSync(dir, { recursive: true, force: true });
});

const enviar = (body, type = 'application/json') => fetch(`${base}/api/rhnet/enviar`, { method: 'POST', headers: { 'Content-Type': type }, body }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
const status = () => fetch(`${base}/api/rhnet/status`).then((r) => r.json());

test('compara operações e schemas', () => {
  const d = compareSpecs(original, versao(2));
  assert.deepEqual(d.operacoes.adicionadas, ['GET /api/v1/novo']);
  assert.equal(d.operacoes.removidas.length, 0);
});

test('página, status e armazenamento em disco', async () => {
  assert.match(await (await fetch(base)).text(), /Atualizar MCP RH Net/);
  const st = await status();
  assert.equal(st.armazenamento.tipo, 'disco');
  assert.equal(st.atual.operacoes, 135);
  assert.equal(st.specUrl, 'https://api-rhnet-hml.sci.com.br/docs?api-docs.json');
});

test('envio atualiza o arquivo, guarda backup e o MCP enxerga sem reiniciar', async () => {
  assert.equal((await enviar(JSON.stringify(original))).status, 'sem-mudancas');
  const r = await enviar(JSON.stringify(versao(2)));
  assert.equal(r.status, 'atualizada');
  assert.ok(loadSpec('rhnet').spec.paths['/api/v1/novo']);
  const st = await status();
  assert.equal(st.backups.length, 1);
  assert.equal(st.eventos.length, 1);
});

test('conteúdo inválido não altera nada', async () => {
  const html = await enviar('<html>login</html>', 'text/plain');
  assert.equal(html.status, 400);
  const quebrada = await enviar(JSON.stringify({ openapi: '3.0.0', info: {}, paths: {} }));
  assert.equal(quebrada.status, 'invalida');
  assert.ok(loadSpec('rhnet').spec.paths['/api/v1/novo']);
});

test('limite de versões e restaurar', async () => {
  await enviar(JSON.stringify(versao(3)));
  await enviar(JSON.stringify(versao(4)));
  const st = await status();
  assert.equal(st.backups.length, 2, 'respeita SPEC_HISTORY_LIMIT');
  const r = await fetch(`${base}/api/rhnet/restaurar`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ arquivo: st.backups[0].arquivo }) }).then((x) => x.json());
  assert.equal(r.status, 'atualizada');
  assert.equal(loadSpec('rhnet').spec.info.version, '3');
});

test('API desconhecida é recusada', async () => {
  const r = await fetch(`${base}/api/outra/status`);
  assert.equal(r.status, 400);
});
