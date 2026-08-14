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
		'\nmodule.exports.__test = { hashText, 本地解析订阅内容, 节点去重, 节点协议, 过滤协议节点, 解析节点名, 剔除大陆节点, 屏蔽节点, 是本地服务器地址, parseYamlValue, base64Decode, proxyURL, 生成本地Clash配置, 生成本地Singbox配置, 生成本地Surge配置, 生成本地Quanx配置, 生成本地Loon配置, singboxJSONtoURIs, 迁移地址列表, KV, getSUB, 解析中国IP文本, 中国IP匹配, 节点服务器地址, 清空实例缓存: () => { 内存缓存.clear(); 热点缓存.clear(); SWR调度记录.clear(); 迁移已执行 = false; } };\n'
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
	屏蔽节点,
	是本地服务器地址,
	parseYamlValue,
	base64Decode,
	proxyURL,
	生成本地Clash配置,
	生成本地Singbox配置,
	生成本地Surge配置,
	生成本地Quanx配置,
	生成本地Loon配置,
	singboxJSONtoURIs,
	迁移地址列表,
	KV,
	getSUB,
	解析中国IP文本,
	中国IP匹配,
	节点服务器地址,
	清空实例缓存,
} = mod.default.__test;
const worker = mod.default;

// getSUB 测试用的桩(只读取 Accept 头)
const 请求壳 = { headers: { get: () => null } };
const 默认限制 = { sources: 50, perSource: 10 * 1024 * 1024, total: 40 * 1024 * 1024, timeout: 20000 };

