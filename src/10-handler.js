// ===== 实例内存热缓存(纯 Worker 内,避免高频请求每次都读 KV) =====
// 聚合结果在“上游未变化”前提下是确定性的,故内存缓存与 KV 缓存可安全并存。
// 注意:Worker 实例可能被回收,内存缓存只是热点加速层,KV 才是权威。
const 内存TTL秒 = 60;
const 内存缓存 = new Map(); // key -> { value, expireAt }
function 内存缓存取(key) {
	const e = 内存缓存.get(key);
	if (!e) return null;
	if (Date.now() > e.expireAt) { 内存缓存.delete(key); return null; }
	return e.value;
}
function 内存缓存放(key, value) {
	if (!value) return;
	if (内存缓存.size >= 1024) { // 简单清理过期项,防止无限增长
		for (const [k, v] of 内存缓存) { if (Date.now() > v.expireAt) 内存缓存.delete(k); }
	}
	内存缓存.set(key, { value, expireAt: Date.now() + 内存TTL秒 * 1000 });
}

// ===== 热点键内存缓存(低频变更的 KV 键,如 LINK.txt / PROTOCOL.txt / NOCN.txt / EXCLUDE.txt) =====
// 这些键每次请求都会被读取,而内容极少变化,30 秒内存缓存可显著减少 KV 读取次数;
// 管理页保存时会主动失效(热点缓存删),因此编辑后同实例内立即生效,KV 跨实例传播延迟可接受。
const 热点缓存 = new Map(); // key -> { value, expireAt }
const 热点TTL毫秒 = 30 * 1000;
function 热点缓存取(key) {
	const e = 热点缓存.get(key);
	if (!e) return undefined;
	if (Date.now() > e.expireAt) { 热点缓存.delete(key); return undefined; }
	return e.value;
}
function 热点缓存存(key, value) {
	if (热点缓存.size >= 256) { // 简单清理过期项,防止无限增长
		for (const [k, v] of 热点缓存) { if (Date.now() > v.expireAt) 热点缓存.delete(k); }
	}
	热点缓存.set(key, { value, expireAt: Date.now() + 热点TTL毫秒 });
}
function 热点缓存删(key) { 热点缓存.delete(key); }
async function 热点KV读(env, key) {
	const hit = 热点缓存取(key);
	if (hit !== undefined) return hit;
	let v = null;
	try { v = await env.KV.get(key); } catch (e) { v = null; }
	热点缓存存(key, v);
	return v;
}

// 旧键(/LINK.txt)数据迁移只需每实例执行一次,避免每次请求都做两次 KV 读取
let 迁移已执行 = false;

// ===== 格式成品内存缓存 =====
// 聚合缓存(SUB_AGG)保存的是节点文本,clash/singbox/surge/qx/loon 的成品配置此前每次请求都全量重生成;
// 这里按「缓存键 + 格式 + 订阅名」对成品做秒级内存缓存,大幅减少大订阅下的重复解析/生成开销。
// 强制刷新(&refresh)时跳过缓存,且 执行聚合刷新 产生新结果时会清空全部 FMT:* 条目,保证不返回旧格式配置。
async function 生成配置缓存(键, fn, 强制 = false) {
	if (!强制) {
		const v = 内存缓存取(键);
		if (v != null) return v;
	}
	const v = await fn();
	内存缓存放(键, v);
	return v;
}

// ===== 订阅源条件请求凭据(ETag / Last-Modified)存取 =====
// 用于“有变化才下载”:后台刷新带上上次 ETag,上游返回 304 则不下载 body。
async function 读取源条件(env, urls) {
	if (!env || !env.KV || !urls || urls.length === 0) return null;
	const 表 = {};
	await Promise.all(urls.map(async u => {
		try {
			const raw = await env.KV.get('SUB_ETAG:' + await hashText(u));
			if (raw) { const o = JSON.parse(raw); if (o && (o.etag || o.lastModified)) 表[u] = o; }
		} catch (e) { /* 该源无凭据则做一次普通请求 */ }
	}));
	return Object.keys(表).length ? 表 : null;
}
async function 保存源条件(env, 新表, ttlHours = 24) {
	if (!env || !env.KV || !新表) return;
	await Promise.all(Object.entries(新表).map(async ([u, v]) => {
		try {
			// 与聚合缓存(SUB_AGG)采用相同 TTL,避免 ETag 常驻而聚合缓存已过期:
			// 否则上游返回 304 时因无旧缓存而重建出"缺失所有订阅源节点"的残缺结果。
			await env.KV.put('SUB_ETAG:' + await hashText(u), JSON.stringify(v), { expirationTtl: ttlHours * 3600 });
		} catch (e) { /* 忽略 */ }
	}));
}

