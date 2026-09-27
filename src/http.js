import express from 'express';
import { AUTH_TOKEN, HTTP_HOST, HTTP_PORT, SPECS_DIR } from './config.js';
import { listApiIds } from './specs.js';
import { mountMcpRoutes } from './web.js';

// Servidor HTTP de longa duração: uso local, Docker, Render, Railway, Azure App Service etc.
const app = mountMcpRoutes(express());

app.listen(HTTP_PORT, HTTP_HOST, () => {
  console.log(`[mcp] ouvindo em http://${HTTP_HOST}:${HTTP_PORT}/mcp (specs: ${SPECS_DIR}, ${listApiIds().length} APIs, token: ${AUTH_TOKEN ? 'sim' : 'não'})`);
});
