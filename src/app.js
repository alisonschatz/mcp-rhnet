import express from 'express';
import siteFiles from './site.bundle.js';
import bundle from './specs.bundle.js';
import { useBundledSpecs } from './specs.js';
import { mountMcpRoutes } from './web.js';

// Entrypoint da Vercel (detectado automaticamente: src/app.js com export default de um app Express).
// specs.bundle.js e site.bundle.js são gerados por "npm run build".
// A spec do build é o ponto de partida; as atualizações feitas pela página ficam no Vercel Blob.
useBundledSpecs(bundle);

export default mountMcpRoutes(express(), { siteFiles });
