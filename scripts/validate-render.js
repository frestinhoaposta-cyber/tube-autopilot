const fs = require('node:fs');
const { parse } = require('yaml');
const Ajv = require('ajv/dist/2020');

function assertFreeBlueprint(blueprint) {
  const services = blueprint.services || [];
  if (services.length !== 1 || services[0].type !== 'web' || services[0].plan !== 'free'
    || services[0].disk || (services[0].previews?.plan && services[0].previews.plan !== 'free')
    || blueprint.databases?.length || blueprint.projects?.length || blueprint.ungrouped) {
    throw new Error('Esta configuração autoriza somente um Web Service gratuito, sem worker, banco provisionado ou disco persistente no Render.');
  }
  if (services[0].branch !== 'main' || services[0].autoDeployTrigger !== 'commit' || services[0].startCommand !== 'node server/server.js') {
    throw new Error('O web deve iniciar com node server/server.js e usar deploy automático da branch main.');
  }
}

async function main() {
  const blueprint = parse(fs.readFileSync('render.yaml', 'utf8'));
  assertFreeBlueprint(blueprint);
  const response = await fetch('https://render.com/schema/render.yaml.json');
  if (!response.ok) throw new Error('Não foi possível obter o schema atual do Render.');
  const schema = await response.json();
  const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
  const validate = ajv.compile(schema);
  if (!validate(blueprint)) {
    console.error(JSON.stringify(validate.errors, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log('render.yaml válido segundo o schema público atual do Render. Nenhum recurso foi criado.');
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { assertFreeBlueprint };
