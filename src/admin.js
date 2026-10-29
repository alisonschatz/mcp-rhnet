import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { ADMIN_TOKEN, SPEC_AUTO_UPDATE_MINUTES, SPEC_SOURCES } from './config.js';
import { syncSpecs } from './store/index.js';
import { restoreBackup, specStatus, updateFromText, updateFromUrl, UpdateError } from './updater.js';

const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'admin.html');

function safeDecode(v) {
  if (!v) return undefined;
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

function sameToken(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Tela /admin: ver a versão atual, conferir se há versão nova e atualizar com um clique.
 * - html: conteúdo da página (na Vercel vem do bundle gerado no build).
 * - token: quando definido, toda chamada da API da tela exige o cabeçalho x-admin-token.
 */
export function mountAdminRoutes(app, { token = ADMIN_TOKEN, html } = {}) {
  const router = express.Router();
  const page = () => html ?? fs.readFileSync(PAGE, 'utf8');

  router.use('/api', (req, res, next) => {
    if (!token) return next();
    const given = req.get('x-admin-token') || '';
    if (given && sameToken(given, token)) return next();
    res.status(401).json({ erro: given ? 'Token inválido.' : 'Informe o token de administração.', precisaToken: true });
  });

  const apiIdOf = (req) => {
    const id = req.params.apiId;
    if (!SPEC_SOURCES[id]) throw new UpdateError(`API "${id}" não tem fonte de atualização configurada.`);
    return id;
  };

  const handle = (fn) => async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (e) {
      const known = e instanceof UpdateError;
      if (!known) console.error('[admin] erro:', e);
      res.status(known ? 400 : 500).json({ erro: e.message, dica: e.dica || null });
    }
  };

  router.get('/', (_req, res) => res.set('Cache-Control', 'no-store').type('html').send(page()));

  router.get(
    '/api/status',
    handle(async () => {
      await syncSpecs({ force: true });
      return {
        autoAtualizacaoMinutos: SPEC_AUTO_UPDATE_MINUTES,
        protegida: Boolean(token),
        apis: await Promise.all(Object.keys(SPEC_SOURCES).map((id) => specStatus(id))),
      };
    })
  );

  // O servidor baixa (local/Docker com acesso à rede interna).
  router.post('/api/:apiId/verificar', handle(async (req) => updateFromUrl(apiIdOf(req), { aplicar: false, url: req.body?.url })));
  router.post('/api/:apiId/atualizar', handle(async (req) => updateFromUrl(apiIdOf(req), { aplicar: true, url: req.body?.url })));

  // O navegador baixou (ou o usuário escolheu um arquivo) e envia o conteúdo, de preferência em gzip.
  // Corpo binário para não esbarrar no limite do parser JSON do /mcp.
  router.post(
    '/api/:apiId/enviar',
    express.raw({ type: () => true, limit: '25mb' }),
    handle(async (req) =>
      updateFromText(apiIdOf(req), req.body, {
        aplicar: req.query.aplicar !== '0',
        origem: safeDecode(req.get('x-origem')),
        url: safeDecode(req.get('x-url')),
      })
    )
  );

  router.post('/api/:apiId/restaurar', handle(async (req) => restoreBackup(apiIdOf(req), String(req.body?.arquivo || ''))));

  app.use('/admin', router);
  return app;
}
