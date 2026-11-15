const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('yaml');
const { assertFreeBlueprint } = require('../scripts/validate-render');
const read = () => parse(fs.readFileSync(path.join(__dirname, '../render.yaml'), 'utf8'));

test('Blueprint do projeto contém somente web gratuito com execução na main', () => {
  assert.doesNotThrow(() => assertFreeBlueprint(read()));
});

test('validação rejeita worker e plano omitido que poderia assumir custo', () => {
  const withWorker = read();
  withWorker.services.push({ type: 'worker', plan: 'free' });
  assert.throws(() => assertFreeBlueprint(withWorker), /somente um Web Service gratuito/);
  const withDefaultPlan = read();
  delete withDefaultPlan.services[0].plan;
  assert.throws(() => assertFreeBlueprint(withDefaultPlan), /somente um Web Service gratuito/);
});

test('validação rejeita provisionamento de banco ou disco pelo Blueprint', () => {
  const withDatabase = read();
  withDatabase.databases = [{ name: 'banco-nao-autorizado', plan: 'free' }];
  assert.throws(() => assertFreeBlueprint(withDatabase), /somente um Web Service gratuito/);
  const withDisk = read();
  withDisk.services[0].disk = { name: 'disco-nao-autorizado', mountPath: '/data', sizeGB: 1 };
  assert.throws(() => assertFreeBlueprint(withDisk), /somente um Web Service gratuito/);
});
