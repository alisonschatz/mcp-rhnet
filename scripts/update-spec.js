#!/usr/bin/env node
/**
 * Atualiza a spec pela linha de comando (precisa da VPN).
 *
 *   npm run spec:atualizar                       baixa da URL configurada e aplica
 *   npm run spec:verificar                       só compara, não grava
 *   npm run spec:atualizar -- --url <url>        usa outra URL (JSON ou página do Swagger)
 *   npm run spec:atualizar -- --arquivo <caminho> aplica um JSON baixado manualmente
 *   (opcional) --api rhnet
 *
 * Grava onde o servidor grava: na pasta specs/ ou, com BLOB_READ_WRITE_TOKEN no .env,
 * direto no Vercel Blob do deploy (atualiza o site sem passar pela tela).
 */
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { updateFromText, updateFromUrl } from '../src/updater.js';

const { values } = parseArgs({
  options: {
    api: { type: 'string', default: 'rhnet' },
    url: { type: 'string' },
    arquivo: { type: 'string' },
    verificar: { type: 'boolean', default: false },
  },
});

const lista = (titulo, itens) => itens.length && console.log(`  ${titulo} (${itens.length}):\n${itens.slice(0, 40).map((i) => `    - ${i}`).join('\n')}${itens.length > 40 ? `\n    … e mais ${itens.length - 40}` : ''}`);

try {
  const aplicar = !values.verificar;
  const r = values.arquivo
    ? await updateFromText(values.api, fs.readFileSync(values.arquivo, 'utf8'), { aplicar, origem: `arquivo: ${values.arquivo}` })
    : await updateFromUrl(values.api, { aplicar, url: values.url });

  console.log(`\n${r.status === 'invalida' ? '✖' : '✔'} ${r.mensagem}`);
  if (r.urlUsada) console.log(`  origem: ${r.urlUsada}`);
  if (r.anterior && r.status !== 'sem-mudancas') console.log(`  operações: ${r.anterior.operacoes} → ${r.nova.operacoes} · schemas: ${r.anterior.schemas} → ${r.nova.schemas}`);
  if (r.status !== 'sem-mudancas') {
    lista('operações novas', r.diff.operacoes.adicionadas);
    lista('operações removidas', r.diff.operacoes.removidas);
    lista('operações alteradas', r.diff.operacoes.alteradas);
    lista('schemas novos', r.diff.schemas.adicionadas);
    lista('schemas removidos', r.diff.schemas.removidas);
    lista('schemas alterados', r.diff.schemas.alteradas);
  }
  r.erros.forEach((e) => console.log(`  ERRO  ${e}`));
  if (r.backup) console.log(`  backup da versão anterior: ${r.backup}`);
  process.exit(r.status === 'invalida' ? 1 : 0);
} catch (e) {
  console.error(`\n✖ ${e.message}`);
  if (e.dica) console.error(`  ${e.dica}`);
  process.exit(1);
}
