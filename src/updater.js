import zlib from 'node:zlib';
import { SPEC_FETCH_MODE, SPEC_HISTORY_LIMIT, SPEC_SOURCES } from './config.js';
import { downloadSpec, tryParseSpec, UpdateError } from './fetcher.js';
import { compareSpecs, diffCounts, summarize } from './spec-diff.js';
import { loadSpec } from './specs.js';
import { getStore, markSynced, storageInfo } from './store/index.js';
import { validateSpec } from './validate.js';

export { compareSpecs } from './spec-diff.js';
export { findSpecLinks, UpdateError } from './fetcher.js';

/**
 * Atualização da spec.
 *
 * Origem do conteúdo:
 * - URL (o servidor baixa: local/Docker na rede interna);
 * - texto enviado (o navegador baixou pela VPN de quem usa, ou upload de arquivo).
 *
 * Em ambos: parse → valida → compara com a atual → grava no store (disco ou Vercel Blob)
 * guardando a anterior. Uma spec inválida nunca substitui a atual, e o MCP passa a usar
 * a versão nova sem reiniciar.
 */

const MAX_EVENTS = 40;
const running = new Map();
const lastCheck = new Map(); // em memória, para stores que não gravam toda verificação

function stamp(date = new Date()) {
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}-${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}-${p(date.getUTCMilliseconds(), 3)}`;
}

async function writableStore() {
  const store = await getStore();
  if (!store) throw new UpdateError('Este ambiente não consegue gravar a spec.', (await storageInfo()).motivo);
  return store;
}

async function recordEvent(store, apiId, evento, extra = {}, { force = false } = {}) {
  const agora = new Date().toISOString();
  lastCheck.set(apiId, agora);
  if (!store.persistEveryEvent && !force) return;
  const meta = await store.readMeta(apiId);
  Object.assign(meta, { ultimaVerificacao: agora }, extra);
  meta.eventos = [{ data: agora, ...evento }, ...(meta.eventos || [])].slice(0, MAX_EVENTS);
  await store.writeMeta(apiId, meta);
}

/** Versão atual: a do store; se ainda não houver (ex.: Blob vazio), a do build/repositório. */
async function currentVersion(store, apiId) {
  const saved = store ? await store.readCurrent(apiId) : null;
  if (saved) {
    try {
      return { spec: JSON.parse(saved.text.replace(/^﻿/, '')), text: saved.text, salvoEm: saved.salvoEm };
    } catch {
      /* cai no fallback */
    }
  }
  const { spec } = loadSpec(apiId);
  return spec ? { spec, text: JSON.stringify(spec), salvoEm: null, doBuild: true } : null;
}

export async function sourceFor(apiId) {
  const src = SPEC_SOURCES[apiId];
  if (!src) throw new UpdateError(`Não há fonte configurada para "${apiId}". Fontes: ${Object.keys(SPEC_SOURCES).join(', ')}.`);
  const store = await getStore();
  const meta = store ? await store.readMeta(apiId) : {};
  // Prioridade: variável de ambiente > última URL usada na tela > padrão.
  const url = src.urlFromEnv ? src.url : meta.url || src.url;
  return { url, headers: src.headers, autenticacao: Object.keys(src.headers) };
}

export async function specStatus(apiId) {
  const store = await getStore();
  const armazenamento = await storageInfo();
  const meta = store ? await store.readMeta(apiId) : { eventos: [] };
  let atual = null;
  let erro = null;
  try {
    const cur = await currentVersion(store, apiId);
    if (cur) atual = { ...summarize(cur.spec, cur.text), modificadoEm: cur.salvoEm, doBuild: Boolean(cur.doBuild) };
  } catch (e) {
    erro = `Spec atual ilegível: ${e.message}`;
  }
  const src = SPEC_SOURCES[apiId];
  const fonte = src ? { url: src.urlFromEnv ? src.url : meta.url || src.url, urlFixadaNoAmbiente: Boolean(src.urlFromEnv), autenticacao: Object.keys(src.headers) } : null;
  return {
    apiId,
    atual,
    erro,
    fonte,
    modoBusca: SPEC_FETCH_MODE,
    armazenamento,
    ultimaAtualizacao: meta.ultimaAtualizacao || null,
    ultimaVerificacao: [meta.ultimaVerificacao, lastCheck.get(apiId)].filter(Boolean).sort().pop() || null,
    emAndamento: running.has(apiId),
    eventos: meta.eventos || [],
    backups: store ? await store.listBackups(apiId) : [],
  };
}

async function processCandidate(apiId, { spec, text }, { aplicar, origem, url }) {
  const store = await writableStore();
  const { errors, warnings } = validateSpec(spec);
  const nova = summarize(spec, text);
  const cur = await currentVersion(store, apiId);
  const anterior = cur ? summarize(cur.spec, cur.text) : null;
  const diff = compareSpecs(cur?.spec || null, spec);
  const base = { apiId, origem, anterior, nova, diff, resumo: diffCounts(diff), avisos: warnings, erros: errors };
  const urlExtra = url && !SPEC_SOURCES[apiId]?.urlFromEnv ? { url } : {};

  if (errors.length) {
    await recordEvent(store, apiId, { tipo: 'erro', origem, mensagem: `Spec recebida inválida (${errors.length} erro(s)); a atual foi mantida.` });
    return { ...base, status: 'invalida', aplicada: false, mensagem: 'A spec recebida tem erros e não foi aplicada. A versão atual continua valendo.' };
  }
  // Mesmo conteúdo, mas a atual ainda é a do build: vale gravar para o store passar a ter a versão.
  if (anterior?.hash === nova.hash && !(aplicar && cur?.doBuild)) {
    await recordEvent(store, apiId, { tipo: 'sem-mudancas', origem, hash: nova.hash }, urlExtra);
    return { ...base, status: 'sem-mudancas', aplicada: false, mensagem: 'A spec já está na versão mais recente.' };
  }
  if (!aplicar) {
    await recordEvent(store, apiId, { tipo: 'verificado', origem, hash: nova.hash, resumo: diffCounts(diff) }, urlExtra);
    return { ...base, status: 'nova-versao', aplicada: false, mensagem: 'Há uma versão nova disponível (ainda não aplicada).' };
  }

  const pretty = `${JSON.stringify(spec, null, 4)}\n`;
  const { backup, versao } = await store.saveVersion(apiId, pretty, { stamp: stamp(), hash: nova.hash });
  const agora = new Date().toISOString();
  await recordEvent(
    store,
    apiId,
    { tipo: 'atualizado', origem, hash: nova.hash, hashAnterior: anterior?.hash || null, backup, resumo: diffCounts(diff) },
    { ultimaAtualizacao: agora, ...(versao ? { versao } : {}), ...urlExtra },
    { force: true }
  );
  markSynced(apiId, versao, spec);
  for (const { arquivo } of (await store.listBackups(apiId)).slice(SPEC_HISTORY_LIMIT)) await store.deleteBackup(apiId, arquivo);
  return { ...base, status: 'atualizada', aplicada: true, backup, mensagem: 'Spec atualizada. O MCP já usa a versão nova (não precisa reiniciar).' };
}

async function exclusive(apiId, fn) {
  if (running.has(apiId)) throw new UpdateError('Já existe uma atualização em andamento. Aguarde terminar.');
  const p = fn();
  running.set(apiId, p);
  try {
    return await p;
  } finally {
    running.delete(apiId);
  }
}

/** O servidor baixa da URL configurada (ou da informada). */
export function updateFromUrl(apiId, { aplicar = true, url } = {}) {
  return exclusive(apiId, async () => {
    const store = await writableStore();
    const source = await sourceFor(apiId);
    const target = (url || '').trim() || source.url;
    try {
      new URL(target);
    } catch {
      throw new UpdateError(`URL inválida: "${target}".`);
    }
    let downloaded;
    try {
      downloaded = await downloadSpec(target, source.headers);
    } catch (e) {
      await recordEvent(store, apiId, { tipo: 'erro', origem: target, mensagem: e.message });
      throw e;
    }
    const usada = downloaded.urlFinal || target;
    const report = await processCandidate(apiId, downloaded, { aplicar, origem: usada, url: usada });
    return { ...report, urlUsada: usada, ...(downloaded.descobertaEm ? { jsonDescobertoNaPagina: downloaded.descobertaEm } : {}) };
  });
}

/**
 * Conteúdo enviado pela tela: baixado pelo navegador (pela VPN de quem usa) ou upload de
 * arquivo. Aceita texto ou Buffer, opcionalmente gzip.
 */
export function updateFromText(apiId, body, { aplicar = true, origem, url } = {}) {
  return exclusive(apiId, async () => {
    if (!SPEC_SOURCES[apiId] && !loadSpec(apiId).spec) throw new UpdateError(`API "${apiId}" desconhecida.`);
    let text = body;
    if (Buffer.isBuffer(body)) {
      try {
        text = body[0] === 0x1f && body[1] === 0x8b ? zlib.gunzipSync(body).toString('utf8') : body.toString('utf8');
      } catch {
        throw new UpdateError('Não foi possível descompactar o conteúdo enviado.');
      }
    }
    const spec = tryParseSpec(String(text || ''));
    if (!spec) throw new UpdateError('O conteúdo enviado não é um JSON OpenAPI válido (precisa ter "openapi" ou "swagger").');
    let validUrl;
    try {
      validUrl = url ? new URL(url).href : undefined;
    } catch {
      validUrl = undefined;
    }
    return processCandidate(apiId, { spec, text: String(text) }, { aplicar, origem: origem || 'arquivo enviado', url: validUrl });
  });
}

/** Volta para uma versão anterior (a atual também fica guardada, então dá para desfazer). */
export function restoreBackup(apiId, arquivo) {
  return exclusive(apiId, async () => {
    const store = await writableStore();
    const text = await store.readBackup(apiId, arquivo);
    if (text == null) throw new UpdateError(`Versão "${arquivo}" não encontrada.`);
    const spec = tryParseSpec(text);
    if (!spec) throw new UpdateError('A versão guardada não contém um JSON OpenAPI válido.');
    return processCandidate(apiId, { spec, text }, { aplicar: true, origem: `restaurada: ${arquivo}` });
  });
}

export async function listBackups(apiId) {
  const store = await getStore();
  return store ? store.listBackups(apiId) : [];
}

/** Verificação periódica pelo servidor (SPEC_AUTO_UPDATE_MINUTES). Erros só vão para o log. */
export function startAutoUpdate(minutes, log = console.error) {
  if (!(minutes > 0)) return null;
  const run = async () => {
    for (const apiId of Object.keys(SPEC_SOURCES)) {
      try {
        const r = await updateFromUrl(apiId, { aplicar: true });
        if (r.status !== 'sem-mudancas') log(`[spec] ${apiId}: ${r.mensagem}`);
      } catch (e) {
        log(`[spec] ${apiId}: falha na atualização automática — ${e.message}${e.dica ? ` (${e.dica})` : ''}`);
      }
    }
  };
  const first = setTimeout(run, 5000);
  const timer = setInterval(run, minutes * 60_000);
  first.unref?.();
  timer.unref?.();
  log(`[spec] atualização automática a cada ${minutes} min`);
  return { stop: () => (clearTimeout(first), clearInterval(timer)) };
}
