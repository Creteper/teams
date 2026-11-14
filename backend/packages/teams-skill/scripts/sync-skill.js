'use strict';
// Copies the single source of truth backend/skill/teams-bot-integration/SKILL.md
// into the package root before `npm pack` (prepack). The copy is git-ignored.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, '..', '..', 'skill', 'teams-bot-integration', 'SKILL.md');
fs.copyFileSync(src, path.join(root, 'SKILL.md'));
console.log('synced SKILL.md from ' + path.relative(root, src));
