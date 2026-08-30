// ==================== 方案A:本地 sing-box 配置生成(不依赖第三方 SUBAPI) ====================
// 复用 uriToClashProxy 将节点 URI 解析为 Clash 代理对象,再转换为 sing-box outbound,
// 最后组装为完整的 sing-box JSON(outbounds + route),支持 selector/urltest 策略组。

// 将 Clash 代理对象转换为 sing-box outbound,失败返回 null
function clashToSingboxOutbound(p) {
	if (!p || !p.server || !p.port) return null;
	const o = { type: '', tag: p.name, server: p.server, server_port: Number(p.port) };
	const net = String(p.network || 'tcp').toLowerCase();
	const hasTls = !!p.tls;

	// 传输层转换(ws / grpc / http)
	const transport = (() => {
		if (net === 'ws') {
			const t = { type: 'ws' };
			if (p['ws-opts']) {
				if (p['ws-opts'].path) t.path = String(p['ws-opts'].path);
				if (p['ws-opts'].headers && p['ws-opts'].headers.Host) t.headers = { Host: String(p['ws-opts'].headers.Host) };
			}
			return t;
		}
		if (net === 'grpc') {
			const t = { type: 'grpc' };
			if (p['grpc-opts'] && p['grpc-opts']['grpc-service-name']) t.service_name = String(p['grpc-opts']['grpc-service-name']);
			return t;
		}
		if (net === 'http' || net === 'h2') {
			const t = { type: 'http' };
			if (p['h2-opts']) {
				const h = p['h2-opts'].host;
				if (Array.isArray(h) && h.length) t.host = String(h[0]);
				else if (h) t.host = String(h);
				if (p['h2-opts'].path) t.path = String(p['h2-opts'].path);
			}
			return t;
		}
		return null;
	})();

	// TLS 层(标准 TLS / Reality)
	const tls = (() => {
		if (!hasTls) return null;
		const t = { enabled: true };
		if (p.servername) t.server_name = String(p.servername);
		if (p['client-fingerprint']) t.utls = { enabled: true, fingerprint: String(p['client-fingerprint']) };
		if (p['skip-cert-verify']) t.insecure = true;
		if (p['reality-opts']) {
			t.reality = { enabled: true };
			if (p['reality-opts']['public-key']) t.reality.public_key = String(p['reality-opts']['public-key']);
			if (p['reality-opts']['short-id']) t.reality.short_id = String(p['reality-opts']['short-id']);
		}
		return t;
	})();

	switch (p.type) {
		case 'vless': {
			o.type = 'vless';
			if (p.uuid) o.uuid = String(p.uuid);
			if (p.flow) o.flow = String(p.flow);
			if (tls) o.tls = tls;
			if (transport) o.transport = transport;
			return o;
		}
		case 'vmess': {
			o.type = 'vmess';
			if (p.uuid) o.uuid = String(p.uuid);
			o.alter_id = Number(p.alterId || 0);
			if (p.cipher) o.security = String(p.cipher);
			if (tls) o.tls = tls;
			if (transport) o.transport = transport;
			return o;
		}
		case 'trojan': {
			o.type = 'trojan';
			if (p.password) o.password = String(p.password);
			if (tls) o.tls = tls;
			if (transport) o.transport = transport;
			return o;
		}
		case 'ss': {
			o.type = 'shadowsocks';
			if (p.cipher) o.method = String(p.cipher);
			if (p.password) o.password = String(p.password);
			if (p.plugin) {
				// sing-box 需要独立的 plugin / plugin_opts 两个字段
				const opts = p['plugin-opts'] || {};
				if (p.plugin === 'obfs') {
					o.plugin = 'obfs-local';
					const parts = [];
					if (opts.mode) parts.push('obfs=' + opts.mode);
					if (opts.host) parts.push('obfs-host=' + opts.host);
					o.plugin_opts = parts.join(';');
				} else if (p.plugin === 'v2ray-plugin') {
					o.plugin = 'v2ray-plugin';
					const parts = [];
					if (opts.mode) parts.push('mode=' + opts.mode);
					if (opts.host) parts.push('host=' + opts.host);
					if (opts.path) parts.push('path=' + opts.path);
					if (opts.tls) parts.push('tls');
					o.plugin_opts = parts.join(';');
				}
			}
			return o;
		}
		case 'ssr': {
			// sing-box 1.6.0 起已移除 ShadowsocksR(SSR) 支持,输出会导致整个配置加载失败,故跳过
			return null;
		}
		case 'hysteria2':
		case 'hy2': {
			o.type = 'hysteria2';
			if (p.password) o.password = String(p.password);
			// sing-box 要求 hysteria2 必须启用 TLS,否则报 TLS required 并导致整个配置加载失败
			if (!o.tls) o.tls = { enabled: true };
			if (p.sni) o.tls.server_name = String(p.sni);
			if (p['skip-cert-verify']) o.tls.insecure = true;
			if (p.up) o.up_mbps = Number(p.up);
			if (p.down) o.down_mbps = Number(p.down);
			if (p.obfs) o.obfs = { type: String(p.obfs), password: p['obfs-password'] ? String(p['obfs-password']) : '' };
			return o;
		}
		case 'hysteria': {
			o.type = 'hysteria';
			if (p['auth_str']) o.auth_str = String(p['auth_str']);
			// sing-box 的 hysteria v1 必填 tls 与 up/down 带宽,缺失会导致整个配置加载失败
			if (!o.tls) o.tls = { enabled: true };
			if (p.sni) o.tls.server_name = String(p.sni);
			if (p['skip-cert-verify']) o.tls.insecure = true;
			o.up_mbps = p.up ? Number(p.up) : 100;
			o.down_mbps = p.down ? Number(p.down) : 100;
			if (p.obfs) o.obfs = String(p.obfs);
			return o;
		}
		case 'tuic': {
			o.type = 'tuic';
			if (p.uuid) o.uuid = String(p.uuid);
			if (p.password) o.password = String(p.password);
			// sing-box 的 tuic 必须启用 TLS
			if (!o.tls) o.tls = { enabled: true };
			if (p.sni) o.tls.server_name = String(p.sni);
			if (p['skip-cert-verify']) o.tls.insecure = true;
			if (p['congestion-controller']) o.congestion_control = String(p['congestion-controller']);
			if (p['udp-relay-mode']) o.udp_relay_mode = String(p['udp-relay-mode']);
			if (p['reduce-rtt']) o.reduce_rtt = true;
			if (Array.isArray(p.alpn) && p.alpn.length) o.alpn = p.alpn.map(String);
			return o;
		}
		case 'wireguard': {
			// sing-box 1.12 起废弃旧 wireguard 出站,1.13 彻底移除;
			// 由 clashToSingboxEndpoint 生成为 endpoints 数组(见 生成本地Singbox配置)
			return null;
		}
		case 'anytls': {
			o.type = 'anytls';
			if (p.password) o.password = String(p.password);
			// sing-box 的 anytls 必须启用 TLS
			if (!o.tls) o.tls = { enabled: true };
			if (p.sni) o.tls.server_name = String(p.sni);
			if (p['skip-cert-verify']) o.tls.insecure = true;
			if (p['idle-session-check-interval']) o.idle_session_check_interval = Number(p['idle-session-check-interval']);
			if (p['idle-session-timeout']) o.idle_session_timeout = Number(p['idle-session-timeout']);
			if (p['min-idle-session']) o.min_idle_session = Number(p['min-idle-session']);
			return o;
		}
		case 'socks':
		case 'socks5': {
			o.type = 'socks';
			if (p.username) o.username = String(p.username);
			if (p.password) o.password = String(p.password);
			return o;
		}
		case 'http':
		case 'https': {
			o.type = 'http';
			if (p.username) o.username = String(p.username);
			if (p.password) o.password = String(p.password);
			if (p.tls) o.tls = { enabled: true };
			return o;
		}
		default:
			return null;
	}
}

