// ===== YAML 渲染工具 =====
// 注意:YAML 1.1 会把裸词 off/on/yes/no/y/n 等解析为布尔值(例如 `sni: off` → false),
// 而 Clash/Mihomo 内核要求 sni/servername/host 等字段必须是字符串,
// 因此所有字符串值一律用双引号包裹,保证生成 `sni: "off"` 这类安全 YAML。
function yamlValue(v) {
	if (typeof v === 'number' || typeof v === 'boolean') return String(v);
	// 转义反斜杠、双引号与控制字符(如节点名里的换行/制表符/行分隔符),
	// 防止生成非法 YAML 导致 OpenClash/Mihomo 无法解析整个配置。
	return '"' + String(v)
		.replace(/\\/g, '\\\\')
		.replace(/"/g, '\\"')
		.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'))
		+ '"';
}

function yamlInline(obj) {
	const parts = [];
	for (const [k, v] of Object.entries(obj)) {
		if (v === undefined || v === null || v === '') continue;
		parts.push(k + ': ' + yamlValue(v));
	}
	return '{ ' + parts.join(', ') + ' }';
}

function yamlEmit(obj, indent) {
	const pad = ' '.repeat(indent);
	const out = [];
	for (const [k, v] of Object.entries(obj)) {
		// 注意:不能跳过空字符串!vmess/vless/trojan/ssr 的空 uuid/password 必须以 "" 输出,
		// 否则字段缺失会触发 mihomo 的 "has unset fields" 校验错误,导致整个配置文件加载失败。
		if (v === undefined || v === null) continue;
		if (Array.isArray(v)) {
			if (v.length === 0) continue;
			out.push(pad + k + ':');
			for (const item of v) {
				if (item && typeof item === 'object') out.push(pad + '  - ' + yamlInline(item));
				else out.push(pad + '  - ' + yamlValue(item));
			}
		} else if (v && typeof v === 'object') {
			out.push(pad + k + ':');
			out.push(yamlEmit(v, indent + 2));
		} else {
			out.push(pad + k + ': ' + yamlValue(v));
		}
	}
	return out.join('\n');
}

// Clash 中允许布尔值的字段;其余字段若出现布尔值(如 sni: false)一律视为"未设置"丢弃,
// 避免生成 `sni: false` 这类 YAML 解析后为布尔、被 Clash 内核以"sni 必须是字符串"拒绝的配置。
const CLASH_BOOL_KEYS = new Set(['tls', 'udp', 'skip-cert-verify', 'reduce-rtt', 'allowInsecure', 'insecure']);

// 规整代理对象:递归丢弃出现在字符串字段里的布尔值,并剥离 null/undefined。
function 规整Clash代理(p) {
	if (!p || typeof p !== 'object') return p;
	const out = {};
	for (const [k, v] of Object.entries(p)) {
		if (v === undefined || v === null) continue;
		if (Array.isArray(v)) {
			out[k] = v.map(x => (x && typeof x === 'object') ? 规整Clash代理(x) : x);
		} else if (v && typeof v === 'object') {
			const nested = 规整Clash代理(v);
			// 嵌套对象清空(如 headers: {Host: false})后直接丢弃,避免输出悬空的空映射
			if (Object.keys(nested).length === 0) continue;
			out[k] = nested;
		} else if (typeof v === 'boolean' && !CLASH_BOOL_KEYS.has(k)) {
			continue; // 布尔值出现在非布尔字段(如 sni/servername)→ 视为未设置
		} else {
			out[k] = v;
		}
	}
	return out;
}

// 渲染单个代理
function 渲染Clash代理(p) {
	return '- ' + yamlEmit(规整Clash代理(p), 2).slice(2);
}

// 渲染策略组
function 渲染Clash策略组(g) {
	const lines = [];
	lines.push('- name: ' + yamlValue(g.name));
	lines.push('  type: ' + g.type);
	if (g.url) {
		lines.push('  url: ' + yamlValue(g.url));
		if (g.interval) lines.push('  interval: ' + g.interval);
		if (g.tolerance) lines.push('  tolerance: ' + g.tolerance);
	}
	lines.push('  proxies:');
	for (const p of g.proxies) lines.push('    - ' + yamlValue(p));
	return lines.join('\n');
}

// ===== 规则获取(KV 缓存 + ACL4SSR 在线规则集) =====
const 内置Clash规则 = [
	'IP-CIDR,127.0.0.0/8,DIRECT,no-resolve',
	'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
	'IP-CIDR,172.16.0.0/12,DIRECT,no-resolve',
	'IP-CIDR,192.168.0.0/16,DIRECT,no-resolve',
];

// Mihomo 内置保留代理名 + 本生成器使用的策略组名。
// 规则引用了不存在的组会报 proxy [xxx] not found 并使整个配置加载失败,生成规则时必须校验。
const MIHOMO_RULE_GROUPS = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', 'GLOBAL', '🎯 全球直连', '🛑 全球拦截', '🌍 国外媒体', '📲 电报信息', '💬 Ai平台', '🚀 节点选择', '♻️ 自动选择', '🐟 漏网之鱼']);

// Mihomo/Meta 核心支持的规则类型白名单;其余类型(如 URL-REGEX)直接丢弃,
// 避免 OpenClash/Mihomo 因不支持的规则类型而报错或无法启动。
const MIHOMO_RULE_TYPES = new Set([
	'DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'DOMAIN-REGEX',
	'GEOIP', 'SRC-GEOIP', 'IP-CIDR', 'IP-CIDR6', 'SRC-IP-CIDR', 'SRC-IP-CIDR6',
	'DST-PORT', 'SRC-PORT', 'PROCESS-NAME', 'PROCESS-PATH',
	'IP-ASN', 'SRC-IP-ASN', 'GEOSITE', 'RULE-SET', 'NETWORK', 'USER-AGENT',
	'MATCH', 'AND', 'OR', 'NOT',
]);

// 规范化规则行:
//  1. 丢弃不支持的规则类型(如 URL-REGEX);
//  2. 修正 no-resolve 位置:Mihomo 要求 no-resolve 位于行末、策略名之后。
//     同时可兼容修复旧版本写入的错误缓存(IP-CIDR,x,x.x.x.x/x,no-resolve,组 之类)。
function 规范化Clash规则(raw) {
	const parts = String(raw || '').trim().split(',').map(s => s.trim()).filter(Boolean);
	if (parts.length < 2 || !parts[0]) return '';
	const type = parts[0].toUpperCase();
	if (!MIHOMO_RULE_TYPES.has(type)) return '';
	const hasNoResolve = parts.some(p => p.toLowerCase() === 'no-resolve');
	const rest = parts.slice(1).filter(p => p.toLowerCase() !== 'no-resolve');
	if (rest.length === 0) return '';
	// 规则最后一段是策略组名,必须存在于已知组集合,否则 mihomo 报 proxy [xxx] not found
	// 并使整个配置加载失败。MATCH 规则只有策略名一个参数,同样校验。
	const groupName = rest[rest.length - 1];
	if (!MIHOMO_RULE_GROUPS.has(groupName)) return '';
	return type + ',' + rest.join(',') + (hasNoResolve ? ',no-resolve' : '');
}

// 为规则行附加策略组:若行尾已有 no-resolve(如 ACL4SSR 的 IP-CIDR 行),
// 策略名必须插在 no-resolve 之前,否则 Mihomo 会把 no-resolve 当成代理名报
// "proxy [no-resolve] not found" 错误。
function 附加策略组(line, group) {
	const t = String(line).trim();
	return /,\s*no-resolve$/i.test(t)
		? t.replace(/,\s*no-resolve$/i, '') + ',' + group + ',no-resolve'
		: t + ',' + group;
}

async function 获取Clash规则(env) {
	const 基础规则 = [...内置Clash规则];
	if (!env.KV) {
		// 无 KV:回退内置精简规则(零外部依赖)
		基础规则.push('GEOIP,CN,DIRECT');
		基础规则.push('MATCH,🐟 漏网之鱼');
		return 基础规则;
	}
	try {
		const now = Date.now();
		const cached = await env.KV.get('CLASH_RULES.txt');
		const cachedAt = Number(await env.KV.get('CLASH_RULES_AT') || 0);
		if (cached && now - cachedAt < 24 * 3600 * 1000) {
			// 读缓存时同样规范化,兼容修复旧版本写入的错误 no-resolve 位置
			const lines = cached.split('\n').map(规范化Clash规则).filter(Boolean);
			if (lines.length > 0) {
				基础规则.push(...lines);
				基础规则.push('MATCH,🐟 漏网之鱼');
				return 基础规则;
			}
		}
		// 最近1小时内已尝试拉取失败:跳过网络请求,避免每次请求都阻塞
		const lastTry = Number(await env.KV.get('CLASH_RULES_TRY') || 0);
		if (now - lastTry < 3600 * 1000) {
			基础规则.push('GEOIP,CN,DIRECT');
			基础规则.push('MATCH,🐟 漏网之鱼');
			return 基础规则;
		}
		await env.KV.put('CLASH_RULES_TRY', String(now));
		// 缓存缺失或过期:并行拉取 ACL4SSR 规则集
		const results = await Promise.allSettled(ACL4SSR_RULES.map(r => fetch(r.url, { signal: AbortSignal.timeout(12000) }).then(res => res.ok ? res.text() : Promise.reject(new Error('HTTP ' + res.status))).catch(() => '')));
		const rules = [];
		const seen = new Set();
		for (let i = 0; i < ACL4SSR_RULES.length; i++) {
			const text = results[i].status === 'fulfilled' ? results[i].value : '';
			if (!text) continue;
			const group = ACL4SSR_RULES[i].group;
			for (const raw of text.split('\n')) {
				const line = raw.trim();
				if (!line || line.startsWith('#') || line.startsWith('!')) continue;
				// 先附加策略组,再规范化:修正 no-resolve 位置、丢弃不支持的类型
				const r = 规范化Clash规则(附加策略组(line, group));
				if (r && !seen.has(r)) { seen.add(r); rules.push(r); }
				if (rules.length >= 3000) break;
			}
			if (rules.length >= 3000) break;
		}
		if (rules.length === 0) {
			基础规则.push('GEOIP,CN,DIRECT');
			基础规则.push('MATCH,🐟 漏网之鱼');
			return 基础规则;
		}
		// 内容和时间戳使用相同 TTL,避免失效规则长期残留在 KV。
		await env.KV.put('CLASH_RULES.txt', rules.join('\n'), { expirationTtl: 24 * 3600 });
		await env.KV.put('CLASH_RULES_AT', String(now), { expirationTtl: 24 * 3600 });
		基础规则.push(...rules);
		基础规则.push('GEOIP,CN,DIRECT');
		基础规则.push('MATCH,🐟 漏网之鱼');
		return 基础规则;
	} catch (e) {
		基础规则.push('GEOIP,CN,DIRECT');
		基础规则.push('MATCH,🐟 漏网之鱼');
		return 基础规则;
	}
}

