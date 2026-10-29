import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Carrega o .env da raiz do projeto (se existir) sem dependência extra. Variáveis já
// definidas no ambiente têm prioridade.
const envFile = path.join(ROOT_DIR, '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(envFile);
  } catch (e) {
    console.error(`[config] não foi possível ler .env: ${e.message}`);
  }
}

/**
 * Pasta com os arquivos OpenAPI (*.json). Resolvida a partir da raiz do projeto,
 * e não do cwd, porque o processo pode ser iniciado de qualquer pasta.
 */
export const SPECS_DIR = process.env.SPECS_DIR ? path.resolve(process.env.SPECS_DIR) : path.join(ROOT_DIR, 'specs');

/** Backups das versões anteriores e o registro das atualizações (não aparece como API). */
export const HISTORY_DIR = path.join(SPECS_DIR, '.historico');

// Plataformas (Render, Railway, Fly, Azure...) informam a porta em PORT e exigem ouvir em 0.0.0.0.
export const HTTP_PORT = Number(process.env.PORT || process.env.MCP_PORT || 3001);
export const HTTP_HOST = process.env.MCP_HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');

export const MAX_RESPONSE_CHARS = Number(process.env.MCP_MAX_RESPONSE_CHARS || 16000);
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 50;
export const MAX_SEARCH_MATCHES_PER_API = 5;

export const SERVER_NAME = 'mcp-rhnet';
export const SERVER_VERSION = '2.2.0';

// ---------------------------------------------------------------------------
// Atualização da spec
// ---------------------------------------------------------------------------

/** Link do JSON da spec do RH Net (só abre na VPN). A página abre este link. */
export const RHNET_SPEC_URL = process.env.RHNET_SPEC_URL || 'https://api-rhnet-hml.sci.com.br/docs?api-docs.json';

/** APIs que podem ser atualizadas pela página. */
export const UPDATABLE_APIS = ['rhnet'];

/** Quantas versões anteriores manter para restaurar. */
export const SPEC_HISTORY_LIMIT = Math.max(1, Number(process.env.SPEC_HISTORY_LIMIT || 10));

/** Com Vercel Blob: de quanto em quanto tempo cada instância confere se há versão nova. */
export const SPEC_SYNC_SECONDS = Number(process.env.SPEC_SYNC_SECONDS || 15);
