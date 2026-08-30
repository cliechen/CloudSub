// ===== 本地生成完整 Clash YAML =====
async function 生成本地Clash配置(节点文本, env, fileName = DEFAULT_FILE_NAME, FRonly = false) {
	const lines = String(节点文本 || '').split('\n').map(s => s.trim()).filter(Boolean);
	const proxies = [];
	const frIndices = [];
	for (const line of lines) {
		let p;
		try { p = uriToClashProxy(line); } catch (e) { p = null; } // 单节点解析失败只跳过该节点
		if (p && 校验节点(p)) { // 校验合法才收入
			if (!FRonly && 是否法国节点(line, null)) frIndices.push(proxies.length);
			proxies.push(p);
		}
	}
	if (proxies.length === 0) return '# 无可用节点\n';

	// 节点名去重(Clash 要求唯一)。除节点间重名外,还必须规避:
	//  1) mihomo 内置保留名 DIRECT/REJECT/PASS/COMPATIBLE/REJECT-DROP(实测同名直接导致整个配置加载失败);
	//  2) 下方生成的策略组名(节点与组同名同样报 duplicate name)。
	const 直连 = '🎯 全球直连';
	const 拦截 = '🛑 全球拦截';
	const 媒体 = '🌍 国外媒体';
	const 电报 = '📲 电报信息';
	const Ai = '💬 Ai平台';
	const 节点选择 = '🚀 节点选择';
	const 自动选择 = '♻️ 自动选择';
	const 漏网 = '🐟 漏网之鱼';
	const 法国组 = '🇫🇷 法国节点';
	const seenNames = new Set(['DIRECT', 'REJECT', 'PASS', 'COMPATIBLE', 'REJECT-DROP', 直连, 拦截, 媒体, 电报, Ai, 节点选择, 自动选择, 漏网, 法国组]);
	for (const p of proxies) {
		let n = p.name;
		let i = 2;
		while (seenNames.has(n)) { n = p.name + ' ' + i; i++; }
		seenNames.add(n);
		p.name = n;
	}
	const nodeNames = proxies.map(p => p.name);
	const frNames = frIndices.map(i => proxies[i].name);

	const groups = [
		{ name: 节点选择, type: 'select', proxies: [自动选择, ...nodeNames, ...(frNames.length ? [法国组] : []), 直连] },
		{ name: 自动选择, type: 'url-test', url: 'http://www.gstatic.com/generate_204', interval: 300, tolerance: 50, proxies: nodeNames },
		{ name: 直连, type: 'select', proxies: ['DIRECT'] },
		{ name: 拦截, type: 'select', proxies: ['REJECT', 'DIRECT'] },
		{ name: 媒体, type: 'select', proxies: [节点选择, 直连] },
		{ name: 电报, type: 'select', proxies: [节点选择, 直连] },
		{ name: Ai, type: 'select', proxies: [节点选择, 直连] },
		{ name: 漏网, type: 'select', proxies: [节点选择, 直连] },
	];
	// 法国节点单独成组(FR-only 订阅模式下整份即为法国节点,无需再建分组)
	if (frNames.length && !FRonly) groups.push({ name: 法国组, type: 'select', proxies: [...frNames, 节点选择] });

	const rules = await 获取Clash规则(env);

	const out = [];
	out.push('mixed-port: 7890');
	out.push('allow-lan: false');
	out.push('mode: rule');
	out.push('log-level: info');
	out.push('');
	out.push('proxies:');
	for (const p of proxies) {
		try { out.push(渲染Clash代理(p)); } catch (e) { /* 单节点渲染失败只跳过该节点,不拖垮整份配置 */ }
	}
	out.push('');
	out.push('proxy-groups:');
	for (const g of groups) out.push(渲染Clash策略组(g));
	out.push('');
	out.push('rules:');
	for (const r of rules) out.push('  - ' + r);
	return out.join('\n');
}

// ==================== 方案A:本地 Surge 配置生成(不依赖第三方 SUBAPI) ====================
// 复用 uriToClashProxy 将节点 URI 解析为 Clash 代理对象,再转换为 Surge [Proxy] 行,
// 最后组装为完整的 Surge profile([General] + [Proxy] + [Proxy Group] + [Rule])。
// 注意:Surge 不支持 vless / ssr / hysteria(v1),这些协议的节点会被自动跳过。

