// ==================== 本地多格式订阅解析(零第三方依赖) ====================
// 除 Clash YAML / sing-box JSON / base64 / 明文节点外,额外本地识别:
// Surge / Loon profile、Quantumult X 配置、v2ray / Xray JSON、SS JSON 列表,
// 以及"base64 包裹的其他格式",全部就地转换为节点 URI。
// 至此,任何订阅源响应都不再需要交给第三方 SUBAPI 转换。

// 按逗号拆分配置行(尊重双引号与 []/{}/( ) 嵌套,防止 peers=[{...}] 被拆散)
function splitCSVLine(str) {
	const tokens = [];
	let cur = '';
	let inQuote = false;
	let depth = 0;
	for (let i = 0; i < str.length; i++) {
		const c = str[i];
		if (inQuote) {
			if (c === '"') {
				if (str[i + 1] === '"') { cur += '"'; i++; }
				else inQuote = false;
			} else cur += c;
		} else if (c === '"') inQuote = true;
		else if (c === '[' || c === '{' || c === '(') { depth++; cur += c; }
		else if (c === ']' || c === '}' || c === ')') { depth--; cur += c; }
		else if (c === ',' && depth === 0) { tokens.push(cur); cur = ''; }
		else cur += c;
	}
	tokens.push(cur);
	return tokens;
}

// 去掉配置值首尾的双引号
function unquoteSurge(v) {
	const s = String(v ?? '').trim();
	if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') return s.slice(1, -1);
	return s;
}

// 从 "Host:xxx|X-Token:yyy" 这类 Surge ws-headers 中取指定 header 值
function surgeHeaderValue(headers, key) {
	if (!headers) return '';
	for (const part of String(headers).split('|')) {
		const idx = part.indexOf(':');
		if (idx > 0 && part.slice(0, idx).trim().toLowerCase() === key.toLowerCase()) return part.slice(idx + 1).trim();
	}
	return '';
}

// 解析 "{k = v, k2 = [1,2], ...}" 或 "(k = v, ...)" 风格的对象
function parseBracedPairs(str) {
	const inner = String(str).trim().replace(/^[\[{(]/, '').replace(/[\]})]$/, '');
	const obj = {};
	for (const part of splitCSVLine(inner)) {
		const eq = part.indexOf('=');
		if (eq <= 0) continue;
		const k = part.slice(0, eq).trim().toLowerCase();
		let v = part.slice(eq + 1).trim();
		if (v.startsWith('[') && v.endsWith(']')) {
			obj[k] = v.slice(1, -1).split(',').map(x => Number(x.trim())).filter(n => !Number.isNaN(n));
		} else {
			obj[k] = unquoteSurge(v);
		}
	}
	return obj;
}

// 解析 Surge/Loon [Proxy] 行:Name = type, host, port, [位置参数...], k=v, ...
function parseProfileProxyLine(line) {
	const eq = line.indexOf('=');
	if (eq === -1) return null;
	const name = unquoteSurge(line.slice(0, eq));
	if (!name || name.startsWith('[') || name.startsWith('#')) return null;
	const tokens = splitCSVLine(line.slice(eq + 1));
	if (tokens.length < 2) return null;
	const type = tokens[0].trim().toLowerCase();
	// wireguard 的主机/端口位于 [WireGuard] 段的 peer endpoint 中,代理行本身不包含
	const server = tokens.length >= 3 ? unquoteSurge(tokens[1]) : '';
	const port = tokens.length >= 3 ? Number(unquoteSurge(tokens[2])) : 0;
	if (type !== 'wireguard' && (!server || !port)) return null;
	const kv = {};
	const positional = [];
	// wireguard 无行内 host/port,其 k=v 参数从第 2 个 token 开始;普通代理从第 4 个开始
	const kvStart = type === 'wireguard' ? 1 : 3;
	for (let i = kvStart; i < tokens.length; i++) {
		const t = tokens[i].trim();
		if (!t) continue;
		const eqi = t.indexOf('=');
		if (eqi > 0) kv[t.slice(0, eqi).trim().toLowerCase()] = unquoteSurge(t.slice(eqi + 1));
		else positional.push(unquoteSurge(t));
	}
	return { name, type, server, port, kv, positional };
}

