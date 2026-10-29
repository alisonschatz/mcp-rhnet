import express from 'express';
import adminPage from './admin-page.bundle.js';
import { mountAdminRoutes } from './admin.js';
import { ADMIN_TOKEN } from './config.js';
import bundle from './specs.bundle.js';
import { useBundledSpecs } from './specs.js';
import { mountMcpRoutes } from './web.js';

// Entrypoint da Vercel (detectado automaticamente: src/app.js com export default de um app Express).
// specs.bundle.js e admin-page.bundle.js são gerados por "npm run build".
// A spec do build é o ponto de partida; as atualizações feitas em /admin ficam no Vercel Blob.
useBundledSpecs(bundle);

const app = mountMcpRoutes(express(), {
  extraRoutes: (a) => {
    if (ADMIN_TOKEN) return mountAdminRoutes(a, { html: adminPage });
    a.get('/admin', (_req, res) =>
      res
        .status(503)
        .type('html')
        .send('<meta charset="utf-8"><p style="font:16px system-ui;padding:24px">A tela de atualização está desligada: defina a variável <code>ADMIN_TOKEN</code> no projeto da Vercel e faça um redeploy.</p>')
    );
  },
});
export default app;
