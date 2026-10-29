import zlib from 'node:zlib';
import { APIS, SPEC_AUTO_UPDATE_MINUTES, SPEC_FETCH_TIMEOUT_MS, UPDATABLE_APIS } from './config.js';
import { compareSpecs, diffCounts, summarize } from './spec-diff.js';
import { loadSpec } from './specs.js';
import { getStore, markSynced, storageInfo, syncSpecs } from './store/index.js';
import { validateSpec } from './validate.js';

export { compareSpecs } from './spec-diff.js';

/**
 * Atualização da spec: arquivo enviado pela página (homologação, que só abre na VPN) ou
 * download pelo servidor (produção, pública — automático a cada SPEC_AUTO_UPDATE_MINUTES).
 * Fluxo: parse → valida → compara com a atual → grava no store (Vercel Blob ou disco),
 * guardando a anterior. Uma spec inválida nunca substitui a atual, e o MCP passa a usar
 * a versão nova sem reiniciar.
 */

export class UpdateError extends Error {}

const running = new Set();

function stamp(date = new Date()) {
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}-${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}-${p(date.getUTCMilliseconds(), 3)}`;
}

export function tryParseSpec(text) {
  const trimmed = String(text || '').replace(/^﻿/, '').trimStart();
  if (!trimmed.startsWith('{')) return null;
  try {
    const spec = JSON.parse(trimmed);
    return spec && (spec.openapi || spec.swagger) ? spec : null;
  } catch {
    return null;
  }
}

function checkApi(apiId) {
  if (!UPDATABLE_APIS.includes(apiId)) throw new UpdateError(`API "${apiId}" não pode ser atualizada por aqui.`);
}

async function writableStore() {
  const store = await getStore();
  if (!store) throw new UpdateError((await storageInfo()).motivo);
  return store;
}

/** Versão atual: a do store; se ainda não houver (Blob vazio), a do build/repositório. */
async function currentVersion(store, apiId) {
  const saved = store ? await store.readCurrent(apiId) : null;
  if (saved) {
    const spec = tryParseSpec(saved.text);
    if (spec) return { spec, text: saved.text, salvoEm: saved.salvoEm };
  }
  const { spec } = loadSpec(apiId);
  return spec ? { spec, text: JSON.stringify(spec), salvoEm: null, doBuild: true } : null;
}

export async function specStatus(apiId) {
  checkApi(apiId);
  const store = await getStore();
  const meta = store ? await store.readMeta(apiId) : {};
  const cur = await currentVersion(store, apiId);
  const cfg = APIS[apiId];
  return {
    apiId,
    nome: cfg.nome,
    modo: cfg.modo,
    specUrl: cfg.specUrl,
    atual: cur ? { ...summarize(cur.spec, cur.text), doBuild: Boolean(cur.doBuild) } : null,
    atualizadaEm: meta.ultimaAtualizacao || null,
    verificadaEm: meta.ultimaVerificacao || null,
    ultimoErro: meta.ultimoErro || null,
    armazenamento: await storageInfo(),
    ultimaMudanca: meta.ultimaMudanca || null,
    versaoAnterior: (store ? await store.listBackups(apiId) : [])[0] || null,
  };
}

async function exclusive(apiId, fn) {
  if (running.has(apiId)) throw new UpdateError('Já existe uma atualização em andamento.');
  running.add(apiId);
  try {
    return await fn();
  } finally {
    running.delete(apiId);
  }
}

async function apply(store, apiId, spec, text, origem, { verificacao = false } = {}) {
  const { errors } = validateSpec(spec);
  const nova = summarize(spec, text);
  const cur = await currentVersion(store, apiId);
  const anterior = cur ? summarize(cur.spec, cur.text) : null;
  const diff = compareSpecs(cur?.spec || null, spec);
  const base = { apiId, anterior, nova, diff, resumo: diffCounts(diff), erros: errors };

  if (errors.length) return { ...base, status: 'invalida', mensagem: 'Spec inválida. Nada foi alterado.' };
  // Mesmo conteúdo: não grava. Exceção: a atual ainda é a do build e o store está vazio.
  if (anterior?.hash === nova.hash && !cur?.doBuild) {
    if (verificacao) {
      const meta = await store.readMeta(apiId);
      meta.ultimaVerificacao = new Date().toISOString();
      delete meta.ultimoErro;
      await store.writeMeta(apiId, meta);
    }
    return { ...base, status: 'sem-mudancas', mensagem: 'Já estava atualizada.' };
  }

  const { backup, versao } = await store.saveVersion(apiId, `${JSON.stringify(spec, null, 4)}\n`, { stamp: stamp(), hash: nova.hash });
  const agora = new Date().toISOString();
  const meta = await store.readMeta(apiId);
  meta.ultimaAtualizacao = agora;
  if (verificacao) {
    meta.ultimaVerificacao = agora;
    delete meta.ultimoErro;
  }
  if (versao) meta.versao = versao;
  // Só a última mudança, com o detalhe do que mudou (nomes de operações e schemas).
  meta.ultimaMudanca = { data: agora, origem, primeiraCarga: !anterior, anterior: anterior && { operacoes: anterior.operacoes, schemas: anterior.schemas }, nova: { operacoes: nova.operacoes, schemas: nova.schemas }, resumo: diffCounts(diff), diff };
  delete meta.eventos;
  await store.writeMeta(apiId, meta);
  markSynced(apiId, versao, spec);
  // Guarda só a versão anterior à atual.
  for (const { arquivo } of (await store.listBackups(apiId)).slice(1)) await store.deleteBackup(apiId, arquivo);

  if (anterior?.hash === nova.hash) return { ...base, status: 'sem-mudancas', mensagem: 'Já estava atualizada.' };
  return { ...base, status: 'atualizada', backup, mensagem: 'Spec atualizada.' };
}

/** Conteúdo enviado (texto ou Buffer, opcionalmente gzip). */
export function updateFromText(apiId, body, { origem } = {}) {
  checkApi(apiId);
  return exclusive(apiId, async () => {
    const store = await writableStore();
    let text = body;
    // JSON já interpretado pelo express.json (Content-Type: application/json).
    if (body && typeof body === 'object' && !Buffer.isBuffer(body)) text = JSON.stringify(body);
    else if (Buffer.isBuffer(body)) {
      try {
        text = body[0] === 0x1f && body[1] === 0x8b ? zlib.gunzipSync(body).toString('utf8') : body.toString('utf8');
      } catch {
        throw new UpdateError('Não foi possível ler o conteúdo enviado.');
      }
    }
    const spec = tryParseSpec(text);
    if (!spec) throw new UpdateError('O arquivo não é uma spec OpenAPI em JSON.');
    return apply(store, apiId, spec, String(text), origem || 'arquivo');
  });
}

/** Volta para uma versão anterior (a atual também fica guardada). */
export function restoreBackup(apiId, arquivo) {
  checkApi(apiId);
  return exclusive(apiId, async () => {
    const store = await writableStore();
    const text = await store.readBackup(apiId, arquivo);
    if (text == null) throw new UpdateError('Versão não encontrada.');
    const spec = tryParseSpec(text);
    if (!spec) throw new UpdateError('Versão guardada inválida.');
    return apply(store, apiId, spec, text, `restaurada (${arquivo})`);
  });
}

export async function listBackups(apiId) {
  const store = await getStore();
  return store ? store.listBackups(apiId) : [];
}

// ---------------------------------------------------------------------------
// Download pelo servidor (APIs com spec pública)
// ---------------------------------------------------------------------------

async function download(url) {
  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(SPEC_FETCH_TIMEOUT_MS) });
  } catch (e) {
    throw new UpdateError(`Não foi possível baixar a spec (${e.cause?.code || e.name}).`);
  }
  if (!res.ok) throw new UpdateError(`A spec respondeu ${res.status}.`);
  const text = await res.text();
  const spec = tryParseSpec(text);
  if (!spec) throw new UpdateError('O link não devolveu uma spec OpenAPI em JSON.');
  return { spec, text };
}

/** Baixa a spec do link configurado e aplica se mudou. */
export function updateFromUrl(apiId, { origem = 'automático' } = {}) {
  checkApi(apiId);
  return exclusive(apiId, async () => {
    const store = await writableStore();
    try {
      const { spec, text } = await download(APIS[apiId].specUrl);
      return await apply(store, apiId, spec, text, origem, { verificacao: true });
    } catch (e) {
      const meta = await store.readMeta(apiId);
      meta.ultimaVerificacao = new Date().toISOString();
      meta.ultimoErro = e.message;
      await store.writeMeta(apiId, meta);
      throw e;
    }
  });
}

const lastAutoCheck = new Map();

/**
 * Chamado antes de cada uso (MCP e página): sincroniza a versão guardada e, para as APIs
 * automáticas, baixa a spec de novo se a última verificação passou do intervalo.
 * Falhas não interrompem o MCP: a versão atual continua valendo.
 */
export async function ensureFresh() {
  await syncSpecs();
  if (!(SPEC_AUTO_UPDATE_MINUTES > 0)) return;
  const store = await getStore();
  if (!store) return;
  const intervalo = SPEC_AUTO_UPDATE_MINUTES * 60_000;
  const automaticas = UPDATABLE_APIS.filter((id) => APIS[id].modo === 'automatico');
  await Promise.all(
    automaticas.map(async (apiId) => {
      if (Date.now() - (lastAutoCheck.get(apiId) || 0) < intervalo) return;
      lastAutoCheck.set(apiId, Date.now());
      const ultima = Date.parse((await store.readMeta(apiId)).ultimaVerificacao || '') || 0;
      if (Date.now() - ultima < intervalo && loadSpec(apiId).spec) return lastAutoCheck.set(apiId, ultima);
      try {
        const r = await updateFromUrl(apiId);
        if (r.status === 'atualizada') console.log(`[spec] ${apiId} atualizada automaticamente`);
      } catch (e) {
        console.error(`[spec] ${apiId}: ${e.message}`);
      }
    })
  );
}
