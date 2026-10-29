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

O MCP passa a usar a versão nova na hora, sem deploy. Cada ambiente guarda só a versão em uso e a anterior. Depois de enviar, a página abre **Mudanças em homologação**: operações novas, removidas, alteradas (campo a campo) e só de texto, em relação à versão anterior — ideal para o QA ver o que o dev mudou. Dá para voltar para a anterior com um clique.

## Comparar homologação e produção

A aba **Homologação × Produção** mostra o que muda quando homologação for para produção. As abas de mudanças mostram o que mudou da versão anterior para a atual em cada ambiente.

Cada mudança tem um **impacto** e uma **categoria**:

| Impacto | Quando |
|---|---|
| Quebra | pode quebrar quem usa a API: campo/parâmetro obrigatório novo, campo da resposta removido, tipo mudou, enum perdeu valor, limite mais restrito, passou a exigir autenticação, operação removida |
| Atenção | vale testar: campo opcional novo, campo novo na resposta, status novo, operação nova |
| Documentação | só texto ou exemplo |

Categorias: endpoint, segurança, parâmetros, corpo, resposta, exemplos e textos. Dá para filtrar por impacto, categoria, situação e busca. Clique numa operação para ver campo a campo, com antes/depois (exemplos inclusive). Pela IA, por exemplo:

> Use o prompt revisar_mudancas para o rhnet-hml.

> Compare POST /api/v1/admissoes entre rhnet-prd e rhnet-hml e liste só o que quebra.

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
- O repositório não tem spec fixa: homologação começa vazia até o primeiro envio pela página, e produção é baixada sozinha no primeiro uso.

## Rodando local

```bash
npm install
npm start      # página em http://127.0.0.1:3001 · conector em http://127.0.0.1:3001/mcp
npm test
```

Localmente as specs enviadas ficam em `specs/` (fora do git; versão anterior em `specs/.historico/`).

## Ferramentas MCP

| Tool | Para quê |
|---|---|
| `list_apis` | APIs disponíveis |
| `get_api_overview` | descrição, servidores, tags, segurança |
| `list_operations` | endpoints, com filtro por tag |
| `get_operation_docs` | descrição funcional, parâmetros, respostas |
| `get_operation_schema` · `get_schema_definition` | schemas |
| `search_documentation` | busca indexada (operação, parâmetro, campo, resposta, schema, exemplo), com filtros e paginação |
| `list_schemas` · `get_schema_usages` | schemas da spec e quais operações usam cada um |
| `get_operation_examples` | exemplos de requisição e resposta de uma operação |
| `compare_apis` | homologação × produção com impacto e categoria (filtros: categoria, impacto, situação, tag, busca; paginado) |
| `compare_previous_version` | o mesmo, entre a versão anterior e a atual de um ambiente |
| `get_operation_test_context` | campos com restrições, segurança e respostas (paginado) |
| `generate_example_payload` | payload válido (`completo`/`minimo`, `exemplo`, `variante`) |
| `suggest_test_scenarios` | cenários de teste com status esperado e lacunas da spec |

Prompts: `casos_de_teste_operacao`, `plano_de_testes_api` e `revisar_mudancas`. Resources: `docs://index`, `openapi://rhnet-hml` e `openapi://rhnet-prd`.

## Estrutura

```
src/
  site.html · site.js   página (/) e API usada por ela
  updater.js            valida, grava, restaura e baixa produção sozinho
  compare.js            comparação por impacto e categoria
  mcp-qa.js             tools de comparação, busca, schemas e exemplos
  store/                Vercel Blob (produção) ou disco (local)
  mcp.js · openapi.js · testing.js · specs.js · validate.js · spec-diff.js
  web.js · app.js (Vercel) · http.js (local)
scripts/                build-bundle, validate-specs
test/                   node:test (a spec usada nos testes fica em test/fixtures/specs/)
```
