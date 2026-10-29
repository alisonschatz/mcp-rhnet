// Simula o deploy na Vercel com Vercel Blob (cliente em memória).
process.env.VERCEL = '1';
process.env.SPEC_SYNC_SECONDS = '0';

const { test, before, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const zlib = await import('node:zlib');
const { execFileSync } = await import('node:child_process');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { createBlobStore } = await import('../src/store/blob-store.js');
const { useStore } = await import('../src/store/index.js');

/** Cliente em memória com a mesma interface usada do @vercel/blob. */
function fakeBlobClient() {
  const blobs = new Map();
  let n = 0;
  const ops = { put: 0, get: 0, list: 0, del: 0 };
  return {
    ops,
    blobs,
    async put(pathname, body, opts) {
      ops.put++;
      assert.equal(opts.access, 'private');
      if (blobs.has(pathname) && !opts.allowOverwrite) throw new Error('blob já existe');
      const text = typeof body === 'string' ? body : body.toString();
      blobs.set(pathname, { text, etag: `"e${++n}"`, uploadedAt: new Date(), url: `https://fake.blob/${pathname}`, pathname });
      return { url: `https://fake.blob/${pathname}`, pathname };
    },
    async get(pathname, opts) {
      ops.get++;
      const b = blobs.get(pathname);
      if (!b) return null;
      if (opts.ifNoneMatch && opts.ifNoneMatch === b.etag) return { statusCode: 304, stream: null, blob: { etag: b.etag } };
      return { statusCode: 200, stream: new Blob([b.text]).stream(), blob: { etag: b.etag, uploadedAt: b.uploadedAt, size: b.text.length } };
    },
    async list({ prefix }) {
      ops.list++;
      const items = [...blobs.values()].filter((b) => b.pathname.startsWith(prefix)).map((b) => ({ pathname: b.pathname, url: b.url, size: b.text.length, uploadedAt: b.uploadedAt }));
      return { blobs: items, hasMore: false };
    },
    async del(url) {
      ops.del++;
      for (const [k, b] of blobs) if (b.url === url) blobs.delete(k);
    },
  };
}

const client = fakeBlobClient();
let server;
let base;
const H = {};

before(async () => {
  execFileSync(process.execPath, ['scripts/build-bundle.js'], { stdio: 'ignore' });
  useStore(createBlobStore({ client }));
  const { default: app } = await import('../src/app.js');
  await new Promise((r) => (server = app.listen(0, '127.0.0.1', r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

async function mcpCall(name, args) {
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const r = await c.callTool({ name, arguments: args });
  await c.close();
  return r.isError ? r.content[0].text : JSON.parse(r.content[0].text);
}

const specAtual = async () => (await fetch(`${base}/api/rhnet/status`)).json();

test('página em /', async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /Abrir spec do RH Net/);
  assert.equal((await fetch(`${base}/favorito.js`)).status, 404);
});

test('começa com a spec do deploy e busca pelo navegador', async () => {
  const st = await specAtual();
  assert.equal(st.armazenamento.tipo, 'vercel-blob');
  assert.equal(st.atual.doBuild, true);
  assert.equal(st.atual.operacoes, 135);
});

test('envio do arquivo (gzip) → MCP já usa a versão nova', async () => {
  const { default: bundle } = await import('../src/specs.bundle.js');
  const nova = structuredClone(bundle.rhnet);
  nova.paths['/api/v1/teste-novo'] = { get: { summary: 'Novo', tags: ['Novo'], responses: { 200: { description: 'ok' }, 400: { description: 'erro' } } } };
  const r = await fetch(`${base}/api/rhnet/enviar`, { method: 'POST', headers: { 'Content-Type': 'application/gzip', 'x-arquivo': encodeURIComponent('docs.json') }, body: zlib.gzipSync(JSON.stringify(nova)) });
  const upd = await r.json();
  assert.equal(upd.status, 'atualizada');
  assert.deepEqual(upd.diff.operacoes.adicionadas, ['GET /api/v1/teste-novo']);
  assert.equal((await mcpCall('list_operations', { apiId: 'rhnet', tag: 'Novo' })).totalItems, 1);

  const st = await specAtual();
  assert.equal(st.atual.operacoes, 136);
  assert.ok(st.atualizadaEm);
  assert.equal(st.eventos[0].origem, 'docs.json');

  const denovo = await (await fetch(`${base}/api/rhnet/enviar`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(nova) })).json();
  assert.equal(denovo.status, 'sem-mudancas');
});

test('outra instância (cache vazio) enxerga a versão do Blob', async () => {
  const { setSpecOverride } = await import('../src/specs.js');
  const { default: bundle } = await import('../src/specs.bundle.js');
  setSpecOverride('rhnet', bundle.rhnet); // simula instância que só tem a spec do build
  useStore(createBlobStore({ client }));
  const ops = await mcpCall('list_operations', { apiId: 'rhnet', tag: 'Novo' });
  assert.equal(ops.totalItems, 1);
});

test('restaurar a versão anterior e enviar conteúdo inválido', async () => {
  const { default: bundle } = await import('../src/specs.bundle.js');
  const v2 = structuredClone(bundle.rhnet);
  v2.info.version = '2.0.0';
  await fetch(`${base}/api/rhnet/enviar`, { method: 'POST', headers: { ...H, 'Content-Type': 'text/plain' }, body: JSON.stringify(v2) });
  const st = await specAtual();
  assert.equal(st.backups.length, 1);
  const r = await (await fetch(`${base}/api/rhnet/restaurar`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ arquivo: st.backups[0].arquivo }) })).json();
  assert.equal(r.status, 'atualizada');
  assert.equal((await mcpCall('list_operations', { apiId: 'rhnet', tag: 'Novo' })).totalItems, 1);

  const ruim = await fetch(`${base}/api/rhnet/enviar`, { method: 'POST', headers: { ...H, 'Content-Type': 'text/plain' }, body: '<html>login</html>' });
  assert.equal(ruim.status, 400);
});

test('acha a variável do Blob mesmo com prefixo personalizado', async () => {
  const { findBlobCredentials } = await import('../src/store/index.js');
  assert.equal(findBlobCredentials({ BLOB_READ_WRITE_TOKEN: 'x' }).origem, 'BLOB_READ_WRITE_TOKEN');
  const pref = findBlobCredentials({ MCP_RHNET_READ_WRITE_TOKEN: 'vercel_blob_rw_abc_123' });
  assert.deepEqual(pref, { opts: { token: 'vercel_blob_rw_abc_123' }, origem: 'MCP_RHNET_READ_WRITE_TOKEN' });
  assert.equal(findBlobCredentials({ OUTRA: '1' }), null);
});
