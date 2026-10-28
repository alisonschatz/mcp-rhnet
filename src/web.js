import cors from 'cors';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SERVER_NAME, SERVER_VERSION } from './config.js';
import { buildMcpServer } from './mcp.js';
import { listApiIds } from './specs.js';

const jsonRpcError = (res, status, code, message) => res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });

/**
 * Registra as rotas do MCP em um app Express (usado pelo servidor local e pela Vercel).
 * O endpoint /mcp é público: não há token nem outra autenticação.
 */
export function mountMcpRoutes(app) {
  app.disable('x-powered-by');
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

  app.get('/mcp/health', (_req, res) => res.json({ status: 'ok', versao: SERVER_VERSION, apis: listApiIds().length }));
  app.get('/', (_req, res) => res.json({ servico: SERVER_NAME, endpoint: '/mcp', health: '/mcp/health' }));

  app.use((err, _req, res, _next) => {
    console.error('[mcp] erro não tratado:', err);
    if (!res.headersSent) jsonRpcError(res, err.status || 500, err.type === 'entity.parse.failed' ? -32700 : -32603, err.type === 'entity.parse.failed' ? 'JSON inválido.' : 'Erro interno.');
  });
  return app;
}
