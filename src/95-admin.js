async function 迁移地址列表(env, txt = 'ADD.txt') {
	const 旧数据 = await env.KV.get(`/${txt}`);
	const 新数据 = await env.KV.get(txt);

	if (旧数据 && !新数据) {
		// 写入新位置
		await env.KV.put(txt, 旧数据);
		// 删除旧数据
		await env.KV.delete(`/${txt}`);
		return true;
	}
	return false;
}

async function KV(request, env, txt = 'ADD.txt', { subscriptionToken, fileName } = {}) {
	const url = new URL(request.url);
	try {
		// POST请求处理
		if (request.method === "POST") {
			if (!env.KV) return new Response("未绑定KV空间", { status: 400 });
			try {
				const content = await request.text();
				if (new TextEncoder().encode(content).byteLength > MAX_KV_CONTENT_BYTES) {
					return new Response('提交内容超过大小限制', { status: 413 });
				}
				// 协议过滤配置: 使用 ?save=protocol 区分,保存到 PROTOCOL.txt
				if (url.searchParams.get('save') === 'protocol') {
					const clean = String(content).split(/[,;\n]+/).map(x => x.trim().toLowerCase()).filter(Boolean).join(',');
					await env.KV.put('PROTOCOL.txt', clean);
					热点缓存删('PROTOCOL.txt'); // 同实例内立即生效,无需等 30s 热点缓存过期
					return new Response("协议过滤设置已保存");
				}
				// 剔除大陆节点开关: 使用 ?save=nocn 区分,保存到 NOCN.txt
				if (url.searchParams.get('save') === 'nocn') {
					await env.KV.put('NOCN.txt', String(content).trim());
					热点缓存删('NOCN.txt');
					return new Response("剔除大陆节点设置已保存");
				}
				// 节点屏蔽词: 使用 ?save=blockwords 区分,保存到 BLOCKWORDS.txt
				if (url.searchParams.get('save') === 'blockwords') {
					const clean = String(content).split(/[\n,;]+/).map(x => x.trim()).filter(Boolean).join(',');
					await env.KV.put('BLOCKWORDS.txt', clean);
					热点缓存删('BLOCKWORDS.txt');
					return new Response("节点屏蔽词已保存");
				}
				await env.KV.put(txt, content);
				热点缓存删(txt);
				return new Response("保存成功");
			} catch (error) {
				console.error('保存KV时发生错误:', error);
				return new Response("保存失败: " + error.message, { status: 500 });
			}
		}

		// GET请求部分
		let content = '';
		let hasKV = !!env.KV;

		if (hasKV) {
			try {
				content = await env.KV.get(txt) || '';
			} catch (error) {
				console.error('读取KV时发生错误:', error);
				content = '读取数据时发生错误: ' + error.message;
			}
		}

		// 读取协议过滤配置并生成勾选项
		let protoConfig = '';
		if (hasKV) {
			try { protoConfig = await env.KV.get('PROTOCOL.txt') || ''; } catch (e) { protoConfig = ''; }
		}
		const 已选协议 = new Set(String(protoConfig).split(/[,;\n]+/).map(x => x.trim().toLowerCase()).filter(Boolean));
		const 协议选项HTML = 支持协议.map(p => {
			const checked = 已选协议.has(p) ? 'checked' : '';
			return `<label style="margin-right:12px;display:inline-block;white-space:nowrap;"><input type="checkbox" class="proto-cb" value="${p}" ${checked}> ${p}</label>`;
		}).join('');
		// 读取「剔除大陆节点」开关并生成勾选状态
		let nocnConfig = '';
		if (hasKV) {
			try { nocnConfig = await env.KV.get('NOCN.txt') || ''; } catch (e) { nocnConfig = ''; }
		}
		const 剔除大陆已开 = /^(1|true|on|yes|开|是)$/i.test(String(nocnConfig || '').trim());

		// 读取「节点屏蔽词」配置(名称含任一关键词的节点剔除;本地地址节点无需配置默认剔除)
		let blockwordsConfig = '';
		if (hasKV) {
			try { blockwordsConfig = await env.KV.get('BLOCKWORDS.txt') || ''; } catch (e) { blockwordsConfig = ''; }
		}
		const blockwordsLiteral = escapeJs(blockwordsConfig);

		const safeFileName = escapeHtml(fileName);
		const safeContent = '';
		const contentLiteral = escapeJs(content);
		const safeUserAgent = escapeHtml(request.headers.get('User-Agent') || '');

		const html = `
			<!DOCTYPE html>
			<html>
				<head>
					<title>${safeFileName} 订阅编辑</title>
					<meta charset="utf-8">
					<meta name="viewport" content="width=device-width, initial-scale=1">
					<style>
						:root { color-scheme: light; --ink:#172033; --muted:#687386; --line:#e5eaf1; --brand:#3857e8; --brand-dark:#2943c7; --soft:#f6f8fc; --success:#16835b; }
						* { box-sizing: border-box; }
						body { margin:0; min-height:100vh; color:var(--ink); background:#f3f6fb; font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; }
						body:before { content:""; display:block; height:5px; background:linear-gradient(90deg,#3857e8,#7b61ff 55%,#20b486); }
						.page { width:min(1180px,calc(100% - 40px)); margin:0 auto; padding:42px 0 56px; }
						.hero { display:flex; justify-content:space-between; align-items:flex-end; gap:24px; margin-bottom:28px; }
						.eyebrow { margin:0 0 8px; color:var(--brand); font-size:12px; font-weight:700; letter-spacing:.14em; text-transform:uppercase; }
						h1 { margin:0; font-size:clamp(26px,4vw,38px); line-height:1.2; letter-spacing:-.04em; }
						.subtitle { max-width:650px; margin:11px 0 0; color:var(--muted); font-size:15px; }
						.badge { flex:none; padding:8px 13px; border:1px solid #dce3ff; border-radius:999px; color:var(--brand); background:#f0f3ff; font-size:12px; font-weight:700; }
						.grid { display:grid; grid-template-columns:minmax(0,1.35fr) minmax(320px,.65fr); gap:20px; align-items:start; }
						.card { min-width:0; padding:24px; border:1px solid rgba(220,226,237,.9); border-radius:18px; background:#fff; box-shadow:0 12px 35px rgba(35,49,87,.06); }
						.card + .card { margin-top:20px; }
						.card-title { display:flex; align-items:center; justify-content:space-between; gap:12px; margin:0 0 5px; font-size:18px; letter-spacing:-.02em; }
						.card-title span { color:var(--muted); font-size:12px; font-weight:500; letter-spacing:0; }
						.card-intro { margin:0 0 18px; color:var(--muted); }
						.link-list { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
						.link-card { min-width:0; padding:15px; border:1px solid var(--line); border-radius:12px; background:var(--soft); transition:.2s ease; }
						.link-card:hover { border-color:#b7c4ff; background:#f7f8ff; transform:translateY(-1px); }
						.link-label { display:block; margin-bottom:7px; color:var(--muted); font-size:12px; font-weight:700; }
						.sub-link { display:block; overflow:hidden; color:var(--brand); font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; text-decoration:none; text-overflow:ellipsis; white-space:nowrap; cursor:pointer; }
						.sub-link:hover { color:var(--brand-dark); text-decoration:underline; }
						.qr { display:flex; min-height:0; margin-top:12px; justify-content:center; }
						.qr:empty { display:none; }
						.qr img { max-width:150px; height:auto; padding:7px; border-radius:8px; background:#fff; }
						.notice-toggle { display:inline-flex; margin-top:18px; color:var(--brand); font-weight:700; text-decoration:none; }
						.notice-content { margin-top:16px; padding:16px; border:1px solid #dce3ff; border-radius:12px; background:#f7f8ff; }
						.info-row { display:grid; gap:5px; padding:13px 0; border-bottom:1px solid var(--line); }
						.info-row:last-child { border-bottom:0; padding-bottom:0; }
						.info-label { color:var(--muted); font-size:12px; font-weight:700; }
						.info-value { overflow-wrap:anywhere; font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; }
						.editor:focus { border-color:#8799f5; box-shadow:0 0 0 4px rgba(56,87,232,.11); background:#fff; }
						.divider { height:1px; margin:25px 0; border:0; background:var(--line); }
						.proto-container { padding:18px; border:1px solid var(--line); border-radius:12px; background:var(--soft); }
						.proto-options { display:flex; flex-wrap:wrap; gap:8px; }
						.proto-options label { display:inline-flex !important; align-items:center; gap:6px; margin:0 !important; padding:6px 10px; border:1px solid var(--line); border-radius:7px; color:#4c5870; background:#fff; font:12px ui-monospace,SFMono-Regular,Menlo,monospace; }
						.proto-options input { accent-color:var(--brand); }
						.helper { margin:12px 0 0; color:var(--muted); font-size:12px; }
						.footer { margin-top:22px; color:#9aa3b2; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
						@media (max-width:760px) { .page { width:min(100% - 24px,600px); padding:28px 0 36px; } .hero { display:block; } .badge { display:inline-block; margin-top:18px; } .grid { display:block; } .card { padding:18px; border-radius:14px; } .link-list { grid-template-columns:1fr; } .editor { min-height:280px; } }
						.editor-container {
							width: 100%;
							max-width: 100%;
							margin: 0 auto;
						}
						.editor {
							width: 100%;
							height: 300px; /* 调整高度 */
							margin: 15px 0; /* 调整margin */
							padding: 10px; /* 调整padding */
							box-sizing: border-box;
							border: 1px solid #ccc;
							border-radius: 4px;
							font-size: 13px;
							line-height: 1.5;
							overflow-y: auto;
							resize: none;
						}
						.save-container {
							margin-top: 8px; /* 调整margin */
							display: flex;
							align-items: center;
							gap: 10px; /* 调整gap */
						}
						.save-btn, .back-btn {
							padding: 6px 15px; /* 调整padding */
							color: white;
							border: none;
							border-radius: 4px;
							cursor: pointer;
						}
						.save-btn {
							background: #4CAF50;
						}
						.save-btn:hover {
							background: #45a049;
						}
						.back-btn {
							background: #666;
						}
						.back-btn:hover {
							background: #555;
						}
						.save-status {
							color: #666;
						}
						/* Responsive dashboard overrides for the existing editor markup. */
						body { max-width:none; }
						body > .page { width:min(1180px,calc(100% - 40px)); margin:0 auto; padding:42px 0 56px; }
						.page > h1 { margin:0 0 24px; color:#172033; font-size:clamp(26px,4vw,38px); letter-spacing:-.04em; }
						.page > .section-label { margin:26px 0 8px; color:#687386; font-size:12px; font-weight:700; }
						.page > a:not(.section-label) { display:inline-block; max-width:100%; margin:3px 0; padding:7px 11px; overflow:hidden; border:1px solid #e5eaf1; border-radius:8px; color:#3857e8 !important; background:#fff; font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; text-overflow:ellipsis; vertical-align:middle; white-space:nowrap; }
						#noticeToggle { border:0; background:transparent; font-family:inherit; }
						#noticeContent { max-width:760px; padding:20px; border:1px solid #dce3ff; border-radius:14px; background:#f7f8ff; }
						.editor-container { max-width:760px; padding:24px; border:1px solid #dce2ec; border-radius:18px; background:#fff; box-shadow:0 12px 35px rgba(35,49,87,.06); }
						.editor { width:100%; height:340px; margin:18px 0 14px; padding:16px; resize:vertical; border:1px solid #dbe1eb; border-radius:12px; outline:none; color:#27324a; background:#fbfcfe; font:13px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace; }
						.save-container { margin-top:12px; }
						.save-btn { background:#3857e8; border-radius:9px; box-shadow:0 5px 12px rgba(56,87,232,.2); }
						.save-btn:hover { background:#2943c7; }
						.proto-container { margin-top:22px; padding:18px; border:1px solid #e5eaf1; border-radius:12px; background:#f6f8fc; }
						@media (max-width:760px) { body > .page { width:calc(100% - 24px); padding:28px 0 36px; } .editor-container { padding:18px; } .editor { height:280px; } }
					</style>
					<script src="https://cdn.jsdelivr.net/npm/@keeex/qrcodejs-kx@1.0.2/qrcode.min.js"></script>
				</head>
				<body><main class="page">
					<p class="eyebrow">Subscription control center</p>
					<h1>${safeFileName} <span style="color:#3857e8">订阅控制台</span></h1>
					<p class="subtitle">集中管理你的节点与订阅链接，点击任意地址即可复制并生成二维码。</p>
					<div style="margin-top:14px;padding:10px 14px;border:1px dashed #ffb3b3;border-radius:10px;background:#fff5f5;color:#c0392b;font-size:12px;">
						<strong>部署版本:</strong> ${DEPLOY_VERSION}
					</div>
					################################################################<br>
					Subscribe / sub 订阅地址, 点击链接自动 <strong>复制订阅链接</strong> 并 <strong>生成订阅二维码</strong> <br>
					---------------------------------------------------------------<br>
					自适应订阅地址:<br>
					<a href="javascript:void(0)" onclick="copyToClipboard('https://${url.hostname}/sub?token=${subscriptionToken}','qrcode_0')" style="color:blue;text-decoration:underline;cursor:pointer;">https://${url.hostname}/sub?token=${subscriptionToken}</a><br>
					<div id="qrcode_0" style="margin: 10px 10px 10px 10px;"></div>
					Base64订阅地址:<br>
					<a href="javascript:void(0)" onclick="copyToClipboard('https://${url.hostname}/sub?token=${subscriptionToken}&b64','qrcode_1')" style="color:blue;text-decoration:underline;cursor:pointer;">https://${url.hostname}/sub?token=${subscriptionToken}&b64</a><br>
					<div id="qrcode_1" style="margin: 10px 10px 10px 10px;"></div>
					clash订阅地址:<br>
					<a href="javascript:void(0)" onclick="copyToClipboard('https://${url.hostname}/sub?token=${subscriptionToken}&clash','qrcode_2')" style="color:blue;text-decoration:underline;cursor:pointer;">https://${url.hostname}/sub?token=${subscriptionToken}&clash</a><br>
					<div id="qrcode_2" style="margin: 10px 10px 10px 10px;"></div>
					singbox订阅地址:<br>
					<a href="javascript:void(0)" onclick="copyToClipboard('https://${url.hostname}/sub?token=${subscriptionToken}&sb','qrcode_3')" style="color:blue;text-decoration:underline;cursor:pointer;">https://${url.hostname}/sub?token=${subscriptionToken}&sb</a><br>
					<div id="qrcode_3" style="margin: 10px 10px 10px 10px;"></div>
					surge订阅地址:<br>
					<a href="javascript:void(0)" onclick="copyToClipboard('https://${url.hostname}/sub?token=${subscriptionToken}&surge','qrcode_4')" style="color:blue;text-decoration:underline;cursor:pointer;">https://${url.hostname}/sub?token=${subscriptionToken}&surge</a><br>
					<div id="qrcode_4" style="margin: 10px 10px 10px 10px;"></div>
					loon订阅地址:<br>
					<a href="javascript:void(0)" onclick="copyToClipboard('https://${url.hostname}/sub?token=${subscriptionToken}&loon','qrcode_5')" style="color:blue;text-decoration:underline;cursor:pointer;">https://${url.hostname}/sub?token=${subscriptionToken}&loon</a><br>
					<div id="qrcode_5" style="margin: 10px 10px 10px 10px;"></div>
					&nbsp;&nbsp;<strong><a href="javascript:void(0);" id="noticeToggle" onclick="toggleNotice()">查看访客订阅∨</a></strong><br>
					<div id="noticeContent" class="notice-content" style="display: none;">
						---------------------------------------------------------------<br>
						访客订阅只能使用订阅功能，无法查看配置页！<br>
						SUBTOKEN（订阅 UUID）: <strong>${subscriptionToken}</strong><br>
						---------------------------------------------------------------<br>
						自适应订阅地址:<br>
						<a href="javascript:void(0)" onclick="copyToClipboard('https://${url.hostname}/sub?token=${subscriptionToken}','guest_0')" style="color:blue;text-decoration:underline;cursor:pointer;">https://${url.hostname}/sub?token=${subscriptionToken}</a><br>
						<div id="guest_0" style="margin: 10px 10px 10px 10px;"></div>
						Base64订阅地址:<br>
						<a href="javascript:void(0)" onclick="copyToClipboard('https://${url.hostname}/sub?token=${subscriptionToken}&b64','guest_1')" style="color:blue;text-decoration:underline;cursor:pointer;">https://${url.hostname}/sub?token=${subscriptionToken}&b64</a><br>
						<div id="guest_1" style="margin: 10px 10px 10px 10px;"></div>
						clash订阅地址:<br>
						<a href="javascript:void(0)" onclick="copyToClipboard('https://${url.hostname}/sub?token=${subscriptionToken}&clash','guest_2')" style="color:blue;text-decoration:underline;cursor:pointer;">https://${url.hostname}/sub?token=${subscriptionToken}&clash</a><br>
						<div id="guest_2" style="margin: 10px 10px 10px 10px;"></div>
						singbox订阅地址:<br>
						<a href="javascript:void(0)" onclick="copyToClipboard('https://${url.hostname}/sub?token=${subscriptionToken}&sb','guest_3')" style="color:blue;text-decoration:underline;cursor:pointer;">https://${url.hostname}/sub?token=${subscriptionToken}&sb</a><br>
						<div id="guest_3" style="margin: 10px 10px 10px 10px;"></div>
						surge订阅地址:<br>
						<a href="javascript:void(0)" onclick="copyToClipboard('https://${url.hostname}/sub?token=${subscriptionToken}&surge','guest_4')" style="color:blue;text-decoration:underline;cursor:pointer;">https://${url.hostname}/sub?token=${subscriptionToken}&surge</a><br>
						<div id="guest_4" style="margin: 10px 10px 10px 10px;"></div>
						loon订阅地址:<br>
						<a href="javascript:void(0)" onclick="copyToClipboard('https://${url.hostname}/sub?token=${subscriptionToken}&loon','guest_5')" style="color:blue;text-decoration:underline;cursor:pointer;">https://${url.hostname}/sub?token=${subscriptionToken}&loon</a><br>
						<div id="guest_5" style="margin: 10px 10px 10px 10px;"></div>
					</div>
					---------------------------------------------------------------<br>
					################################################################<br>
					订阅转换配置<br>
					---------------------------------------------------------------<br>
					✅ 全部订阅格式(base64 / Clash / sing-box / Surge / Quantumult X / Loon)均已由 Worker 本地生成,<br>
					订阅源解析不依赖任何第三方转换后端(零外部依赖)。<br>
					---------------------------------------------------------------<br>
					################################################################<br>
					${safeFileName} 汇聚订阅编辑: 
					<div class="editor-container">
						${hasKV ? `
						<textarea class="editor" 
							placeholder="${decodeURIComponent(atob('TElOSyVFNyVBNCVCQSVFNCVCRSU4QiVFRiVCQyU4OCVFNCVCOCU4MCVFOCVBMSU4QyVFNCVCOCU4MCVFNCVCOCVBQSVFOCU4QSU4MiVFNyU4MiVCOSVFOSU5MyVCRSVFNiU4RSVBNSVFNSU4RCVCMyVFNSU4RiVBRiVFRiVCQyU4OSVFRiVCQyU5QQp2bGVzcyUzQSUyRiUyRjI0NmFhNzk1LTA2MzctNGY0Yy04ZjY0LTJjOGZiMjRjMWJhZCU0MDEyNy4wLjAuMSUzQTEyMzQlM0ZlbmNyeXB0aW9uJTNEbm9uZSUyNnNlY3VyaXR5JTNEdGxzJTI2c25pJTNEVEcuQ01MaXVzc3NzLmxvc2V5b3VyaXAuY29tJTI2YWxsb3dJbnNlY3VyZSUzRDElMjZ0eXBlJTNEd3MlMjZob3N0JTNEVEcuQ01MaXVzc3NzLmxvc2V5b3VyaXAuY29tJTI2cGF0aCUzRCUyNTJGJTI1M0ZlZCUyNTNEMjU2MCUyM0NGbmF0CnRyb2phbiUzQSUyRiUyRmFhNmRkZDJmLWQxY2YtNGE1Mi1iYTFiLTI2NDBjNDFhNzg1NiU0MDIxOC4xOTAuMjMwLjIwNyUzQTQxMjg4JTNGc2VjdXJpdHklM0R0bHMlMjZzbmklM0RoazEyLmJpbGliaWxpLmNvbSUyNmFsbG93SW5zZWN1cmUlM0QxJTI2dHlwZSUzRHRjcCUyNmhlYWRlclR5cGUlM0Rub25lJTIzSEsKc3MlM0ElMkYlMkZZMmhoWTJoaE1qQXRhV1YwWmkxd2IyeDVNVE13TlRveVJYUlFjVzQyU0ZscVZVNWpTRzlvVEdaVmNFWlJkMjVtYWtORFVUVnRhREZ0U21SRlRVTkNkV04xVjFvNVVERjFaR3RTUzBodVZuaDFielUxYXpGTFdIb3lSbTgyYW5KbmRERTRWelkyYjNCMGVURmxOR0p0TVdwNlprTm1RbUklMjUzRCU0MDg0LjE5LjMxLjYzJTNBNTA4NDElMjNERQoKCiVFOCVBRSVBMiVFOSU5OCU4NSVFOSU5MyVCRSVFNiU4RSVBNSVFNyVBNCVCQSVFNCVCRSU4QiVFRiVCQyU4OCVFNCVCOCU4MCVFOCVBMSU4QyVFNCVCOCU4MCVFNiU5RCVBMSVFOCVBRSVBMiVFOSU5OCU4NSVFOSU5MyVCRSVFNiU4RSVBNSVFNSU4RCVCMyVFNSU4RiVBRiVFRiVCQyU4OSVFRiVCQyU5QQpodHRwcyUzQSUyRiUyRnN1Yi54Zi5mcmVlLmhyJTJGYXV0bw=='))}"
							id="content">${safeContent}</textarea>
						<script>document.getElementById('content').value = ${contentLiteral};</script>
						<div class="save-container">
							<button class="save-btn" onclick="saveContent(this)">保存</button>
							<span class="save-status" id="saveStatus"></span>
						</div>
						<hr>
						<div class="proto-container">
							<strong>按协议过滤（最后合成大订阅只保留勾选的协议，未勾选的隐藏）：</strong><br>
							<div style="margin:8px 0;">${协议选项HTML}</div>
							<div class="save-container">
								<button class="save-btn" onclick="saveProtocol(this)">保存协议设置</button>
								<span class="save-status" id="protoStatus"></span>
							</div>
							<div style="font-size:12px;color:#888;">提示：一个都不勾选并保存 = 不过滤，显示全部协议节点。</div>
						</div>
						<hr>
						<div class="proto-container">
							<strong>剔除中国大陆节点：</strong><br>
							<label style="margin:8px 0;display:inline-block;white-space:nowrap;">
								<input type="checkbox" id="nocnCb" ${剔除大陆已开 ? 'checked' : ''}> 剔除名称含「省份/城市/中国/大陆/移动/联通/电信」等关键词的节点（名称含香港/澳门/台湾的不受影响）
							</label>
							<div class="save-container">
								<button class="save-btn" onclick="saveNocn(this)">保存剔除设置</button>
								<span class="save-status" id="nocnStatus"></span>
							</div>
						</div>
						<hr>
						<div class="proto-container">
							<strong>屏蔽警示/占位节点关键词：</strong><br>
							<div style="font-size:12px;color:#888;margin:6px 0;">服务器为本地地址(127.x/0.0.0.0/localhost)的节点默认剔除,无需配置;此处填写节点名称关键词(如「防范境外势力渗透」),名称命中即剔除,逗号/换行分隔。内置默认词:防范境外势力、境外势力、中间替换、非法用途、请勿用于、已被劫持、勿用于</div>
							<textarea id="blockwordsInput" class="editor" style="height:80px;" placeholder="防范境外势力渗透,已被劫持"></textarea>
							<div class="save-container">
								<button class="save-btn" onclick="saveBlockwords(this)">保存屏蔽词</button>
								<span class="save-status" id="blockwordsStatus"></span>
							</div>
						</div>
						<script>if(document.getElementById('blockwordsInput')) document.getElementById('blockwordsInput').value = ${blockwordsLiteral};</script>
						` : '<p>请绑定 <strong>变量名称</strong> 为 <strong>KV</strong> 的KV命名空间</p>'}
					</div>
					<br>
					<br><br>UA: <strong>${safeUserAgent}</strong>
					<script>
					function copyToClipboard(text, qrcode) {
						navigator.clipboard.writeText(text).then(() => {
							alert('已复制到剪贴板');
						}).catch(err => {
							console.error('复制失败:', err);
						});
						const qrcodeDiv = document.getElementById(qrcode);
						qrcodeDiv.innerHTML = '';
						new QRCode(qrcodeDiv, {
							text: text,
							width: 220, // 调整宽度
							height: 220, // 调整高度
							colorDark: "#000000", // 二维码颜色
							colorLight: "#ffffff", // 背景颜色
							correctLevel: QRCode.CorrectLevel.Q, // 设置纠错级别
							scale: 1 // 调整像素颗粒度
						});
					}

					// 收集勾选的协议
					function collectProtocols() {
						return Array.from(document.querySelectorAll('.proto-cb'))
							.filter(cb => cb.checked)
							.map(cb => cb.value)
							.join(',');
					}

					// 保存协议过滤设置
					function saveProtocol(button) {
						if (!button) return;
						button.disabled = true;
						const status = document.getElementById('protoStatus');
						const setStatus = (msg, color) => {
							if (status) { status.textContent = msg; status.style.color = color || '#666'; }
						};
						setStatus('保存中...');
						// 保留当前 URL 的 token 等参数,避免经 /?token= 打开的页在保存时丢掉鉴权参数
						const saveUrl = new URL(window.location.href);
						saveUrl.search = '';
						saveUrl.searchParams.set('save', 'protocol');
						fetch(saveUrl.toString(), {
							method: 'POST',
							body: collectProtocols(),
							headers: { 'Content-Type': 'text/plain;charset=UTF-8', 'Accept': 'text/html' },
							cache: 'no-cache'
						}).then(res => {
							if (!res.ok) throw new Error('HTTP error! status: ' + res.status);
							return res.text();
						}).then(t => {
							setStatus('已保存: ' + t, '#4CAF50');
						}).catch(e => {
							console.error('保存协议设置失败:', e);
							setStatus('保存失败: ' + e.message, 'red');
						}).finally(() => {
							button.disabled = false;
						});
					}

// 保存「剔除大陆节点」开关
					function saveNocn(button) {
						if (!button) return;
						button.disabled = true;
						const status = document.getElementById('nocnStatus');
						const setStatus = (msg, color) => {
							if (status) { status.textContent = msg; status.style.color = color || '#666'; }
						};
						setStatus('保存中...');
						const cb = document.getElementById('nocnCb');
						// 保留当前 URL 的 token 等参数,避免经 /?token= 打开的页在保存时丢掉鉴权参数
					const saveUrl = new URL(window.location.href);
					saveUrl.search = '';
					saveUrl.searchParams.set('save', 'nocn');
					fetch(saveUrl.toString(), {
							method: 'POST',
							body: cb && cb.checked ? '1' : '0',
							headers: { 'Content-Type': 'text/plain;charset=UTF-8', 'Accept': 'text/html' },
							cache: 'no-cache'
						}).then(res => {
							if (!res.ok) throw new Error('HTTP error! status: ' + res.status);
							return res.text();
						}).then(t => {
							setStatus('已保存: ' + t, '#4CAF50');
						}).catch(e => {
							console.error('保存剔除设置失败:', e);
							setStatus('保存失败: ' + e.message, 'red');
					}).finally(() => {
						button.disabled = false;
					});
					}

// 保存「节点屏蔽词」
					function saveBlockwords(button) {
						if (!button) return;
						button.disabled = true;
						const status = document.getElementById('blockwordsStatus');
						const setStatus = (msg, color) => {
							if (status) { status.textContent = msg; status.style.color = color || '#666'; }
						};
						setStatus('保存中...');
						const input = document.getElementById('blockwordsInput');
						// 保留当前 URL 的 token 等参数,避免经 /?token= 打开的页在保存时丢掉鉴权参数
						const saveUrl = new URL(window.location.href);
						saveUrl.search = '';
						saveUrl.searchParams.set('save', 'blockwords');
						fetch(saveUrl.toString(), {
							method: 'POST',
							body: (input && input.value) || '',
							headers: { 'Content-Type': 'text/plain;charset=UTF-8', 'Accept': 'text/html' },
							cache: 'no-cache'
						}).then(res => {
							if (!res.ok) throw new Error('HTTP error! status: ' + res.status);
							return res.text();
						}).then(t => {
							setStatus('已保存: ' + t, '#4CAF50');
						}).catch(e => {
							console.error('保存屏蔽词失败:', e);
							setStatus('保存失败: ' + e.message, 'red');
						}).finally(() => {
							button.disabled = false;
						});
					}
						
					if (document.querySelector('.editor')) {
						let timer;
						const textarea = document.getElementById('content');
						const originalContent = textarea.value;
		
						function goBack() {
							const currentUrl = window.location.href;
							const parentUrl = currentUrl.substring(0, currentUrl.lastIndexOf('/'));
							window.location.href = parentUrl;
						}
		
						function replaceFullwidthColon() {
							const text = textarea.value;
							textarea.value = text.replace(/：/g, ':');
						}
						
						function saveContent(button) {
							try {
								const updateButtonText = (step) => {
									button.textContent = \`保存中: \${step}\`;
								};
								// 检测是否为iOS设备
								const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
								
								// 仅在非iOS设备上执行replaceFullwidthColon
								if (!isIOS) {
									replaceFullwidthColon();
								}
								updateButtonText('开始保存');
								button.disabled = true;

								// 获取textarea内容和原始内容
								const textarea = document.getElementById('content');
								if (!textarea) {
									throw new Error('找不到文本编辑区域');
								}

								updateButtonText('获取内容');
								let newContent;
								let originalContent;
								try {
									newContent = textarea.value || '';
									originalContent = textarea.defaultValue || '';
								} catch (e) {
									console.error('获取内容错误:', e);
									throw new Error('无法获取编辑内容');
								}

								updateButtonText('准备状态更新函数');
								const updateStatus = (message, isError = false) => {
									const statusElem = document.getElementById('saveStatus');
									if (statusElem) {
										statusElem.textContent = message;
										statusElem.style.color = isError ? 'red' : '#666';
									}
								};

								updateButtonText('准备按钮重置函数');
								const resetButton = () => {
									button.textContent = '保存';
									button.disabled = false;
								};

								if (newContent !== originalContent) {
									updateButtonText('发送保存请求');
									fetch(window.location.href, {
										method: 'POST',
										body: newContent,
										headers: {
											'Content-Type': 'text/plain;charset=UTF-8',
											'Accept': 'text/html'
										},
										cache: 'no-cache'
									})
									.then(response => {
										updateButtonText('检查响应状态');
										if (!response.ok) {
											throw new Error(\`HTTP error! status: \${response.status}\`);
										}
										updateButtonText('更新保存状态');
										const now = new Date().toLocaleString();
										document.title = \`编辑已保存 \${now}\`;
										updateStatus(\`已保存 \${now}\`);
									})
									.catch(error => {
										updateButtonText('处理错误');
										console.error('Save error:', error);
										updateStatus(\`保存失败: \${error.message}\`, true);
									})
									.finally(() => {
										resetButton();
									});
								} else {
									updateButtonText('检查内容变化');
									updateStatus('内容未变化');
									resetButton();
								}
							} catch (error) {
								console.error('保存过程出错:', error);
								button.textContent = '保存';
								button.disabled = false;
								const statusElem = document.getElementById('saveStatus');
								if (statusElem) {
									statusElem.textContent = \`错误: \${error.message}\`;
									statusElem.style.color = 'red';
								}
							}
						}
		
						textarea.addEventListener('blur', saveContent);
						textarea.addEventListener('input', () => {
							clearTimeout(timer);
							timer = setTimeout(saveContent, 5000);
						});
					}

					function toggleNotice() {
						const noticeContent = document.getElementById('noticeContent');
						const noticeToggle = document.getElementById('noticeToggle');
						if (noticeContent.style.display === 'none' || noticeContent.style.display === '') {
							noticeContent.style.display = 'block';
							noticeToggle.textContent = '隐藏访客订阅∧';
						} else {
							noticeContent.style.display = 'none';
							noticeToggle.textContent = '查看访客订阅∨';
						}
					}
			
					// 初始化 noticeContent 的 display 属性
					document.addEventListener('DOMContentLoaded', () => {
						document.getElementById('noticeContent').style.display = 'none';
					});
					</script></main>
				</body>
			</html>
		`;

		return new Response(html, {
			headers: {
				"Content-Type": "text/html;charset=utf-8",
				"Cache-Control": "no-store",
				"Content-Security-Policy": "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
				"X-Content-Type-Options": "nosniff",
				"X-Frame-Options": "DENY",
				"Referrer-Policy": "no-referrer"
			}
		});
	} catch (error) {
		console.error('处理请求时发生错误:', error);
		return new Response("服务器错误: " + error.message, {
			status: 500,
			headers: { "Content-Type": "text/plain;charset=utf-8" }
		});
	}
}
