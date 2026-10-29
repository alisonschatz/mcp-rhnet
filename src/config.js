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
 * e não do cwd, porque clientes MCP via stdio (Claude Desktop, VS Code, Cursor)
 * iniciam o processo em diretórios arbitrários.
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
export const SERVER_VERSION = '2.0.0';

// ---------------------------------------------------------------------------
// Atualização automática da spec
// ---------------------------------------------------------------------------

function parseHeaders(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    console.error('[config] RHNET_SPEC_HEADERS não é um JSON válido; ignorado.');
    return {};
  }
}

/**
 * De onde cada API é baixada. Hoje só o RH Net (exige VPN).
 * A URL pode apontar direto para o JSON ou para a página do Swagger UI: nesse caso
 * o atualizador procura o link do JSON dentro da página.
 */
export const SPEC_SOURCES = {
  rhnet: {
    url: process.env.RHNET_SPEC_URL || 'https://api-rhnet-hml.sci.com.br/docs?api-docs.json',
    urlFromEnv: Boolean(process.env.RHNET_SPEC_URL),
    headers: {
      ...(process.env.RHNET_SPEC_TOKEN ? { Authorization: `Bearer ${process.env.RHNET_SPEC_TOKEN}` } : {}),
      ...(process.env.RHNET_SPEC_COOKIE ? { Cookie: process.env.RHNET_SPEC_COOKIE } : {}),
      ...parseHeaders(process.env.RHNET_SPEC_HEADERS),
    },
  },
};

/** Intervalo da verificação automática em minutos (0 = desligada). */
export const SPEC_AUTO_UPDATE_MINUTES = Number(process.env.SPEC_AUTO_UPDATE_MINUTES || 0);
export const SPEC_HISTORY_LIMIT = Math.max(1, Number(process.env.SPEC_HISTORY_LIMIT || 10));
export const SPEC_FETCH_TIMEOUT_MS = Number(process.env.SPEC_FETCH_TIMEOUT_MS || 60000);
/** Com Vercel Blob: de quanto em quanto tempo cada instância confere se há versão nova. */
export const SPEC_SYNC_SECONDS = Number(process.env.SPEC_SYNC_SECONDS || 15);

/**
 * Quem baixa a spec quando se clica em "Atualizar":
 * - "navegador": a página baixa usando a rede de quem está usando (a VPN do seu computador)
 *   e envia ao servidor. Padrão na Vercel, que não alcança a VPN.
 * - "servidor": o próprio servidor baixa. Padrão local/Docker em rede interna.
 */
export const SPEC_FETCH_MODE = process.env.SPEC_FETCH_MODE || (process.env.VERCEL ? 'navegador' : 'servidor');

/**
 * Tela /admin. Com ADMIN_TOKEN ela fica sempre ligada (exige o token). Sem token, só
 * quando o servidor ouve apenas na máquina local. Na Vercel/host público sem token,
 * a tela aparece só com a instrução de configurar o token.
 */
export const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const LOCAL_ONLY = !process.env.VERCEL && ['127.0.0.1', 'localhost', '::1'].includes(HTTP_HOST);
export const ADMIN_ENABLED = process.env.ADMIN_ENABLED === '0' ? false : Boolean(ADMIN_TOKEN) || LOCAL_ONLY;
