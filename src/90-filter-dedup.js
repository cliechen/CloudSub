// ==================== 按协议过滤大订阅 ====================
// 识别一行节点链接的协议类型(取 :// 前的 scheme,小写),非节点行返回空串
function 节点协议(line) {
	const s = String(line).trim();
	const idx = s.indexOf('://');
	if (idx === -1) return '';
	let scheme = s.slice(0, idx).toLowerCase().trim();
	if (scheme === 'hy2') scheme = 'hysteria2';
	return scheme;
}

// 按允许的协议集合过滤大订阅内容;协议过滤为空(未设置)时返回原文,即全部显示
function 过滤协议节点(text, allowed) {
	const src = String(text || '');
	if (!allowed || allowed.size === 0) return src;
	return src.split('\n').filter(line => {
		const s = line.trim();
		if (!s) return false;
		return allowed.has(节点协议(s));
	}).join('\n');
}

// ==================== 节点去重 ====================
// 生成节点的去重身份键:忽略 #名称 片段、排序 query 参数、归一化 vmess/ssr,
// 这样不同来源订阅中“一模一样”的节点(仅名称或参数顺序不同)也能被识别为重复。

function 节点去重身份(line) {
	try {
		if (line.startsWith('vmess://')) {
			// 解码 JSON,剔除 ps(名称)字段后按排序键重新序列化
			const json = JSON.parse(base64Decode(line.slice(8)));
			delete json.ps;
			const obj = {};
			for (const k of Object.keys(json).sort()) obj[k] = json[k];
			return 'vmess://' + JSON.stringify(obj);
		}
		if (line.startsWith('ssr://')) {
			// 解码后剔除 remarks(名称)参数
			const decoded = base64Decode(line.slice(6));
			const m = decoded.split('/?');
			const params = (m[1] || '').split('&').filter(p => !p.startsWith('remarks=')).sort();
			const clean = m[0] + (params.length ? '/?' + params.join('&') : '');
			return 'ssr://' + btoaUnicode(clean);
		}
		let base = line.split('#')[0]; // 去掉 #名称 片段
		const qIdx = base.indexOf('?');
		if (qIdx !== -1) {
			// 排序 query 参数,避免顺序不同导致误判为不同节点
			base = base.slice(0, qIdx) + '?' + base.slice(qIdx + 1).split('&').filter(Boolean).sort().join('&');
		}
		return base;
	} catch (e) {
		return line; // 解析失败按整行比较
	}
}

// ==================== 本地 GeoIP:中国大陆 IP 段匹配(零第三方 IP 查询接口) ====================
// 从 GitHub 下载中国 IP 段(CIDR 列表,17mon/china_ip_list)后完全本地匹配:
//   - 数据经 KV 缓存(7 天) + 实例内存缓存(1 小时),不向任何 IP 归属查询网站发请求;
//   - 服务器为 IP 字面量的节点:直接二分匹配中国 IP 段,比名称关键词更准确
//     (机场常给大陆节点起境外名,或给境外节点起大陆名,名称不可靠);
//   - 服务器为域名(Worker 内无法做 DNS 解析)或未加载到 IP 数据时:回退到名称关键词判断。