// 将 Surge/Loon [Proxy] 节点行映射为 Clash 代理对象(与 uriToClashProxy 输出同构)
function profileProxyToClash(parsed) {
	const { name, type, server, port, kv, positional } = parsed;
	const base = { name: name || (server + ':' + port), server, port };
	const net = kv['transport'] || kv['network'] || (kv['ws'] === 'true' ? 'ws' : (kv['grpc'] === 'true' ? 'grpc' : 'tcp'));
	if (net !== 'tcp') base.network = net; // ws/grpc/h2 传输层必须随 URI 保留
	const wsOpts = (path, host) => ({ path: path || '/', headers: host ? { Host: host } : undefined });
	switch (type) {
		case 'ss':
		case 'shadowsocks': {
			const p = { ...base, type: 'ss', cipher: kv['encrypt-method'] || kv['method'] || kv['cipher'] || positional[0] || 'aes-256-gcm', password: kv['password'] || positional[1] || '', udp: true };
			if (kv['obfs'] && kv['obfs'] !== 'none') { p.plugin = 'obfs'; p['plugin-opts'] = { mode: kv['obfs'], host: kv['obfs-host'] || '' }; }
			return p;
		}
		case 'ssr':
		case 'shadowsocksr': {
			const p = { ...base, type: 'ssr', cipher: kv['cipher'] || kv['encrypt-method'] || positional[0] || 'aes-256-cfb', password: kv['password'] || positional[1] || '', protocol: kv['protocol'] || 'origin', obfs: kv['obfs'] || 'plain' };
			if (kv['obfs-param']) p['obfs-param'] = kv['obfs-param'];
			if (kv['protocol-param']) p['protocol-param'] = kv['protocol-param'];
			return p;
		}
		case 'vmess': {
			const p = { ...base, type: 'vmess', uuid: kv['username'] || kv['uuid'] || kv['password'] || positional[1] || '', alterId: Number(kv['alterid'] || kv['alter-id'] || 0), cipher: kv['cipher'] || kv['encrypt-method'] || kv['method'] || positional[0] || 'auto', udp: true };
			if (net === 'ws') p['ws-opts'] = wsOpts(kv['ws-path'] || kv['path'], kv['ws-headers'] ? surgeHeaderValue(kv['ws-headers'], 'Host') : (kv['host'] || ''));
			else if (net === 'grpc') p['grpc-opts'] = { 'grpc-service-name': kv['grpc-service-name'] || kv['path'] || '' };
			if (kv['tls'] === 'true' || kv['over-tls'] === 'true') {
				p.tls = true;
				if (kv['sni'] || kv['tls-name'] || kv['servername']) p.servername = kv['sni'] || kv['tls-name'] || kv['servername'];
				if (kv['skip-cert-verify'] === 'true' || kv['skip-cert-verification'] === 'true') p['skip-cert-verify'] = true;
			}
			return p;
		}
		case 'vless': {
			const p = { ...base, type: 'vless', uuid: kv['username'] || kv['uuid'] || kv['password'] || positional[0] || '', udp: true };
			if (kv['flow']) p.flow = kv['flow'];
			if (net === 'ws') p['ws-opts'] = wsOpts(kv['ws-path'] || kv['path'], kv['host'] || '');
			else if (net === 'grpc') p['grpc-opts'] = { 'grpc-service-name': kv['grpc-service-name'] || kv['path'] || '' };
			if (kv['tls'] === 'true' || kv['over-tls'] === 'true') {
				p.tls = true;
				if (kv['sni'] || kv['tls-name'] || kv['servername']) p.servername = kv['sni'] || kv['tls-name'] || kv['servername'];
				if (kv['skip-cert-verify'] === 'true') p['skip-cert-verify'] = true;
			}
			return p;
		}
		case 'trojan': {
			const p = { ...base, type: 'trojan', password: kv['password'] || positional[0] || '', udp: true, tls: true };
			if (net === 'ws') p['ws-opts'] = wsOpts(kv['ws-path'] || kv['path'], kv['host'] || '');
			else if (net === 'grpc') p['grpc-opts'] = { 'grpc-service-name': kv['grpc-service-name'] || kv['path'] || '' };
			if (kv['sni'] || kv['tls-name'] || kv['servername']) p.servername = kv['sni'] || kv['tls-name'] || kv['servername'];
			if (kv['skip-cert-verify'] === 'true') p['skip-cert-verify'] = true;
			return p;
		}
		case 'hysteria2':
		case 'hy2': {
			const p = { ...base, type: 'hysteria2', password: kv['password'] || positional[0] || '' };
			if (kv['sni'] || kv['tls-name']) p.sni = kv['sni'] || kv['tls-name'];
			if (kv['skip-cert-verify'] === 'true') p['skip-cert-verify'] = true;
			if (kv['upload-bandwidth'] || kv['up']) p.up = kv['upload-bandwidth'] || kv['up'];
			if (kv['download-bandwidth'] || kv['down']) p.down = kv['download-bandwidth'] || kv['down'];
			if (kv['salamander-password'] || kv['obfs-password']) { p.obfs = 'salamander'; p['obfs-password'] = kv['salamander-password'] || kv['obfs-password']; }
			else if (kv['obfs'] && kv['obfs'] !== 'none') { p.obfs = kv['obfs']; }
			return p;
		}
		case 'tuic':
		case 'tuic-v5': {
			const p = { ...base, type: 'tuic', uuid: kv['uuid'] || positional[0] || '', password: kv['password'] || kv['token'] || positional[1] || '' };
			if (kv['sni'] || kv['tls-name']) p.sni = kv['sni'] || kv['tls-name'];
			if (kv['congestion-control']) p['congestion-controller'] = kv['congestion-control'];
			if (kv['alpn']) p.alpn = String(kv['alpn']).split(',');
			if (kv['skip-cert-verify'] === 'true') p['skip-cert-verify'] = true;
			if (type === 'tuic-v5' || kv['tuic-v5'] === 'true') p['reduce-rtt'] = true;
			return p;
		}
		case 'anytls': {
			const p = { ...base, type: 'anytls', password: kv['password'] || positional[0] || '' };
			if (kv['sni'] || kv['tls-name']) p.sni = kv['sni'] || kv['tls-name'];
			if (kv['skip-cert-verify'] === 'true') p['skip-cert-verify'] = true;
			if (kv['udp'] === 'true') p.udp = true;
			return p;
		}
		case 'socks5':
		case 'socks': {
			const p = { ...base, type: 'socks5' };
			if (kv['username'] || positional[0]) p.username = kv['username'] || positional[0];
			if (kv['password'] || positional[1]) p.password = kv['password'] || positional[1];
			if (kv['udp'] === 'true') p.udp = true;
			return p;
		}
		case 'http':
		case 'https': {
			const p = { ...base, type: 'http' };
			if (kv['username'] || positional[0]) p.username = kv['username'] || positional[0];
			if (kv['password'] || positional[1]) p.password = kv['password'] || positional[1];
			if (type === 'https' || kv['tls'] === 'true') p.tls = true;
			return p;
		}
		default:
			return null;
	}
}

