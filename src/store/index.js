import { SPEC_SYNC_SECONDS, SPECS_DIR, UPDATABLE_APIS } from '../config.js';
import { setSpecOverride } from '../specs.js';
import { createBlobStore } from './blob-store.js';
import { createFsStore } from './fs-store.js';

/**
 * Escolhe onde a spec é guardada:
 * - BLOB_READ_WRITE_TOKEN definido (Vercel com Blob conectado) → Vercel Blob;
 * - na Vercel sem Blob → somente leitura (spec do build); a tela avisa como ligar;
 * - fora da Vercel → disco (pasta specs/).
 */
let store = null;
let readOnlyReason = null;

/**
 * Acha as credenciais do Blob. Ao conectar o store a Vercel cria BLOB_READ_WRITE_TOKEN, mas
 * se foi definido um prefixo na conexão o nome muda (ex.: MCP_RHNET_READ_WRITE_TOKEN).
 */
export function findBlobCredentials(env = process.env) {
  if (env.BLOB_READ_WRITE_TOKEN) return { opts: {}, origem: 'BLOB_READ_WRITE_TOKEN' };
  for (const [k, v] of Object.entries(env)) {
    if (/READ_WRITE_TOKEN$/.test(k) && /^vercel_blob_rw_/.test(v || '')) return { opts: { token: v }, origem: k };
  }
  if (env.BLOB_STORE_ID) return { opts: {}, origem: 'BLOB_STORE_ID' };
  for (const [k, v] of Object.entries(env)) {
    if (/BLOB.*STORE_ID$|STORE_ID$/.test(k) && /^store_/.test(v || '')) return { opts: { storeId: v }, origem: k };
  }
  return null;
}

/** Repassa as credenciais encontradas para cada chamada do SDK. */
function withCredentials(sdk, opts) {
  if (!Object.keys(opts).length) return sdk;
  return {
    put: (p, body, o = {}) => sdk.put(p, body, { ...o, ...opts }),
    get: (p, o = {}) => sdk.get(p, { ...o, ...opts }),
    list: (o = {}) => sdk.list({ ...o, ...opts }),
    del: (u, o = {}) => sdk.del(u, { ...o, ...opts }),
  };
}

async function init() {
  if (store || readOnlyReason) return;
  const creds = findBlobCredentials();
  if (creds) {
    const sdk = await import('@vercel/blob');
    store = createBlobStore({ client: withCredentials(sdk, creds.opts) });
    store.descricao = `Vercel Blob (privado · ${creds.origem})`;
  } else if (process.env.VERCEL) {
    // Só os nomes (nunca os valores) para ajudar a diagnosticar.
    const nomes = Object.keys(process.env).filter((k) => /BLOB|STORE/i.test(k));
    readOnlyReason =
      'Este deploy não recebeu a variável do Blob (BLOB_READ_WRITE_TOKEN). Confira em Settings do projeto → Environment Variables se ela existe para Production; ' +
      'se existir, faça um Redeploy (Deployments → ⋯ → Redeploy), porque variáveis novas só valem para deploys feitos depois delas.' +
      (nomes.length ? ` Variáveis parecidas encontradas: ${nomes.join(', ')}.` : ' Nenhuma variável BLOB_* chegou a este deploy.');
  } else {
    store = createFsStore({ specsDir: SPECS_DIR });
  }
}

/** Store em uso, ou null quando o ambiente é somente leitura. */
export async function getStore() {
  await init();
  return store;
}

export async function storageInfo() {
  await init();
  return store ? { tipo: store.tipo, descricao: store.descricao, gravavel: true } : { tipo: 'somente-leitura', gravavel: false, motivo: readOnlyReason };
}

/** Para testes: injeta um store (ex.: Blob com cliente em memória). */
export function useStore(custom) {
  store = custom;
  readOnlyReason = null;
  pollState.clear();
  lastPoll = 0;
}

// ---------------------------------------------------------------------------
// Sincronização (Blob): todas as instâncias passam a ver a versão nova.
// ---------------------------------------------------------------------------

const pollState = new Map();
let lastPoll = 0;
let polling = null;

/**
 * Chamado antes de cada requisição do MCP. No disco não faz nada (specs.js já recarrega
 * pelo mtime). No Blob, lê o ponteiro no máximo a cada SPEC_SYNC_SECONDS.
 */
export async function syncSpecs({ force = false } = {}) {
  await init();
  if (!store?.pollCurrent) return;
  if (!force && Date.now() - lastPoll < SPEC_SYNC_SECONDS * 1000) return;
  if (polling) return polling;
  polling = (async () => {
    lastPoll = Date.now();
    for (const apiId of UPDATABLE_APIS) {
      try {
        if (!pollState.has(apiId)) pollState.set(apiId, {});
        const text = await store.pollCurrent(apiId, pollState.get(apiId));
        if (text) setSpecOverride(apiId, JSON.parse(text));
      } catch (e) {
        console.error(`[spec] falha ao sincronizar ${apiId}: ${e.message}`);
      }
    }
  })();
  try {
    await polling;
  } finally {
    polling = null;
  }
}

/** Depois de salvar no Blob, a própria instância já passa a usar a versão nova. */
export function markSynced(apiId, versao, spec) {
  if (!store?.pollCurrent) return;
  const st = pollState.get(apiId) || {};
  st.versao = versao;
  st.etag = undefined;
  pollState.set(apiId, st);
  setSpecOverride(apiId, spec);
}
