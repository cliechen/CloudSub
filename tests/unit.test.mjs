// CloudSub 离线单元测试(不联网,使用固定 fixture,可稳定在 CI 运行)
// 用法: node tests/unit.test.mjs
//
// 覆盖:
//   - hashText: 确定性 + 不同输入不同结果(聚合缓存键依赖它)
//   - 本地解析订阅内容: base64 / Clash YAML / 明文 三种输入
//   - 生成本地Clash配置 / 生成本地Singbox配置: 输出包含关键段落
//   - 节点去重 / 过滤协议节点
//
// 说明: 测试通过与 test_subscription.mjs 相同的“改造 __test 导出”方式,
// 直接加载构建产物 _worker.js(即 src/ 模块拼接后的同一份部署代码)。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '_worker.js');

if (!fs.existsSync(OUT)) {
	console.error('缺少构建产物 _worker.js,请先运行: node build.js');
	process.exit(1);
}

const workerSrc = fs
	.readFileSync(OUT, 'utf8')
	.replace('export default', 'module.exports =');
const tmpWorker = path.join('/tmp', `_worker_unit_${process.pid}.cjs`);
fs.writeFileSync(
	tmpWorker,
	workerSrc +
		'\nmodule.exports.__test = { hashText, 本地解析订阅内容, 节点去重, 节点协议, 过滤协议节点, 解析节点名, 剔除大陆节点, parseYamlValue, base64Decode, proxyURL, 生成本地Clash配置, 生成本地Singbox配置, getSUB };\n'
);
const mod = await import(pathToFileURL(tmpWorker).href);
const {
	hashText,
	本地解析订阅内容,
	节点去重,
	节点协议,
	过滤协议节点,
	解析节点名,
	剔除大陆节点,
	parseYamlValue,
	base64Decode,
	proxyURL,
	生成本地Clash配置,
	生成本地Singbox配置,
	getSUB,
} = mod.default.__test;
const worker = mod.default;

// getSUB 测试用的桩(只读取 Accept 头)
const 请求壳 = { headers: { get: () => null } };
const 默认限制 = { sources: 50, perSource: 10 * 1024 * 1024, total: 40 * 1024 * 1024, timeout: 20000 };

let passed = 0;
const results = [];
async function t(name, fn) {
	try {
		await fn();
		passed++;
		results.push(`  ✓ ${name}`);
	} catch (e) {
		results.push(`  ✗ ${name}\n      ${e.message}`);
	}
}

// ---- 测试用例 ----

await t('hashText 确定性 + 可区分', async () => {
	const a = await hashText('hello');
	const b = await hashText('hello');
	const c = await hashText('world');
	assert.equal(a, b, '相同输入应得到相同哈希');
	assert.equal(a.length, 64, 'SHA-256 十六进制应为 64 位');
	assert.notEqual(a, c, '不同输入应得到不同哈希');
});

await t('本地解析: base64 输入', async () => {
	const uris = [
		'vless://00000000-0000-0000-0000-000000000000@1.2.3.4:443?type=tcp#vl',
		'trojan://password@9.9.9.9:443#t2',
	].join('\n');
	const b64 = Buffer.from(uris, 'utf8').toString('base64');
	const parsed = 本地解析订阅内容(b64);
	assert.ok(parsed, '应能识别 base64');
	const lines = String(parsed.text).split('\n').filter(l => l.trim());
	assert.ok(lines.length >= 2, '应解析出至少 2 行节点');
	assert.ok(lines.some(l => l.startsWith('vless://')), '应包含 vless 节点');
});

await t('本地解析: Clash YAML 输入', async () => {
	const yaml = `proxies:
  - name: "test-vmess"
    type: vmess
    server: 1.2.3.4
    port: 443
    uuid: 00000000-0000-0000-0000-000000000000
    alterId: 0
    cipher: auto
    tls: true
    network: ws
    ws-opts:
      path: /path
      headers:
        Host: example.com
  - name: "test-ss"
    type: ss
    server: 5.6.7.8
    port: 8388
    cipher: aes-128-gcm
    password: secret
`;
	const parsed = 本地解析订阅内容(yaml);
	assert.ok(parsed, '应能识别 Clash YAML');
	const text = String(parsed.text);
	assert.ok(text.includes('vmess://'), '应包含 vmess URI');
	assert.ok(text.includes('ss://'), '应包含 ss URI');
});

