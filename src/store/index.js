import { SPEC_SYNC_SECONDS, SPEC_SOURCES, SPECS_DIR } from '../config.js';
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

async function init() {
  if (store || readOnlyReason) return;
  if (process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID) {
    const client = await import('@vercel/blob');
    store = createBlobStore({ client });
  } else if (process.env.VERCEL) {
    readOnlyReason =
      'Na Vercel a spec precisa de um armazenamento: crie um Blob Store em Storage → Blob e conecte ao projeto (isso cria a variável BLOB_READ_WRITE_TOKEN). Depois faça um redeploy.';
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
    for (const apiId of Object.keys(SPEC_SOURCES)) {
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