// 将 Surge/Loon wireguard 节点(行内 peers 或 [WireGuard] 段)映射为 Clash 代理对象
function profileWGToClash(parsed, wg) {
	const { name, kv } = parsed;
	const wgkv = wg || {};
	let endpoint = '';
	let publicKey = '';
	let preSharedKey = '';
	let reserved = [];
	if (kv['peers']) {
		const raw = String(kv['peers']).trim().replace(/^\[/, '').replace(/\]$/, '');
		const peers = [];
		for (const chunk of splitCSVLine(raw)) if (chunk.trim()) peers.push(parseBracedPairs(chunk));
		const peer0 = peers[0] || {};
		endpoint = peer0['endpoint'] || '';
		publicKey = peer0['public-key'] || '';
		preSharedKey = peer0['preshared-key'] || '';
		if (Array.isArray(peer0['reserved'])) reserved = peer0['reserved'];
	} else if (wgkv['peer'] && typeof wgkv['peer'] === 'object') {
		endpoint = wgkv['peer']['endpoint'] || '';
		publicKey = wgkv['peer']['public-key'] || '';
		preSharedKey = wgkv['peer']['preshared-key'] || '';
		if (wgkv['peer']['client-id']) reserved = String(wgkv['peer']['client-id']).split('/').map(Number);
	}
	// 注:allowed-ips / keepalive 等字段仅作保留,wireguard URI 方案不携带,无需引用
	if (!endpoint || !publicKey) return null;
	const hm = endpoint.match(/^\[(.+)\]:(\d+)$/) || endpoint.match(/^([^:]+):(\d+)$/);
	if (!hm) return null;
	const p = {
		name,
		type: 'wireguard',
		server: hm[1],
		port: Number(hm[2]),
		ip: kv['interface-ip'] || kv['self-ip'] || wgkv['self-ip'] || '10.0.0.2',
		'public-key': publicKey,
		'private-key': kv['private-key'] || wgkv['private-key'] || '',
		udp: true,
	};
	if (preSharedKey) p['pre-shared-key'] = preSharedKey;
	if (reserved && reserved.length) p.reserved = reserved;
	if (kv['mtu'] || wgkv['mtu']) p.mtu = Number(kv['mtu'] || wgkv['mtu']);
	return p;
}