// 将 wireguard 节点转换为 sing-box 1.12+ endpoint 对象
// (sing-box 1.12 起废弃 wireguard 出站、1.13 移除,新格式为 endpoints 数组:
//  address + private_key + peers[].address/port/public_key/allowed_ips)
function clashToSingboxEndpoint(p) {
	if (!p || p.type !== 'wireguard') return null;
	if (!p.server || !p.port) return null;
	// 缺私钥或对端公钥的节点不可用,sing-box 会拒绝该 endpoint,直接丢弃
	if (!p['private-key'] || !p['public-key']) return null;
	const ep = {
		type: 'wireguard',
		tag: String(p.name || 'wireguard'),
		mtu: p.mtu ? Number(p.mtu) : 1280,
	};
	const ipStr = String(p.ip || '10.0.0.2');
	ep.address = [ipStr.includes('/') ? ipStr : ipStr + '/32'];
	ep.private_key = String(p['private-key']);
	const peer = {
		address: String(p.server),
		port: Number(p.port),
		public_key: p['public-key'] ? String(p['public-key']) : '',
		allowed_ips: ['0.0.0.0/0'],
	};
	if (p['pre-shared-key']) peer.pre_shared_key = String(p['pre-shared-key']);
	if (Array.isArray(p.reserved) && p.reserved.length) peer.reserved = p.reserved.map(Number);
	ep.peers = [peer];
	return ep;
}

