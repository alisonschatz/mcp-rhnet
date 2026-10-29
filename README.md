# mcp-rhnet

Servidor MCP com a spec OpenAPI do **RH Net**, para a IA consultar a documentação e criar casos de teste da API.

- **Página:** https://mcp-rhnet.vercel.app (spec em uso, atualização e histórico)
- **Conector MCP:** https://mcp-rhnet.vercel.app/mcp

## Atualizar a spec

1. Com a VPN ligada, clique em **Abrir spec do RH Net** na página.
2. Salve o arquivo com Ctrl+S.
3. Arraste o arquivo na página (ou clique para selecionar).

O MCP passa a usar a versão nova na hora, sem deploy. As versões anteriores ficam no histórico e podem ser restauradas.

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

- **Storage → Blob** (acesso Private) conectado ao projeto: guarda as versões da spec.
- Nenhuma variável de ambiente é obrigatória.
- `specs/rhnet.json` é só a versão inicial do deploy; depois vale a última enviada pela página.

## Rodando local

```bash
npm install
npm start      # página em http://127.0.0.1:3001 · conector em http://127.0.0.1:3001/mcp
npm test
```

Localmente a spec enviada fica em `specs/rhnet.json` (versões anteriores em `specs/.historico/`).

## Ferramentas MCP

| Tool | Para quê |
|---|---|
| `list_apis` | APIs disponíveis |
| `get_api_overview` | descrição, servidores, tags, segurança |
| `list_operations` | endpoints, com filtro por tag |
| `get_operation_docs` | descrição funcional, parâmetros, respostas |
| `get_operation_schema` · `get_schema_definition` | schemas |
| `search_documentation` | busca em caminhos, descrições, parâmetros e schemas |
| `get_operation_test_context` | campos com restrições, segurança e respostas (paginado) |
| `generate_example_payload` | payload válido (`completo`/`minimo`, `exemplo`, `variante`) |
| `suggest_test_scenarios` | cenários de teste com status esperado e lacunas da spec |

Prompts: `casos_de_teste_operacao` e `plano_de_testes_api`. Resources: `docs://index` e `openapi://rhnet`.

## Estrutura

```
specs/rhnet.json        spec inicial
src/
  site.html · site.js   página (/) e API usada por ela
  updater.js            valida, compara, grava e restaura versões
  store/                Vercel Blob (produção) ou disco (local)
  mcp.js · openapi.js · testing.js · specs.js · validate.js · spec-diff.js
  web.js · app.js (Vercel) · http.js (local)
scripts/                build-bundle, validate-specs
test/                   node:test
```