// ===== 执行一次聚合刷新并写缓存 =====
// 使用条件请求(ETag)实现“有变化才下载”:多数刷新周期源未变化(304)时不下载 body。
// 返回新的 过滤结果;若全部源都未变化且存在可复用的旧缓存,则“不下载、不重建、仅续期”,返回 null。
async function 执行聚合刷新({ MainData, 订阅链接数组, 协议过滤, 剔除大陆, 中国IP数据, 屏蔽词, WARP, env, request, 追加UA, userAgentHeader, fileName, 拉取限制, KV缓存键, 时间戳键, SUBUpdateTime, 写缓存, 旧缓存 }) {
	const etags = await 读取源条件(env, 订阅链接数组);
	const 标记 = {};
	let req_data = MainData;
	if (订阅链接数组.length > 0) {
		let 订阅内容 = await getSUB(订阅链接数组, request, 追加UA, userAgentHeader, fileName, 拉取限制, { etags, 标记 });
		// 全部源 304(未变化)且有旧缓存可复用:沿用旧值,仅续期时间戳,不下载、不重建。
		if (标记.全部未变化 && 旧缓存) {
			if (写缓存 && env.KV) {
				try { await env.KV.put(时间戳键, String(Date.now()), { expirationTtl: SUBUpdateTime * 3600 }); } catch (e) { /* 忽略 */ }
			}
			内存缓存放(KV缓存键, 旧缓存);
			return null;
		}
		// 全部源 304 但无旧缓存(缓存已过期而 ETag 仍有效):不能据 304 重建内容,
		// 必须去条件化重拉一次,否则会缓存一份缺失所有订阅源节点的残缺结果。
		if (标记.全部未变化) {
			console.log('全部源 304 但无旧缓存,已去条件化重拉,避免缓存残缺结果');
			const 新标记 = {};
			订阅内容 = await getSUB(订阅链接数组, request, 追加UA, userAgentHeader, fileName, 拉取限制, { etags: null, 标记: 新标记 });
			标记.新etags = 新标记.新etags || 标记.新etags;
		}
		if (订阅内容.length > 0) req_data += '\n' + 订阅内容.join('\n');
		// 持久化本次获取到的最新源 ETag(与缓存同 TTL,避免 ETag 比缓存活得久)
		if (标记.新etags) await 保存源条件(env, 标记.新etags, SUBUpdateTime);
	}

	if (WARP) {
		const warpNodes = await ADD(WARP);
		if (warpNodes.length > 0) req_data += '\n' + warpNodes.join('\n');
	}
	//去重 + 按协议过滤 (+ 可选剔除大陆节点)
	const text = new TextDecoder().decode(new TextEncoder().encode(req_data));
	let 过滤结果 = 过滤协议节点(节点去重(text), 协议过滤);
	// 屏蔽警示/占位节点:本地地址节点默认剔除,名称命中屏蔽词(内置 + BLOCKWORDS)的剔除
	过滤结果 = 屏蔽节点(过滤结果, 屏蔽词 || []);
	if (剔除大陆) 过滤结果 = 剔除大陆节点(过滤结果, 中国IP数据 || null);
	// 节点行数上限(SUBMAXNODES):超大订阅按行截断,保证 KV 缓存不超 2MiB 上限、响应可控
	if (拉取限制 && 拉取限制.nodes && 拉取限制.nodes > 0) {
		const 行 = 过滤结果.split('\n');
		if (行.length > 拉取限制.nodes) 过滤结果 = 行.slice(0, 拉取限制.nodes).join('\n');
	}

	if (写缓存 && env.KV && 过滤结果) {
		const bytes = new TextEncoder().encode(过滤结果).byteLength;
		if (bytes <= MAX_KV_CONTENT_BYTES) {
			try {
				await env.KV.put(KV缓存键, 过滤结果, { expirationTtl: SUBUpdateTime * 3600 });
				await env.KV.put(时间戳键, String(Date.now()), { expirationTtl: SUBUpdateTime * 3600 });
			} catch (e) {
				console.error(`聚合缓存写入失败: ${KV缓存键}, ${bytes} 字节, ${e?.message || e}`);
			}
		} else {
			console.error(`聚合结果超过项目 KV 缓存安全上限,跳过缓存: ${KV缓存键}, ${bytes} 字节`);
		}
	}
	// 新聚合结果已生成:清掉按旧结果生成的格式成品缓存(FMT:*),避免后续请求复用旧格式配置
	if (写缓存) {
		for (const k of 内存缓存.keys()) { if (k.startsWith('FMT:')) 内存缓存.delete(k); }
	}
	内存缓存放(KV缓存键, 过滤结果);
	return 过滤结果;
}