// 解析 Surge / Loon profile 的 [Proxy] 段 + [WireGuard] 段
function surgeLoonProfileToURIs(content, fileName = DEFAULT_FILE_NAME) {
	const lines = String(content).split('\n');
	const proxyLines = [];
	const wgSections = {};
	let inProxy = false;
	let inWG = null;
	for (const raw of lines) {
		const line = raw.trim();
		if (!line || line.startsWith('#') || line.startsWith(';')) continue;
		if (line.startsWith('[')) {
			const close = line.indexOf(']');
			const section = (close === -1 ? line.slice(1) : line.slice(1, close)).trim().toLowerCase();
			inProxy = section === 'proxy';
			if (section.startsWith('wireguard ')) {
				inWG = section.slice('wireguard'.length).trim();
				wgSections[inWG] = {};
			} else {
				inWG = null;
			}
			continue;
		}
		if (inProxy) {
			proxyLines.push(line);
		} else if (inWG) {
			const eq = line.indexOf('=');
			if (eq === -1) continue;
			const k = line.slice(0, eq).trim().toLowerCase();
			let v = line.slice(eq + 1).trim();
			if (k === 'peer') v = parseBracedPairs(v);
			wgSections[inWG][k] = v;
		}
	}
	const uris = [];
	for (const line of proxyLines) {
		const parsed = parseProfileProxyLine(line);
		if (!parsed) continue;
		const p = parsed.type === 'wireguard' ? profileWGToClash(parsed, wgSections[parsed.kv['section-name']] || wgSections[parsed.name]) : profileProxyToClash(parsed);
		if (!p) continue;
		const uri = clashProxyToURI(p, fileName);
		if (uri) uris.push(uri);
	}
	return uris;
}

