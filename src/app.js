import express from 'express';
import bundle from './specs.bundle.js';
import { useBundledSpecs } from './specs.js';
import { mountMcpRoutes } from './web.js';

// Entrypoint da Vercel (detectado automaticamente: src/app.js com export default de um app Express).
// specs.bundle.js é gerado por "npm run build" a partir da pasta specs/.
useBundledSpecs(bundle);

const app = mountMcpRoutes(express());
export default app;