let passed = 0;
const results = [];
async function t(name, fn) {
	// 每次测试前清空实例级内存缓存(内存热缓存/热点缓存/SWR 调度/迁移标记),
	// 避免同一 Worker 模块实例下跨测试的状态污染(不同测试使用不同的 KV store)。
	清空实例缓存();
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

await t('生成本地Surge配置: 输出各段落, 跳过 vless', async () => {
	const nodes = [
		'vless://00000000-0000-0000-0000-000000000000@1.2.3.4:443?type=tcp#vl',
		'trojan://pw@8.8.8.8:443#tj',
		'ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTpwYXNz@7.7.7.7:8443#ss',
	].join('\n');
	const cfg = await 生成本地Surge配置(nodes, {}, 'UnitTest', 'https://worker.example/sub?token=x');
	assert.ok(cfg.includes('[Proxy]') && cfg.includes('[Proxy Group]') && cfg.includes('[Rule]'), '应包含 Surge 各段落');
	assert.ok(cfg.includes('8.8.8.8') && cfg.includes('7.7.7.7'), '应含 trojan/ss 节点');
	assert.ok(!cfg.includes('1.2.3.4'), 'vless 应被 Surge 跳过');
});

await t('生成本地Quanx配置: 输出各段落, 跳过 tuic', async () => {
	const nodes = [
		'ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTpwYXNz@7.7.7.7:8443#ss',
		'tuic://00000000-0000-0000-0000-000000000000:pw@8.8.8.8:443?sni=x.com#tuic',
	].join('\n');
	const cfg = await 生成本地Quanx配置(nodes, {}, 'UnitTest');
	assert.ok(cfg.includes('[server_local]') && cfg.includes('[policy]') && cfg.includes('[filter_local]'), '应包含 QX 各段落');
	assert.ok(cfg.includes('shadowsocks='), '应含 ss 节点');
	assert.ok(!cfg.includes('tuic='), 'tuic 应被 QX 跳过');
});

await t('生成本地Loon配置: 输出各段落, 跳过 socks5', async () => {
	const nodes = [
		'ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTpwYXNz@7.7.7.7:8443#ss',
		'socks5://u:p@8.8.8.8:1080#socks',
	].join('\n');
	const cfg = await 生成本地Loon配置(nodes, {}, 'UnitTest');
	assert.ok(cfg.includes('[Proxy]') && cfg.includes('[Proxy Group]') && cfg.includes('[Rule]'), '应包含 Loon 各段落');
	assert.ok(cfg.includes('Shadowsocks'), '应含 ss 节点');
	assert.ok(!cfg.includes('socks5'), 'socks5 应被 Loon 跳过');
});

await t('生成本地Loon配置: 残缺节点同样被校验丢弃(与其他格式生成器一致)', async () => {
	const b64 = s => Buffer.from(s, 'utf8').toString('base64');
	// vmess 无 uuid: uriToClashProxy 能解析但 校验节点 会拦截(Clash 生成器已丢弃,Loon 此前泄漏)
	const 无uuid = 'vmess://' + b64(JSON.stringify({ v: '2', ps: '无uuid', add: '1.2.3.4', port: '443', id: '', scy: 'auto' }));
	const good = 'ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTpwYXNz@7.7.7.7:8443#good';
	const cfg = await 生成本地Loon配置([无uuid, good].join('\n'), {}, 'UnitTest');
	assert.ok(!cfg.includes('无uuid'), '无 uuid 的 vmess 节点应被丢弃(避免输出不可用节点)');
	assert.ok(cfg.includes('good'), '合法节点不受影响');
});

await t('生成本地Loon配置: wireguard 输出 keepalive 字段拼写正确', async () => {
	const key = Buffer.from('a'.repeat(32)).toString('base64').replace(/=+$/, '');
	const wg = 'wireguard://1.2.3.4:51820?pvtkey=' + key + '&pubkey=' + key + '&ip=10.0.0.2#wg1';
	const cfg = await 生成本地Loon配置(wg, {}, 'UnitTest');
	assert.ok(cfg.includes('keepalive=45'), '应输出 keepalive(此前笔误为 keeyalive)');
	assert.ok(!cfg.includes('keeyalive'), '不应出现 keeyalive 笔误拼写');
});

await t('singboxJSONtoURIs: 解析 sing-box outbounds', async () => {
	const json = JSON.stringify({ outbounds: [
		{ type: 'vless', tag: 'v1', server: '1.2.3.4', server_port: 443, uuid: '00000000-0000-0000-0000-000000000000' },
		{ type: 'direct', tag: 'direct' }, // 非代理类型应被忽略
	] });
	const uris = singboxJSONtoURIs(json);
	assert.ok(uris.some(u => u.startsWith('vless://')), '应解析出 vless URI');
	assert.ok(!uris.some(u => u.includes('direct')), 'direct 等非代理 outbound 不应转换');
});

await t('本地解析: v2ray/Xray JSON 输入', async () => {
	const v2 = JSON.stringify({ outbounds: [
		{ protocol: 'vmess', tag: 'x', settings: { vnext: [ { address: '1.2.3.4', port: 443, users: [ { id: '00000000-0000-0000-0000-000000000000', alterId: 0, security: 'auto' } ] } ] },
			streamSettings: { network: 'ws', security: 'tls', wsSettings: { path: '/p', headers: { Host: 'h.example' } } } },
	] });
	const parsed = 本地解析订阅内容(v2);
	assert.ok(parsed && parsed.type === 'uris', '应识别 v2ray JSON');
	assert.ok(String(parsed.text).includes('vmess://'), '应含 vmess URI');
});

await t('本地解析: SS JSON 列表', async () => {
	const ss = JSON.stringify({ servers: [ { server: '1.2.3.4', server_port: 8388, method: 'aes-128-gcm', password: 'p' } ] });
	const parsed = 本地解析订阅内容(ss);
	assert.ok(parsed && parsed.type === 'uris', '应识别 SS JSON');
	assert.ok(String(parsed.text).includes('ss://'), '应含 ss URI');
});

await t('本地解析: Surge profile 输入', async () => {
	const surge = '[Proxy]\nproxy-a = ss, 1.2.3.4, 8388, encrypt-method=aes-128-gcm, password=pass\n';
	const parsed = 本地解析订阅内容(surge);
	assert.ok(parsed && parsed.type === 'uris', '应识别 Surge profile');
	assert.ok(String(parsed.text).includes('ss://'), '应含 ss URI');
});

await t('本地解析: Quantumult X 输入', async () => {
	const qx = '[server_local]\nshadowsocks=1.2.3.4:8388, method=aes-128-gcm, password=pass, tag=qx1\n';
	const parsed = 本地解析订阅内容(qx);
	assert.ok(parsed && parsed.type === 'uris', '应识别 QX 配置');
	assert.ok(String(parsed.text).includes('ss://'), '应含 ss URI');
});

await t('本地解析: base64 包裹 Clash YAML(递归识别)', async () => {
	const yaml = 'proxies:\n  - name: "t"\n    type: ss\n    server: 1.2.3.4\n    port: 8388\n    cipher: aes-128-gcm\n    password: p\n';
	const b64 = Buffer.from(yaml, 'utf8').toString('base64');
	const parsed = 本地解析订阅内容(b64);
	assert.ok(parsed && parsed.type === 'uris', '应递归解码并识别 base64 包裹的 YAML');
	assert.ok(String(parsed.text).includes('ss://'), '应含 ss URI');
});

await t('本地解析: 无法识别的内容返回 null', async () => {
	assert.equal(本地解析订阅内容('这不是订阅源内容'), null);
});

await t('管理页 KV(): GET 渲染订阅地址, POST 保存内容/协议', async () => {
	const store = new Map();
	const kv = { async get(k){ return store.get(k)||null; }, async put(k,v){ store.set(k,String(v)); }, async delete(k){ store.delete(k); } };
	const env = { KV: kv };
	// GET: 渲染页面并包含订阅 token
	const req = new Request('https://worker.example/auto?token=admin', { headers: { 'User-Agent': 'Mozilla/5.0 test' } });
	const res = await KV(req, env, 'LINK.txt', { subscriptionToken: '550e8400-e29b-41d4-a716-446655440000', fileName: 'CloudSub' });
	assert.equal(res.status, 200);
	const html = await res.text();
	assert.ok(html.includes('550e8400-e29b-41d4-a716-446655440000'), '页面应包含订阅 token');
	// POST: 保存订阅内容
	const post = new Request('https://worker.example/auto', { method: 'POST', body: 'vless://u@1.2.3.4:443#x\n' });
	const res2 = await KV(post, env, 'LINK.txt', {});
	assert.equal(res2.status, 200);
	assert.ok(store.get('LINK.txt').includes('vless://'), '内容应写入 KV');
	// POST: 保存协议过滤
	const postP = new Request('https://worker.example/auto?save=protocol', { method: 'POST', body: 'vmess,vless' });
	await KV(postP, env, 'LINK.txt', {});
	assert.equal(store.get('PROTOCOL.txt'), 'vmess,vless', '协议配置应写入 PROTOCOL.txt');
});

await t('迁移地址列表: 旧键 /LINK.txt 迁移到 LINK.txt 且只执行一次', async () => {
	const store = new Map([['/LINK.txt', 'old data']]);
	const kv = { async get(k){ return store.get(k)||null; }, async put(k,v){ store.set(k,String(v)); }, async delete(k){ store.delete(k); } };
	assert.equal(await 迁移地址列表({ KV: kv }, 'LINK.txt'), true, '首次应迁移');
	assert.equal(store.get('LINK.txt'), 'old data', '数据应写入新键');
	assert.ok(!store.has('/LINK.txt'), '旧键应删除');
	assert.equal(await 迁移地址列表({ KV: kv }, 'LINK.txt'), false, '第二次不应再迁移');
});

await t('SUBMAXNODES: 节点行数超过上限时截断', async () => {
	const TOKEN = '550e8400-e29b-41d4-a716-446655440000';
	const store = new Map([['LINK.txt', [
		'vless://00000000-0000-0000-0000-000000000000@1.2.3.4:443?type=tcp#a',
		'trojan://pw@8.8.8.8:443#b',
		'ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTpwYXNz@7.7.7.7:8443#c',
	].join('\n')]]);
	const kv = { async get(k){ return store.get(k)||null; }, async put(k,v){ store.set(k,String(v)); }, async delete(k){ store.delete(k); } };
	const env = { KV: kv, TOKEN: 'admin', SUBTOKEN: TOKEN, SUBMAXNODES: '2' };
	const request = () => new Request('https://worker.example/sub?token=' + TOKEN, { headers: { 'User-Agent': 'CloudSub test' } });
	const res = await worker.fetch(request(), env, { waitUntil() {} });
	assert.equal(res.status, 200);
	const decoded = Buffer.from(await res.text(), 'base64').toString('utf8');
	const nodeLines = decoded.split('\n').filter(l => l.includes('://'));
	assert.ok(nodeLines.length <= 2, `节点数应被截断到 SUBMAXNODES(实际 ${nodeLines.length})`);
});

await t('EXCLUDE: 排除指定订阅源不拉取', async () => {
	const TOKEN = '550e8400-e29b-41d4-a716-446655440000';
	const store = new Map([
		['LINK.txt', 'https://bad.example.com/sub\nhttps://good.example.com/sub\n'],
		['EXCLUDE.txt', 'bad.example.com'],
	]);
	const kv = { async get(k){ return store.get(k)||null; }, async put(k,v){ store.set(k,String(v)); }, async delete(k){ store.delete(k); } };
	const originalFetch = globalThis.fetch;
	const fetched = [];
	globalThis.fetch = async input => {
		const target = typeof input === 'string' ? input : input.url;
		fetched.push(target.split('?')[0].split('#')[0]);
		if (target.includes('good.example.com')) {
			return new Response('vless://00000000-0000-0000-0000-000000000000@5.6.7.8:443?type=tcp#fromGood', { status: 200 });
		}
		throw new Error('unexpected fetch: ' + target);
	};
	try {
		const env = { KV: kv, TOKEN: 'admin', SUBTOKEN: TOKEN };
		const request = () => new Request('https://worker.example/sub?token=' + TOKEN, { headers: { 'User-Agent': 'CloudSub test' } });
		const res = await worker.fetch(request(), env, { waitUntil() {} });
		assert.equal(res.status, 200);
		const decoded = Buffer.from(await res.text(), 'base64').toString('utf8');
		assert.ok(decoded.includes('fromGood'), '应拉取未被排除的源');
		assert.ok(!fetched.some(t => t.includes('bad.example.com')), '不应拉取被排除的源');
	} finally {
		globalThis.fetch = originalFetch;
	}
});

await t('订阅响应 ETag: If-None-Match 命中返回 304', async () => {
	const TOKEN = '550e8400-e29b-41d4-a716-446655440000';
	const store = new Map([['LINK.txt', 'vless://00000000-0000-0000-0000-000000000000@1.2.3.4:443?type=tcp#e']]);
	const kv = { async get(k){ return store.get(k)||null; }, async put(k,v){ store.set(k,String(v)); }, async delete(k){ store.delete(k); } };
	const env = { KV: kv, TOKEN: 'admin', SUBTOKEN: TOKEN };
	const first = await worker.fetch(new Request('https://worker.example/sub?token=' + TOKEN, { headers: { 'User-Agent': 'CloudSub test' } }), env, { waitUntil() {} });
	assert.equal(first.status, 200);
	const etag = first.headers.get('ETag');
	assert.ok(etag, '响应应带 ETag');
	const second = await worker.fetch(new Request('https://worker.example/sub?token=' + TOKEN, { headers: { 'User-Agent': 'CloudSub test', 'If-None-Match': etag } }), env, { waitUntil() {} });
	assert.equal(second.status, 304, 'If-None-Match 命中应返回 304');
});

await t('SS 插件校验: 非法 obfs/v2ray mode 丢弃,缺失 mode 默认合法', async () => {
	const b64ss = s => Buffer.from(s, 'utf8').toString('base64');
	const bad1 = 'ss://' + b64ss('aes-128-gcm:pw') + '@1.2.3.4:8388?plugin=' + encodeURIComponent('obfs-local;obfs=on;obfs-host=h.com') + '#bad1';
	const bad2 = 'ss://' + b64ss('aes-128-gcm:pw') + '@1.2.3.4:8388?plugin=' + encodeURIComponent('v2ray-plugin;mode=quic') + '#bad2';
	const good1 = 'ss://' + b64ss('aes-128-gcm:pw') + '@1.2.3.4:8388?plugin=' + encodeURIComponent('obfs-local;obfs-host=h.com') + '#good1';
	const good2 = 'ss://' + b64ss('aes-128-gcm:pw') + '@1.2.3.4:8388?plugin=' + encodeURIComponent('v2ray-plugin') + '#good2';
	const cfg = await 生成本地Clash配置([bad1, bad2, good1, good2].join('\n'), {}, 'SSPlugin');
	assert.ok(!cfg.includes('bad1'), 'obfs 非法模式(on)应丢弃节点,避免 mihomo obfs mode error 拖垮整个配置');
	assert.ok(!cfg.includes('bad2'), 'v2ray-plugin 非法模式(quic)应丢弃节点');
	assert.ok(cfg.includes('good1') && cfg.includes('mode: "http"'), 'obfs 缺失模式应默认 http 并保留');
	assert.ok(cfg.includes('good2') && cfg.includes('mode: "websocket"'), 'v2ray-plugin 缺失模式应默认 websocket 并保留');
});

await t('SS cipher 白名单: mihomo 支持的加密保留,chacha20-poly1305 仍丢弃', async () => {
	const b64ss = s => Buffer.from(s, 'utf8').toString('base64');
	const mk = c => 'ss://' + b64ss(c + ':pw') + '@1.2.3.4:8388#' + c.replace(/-/g, '_');
	const keep = ['aes-128-ccm', 'chacha8-ietf-poly1305', 'lea-256-gcm', 'aegis-256', 'aes-128-gcm-siv'];
	const drop = ['chacha20-poly1305', 'aes-999-cfb'];
	const cfg = await 生成本地Clash配置([...keep, ...drop].map(mk).join('\n'), {}, 'SSCipher');
	for (const c of keep) assert.ok(cfg.includes('cipher: "' + c + '"'), c + ' 应被保留');
	for (const c of drop) assert.ok(!cfg.includes('cipher: "' + c + '"'), c + ' 应被丢弃(mihomo 不支持)');
});

await t('协议字段校验: vmess cipher/alterId 非法值丢弃节点', async () => {
	const b64 = s => Buffer.from(s, 'utf8').toString('base64');
	const UUID = '00000000-0000-0000-0000-000000000000';
	const vm = (o, n) => 'vmess://' + b64(JSON.stringify({ v: '2', ps: n, add: '1.2.3.4', port: '443', id: UUID, ...o })) + '#' + n;
	const badCipher = vm({ scy: 'chacha20-ietf-poly1305' }, 'bad_cipher');
	const badAid = vm({ aid: 'abc' }, 'bad_aid');
	const good1 = vm({ scy: 'aes-128-gcm', aid: '64' }, 'good_cipher');
	const good2 = vm({ scy: 'AUTO' }, 'good_auto');
	const cfg = await 生成本地Clash配置([badCipher, badAid, good1, good2].join('\n'), {}, 'VMessCheck');
	assert.ok(!cfg.includes('bad_cipher'), 'vmess 非法 cipher 应丢弃节点(mihomo 只认 auto/aes-128-gcm/chacha20-poly1305/none)');
	assert.ok(!cfg.includes('bad_aid'), 'vmess 非数字 alterId 应丢弃节点');
	assert.ok(cfg.includes('good_cipher') && cfg.includes('cipher: "aes-128-gcm"'), '合法 cipher 应保留');
	assert.ok(cfg.includes('good_auto'), '大写 cipher 变体应保留');
});

await t('协议字段校验: hysteria2 obfs 仅接受 salamander+密码', async () => {
	const text = [
		'hysteria2://pw@1.2.3.4:443/?obfs=none&obfs-password=x#bad_obfs',
		'hysteria2://pw@1.2.3.4:443/?obfs=salamander#bad_nopw',
		'hysteria2://pw@1.2.3.4:443/?obfs=salamander&obfs-password=secret#good_obfs',
		'hysteria2://pw@1.2.3.4:443/#good_plain',
	].join('\n');
	const cfg = await 生成本地Clash配置(text, {}, 'Hy2Check');
	assert.ok(!cfg.includes('bad_obfs'), 'obfs=none 应丢弃节点');
	assert.ok(!cfg.includes('bad_nopw'), 'obfs=salamander 缺密码应丢弃节点');
	assert.ok(cfg.includes('good_obfs') && cfg.includes('obfs-password: "secret"'), 'salamander+密码应保留');
	assert.ok(cfg.includes('good_plain'), '无 obfs 应保留');
});

await t('协议字段校验: hysteria v1 up/down 必须正整数,缺省给默认值', async () => {
	const text = [
		'hysteria://1.2.3.4:443/?auth=x&upmbps=0&downmbps=100#bad_up0',
		'hysteria://1.2.3.4:443/?auth=x&upmbps=abc#bad_upabc',
		'hysteria://1.2.3.4:443/?auth=x&upmbps=1.5&downmbps=100#bad_float',
		'hysteria://1.2.3.4:443/?auth=x&upmbps=50&downmbps=200#good_num',
		'hysteria://1.2.3.4:443/?auth=x#good_default',
	].join('\n');
	const cfg = await 生成本地Clash配置(text, {}, 'Hy1Check');
	assert.ok(!cfg.includes('bad_up0'), 'up=0 应丢弃节点');
	assert.ok(!cfg.includes('bad_upabc'), 'up 非数字应丢弃节点');
	assert.ok(!cfg.includes('bad_float'), 'up 小数应丢弃节点');
	assert.ok(cfg.includes('good_num') && cfg.includes('up: "50"'), '正整数 up/down 应保留');
	assert.ok(cfg.includes('good_default'), '缺省 up/down 应保留并给默认值');
});

await t('协议字段校验: wireguard ip/reserved 非法值丢弃节点', async () => {
	const b64 = s => Buffer.from(s, 'utf8').toString('base64');
	const key = b64('a'.repeat(32)).replace(/=+$/, '');
	const wg = (extra, n) => 'wireguard://1.2.3.4:443?pvtkey=' + key + '&pubkey=' + key + extra + '#' + n;
	const cfg = await 生成本地Clash配置([
		wg('&ip=10.0.0.2/32', 'bad_cidr'),
		wg('&ip=2001:db8::1', 'bad_v6'),
		wg('&ip=01.02.03.04', 'bad_leading'),
		wg('&ip=999.999.999.999', 'bad_range'),
		wg('&ip=10.0.0.2&reserved=1,2', 'bad_rlen'),
		wg('&ip=10.0.0.2&reserved=1,2,999', 'bad_rval'),
		wg('&ip=10.0.0.2', 'good_wg'),
		wg('&ip=10.0.0.2&reserved=1,2,3', 'good_resv'),
	].join('\n'), {}, 'WgCheck');
	for (const n of ['bad_cidr', 'bad_v6', 'bad_leading', 'bad_range', 'bad_rlen', 'bad_rval']) {
		assert.ok(!cfg.includes(n), n + ' 应丢弃节点(ip/reserved 非法会让 mihomo 拒绝加载整个配置)');
	}
	assert.ok(cfg.includes('good_wg'), '合法 ip 应保留');
	assert.ok(cfg.includes('good_resv') && /reserved:\s*\n\s*- 1\s*\n\s*- 2\s*\n\s*- 3/.test(cfg), '合法 reserved(3字节)应保留');
});

await t('协议字段校验: anytls 数字字段必须正整数 + URI 尾部斜杠容忍', async () => {
	const text = [
		'anytls://pw@1.2.3.4:443/?idle-session-check-interval=abc#bad_idle',
		'anytls://pw@1.2.3.4:443/?idle-session-timeout=0#bad_timeout',
		'anytls://pw@1.2.3.4:443/?min-idle-session=5#good_min',
		'anytls://pw@1.2.3.4:443/#good_anytls',
		'hysteria2://pw@1.2.3.4:443/#good_slash',
	].join('\n');
	const cfg = await 生成本地Clash配置(text, {}, 'AnyTLSCheck');
	assert.ok(!cfg.includes('bad_idle'), 'anytls 非数字字段应丢弃节点');
	assert.ok(!cfg.includes('bad_timeout'), 'anytls 0 值应丢弃节点');
	assert.ok(cfg.includes('good_min') && cfg.includes('min-idle-session: 5'), 'anytls 正整数应保留');
	assert.ok(cfg.includes('good_anytls'), 'anytls 正常应保留');
	assert.ok(cfg.includes('good_slash'), '带尾部斜杠的 URI 不应被误丢');
});

await t('管理页保存: saveProtocol/saveNocn 均保留 URL token 参数', async () => {
	// 前端 JS 内嵌在 _worker.js 中,直接校验构建产物源码特征
	const worker = fs.readFileSync(OUT, 'utf8');
	assert.ok(!worker.includes("location.pathname + '?save=protocol'"), 'saveProtocol 不应再用 pathname(会丢 token)');
	assert.ok(worker.includes("searchParams.set('save', 'protocol')"), 'saveProtocol 应保留完整 URL(含 token)');
	assert.ok(worker.includes("searchParams.set('save', 'nocn')"), 'saveNocn 应保留完整 URL(含 token)');
});

await t('解析中国IP文本: CIDR 解析/合并 + 二分匹配(IPv4/IPv6)', async () => {
	const list = [
		'1.0.1.0/24',
		'1.0.2.0/23', // 与上一段相邻,应被合并
		'8.8.8.0/24',
		'2001:db8::/32',
		'# 注释行',
		'非法行',
	].join('\n');
	const data = 解析中国IP文本(list);
	assert.ok(data && data.v4.length === 2, '相邻 /24 与 /23 应合并为一段,共 2 段');
	assert.equal(data.v4[0][0], 0x01000100, '起始 IP 应正确');
	assert.equal(data.v4[0][1], 0x010003ff, '合并后的结束 IP 应正确');
	assert.ok(中国IP匹配(data, '1.0.1.5'), '1.0.1.5 应命中');
	assert.ok(中国IP匹配(data, '1.0.3.255'), '合并段边界应命中');
	assert.ok(中国IP匹配(data, '8.8.8.8'), '8.8.8.8 应命中');
	assert.ok(!中国IP匹配(data, '1.0.4.1'), '段外不应命中');
	assert.ok(!中国IP匹配(data, '9.9.9.9'), '9.9.9.9 不应命中');
	assert.ok(中国IP匹配(data, '2001:db8::1'), 'IPv6 应命中');
	assert.ok(!中国IP匹配(data, '2001:db9::1'), 'IPv6 段外不应命中');
});

await t('节点服务器地址: vmess/ssr/明文/IPv6 提取', async () => {
	assert.equal(节点服务器地址('vless://u@1.2.3.4:443?type=tcp#x'), '1.2.3.4');
	assert.equal(节点服务器地址('vless://u@[2001:db8::1]:443#x'), '2001:db8::1');
	assert.equal(节点服务器地址('ss://YWVzLTEyOC1nY206cA==@hk.example.com:8388#x'), 'hk.example.com');
	const vmess = 'vmess://' + Buffer.from(JSON.stringify({ v: '2', ps: 'x', add: '5.6.7.8', port: '443', id: 'u' }), 'utf8').toString('base64');
	assert.equal(节点服务器地址(vmess), '5.6.7.8');
	assert.equal(节点服务器地址('vless://u@1.2.3.4:443#x'), '1.2.3.4');
});

await t('剔除大陆节点: IP 优先匹配,域名回退名称关键词', async () => {
	const list = '1.0.1.5/24';
	const data = 解析中国IP文本(list);
	const text = [
		'vless://u@1.0.1.5:443?type=tcp#东京', // 大陆 IP + 境外名 → IP 为准,剔除
		'vless://u@1.0.1.5:443?type=tcp#香港01', // 大陆 IP + 港澳名 → IP 为准,剔除
		'vless://u@8.8.8.8:443?type=tcp#上海-BGP', // 境外 IP + 大陆名 → IP 为准,保留
		'vless://u@8.8.8.8:443?type=tcp#香港', // 境外 IP → 保留
		'vless://u@hk.example.com:443?type=tcp#上海', // 域名 → 名称关键词,剔除
		'vless://u@hk.example.com:443?type=tcp#香港', // 域名 → 名称关键词,保留
		'trojan://pw@1.0.1.5:443#大陆-01', // 大陆 IP → 剔除
	].join('\n');
	const out = 剔除大陆节点(text, data);
	const lines = out.split('\n').filter(l => l.includes('://'));
	assert.ok(!lines.some(l => l.includes('1.0.1.5')), '大陆 IP 节点应全部剔除(名称无法豁免)');
	assert.ok(!lines.some(l => l.includes('hk.example.com') && l.includes('上海')), '域名 + 大陆名应剔除');
	assert.ok(lines.some(l => l.includes('8.8.8.8')), '境外 IP 节点应保留');
	assert.ok(lines.some(l => l.includes('hk.example.com') && l.includes('香港')), '域名 + 港澳名应保留');
});

await t('剔除大陆节点: 无 IP 数据时回退纯名称关键词(兼容旧行为)', async () => {
	const text = [
		'vless://u@1.0.1.5:443?type=tcp#北京', // 大陆 IP 但无数据 → 名称判断剔除
		'vless://u@1.0.1.5:443?type=tcp#东京', // 大陆 IP 无数据且无关键词 → 保留(旧行为)
	].join('\n');
	const out = 剔除大陆节点(text, null);
	assert.ok(!out.includes('北京'), '名称含关键词应剔除');
	assert.ok(out.includes('东京'), '无数据时按名称判断,应保留');
});

await t('屏蔽节点: 本地/回环地址节点默认剔除(警示占位节点)', async () => {
	const b64 = s => Buffer.from(s, 'utf8').toString('base64');
	// NoMoreWalls 注入的「防范境外势力渗透」系列: server=127.0.0.53, 本地回环地址
	const vmessWarn = 'vmess://' + b64(JSON.stringify({ v: '2', ps: '防范境外势力渗透', add: '127.0.0.53', port: '80', id: 'x', scy: 'auto' }));
	const text = [
		vmessWarn,
		'vless://u@127.0.0.1:443?type=tcp#本地',
		'vless://u@localhost:443?type=tcp#本地域名',
		'vless://u@0.0.0.0:443?type=tcp#全零',
		'vless://u@8.8.8.8:443?type=tcp#正常节点',
		'ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTpwYXNz@1.2.3.4:8388#正常SS',
	].join('\n');
	const out = 屏蔽节点(text);
	assert.ok(!out.includes('防范境外势力渗透'), '127.0.0.53 警示节点应剔除');
	assert.ok(!out.includes('127.0.0.1'), '127.0.0.1 应剔除');
	assert.ok(!out.includes('localhost'), 'localhost 应剔除');
	assert.ok(!out.includes('0.0.0.0'), '0.0.0.0 应剔除');
	assert.ok(out.includes('正常节点') && out.includes('正常SS'), '正常节点不受影响');
});

await t('屏蔽节点: 名称命中内置/配置屏蔽词剔除,无关节点保留', async () => {
	const text = [
		'vless://u@1.2.3.4:443?type=tcp#防范境外势力渗透', // 命中内置默认词
		'vless://u@1.2.3.4:443?type=tcp#可能已经被中间替换', // 命中内置默认词(中间替换)
		'vless://u@1.2.3.4:443?type=tcp#请勿用于非法用途', // 命中内置默认词
		'vless://u@1.2.3.4:443?type=tcp#自定义屏蔽词A', // 命中配置词
		'vless://u@1.2.3.4:443?type=tcp#香港-01', // 正常节点
		'vless://u@1.2.3.4:443?type=tcp#日本 东京', // 正常节点
	].join('\n');
	const out = 屏蔽节点(text, ['自定义屏蔽词A']);
	assert.ok(!out.includes('防范境外势力渗透'), '内置默认词应命中');
	assert.ok(!out.includes('中间替换'), '内置默认词应命中');
	assert.ok(!out.includes('非法用途'), '内置默认词应命中');
	assert.ok(!out.includes('自定义屏蔽词A'), '配置词应命中');
	assert.ok(out.includes('香港-01') && out.includes('日本 东京'), '正常节点应保留');
});

await t('是本地服务器地址: 回环/全零/域名判定,普通 IP 排除', async () => {
	assert.ok(是本地服务器地址('127.0.0.1'));
	assert.ok(是本地服务器地址('127.0.0.53'));
	assert.ok(是本地服务器地址('0.0.0.0'));
	assert.ok(是本地服务器地址('localhost'));
	assert.ok(是本地服务器地址('::1'));
	assert.ok(!是本地服务器地址('8.8.8.8'));
	assert.ok(!是本地服务器地址('1.2.3.4'));
	assert.ok(!是本地服务器地址('example.com'));
	assert.ok(!是本地服务器地址('2001:db8::1'));
});

// ---- 输出汇总 ----
console.log(`[unit] 通过 ${passed} / ${results.length}`);
for (const r of results) console.log(r);
process.exit(passed === results.length ? 0 : 1);