// 解析 Quantumult X 的 [server_local] 段:proto=host:port, method=..., password=..., tag=...
function quanxServerToURIs(content, fileName = DEFAULT_FILE_NAME) {
	const lines = String(content).split('\n');
	const uris = [];
	for (const raw of lines) {
		const line = raw.trim();
		if (!line || line.startsWith('#') || line.startsWith(';') || line.startsWith('[')) continue;
		const eq = line.indexOf('=');
		if (eq === -1) continue;
		const proto = line.slice(0, eq).trim().toLowerCase();
		const rest = line.slice(eq + 1).trim();
		const commaIdx = rest.indexOf(',');
		const hostPort = (commaIdx === -1 ? rest : rest.slice(0, commaIdx)).trim();
		const hm = hostPort.match(/^\[(.+)\]:(\d+)$/) || hostPort.match(/^([^:]+):(\d+)$/);
		if (!hm) continue;
		const server = hm[1];
		const port = Number(hm[2]);
		if (!port) continue;
		const kv = {};
		if (commaIdx !== -1) {
			for (const part of splitCSVLine(rest.slice(commaIdx + 1))) {
				const i2 = part.indexOf('=');
				if (i2 > 0) kv[part.slice(0, i2).trim().toLowerCase()] = unquoteSurge(part.slice(i2 + 1));
			}
		}
		const base = { name: kv['tag'] || (server + ':' + port), server, port };
		let p = null;
		if (proto === 'shadowsocks') {
			p = { ...base, type: 'ss', cipher: kv['method'] || 'aes-256-gcm', password: kv['password'] || '', udp: true };
			if (kv['obfs'] === 'http' || kv['obfs'] === 'tls') {
				p.plugin = 'obfs';
				p['plugin-opts'] = { mode: kv['obfs'], host: kv['obfs-host'] || '' };
			}
			if (kv['ssr-protocol'] && kv['ssr-protocol'] !== 'origin') {
				p = { ...base, type: 'ssr', cipher: kv['method'] || 'aes-256-cfb', password: kv['password'] || '', protocol: kv['ssr-protocol'], obfs: kv['obfs'] || 'plain' };
				if (kv['ssr-protocol-param']) p['protocol-param'] = kv['ssr-protocol-param'];
				if (kv['obfs-param']) p['obfs-param'] = kv['obfs-param'];
			}
		} else if (proto === 'vmess' || proto === 'vless') {
			const isVless = proto === 'vless';
			p = { ...base, type: isVless ? 'vless' : 'vmess', uuid: kv['password'] || '', udp: kv['udp-relay'] === 'true' };
			if (!isVless) { p.alterId = Number(kv['aid'] || 0); p.cipher = kv['method'] || 'auto'; }
			const obfs = kv['obfs'];
			if (obfs === 'wss') { p.tls = true; p.network = 'ws'; }
			else if (obfs === 'ws') { p.network = 'ws'; }
			else if (obfs === 'over-tls') { p.tls = true; }
			else if (obfs === 'http' || obfs === 'h2') { p.network = 'h2'; }
			if (p.network === 'ws') p['ws-opts'] = { path: kv['obfs-uri'] || '/', headers: kv['obfs-host'] ? { Host: kv['obfs-host'] } : undefined };
			if (p.tls) {
				if (kv['obfs-host']) p.servername = kv['obfs-host'];
				if (kv['tls-verification'] === 'false') p['skip-cert-verify'] = true;
			}
		} else if (proto === 'trojan') {
			p = { ...base, type: 'trojan', password: kv['password'] || '', udp: true, tls: true };
			if (kv['obfs'] === 'wss' || kv['obfs'] === 'ws') {
				p.network = 'ws';
				p['ws-opts'] = { path: kv['obfs-uri'] || '/', headers: kv['obfs-host'] ? { Host: kv['obfs-host'] } : undefined };
			}
			if (kv['tls-host']) p.servername = kv['tls-host'];
			if (kv['tls-verification'] === 'false') p['skip-cert-verify'] = true;
		} else if (proto === 'http' || proto === 'https') {
			p = { ...base, type: 'http' };
			if (kv['username']) p.username = kv['username'];
			if (kv['password']) p.password = kv['password'];
			if (proto === 'https' || kv['over-tls'] === 'true') p.tls = true;
		} else if (proto === 'hysteria2' || proto === 'hy2') {
			p = { ...base, type: 'hysteria2', password: kv['password'] || '' };
			if (kv['sni']) p.sni = kv['sni'];
			if (kv['skip-cert-verify'] === 'true') p['skip-cert-verify'] = true;
			if (kv['up']) p.up = kv['up'];
			if (kv['down']) p.down = kv['down'];
			if (kv['obfs'] === 'salamander') { p.obfs = 'salamander'; if (kv['obfs-password']) p['obfs-password'] = kv['obfs-password']; }
		}
		if (!p) continue;
		const uri = clashProxyToURI(p, fileName);
		if (uri) uris.push(uri);
	}
	return uris;
}