// 协议级节点校验(供各格式生成器共用,宁缺毋滥:不合格节点整条丢弃,不拖垮整份配置)
// 除 server/port 外,还校验各协议必填凭据与关键字段值域,拦截“能解析但字段残缺/非法”的节点。
// 这些字段若残缺或非法,OpenClash(mihomo)/sing-box 等对格式要求严格的客户端会直接拒绝
// 整个配置或让该节点不可用。
const 合法网络 = new Set(['tcp', 'ws', 'grpc', 'http', 'h2']);
function 校验节点(p) {
	if (!p || typeof p !== 'object') return false;
	if (!p.server) return false;
	const server = String(p.server).trim();
	if (!server || server.length > 253) return false;
	const port = Number(p.port);
	if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
	const net = String(p.network || 'tcp').toLowerCase();
	if (!合法网络.has(net)) return false;
	switch (p.type) {
		case 'vmess': return !!(p.uuid && p.cipher);
		case 'vless': return !!p.uuid;
		case 'ss': return !!(p.password && p.cipher);
		case 'ssr': return !!(p.password && p.cipher && p.protocol && p.obfs);
		case 'trojan': return !!p.password;
		case 'hysteria2':
		case 'hy2': return !!p.password;
		case 'hysteria': return true; // up/down 有默认值兜底
		case 'tuic': return !!(p.uuid && p.password);
		case 'wireguard': return !!(p['public-key'] && p['private-key'] && p.ip);
		case 'anytls': return !!p.password;
		case 'socks':
		case 'socks5':
		case 'http':
		case 'https': return true;
		default: return false; // 未知协议:丢弃
	}
}

