# mcp-rhnet

Servidor MCP que expõe a spec OpenAPI do **RH Net** para uma IA (Claude, Copilot, Cursor...) navegar pela documentação e **criar casos de teste** da API.

Deploy na Vercel com uma tela em **`/admin`**: abra o link, veja se a spec mudou e clique em **Atualizar agora**. O MCP passa a usar a versão nova na hora, sem redeploy e sem commit.

## Como funciona

```
Seu navegador (na VPN)                       Vercel                              IA
───────────────────────                      ──────                              ──
1. abre https://SEU-PROJETO.vercel.app/admin
2. a página baixa a spec do RH Net  ───────▶ 3. valida, compara e guarda  ◀────── /mcp usa sempre
   (pela SUA rede/VPN)                          no Vercel Blob                     a versão mais nova
```

O RH Net só abre pela VPN, e a Vercel não está na VPN. Por isso quem baixa a spec é o **seu navegador**, que envia o conteúdo para o servidor. O servidor nunca precisa alcançar a rede interna.

- Ao abrir `/admin`, a página já confere sozinha se há versão nova e mostra o que mudou: operações e schemas novos, removidos e alterados.
- **Atualizar agora** grava a versão nova. A anterior fica guardada e pode ser **restaurada** com um clique.
- Uma spec inválida nunca substitui a atual.

### O favorito "⟳ Atualizar MCP RH Net" (hoje é o caminho principal)

A spec fica em `https://api-rhnet-hml.sci.com.br/docs?api-docs.json`, e esse servidor não libera leitura por outros sites (CORS). Por isso a página da Vercel não consegue baixá-la direto. O favorito contorna isso:

1. Em `/admin`, arraste o botão **⟳ Atualizar MCP RH Net** para a barra de favoritos (uma vez).
2. Com a VPN ligada, clique no favorito: ele abre a spec do RH Net. Clique nele de novo nessa página: ele lê a spec e envia para o MCP. Aparece "✔ Spec atualizada" ou "✔ A spec já estava atualizada".

Sem o favorito, também dá para usar **Abrir o JSON em outra aba**, salvar com Ctrl+S e arrastar o arquivo em `/admin`.

Se o time do RH Net liberar CORS na rota da documentação (`Access-Control-Allow-Origin: https://SEU-PROJETO.vercel.app`), a própria página `/admin` passa a conferir e atualizar sozinha, sem o favorito.

## Deploy na Vercel (uma vez)

1. **Blob Store**: no projeto da Vercel, vá em *Storage → Create → Blob*, escolha acesso **Private** e conecte ao projeto. Isso cria a variável `BLOB_READ_WRITE_TOKEN` sozinho.
2. **Variáveis** (*Settings → Environment Variables*):
   - `ADMIN_TOKEN`: uma senha longa. É o que a tela pede para entrar. Sem ela, `/admin` fica desligada.
   - `RHNET_SPEC_URL` (opcional): já vem configurado com `https://api-rhnet-hml.sci.com.br/docs?api-docs.json`.
3. **Redeploy**. O build continua o mesmo (`npm run build` valida e empacota `specs/rhnet.json`).
4. Abra `https://SEU-PROJETO.vercel.app/admin`, entre com o token e arraste o favorito para a barra.

A spec do repositório (`specs/rhnet.json`) é só o ponto de partida. Depois da primeira atualização pela tela, vale a versão guardada no Blob. Não é preciso commitar a spec a cada mudança, mas pode commitar de vez em quando para o repositório não ficar muito defasado.

A URL do MCP não muda: `https://SEU-PROJETO.vercel.app/mcp`.

## Rodando local

```bash
npm install
npm start          # MCP em http://127.0.0.1:3001/mcp · tela em http://127.0.0.1:3001/admin
npm test
```

Localmente a spec fica na pasta `specs/` (backups em `specs/.historico/`) e quem baixa é o próprio servidor, porque sua máquina está na VPN. Também dá para atualizar pelo terminal:

```bash
npm run spec:verificar
npm run spec:atualizar                                  # baixa e aplica
npm run spec:atualizar -- --arquivo C:/Downloads/api-docs.json
```