// 将 v2ray / Xray 的 streamSettings 应用到 Clash 代理对象
function applyV2rayStream(p, stream, network, security) {
	if (network !== 'tcp') p.network = network; // ws/grpc/h2 传输层必须随 URI 保留
	if (network === 'ws') {
		const ws = stream.wsSettings || {};
		p['ws-opts'] = { path: ws.path || '/', headers: (ws.headers && ws.headers.Host) ? { Host: String(ws.headers.Host) } : undefined };
	} else if (network === 'grpc') {
		const g = stream.grpcSettings || {};
		p['grpc-opts'] = { 'grpc-service-name': g.serviceName || '' };
	} else if (network === 'h2' || network === 'http') {
		const h = stream.httpSettings || {};
		const hosts = Array.isArray(h.host) ? h.host : (h.host ? [h.host] : []);
		p['h2-opts'] = { host: hosts.map(String), path: h.path || '/' };
	}
	if (security === 'tls') {
		p.tls = true;
		const tls = stream.tlsSettings || {};
		if (tls.serverName) p.servername = String(tls.serverName);
		if (tls.allowInsecure) p['skip-cert-verify'] = true;
		if (Array.isArray(tls.alpn) && tls.alpn.length) p.alpn = tls.alpn.map(String);
		if (tls.fingerprint) p['client-fingerprint'] = String(tls.fingerprint);
	} else if (security === 'reality') {
		p.tls = true;
		const r = stream.realitySettings || {};
		if (r.serverName) p.servername = String(r.serverName);
		p['reality-opts'] = { 'public-key': String(r.publicKey || ''), 'short-id': String(r.shortId || ''), 'client-fingerprint': String(r.fingerprint || '') };
	}
}

