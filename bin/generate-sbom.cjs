#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  version: 1,
  metadata: {
    component: {
      type: 'application',
      name: pkg.name,
      version: pkg.version,
      licenses: [{ license: { id: pkg.license } }],
      purl: `pkg:npm/${pkg.name}@${pkg.version}`,
    },
  },
  components: [],
  dependencies: [{ ref: `pkg:npm/${pkg.name}@${pkg.version}`, dependsOn: [] }],
};
const output = `${JSON.stringify(sbom, null, 2)}\n`;
const file = path.join(ROOT, 'sbom.cdx.json');
if (process.argv.includes('--write')) {
  fs.writeFileSync(file, output);
  console.log(`wrote ${path.relative(ROOT, file)}`);
} else {
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (current !== output) {
    console.error('sbom.cdx.json is stale; run node bin/generate-sbom.cjs --write');
    process.exit(1);
  }
  console.log('sbom: PASS');
}

module.exports = { sbom };
