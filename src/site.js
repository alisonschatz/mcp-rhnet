import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { APIS, SERVER_VERSION, UPDATABLE_APIS } from './config.js';
import { diffOperacao, diffSpecs, semItens } from './compare.js';
import { loadSpec } from './specs.js';
import { summarize } from './spec-diff.js';
import { ensureFresh, previousSpec, restoreBackup, specStatus, updateFromText, updateFromUrl, UpdateError } from './updater.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const readLocal = (name) => fs.readFileSync(path.join(DIR, name), 'utf8');

/** Nome do arquivo enviado, só para o histórico. */
function nomeArquivo(v) {
  try {
    const nome = decodeURIComponent(v || '').replace(/[^\w .()\-À-ÿ]/g, '').slice(0, 80);
    return nome || 'arquivo';
  } catch {
    return 'arquivo';
  }
}

/**
 * Diferenças entre duas specs para a página: resumo + operações (sem os itens) ou,
 * com method+path, a operação com todos os itens (categoria, impacto, antes → depois).
 */
function comparacao(specA, specB, query) {
  if (query.method && query.path) {
    return diffOperacao(specA, specB, String(query.method), String(query.path)) || { erro: 'Operação não encontrada.' };
  }
  const d = diffSpecs(specA, specB);
  return { resumo: d.resumo, operacoes: d.operacoes.map(semItens) };
}

function specOf(apiId) {
  if (!UPDATABLE_APIS.includes(apiId)) throw new UpdateError(`API "${apiId}" desconhecida.`);
  const { spec } = loadSpec(apiId);
  if (!spec) {
    const { nome, modo } = APIS[apiId];
    throw new UpdateError(modo === 'manual' ? `Envie a spec de ${nome.toLowerCase()} para comparar.` : `A spec de ${nome.toLowerCase()} ainda não foi baixada.`);
  }
  return spec;
}

/**
 * Página principal (/) e a API usada por ela:
 * - GET  /api/status                 os ambientes, com versão em uso e histórico
 * - POST /api/:apiId/enviar          envia o arquivo JSON da spec
 * - POST /api/:apiId/atualizar       o servidor baixa a spec (ambientes com spec pública)
 * - POST /api/:apiId/restaurar       volta para uma versão anterior
 * - GET  /api/comparar?a=&b=         diferenças entre dois ambientes
 * - GET  /api/:apiId/mudancas        o que mudou da versão anterior para a atual
 *   (as duas aceitam &method=&path= para o detalhe campo a campo de uma operação)
 * `files` vem do bundle na Vercel; localmente a página é lida do disco.
 */
export function mountSiteRoutes(app, { files } = {}) {
  const page = () => files?.page ?? readLocal('site.html');

  const handle = (fn) => async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store').json(await fn(req));
    } catch (e) {
      const known = e instanceof UpdateError;
      if (!known) console.error('[site] erro:', e);
      res.status(known ? 400 : 500).json({ erro: known ? e.message : 'Erro interno.' });
    }
  };

  app.get('/', (_req, res) => res.set('Cache-Control', 'no-store').type('html').send(page()));

  app.get(
    '/api/status',
    handle(async () => {
      await ensureFresh();
      return { versaoServidor: SERVER_VERSION, apis: await Promise.all(UPDATABLE_APIS.map((id) => specStatus(id))) };
    })
  );
  // Corpo binário (gzip ou texto) para não esbarrar no limite do parser JSON do /mcp.
  app.post(
    '/api/:apiId/enviar',
    express.raw({ type: () => true, limit: '25mb' }),
    handle(async (req) => updateFromText(req.params.apiId, req.body, { origem: nomeArquivo(req.get('x-arquivo')) }))
  );
  app.post('/api/:apiId/atualizar', handle(async (req) => updateFromUrl(req.params.apiId, { origem: 'manual' })));
  app.post('/api/:apiId/restaurar', handle(async (req) => restoreBackup(req.params.apiId, String(req.body?.arquivo || ''))));
  app.get(
    '/api/comparar',
    handle(async (req) => {
      await ensureFresh();
      const [a, b] = [String(req.query.a || ''), String(req.query.b || '')];
      return { a, b, ...comparacao(specOf(a), specOf(b), req.query) };
    })
  );
  app.get(
    '/api/:apiId/mudancas',
    handle(async (req) => {
      await ensureFresh();
      const atual = specOf(req.params.apiId);
      const anterior = await previousSpec(req.params.apiId);
      if (!anterior) return { semAnterior: true };
      const resumo = (s) => ({ operacoes: summarize(s, '').operacoes, schemas: summarize(s, '').schemas });
      return {
        anterior: { salvoEm: anterior.salvoEm, arquivo: anterior.arquivo, ...resumo(anterior.spec) },
        atual: resumo(atual),
        ...comparacao(anterior.spec, atual, req.query),
      };
    })
  );
  return app;
}
