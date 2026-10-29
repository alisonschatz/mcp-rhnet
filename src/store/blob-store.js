/**
 * Armazenamento no Vercel Blob (deploy na Vercel, onde o disco é somente leitura).
 *
 * Tudo é privado (access: 'private'), dentro de specs/:
 * - specs/<apiId>/versoes/<data>-<hash>.json   a atual e a anterior (as demais são apagadas)
 * - specs/<apiId>/atual.json                   ponteiro: qual versão vale + última mudança
 *
 * Todas as instâncias da função leem o ponteiro (com cache curto), então uma atualização
 * feita pela tela vale para o MCP em todas elas em poucos segundos.
 *
 * `client` segue a interface do pacote @vercel/blob ({ put, get, list, del }) — nos testes
 * entra um cliente em memória.
 */
async function streamToText(stream) {
  return new Response(stream).text();
}

const RAIZ = 'specs/';
const MARCA_LIMPEZA = `${RAIZ}.limpeza-v3`;

export function createBlobStore({ client }) {
  const pointerPath = (apiId) => `${RAIZ}${apiId}/atual.json`;
  const versionPrefix = (apiId) => `${RAIZ}${apiId}/versoes/`;
  const putOpts = { access: 'private', contentType: 'application/json', addRandomSuffix: false };

  async function readText(pathname, opts = {}) {
    const r = await client.get(pathname, { access: 'private', ...opts });
    if (!r) return null;
    if (r.statusCode === 304) return { notModified: true, etag: r.blob.etag };
    return { text: await streamToText(r.stream), etag: r.blob.etag, uploadedAt: r.blob.uploadedAt };
  }

  async function listAll(prefix) {
    const out = [];
    let cursor;
    do {
      const page = await client.list({ ...(prefix ? { prefix } : {}), cursor, limit: 1000 });
      out.push(...page.blobs);
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return out;
  }

  const listVersions = async (apiId) => (await listAll(versionPrefix(apiId))).sort((a, b) => (a.pathname < b.pathname ? 1 : -1));

  const nameOf = (pathname) => pathname.split('/').pop();

  const store = {
    /**
     * Começo do zero: apaga uma única vez tudo o que foi guardado antes deste formato
     * (versões e históricos antigos). Uma marca no Blob evita repetir.
     */
    async limparAntigos() {
      if (await client.get(MARCA_LIMPEZA, { access: 'private' })) return 0;
      const antigos = (await listAll()).filter((b) => !b.pathname.startsWith(RAIZ));
      for (const b of antigos) await client.del(b.url);
      await client.put(MARCA_LIMPEZA, JSON.stringify({ data: new Date().toISOString(), apagados: antigos.length }), { ...putOpts, allowOverwrite: true });
      return antigos.length;
    },

    tipo: 'vercel-blob',
    descricao: 'Vercel Blob (privado)',

    async readMeta(apiId) {
      const r = await readText(pointerPath(apiId), { useCache: false });
      if (!r?.text) return {};
      try {
        return JSON.parse(r.text);
      } catch {
        return {};
      }
    },

    async writeMeta(apiId, meta) {
      await client.put(pointerPath(apiId), JSON.stringify(meta), { ...putOpts, allowOverwrite: true, cacheControlMaxAge: 60 });
    },

    async readCurrent(apiId) {
      const meta = await this.readMeta(apiId);
      if (!meta.versao) return null;
      const r = await readText(meta.versao);
      return r?.text ? { text: r.text, salvoEm: meta.ultimaAtualizacao || null } : null;
    },

    async saveVersion(apiId, text, { stamp, hash }) {
      const meta = await this.readMeta(apiId);
      const pathname = `${versionPrefix(apiId)}${stamp}-${hash.slice(0, 12)}.json`;
      await client.put(pathname, text, { ...putOpts, cacheControlMaxAge: 31536000 });
      return { backup: meta.versao ? nameOf(meta.versao) : null, versao: pathname };
    },

    async listBackups(apiId) {
      const meta = await this.readMeta(apiId);
      return (await listVersions(apiId))
        .filter((b) => b.pathname !== meta.versao)
        .map((b) => ({ arquivo: nameOf(b.pathname), tamanho: b.size, salvoEm: new Date(b.uploadedAt).toISOString() }));
    },

    async readBackup(apiId, arquivo) {
      if (!/^[\w.-]+\.json$/.test(arquivo)) return null;
      return (await readText(`${versionPrefix(apiId)}${arquivo}`))?.text ?? null;
    },

    async deleteBackup(apiId, arquivo) {
      const found = (await listVersions(apiId)).find((b) => nameOf(b.pathname) === arquivo);
      if (found) await client.del(found.url);
    },

    /**
     * Usado a cada requisição do MCP: devolve o texto da versão atual só quando ela mudou
     * desde a última leitura (o ponteiro é lido com If-None-Match, então é barato).
     */
    async pollCurrent(apiId, state) {
      const r = await readText(pointerPath(apiId), { useCache: false, ...(state.etag ? { ifNoneMatch: state.etag } : {}) });
      if (!r || r.notModified) return null;
      state.etag = r.etag;
      let meta;
      try {
        meta = JSON.parse(r.text);
      } catch {
        return null;
      }
      state.meta = meta;
      if (!meta.versao || meta.versao === state.versao) return null;
      const v = await readText(meta.versao);
      if (!v?.text) return null;
      state.versao = meta.versao;
      return v.text;
    },
  };
  return store;
}
