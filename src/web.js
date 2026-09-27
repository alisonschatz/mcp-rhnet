import crypto from 'node:crypto';
import cors from 'cors';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ALLOW_ANONYMOUS, AUTH_TOKEN, IS_HOSTED } from './config.js';
import { buildMcpServer } from './mcp.js';
import { listApiIds } from './specs.js';

const jsonRpcError = (res, status, code, message) => res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });

const sha = (v) => crypto.createHash('sha256').update(String(v)).digest();
const tokenMatches = (provided) => Boolean(provided) && crypto.timingSafeEqual(sha(provided), sha(AUTH_TOKEN));

function requireToken(req, res, next) {
  if (!AUTH_TOKEN) {
    if (IS_HOSTED && !ALLOW_ANONYMOUS) {
      return jsonRpcError(res, 503, -32001, 'Servidor sem MCP_AUTH_TOKEN configurado. Defina o token (ou MCP_ALLOW_ANONYMOUS=1 para acesso aberto).');
    }
    return next();
  }
  const header = req.get('authorization') || '';
  const bearer = /^Bearer\s+(.+)$/i.exec(header)?.[1];
  if (tokenMatches(bearer) || tokenMatches(req.query?.token)) return next();
  return jsonRpcError(res, 401, -32001, 'Não autorizado: envie Authorization: Bearer <token> ou ?token=<token>.');
}

/** Registra as rotas do MCP em um app Express (usado pelo servidor local e pela Vercel). */
export function mountMcpRoutes(app) {
  app.use(
    cors({
      origin: '*',
      allowedHeaders: ['Content-Type', 'Accept', 'Authorization', 'Mcp-Session-Id', 'Mcp-Protocol-Version'],
      exposedHeaders: ['Mcp-Session-Id'],
    })
  );
  app.use(express.json({ limit: '2mb' }));

  // Modo stateless: um servidor + transporte por requisição.
  app.post('/mcp', requireToken, async (req, res) => {
    try {
      const server = buildMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('[mcp] erro ao processar requisição:', error);
      if (!res.headersSent) jsonRpcError(res, 500, -32603, 'Erro interno do servidor MCP.');
    }
  });

  const methodNotAllowed = (_req, res) => jsonRpcError(res, 405, -32000, 'Method not allowed. Servidor MCP em modo stateless.');
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  app.get('/mcp/health', (_req, res) => res.json({ status: 'ok', apis: listApiIds().length, autenticacao: Boolean(AUTH_TOKEN) }));
  app.get('/', (_req, res) => res.json({ servico: 'mcp-apis-time', endpoint: '/mcp', health: '/mcp/health' }));

  app.use((err, _req, res, _next) => {
    console.error('[mcp] erro não tratado:', err);
    if (!res.headersSent) jsonRpcError(res, err.status || 500, -32603, err.type === 'entity.parse.failed' ? 'JSON inválido.' : 'Erro interno.');
  });
  return app;
}