await t('本地解析: 明文节点', async () => {
	const raw = 'vless://00000000-0000-0000-0000-000000000000@1.2.3.4:443?type=tcp#t';
	const parsed = 本地解析订阅内容(raw);
	assert.ok(parsed, '应能识别明文节点');
	assert.ok(String(parsed.text).includes('vless://'));
});

await t('节点去重 + 协议过滤', async () => {
	const text = [
		'vless://00000000-0000-0000-0000-000000000000@1.2.3.4:443?type=tcp#a',
		'vless://00000000-0000-0000-0000-000000000000@1.2.3.4:443?type=tcp#a', // 重复
		'trojan://password@9.9.9.9:443#b',
	].join('\n');
	const deduped = 节点去重(text);
	const lines = deduped.split('\n').filter(l => l.trim());
	assert.ok(lines.length <= 2, '重复节点应被去重');

	const onlyTrojan = 过滤协议节点(deduped, new Set(['trojan']));
	const trojanLines = onlyTrojan.split('\n').filter(l => l.includes('://'));
	assert.ok(trojanLines.every(l => 节点协议(l) === 'trojan'), '应只保留 trojan');
});

await t('生成本地Clash配置: 输出关键段落', async () => {
	const nodes = [
		'vmess://00000000-0000-0000-0000-000000000000@1.2.3.4:443?type=ws&path=%2Fpath&host=example.com#vm',
		'ss://YWVzLTEyOC1nY206cGFzc3dk@5.6.7.8:8388#ss',
	].join('\n');
	const cfg = await 生成本地Clash配置(nodes, {}, 'UnitTest');
	assert.ok(cfg.includes('proxies:'), '应包含 proxies');
	assert.ok(cfg.includes('proxy-groups:'), '应包含 proxy-groups');
	assert.ok(cfg.includes('rules:'), '应包含 rules');
	assert.ok(!cfg.includes('无可用节点'), '不应为空配置');
});

await t('生成本地Singbox配置: 输出 outbounds', async () => {
	const nodes = 'vless://00000000-0000-0000-0000-000000000000@1.2.3.4:443?type=tcp#sb';
	const cfg = await 生成本地Singbox配置(nodes, {}, 'UnitTest');
	assert.ok(cfg.includes('"outbounds"'), '应包含 outbounds');
	assert.ok(cfg.includes('"route"'), '应包含 route');
});

await t('getSUB 条件请求:304=未变化不下载,变化才下载', async () => {
	const SRC = 'https://a.example/sub';
	const originalFetch = globalThis.fetch;
	let 下载次数 = 0;
	globalThis.fetch = async (req) => {
		const headers = new Headers(req.headers);
		if (headers.get('If-None-Match') === '"v1"') {
			return new Response(null, { status: 304 });
		}
		下载次数++;
		const body = 'vless://00000000-0000-0000-0000-000000000000@1.2.3.4:443?type=tcp#a';
		return new Response(body, { status: 200, headers: { 'ETag': '"v1"' } });
	};
	try {
		// 首次:无条件凭据 -> 200 下载
		const 标记1 = {};
		const r1 = await getSUB([SRC], 请求壳, 'v2rayn', 'test', 'T', 默认限制, { etags: null, 标记: 标记1 });
		assert.ok(r1.length > 0, '首次应下载并返回节点');
		assert.equal(标记1.全部未变化, false, '首次应是“有变化”');

		// 第二次:带 etag=v1 -> 上游 304 -> 不下载 body
		const 标记2 = {};
		const r2 = await getSUB([SRC], 请求壳, 'v2rayn', 'test', 'T', 默认限制, {
			etags: { [SRC]: { etag: '"v1"', lastModified: '' } }, 标记: 标记2
		});
		assert.equal(r2.length, 0, '304 时不应返回新内容');
		assert.equal(标记2.全部未变化, true, '应标记为“全部未变化”');

		// 第三次:etag=v2(与上游 v1 不匹配) -> 200 -> 下载并记录新 etag
		const 标记3 = {};
		const r3 = await getSUB([SRC], 请求壳, 'v2rayn', 'test', 'T', 默认限制, {
			etags: { [SRC]: { etag: '"v2"', lastModified: '' } }, 标记: 标记3
		});
		assert.ok(r3.length > 0, 'etag 变化时应下载');
		assert.equal(标记3.全部未变化, false);
		assert.ok(标记3.新etags && 标记3.新etags[SRC], '应记录最新 etag 供下次使用');
		assert.equal(下载次数, 2, '仅真正变化(200)的两次被下载,304 那次不下载');
	} finally {
		globalThis.fetch = originalFetch;
	}
});