// ===== 触发后台刷新(SWR,访问驱动) =====
// 缓存靠近过期且被访问时,把刷新放到 ctx.waitUntil 后台执行,用户请求不阻塞。
// 双防抖(实例内存 + KV),避免每个请求都去读 KV 防抖键,也避免多实例并发重复调度。
const SWR调度记录 = new Map(); // 防抖键 -> 上次调度时间戳(实例内存)
async function 触发后台刷新(ctx, env, 缓存键, 时间戳键, SUBUpdateTime, 当前值, 刷新参数) {
	try {
		const 防抖键 = 'SUB_REFRESH_AT:' + 缓存键;
		// 1) 实例内存节流:每实例每键每 5 分钟才真正访问 KV 一次
		const 上次数值 = SWR调度记录.get(防抖键) || 0;
		if (Date.now() - 上次数值 < 5 * 60 * 1000) return;
		SWR调度记录.set(防抖键, Date.now());
		// 只有缓存接近 TTL 过期时才刷新。时间戳缺失时按旧缓存处理,避免永久不刷新。
		let 缓存时间 = 0;
		try { 缓存时间 = Number(await env.KV.get(时间戳键) || 0); } catch (e) { /* 按缺失时间戳处理 */ }
		const ttlMs = SUBUpdateTime * 3600 * 1000;
		const refreshWindowMs = Math.max(5 * 60 * 1000, Math.min(ttlMs / 5, 60 * 60 * 1000));
		if (缓存时间 && Date.now() - 缓存时间 < Math.max(0, ttlMs - refreshWindowMs)) return;
		// 2) KV 防抖:防止多实例/多请求并发调度同一刷新
		let 最近刷 = 0;
		try { 最近刷 = Number(await env.KV.get(防抖键) || 0); } catch (e) { 最近刷 = 0; }
		if (Date.now() - 最近刷 < 5 * 60 * 1000) return; // 5 分钟内已调度则跳过
		try { await env.KV.put(防抖键, String(Date.now()), { expirationTtl: 600 }); } catch (e) { return; }
		ctx.waitUntil((async () => {
			try {
				await 执行聚合刷新({ ...刷新参数, 写缓存: true, 旧缓存: 当前值 || null });
			} catch (e) { console.error('后台刷新失败:', e && e.message || e); }
		})());
	} catch (e) { /* 忽略后台刷新调度错误 */ }
}

