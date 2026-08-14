#!/usr/bin/env node
// CloudSub 构建脚本
//
// 说明:
//   本项目源码按职责拆分在 src/ 目录下(便于维护),由于 Cloudflare Workers 的
//   「粘贴单个 _worker.js 到编辑器」部署方式与 test/test_subscription.mjs 都要求
//   一个可部署的单文件,因此本脚本把 src/ 下所有模块按固定顺序拼接回 _worker.js。
//   所有 src/*.js 均处于同一模块作用域(不做互相 import),拼接后语义与拆分前完全一致。
//
// 用法:
//   node build.js            # 重新生成 _worker.js
//   node build.js --check    # 仅校验 src 总行数是否等于当前 _worker.js,不覆盖写

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(__dirname, 'src');
const OUT = path.join(__dirname, '_worker.js');

// src/ 模块拼接顺序(即拆分时的原始行序,不可乱序改)
const FILES = [
	'00-constants.js',
	'10-handler.js',
	'15-notify.js',
	'20-http.js',
	'30-clash-parser.js',
	'40-singbox-parser.js',
	'50-multiformat-parser.js',
	'60-convert.js',
	'70-render-rules.js',
	'80-generators.js',
	'90-filter-dedup.js',
	'95-admin.js',
];

const checkOnly = process.argv.includes('--check');

let out = '';
for (const f of FILES) {
	const p = path.join(SRC_DIR, f);
	if (!fs.existsSync(p)) {
		console.error(`[build] 缺少源文件: ${f}`);
		process.exit(1);
	}
	out += fs.readFileSync(p, 'utf8');
}

if (checkOnly) {
	// 真正校验:拼接结果必须与已生成的 _worker.js 完全一致,
	// 否则说明 src/ 被改动后未重新 build,部署产物会落后于源码。
	const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;
	if (current !== out) {
		console.error('[build] --check: src/ 与 _worker.js 不一致,请先运行 node build.js 重新生成');
		process.exit(1);
	}
	console.log(`[build] --check: 通过,${out.length} 字节,src/ 与 _worker.js 一致`);
	process.exit(0);
}

fs.writeFileSync(OUT, out);
console.log(`[build] 已生成 _worker.js (${out.length} 字节)`);
