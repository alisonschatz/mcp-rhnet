import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffOperacao, diffSpecs, filtrarDiff } from '../src/compare.js';

const base = () => ({
  openapi: '3.0.0',
  info: { title: 't', version: '1' },
  components: {
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    schemas: {
      Pessoa: {
        type: 'object',
        required: ['nome'],
        properties: {
          nome: { type: 'string', maxLength: 100, description: 'Nome completo' },
          tipo: { type: 'string', enum: ['A', 'B', 'C'] },
          idade: { type: 'integer', minimum: 0 },
        },
      },
    },
  },
  paths: {
    '/pessoas': {
      post: {
        summary: 'Cria pessoa',
        parameters: [{ name: 'empresa_id', in: 'query', schema: { type: 'integer' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Pessoa' }, example: { nome: 'Ana' } } } },
        responses: {
          201: { description: 'Criada', content: { 'application/json': { schema: { type: 'object', required: ['id'], properties: { id: { type: 'integer' }, nome: { type: 'string' } } } } } },
          400: { description: 'Inválido' },
        },
      },
    },
  },
});

const achar = (d, local, propriedade) => d.itens.find((i) => i.local === local && (!propriedade || i.propriedade === propriedade));

test('regras de impacto da requisição', () => {
  const a = base();
  const b = base();
  const p = b.components.schemas.Pessoa;
  p.properties.nome.maxLength = 50; // mais restrito → quebra
  p.properties.tipo.enum = ['A', 'B', 'D']; // C removido → quebra
  p.properties.cpf = { type: 'string', pattern: '^\\d{11}$' };
  p.required.push('cpf'); // campo novo obrigatório → quebra
  p.properties.nome.description = 'Nome civil'; // texto → info
  b.paths['/pessoas'].post.parameters[0].required = true; // parâmetro virou obrigatório → quebra
  b.paths['/pessoas'].post.requestBody.content['application/json'].example = { nome: 'Bia' }; // exemplo → info

  const d = diffOperacao(a, b, 'POST', '/pessoas');
  assert.equal(d.situacao, 'alterada');
  assert.equal(d.impacto, 'quebra');
  assert.equal(achar(d, 'corpo.nome', 'maxLength').impacto, 'quebra');
  assert.match(achar(d, 'corpo.nome', 'maxLength').resumo, /100 → 50/);
  const en = achar(d, 'corpo.tipo', 'enum');
  assert.equal(en.impacto, 'quebra');
  assert.match(en.resumo, /novos: D/);
  assert.match(en.resumo, /removidos: C/);
  assert.equal(achar(d, 'corpo.cpf').mudanca, 'adicionado');
  assert.equal(achar(d, 'corpo.cpf').impacto, 'quebra');
  assert.equal(achar(d, 'corpo.nome', 'descricao').categoria, 'texto');
  assert.equal(achar(d, 'parâmetro query.empresa_id', 'obrigatorio').impacto, 'quebra');
  const ex = d.itens.find((i) => i.categoria === 'exemplo');
  assert.equal(ex.impacto, 'info');
  assert.deepEqual([ex.antes, ex.depois], [{ nome: 'Ana' }, { nome: 'Bia' }]);
  assert.equal(d.itens[0].impacto, 'quebra', 'quebras vêm primeiro');
});

test('regras de impacto da resposta, segurança e status', () => {
  const a = base();
  const b = base();
  const r201 = b.paths['/pessoas'].post.responses[201].content['application/json'].schema;
  delete r201.properties.nome; // campo da resposta removido → quebra
  r201.properties.id.nullable = true; // pode vir null → quebra
  r201.properties.criado_em = { type: 'string', format: 'date-time' }; // campo novo na resposta → atencao
  b.paths['/pessoas'].post.responses[404] = { description: 'Não encontrada' }; // status novo → atencao
  delete b.paths['/pessoas'].post.responses[400]; // status de erro removido → atencao
  b.paths['/pessoas'].post.security = [{ bearer: [] }]; // passou a exigir autenticação → quebra

  const d = diffOperacao(a, b, 'POST', '/pessoas');
  assert.equal(achar(d, 'resposta 201.nome').impacto, 'quebra');
  assert.equal(achar(d, 'resposta 201.id', 'nullable').impacto, 'quebra');
  assert.equal(achar(d, 'resposta 201.criado_em').impacto, 'atencao');
  assert.equal(achar(d, 'resposta 404').mudanca, 'adicionado');
  assert.equal(achar(d, 'resposta 400').impacto, 'atencao');
  const seg = d.itens.find((i) => i.categoria === 'seguranca');
  assert.equal(seg.impacto, 'quebra');
  assert.match(seg.resumo, /passou a exigir autenticação/);
});

test('diffSpecs: resumo, operações novas/removidas, filtros e cache', () => {
  const a = base();
  const b = base();
  b.paths['/empresas'] = { get: { summary: 'Lista', responses: { 200: { description: 'ok' } } } };
  b.components.schemas.Pessoa.properties.nome.description = 'Outro texto';
  const d = diffSpecs(a, b);
  assert.equal(d.resumo.operacoes.novas, 1);
  assert.equal(d.resumo.operacoes.alteradas, 1);
  assert.deepEqual(d.resumo.schemas.alterados, ['Pessoa']);
  assert.equal(diffSpecs(a, b), d, 'mesmo par de specs usa o cache');
  assert.deepEqual(filtrarDiff(d, { impacto: 'info' }).map((o) => o.operacao), ['POST /pessoas']);
  assert.deepEqual(filtrarDiff(d, { situacao: 'nova' }).map((o) => o.operacao), ['GET /empresas']);
  assert.equal(diffSpecs(a, structuredClone(a)).operacoes.length, 0);
});

test('enum com rótulos (oneOf + const): valor mudou é contrato, título é texto', () => {
  const mk = (r) => ({ openapi: '3.0.0', info: { title: 't', version: '1' }, paths: { '/x': { get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { sexo: { oneOf: Object.entries(r).map(([k, t]) => ({ const: k, title: t })) } } } } } } } } } } });
  const valores = diffOperacao(mk({ feminino: '0 - Feminino', masculino: '1 - Masculino' }), mk({ 0: '0 - Feminino', 1: '1 - Masculino' }), 'GET', '/x');
  assert.deepEqual(valores.itens.map((i) => [i.categoria, i.impacto, i.propriedade]), [['resposta', 'quebra', 'enum']]);
  const titulos = diffOperacao(mk({ a: 'A', b: 'B' }), mk({ a: 'Á', b: 'B' }), 'GET', '/x');
  assert.deepEqual(titulos.itens.map((i) => [i.categoria, i.impacto, i.resumo]), [['texto', 'info', 'rótulos mudaram: a: A → Á']]);
});
