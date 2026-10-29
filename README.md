# mcp-rhnet

Servidor MCP com a spec OpenAPI do **RH Net** em dois ambientes, para a IA consultar a documentação, comparar ambientes e criar casos de teste da API.

| Ambiente | apiId | Spec | Atualização |
|---|---|---|---|
| Homologação | `rhnet-hml` | https://api-rhnet-hml.sci.com.br/docs?api-docs.json (VPN) | manual, pela página |
| Produção | `rhnet-prd` | https://api2.rhnetsocial.com.br/docs?api-docs.json | automática, a cada hora |

- **Página:** https://mcp-rhnet.vercel.app (specs em uso, atualização, última mudança e comparação)
- **Conector MCP:** https://mcp-rhnet.vercel.app/mcp

## Atualizar a spec

**Homologação** (só abre na VPN):

1. Com a VPN ligada, clique em **abra a spec** na página.
2. Salve o arquivo com Ctrl+S.
3. Arraste o arquivo na página (ou clique para selecionar).

**Produção**: o servidor confere sozinho a cada hora, na primeira vez que a página ou o MCP é usado depois desse intervalo. O botão **Atualizar agora** força na hora.

O MCP passa a usar a versão nova na hora, sem deploy. Cada ambiente guarda só a versão em uso e a anterior: a página mostra o que mudou na última atualização e permite voltar para a anterior.

## Comparar homologação e produção

A página mostra as operações que existem só em homologação, só em produção e as que estão diferentes — inclusive quando a diferença está num schema usado pela operação. Clique numa operação diferente para ver campo a campo. Pela IA, por exemplo:

> Compare POST /api/v1/admissoes entre rhnet-hml e rhnet-prd.

A tool `compare_apis` devolve parâmetros, campos do corpo e respostas que existem só em um ambiente ou que mudaram (tipo, obrigatoriedade, tamanho, enum…).

## Conectar na IA

**claude.ai** — conector personalizado com a URL `https://mcp-rhnet.vercel.app/mcp`.

**Claude Code**

```bash
claude mcp add --transport http rhnet https://mcp-rhnet.vercel.app/mcp
```

**VS Code / Cursor** (`.vscode/mcp.json`)

```json
{ "servers": { "rhnet": { "type": "http", "url": "https://mcp-rhnet.vercel.app/mcp" } } }
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{ "mcpServers": { "rhnet": { "command": "npx", "args": ["-y", "mcp-remote", "https://mcp-rhnet.vercel.app/mcp"] } } }
```

## Deploy (Vercel)

- **Storage → Blob** (acesso Private) conectado ao projeto: guarda a versão atual e a anterior de cada ambiente, em `specs/`. Arquivos de formatos antigos são apagados sozinhos no primeiro acesso.
- Nenhuma variável de ambiente é obrigatória.
- `specs/rhnet-hml.json` é só a versão inicial de homologação; depois vale a última enviada pela página. Produção é baixada sozinha no primeiro uso.

## Rodando local

```bash
npm install
npm start      # página em http://127.0.0.1:3001 · conector em http://127.0.0.1:3001/mcp
npm test
```

Localmente as specs ficam em `specs/` (versão anterior em `specs/.historico/`).

## Ferramentas MCP

| Tool | Para quê |
|---|---|
| `list_apis` | APIs disponíveis |
| `get_api_overview` | descrição, servidores, tags, segurança |
| `list_operations` | endpoints, com filtro por tag |
| `get_operation_docs` | descrição funcional, parâmetros, respostas |
| `get_operation_schema` · `get_schema_definition` | schemas |
| `search_documentation` | busca em caminhos, descrições, parâmetros e schemas |
| `compare_apis` | diferenças entre homologação e produção (geral ou de uma operação) |
| `get_operation_test_context` | campos com restrições, segurança e respostas (paginado) |
| `generate_example_payload` | payload válido (`completo`/`minimo`, `exemplo`, `variante`) |
| `suggest_test_scenarios` | cenários de teste com status esperado e lacunas da spec |

Prompts: `casos_de_teste_operacao` e `plano_de_testes_api`. Resources: `docs://index`, `openapi://rhnet-hml` e `openapi://rhnet-prd`.

## Estrutura

```
specs/rhnet-hml.json    spec inicial de homologação
src/
  site.html · site.js   página (/) e API usada por ela
  updater.js            valida, grava, restaura e baixa produção sozinho
  compare.js            comparação entre ambientes
  store/                Vercel Blob (produção) ou disco (local)
  mcp.js · openapi.js · testing.js · specs.js · validate.js · spec-diff.js
  web.js · app.js (Vercel) · http.js (local)
scripts/                build-bundle, validate-specs
test/                   node:test
```
