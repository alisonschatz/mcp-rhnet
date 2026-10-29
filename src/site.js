import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { SERVER_VERSION, UPDATABLE_APIS } from './config.js';
import { compareApis, compareOperation } from './compare.js';
import { findOperation } from './openapi.js';
import { loadSpec } from './specs.js';
import { ensureFresh, restoreBackup, specStatus, updateFromText, updateFromUrl, UpdateError } from './updater.js';

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

/** "POST /api/v1/x" → { metodo, path, resumo, tag } para a página mostrar. */
function detalharOps(lista, ...specs) {
  return lista.map((chave) => {
    const [metodo, ...resto] = chave.split(' ');
    const path = resto.join(' ');
    const op = specs.map((s) => findOperation(s, metodo, path)).find(Boolean);
    return { metodo, path, resumo: op?.operation.summary || '', tag: op?.operation.tags?.[0] || '' };
  });
}

function specOf(apiId) {
  if (!UPDATABLE_APIS.includes(apiId)) throw new UpdateError(`API "${apiId}" desconhecida.`);
  const { spec } = loadSpec(apiId);
  if (!spec) throw new UpdateError(`A spec de "${apiId}" ainda não foi carregada.`);
  return spec;
}

/**
 * Página principal (/) e a API usada por ela:
 * - GET  /api/status                 os ambientes, com versão em uso e histórico
 * - POST /api/:apiId/enviar          envia o arquivo JSON da spec
 * - POST /api/:apiId/atualizar       o servidor baixa a spec (ambientes com spec pública)
 * - POST /api/:apiId/restaurar       volta para uma versão anterior
 * - GET  /api/comparar?a=&b=         diferenças entre dois ambientes
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
      const specA = specOf(a);
      const specB = specOf(b);
      if (req.query.method && req.query.path) {
        return compareOperation(specA, specB, String(req.query.method), String(req.query.path), { incluirDescricoes: req.query.descricoes === '1' });
      }
      const r = compareApis(specA, specB);
      return {
        a,
        b,
        totalDiferencas: r.totalDiferencas,
        operacoes: {
          soEmA: detalharOps(r.operacoes.soEmA, specA),
          soEmB: detalharOps(r.operacoes.soEmB, specB),
          diferentes: detalharOps(r.operacoes.diferentes, specA, specB),
          soTextos: detalharOps(r.operacoes.soTextos, specA, specB),
        },
        schemas: { soEmA: r.schemas.soEmA.length, soEmB: r.schemas.soEmB.length, diferentes: r.schemas.diferentes.length },
      };
    })
  );
  return app;
}
