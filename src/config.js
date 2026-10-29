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

/** Versão anterior e registro da última mudança (não aparece como API). */
export const HISTORY_DIR = path.join(SPECS_DIR, '.historico');

// Plataformas (Render, Railway, Fly, Azure...) informam a porta em PORT e exigem ouvir em 0.0.0.0.
export const HTTP_PORT = Number(process.env.PORT || process.env.MCP_PORT || 3001);
export const HTTP_HOST = process.env.MCP_HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');

export const MAX_RESPONSE_CHARS = Number(process.env.MCP_MAX_RESPONSE_CHARS || 16000);
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 50;
export const MAX_SEARCH_MATCHES_PER_API = 5;

export const SERVER_NAME = 'mcp-rhnet';
export const SERVER_VERSION = '2.6.0';

// ---------------------------------------------------------------------------
// Atualização da spec
// ---------------------------------------------------------------------------

/**
 * Ambientes do RH Net. Cada um vira uma API no MCP (o id é o apiId usado pela IA).
 * - manual: a spec só abre na VPN, então é enviada pela página (arquivo JSON).
 * - automatico: a spec é pública; o servidor baixa sozinho de tempos em tempos.
 */
export const APIS = {
  'rhnet-hml': {
    nome: 'Homologação',
    specUrl: process.env.RHNET_HML_SPEC_URL || 'https://api-rhnet-hml.sci.com.br/docs?api-docs.json',
    modo: 'manual',
  },
  'rhnet-prd': {
    nome: 'Produção',
    specUrl: process.env.RHNET_PRD_SPEC_URL || 'https://api2.rhnetsocial.com.br/docs?api-docs.json',
    modo: 'automatico',
  },
};

/** APIs que podem ser atualizadas pela página. */
export const UPDATABLE_APIS = Object.keys(APIS);

/** De quanto em quanto tempo (minutos) as APIs automáticas são conferidas. 0 desliga. */
export const SPEC_AUTO_UPDATE_MINUTES = Number(process.env.SPEC_AUTO_UPDATE_MINUTES ?? 60);
export const SPEC_FETCH_TIMEOUT_MS = Number(process.env.SPEC_FETCH_TIMEOUT_MS || 20000);

/** Com Vercel Blob: de quanto em quanto tempo cada instância confere se há versão nova. */
export const SPEC_SYNC_SECONDS = Number(process.env.SPEC_SYNC_SECONDS || 15);
