import express from 'express';
import { HTTP_HOST, HTTP_PORT, SPECS_DIR } from './config.js';
import { listApiIds } from './specs.js';
import { mountMcpRoutes } from './web.js';

// Servidor local para desenvolvimento (npm start). Sem Vercel Blob, a spec enviada fica em specs/.
const app = mountMcpRoutes(express());

app.listen(HTTP_PORT, HTTP_HOST, () => {
  const base = `http://${HTTP_HOST === '0.0.0.0' ? 'localhost' : HTTP_HOST}:${HTTP_PORT}`;
  console.log(`[mcp] página: ${base}  ·  conector: ${base}/mcp  (specs: ${SPECS_DIR}, ${listApiIds().length} API(s))`);
});
