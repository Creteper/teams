'use strict';
// `npm run dist`: packs teams-skill-<version>.tgz into backend/skill/dist/
// (embedded into the server binary via go:embed), replacing older tarballs.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const dist = path.join(root, '..', '..', 'skill', 'dist');
fs.mkdirSync(dist, { recursive: true });
for (const f of fs.readdirSync(dist)) {
  if (/^teams-skill-.*\.tgz$/.test(f)) fs.rmSync(path.join(dist, f));
}
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
execFileSync(npm, ['pack', '--pack-destination', dist], { cwd: root, stdio: 'inherit' });
const out = fs.readdirSync(dist).filter((f) => f.endsWith('.tgz'));
console.log('dist: ' + out.join(', '));