await t('剔除大陆节点: 名称含大陆关键词即剔除,港澳台/海外保留', async () => {
	const vmess_上海 = 'vmess://' + Buffer.from(JSON.stringify({
		v: '2', ps: '上海-01', add: '1.2.3.4', port: '443', id: '00000000-0000-0000-0000-000000000000',
		aes: 'auto', net: 'ws', path: '/', host: 'example.com'
	}), 'utf8').toString('base64');
	const text = [
		vmess_上海,
		'vless://00000000-0000-0000-0000-000000000000@1.2.3.4:443?type=tcp#北京BGP',
		'vless://00000000-0000-0000-0000-000000000000@5.5.5.5:443?type=tcp#%E4%B8%8A%E6%B5%B7', // 上海(URL 编码)
		'trojan://pw@1.2.3.5:443#上海联通',
		'trojan://pw@8.8.8.8:443#香港01',
		'trojan://pw@8.8.8.9:443#移动电信联通三网优化',
		'trojan://pw@8.8.8.7:443#东京三网优化',
		'trojan://pw@8.8.8.6:443#中国移动',
		'trojan://pw@9.9.9.9:443#Tokyo-01',
		'ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTpwYXNz@7.7.7.7:8443#东京',
	].join('\n');
	const out = 剔除大陆节点(text);
	const lines = out.split('\n').filter(l => l.trim());
	assert.ok(!lines.some(l => l.includes('上海-01')), '应剔除 vmess(ps=上海)');
	assert.ok(!lines.some(l => l.includes('北京BGP') || l.includes('5.5.5.5')), '应剔除 北京 / URL编码的上海');
	assert.ok(!lines.some(l => l.includes('1.2.3.5')), '应剔除「上海联通」(命中大陆地名)');
	assert.ok(!lines.some(l => l.includes('8.8.8.9')), '应剔除「移动电信联通三网优化」(含移动/联通/电信关键词)');
	assert.ok(!lines.some(l => l.includes('8.8.8.6')), '应剔除「中国移动」(含运营商关键词)');
	assert.ok(lines.some(l => l.includes('8.8.8.8')), '应保留香港节点');
	assert.ok(lines.some(l => l.includes('8.8.8.7')), '应保留「东京三网优化」(名称不含大陆关键词)');
	assert.ok(lines.some(l => l.includes('9.9.9.9') || l.includes('Tokyo')), '应保留海外节点');
	assert.ok(lines.some(l => l.includes('7.7.7.7')), '应保留东京节点');
});

await t('剔除大陆节点: 中国大陆节点剔除,「中国香港/中国台湾/中国澳门」保留', async () => {
	const text = [
		'vless://00000000-0000-0000-0000-000000000000@1.1.1.1:443?type=tcp#中国移动-01',
		'vless://00000000-0000-0000-0000-000000000000@1.1.1.2:443?type=tcp#中国电信',
		'vless://00000000-0000-0000-0000-000000000000@1.1.1.3:443?type=tcp#中国联通',
		'vless://00000000-0000-0000-0000-000000000000@1.1.1.4:443?type=tcp#中国大陆-01',
		'vless://00000000-0000-0000-0000-000000000000@1.1.1.5:443?type=tcp#%E4%B8%AD%E5%9B%BD%E5%A4%A7%E9%99%86', // 中国大陆(URL 编码)
		'vless://00000000-0000-0000-0000-000000000000@1.1.1.6:443?type=tcp#中国-01',
		'vless://00000000-0000-0000-0000-000000000000@2.2.2.1:443?type=tcp#中国香港-01',
		'vless://00000000-0000-0000-0000-000000000000@2.2.2.2:443?type=tcp#中国台湾',
		'vless://00000000-0000-0000-0000-000000000000@2.2.2.3:443?type=tcp#中国澳门',
		'trojan://pw@3.3.3.3:443#东京-01',
	].join('\n');
	const out = 剔除大陆节点(text);
	const lines = out.split('\n').filter(l => l.trim());
	assert.ok(!lines.some(l => l.includes('1.1.1.')), '应剔除全部中国移动/电信/联通/大陆类节点');
	assert.ok(lines.some(l => l.includes('2.2.2.1')), '应保留「中国香港-01」(不影响跨境使用)');
	assert.ok(lines.some(l => l.includes('2.2.2.2')), '应保留「中国台湾」');
	assert.ok(lines.some(l => l.includes('2.2.2.3')), '应保留「中国澳门」');
	assert.ok(lines.some(l => l.includes('3.3.3.3')), '应保留东京节点');
});

