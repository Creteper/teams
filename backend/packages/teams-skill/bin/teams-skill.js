#!/usr/bin/env node
'use strict';
// Writes the bundled TeAms bot integration skill to
// ./.cursor/skills/teams-bot-integration/SKILL.md (or <dir>/SKILL.md).
// No dependencies; Node 18+.

const fs = require('fs');
const path = require('path');

const pkg = require('../package.json');
const SKILL_NAME = 'teams-bot-integration';
const DEFAULT_DIR = path.join('.cursor', 'skills', SKILL_NAME);

const USAGE = `teams-skill ${pkg.version} — 安装 TeAms bot 接入 skill（${SKILL_NAME}）

用法：
  npx -y <tgz 地址> [选项]
  teams-skill [选项]

默认写到 ./${DEFAULT_DIR.split(path.sep).join('/')}/SKILL.md（相对当前目录）。

选项：
  --dir <目录>   把 SKILL.md 放到 <目录> 下（即写 <目录>/SKILL.md；目录不存在会创建）
  --force, -f    目标文件已存在时覆盖（不加则提示并以退出码 1 结束）
  --help, -h     显示帮助
  --version, -v  显示版本
`;

function fail(msg, code) {
  process.stderr.write(`teams-skill: ${msg}\n`);
  process.exit(code);
}

function parse(argv) {
  const opts = { dir: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      process.stdout.write(USAGE);
      process.exit(0);
    } else if (a === '--version' || a === '-v') {
      process.stdout.write(pkg.version + '\n');
      process.exit(0);
    } else if (a === '--force' || a === '-f') {
      opts.force = true;
    } else if (a === '--dir') {
      const v = argv[++i];
      if (!v || v.startsWith('-')) fail('--dir 需要一个目录参数', 2);
      opts.dir = v;
    } else if (a.startsWith('--dir=')) {
      opts.dir = a.slice('--dir='.length);
      if (!opts.dir) fail('--dir 需要一个目录参数', 2);
    } else {
      fail(`未知参数：${a}（--help 查看用法）`, 2);
    }
  }
  return opts;
}

function main() {
  const opts = parse(process.argv.slice(2));
  const src = path.join(__dirname, '..', 'SKILL.md');
  let content;
  try {
    content = fs.readFileSync(src);
  } catch (e) {
    fail(`包内缺少 SKILL.md（${e.code || e.message}），请重新打包`, 1);
  }
  const dir = path.resolve(process.cwd(), opts.dir || DEFAULT_DIR);
  const target = path.join(dir, 'SKILL.md');
  if (fs.existsSync(target)) {
    if (!opts.force) {
      fail(`${target} 已存在，未覆盖。要更新请加 --force`, 1);
    }
    if (fs.statSync(target).isDirectory()) fail(`${target} 是目录，无法写入`, 1);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(target, content);
  process.stdout.write(`已写入 ${target}（teams-skill ${pkg.version}，${content.length} 字节）\n`);
}

main();