// 将 v2ray / Xray 的一个 outbound 转换为 Clash 代理对象
function v2rayOutboundToClash(o) {
	try {
		if (!o || typeof o !== 'object') return null;
		const protocol = String(o.protocol || '').toLowerCase();
		const settings = o.settings || {};
		const stream = o.streamSettings || {};
		const network = String(stream.network || 'tcp').toLowerCase();
		const security = String(stream.security || '').toLowerCase();
		const tag = String(o.tag || '');
		if (protocol === 'vmess' || protocol === 'vless') {
			const vn = Array.isArray(settings.vnext) ? settings.vnext[0] : null;
			const user = vn && Array.isArray(vn.users) ? vn.users[0] : null;
			if (!vn || !user) return null;
			const server = String(vn.address || '');
			const port = Number(vn.port || 0);
			if (!server || !port) return null;
			const p = { name: tag || (server + ':' + port), type: protocol, server, port, uuid: String(user.id || ''), udp: true };
			if (protocol === 'vmess') { p.alterId = Number(user.alterId || 0); p.cipher = String(user.security || 'auto'); }
			if (user.flow) p.flow = String(user.flow);
			applyV2rayStream(p, stream, network, security);
			return p;
		}
		if (protocol === 'trojan') {
			const srv = Array.isArray(settings.servers) ? settings.servers[0] : null;
			if (!srv) return null;
			const server = String(srv.address || '');
			const port = Number(srv.port || 0);
			if (!server || !port) return null;
			const p = { name: tag || (server + ':' + port), type: 'trojan', server, port, password: String(srv.password || ''), udp: true, tls: true };
			if (srv.flow) p.flow = String(srv.flow);
			applyV2rayStream(p, stream, network, security);
			return p;
		}
		if (protocol === 'shadowsocks') {
			const srv = Array.isArray(settings.servers) ? settings.servers[0] : null;
			if (!srv) return null;
			const server = String(srv.address || '');
			const port = Number(srv.port || 0);
			if (!server || !port) return null;
			const p = { name: tag || (server + ':' + port), type: 'ss', server, port, cipher: String(srv.method || 'aes-256-gcm'), password: String(srv.password || ''), udp: true };
			if (srv.plugin) {
				const pluginName = String(srv.plugin);
				if (pluginName.includes('obfs')) {
					p.plugin = 'obfs';
					const po = typeof srv.pluginOpts === 'object' ? srv.pluginOpts : {};
					p['plugin-opts'] = { mode: String(po.mode || 'http'), host: String(po.host || '') };
				} else if (pluginName.includes('v2ray')) {
					p.plugin = 'v2ray-plugin';
					p['plugin-opts'] = typeof srv.pluginOpts === 'object' ? srv.pluginOpts : {};
				}
			}
			return p;
		}
		if (protocol === 'http' || protocol === 'socks') {
			const srv = Array.isArray(settings.servers) ? settings.servers[0] : null;
			if (!srv) return null;
			const server = String(srv.address || '');
			const port = Number(srv.port || 0);
			if (!server || !port) return null;
			const user = srv.users && Array.isArray(srv.users) ? srv.users[0] : null;
			const p = { name: tag || (server + ':' + port), type: protocol === 'socks' ? 'socks5' : 'http', server, port };
			if (user) { if (user.user) p.username = String(user.user); if (user.pass) p.password = String(user.pass); }
			if (protocol === 'http' && security === 'tls') p.tls = true;
			return p;
		}
		return null;
	} catch (e) { return null; }
}

// 解析 v2ray / Xray 风格 JSON 配置(outbounds 中每项带 protocol + settings + streamSettings)
function v2rayJSONtoURIs(content, fileName = DEFAULT_FILE_NAME) {
	try {
		const obj = JSON.parse(cleanJSON(content));
		const outbounds = obj && Array.isArray(obj.outbounds) ? obj.outbounds : [];
		const uris = [];
		for (const o of outbounds) {
			const p = v2rayOutboundToClash(o);
			if (!p) continue;
			const uri = clashProxyToURI(p, fileName);
			if (uri) uris.push(uri);
		}
		return uris;
	} catch (e) { return []; }
}

// 解析 Shadowsocks JSON 列表(单对象 / {servers:[...]} / 数组)
function ssJSONtoURIs(content, fileName = DEFAULT_FILE_NAME) {
	try {
		const obj = JSON.parse(cleanJSON(content));
		let list = [];
		if (Array.isArray(obj)) list = obj;
		else if (Array.isArray(obj.servers)) list = obj.servers;
		else if (obj.server) list = [obj];
		const uris = [];
		for (const s of list) {
			if (!s || !s.server || !s.server_port) continue;
			const p = { name: String(s.remarks || s.name || (s.server + ':' + s.server_port)), type: 'ss', server: String(s.server), port: Number(s.server_port), cipher: String(s.method || 'aes-256-gcm'), password: String(s.password || ''), udp: true };
			if (s.plugin) {
				const pluginName = String(s.plugin);
				if (pluginName.includes('obfs')) {
					p.plugin = 'obfs';
					const po = typeof s.plugin_opts === 'object' ? s.plugin_opts : {};
					p['plugin-opts'] = { mode: String(po.mode || 'http'), host: String(po.host || '') };
				} else if (pluginName.includes('v2ray')) {
					p.plugin = 'v2ray-plugin';
					p['plugin-opts'] = typeof s.plugin_opts === 'object' ? s.plugin_opts : {};
				}
			}
			const uri = clashProxyToURI(p, fileName);
			if (uri) uris.push(uri);
		}
		return uris;
	} catch (e) { return []; }
}