// 本地生成完整 sing-box JSON 配置
async function 生成本地Singbox配置(节点文本, env, fileName = DEFAULT_FILE_NAME, FRonly = false) {
	const lines = String(节点文本 || '').split('\n').map(s => s.trim()).filter(Boolean);
	const outbounds = [];
	const endpoints = [];
	const frOutIndices = [];
	const frEpIndices = [];
	for (const line of lines) {
		let p;
		try { p = uriToClashProxy(line); } catch (e) { p = null; } // 单节点解析失败只跳过该节点
		if (!p || !校验节点(p)) continue; // 协议级校验:不合格节点宁缺毋滥
		if (p.type === 'wireguard') {
			const ep = clashToSingboxEndpoint(p);
			if (!ep) continue;
			if (!FRonly && 是否法国节点(line, null)) frEpIndices.push(endpoints.length);
			endpoints.push(ep);
			continue;
		}
		const o = clashToSingboxOutbound(p);
		if (!o) continue;
		if (!FRonly && 是否法国节点(line, null)) frOutIndices.push(outbounds.length);
		outbounds.push(o);
	}
	if (outbounds.length === 0 && endpoints.length === 0) return JSON.stringify({ log: { level: 'info' }, outbounds: [] });

	// 节点 tag 去重(出站 + 端点)
	const seenTags = new Set();
	const allNodes = [...outbounds, ...endpoints];
	for (const o of allNodes) {
		let t = o.tag;
		let i = 2;
		while (seenTags.has(t)) { t = o.tag + ' ' + i; i++; }
		seenTags.add(t);
		o.tag = t;
	}
	const nodeTags = allNodes.map(o => o.tag);
	const frNames = [...frOutIndices.map(i => allNodes[i].tag), ...frEpIndices.map(i => allNodes[outbounds.length + i].tag)];

	const 直连 = '🎯 全球直连';
	const 拦截 = '🛑 全球拦截';
	const 媒体 = '🌍 国外媒体';
	const 电报 = '📲 电报信息';
	const Ai = '💬 Ai平台';
	const 节点选择 = '🚀 节点选择';
	const 自动选择 = '♻️ 自动选择';
	const 漏网 = '🐟 漏网之鱼';

	const 法国组 = '🇫🇷 法国节点';
	const groups = [
		{ type: 'selector', tag: 节点选择, outbounds: [自动选择, ...nodeTags, ...(frNames.length ? [法国组] : []), 直连] },
		{ type: 'urltest', tag: 自动选择, outbounds: nodeTags, url: 'http://www.gstatic.com/generate_204', interval: '300s' },
		{ type: 'direct', tag: 直连 },
		{ type: 'block', tag: 拦截 },
		{ type: 'selector', tag: 媒体, outbounds: [节点选择, 直连] },
		{ type: 'selector', tag: 电报, outbounds: [节点选择, 直连] },
		{ type: 'selector', tag: Ai, outbounds: [节点选择, 直连] },
		{ type: 'selector', tag: 漏网, outbounds: [节点选择, 直连] },
	];
	// 法国节点单独成组(FR-only 订阅模式下整份即为法国节点,无需再建分组)
	if (frNames.length && !FRonly) groups.push({ type: 'selector', tag: 法国组, outbounds: [...frNames, 节点选择] });
	outbounds.push(...groups);

	const config = {
		log: { level: 'info', timestamp: true },
		experimental: { cache_file: { enabled: true } },
		outbounds,
		// sing-box 1.12+: wireguard 由 outbound 迁移为 endpoint(1.13 起旧格式直接报错)
		...(endpoints.length ? { endpoints } : {}),
		route: {
			rules: [
				{ ip_cidr: ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'], outbound: 直连 },
				// sing-box 1.12+ 移除了 geoip/geosite 内置数据库规则,必须改用 rule_set(远程 .srs 文件)。
				// rule_set 自 sing-box 1.4 起全版本可用,兼容所有客户端。
				{ rule_set: ['geoip-cn'], outbound: 直连 },
				{ rule_set: ['geosite-cn'], outbound: 直连 },
			],
			rule_set: [
				{
					tag: 'geoip-cn',
					type: 'remote',
					format: 'binary',
					url: 'https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-cn.srs',
					download_detour: 直连,
				},
				{
					tag: 'geosite-cn',
					type: 'remote',
					format: 'binary',
					url: 'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-cn.srs',
					download_detour: 直连,
				},
			],
			final: 漏网,
			auto_detect_interface: true,
		},
	};
	return JSON.stringify(config, null, 2);
}

// ==================== 方案A:本地 Clash 配置生成(不依赖第三方 SUBAPI) ====================
// 将聚合后的节点 URI 列表直接在 Worker 内转换为 Clash/Mihomo YAML。
// 分流规则优先读取 KV 缓存的 ACL4SSR 规则集(24小时自动刷新),无 KV 或拉取失败时回退内置精简规则。

// ACL4SSR 在线规则集列表(按 group 映射到生成的策略组)
const ACL4SSR_RULES = [
	{ url: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/LocalAreaNetwork.list', group: '🎯 全球直连' },
	{ url: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/UnBan.list', group: '🎯 全球直连' },
	{ url: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/BanAD.list', group: '🛑 全球拦截' },
	{ url: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/BanProgramAD.list', group: '🛑 全球拦截' },
	{ url: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/GoogleCN.list', group: '🎯 全球直连' },
	{ url: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Ruleset/SteamCN.list', group: '🎯 全球直连' },
	{ url: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Telegram.list', group: '📲 电报信息' },
	{ url: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/ProxyMedia.list', group: '🌍 国外媒体' },
	{ url: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Ruleset/AI.list', group: '💬 Ai平台' },
	{ url: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Ruleset/OpenAi.list', group: '💬 Ai平台' },
	{ url: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/ChinaDomain.list', group: '🎯 全球直连' },
	{ url: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/ChinaCompanyIp.list', group: '🎯 全球直连' },
];

// 将单条节点 URI 解析为 Clash 代理对象,失败返回 null
function uriToClashProxy(uri) {
	try {
		const s = String(uri || '').trim();
		const hashIdx = s.indexOf('#');
		let name = '';
		if (hashIdx !== -1) { try { name = decodeURIComponent(s.slice(hashIdx + 1)); } catch { name = s.slice(hashIdx + 1); } }
		let body = hashIdx !== -1 ? s.slice(0, hashIdx) : s;
		const schemeIdx = body.indexOf('://');
		if (schemeIdx === -1) return null;
		const scheme = body.slice(0, schemeIdx).toLowerCase();
		body = body.slice(schemeIdx + 3);
		// vmess / ssr 的 URI 主体是纯 base64(无 @host:port 结构),需单独解析
		if (scheme === 'vmess' || scheme === 'ssr') {
			const b64 = body.split('?')[0];
			let decoded = b64;
			try { decoded = base64Decode(b64); } catch { return null; }
			if (scheme === 'vmess') {
				let json;
				try { json = JSON.parse(decoded); } catch { return null; }
				if (!json.add || !json.port) return null;
				const p = {
					name: name || json.ps || (json.add + ':' + json.port),
					type: 'vmess',
					server: json.add,
					port: Number(json.port),
					uuid: json.id || '',
					alterId: Number(json.aid || 0),
					cipher: json.scy || 'auto',
					udp: true,
				};
				// vmess cipher 白名单:mihomo 实测仅支持 auto/aes-128-gcm/chacha20-poly1305/none,
				// 其余值(常见误配如 ss 的 chacha20-ietf-poly1305)会拒绝加载整个配置,整节点丢弃。
				const VMESS_CIPHERS = new Set(['auto', 'aes-128-gcm', 'chacha20-poly1305', 'none']);
				if (json.scy && !VMESS_CIPHERS.has(String(json.scy).toLowerCase())) return null;
				// alterId 必须为非负整数(实测字符串/NaN 会让 mihomo 拒绝加载整个配置)
				if (json.aid && !/^\d+$/.test(String(json.aid))) return null;
				const net = String(json.net || 'tcp').toLowerCase();
				if (net !== 'tcp') p.network = net;
				if (net === 'ws') p['ws-opts'] = { path: json.path || '/', headers: json.host ? { Host: json.host } : undefined };
				else if (net === 'h2' || net === 'http') p['h2-opts'] = { host: json.host ? [json.host] : [], path: json.path || '/' };
				else if (net === 'grpc') p['grpc-opts'] = { 'grpc-service-name': json.path || '' };
				if (json.tls) {
					p.tls = true;
					if (json.sni) p.servername = json.sni;
					if (json.fp) p['client-fingerprint'] = json.fp;
				}
				if (json.alpn) p.alpn = String(json.alpn).split(',');
				return p;
			}
			// ssr
			const q2 = decoded.split('/?');
			const core = q2[0].split(':');
			const ssp = new URLSearchParams(q2[1] || '');
			let mp = core.slice(4).join(':');
			try { mp = base64Decode(mp); } catch { /* 保持原样 */ }
			const mci = mp.indexOf(':');
			let remarks = '';
			try { if (ssp.get('remarks')) remarks = base64Decode(ssp.get('remarks')); } catch { /* 忽略 */ }
			const protocol = (core[2] || 'origin').toLowerCase();
			const obfs = (core[3] || 'plain').toLowerCase();
			// ssr protocol/obfs 白名单:mihomo 对未知值报 initialize protocol/obfs error 并使整个配置加载失败
			const SSR_PROTOCOLS = new Set(['origin', 'auth_sha1_v4', 'auth_aes128_md5', 'auth_aes128_sha1', 'auth_chain_a', 'auth_chain_b']);
			const SSR_OBFS = new Set(['plain', 'http_simple', 'http_post', 'random_head', 'tls1.2_ticket_auth', 'tls1.2_ticket_fastauth']);
			if (!SSR_PROTOCOLS.has(protocol) || !SSR_OBFS.has(obfs)) return null; // 非法 protocol/obfs:丢弃节点
			const p = {
				name: remarks || name || (core[0] + ':' + core[1]),
				server: core[0],
				port: Number(core[1]),
				type: 'ssr',
				cipher: mci !== -1 ? mp.slice(0, mci) : 'aes-256-cfb',
				password: mci !== -1 ? mp.slice(mci + 1) : '',
				protocol,
				obfs,
			};
			if (ssp.get('obfsparam')) { try { p['obfs-param'] = base64Decode(ssp.get('obfsparam')); } catch { /* 忽略 */ } }
			if (ssp.get('protoparam')) { try { p['protocol-param'] = base64Decode(ssp.get('protoparam')); } catch { /* 忽略 */ } }
			return p;
		}
		let userInfo = '';
		let hostPort = body;
		const atIdx = body.lastIndexOf('@');
		if (atIdx !== -1) { userInfo = body.slice(0, atIdx); hostPort = body.slice(atIdx + 1); }
		const qIdx = hostPort.indexOf('?');
		let query = '';
		if (qIdx !== -1) { query = hostPort.slice(qIdx + 1); hostPort = hostPort.slice(0, qIdx); }
		const params = new URLSearchParams(query);
		// 部分机场模板 URI 带尾部斜杠(如 hysteria2://pw@host:443/),
		// 直接匹配会失败导致节点被误丢,去掉尾部斜杠再解析。
		hostPort = hostPort.replace(/\/+$/, '');
		let server = hostPort, port = '';
		const hm = hostPort.match(/^\[(.+)\]:(\d+)$/) || hostPort.match(/^([^:]+):(\d+)$/);
		if (hm) { server = hm[1]; port = hm[2]; }
		if (!server || !port) return null;
		const base = { name: name || (server + ':' + port), server, port: Number(port) };
		switch (scheme) {
			case 'vless': {
				const p = { ...base, type: 'vless', uuid: userInfo, udp: true };
				const net = params.get('type') || 'tcp';
				if (net !== 'tcp') p.network = net;
				const security = params.get('security') || 'none';
				if (security === 'reality') {
					p.tls = true;
					p.servername = params.get('sni') || server;
					if (params.get('fp')) p['client-fingerprint'] = params.get('fp');
					// REALITY 公钥必须为 URL-safe base64(无padding),解码后恰好 32 字节(X25519)
					// mihomo/sing-box 均用 RawURLEncoding 校验:标准 base64 的 + / 或带 = 的 padding 都会导致
					// "invalid REALITY public key" 进而使整个配置文件加载失败(OpenClash 无法启动)。
					const rawPbk = String(params.get('pbk') || '').trim();
					const urlSafePbk = rawPbk.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
					let pbkOk = false;
					try {
						const bytes = Uint8Array.from(atob(urlSafePbk.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
						pbkOk = bytes.length === 32;
					} catch { pbkOk = false; }
					if (!pbkOk) return null; // pbk 缺失/非法:丢弃该节点,避免单个坏节点拖垮整个配置
					// short-id 必须为偶数长度 hex 且解码后 ≤8 字节,否则 mihomo 报 invalid REALITY short ID
					const rawSid = String(params.get('sid') || '').trim();
					const sidOk = /^[0-9a-fA-F]{0,16}$/.test(rawSid) && rawSid.length % 2 === 0;
					p['reality-opts'] = { 'public-key': urlSafePbk };
					if (rawSid && sidOk) p['reality-opts']['short-id'] = rawSid.toLowerCase();
				} else if (security === 'tls') {
					p.tls = true;
					if (params.get('sni')) p.servername = params.get('sni');
					if (params.get('fp')) p['client-fingerprint'] = params.get('fp');
				}
				if (params.get('flow')) p.flow = params.get('flow');
				// flow 白名单防御:仅保留 mihomo/sing-box 已知合法值;垃圾 flow 直接丢弃该字段
				// (实测 mihomo v1.19.29 对任意 flow 均接受,但旧版本/未来版本可能严格校验,保守起见过滤)
				if (p.flow && !['xtls-rprx-vision', 'xtls-rprx-vision-udp443'].includes(p.flow)) delete p.flow;
				if (net === 'ws') p['ws-opts'] = { path: params.get('path') || '/', headers: params.get('host') ? { Host: params.get('host') } : undefined };
				else if (net === 'grpc') p['grpc-opts'] = { 'grpc-service-name': params.get('serviceName') || params.get('service_name') || '' };
				else if (net === 'h2' || net === 'http') p['h2-opts'] = { host: params.get('host') ? [params.get('host')] : [], path: params.get('path') || '/' };
				if (params.get('alpn')) p.alpn = String(params.get('alpn')).split(',');
				return p;
			}
			case 'trojan': {
				const p = { ...base, type: 'trojan', password: userInfo, udp: true };
				const security = params.get('security') || 'tls';
				if (security !== 'none') p.tls = true;
				if (params.get('sni')) p.servername = params.get('sni');
				if (params.get('allowInsecure') === '1') p['skip-cert-verify'] = true;
				const net = params.get('type') || 'tcp';
				if (net !== 'tcp') p.network = net;
				if (net === 'ws') p['ws-opts'] = { path: params.get('path') || '/', headers: params.get('host') ? { Host: params.get('host') } : undefined };
				else if (net === 'grpc') p['grpc-opts'] = { 'grpc-service-name': params.get('serviceName') || '' };
				if (params.get('alpn')) p.alpn = String(params.get('alpn')).split(',');
				return p;
			}
			case 'ss': {
				let decoded = userInfo;
				try { decoded = base64Decode(userInfo); } catch { /* 保持原样 */ }
				const ci = decoded.indexOf(':');
				const cipher = ci !== -1 ? decoded.slice(0, ci) : 'aes-256-gcm';
				const password = ci !== -1 ? decoded.slice(ci + 1) : decoded;
				if (!password) return null; // ss 空密码:mihomo 报 cipher initialize error,整个配置加载失败
				// cipher 白名单:mihomo 对不认识的 cipher 报 initialize error 并使整个配置加载失败
				// (实测 salsa20/camellia-*/rc4/大写变体均被拒,2022-blake3 需 base64 密码解码为 16/32 字节 key)
				const normCipher = String(cipher).toLowerCase().trim();
				// cipher 白名单与 mihomo v1.19.x 实测支持列表一致(逐项用 mihomo -t 验证过);
				// 注意:chacha20-poly1305 是 mihomo 明确不支持的名称(实测报 cipher not supported),
				// 不能加入白名单,否则会让整个配置加载失败。
				const SS_CIPHERS = new Set([
					'aes-128-gcm', 'aes-192-gcm', 'aes-256-gcm',
					'aes-128-ccm', 'aes-192-ccm', 'aes-256-ccm',
					'aes-128-gcm-siv', 'aes-256-gcm-siv',
					'aes-128-cfb', 'aes-192-cfb', 'aes-256-cfb',
					'aes-128-ctr', 'aes-192-ctr', 'aes-256-ctr',
					'chacha20-ietf-poly1305', 'xchacha20-ietf-poly1305',
					'chacha8-ietf-poly1305', 'xchacha8-ietf-poly1305',
					'chacha20-ietf', 'chacha20', 'xchacha20',
					'lea-128-gcm', 'lea-192-gcm', 'lea-256-gcm',
					'rabbit128-poly1305', 'aegis-128l', 'aegis-256',
					'aez-384', 'deoxys-ii-256-128',
					'rc4-md5', 'none',
					'2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm', '2022-blake3-chacha20-poly1305',
				]);
				if (!SS_CIPHERS.has(normCipher)) return null;
				if (normCipher.startsWith('2022-blake3')) {
					// 2022-blake3 密码必须是 base64 编码的 key:128→16字节,256/chacha20→32字节
					let keyBytes = null;
					try { keyBytes = Uint8Array.from(atob(String(password)), c => c.charCodeAt(0)); } catch { /* 非法 base64 */ }
					const need = normCipher.includes('128') ? 16 : 32;
					if (!keyBytes || keyBytes.length !== need) return null; // key 长度错误:mihomo 报 bad key length,丢弃节点
				}
				const p = { ...base, type: 'ss', cipher: normCipher, password, udp: true };
				const plugin = params.get('plugin');
				if (plugin) {
					const parts = String(plugin).split(';');
					if (parts[0].includes('obfs')) {
						p.plugin = 'obfs';
						const opts = {};
						for (const kv of parts.slice(1)) {
							const eq = kv.indexOf('=');
							if (eq > 0) { const k = kv.slice(0, eq); const v = kv.slice(eq + 1); if (k === 'obfs') opts.mode = v; else if (k === 'obfs-host') opts.host = v; }
						}
						// mihomo 的 obfs 仅接受 http/tls 两种模式,缺失时按 simple-obfs 惯例默认 http;
						// 非法模式(on/off/yes/自定义等)会让 mihomo 报 "obfs mode error" 并拒绝加载整个配置,
						// 这类节点整条丢弃(宁缺毋滥,不拖垮整份配置)。
						const 模式 = String(opts.mode || 'http').toLowerCase();
						if (模式 !== 'http' && 模式 !== 'tls') return null;
						opts.mode = 模式;
						p['plugin-opts'] = opts;
					} else if (parts[0].includes('v2ray')) {
						p.plugin = 'v2ray-plugin';
						const opts = {};
						for (const kv of parts.slice(1)) {
							const eq = kv.indexOf('=');
							if (eq > 0) opts[kv.slice(0, eq)] = kv.slice(eq + 1);
							else opts[kv.trim()] = true;
						}
						// mihomo 的 v2ray-plugin 仅支持 mode=websocket(官方注释 no QUIC now),
						// 缺失时默认 websocket;非法模式(quic/ws 等)会让 mihomo 报错并拒绝加载整个配置,
						// 这类节点整条丢弃。
						const 模式 = String(opts.mode || 'websocket').toLowerCase();
						if (模式 !== 'websocket') return null;
						opts.mode = 模式;
						p['plugin-opts'] = opts;
					}
				}
				return p;
			}
			case 'hysteria2':
			case 'hy2': {
				const p = { ...base, type: 'hysteria2', password: userInfo };
				if (params.get('sni')) p.sni = params.get('sni');
				if (params.get('insecure') === '1') p['skip-cert-verify'] = true;
				if (params.get('up')) p.up = params.get('up');
				if (params.get('down')) p.down = params.get('down');
				// mihomo 的 hysteria2 obfs 仅支持 salamander 且必须带密码;
				// none/自定义值或缺密码实测都会报错并拒绝加载整个配置,整节点丢弃。
				const hy2obfs = params.get('obfs');
				if (hy2obfs) {
					if (String(hy2obfs).toLowerCase() !== 'salamander') return null;
					const hy2obfsPw = params.get('obfs-password');
					if (!hy2obfsPw) return null;
					p.obfs = 'salamander';
					p['obfs-password'] = hy2obfsPw;
				}
				return p;
			}
			case 'hysteria': {
				const p = { ...base, type: 'hysteria' };
				if (params.get('auth')) p['auth_str'] = params.get('auth');
				if (params.get('peer')) p.sni = params.get('peer');
				if (params.get('insecure') === '1') p['skip-cert-verify'] = true;
				// mihomo 的 hysteria v1 必填正整数 up/down,缺失给默认值;
				// 非数字/小数/0 实测会报错并拒绝加载整个配置,整节点丢弃。
				const hy1up = params.get('upmbps'), hy1down = params.get('downmbps');
				if (hy1up && !/^[1-9]\d*$/.test(hy1up)) return null;
				if (hy1down && !/^[1-9]\d*$/.test(hy1down)) return null;
				p.up = hy1up || '100';
				p.down = hy1down || '100';
				return p;
			}
			case 'tuic': {
				const ui = userInfo.split(':');
				const p = { ...base, type: 'tuic', uuid: ui[0] || '', password: ui[1] || '' };
				if (params.get('sni')) p.sni = params.get('sni');
				if (params.get('congestion_control')) p['congestion-controller'] = params.get('congestion_control');
				if (params.get('udp_relay_mode')) p['udp-relay-mode'] = params.get('udp_relay_mode');
				if (params.get('alpn')) p.alpn = String(params.get('alpn')).split(',');
				if (params.get('allow_insecure') === '1' || params.get('insecure') === '1') p['skip-cert-verify'] = true;
				if (params.get('reduce_rtt') === '1' || params.get('reduce_rtt') === 'true') p['reduce-rtt'] = true;
				return p;
			}
			case 'wireguard': {
				// wireguard key 必须为标准 base64(可带 + / 与 = padding);URL-safe 无 padding 会被
				// mihomo 以 decode private key: illegal base64 data 拒绝并导致整个配置加载失败。
				const normWgKey = (v) => {
					if (!v) return '';
					const s = String(v).trim().replace(/-/g, '+').replace(/_/g, '/');
					const padded = s + '='.repeat((4 - s.length % 4) % 4);
					try { atob(padded); return padded; } catch { return ''; }
				};
				const priv = normWgKey(params.get('pvtkey'));
				if (!priv) return null; // 缺失/非法 private-key:丢弃节点
				// mihomo 的 wireguard ip 字段仅接受纯 IPv4:实测 IPv6 / CIDR 后缀 / 前导零 / 越界
				// (如 10.0.0.2/32、999.999.999.999、01.02.03.04、2001:db8::1)都会报错并拒绝加载整个配置。
				const rawIp = String(params.get('ip') || '10.0.0.2').trim();
				const ipOk = /^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(rawIp)
					&& rawIp.split('.').every(o => Number(o) <= 255);
				if (!ipOk) return null; // 非法 ip:丢弃节点
				const p = { ...base, type: 'wireguard', ip: rawIp };
				p['private-key'] = priv;
				const pub = normWgKey(params.get('pubkey'));
				if (pub) p['public-key'] = pub;
				const psk = normWgKey(params.get('presharedkey'));
				if (psk) p['pre-shared-key'] = psk;
				// mihomo 的 reserved 必须恰好 3 字节且每字节 0-255(实测 2/4 字节会拒绝加载整个配置)
				if (params.get('reserved')) {
					const reserved = String(params.get('reserved')).split(',').map(Number);
					if (reserved.length !== 3 || reserved.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
					p.reserved = reserved;
				}
				// mtu 必须为正整数,非法值 mihomo 报 cannot parse 'mtu' as int 并使整个配置失败
				const mtu = Number(params.get('mtu'));
				if (params.get('mtu') && Number.isInteger(mtu) && mtu > 0) p.mtu = mtu;
				if (params.get('udp') === '1') p.udp = true;
				return p;
			}
			case 'anytls': {
				if (!userInfo) return null; // anytls 缺密码:mihomo 报 has unset fields: password,整个配置失败
				const p = { ...base, type: 'anytls', password: userInfo };
				if (params.get('sni') || params.get('servername')) p.sni = params.get('sni') || params.get('servername');
				if (params.get('allowInsecure') === '1') p['skip-cert-verify'] = true;
				if (params.get('udp') === '1') p.udp = true;
				// mihomo 的 anytls 数字字段必须是正整数(实测字符串/NaN 会拒绝加载整个配置)
				for (const key of ['idle-session-check-interval', 'idle-session-timeout', 'min-idle-session']) {
					const v = params.get(key);
					if (v) {
						if (!/^[1-9]\d*$/.test(v)) return null;
						p[key] = Number(v);
					}
				}
				return p;
			}
			case 'socks':
			case 'socks5': {
				const ui = userInfo.split(':');
				const p = { ...base, type: 'socks5' };
				if (ui[0]) p.username = decodeURIComponent(ui[0]);
				if (ui[1]) p.password = decodeURIComponent(ui[1]);
				if (params.get('udp') === '1') p.udp = true;
				return p;
			}
			case 'http':
			case 'https': {
				const ui = userInfo.split(':');
				const p = { ...base, type: 'http' };
				if (ui[0]) p.username = decodeURIComponent(ui[0]);
				if (ui[1]) p.password = decodeURIComponent(ui[1]);
				if (scheme === 'https' || params.get('tls') === '1') p.tls = true;
				return p;
			}
			default:
				return null;
		}
	} catch (e) {
		return null;
	}
}

