# mcp-rhnet

Servidor MCP com a spec OpenAPI do **RH Net**, para a IA consultar a documentação e criar casos de teste da API.

- **Página:** https://mcp-rhnet.vercel.app
- **Conector MCP:** https://mcp-rhnet.vercel.app/mcp

## Atualizar a spec

1. Na página, arraste o botão **⟳ Atualizar MCP RH Net** para a barra de favoritos (uma vez só).
2. Com a VPN ligada, abra a [spec do RH Net](https://api-rhnet-hml.sci.com.br/docs?api-docs.json) e clique no favorito.

O MCP passa a usar a versão nova na hora, sem deploy. Também dá para arrastar o arquivo JSON na página. As versões anteriores ficam no histórico e podem ser restauradas.

O favorito precisa rodar na página da spec porque o RH Net só abre pela VPN e não deixa outros sites lerem o arquivo.

## Conectar na IA

| Cliente | Como |
|---|---|
| claude.ai | Conector personalizado com a URL `https://mcp-rhnet.vercel.app/mcp` |
| Claude Code | `claude mcp add --transport http rhnet https://mcp-rhnet.vercel.app/mcp` |
| VS Code / Cursor | `examples/vscode-mcp.json` |
| Claude Desktop | `examples/claude_desktop_config.json` |

## Deploy (Vercel)

- **Storage → Blob** (acesso Private) conectado ao projeto. É onde ficam as versões da spec.
- Nenhuma variável de ambiente é obrigatória.
- `specs/rhnet.json` é só a versão inicial do deploy; depois vale a última enviada pela página.

## Rodando local

```bash
npm install
npm start      # página em http://127.0.0.1:3001 · conector em http://127.0.0.1:3001/mcp
npm test
```

Localmente a spec atualizada fica em `specs/rhnet.json` (versões anteriores em `specs/.historico/`).

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
  favorito.js           script do favorito
  updater.js            valida, compara, grava e restaura versões
  store/                Vercel Blob (produção) ou disco (local)
  mcp.js · openapi.js · testing.js · specs.js · validate.js · spec-diff.js
  web.js · app.js (Vercel) · http.js (local) · stdio.js
scripts/                build-bundle, validate-specs
test/                   node:test
```