// 从节点行中提取服务器地址(host,不含端口);vmess/ssr 需要解码 base64,其余取 @ 后主机部分。
function 节点服务器地址(line) {
	try {
		const s = String(line || '').trim();
		if (s.startsWith('vmess://')) {
			const json = JSON.parse(base64Decode(s.slice(8)));
			if (json && json.add) return String(json.add);
			return '';
		}
		if (s.startsWith('ssr://')) {
			const decoded = base64Decode(s.slice(6));
			const core = decoded.split('/?')[0].split(':');
			return core[0] || '';
		}
		const hashIdx = s.indexOf('#');
		let body = hashIdx === -1 ? s : s.slice(0, hashIdx);
		const schemeIdx = body.indexOf('://');
		if (schemeIdx === -1) return '';
		body = body.slice(schemeIdx + 3);
		const atIdx = body.lastIndexOf('@');
		if (atIdx !== -1) body = body.slice(atIdx + 1);
		const m = body.match(/^(\[[0-9a-fA-F:]+\]|[^:/?#]+)/);
		if (!m) return '';
		return m[1].replace(/^\[|\]$/g, '');
	} catch (e) {
		return '';
	}
}

// 判断字符串是否为 IP 字面量(IPv4 或 IPv6),域名返回 false
function 是IP字面量(host) {
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
		return host.split('.').every(o => Number(o) <= 255);
	}
	if (host.includes(':')) return /^[0-9a-fA-F:]+$/.test(host);
	return false;
}

function 解析IPv4(ip) {
	const parts = ip.split('.');
	if (parts.length !== 4) return null;
	let num = 0;
	for (const p of parts) {
		if (!/^\d{1,3}$/.test(p)) return null;
		const o = Number(p);
		if (o > 255) return null;
		num = (num << 8) | o;
	}
	return num >>> 0;
}

// 简化 IPv6 解析:标准 8 组 + :: 压缩,不支持内嵌 IPv4(中国 IP 段列表不包含)
function 解析IPv6(ip) {
	const parts = String(ip).split('::');
	if (parts.length > 2) return null;
	const head = parts[0] ? parts[0].split(':') : [];
	const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
	const groups = [];
	for (const g of head) {
		const v = parseInt(g, 16);
		if (isNaN(v) || v > 0xffff) return null;
		groups.push(v);
	}
	if (parts.length === 2) {
		const missing = 8 - head.length - tail.length;
		if (missing < 1) return null;
		for (let i = 0; i < missing; i++) groups.push(0);
	}
	for (const g of tail) {
		const v = parseInt(g, 16);
		if (isNaN(v) || v > 0xffff) return null;
		groups.push(v);
	}
	if (groups.length !== 8) return null;
	let num = 0n;
	for (const g of groups) num = (num << 16n) | BigInt(g);
	return num;
}

// 单个 CIDR -> { type:'v4'|'v6', start, end }(含边界),非法返回 null
function CIDR转区间(cidr) {
	const m = String(cidr).match(/^([0-9a-fA-F:.]+)\/(\d{1,3})$/);
	if (!m) return null;
	const ip = m[1];
	const bits = Number(m[2]);
	if (ip.includes(':')) {
		const num = 解析IPv6(ip);
		if (num === null || bits > 128) return null;
		const hostBits = 128 - bits;
		const start = hostBits === 128 ? 0n : (num >> BigInt(hostBits)) << BigInt(hostBits);
		const end = hostBits === 128 ? 0xffffffffffffffffffffffffffffffffn : start + ((1n << BigInt(hostBits)) - 1n);
		return { type: 'v6', start, end };
	}
	const num = 解析IPv4(ip);
	if (num === null || bits > 32) return null;
	const hostBits = 32 - bits;
	const start = hostBits === 32 ? 0 : (num >>> hostBits) << hostBits;
	const end = hostBits === 32 ? 0xffffffff : start + ((1 << hostBits) - 1);
	return { type: 'v4', start: start >>> 0, end: end >>> 0 };
}

// 解析 CIDR 文本列表 -> { v4: 合并排序区间[], v6: 合并排序区间[] },无有效行返回 null
function 解析中国IP文本(text) {
	const v4 = [];
	const v6 = [];
	for (const line of String(text || '').split(/\r?\n/)) {
		const cidr = line.trim();
		if (!cidr || cidr.startsWith('#') || cidr.startsWith(';')) continue;
		const r = CIDR转区间(cidr);
		if (!r) continue;
		if (r.type === 'v4') v4.push([r.start, r.end]);
		else v6.push([r.start, r.end]);
	}
	if (v4.length === 0 && v6.length === 0) return null;
	return { v4: 合并区间(v4), v6: 合并区间(v6), 行数: v4.length + v6.length };
}

// 排序 + 合并相邻/重叠区间,产出互不重叠的升序区间数组,供二分查找
function 合并区间(list) {
	if (list.length < 2) return list;
	list.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	const out = [list[0]];
	for (let i = 1; i < list.length; i++) {
		const last = out[out.length - 1];
		const cur = list[i];
		const step = typeof last[1] === 'bigint' ? 1n : 1;
		if (cur[0] <= last[1] + step) {
			if (cur[1] > last[1]) last[1] = cur[1];
		} else {
			out.push(cur);
		}
	}
	return out;
}

// 在有序区间数组上二分查找
function 区间二分查找(区间, num) {
	let lo = 0, hi = 区间.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const r = 区间[mid];
		if (num < r[0]) hi = mid - 1;
		else if (num > r[1]) lo = mid + 1;
		else return true;
	}
	return false;
}

// 判断 IP 是否命中中国 IP 段(本地匹配,不请求任何外部接口)
function 中国IP匹配(数据, ip) {
	if (!数据 || !ip) return false;
	if (ip.includes(':')) {
		if (!数据.v6 || 数据.v6.length === 0) return false;
		const num = 解析IPv6(ip);
		return num !== null && 区间二分查找(数据.v6, num);
	}
	if (!数据.v4 || 数据.v4.length === 0) return false;
	const num = 解析IPv4(ip);
	return num !== null && 区间二分查找(数据.v4, num);
}

// ===== 中国 IP 段数据获取(KV 7 天缓存 + 实例内存 1 小时缓存 + 失败退避) =====
// 与 CLASH_RULES 同一套缓存思路:平时零网络请求,仅在 KV 过期且未在退避期内才去 GitHub 下载。
const 中国IP源 = [
	{ url: 'https://raw.githubusercontent.com/17mon/china_ip_list/master/china_ip_list.txt', name: '17mon-raw' },
	{ url: 'https://cdn.jsdelivr.net/gh/17mon/china_ip_list@master/china_ip_list.txt', name: '17mon-jsdelivr' },
	{ url: 'https://fastly.jsdelivr.net/gh/17mon/china_ip_list@master/china_ip_list.txt', name: '17mon-fastly' },
];
const 中国IP内存 = { 数据: null, 版本: '', at: 0 }; // at=0 表示从未成功加载
const 中国IP缓存有效期 = 7 * 24 * 3600 * 1000; // 7 天
const 中国IP重试退避 = 3600 * 1000; // 失败后 1 小时内不重复下载

async function 获取中国IP数据(env) {
	const now = Date.now();
	// 1) 实例内存缓存:避免每请求重新读 KV / 重新解析数万条 CIDR
	if (中国IP内存.数据 && now - 中国IP内存.at < 3600 * 1000) return 中国IP内存;
	// 2) KV 缓存
	if (env && env.KV) {
		try {
			const raw = await env.KV.get('CHINA_IP.txt');
			const at = Number(await env.KV.get('CHINA_IP_AT') || 0);
			if (raw && now - at < 中国IP缓存有效期) {
				const d = 解析中国IP文本(raw);
				if (d) { 中国IP内存.数据 = d; 中国IP内存.版本 = String(at); 中国IP内存.at = now; return 中国IP内存; }
			}
		} catch (e) { /* KV 异常则走下载 */ }
	}
	// 3) 失败退避:1 小时内不重复尝试下载(有 KV 时以 KV 的 CHINA_IP_TRY 为准)
	if (now - 中国IP内存.at < 中国IP重试退避) return 中国IP内存.数据 ? 中国IP内存 : null;
	if (env && env.KV) {
		try {
			const lastTry = Number(await env.KV.get('CHINA_IP_TRY') || 0);
			if (now - lastTry < 中国IP重试退避) return 中国IP内存.数据 ? 中国IP内存 : null;
			await env.KV.put('CHINA_IP_TRY', String(now), { expirationTtl: 3600 });
		} catch (e) { /* 忽略 */ }
	}
	// 4) 按顺序尝试各源下载
	for (const 源 of 中国IP源) {
		try {
			const res = await fetch(源.url, { signal: AbortSignal.timeout(15000) });
			if (!res.ok) continue;
			const text = await res.text();
			const d = 解析中国IP文本(text);
			if (d) {
				中国IP内存.数据 = d; 中国IP内存.版本 = String(now); 中国IP内存.at = now;
				if (env && env.KV) {
					try {
						await env.KV.put('CHINA_IP.txt', text, { expirationTtl: 7 * 24 * 3600 });
						await env.KV.put('CHINA_IP_AT', String(now), { expirationTtl: 7 * 24 * 3600 });
					} catch (e) { /* 忽略 */ }
				}
				return 中国IP内存;
			}
		} catch (e) { /* 尝试下一个源 */ }
	}
	return 中国IP内存.数据 ? 中国IP内存 : null;
}

// ==================== 剔除中国大陆节点 ====================
// 优先本地 GeoIP:服务器为 IP 字面量时按中国 IP 段精确匹配(不请求第三方 IP 查询接口);
// 服务器为域名(Worker 内无法 DNS 解析)或未加载到 IP 数据时,回退到名称关键词判断:
//   1. 关键词包含:省份/直辖市/重点城市/中国/大陆/内地/国内/境内 等地域词,以及
//      大陆运营商词(移动/联通/电信/天翼/铁通)。
//   2. 故意不包含 香港/澳门/台湾,因此这些地区节点不会误删。
const 大陆地域词 = /北京|上海|广州|深圳|天津|重庆|成都|杭州|南京|武汉|西安|长沙|郑州|青岛|大连|东莞|福州|厦门|昆明|长春|沈阳|哈尔滨|乌鲁木齐|呼和浩特|南宁|贵阳|兰州|拉萨|银川|西宁|石家庄|太原|济南|合肥|南昌|苏州|无锡|宁波|温州|佛山|珠海|中山|惠州|汕头|湛江|三亚|常州|南通|徐州|扬州|嘉兴|绍兴|金华|台州|泉州|烟台|潍坊|临沂|淄博|济宁|泰安|洛阳|襄阳|宜昌|株洲|湘潭|岳阳|衡阳|绵阳|德阳|宜宾|南充|赣州|上饶|遵义|保定|廊坊|秦皇岛|唐山|邯郸|咸阳|宝鸡|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|内蒙古|广西|西藏|宁夏|新疆|中国|大陆|内地|国内|境内|移动|联通|电信|天翼|铁通/;

// 安全解码:仅当字符串含 % 时才尝试 URL 解码(vmess ps / # 片段可能被百分号编码),
// 解码失败时保留原始字符串,避免误报。
function 安全解码(v) {
	if (typeof v !== 'string') return '';
	if (v.includes('%')) { try { return decodeURIComponent(v); } catch (e) { /* 保留原样 */ } }
	return v;
}

// 解析一行节点链接的「显示名称」:vmess 取 base64 JSON 的 ps,ssr 取 remarks,
// 其余协议取 # 后的片段(尽量做 URL 解码);解析不到名称返回空串。
function 解析节点名(line) {
	const s = String(line || '').trim();
	if (!s) return '';
	try {
		if (s.startsWith('vmess://')) {
			const json = JSON.parse(base64Decode(s.slice(8)));
			if (json && json.ps) return 安全解码(String(json.ps));
			// vmess 无 ps 时回退到 # 片段
		}
		if (s.startsWith('ssr://')) {
			const decoded = base64Decode(s.slice(6));
			const m = decoded.match(/remarks=([^&]*)/);
			if (m) return 安全解码(m[1]);
		}
	} catch (e) { /* 解析失败回退到 # 片段 */ }
	const hash = s.lastIndexOf('#');
	if (hash !== -1) return 安全解码(s.slice(hash + 1));
	return '';
}

// 剔除「大陆节点」:名称命中「大陆关键词」的节点直接剔除,其余一律保留(宁缺毋滥)。
// 特例:名称含「香港/澳门/台湾」的节点(如「中国香港-01」「中国台湾」)不影响跨境使用,一律保留。
function 剔除大陆节点(text, 中国IP数据 = null) {
	const src = String(text || '');
	return src.split('\n').filter(line => {
		const s = line.trim();
		if (!s) return true; // 保留空行
		// 本地 GeoIP:服务器为 IP 字面量时以 IP 归属为准(名称不可靠,机场常乱起名)
		if (中国IP数据) {
			const host = 节点服务器地址(s);
			if (host && 是IP字面量(host)) {
				return !中国IP匹配(中国IP数据, host); // 命中中国 IP 段即剔除
			}
		}
		// 域名节点 / 未加载到 IP 数据:回退到名称关键词判断
		const 名 = 解析节点名(s);
		if (!名) return true; // 取不到名称(注释等)一律保留
		if (/香港|澳门|台湾/.test(名)) return true; // 港澳台节点保留(如「中国香港」)
		return !大陆地域词.test(名);
	}).join('\n');
}

// ==================== 屏蔽警示/占位节点 ====================
// 部分公开订阅源会注入「警示节点」:如 NoMoreWalls 的「防范境外势力渗透 #0~#9」,
// 服务器指向回环地址(127.0.0.53)等本地地址,永远连不上,纯占位/提醒性质。
// 屏蔽策略(两层,均不请求外部接口):
//   1. 服务器为本地/回环地址(127.0.0.0/8、0.0.0.0、::1、::、localhost):
//      正常节点不可能指向本地地址,默认一律剔除;
//   2. 节点名含屏蔽词(内置默认警示词 + BLOCKWORDS 配置追加):
//      命中即剔除,覆盖作者改用真实服务器 IP 放警示节点的场景。

// 判断服务器地址是否为本地/回环地址(不可能提供代理服务的地址)
function 是本地服务器地址(host) {
	if (!host) return false;
	const h = String(host).trim().toLowerCase();
	if (h === 'localhost' || h === '0.0.0.0' || h === '::' || h === '::1') return true;
	if (h.includes(':')) return false; // 其余 IPv6 不判
	const m = h.match(/^(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
	return !!m && Number(m[1]) === 127; // 127.0.0.0/8 回环段
}

// 内置默认警示词(覆盖常见的订阅源注入文案;BLOCKWORDS 配置在此基础上追加)
const 默认屏蔽词 = ['防范境外势力', '境外势力', '中间替换', '非法用途', '请勿用于', '已被劫持', '勿用于'];

// 转义正则特殊字符,防止用户配置的屏蔽词破坏正则
function 转义正则(s) {
	return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 屏蔽警示/占位节点:服务器为本地地址或名称命中屏蔽词的节点剔除,其余保留
function 屏蔽节点(text, 额外词 = []) {
	const 词表 = [...默认屏蔽词, ...(Array.isArray(额外词) ? 额外词 : [])].filter(w => w && String(w).trim());
	const 正则 = 词表.length ? new RegExp(词表.map(w => 转义正则(String(w).trim())).join('|')) : null;
	return String(text || '').split('\n').filter(line => {
		const s = line.trim();
		if (!s) return true; // 保留空行
		// 1) 本地/回环地址节点:默认剔除
		const host = 节点服务器地址(s);
		if (host && 是本地服务器地址(host)) return false;
		// 2) 名称命中屏蔽词:剔除
		if (正则) {
			const 名 = 解析节点名(s);
			if (名 && 正则.test(名)) return false;
		}
		return true;
	}).join('\n');
}

// 文本去重:同一节点(忽略名称差异)仅保留第一次出现的行
function 节点去重(text) {
	const uniqueLines = [];
	const seen = new Set();
	for (const line of text.split('\n')) {
		const id = 节点去重身份(line);
		if (!line || !id) {
			// 空行/注释等非节点行:按原始行去重(与旧行为一致)
			if (seen.has('RAW:' + line)) continue;
			seen.add('RAW:' + line);
			uniqueLines.push(line);
			continue;
		}
		if (seen.has(id)) continue;
		seen.add(id);
		uniqueLines.push(line);
	}
	return uniqueLines.join('\n');
}