// Surge 配置值:含逗号、引号或首尾空格的值需要加双引号
function surgeQuote(v) {
	v = String(v ?? '');
	if (/[",]/.test(v) || /^\s|\s$/.test(v)) return '"' + v.replace(/"/g, '\\"') + '"';
	return v;
}

// 将 Clash 代理对象转换为 Surge [Proxy] 行;不支持的协议返回 null
// wireguard 需要额外的 [WireGuard xxx] 段,通过返回对象的 wgSection 字段带回
function clashToSurgeProxy(p, wgIndex) {
	if (!p || !p.server || !p.port) return null;
	const name = String(p.name || (p.server + ':' + p.port));
	// [Proxy] 行首的节点名若含逗号/引号需要加引号,否则整行解析失败
	const displayName = surgeQuote(name);
	const server = String(p.server);
	const port = String(p.port);
	const net = String(p.network || 'tcp').toLowerCase();

	// 传输层参数(ws)
	const wsArgs = [];
	if (net === 'ws') {
		wsArgs.push('ws=true');
		const ws = p['ws-opts'] || {};
		if (ws.path) wsArgs.push('ws-path=' + ws.path);
		if (ws.headers && ws.headers.Host) wsArgs.push('ws-headers=Host:' + ws.headers.Host);
	}

	// TLS 参数
	const tlsArgs = [];
	if (p.servername || p.sni) tlsArgs.push('sni=' + surgeQuote(p.servername || p.sni));
	if (p['skip-cert-verify']) tlsArgs.push('skip-cert-verify=true');
	if (Array.isArray(p.alpn) && p.alpn.length) tlsArgs.push('alpn=' + p.alpn.join(','));

	switch (p.type) {
		case 'ss': {
			const args = ['ss', server, port, 'encrypt-method=' + (p.cipher || 'aes-256-gcm'), 'password=' + surgeQuote(p.password || '')];
			if (p.plugin === 'obfs') {
				const opts = p['plugin-opts'] || {};
				args.push('obfs=' + (opts.mode || 'http'));
				if (opts.host) args.push('obfs-host=' + surgeQuote(opts.host));
			}
			return { name, line: displayName + ' = ' + args.join(', ') };
		}
		case 'vmess': {
			const args = ['vmess', server, port, 'username=' + (p.uuid || '')];
			args.push(...wsArgs);
			if (p.cipher && p.cipher !== 'auto') args.push('encrypt-method=' + p.cipher);
			if (p.tls) args.push('tls=true');
			args.push(...tlsArgs);
			return { name, line: displayName + ' = ' + args.join(', ') };
		}
		case 'trojan': {
			const args = ['trojan', server, port, 'password=' + surgeQuote(p.password || '')];
			args.push(...wsArgs);
			// trojan 始终走 TLS,直接附加 TLS 参数
			args.push(...tlsArgs);
			return { name, line: displayName + ' = ' + args.join(', ') };
		}
		case 'hysteria2': {
			const args = ['hysteria2', server, port, 'password=' + surgeQuote(p.password || '')];
			if (p.up) args.push('upload-bandwidth=' + p.up);
			if (p.down) args.push('download-bandwidth=' + p.down);
			if (p.obfs) args.push('salamander-password=' + surgeQuote(p['obfs-password'] || ''));
			args.push(...tlsArgs);
			return { name, line: displayName + ' = ' + args.join(', ') };
		}
		case 'tuic': {
			// 同时有 uuid 和 password -> tuic-v5;只有 token -> tuic (v4)
			if (p.uuid && p.password) {
				const args = ['tuic-v5', server, port, 'uuid=' + p.uuid, 'password=' + surgeQuote(p.password)];
				if (p['udp-relay-mode']) args.push('udp-relay-mode=' + p['udp-relay-mode']);
				if (p['congestion-controller']) args.push('congestion-controller=' + p['congestion-controller']);
				if (!Array.isArray(p.alpn) || p.alpn.length === 0) args.push('alpn=h3');
				args.push(...tlsArgs);
				return { name, line: displayName + ' = ' + args.join(', ') };
			}
			const args = ['tuic', server, port, 'token=' + surgeQuote(p.password || p.uuid || '')];
			if (p['udp-relay-mode']) args.push('udp-relay-mode=' + p['udp-relay-mode']);
			if (p['congestion-controller']) args.push('congestion-controller=' + p['congestion-controller']);
			if (!Array.isArray(p.alpn) || p.alpn.length === 0) args.push('alpn=h3');
			args.push(...tlsArgs);
			return { name, line: displayName + ' = ' + args.join(', ') };
		}
		case 'anytls': {
			const args = ['anytls', server, port, 'password=' + surgeQuote(p.password || '')];
			args.push(...tlsArgs);
			return { name, line: displayName + ' = ' + args.join(', ') };
		}
		case 'socks5': {
			const args = ['socks5', server, port];
			if (p.username) args.push('username=' + surgeQuote(p.username));
			if (p.password) args.push('password=' + surgeQuote(p.password));
			return { name, line: displayName + ' = ' + args.join(', ') };
		}
		case 'http': {
			// Surge 的 https 类型即 HTTP-over-TLS 代理
			const args = [p.tls ? 'https' : 'http', server, port];
			if (p.username) args.push('username=' + surgeQuote(p.username));
			if (p.password) args.push('password=' + surgeQuote(p.password));
			if (p.tls) args.push(...tlsArgs);
			return { name, line: displayName + ' = ' + args.join(', ') };
		}
		case 'wireguard': {
			// Surge WireGuard 需要 section-name + [WireGuard xxx] 独立段落
			const section = 'wg-' + (wgIndex || 0);
			const peerArgs = [];
			if (p['public-key']) peerArgs.push('public-key = ' + p['public-key']);
			peerArgs.push('allowed-ips = 0.0.0.0/0');
			peerArgs.push('endpoint = ' + server + ':' + port);
			if (Array.isArray(p.reserved) && p.reserved.length === 3) peerArgs.push('client-id = ' + p.reserved.join('/'));
			const wgSection = [
				'[WireGuard ' + section + ']',
				'private-key = ' + (p['private-key'] || ''),
				'self-ip = ' + (p.ip || '10.0.0.2'),
				'dns-server = 1.1.1.1',
				'peer = (' + peerArgs.join(', ') + ')',
			].join('\n');
			return { name, line: name + ' = wireguard, section-name=' + section, wgSection };
		}
		default:
			// vless / ssr / hysteria / snell 等 Surge 不支持的协议跳过
			return null;
	}
}

// 本地生成完整 Surge 配置文本
async function 生成本地Surge配置(节点文本, env, fileName = DEFAULT_FILE_NAME, 订阅地址 = '', FRonly = false) {
	const lines = String(节点文本 || '').split('\n').map(s => s.trim()).filter(Boolean);
	const proxyLines = [];
	const wgSections = [];
	const names = [];
	const frIndices = [];
	let wgIndex = 0;
	for (const line of lines) {
		let p;
		try { p = uriToClashProxy(line); } catch (e) { p = null; } // 单节点解析失败只跳过该节点
		if (!p || !校验节点(p)) continue; // 协议级校验:不合格节点宁缺毋滥
		const r = clashToSurgeProxy(p, wgIndex);
		if (!r) continue;
		if (r.wgSection) { wgSections.push(r.wgSection); wgIndex++; }
		proxyLines.push(r.line);
		if (!FRonly && 是否法国节点(line, null)) frIndices.push(names.length);
		names.push(r.name);
	}
	if (proxyLines.length === 0) return '# 无可用节点\n';

	// 节点名去重(Surge 要求唯一),同步更新对应的 [Proxy] 行;同时规避 DIRECT/REJECT 等内置保留名
	const seenNames = new Set(['DIRECT', 'REJECT', 'PASS', 'COMPATIBLE', 'REJECT-DROP', '🎯 全球直连', '🛑 全球拦截', '🌍 国外媒体', '📲 电报信息', '💬 Ai平台', '🚀 节点选择', '♻️ 自动选择', '🐟 漏网之鱼', '🇫🇷 法国节点']);
	for (let i = 0; i < names.length; i++) {
		let n = names[i];
		let k = 2;
		while (seenNames.has(n)) { n = names[i] + ' ' + k; k++; }
		seenNames.add(n);
		if (n !== names[i]) {
			names[i] = n;
			// 从引号包裹后的原名字之后定位 ' = '(防止名字本身含该子串)
			const eq = proxyLines[i].indexOf(' = ', surgeQuote(names[i]).length);
			proxyLines[i] = surgeQuote(n) + proxyLines[i].slice(eq);
		}
	}

	const 直连 = '🎯 全球直连';
	const 拦截 = '🛑 全球拦截';
	const 媒体 = '🌍 国外媒体';
	const 电报 = '📲 电报信息';
	const Ai = '💬 Ai平台';
	const 节点选择 = '🚀 节点选择';
	const 自动选择 = '♻️ 自动选择';
	const 漏网 = '🐟 漏网之鱼';
	const frNames = frIndices.map(i => names[i]);
	const 法国组 = '🇫🇷 法国节点';
	const q = v => surgeQuote(v);

	const groups = [
		节点选择 + ' = select, ' + [自动选择, ...names, ...(frNames.length ? [法国组] : []), 直连].map(q).join(', '),
		自动选择 + ' = url-test, ' + names.map(q).join(', ') + ', url=http://www.gstatic.com/generate_204, interval=300, tolerance=100',
		直连 + ' = select, DIRECT',
		拦截 + ' = select, REJECT',
		媒体 + ' = select, ' + [节点选择, 直连].map(q).join(', '),
		电报 + ' = select, ' + [节点选择, 直连].map(q).join(', '),
		Ai + ' = select, ' + [节点选择, 直连].map(q).join(', '),
		漏网 + ' = select, ' + [节点选择, 直连].map(q).join(', '),
	];
	// 法国节点单独成组(FR-only 订阅模式下整份即为法国节点)
	if (frNames.length && !FRonly) groups.push(法国组 + ' = select, ' + [...frNames, 节点选择].map(q).join(', '));

	// 规则复用 Clash 的 KV 缓存规则集,只需把结尾的 MATCH 换成 Surge 的 FINAL
	const rules = (await 获取Clash规则(env)).map(r => r.startsWith('MATCH,') ? 'FINAL,' + r.slice(6) : r);

	const out = [];
	if (订阅地址) out.push('#!MANAGED-CONFIG ' + 订阅地址 + ' interval=86400');
	out.push('[General]');
	out.push('loglevel = notify');
	out.push('dns-server = 223.5.5.5, 8.8.8.8');
	out.push('');
	out.push('[Proxy]');
	for (const l of proxyLines) out.push(l);
	if (wgSections.length) {
		out.push('');
		out.push(...wgSections);
	}
	out.push('');
	out.push('[Proxy Group]');
	for (const g of groups) out.push(g);
	out.push('');
	out.push('[Rule]');
	for (const r of rules) out.push(r);
	return out.join('\n');
}


// ==================== 方案A:本地 Quantumult X / Loon 配置生成(不依赖第三方 SUBAPI) ====================
// 复用 uriToClashProxy 将节点 URI 解析为 Clash 代理对象,再转换为 QX/Loon 节点行,
// 最后组装为完整配置([server_local]/[policy]/[filter_local] 或 [Proxy]/[Proxy Group]/[Rule])。
// 注意:Quantumult X 不支持 tuic/wireguard/socks5/anytls;Loon 不支持 socks5/tuic/anytls。
//       这些协议的节点会被自动跳过(与 Surge 跳过 vless/ssr/hysteria 同理)。

// ===== Quantumult X =====
// QX 配置值:含逗号/引号的值加引号
function qxQuote(v) {
	v = String(v ?? '');
	if (/[",]/.test(v) || /^\s|\s$/.test(v)) return '"' + v.replace(/"/g, '\\"') + '"';
	return v;
}

// 将 Clash 代理对象转换为 QX [server_local] 行;不支持的协议返回 null
function clashToQuanxServer(p) {
	if (!p || !p.server || !p.port) return null;
	const server = String(p.server);
	const port = String(p.port);
	const tag = p.name || (server + ':' + port);
	const net = String(p.network || 'tcp').toLowerCase();

	switch (p.type) {
		case 'ss': {
			const args = ['shadowsocks=' + server + ':' + port, 'method=' + (p.cipher || 'aes-256-gcm'), 'password=' + qxQuote(p.password || '')];
			if (p.plugin === 'obfs') {
				const opts = p['plugin-opts'] || {};
				args.push('obfs=' + (opts.mode || 'http'));
				if (opts.host) args.push('obfs-host=' + qxQuote(opts.host));
			}
			args.push('fast-open=false', 'udp-relay=' + (p.udp ? 'true' : 'false'), 'tag=' + qxQuote(tag));
			return args.join(', ');
		}
		case 'ssr': {
			// QX 的 ssr 复用 shadowsocks= 前缀 + ssr-protocol 参数
			const args = ['shadowsocks=' + server + ':' + port, 'method=' + (p.cipher || 'aes-256-cfb'), 'password=' + qxQuote(p.password || '')];
			if (p.protocol) args.push('ssr-protocol=' + qxQuote(p.protocol));
			if (p['protocol-param']) args.push('ssr-protocol-param=' + qxQuote(p['protocol-param']));
			args.push('obfs=' + (p.obfs || 'plain'));
			if (p['obfs-param']) args.push('obfs-host=' + qxQuote(p['obfs-param']));
			args.push('fast-open=false', 'udp-relay=' + (p.udp ? 'true' : 'false'), 'tag=' + qxQuote(tag));
			return args.join(', ');
		}
		case 'vmess':
		case 'vless': {
			const type = p.type;
			const args = [type + '=' + server + ':' + port];
			if (type === 'vmess') {
				args.push('method=' + (p.cipher && p.cipher !== 'auto' ? p.cipher : 'chacha20-poly1305'), 'password=' + (p.uuid || ''));
			} else {
				args.push('method=none', 'password=' + (p.uuid || ''));
			}
			// obfs 映射: tcp+tls → over-tls; ws → ws; ws+tls → wss; grpc/h2 无对应则降级
			if (net === 'tcp' && p.tls) args.push('obfs=over-tls');
			else if (net === 'ws' && p.tls) args.push('obfs=wss');
			else if (net === 'ws') args.push('obfs=ws');
			if (net === 'ws') {
				const ws = p['ws-opts'] || {};
				if (ws.path) args.push('obfs-uri=' + ws.path);
				if (ws.headers && ws.headers.Host) args.push('obfs-host=' + qxQuote(ws.headers.Host));
			} else if (p.servername || p.sni) {
				args.push('obfs-host=' + qxQuote(p.servername || p.sni));
			}
			if (p.tls) args.push('tls-verification=false');
			args.push('fast-open=false', 'udp-relay=' + (p.udp ? 'true' : 'false'), 'tag=' + qxQuote(tag));
			return args.join(', ');
		}
		case 'trojan': {
			const args = ['trojan=' + server + ':' + port, 'password=' + qxQuote(p.password || ''), 'over-tls=true'];
			if (p.servername || p.sni) args.push('tls-host=' + qxQuote(p.servername || p.sni));
			args.push('tls-verification=false');
			if (net === 'ws') {
				args.push('obfs=wss');
				const ws = p['ws-opts'] || {};
				if (ws.path) args.push('obfs-uri=' + ws.path);
				if (ws.headers && ws.headers.Host) args.push('obfs-host=' + qxQuote(ws.headers.Host));
			}
			args.push('fast-open=false', 'udp-relay=' + (p.udp ? 'true' : 'false'), 'tag=' + qxQuote(tag));
			return args.join(', ');
		}
		case 'http': {
			const args = ['http=' + server + ':' + port];
			if (p.username) args.push('username=' + qxQuote(p.username));
			if (p.password) args.push('password=' + qxQuote(p.password));
			if (p.tls) {
				args.push('over-tls=true');
				if (p.servername || p.sni) args.push('tls-host=' + qxQuote(p.servername || p.sni));
				args.push('tls-verification=false');
			}
			args.push('fast-open=false', 'udp-relay=' + (p.udp ? 'true' : 'false'), 'tag=' + qxQuote(tag));
			return args.join(', ');
		}
		case 'hysteria2': {
			// QX 新版支持 hysteria2(社区公认语法)
			const args = ['hysteria2=' + server + ':' + port, 'password=' + qxQuote(p.password || '')];
			if (p.obfs) {
				args.push('obfs=salamander');
				if (p['obfs-password']) args.push('obfs-password=' + qxQuote(p['obfs-password']));
			}
			if (p.up) args.push('up=' + p.up);
			if (p.down) args.push('down=' + p.down);
			if (p.sni) args.push('sni=' + qxQuote(p.sni));
			if (p['skip-cert-verify']) args.push('skip-cert-verify=true');
			args.push('fast-open=false', 'udp-relay=' + (p.udp ? 'true' : 'false'), 'tag=' + qxQuote(tag));
			return args.join(', ');
		}
		default:
			// tuic / wireguard / socks5 / anytls / hysteria(v1) 等 QX 不支持的协议跳过
			return null;
	}
}

// QX 规则转换:Clash 规则行 -> QX [filter_local] 行;不支持的规则类型返回 null
function clashRuleToQuanx(r) {
	const parts = String(r).split(',').map(s => s.trim());
	const type = String(parts[0] || '').toLowerCase();
	// 规范化后的规则形如 IP-CIDR,x.x.x.x/x,策略名,no-resolve:
	// no-resolve 位于行末,策略名需取最后一个非 no-resolve 字段
	const hasNoResolve = parts.some(x => x.toLowerCase() === 'no-resolve');
	const meaningful = parts.slice(1).filter(x => x.toLowerCase() !== 'no-resolve');
	const value = String(meaningful[0] || '').trim();
	const policy = String(meaningful[meaningful.length - 1] || '').trim();
	switch (type) {
		case 'domain-suffix': return 'host-suffix, ' + value + ', ' + policy;
		case 'domain-keyword': return 'host-keyword, ' + value + ', ' + policy;
		case 'domain': return 'host, ' + value + ', ' + policy;
		case 'ip-cidr': return 'ip-cidr, ' + value + ', ' + policy + (hasNoResolve ? ', no-resolve' : '');
		case 'ip-cidr6': return 'ip6-cidr, ' + value + ', ' + policy + (hasNoResolve ? ', no-resolve' : '');
		case 'geoip': return 'geoip, ' + value.toLowerCase() + ', ' + policy;
		case 'match': return 'final, ' + policy;
		default: return null; // 跳过不支持的规则类型
	}
}

// 本地生成完整 Quantumult X 配置
async function 生成本地Quanx配置(节点文本, env, fileName = DEFAULT_FILE_NAME, FRonly = false) {
	const lines = String(节点文本 || '').split('\n').map(s => s.trim()).filter(Boolean);
	const servers = [];
	const names = [];
	const frIndices = [];
	for (const line of lines) {
		let p;
		try { p = uriToClashProxy(line); } catch (e) { p = null; } // 单节点解析失败只跳过该节点
		if (!p || !校验节点(p)) continue; // 协议级校验:不合格节点宁缺毋滥
		const s = clashToQuanxServer(p);
		if (!s) continue;
		servers.push(s);
		if (!FRonly && 是否法国节点(line, null)) frIndices.push(names.length);
		names.push(p.name || (p.server + ':' + p.port));
	}
	if (servers.length === 0) return '# 无可用节点\n';

	// 节点名去重(QX 的 tag 需唯一);同时规避内置保留名
	const seenNames = new Set(['DIRECT', 'REJECT', 'PASS', 'COMPATIBLE', 'REJECT-DROP', 'direct', 'reject', 'proxy', '🎯 全球直连', '🛑 全球拦截', '🌍 国外媒体', '📲 电报信息', '💬 Ai平台', '🚀 节点选择', '♻️ 自动选择', '🐟 漏网之鱼', '🇫🇷 法国节点']);
	for (let i = 0; i < names.length; i++) {
		let n = names[i];
		let k = 2;
		while (seenNames.has(n)) { n = names[i] + ' ' + k; k++; }
		seenNames.add(n);
		names[i] = n;
		const tagIdx = servers[i].lastIndexOf('tag=');
		servers[i] = servers[i].slice(0, tagIdx) + 'tag=' + qxQuote(n);
	}

	const 直连 = '🎯 全球直连';
	const 拦截 = '🛑 全球拦截';
	const 媒体 = '🌍 国外媒体';
	const 电报 = '📲 电报信息';
	const Ai = '💬 Ai平台';
	const 节点选择 = '🚀 节点选择';
	const 自动选择 = '♻️ 自动选择';
	const 漏网 = '🐟 漏网之鱼';

	const frNames = frIndices.map(i => names[i]);
	const 法国组 = '🇫🇷 法国节点';
	const qxq = v => qxQuote(v);
	const policies = [
		'static=' + 节点选择 + ', ' + [自动选择, ...names, ...(frNames.length ? [法国组] : []), 直连].map(qxq).join(', '),
		'url-latency-benchmark=' + 自动选择 + ', ' + names.map(qxq).join(', ') + ', check-interval=300, alive-checking=true, tolerance=0',
		'static=' + 直连 + ', direct',
		'static=' + 拦截 + ', reject',
		'static=' + 媒体 + ', ' + [节点选择, 直连].map(qxq).join(', '),
		'static=' + 电报 + ', ' + [节点选择, 直连].map(qxq).join(', '),
		'static=' + Ai + ', ' + [节点选择, 直连].map(qxq).join(', '),
		'static=' + 漏网 + ', ' + [节点选择, 直连].map(qxq).join(', '),
	];
	// 法国节点单独成组(FR-only 订阅模式下整份即为法国节点)
	if (frNames.length && !FRonly) policies.push('static=' + 法国组 + ', ' + [...frNames, 节点选择].map(qxq).join(', '));

	// 规则复用 Clash 的 KV 缓存规则集,转换为 QX 语法
	const rules = (await 获取Clash规则(env))
		.map(clashRuleToQuanx)
		.filter(Boolean);
	// 兜底:内置局域网直连 + geoip cn
	const builtin = ['ip-cidr, 127.0.0.0/8, direct, no-resolve', 'ip-cidr, 10.0.0.0/8, direct, no-resolve', 'ip-cidr, 172.16.0.0/12, direct, no-resolve', 'ip-cidr, 192.168.0.0/16, direct, no-resolve', 'geoip, cn, direct'];
	for (const b of builtin) if (!rules.includes(b)) rules.unshift(b);
	if (!rules.some(r => r.startsWith('final,'))) rules.push('final, ' + 漏网);

	const out = [];
	out.push('[server_local]');
	for (const s of servers) out.push(s);
	out.push('');
	out.push('[policy]');
	for (const pol of policies) out.push(pol);
	out.push('');
	out.push('[filter_local]');
	for (const r of rules) out.push(r);
	return out.join('\n');
}

// ===== Loon =====
// Loon 配置值:含逗号/引号的值加引号(官方示例中密码均带引号)
function loonQuote(v) {
	v = String(v ?? '');
	if (/[",]/.test(v) || /^\s|\s$/.test(v)) return '"' + v.replace(/"/g, '\\"') + '"';
	return v;
}

// Loon 官方示例中密码/UUID 始终带引号,避免密码含逗号时整行解析失败
function loonPass(v) {
	return '"' + String(v ?? '').replace(/"/g, '\\"') + '"';
}

// 将 Clash 代理对象转换为 Loon [Proxy] 行;不支持的协议返回 null
function clashToLoonProxy(p) {
	if (!p || !p.server || !p.port) return null;
	const name = String(p.name || (p.server + ':' + p.port));
	// [Proxy] 行首的节点名若含逗号/引号需要加引号,否则整行解析失败
	const displayName = loonQuote(name);
	const server = String(p.server);
	const port = String(p.port);
	const net = String(p.network || 'tcp').toLowerCase();

	switch (p.type) {
		case 'ss': {
			const args = ['Shadowsocks', server, port, p.cipher || 'aes-256-gcm', loonPass(p.password)];
			if (p.plugin === 'obfs') {
				const opts = p['plugin-opts'] || {};
				args.push('obfs-name=' + (opts.mode || 'http'));
				if (opts.host) args.push('obfs-host=' + loonQuote(opts.host));
				args.push('obfs-uri=/');
			}
			args.push('fast-open=false', 'udp=true');
			return displayName + ' = ' + args.join(',');
		}
		case 'ssr': {
			const args = ['ShadowsocksR', server, port, p.cipher || 'aes-256-cfb', loonPass(p.password)];
			args.push('protocol=' + (p.protocol || 'origin'));
			if (p['protocol-param']) args.push('protocol-param=' + loonQuote(p['protocol-param']));
			args.push('obfs=' + (p.obfs || 'plain'));
			if (p['obfs-param']) args.push('obfs-param=' + loonQuote(p['obfs-param']));
			args.push('fast-open=false', 'udp=true');
			return displayName + ' = ' + args.join(',');
		}
		case 'vmess': {
			const args = ['vmess', server, port, p.cipher && p.cipher !== 'auto' ? p.cipher : 'auto', loonPass(p.uuid)];
			args.push('transport=' + (net === 'tcp' ? 'tcp' : net));
			args.push('alterId=' + (p.alterId || 0));
			if (net === 'ws') {
				const ws = p['ws-opts'] || {};
				args.push('path=' + (ws.path || '/'));
				if (ws.headers && ws.headers.Host) args.push('host=' + loonQuote(ws.headers.Host));
			}
			if (p.tls) {
				args.push('over-tls=true');
				if (p.servername || p.sni) args.push('tls-name=' + loonQuote(p.servername || p.sni));
				if (p['skip-cert-verify']) args.push('skip-cert-verify=true');
			}
			return displayName + ' = ' + args.join(',');
		}
		case 'vless': {
			const args = ['VLESS', server, port, loonPass(p.uuid)];
			args.push('transport=' + (net === 'tcp' ? 'tcp' : net));
			if (net === 'ws') {
				const ws = p['ws-opts'] || {};
				args.push('path=' + (ws.path || '/'));
				if (ws.headers && ws.headers.Host) args.push('host=' + loonQuote(ws.headers.Host));
			}
			if (p.tls) {
				args.push('over-tls=true');
				if (p.servername || p.sni) args.push('tls-name=' + loonQuote(p.servername || p.sni));
				if (p['skip-cert-verify']) args.push('skip-cert-verify=true');
			}
			return displayName + ' = ' + args.join(',');
		}
		case 'trojan': {
			const args = ['trojan', server, port, loonPass(p.password)];
			if (net === 'ws') {
				const ws = p['ws-opts'] || {};
				args.push('transport=ws', 'path=' + (ws.path || '/'));
				if (ws.headers && ws.headers.Host) args.push('host=' + loonQuote(ws.headers.Host));
			}
			if (p.servername || p.sni) args.push('tls-name=' + loonQuote(p.servername || p.sni));
			if (p['skip-cert-verify']) args.push('skip-cert-verify=true');
			args.push('udp=true');
			return displayName + ' = ' + args.join(',');
		}
		case 'hysteria2': {
			const args = ['Hysteria2', server, port, loonPass(p.password)];
			if (p['skip-cert-verify']) args.push('skip-cert-verify=true');
			if (p.sni) args.push('tls-name=' + loonQuote(p.sni));
			args.push('udp=true', 'fast-open=true');
			return displayName + ' = ' + args.join(',');
		}
		case 'wireguard': {
			// Loon wireguard 官方格式(interface-ip + private-key + peers 数组)
			const args = ['wireguard'];
			if (p.ip) args.push('interface-ip=' + p.ip);
			if (p['private-key']) args.push('private-key="' + p['private-key'] + '"');
			if (p.mtu) args.push('mtu=' + p.mtu);
			const peer = [];
			if (p['public-key']) peer.push('public-key="' + p['public-key'] + '"');
			if (p['pre-shared-key']) peer.push('preshared-key="' + p['pre-shared-key'] + '"');
			if (Array.isArray(p.reserved) && p.reserved.length) peer.push('reserved=[' + p.reserved.join(',') + ']');
			peer.push('allowed-ips="0.0.0.0/0"');
			peer.push('endpoint=' + server + ':' + port);
			args.push('peers=[{' + peer.join(',') + '}]');
			args.push('keepalive=45');
			return displayName + ' = ' + args.join(',');
		}
		case 'http': {
			const args = [p.tls ? 'https' : 'http', server, port];
			if (p.username) args.push(loonPass(p.username));
			if (p.password) args.push(loonPass(p.password));
			if (p.tls) {
				if (p.servername || p.sni) args.push('tls-name=' + loonQuote(p.servername || p.sni));
				if (p['skip-cert-verify']) args.push('skip-cert-verify=true');
			}
			return displayName + ' = ' + args.join(',');
		}
		default:
			// socks5 / tuic / anytls / hysteria(v1) 等 Loon 不支持的协议跳过
			return null;
	}
}

// Loon 规则转换:Clash 规则行 -> Loon [Rule] 行(Loon 规则与 Surge 几乎一致)
function clashRuleToLoon(r) {
	const parts = String(r).split(',');
	const type = String(parts[0] || '').trim().toLowerCase();
	if (type === 'match') return 'FINAL,' + parts.slice(1).join(',').trim();
	return String(r).trim();
}

// 本地生成完整 Loon 配置
async function 生成本地Loon配置(节点文本, env, fileName = DEFAULT_FILE_NAME, FRonly = false) {
	const lines = String(节点文本 || '').split('\n').map(s => s.trim()).filter(Boolean);
	const proxies = [];
	const frIndices = [];
	const names = [];
	for (const line of lines) {
		let p;
		try { p = uriToClashProxy(line); } catch (e) { p = null; } // 单节点解析失败只跳过该节点
		if (!p || !校验节点(p)) continue; // 协议级校验:不合格节点宁缺毋滥(与其他格式生成器一致)
		const pr = clashToLoonProxy(p);
		if (!pr) continue;
		proxies.push(pr);
		if (!FRonly && 是否法国节点(line, null)) frIndices.push(names.length);
		names.push(p.name || (p.server + ':' + p.port));
	}
	if (proxies.length === 0) return '# 无可用节点\n';

	// 节点名去重(Loon 要求唯一),同步更新 [Proxy] 行;同时规避 DIRECT/REJECT 等内置保留名
	const seenNames = new Set(['DIRECT', 'REJECT', 'PASS', 'COMPATIBLE', 'REJECT-DROP', '🎯 全球直连', '🛑 全球拦截', '🌍 国外媒体', '📲 电报信息', '💬 Ai平台', '🚀 节点选择', '♻️ 自动选择', '🐟 漏网之鱼', '🇫🇷 法国节点']);
	for (let i = 0; i < names.length; i++) {
		let n = names[i];
		let k = 2;
		while (seenNames.has(n)) { n = names[i] + ' ' + k; k++; }
		seenNames.add(n);
		if (n !== names[i]) {
			names[i] = n;
			// 从引号包裹后的原名字之后定位 ' = '(防止名字本身含该子串)
			const eq = proxies[i].indexOf(' = ', loonQuote(names[i]).length);
			proxies[i] = loonQuote(n) + proxies[i].slice(eq);
		}
	}

	const 直连 = '🎯 全球直连';
	const 拦截 = '🛑 全球拦截';
	const 媒体 = '🌍 国外媒体';
	const 电报 = '📲 电报信息';
	const Ai = '💬 Ai平台';
	const 节点选择 = '🚀 节点选择';
	const 自动选择 = '♻️ 自动选择';
	const 漏网 = '🐟 漏网之鱼';

	const frNames = frIndices.map(i => names[i]);
	const 法国组 = '🇫🇷 法国节点';
	const loonq = v => loonQuote(v);
	const groups = [
		节点选择 + ' = select, ' + [自动选择, ...names, ...(frNames.length ? [法国组] : []), 直连].map(loonq).join(', '),
		自动选择 + ' = url-test, ' + names.map(loonq).join(', ') + ', url=http://www.gstatic.com/generate_204, interval=300, tolerance=100',
		直连 + ' = select, DIRECT',
		拦截 + ' = select, REJECT',
		媒体 + ' = select, ' + [节点选择, 直连].map(loonq).join(', '),
		电报 + ' = select, ' + [节点选择, 直连].map(loonq).join(', '),
		Ai + ' = select, ' + [节点选择, 直连].map(loonq).join(', '),
		漏网 + ' = select, ' + [节点选择, 直连].map(loonq).join(', '),
	];
	// 法国节点单立成组(FR-only 订阅模式下整份即为法国节点)
	if (frNames.length && !FRonly) groups.push(法国组 + ' = select, ' + [...frNames, 节点选择].map(loonq).join(', '));

	const rules = (await 获取Clash规则(env)).map(clashRuleToLoon);
	if (!rules.some(r => r.startsWith('FINAL,'))) rules.push('FINAL,' + 漏网);

	const out = [];
	out.push('[Proxy]');
	for (const pr of proxies) out.push(pr);
	out.push('');
	out.push('[Proxy Group]');
	for (const g of groups) out.push(g);
	out.push('');
	out.push('[Rule]');
	for (const r of rules) out.push(r);
	return out.join('\n');
}


