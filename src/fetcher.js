import { SPEC_FETCH_TIMEOUT_MS } from './config.js';

/**
 * Download da spec pelo servidor (quando ele alcança a rede da API: máquina local
 * com VPN ou servidor interno). Na Vercel quem baixa é o navegador (ver admin.html).
 */

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

export class UpdateError extends Error {
  constructor(message, dica) {
    super(message);
    this.dica = dica;
  }
}

const AUTH_HINT =
  'A URL pediu login. Informe um acesso no .env (RHNET_SPEC_TOKEN, RHNET_SPEC_COOKIE ou RHNET_SPEC_HEADERS), aponte RHNET_SPEC_URL direto para o JSON público da documentação, ou use "Enviar arquivo".';

function networkHint(error) {
  const code = error?.cause?.code || error?.code || '';
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT/.test(code) || error?.name === 'TimeoutError') {
    return 'Não foi possível alcançar o servidor. Confira se a VPN (Pritunl) está conectada e se a URL está correta.';
  }
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(code)) {
    return 'O certificado HTTPS não foi reconhecido pelo Node. Rode com NODE_OPTIONS=--use-system-ca (Node 22.15+) ou aponte NODE_EXTRA_CA_CERTS para o certificado da CA interna.';
  }
  return null;
}

async function httpGet(url, headers) {
  let res;
  try {
    res = await fetch(url, {
      headers: { Accept: 'application/json, text/html;q=0.9, */*;q=0.8', 'User-Agent': 'mcp-rhnet-updater', ...headers },
      redirect: 'follow',
      signal: AbortSignal.timeout(SPEC_FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    throw new UpdateError(`Falha ao acessar ${url}: ${e.cause?.message || e.message}`, networkHint(e));
  }
  const text = await res.text();
  if (res.status === 401 || res.status === 403 || /erro\.php\?erro=40[13]/.test(res.url)) {
    throw new UpdateError(`Acesso negado (${res.status === 200 ? '401' : res.status}) em ${res.url}.`, AUTH_HINT);
  }
  if (!res.ok) throw new UpdateError(`O servidor respondeu ${res.status} ${res.statusText} em ${res.url}.`);
  return { text, finalUrl: res.url, contentType: res.headers.get('content-type') || '' };
}

export function tryParseSpec(text) {
  const trimmed = text.replace(/^﻿/, '').trimStart();
  if (!trimmed.startsWith('{')) return null;
  try {
    const spec = JSON.parse(trimmed);
    return spec && (spec.openapi || spec.swagger) ? spec : null;
  } catch {
    return null;
  }
}

/** Procura links de JSON OpenAPI dentro de uma página do Swagger UI / Redoc / l5-swagger. */
export function findSpecLinks(html, baseUrl) {
  const found = new Set();
  const patterns = [
    /\burl\s*[:=]\s*["'`]([^"'`\s]+)["'`]/g, // SwaggerUIBundle({ url: "..." })
    /["']url["']\s*:\s*["']([^"'\s]+)["']/g, // configUrl / urls: [{ "url": "..." }]
    /spec-url=["']([^"'\s]+)["']/g, // <redoc spec-url="...">
    /["'`]([^"'`\s<>]*(?:api-docs|openapi|swagger)[^"'`\s<>]*\.json[^"'`\s<>]*)["'`]/gi,
    /["'`]([^"'`\s<>]*\?[^"'`\s<>]*api-docs[^"'`\s<>]*)["'`]/gi, // l5-swagger: /docs?api-docs.json
  ];
  for (const re of patterns) {
    for (const m of html.matchAll(re)) {
      const raw = m[1].replace(/\\\//g, '/');
      if (/\.(js|css|png|svg|ico|html?)(\?|$)/i.test(raw)) continue;
      try {
        found.add(new URL(raw, baseUrl).href);
      } catch {
        /* ignora */
      }
    }
  }
  return [...found];
}

function scriptSources(html, baseUrl) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
    if (/initializer|swagger-config|config/i.test(m[1])) {
      try {
        out.push(new URL(m[1], baseUrl).href);
      } catch {
        /* ignora */
      }
    }
  }
  return out;
}

/** Baixa a spec. Aceita URL do JSON ou da página da documentação (Swagger UI). */
export async function downloadSpec(url, headers = {}) {
  const first = await httpGet(url, headers);
  const direct = tryParseSpec(first.text);
  if (direct) return { spec: direct, text: first.text, urlFinal: first.finalUrl };

  // Caiu numa tela de login (ex.: SCI WEB): não adianta procurar o JSON nela.
  if (/<input[^>]+type=["']?password/i.test(first.text)) {
    throw new UpdateError(`A URL redirecionou para uma tela de login (${first.finalUrl}).`, AUTH_HINT);
  }

  // Página HTML: procura o link do JSON nela e nos scripts de configuração do Swagger UI.
  const candidates = findSpecLinks(first.text, first.finalUrl);
  for (const src of scriptSources(first.text, first.finalUrl).slice(0, 3)) {
    try {
      const js = await httpGet(src, headers);
      candidates.push(...findSpecLinks(js.text, src));
    } catch {
      /* ignora */
    }
  }
  const tried = [];
  for (const candidate of [...new Set(candidates)].slice(0, 6)) {
    tried.push(candidate);
    try {
      const r = await httpGet(candidate, headers);
      const spec = tryParseSpec(r.text);
      if (spec) return { spec, text: r.text, urlFinal: r.finalUrl, descobertaEm: url };
    } catch (e) {
      if (e instanceof UpdateError && /Acesso negado/.test(e.message)) throw e;
    }
  }
  const isHtml = /html/i.test(first.contentType) || /^\s*</.test(first.text);
  throw new UpdateError(
    isHtml
      ? `A URL devolveu uma página HTML, não o JSON da spec${tried.length ? ` (links testados: ${tried.join(', ')})` : ''}.`
      : 'A resposta não é um JSON OpenAPI (faltam os campos "openapi"/"swagger").',
    isHtml
      ? 'Abra a documentação no navegador, encontre o link do JSON (no Swagger UI fica no topo da página, ex.: /docs/api-docs.json) e configure em RHNET_SPEC_URL ou cole no campo URL da tela. Se a página for de login, veja as opções de acesso no README.'
      : null
  );
}
