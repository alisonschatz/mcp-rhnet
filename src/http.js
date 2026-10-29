import express from 'express';
import { ADMIN_ENABLED, ADMIN_TOKEN, HTTP_HOST, HTTP_PORT, SPEC_AUTO_UPDATE_MINUTES, SPECS_DIR } from './config.js';
import { mountAdminRoutes } from './admin.js';
import { listApiIds } from './specs.js';
import { startAutoUpdate } from './updater.js';
import { mountMcpRoutes } from './web.js';

// Servidor HTTP de longa duração: uso local, Docker, Render, Railway, Azure App Service etc.
const app = mountMcpRoutes(express(), { extraRoutes: ADMIN_ENABLED ? (a) => mountAdminRoutes(a) : undefined });

app.listen(HTTP_PORT, HTTP_HOST, () => {
  const base = `http://${HTTP_HOST === '0.0.0.0' ? 'localhost' : HTTP_HOST}:${HTTP_PORT}`;
  console.log(`[mcp] ouvindo em ${base}/mcp (specs: ${SPECS_DIR}, ${listApiIds().length} API(s))`);
  if (ADMIN_ENABLED) console.log(`[mcp] tela de atualização da spec: ${base}/admin${ADMIN_TOKEN ? ' (protegida por ADMIN_TOKEN)' : ''}`);
  else console.log('[mcp] tela /admin desligada (host público sem ADMIN_TOKEN)');
  startAutoUpdate(SPEC_AUTO_UPDATE_MINUTES, console.log);
});
