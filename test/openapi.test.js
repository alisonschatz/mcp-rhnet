import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { deref, findOperation, flattenFields, inlineSchema, operationParameters } from '../src/openapi.js';
import { buildExample, deriveTestScenarios, examplePayload } from '../src/testing.js';

const pedidos = JSON.parse(fs.readFileSync(new URL('../specs/exemplo-pedidos.json', import.meta.url)));
const ciclica = JSON.parse(fs.readFileSync(new URL('./fixtures/ciclica.json', import.meta.url)));

test('parâmetros de path-item com $ref são resolvidos', () => {
  const op = findOperation(pedidos, 'GET', '/pedidos/{id}');
  const params = operationParameters(pedidos, op.pathItem, op.operation);
  assert.equal(params.length, 1);
  assert.equal(params[0].name, 'id');
  assert.equal(params[0].in, 'path');
});

test('responses com $ref para components/responses são resolvidas', () => {
  const r = deref(pedidos, pedidos.paths['/pedidos'].post.responses['400']);
  assert.equal(r.description, 'Dados de entrada inválidos');
});

test('allOf é mesclado e readOnly sai dos campos de request', () => {
  const schema = inlineSchema(pedidos, { $ref: '#/components/schemas/Pedido' });
  assert.ok(schema.properties.cliente && schema.properties.id);
  assert.ok(schema.required.includes('numeroParceiro') && schema.required.includes('id'));
  const campos = flattenFields(schema, { context: 'request' }).map((f) => f.campo);
  assert.ok(campos.includes('cliente.endereco.cep'));
  assert.ok(campos.includes('itens[].sku'));
  assert.ok(!campos.includes('id'));
});

test('schema cíclico não entra em loop', () => {
  const schema = inlineSchema(ciclica, { $ref: '#/components/schemas/Categoria' });
  const exemplo = buildExample(schema);
  assert.equal(typeof exemplo.nome, 'string');
  assert.ok(exemplo.nome.length <= 50);
});

test('payload gerado respeita pattern, enum e limites', () => {
  const op = findOperation(pedidos, 'POST', '/pedidos');
  const { corpo, avisos } = examplePayload(pedidos, op, 'completo');
  assert.match(corpo.cliente.cpf, /^\d{11}$/);
  assert.match(corpo.cliente.endereco.cep, /^\d{5}-?\d{3}$/);
  assert.ok(['PIX', 'CARTAO', 'BOLETO'].includes(corpo.formaPagamento));
  assert.ok(corpo.itens[0].precoUnitario > 0);
  assert.ok(corpo.numeroParceiro.length >= 3 && corpo.numeroParceiro.length <= 30);
  assert.deepEqual(avisos, []);
  const minimo = examplePayload(pedidos, op, 'minimo').corpo;
  assert.equal(minimo.observacao, undefined);
  assert.equal(minimo.cliente.endereco, undefined);
});

test('exclusiveMinimum 3.0 (boolean) e 3.1 (number) geram limites corretos', () => {
  const op = findOperation(ciclica, 'POST', '/categorias');
  const cenarios = deriveTestScenarios(ciclica, op).cenarios;
  const abaixo = cenarios.find((c) => c.titulo.includes('"codigo"') && c.titulo.includes('abaixo do mínimo'));
  assert.equal(abaixo.alteracao.valor, 0);
  const limite = cenarios.find((c) => c.titulo.includes('"codigo"') && c.titulo.includes('no limite mínimo'));
  assert.equal(limite.alteracao.valor, 1);
  // nome é nullable (3.1): não deve haver cenário de null
  assert.ok(!cenarios.some((c) => c.titulo.includes('"nome" com null')));
});

test('cenários usam os status documentados e apontam lacunas', () => {
  const op = findOperation(pedidos, 'DELETE', '/pedidos/{id}');
  const { cenarios, statusSucesso } = deriveTestScenarios(pedidos, op);
  assert.equal(statusSucesso, '204');
  assert.ok(cenarios.some((c) => c.categoria === 'recurso' && c.esperado.status === '404'));
  assert.ok(cenarios.some((c) => c.esperado.status === '403'));
  assert.ok(cenarios.some((c) => c.esperado.status === '409'));
  const ids = cenarios.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);

  const semSeguranca = deriveTestScenarios(ciclica, findOperation(ciclica, 'POST', '/categorias'));
  assert.ok(semSeguranca.lacunasDaSpec.some((l) => l.includes('segurança')));
  assert.ok(semSeguranca.lacunasDaSpec.some((l) => l.includes('4xx')));
});

test('operação pública (security: []) não gera cenários de autenticação', () => {
  const op = findOperation(pedidos, 'GET', '/health');
  const { cenarios } = deriveTestScenarios(pedidos, op);
  assert.ok(!cenarios.some((c) => c.categoria === 'seguranca'));
});