await t('解析节点名: 正确提取 vmess ps / # 片段 / ssr remarks', async () => {
	const vmess = 'vmess://' + Buffer.from(JSON.stringify({
		v: '2', ps: '香港-01', add: '1.2.3.4', port: '443', id: '00000000-0000-0000-0000-000000000000'
	}), 'utf8').toString('base64');
	assert.equal(解析节点名(vmess), '香港-01', 'vmess 应取 ps');
	assert.equal(解析节点名('vless://a@b:443?type=tcp#%E4%B8%8A%E6%B5%B7'), '上海', '# 片段应做 URL 解码');
	assert.equal(解析节点名('trojan://pw@8.8.8.8:443#大阪'), '大阪');
	assert.equal(解析节点名('http://a'), '', '无名称片段应返回空串');
});

await t('parseYamlValue: 正确处理转义引号,不截断名称', async () => {
	assert.equal(parseYamlValue('"a\\"b"'), 'a"b', '双引号内 \\" 转义应保留');
	assert.equal(parseYamlValue("'it''s'"), "it's", "单引号内 '' 转义应保留");
	assert.equal(parseYamlValue('"x\\nY"'), 'x\nY', '\\n 转义为换行');
	assert.equal(parseYamlValue('"off"'), 'off', '引号内的 off 保持字符串');
	assert.equal(parseYamlValue('a # c'), 'a', '未加引号的注释应剥离');
});

