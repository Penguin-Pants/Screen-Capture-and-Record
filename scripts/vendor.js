// Copy third-party browser code from node_modules into src/vendor.
// Files are copied unmodified, so reviewers can compare them with the
// published npm package. Run after you change a version in package.json.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const packages = [
  {
    name: 'mediabunny',
    files: { 'dist/bundles/mediabunny.min.mjs': 'mediabunny.min.mjs', LICENSE: 'LICENSE' }
  }
];

for (const pkg of packages) {
  const source = path.join(root, 'node_modules', pkg.name);
  const { version } = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  const target = path.join(root, 'src', 'vendor', pkg.name);
  fs.mkdirSync(target, { recursive: true });
  for (const [from, to] of Object.entries(pkg.files)) {
    fs.copyFileSync(path.join(source, from), path.join(target, to));
  }
  fs.writeFileSync(path.join(target, 'VERSION'), `${pkg.name} ${version}\nhttps://www.npmjs.com/package/${pkg.name}/v/${version}\n`);
  console.log(`Copied ${pkg.name} ${version} to ${path.relative(root, target)}`);
}
