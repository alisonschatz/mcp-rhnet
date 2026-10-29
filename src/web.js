import cors from 'cors';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildMcpServer } from './mcp.js';
import { mountSiteRoutes } from './site.js';
import { syncSpecs } from './store/index.js';

const jsonRpcError = (res, status, code, message) => res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });

/**
 * Monta o app (Vercel e servidor local):
 * - /mcp         endpoint MCP (público, stateless)
 * - /            página para atualizar a spec
 * - /api/...     usada pela página
 * `siteFiles` traz a página empacotada (Vercel); localmente ela é lida do disco.
 */
export function mountMcpRoutes(app, { siteFiles } = {}) {
  app.disable('x-powered-by');
  // Vercel Blob conectado via OIDC (variável BLOB_STORE_ID): a Vercel manda o token OIDC em cada
  // requisição. Guardamos para o SDK do Blob usar mesmo fora do contexto da requisição.
  app.use((req, _res, next) => {
    const oidc = req.headers['x-vercel-oidc-token'];
    if (typeof oidc === 'string' && oidc) process.env.VERCEL_OIDC_TOKEN = oidc;
    next();
  });
  app.use(
    cors({
      origin: '*',
      allowedHeaders: ['Content-Type', 'Accept', 'Mcp-Session-Id', 'Mcp-Protocol-Version', 'Last-Event-ID'],
      exposedHeaders: ['Mcp-Session-Id', 'Mcp-Protocol-Version'],
    })
  );
  app.use(express.json({ limit: '2mb' }));

  // Modo stateless: um servidor + transporte por requisição.
  app.post('/mcp', async (req, res) => {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await syncSpecs(); // com Vercel Blob, pega a versão mais recente da spec
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('[mcp] erro ao processar requisição:', error);
      if (!res.headersSent) jsonRpcError(res, 500, -32603, 'Erro interno do servidor MCP.');
    }
  });

  const methodNotAllowed = (_req, res) => res.set('Allow', 'POST').status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. Servidor MCP em modo stateless: use POST.' }, id: null });
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  mountSiteRoutes(app, { files: siteFiles });

  app.use((err, _req, res, _next) => {
    console.error('[mcp] erro não tratado:', err);
    if (!res.headersSent) jsonRpcError(res, err.status || 500, err.type === 'entity.parse.failed' ? -32700 : -32603, err.type === 'entity.parse.failed' ? 'JSON inválido.' : 'Erro interno.');
  });
  return app;
}
