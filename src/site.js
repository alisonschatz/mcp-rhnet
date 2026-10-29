import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { RHNET_SPEC_URL } from './config.js';
import { syncSpecs } from './store/index.js';
import { restoreBackup, specStatus, updateFromText, UpdateError } from './updater.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const readLocal = (name) => fs.readFileSync(path.join(DIR, name), 'utf8');

/**
 * Página principal (/) para atualizar a spec enviando o arquivo JSON, e a API usada por ela.
 * `files` vem do bundle na Vercel; localmente a página é lida do disco.
 */
/** Nome do arquivo enviado, só para o histórico. */
function nomeArquivo(v) {
  try {
    const nome = decodeURIComponent(v || '').replace(/[^\w .()\-À-ÿ]/g, '').slice(0, 80);
    return nome || 'arquivo';
  } catch {
    return 'arquivo';
  }
}

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
    '/api/:apiId/status',
    handle(async (req) => {
      await syncSpecs({ force: true });
      return { ...(await specStatus(req.params.apiId)), specUrl: RHNET_SPEC_URL };
    })
  );
  // Corpo binário (gzip ou texto) para não esbarrar no limite do parser JSON do /mcp.
  app.post(
    '/api/:apiId/enviar',
    express.raw({ type: () => true, limit: '25mb' }),
    handle(async (req) => updateFromText(req.params.apiId, req.body, { origem: nomeArquivo(req.get('x-arquivo')) }))
  );
  app.post('/api/:apiId/restaurar', handle(async (req) => restoreBackup(req.params.apiId, String(req.body?.arquivo || ''))));
  return app;
}