export default {
	async fetch(request, env, ctx) {
		const userAgentHeader = request.headers.get('User-Agent');
		const userAgent = userAgentHeader ? userAgentHeader.toLowerCase() : "null";
		const url = new URL(request.url);
		const token = url.searchParams.get('token');
		const adminToken = env.TOKEN || DEFAULT_TOKEN;
		if (!/^[A-Za-z0-9_-]{1,128}$/.test(adminToken)) {
			return new Response('TOKEN 配置无效', { status: 500 });
		}
		const subscriptionToken = env.SUBTOKEN || env.SUBUUID || '';
		if (!UUID_PATTERN.test(subscriptionToken)) {
			return new Response('SUBTOKEN 配置无效，请设置 UUID 格式的 SUBTOKEN 或 SUBUUID', { status: 500 });
		}
		if (subscriptionToken.toLowerCase() === adminToken.toLowerCase()) {
			return new Response('TOKEN 与 SUBTOKEN 不能相同', { status: 500 });
		}
		const BotToken = env.TGTOKEN || '';
		const ChatID = env.TGID || '';
		const TG = Number(env.TG || 0);
		// 通知开关统一由 TG=1 控制(与 README 变量表一致);IPINFO=0 时通知不再查询 ip-api.com 归属地
		const 推送通知 = TG === 1;
		const 跳过IP归属 = String(env.IPINFO || '') === '0';
		const fileName = String(env.SUBNAME || DEFAULT_FILE_NAME).slice(0, 80);
		const SUBUpdateTime = Math.min(168, Math.max(1, Number(env.SUBUPTIME) || DEFAULT_UPDATE_TIME));

		// 订阅源拉取限制(环境变量覆盖,见常量定义处;均设硬上限防内存超限)
		const 拉取限制 = {
			sources: Math.min(500, Math.max(1, Number(env.SUBMAXSOURCE) || DEFAULT_MAX_SUB_SOURCES)),
			perSource: Math.min(HARD_MAX_SUB_RESPONSE_BYTES, Math.max(1, Number(env.SUBMAXSIZE) || DEFAULT_MAX_SUB_RESPONSE_BYTES)),
			total: Math.min(HARD_MAX_SUB_TOTAL_BYTES, Math.max(1, Number(env.SUBMAXTOTAL) || DEFAULT_MAX_SUB_TOTAL_BYTES)),
			timeout: Math.min(HARD_MAX_SUB_TIMEOUT_MS, Math.max(1000, Number(env.SUBMAXTIME) || DEFAULT_SUB_FETCH_TIMEOUT_MS)),
			nodes: Math.min(HARD_MAX_SUB_NODES, Math.max(1, Number(env.SUBMAXNODES) || DEFAULT_MAX_SUB_NODES)),
		};

		let MainData = DEFAULT_MAIN_DATA;
		let urls = [];

		const isPathAdminAuth = url.pathname === `/${adminToken}`;
		const isAdminAuth = token === adminToken || isPathAdminAuth;
		const isSubscriptionAuth = token === subscriptionToken;
		// 管理页识别:浏览器 UA 或 Accept: text/html 任一满足即可(UA 可伪造,Accept 更贴近真实页面请求);
		// 管理页内保存请求均带 Accept: text/html,详见 95-admin.js。
		const isManagementRequest = isAdminAuth && (userAgent.includes('mozilla') || String(request.headers.get('Accept') || '').toLowerCase().includes('text/html')) && (
			isPathAdminAuth || (token === adminToken && url.pathname === '/') || (url.searchParams.get('save') === 'protocol' && isAdminAuth)
		);
		if (!(isAdminAuth || isSubscriptionAuth)) {
			// 通知改为后台异步(ctx.waitUntil)发送,不再阻塞请求响应
			if (推送通知 && url.pathname !== "/" && url.pathname !== "/favicon.ico") ctx.waitUntil(sendMessage(`#异常访问 ${fileName}`, request.headers.get('CF-Connecting-IP'), `UA: ${userAgent}</tg-spoiler>\n域名: ${url.hostname}\n<tg-spoiler>入口: ${url.pathname}</tg-spoiler>`, BotToken, ChatID, 跳过IP归属));
			if (env.URL302) return Response.redirect(env.URL302, 302);
			else if (env.URL) return await proxyURL(env.URL, url);
			else return new Response(await nginx(), {
				status: 200,
				headers: {
					'Content-Type': 'text/html; charset=UTF-8',
				},
			});
		} else {
			if (isAdminAuth && !isManagementRequest) {
				return new Response('管理 Token 仅用于配置页面', { status: 403, headers: { 'Cache-Control': 'no-store' } });
			}
			if (!['GET', 'HEAD'].includes(request.method) && !(isManagementRequest && request.method === 'POST')) {
				return new Response('Method Not Allowed', { status: 405, headers: { 'Allow': 'GET, HEAD' } });
			}			if (env.KV) {
				if (!迁移已执行) { await 迁移地址列表(env, 'LINK.txt'); 迁移已执行 = true; }
				if (isManagementRequest) {
					if (推送通知) ctx.waitUntil(sendMessage(`#编辑订阅 ${fileName}`, request.headers.get('CF-Connecting-IP'), `UA: ${userAgentHeader}</tg-spoiler>\n域名: ${url.hostname}\n<tg-spoiler>入口: ${url.pathname}</tg-spoiler>`, BotToken, ChatID, 跳过IP归属));
					return await KV(request, env, 'LINK.txt', { subscriptionToken, fileName });
				} else {
					MainData = await 热点KV读(env, 'LINK.txt') || '';
				}
			} else {
				MainData = env.LINK || '';
				urls = env.LINKSUB ? await ADD(env.LINKSUB) : [];
			}
			// 读取协议过滤配置(用于最后合成大订阅时按协议勾选显示)
			// 来源: KV 命名空间 PROTOCOL.txt,或环境变量 PROTOCOL。值为逗号/分号/换行分隔的协议名列表
			const 协议过滤 = new Set();
			const 协议过滤配置 = env.KV ? await 热点KV读(env, 'PROTOCOL.txt') : (env.PROTOCOL || '');
			if (协议过滤配置) {
				for (const p of String(协议过滤配置).split(/[,;\n]+/)) {
					const t = p.trim().toLowerCase();
					if (t) 协议过滤.add(t);
				}
			}
			// 读取「剔除大陆节点」开关(可选项)
			// 来源: KV 命名空间 NOCN.txt,或环境变量 NOCN。值为 1/true/on/yes/开/是 时启用。
			const 剔除大陆 = /^(1|true|on|yes|开|是)$/i.test(String((env.KV ? await 热点KV读(env, 'NOCN.txt') : (env.NOCN || '')) || '').trim());
			// 本地 GeoIP 中国 IP 段数据(KV 缓存,零第三方 IP 查询接口);域名节点仍走名称关键词回退
			const 中国IP数据 = 剔除大陆 ? await 获取中国IP数据(env) : null;
			// 排除订阅源:按 URL 片段匹配(一行一个,支持逗号/分号分隔),命中即不拉取该源
			// 来源: KV 命名空间 EXCLUDE.txt,或环境变量 EXCLUDE。
			const 排除配置 = env.KV ? await 热点KV读(env, 'EXCLUDE.txt') : (env.EXCLUDE || '');
			const 排除列表 = String(排除配置 || '').split(/[\n,;]+/).map(s => s.trim()).filter(s => s.length >= 4);
			// 节点屏蔽词:名称含任一关键词的节点剔除(警示/占位节点,如「防范境外势力渗透」)。
			// 来源: KV 命名空间 BLOCKWORDS.txt,或环境变量 BLOCKWORDS;在项目内置默认词基础上追加。
			const 屏蔽词配置 = env.KV ? await 热点KV读(env, 'BLOCKWORDS.txt') : (env.BLOCKWORDS || '');
			const 屏蔽词 = String(屏蔽词配置 || '').split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);

			let 重新汇总所有链接 = await ADD(MainData + '\n' + urls.join('\n'));
			let 自建节点 = "";
			let 订阅链接 = "";
			// 区分“http/https 订阅链接”与“http/https 代理节点”:
			// 形如 http(s)://[user:pass@]host:port[#name] 或结尾是 host:port 的,是节点而非订阅地址。
			// 否则会把 http 代理节点误当远程订阅去拉取。
			const 是Http节点 = (x) => /^https?:\/\//i.test(x)
				&& (/^https?:\/\/[^/]*@[^/]+:\d+/i.test(x) || /^https?:\/\/[^/]+:\d+([?#]|$)/i.test(x));
			for (let x of 重新汇总所有链接) {
				if (/^https?:\/\//i.test(x) && !是Http节点(x)) {
					订阅链接 += x + '\n';
				} else {
					自建节点 += x + '\n';
				}
			}
			MainData = 自建节点;
			urls = await ADD(订阅链接);
			// 通知后台异步发送,不阻塞订阅响应
			if (推送通知) ctx.waitUntil(sendMessage(`#获取订阅 ${fileName}`, request.headers.get('CF-Connecting-IP'), `UA: ${userAgentHeader}</tg-spoiler>\n域名: ${url.hostname}\n<tg-spoiler>入口: ${url.pathname}</tg-spoiler>`, BotToken, ChatID, 跳过IP归属));
			const isSubConverterRequest = request.headers.get('subconverter-request') || request.headers.get('subconverter-version') || userAgent.includes('subconverter');
			let 订阅格式 = 'base64';
			if (!(userAgent.includes('null') || isSubConverterRequest || userAgent.includes('nekobox') || userAgent.includes(('CloudSub').toLowerCase()))) {
				if (userAgent.includes('sing-box') || userAgent.includes('singbox') || url.searchParams.has('sb') || url.searchParams.has('singbox')) {
					订阅格式 = 'singbox';
				} else if (userAgent.includes('surge') || url.searchParams.has('surge')) {
					订阅格式 = 'surge';
				} else if (userAgent.includes('quantumult') || url.searchParams.has('quanx')) {
					订阅格式 = 'quanx';
				} else if (userAgent.includes('loon') || url.searchParams.has('loon')) {
					订阅格式 = 'loon';
				} else if (userAgent.includes('clash') || userAgent.includes('meta') || userAgent.includes('mihomo') || url.searchParams.has('clash')) {
					订阅格式 = 'clash';
				}
			}

			// 追加UA 仅用于 getSUB 拉取上游时的标识;格式仍在下方按 订阅格式 本地生成
			let 追加UA = 'v2rayn';
			if (url.searchParams.has('b64') || url.searchParams.has('base64')) 订阅格式 = 'base64';
			else if (url.searchParams.has('clash')) 追加UA = 'clash';
			else if (url.searchParams.has('singbox')) 追加UA = 'singbox';
			else if (url.searchParams.has('surge')) 追加UA = 'surge';
			else if (url.searchParams.has('quanx')) 追加UA = 'Quantumult%20X';
			else if (url.searchParams.has('loon')) 追加UA = 'Loon';

			const 订阅链接数组 = [...new Set(urls)].filter(item => item?.trim?.()).filter(u => !排除列表.some(e => u.includes(e))).slice(0, 拉取限制.sources); // 去重、排除指定源并限制来源数量

			// ===== 聚合结果缓存(性能优化) =====
			// 把「聚合、去重、按协议过滤后的最终节点文本」按 自建节点+订阅源列表+协议过滤+WARP
			// 的哈希缓存在 KV(SUB_AGG:<sha256>),一份缓存服务所有格式(base64/clash/singbox/...)。
			// 三层机制降低资源占用:
			//  1) 实例内存热缓存(秒级):命中则完全不碰 KV、不拉上游;
			//  2) KV 缓存(TTL=SUBUPTIME):跨实例复用;
			//  3) SWR + 条件请求:缓存靠近过期且被访问时,在后台(ctx.waitUntil)用
			//     ETag/Last-Modified 刷新——上游全 304 则“不下载、不重建、仅续期”,真正变化才下载;
			//  4) 防惊群锁:缓存 cold 时仅一个请求承担全量拉取,其余等待读取结果。
			// 追加 &refresh 强制重建;未绑定 KV 时退化为实时聚合。
			// 缓存因子附带中国 IP 数据版本:IP 段更新后自动生成新缓存键,避免复用旧 GeoIP 结果;
			// 屏蔽词、节点上限同样纳入:配置变化后自动生成新缓存键,不复用旧结果(否则 SUBMAXNODES 调小后仍返回旧的大截断结果)
			const 缓存因子 = [MainData, 订阅链接数组.join('\n'), [...协议过滤].sort().join(','), env.WARP || '', 剔除大陆 ? '1:' + (中国IP数据?.版本 || '0') : '0', [...屏蔽词].sort().join(','), String(拉取限制.nodes)].join('\u0001');
			const 缓存键 = await hashText(缓存因子);
			const KV缓存键 = 'SUB_AGG:' + 缓存键;
			const 时间戳键 = 'SUB_AGG_AT:' + 缓存键;
			const 强制刷新 = url.searchParams.has('refresh');
			const 刷新参数 = { MainData, 订阅链接数组, 协议过滤, 剔除大陆, 中国IP数据, 屏蔽词, WARP: env.WARP || '', env, request, 追加UA, userAgentHeader, fileName, 拉取限制, KV缓存键, 时间戳键, SUBUpdateTime };

			// 1) 实例内存热缓存
			let 过滤结果 = (!强制刷新) ? 内存缓存取(KV缓存键) : null;

			// 2) KV 缓存
			let KV值 = '';
			if (!过滤结果 && env.KV) {
				try { KV值 = await env.KV.get(KV缓存键) || ''; } catch (e) { KV值 = ''; }
				过滤结果 = (!强制刷新) ? (KV值 || null) : null;
			}

			if (过滤结果) {
				if (!KV值) 内存缓存放(KV缓存键, 过滤结果); // 来自内存或 KV,均回填内存热缓存
				// 3) SWR:缓存靠近过期且被访问时,后台续期/刷新(本请求不阻塞)
				if (KV值 && ctx && env.KV && !强制刷新 && 订阅链接数组.length > 0) {
					await 触发后台刷新(ctx, env, 缓存键, 时间戳键, SUBUpdateTime, 过滤结果, 刷新参数);
				}
			} else {
				// 4) 缓存 cold 或强制刷新:以防惊群锁方式同步重建
			const 锁键 = 'SUB_LOCK:' + 缓存键;
			let 拿锁 = false;
			let 我的锁值 = '';
			try {
				if (env.KV) {
					// KV 无 CAS:锁值 = 时间戳 + 实例随机值。持锁者崩溃/超时后锁会悬挂,
					// 超过 90 秒视为失效可接管;释放时校验值归属,避免误删他人新锁。
					const 已有锁 = await env.KV.get(锁键);
					const 锁龄 = 已有锁 ? Date.now() - Number(String(已有锁).split(':')[0] || 0) : Infinity;
					if (!已有锁 || 锁龄 > 90 * 1000) {
						我的锁值 = Date.now() + ':' + Math.random().toString(36).slice(2);
						await env.KV.put(锁键, 我的锁值, { expirationTtl: 120 });
						拿锁 = true;
					}
				} else { 拿锁 = true; }
			} catch (e) { 拿锁 = true; } // 无 KV 或失败则直接在本请求内重建
			if (拿锁) {
				try {
					过滤结果 = await 执行聚合刷新({ ...刷新参数, 写缓存: !!env.KV, 旧缓存: null });
				} finally {
					if (env.KV && 我的锁值) {
						try {
							const 现值 = await env.KV.get(锁键);
							if (现值 === 我的锁值) await env.KV.delete(锁键);
						} catch (e) { /* 忽略 */ }
					}
				}
				} else if (env.KV) {
					// 其它请求正在重建:短等待后读取 KV 结果(最多约 4 次)
					for (let i = 0; i < 4 && !过滤结果; i++) {
						await new Promise(r => setTimeout(r, 200));
						try { 过滤结果 = await env.KV.get(KV缓存键) || ''; } catch (e) { 过滤结果 = ''; }
					}
				}
				// 仍未取到(无 KV 或等待超时):直接同步聚合兜底
				if (!过滤结果) {
					过滤结果 = await 执行聚合刷新({ ...刷新参数, 写缓存: !!env.KV, 旧缓存: null }) || '';
				}
				if (过滤结果) 内存缓存放(KV缓存键, 过滤结果);
			}
			过滤结果 = 过滤结果 || '';



			// 构建响应头对象
			const FRonly = url.searchParams.has('fr');
			// ?fr:仅保留法国节点(白名单)。法国 GeoIP/名称二路分类,IP 匹配走获取法国IP数据。
			// 法国专属订阅复用聚合缓存(SUB_AGG),仅格式成品走独立 FMT:fr: 缓存键(含 IP 数据版本)。
			const frIpData = FRonly ? await 获取法国IP数据(env) : null;
			const 输出结果 = FRonly ? 仅保留法国节点(过滤结果, frIpData) : 过滤结果;
			// Clash 需区分 mihomo/旧版(legacy)以避免旧版因 hysteria2/reality 等扩展字段无法启动
			// 仅 mihomo/meta/verge 等新核保留扩展, 旧版 Clash(含 clashoo/clashforandroid) 过滤
			const isMihomoReq = (() => {
				const s = String(userAgent || '').toLowerCase();
				if (!s || s === 'null') return true;
				if (s.includes('clashoo')) return false;
				if (/mihomo|meta|verge|nyanpasu|stash|metaforandroid/i.test(s)) return true;
				if (s.includes('clash')) return false;
				return false;
			})();
			const FMT前缀 = 'FMT:' + (FRonly ? ('fr:' + (frIpData && frIpData.版本 ? frIpData.版本 : '0') + ':') : '') + (订阅格式 === 'clash' ? (isMihomoReq ? 'm:' : 'l:') : '') + 缓存键;

			const responseHeaders = {
				"content-type": "text/plain; charset=utf-8",
				"cache-control": "private, no-store",
				"x-content-type-options": "nosniff",
				"referrer-policy": "no-referrer",
				"Profile-Update-Interval": `${SUBUpdateTime}`,
				"Profile-web-page-url": request.url.includes('?') ? request.url.split('?')[0] : request.url,
				//"Subscription-Userinfo": `upload=${UD}; download=${UD}; total=${total}; expire=${expire}`,
			};

			// ===== 订阅响应 ETag:支持客户端条件请求 =====
			// ETag 取「输出结果 + 格式」的哈希:内容或格式变化时 ETag 才变化;
			// Clash 需区分 mihomo/legacy 否则旧版会命中新版缓存的 304
			// 客户端带 If-None-Match 且未变化时直接返回 304,不重复生成/编码配置。
			const 内容ETag = '"' + await hashText(输出结果 + ':' + 订阅格式 + (FRonly ? ':fr' : '') + (订阅格式 === 'clash' && !isMihomoReq ? ':legacy' : '')) + '"';
			responseHeaders["ETag"] = 内容ETag;
			if (request.headers.get('If-None-Match') === 内容ETag) {
				return new Response(null, {
					status: 304,
					headers: {
						"ETag": 内容ETag,
						"Cache-Control": "no-store",
						"Profile-Update-Interval": `${SUBUpdateTime}`,
					},
				});
			}

			if (订阅格式 == 'base64') {
				// 仅 base64 需编码(懒计算):clash/singbox/surge/qx/loon 等不走此分支,
				// 避免对 2MB 级大订阅每次做一次无谓的 base64 编码。
				let base64Data;
				try {
					base64Data = btoa(输出结果);
				} catch (e) {
					// btoa 对非 Latin1 字符串抛错,回退为 UTF-8 -> base64(处理含中文的订阅名)
					const binary = new TextEncoder().encode(输出结果);
					let base64 = '';
					const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
					for (let i = 0; i < binary.length; i += 3) {
						const byte1 = binary[i];
						const byte2 = binary[i + 1] || 0;
						const byte3 = binary[i + 2] || 0;
						base64 += chars[byte1 >> 2];
						base64 += chars[((byte1 & 3) << 4) | (byte2 >> 4)];
						base64 += chars[((byte2 & 15) << 2) | (byte3 >> 6)];
						base64 += chars[byte3 & 63];
					}
					const padding = 3 - (binary.length % 3 || 3);
					base64Data = base64.slice(0, base64.length - padding) + '=='.slice(0, padding);
				}
				return new Response(base64Data, { headers: responseHeaders });
			} else if (订阅格式 == 'clash') {
				// ===== 方案A:本地生成 Clash 配置,不依赖第三方 SUBAPI =====
				// 分流规则优先使用 KV 缓存的 ACL4SSR 规则集,无 KV 时回退内置精简规则
				// 兼容旧版 Clash(clashoo/premium): 非 mihomo 客户端自动过滤 hysteria2/tuic 等扩展
				const 本地Clash配置 = await 生成配置缓存(FMT前缀 + ':clash:' + fileName, () => 生成本地Clash配置(输出结果, env, fileName, FRonly, userAgent), 强制刷新);
				if (!userAgent.includes('mozilla')) responseHeaders["Content-Disposition"] = `attachment; filename*=utf-8''${encodeURIComponent(fileName)}`;
				return new Response(本地Clash配置, { headers: responseHeaders });
			} else if (订阅格式 == 'singbox') {
				// ===== 方案A:本地生成 sing-box 配置,不依赖第三方 SUBAPI =====
				// 复用 uriToClashProxy 解析节点,再转换为 sing-box outbounds + route
				const 本地Singbox配置 = await 生成配置缓存(FMT前缀 + ':singbox:' + fileName, () => 生成本地Singbox配置(输出结果, env, fileName, FRonly), 强制刷新);
				if (!userAgent.includes('mozilla')) responseHeaders["Content-Disposition"] = `attachment; filename*=utf-8''${encodeURIComponent(fileName)}`;
				return new Response(本地Singbox配置, { headers: responseHeaders });
			} else if (订阅格式 == 'surge') {
				// ===== 方案A:本地生成 Surge 配置,不依赖第三方 SUBAPI =====
				// 复用 uriToClashProxy 解析节点,转换为 Surge [Proxy] + [Proxy Group] + [Rule]
				// 注意:Surge 不支持 vless / ssr / hysteria(v1),这些协议的节点会被自动跳过
				const 本地Surge配置 = await 生成配置缓存(FMT前缀 + ':surge:' + fileName, () => 生成本地Surge配置(输出结果, env, fileName, request.url, FRonly), 强制刷新);
				if (!userAgent.includes('mozilla')) responseHeaders["Content-Disposition"] = `attachment; filename*=utf-8''${encodeURIComponent(fileName)}`;
				return new Response(本地Surge配置, { headers: responseHeaders });
			} else if (订阅格式 == 'quanx') {
				// ===== 方案A:本地生成 Quantumult X 配置,不依赖第三方 SUBAPI =====
				// 复用 uriToClashProxy 解析节点,转换为 [server_local] + [policy] + [filter_local]
				// 注意:QX 不支持 tuic/wireguard/socks5/anytls,这些协议节点会被自动跳过
				const 本地Quanx配置 = await 生成配置缓存(FMT前缀 + ':quanx:' + fileName, () => 生成本地Quanx配置(输出结果, env, fileName, FRonly), 强制刷新);
				if (!userAgent.includes('mozilla')) responseHeaders["Content-Disposition"] = `attachment; filename*=utf-8''${encodeURIComponent(fileName)}`;
				return new Response(本地Quanx配置, { headers: responseHeaders });
			} else if (订阅格式 == 'loon') {
				// ===== 方案A:本地生成 Loon 配置,不依赖第三方 SUBAPI =====
				// 复用 uriToClashProxy 解析节点,转换为 [Proxy] + [Proxy Group] + [Rule]
				// 注意:Loon 不支持 socks5/tuic/anytls,这些协议节点会被自动跳过
				const 本地Loon配置 = await 生成配置缓存(FMT前缀 + ':loon:' + fileName, () => 生成本地Loon配置(输出结果, env, fileName, FRonly), 强制刷新);
				if (!userAgent.includes('mozilla')) responseHeaders["Content-Disposition"] = `attachment; filename*=utf-8''${encodeURIComponent(fileName)}`;
				return new Response(本地Loon配置, { headers: responseHeaders });
			}
			// 注:clash/singbox/surge/quanx/loon 均已本地生成,不再调用第三方 SUBAPI 转换
		}
	}
};

