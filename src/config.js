import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Pasta com os arquivos OpenAPI (*.json). Resolvida a partir da raiz do projeto,
 * e não do cwd, porque clientes MCP via stdio (Claude Desktop, VS Code, Cursor)
 * iniciam o processo em diretórios arbitrários.
 */
export const SPECS_DIR = process.env.SPECS_DIR ? path.resolve(process.env.SPECS_DIR) : path.join(ROOT_DIR, 'specs');

// Plataformas (Render, Railway, Fly, Azure...) informam a porta em PORT e exigem ouvir em 0.0.0.0.
export const HTTP_PORT = Number(process.env.PORT || process.env.MCP_PORT || 3001);
export const HTTP_HOST = process.env.MCP_HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');

export const MAX_RESPONSE_CHARS = Number(process.env.MCP_MAX_RESPONSE_CHARS || 16000);
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 50;
export const MAX_SEARCH_MATCHES_PER_API = 5;

export const SERVER_NAME = 'apis-time-testes';
export const SERVER_VERSION = '1.1.0';