await t('base64Decode: 容忍空白与缺失 padding', async () => {
	assert.equal(base64Decode('aGVsbG8='), 'hello');
	assert.equal(base64Decode('aGVsbG8'), 'hello', '缺失 padding 应能解码');
	assert.equal(base64Decode('aGVs' + '\n' + 'bG8='), 'hello', '含换行空白应能解码');
	assert.equal(base64Decode('aGVsbG8='.replace(/\+/g, '-').replace(/\//g, '_')), 'hello'); // url-safe 无影响
});

await t('proxyURL: 转发请求的查询串而非代理源自身的', async () => {
	const originalFetch = globalThis.fetch;
	let captured = null;
	globalThis.fetch = async (input) => {
		captured = typeof input === 'string' ? input : input.url;
		return new Response('ok', { status: 200 });
	};
	try {
		// env.URL 为代理源(无 query),请求带 /sub?token=xxx
		await proxyURL('https://proxy.example/api', new URL('https://worker.example/sub?token=abc'));
		assert.equal(captured, 'https://proxy.example/api/sub?token=abc', '应拼接请求路径并转发查询串');
	} finally {
		globalThis.fetch = originalFetch;
	}
});

await t('HTTP 代理节点不被误当订阅链接拉取', async () => {
	const TOKEN = '550e8400-e29b-41d4-a716-446655440000';
	const store = new Map([['LINK.txt', 'http://u:p@1.2.3.4:8080#myHttp\nhttps://sub.example.com/sub\n']]);
	const kv = {
		async get(key) { return store.get(key) || null; },
		async put(key, value) { store.set(key, String(value)); },
		async delete(key) { store.delete(key); },
	};
	const originalFetch = globalThis.fetch;
	const fetched = [];
	globalThis.fetch = async input => {
		const target = typeof input === 'string' ? input : input.url;
		fetched.push(target.split('?')[0].split('#')[0]);
		if (target.includes('sub.example.com')) {
			return new Response('vless://00000000-0000-0000-0000-000000000000@5.6.7.8:443?type=tcp#fromSub', { status: 200 });
		}
		throw new Error('unexpected fetch: ' + target);
	};
	try {
		const env = { KV: kv, TOKEN: 'admin', SUBTOKEN: TOKEN };
		const request = () => new Request('https://worker.example/sub?token=' + TOKEN, {
			headers: { 'User-Agent': 'CloudSub test' },
		});
		const res = await worker.fetch(request(), env, { waitUntil() {} });
		assert.equal(res.status, 200);
		const body = res.text ? await res.text() : '';
		const decoded = Buffer.from(body, 'base64').toString('utf8');
		assert.ok(decoded.includes('myHttp'), 'http 代理节点应在聚合结果中');
		assert.ok(decoded.includes('fromSub'), '订阅源节点应被拉取并聚合');
		assert.ok(!fetched.some(t => t.includes('1.2.3.4')), '不应把 http 节点当作订阅地址去 fetch');
		assert.ok(fetched.some(t => t.includes('sub.example.com')), '应 fetch 真正的订阅链接');
	} finally {
		globalThis.fetch = originalFetch;
	}
});

await t('ProxyURL: 代理源无路径时也能正确拼接', async () => {
	const originalFetch = globalThis.fetch;
	let captured = null;
	globalThis.fetch = async (input) => { captured = typeof input === 'string' ? input : input.url; return new Response('ok', { status: 200 }); };
	try {
		await proxyURL('https://proxy.example', new URL('https://worker.example/sub?token=xyz'));
		assert.equal(captured, 'https://proxy.example/sub?token=xyz');
	} finally { globalThis.fetch = originalFetch; }
});

await t('订阅请求: base64 格式正确输出(含 unicode 节点名)', async () => {
	const TOKEN = '550e8400-e29b-41d4-a716-446655440000';
	const store = new Map([['LINK.txt', 'vless://00000000-0000-0000-0000-000000000000@1.2.3.4:443?type=tcp#名称-上海']]);
	const kv = { async get(k){ return store.get(k)||null; }, async put(k,v){ store.set(k,String(v)); }, async delete(k){ store.delete(k); } };
	try {
		const env = { KV: kv, TOKEN: 'admin', SUBTOKEN: TOKEN };
		const req = () => new Request('https://worker.example/sub?token=' + TOKEN, { headers: { 'User-Agent': 'CloudSub test' } });
		const res = await worker.fetch(req(), env, { waitUntil(){} });
		assert.equal(res.status, 200);
		const body = await res.text();
		const decoded = Buffer.from(body, 'base64').toString('utf8');
		assert.ok(decoded.includes('名称-上海'), 'base64 输出应完整保留 unicode 节点名');
		assert.ok(decoded.includes('vless://'), 'base64 输出应含节点链接');
		} finally { /* 本测未 mock fetch,不修改全局 */ }
});

await t('缓存过期+ETag 有效(304):去条件化重拉,不缓存残缺结果', async () => {
	const TOKEN = '550e8400-e29b-41d4-a716-446655440000';
	const SRC = 'https://etag.example/sub';
	const store = new Map([
		['LINK.txt', SRC],
		['SUB_ETAG:' + await hashText(SRC), JSON.stringify({ etag: '"v1"', lastModified: '' })], // 旧 ETag 仍在,聚合缓存已过期(无 SUB_AGG)
	]);
	const kv = {
		async get(key) { return store.get(key) || null; },
		async put(key, value, opts) { store.set(key, String(value)); },
		async delete(key) { store.delete(key); },
	};
	const originalFetch = globalThis.fetch;
	let conditional = 0, unconditional = 0;
	globalThis.fetch = async input => {
		const headers = new Headers(input.headers || {});
		if (headers.get('If-None-Match')) { conditional++; return new Response(null, { status: 304 }); }
		unconditional++;
		return new Response('vless://00000000-0000-0000-0000-000000000000@5.6.7.8:443?type=tcp#fromRefetch', { status: 200, headers: { 'ETag': '"v2"' } });
	};
	try {
		const env = { KV: kv, TOKEN: 'admin', SUBTOKEN: TOKEN };
		const request = () => new Request('https://worker.example/sub?token=' + TOKEN, {
			headers: { 'User-Agent': 'CloudSub test' },
		});
		const res = await worker.fetch(request(), env, { waitUntil() {} });
		assert.equal(res.status, 200);
		const decoded = Buffer.from(await res.text(), 'base64').toString('utf8');
		assert.ok(decoded.includes('fromRefetch'), '缓存过期+ETag 有效时应去条件化重拉拿到真实内容');
		assert.ok(!decoded.includes('# 无可用节点') && decoded.trim(), '结果不应为空/残缺');
		assert.ok(conditional >= 1, '应先用条件请求(304)');
		assert.ok(unconditional >= 1, '304 后应做无条件重拉');
	} finally {
		globalThis.fetch = originalFetch;
	}
});

await t('Worker 聚合缓存:第二次请求不重复拉取上游', async () => {
	const SRC = 'https://cache.example/sub';
	const TOKEN = '550e8400-e29b-41d4-a716-446655440000';
	const store = new Map([['LINK.txt', SRC]]);
	const kv = {
		async get(key) { return store.get(key) || null; },
		async put(key, value) { store.set(key, String(value)); },
		async delete(key) { store.delete(key); },
	};
	const originalFetch = globalThis.fetch;
	let sourceFetches = 0;
	globalThis.fetch = async input => {
		const target = typeof input === 'string' ? input : input.url;
		if (target === SRC) {
			sourceFetches++;
			return new Response('vless://00000000-0000-0000-0000-000000000000@1.2.3.4:443?type=tcp#cached', { status: 200 });
		}
		throw new Error('unexpected fetch: ' + target);
	};
	try {
		const env = { KV: kv, TOKEN: 'admin', SUBTOKEN: TOKEN };
		const request = () => new Request('https://worker.example/sub?token=' + TOKEN, {
			headers: { 'User-Agent': 'CloudSub test' },
		});
		const first = await worker.fetch(request(), env, { waitUntil() {} });
		const second = await worker.fetch(request(), env, { waitUntil() {} });
		assert.equal(first.status, 200);
		assert.equal(second.status, 200);
		assert.equal(sourceFetches, 1, '第二次请求应命中内存或 KV 聚合缓存');
	} finally {
		globalThis.fetch = originalFetch;
	}
});

await t('Clash 订阅: 正常返回 Clash 配置(回归: 空 else-if 吞掉 clash 分支)', async () => {
	const TOKEN = '550e8400-e29b-41d4-a716-446655440000';
	const NODES = [
		'vless://00000000-0000-0000-0000-000000000000@1.2.3.4:443?type=tcp#vl-01',
		'trojan://pw@8.8.8.8:443#tj-01',
		'ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTpwYXNz@7.7.7.7:8443#ss-01',
	].join('\n');
	const store = new Map([['LINK.txt', NODES]]);
	const kv = {
		async get(key) { return store.get(key) || null; },
		async put(key, value) { store.set(key, String(value)); },
		async delete(key) { store.delete(key); },
	};
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => { throw new Error('本测试不应拉取上游'); };
	try {
		const env = { KV: kv, TOKEN: 'admin', SUBTOKEN: TOKEN };
		const request = () => new Request('https://worker.example/sub?token=' + TOKEN, {
			headers: { 'User-Agent': 'ClashForAndroid/2.5.12' },
		});
		const res = await worker.fetch(request(), env, { waitUntil() {} });
		assert.ok(res, 'Clash 订阅不应返回 undefined(空 else-if 回归)');
		assert.equal(res.status, 200);
		const text = await res.text();
		assert.ok(text.includes('proxies:'), '应返回 Clash YAML(含 proxies 段)');
		assert.ok(text.includes('proxy-groups:'), '应返回 Clash YAML(含 proxy-groups 段)');
		assert.ok(!text.includes('无可用节点'), '不应为空配置');
	} finally {
		globalThis.fetch = originalFetch;
	}
});

await t('Clash 订阅 + 协议过滤: 只保留勾选协议节点', async () => {
	const TOKEN = '550e8400-e29b-41d4-a716-446655440000';
	const NODES = [
		'vless://00000000-0000-0000-0000-000000000000@1.2.3.4:443?type=tcp#vl-01',
		'trojan://pw@8.8.8.8:443#tj-01',
		'ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTpwYXNz@7.7.7.7:8443#ss-01',
	].join('\n');
	const store = new Map([['LINK.txt', NODES], ['PROTOCOL.txt', 'trojan']]);
	const kv = {
		async get(key) { return store.get(key) || null; },
		async put(key, value) { store.set(key, String(value)); },
		async delete(key) { store.delete(key); },
	};
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => { throw new Error('本测试不应拉取上游'); };
	try {
		const env = { KV: kv, TOKEN: 'admin', SUBTOKEN: TOKEN };
		const request = () => new Request('https://worker.example/sub?token=' + TOKEN, {
			headers: { 'User-Agent': 'ClashForAndroid/2.5.12' },
		});
		const res = await worker.fetch(request(), env, { waitUntil() {} });
		assert.ok(res, 'Clash 订阅不应返回 undefined');
		assert.equal(res.status, 200);
		const text = await res.text();
		// 协议过滤应先于格式生成生效: 结果里不应再有 vless/ss 节点
		assert.ok(!text.includes('vl-01'), 'vless 节点应被协议过滤剔除');
		assert.ok(!text.includes('ss-01'), 'ss 节点应被协议过滤剔除');
		assert.ok(text.includes('tj-01'), 'trojan 节点应保留');
	} finally {
		globalThis.fetch = originalFetch;
	}
});

// ---- 输出汇总 ----
console.log(`[unit] 通过 ${passed} / ${results.length}`);
for (const r of results) console.log(r);
process.exit(passed === results.length ? 0 : 1);