// 统一入口:识别并本地解析任意格式的订阅内容
// 返回 { type: 'uris', text }(已解析为节点 URI)/ { type: 'raw', text }(明文节点,原样保留)/ null(无法识别)
function 本地解析订阅内容(content, fileName = DEFAULT_FILE_NAME, depth = 0) {
	const src = String(content || '');
	if (!src.trim()) return null;
	// 1. Clash YAML
	if (/^[ \t]*proxies[ \t]*:/m.test(src)) {
		const uris = clashYAMLtoURIs(src, fileName);
		return uris.length ? { type: 'uris', text: uris.join('\n') } : null;
	}
	// 2. JSON:sing-box / v2ray / SS 列表
	let json = null;
	try { json = JSON.parse(cleanJSON(src)); } catch (e) { json = null; }
	if (json && typeof json === 'object') {
		if (Array.isArray(json.outbounds)) {
			const first = json.outbounds[0];
			if (first && first.type) {
				const uris = singboxJSONtoURIs(src, fileName);
				return uris.length ? { type: 'uris', text: uris.join('\n') } : null;
			}
			if (first && first.protocol) {
				const uris = v2rayJSONtoURIs(src, fileName);
				return uris.length ? { type: 'uris', text: uris.join('\n') } : null;
			}
		}
		if (Array.isArray(json.servers) || Array.isArray(json) || json.server) {
			const uris = ssJSONtoURIs(src, fileName);
			return uris.length ? { type: 'uris', text: uris.join('\n') } : null;
		}
		// Clash JSON 格式:{"proxies": [{type/server/port/...}]}
		if (Array.isArray(json.proxies)) {
			const uris = [];
			for (const p of json.proxies) {
				const uri = clashProxyToURI(p, fileName);
				if (uri) uris.push(uri);
			}
			return uris.length ? { type: 'uris', text: uris.join('\n') } : null;
		}
	}
	// 3. Surge / Loon profile([Proxy] 段)
	let 是配置文件 = false;
	if (/^\s*\[Proxy\]\s*$/m.test(src)) {
		是配置文件 = true;
		if (/=\s*(ss|shadowsocks|ssr|shadowsocksr|vmess|vless|trojan|hysteria2|hy2|tuic|tuic-v5|anytls|socks5|socks|http|https|wireguard)\s*,/im.test(src)) {
			const uris = surgeLoonProfileToURIs(src, fileName);
			if (uris.length) return { type: 'uris', text: uris.join('\n') };
		}
	}
	// 4. Quantumult X([server_local] 段)
	if (/^\s*\[server_local\]\s*$/m.test(src)) {
		是配置文件 = true;
		if (/^(shadowsocks|vmess|vless|trojan|http|https|hysteria2|hy2)=/im.test(src)) {
			const uris = quanxServerToURIs(src, fileName);
			if (uris.length) return { type: 'uris', text: uris.join('\n') };
		}
	}
	// 5. 明文节点(含 :// 的链接列表);已识别为配置文件但解析为空的不再按明文混入配置文本
	if (是配置文件) return null;
	if (src.includes('://')) return { type: 'raw', text: src };
	// 6. base64(可能是任意格式的编码,递归识别)
	if (depth < 2 && isValidBase64(src)) {
		let decoded;
		try { decoded = base64Decode(src); } catch (e) { return null; }
		const nested = 本地解析订阅内容(decoded, fileName, depth + 1);
		if (nested) return nested.type === 'uris' ? nested : { type: 'raw', text: decoded };
	}
	return null;
}


