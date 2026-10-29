// Favorito "Atualizar MCP RH Net". Carregado por import() a partir do favorito do navegador,
// roda na página da spec do RH Net (mesma origem, então consegue ler o JSON) e envia ao site.
// O link da spec (constante SPEC) é preenchido pelo servidor ao entregar este arquivo.
const SITE = new URL(import.meta.url).origin;
const SPEC = '__SPEC_URL__';

function aviso(texto, cor, link) {
  let el = document.getElementById('__mcp_rhnet');
  if (!el) {
    el = document.createElement('div');
    el.id = '__mcp_rhnet';
    document.body.appendChild(el);
  }
  el.style.cssText =
    'position:fixed;top:16px;right:16px;z-index:2147483647;max-width:380px;padding:14px 16px;border-radius:10px;' +
    'font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;color:#fff;box-shadow:0 8px 28px rgba(0,0,0,.28);background:' + cor;
  el.textContent = texto;
  if (link) {
    const a = document.createElement('a');
    a.href = SITE;
    a.textContent = 'Abrir MCP RH Net';
    a.style.cssText = 'display:block;margin-top:6px;color:#fff;font-weight:600';
    el.appendChild(a);
  }
}

async function gzip(texto) {
  if (typeof CompressionStream === 'undefined') return { body: texto, tipo: 'text/plain' };
  const stream = new Blob([texto]).stream().pipeThrough(new CompressionStream('gzip'));
  return { body: await new Response(stream).blob(), tipo: 'application/gzip' };
}

async function atualizar() {
  if (location.origin !== new URL(SPEC).origin) {
    location.href = SPEC; // abre a spec; clique no favorito de novo lá
    return;
  }
  try {
    aviso('Atualizando…', '#1f6feb');
    const resp = await fetch(SPEC, { cache: 'no-store' });
    if (!resp.ok) throw new Error(`A spec respondeu ${resp.status}.`);
    const { body, tipo } = await gzip(await resp.text());
    const r = await fetch(`${SITE}/api/rhnet/enviar`, { method: 'POST', headers: { 'Content-Type': tipo, 'x-origem': 'favorito' }, body });
    const res = await r.json();
    if (!r.ok) throw new Error(res.erro || `Falha ${r.status}.`);
    if (res.status === 'invalida') return aviso(`✖ ${res.mensagem}`, '#c0362c', true);
    if (res.status === 'sem-mudancas') return aviso('✔ Já estava atualizada.', '#12805c', true);
    const o = res.resumo.operacoes;
    aviso(`✔ Spec atualizada. Operações: +${o.adicionadas} −${o.removidas} ~${o.alteradas}`, '#12805c', true);
  } catch (e) {
    aviso(`✖ ${e.message}`, '#c0362c', true);
  }
}

atualizar();