Com `BLOB_READ_WRITE_TOKEN` no `.env` (copie de *Storage → Blob → .env.local* na Vercel), o `spec:atualizar` grava **direto no Blob da Vercel**. É outro jeito de atualizar o site, sem abrir a tela.

## Outro host (Docker / servidor interno)

```bash
docker build -t mcp-rhnet . && docker run -p 3001:3001 -e ADMIN_TOKEN=... mcp-rhnet
```

Se o host estiver na rede interna, use `SPEC_FETCH_MODE=servidor` para o próprio servidor baixar a spec. Aí dá até para ligar a atualização automática com `SPEC_AUTO_UPDATE_MINUTES=60`. Monte um volume em `/app/specs` para não perder as versões ao recriar o container.

## Configuração

| Variável | Para quê |
|---|---|
| `ADMIN_TOKEN` | Senha da tela `/admin` (obrigatória fora da máquina local). |
| `BLOB_READ_WRITE_TOKEN` | Criada pela Vercel ao conectar o Blob Store. Com ela, a spec fica no Blob. |
| `RHNET_SPEC_URL` | Link do JSON da spec. Sem ela, vale a última URL usada na tela. |
| `SPEC_FETCH_MODE` | `navegador` (padrão na Vercel) ou `servidor` (padrão local/Docker). |
| `SPEC_SYNC_SECONDS` | Com Blob: a cada quantos segundos cada instância confere se há versão nova (15). |
| `SPEC_HISTORY_LIMIT` | Quantas versões anteriores manter (10). |
| `SPEC_AUTO_UPDATE_MINUTES` | Só no modo `servidor`: atualização automática (0 = desligada). |
| `RHNET_SPEC_TOKEN` / `RHNET_SPEC_COOKIE` / `RHNET_SPEC_HEADERS` | Só no modo `servidor`, se a URL exigir login. |
| `SPECS_DIR`, `PORT`/`MCP_PORT`, `MCP_HOST`, `MCP_MAX_RESPONSE_CHARS` | Servidor. |

## Conectando na IA

| Cliente | Como |
|---|---|
| claude.ai (conector personalizado) | URL `https://SEU-PROJETO.vercel.app/mcp` |
| Claude Code | `claude mcp add --transport http rhnet https://SEU-PROJETO.vercel.app/mcp` |
| VS Code / Cursor / Claude Desktop | `url` do servidor (ver `examples/`) ou stdio local apontando para `src/stdio.js` |

O endpoint `/mcp` é público (só leitura da documentação). A tela `/admin` exige o `ADMIN_TOKEN`.

## Estrutura

```
specs/rhnet.json          ← spec inicial (a do build)
src/
  admin.html · admin.js   ← tela /admin
  updater.js              ← valida, compara, grava, restaura
  fetcher.js              ← download pelo servidor (modo "servidor")
  spec-diff.js            ← resumo e diff entre versões
  store/                  ← onde a spec é guardada: disco (fs-store) ou Vercel Blob (blob-store)
  specs.js                ← leitura da spec usada pelo MCP
  openapi.js · testing.js · mcp.js · validate.js
  web.js · app.js (Vercel) · http.js (local/Docker) · stdio.js
scripts/                  ← build-bundle, validate-specs, update-spec
test/                     ← node:test (inclui simulação da Vercel com Blob em memória)
```

## Ferramentas MCP

| Tool | Para quê |
|---|---|
| `list_apis` | APIs disponíveis |
| `get_api_overview` | descrição, servidores, tags, segurança |
| `list_operations` | endpoints, com filtro por tag |
| `get_operation_docs` | descrição funcional, parâmetros, respostas |
| `get_operation_schema` · `get_schema_definition` | schemas |
| `search_documentation` | busca em caminhos, descrições, parâmetros e schemas |
| `get_operation_test_context` | campos achatados com restrições, segurança e respostas (paginado) |
| `generate_example_payload` | payload válido (`completo`/`minimo`, `exemplo`, `variante`) |
| `suggest_test_scenarios` | checklist de cenários com status esperado e lacunas da spec |

Prompts: `casos_de_teste_operacao` e `plano_de_testes_api`. Resources: `docs://index` e `openapi://rhnet`.

## Limitações

- Somente JSON e `$ref` locais (`#/...`).
- Os cenários vêm só da spec: regras de negócio precisam ser informadas à IA.
