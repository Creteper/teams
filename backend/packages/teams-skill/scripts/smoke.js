'use strict';
// `npm test`: runs the bin in a temp dir and checks default / exists / --force / --dir.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const assert = require('assert');

require('./sync-skill.js');
const bin = path.join(__dirname, '..', 'bin', 'teams-skill.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-skill-'));
const run = (...args) => spawnSync(process.execPath, [bin, ...args], { cwd: tmp, encoding: 'utf8' });
const want = fs.readFileSync(path.join(__dirname, '..', 'SKILL.md'), 'utf8');
const def = path.join(tmp, '.cursor', 'skills', 'teams-bot-integration', 'SKILL.md');

let r = run();
assert.strictEqual(r.status, 0, r.stderr);
assert.strictEqual(fs.readFileSync(def, 'utf8'), want);
r = run();
assert.strictEqual(r.status, 1);
assert.match(r.stderr, /已存在/);
fs.writeFileSync(def, 'old');
r = run('--force');
assert.strictEqual(r.status, 0, r.stderr);
assert.strictEqual(fs.readFileSync(def, 'utf8'), want);
r = run('--dir', 'x/y');
assert.strictEqual(r.status, 0, r.stderr);
assert.strictEqual(fs.readFileSync(path.join(tmp, 'x', 'y', 'SKILL.md'), 'utf8'), want);
assert.strictEqual(run('--version').stdout.trim(), require('../package.json').version);
assert.strictEqual(run('--help').status, 0);
assert.strictEqual(run('--bogus').status, 2);
assert.strictEqual(run('--dir').status, 2);
fs.rmSync(tmp, { recursive: true, force: true });
console.log('smoke ok');
