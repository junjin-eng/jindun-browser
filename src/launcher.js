// 浏览器实例启动器：Chromium内核检测 / 代理 / IP时区强检 / GeoIP自动匹配 / CDP指纹注入
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const puppeteer = require('puppeteer-core');
const fetch = require('node-fetch');
const { HttpProxyAgent } = require('http-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { Server: ProxyChainServer } = require('proxy-chain');
const { buildInjectionScript } = require('./fingerprint');
const km = require('./kernel-manager');

// Electron 屏幕信息（仅在客户端主进程内可用；独立脚本复用时拿不到，走兜底）
let electronScreen = null;
try { electronScreen = require('electron').screen; } catch {}

// Windows 整窗装饰（标题栏+标签栏+地址栏+可能的书签栏）DIP 经验高度：
// --window-size 给的是内容区尺寸，换算整窗/约束工作区时要预留这块
const CHROME_FRAME_H = 140;
const SCROLLBAR_W = 16;
// 运行期自动导出的 Cookie 快照（含会话级，用于跨重启保留登录态）
const RUNTIME_COOKIE_FILE = 'cookies.runtime.json';

// 主屏工作区（去掉任务栏）。取不到时用保守兜底，保证常见 768p 笔记本也能容下整窗
function primaryWorkArea() {
  try {
    const d = electronScreen.getPrimaryDisplay();
    const w = d && d.workArea;
    if (w && w.width >= 1024 && w.height >= 700) {
      return { x: w.x, y: w.y, width: w.width, height: w.height };
    }
  } catch {}
  return { x: 0, y: 0, width: 1366, height: 728 };
}

// ---------- 内核检测 ----------
function detectChrome() {
  let candidates;
  if (process.platform === 'darwin') {
    // macOS: 应用程序包内的可执行文件路径（.app/Contents/MacOS/...）
    const home = process.env.HOME || '';
    const macApps = [
      '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    ];
    candidates = home ? macApps.concat(macApps.map(p => p.replace('/Applications/', home + '/Applications/'))) : macApps;
  } else {
    candidates = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
    ];
  }
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p; } catch {}
  }
  return '';
}

// 代理URL构造
function proxyUrl(p) {
  if (!p || !p.proxy_type) return '';
  const scheme = ['', 'http', 'https', 'socks5'][p.proxy_type] || 'http';
  let auth = '';
  if (p.proxy_username) auth = encodeURIComponent(p.proxy_username) + ':' + encodeURIComponent(p.proxy_password || '') + '@';
  return `${scheme}://${auth}${p.proxy_host}:${p.proxy_port}`;
}

function agentFor(url) {
  if (!url) return undefined;
  if (url.startsWith('socks5://')) return new SocksProxyAgent(url, { timeout: 12000 });
  // 明文HTTP目标走 http-proxy-agent（https-proxy-agent会错误地做TLS包装）
  if (url.startsWith('http://')) return new HttpProxyAgent(url);
  return new HttpsProxyAgent(url);
}

// GeoIP 数据源链：部分代理只放行443或拦截特定目标，自动切换渠道
// 顺序：ip-api(HTTP,无限流) → ipwho.is(HTTPS) → api.ip.sb(HTTPS) → ipapi.co(HTTPS)
const GEO_SOURCES = [
  {
    url: 'http://ip-api.com/json/?fields=status,message,country,countryCode,regionName,city,timezone,lat,lon,query',
    parse: (j) => j && j.status === 'success'
      ? { query: j.query, country: j.country, countryCode: j.countryCode,
          region: j.regionName, city: j.city,
          timezone: j.timezone, lat: j.lat, lon: j.lon } : null
  },
  {
    url: 'https://ipwho.is/',
    parse: (j) => j && j.ip && j.success !== false
      ? { query: j.ip, country: j.country, countryCode: j.country_code,
          region: j.region, city: j.city,
          timezone: j.timezone && j.timezone.id, lat: j.latitude, lon: j.longitude } : null
  },
  {
    url: 'https://api.ip.sb/geoip',
    parse: (j) => j && j.ip
      ? { query: j.ip, country: j.country, countryCode: j.country_code,
          region: j.region, city: j.city,
          timezone: j.timezone, lat: j.latitude, lon: j.longitude } : null
  },
  {
    url: 'https://ipapi.co/json/',
    parse: (j) => j && j.ip
      ? { query: j.ip, country: j.country_name, countryCode: j.country_code,
          region: j.region, city: j.city,
          timezone: j.timezone, lat: j.latitude, lon: j.longitude } : null
  }
];
let lastGoodSource = 0; // 记住上次成功的渠道，下次优先使用（避免每次先撞超时）

// 通过代理请求GeoIP，读取出口IP地理位置（每次启动都会调用，强检入口）
async function geoLookup(proxyStr) {
  const agent = agentFor(proxyStr);
  const order = [lastGoodSource, ...GEO_SOURCES.keys()].filter((v, i, a) => a.indexOf(v) === i);
  let lastErr;
  for (const idx of order) {
    const src = GEO_SOURCES[idx];
    try {
      const res = await fetch(src.url, { agent, timeout: 8000 });
      let j = null;
      try { j = await res.json(); } catch { /* 代理可能返回HTML错误页 */ }
      // 代理层明确拒绝（403/407）：读取代理返回的原因（如"china IP is not allow"），比SOCKS的0x01更有价值
      if (res.status === 403 || res.status === 407) {
        const msg = j && (j.msg || j.message || j.error);
        throw new Error(`代理拒绝访问(HTTP ${res.status})${msg ? '：' + msg : ''}`);
      }
      const info = src.parse(j);
      if (!info || !info.query) throw new Error((j && (j.msg || j.message || j.error || j.info)) || '返回数据无效');
      lastGoodSource = idx;
      return info;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('所有IP查询渠道均失败');
}

// 代理错误 → 中文可行动提示
function proxyErrorHint(e) {
  const m = String((e && e.message) || e);
  if (/china IP is not allow/i.test(m)) return '该代理服务商禁止中国大陆IP接入——请更换支持中国大陆接入的节点/线路，或在本机全局VPN(TUN)环境下使用';
  if (/Authentication|auth/i.test(m)) return '代理认证失败：请检查用户名/密码';
  if (/rejected connection - Failure/i.test(m)) return '代理拒绝连接(Failure)：节点可能实际是HTTP代理、仅放行部分目标/端口，或该代理对此查询渠道受限（已自动尝试多渠道与协议）';
  if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH/i.test(m)) return '无法连接代理服务器：请检查地址/端口是否正确、节点是否可用';
  if (/timeout/i.test(m)) return '连接超时：代理无响应';
  return '';
}
function withHint(e) {
  const hint = proxyErrorHint(e);
  return new Error(e.message + (hint ? '（' + hint + '）' : ''));
}

// 自适应协议探测：按配置类型检测；SOCKS5握手失败时自动改用HTTP协议重试同一地址
// （大量"socks5"节点实际是HTTP/混合端口；浏览器侧同样需要按实际协议连接）
async function geoLookupAdaptive(profile) {
  const base = {
    proxy_type: profile.proxy_type, proxy_host: profile.proxy_host, proxy_port: profile.proxy_port,
    proxy_username: profile.proxy_username, proxy_password: profile.proxy_password
  };
  const urlOf = (t) => proxyUrl({ ...base, proxy_type: t });
  try {
    const geo = await geoLookup(urlOf(base.proxy_type));
    return { geo, viaType: base.proxy_type, adapted: false };
  } catch (e1) {
    if (base.proxy_type === 3) {
      try {
        const geo = await geoLookup(urlOf(1));
        return { geo, viaType: 1, adapted: true, socksError: e1.message };
      } catch (e2) {
        // 两种协议都失败：合并原因（HTTP错误常含代理返回的明确原因，如403地域限制）
        throw withHint(new Error(`SOCKS5方式：${e1.message}；HTTP方式：${e2.message}`));
      }
    }
    throw withHint(e1);
  }
}

// 国家代码 → 常用语言（近似映射，IP库存在解析不准的现实问题）
const COUNTRY_LANG = {
  CN: 'zh-CN', TW: 'zh-TW', HK: 'zh-HK', US: 'en-US', GB: 'en-GB', JP: 'ja', KR: 'ko',
  DE: 'de-DE', FR: 'fr-FR', ES: 'es-ES', PT: 'pt-PT', BR: 'pt-BR', RU: 'ru-RU', IT: 'it-IT',
  NL: 'nl-NL, en', SG: 'en-SG', MY: 'en-MY', TH: 'th-TH', VN: 'vi-VN', ID: 'id-ID',
  IN: 'en-IN', AU: 'en-AU', CA: 'en-CA', PH: 'en-PH', TR: 'tr-TR', AE: 'ar-AE', SA: 'ar-SA'
};

// Chrome的--proxy-server不支持 user:pass@host 形式（会导致代理配置无效、网页全部打不开）
// 账号密码通过CDP page.authenticate注入
function chromeProxyArg(p) {
  if (!p || !p.proxy_type) return '';
  const scheme = ['', 'http', 'https', 'socks5'][p.proxy_type] || 'http';
  return `${scheme}://${p.proxy_host}:${p.proxy_port}`;
}

// 清理残留内核进程（数据目录被占用会导致再次启动失败，如客户端重启后旧窗口仍在）
async function killStaleBrowser(dataDir, exeName) {
  const needle = String(dataDir).toLowerCase();
  const pids = [];

  if (process.platform === 'darwin') {
    // macOS: ps 列出全部进程的 PID + 完整命令行，过滤命令行中带该环境数据目录的 Chrome 进程
    try {
      const out = execSync('ps -ax -o pid=,command=', { encoding: 'utf8', timeout: 15000 });
      for (const line of out.split(/\r?\n/)) {
        if (!line.toLowerCase().includes(needle)) continue;
        if (!/chrome|chromium|edge/i.test(line)) continue;
        const m = line.trim().match(/^(\d+)\s/);
        if (m) pids.push(m[1]);
      }
    } catch { /* ps 不可用时放弃清理 */ }
    for (const pid of [...new Set(pids)]) {
      try { execSync(`kill -9 ${pid}`, { timeout: 10000 }); } catch {}
    }
    return new Set(pids).size;
  }

  // Windows: wmic / PowerShell 两种方式取命令行中带数据目录的进程 PID
  const psCmd = `Get-CimInstance Win32_Process -Filter \\"Name='${exeName}'\\" | Where-Object {$_.CommandLine -like '*${dataDir}*'} | ForEach-Object {$_.ProcessId}`;
  const cmds = [
    `wmic process where "name='${exeName}'" get ProcessId,CommandLine /format:csv`,
    `powershell -NoProfile -Command "${psCmd}"`
  ];
  for (const cmd of cmds) {
    try {
      const out = execSync(cmd, { encoding: 'utf8', timeout: 15000, windowsHide: true });
      for (const line of out.split(/\r?\n/)) {
        if (!line.toLowerCase().includes(needle)) continue;
        const m = line.trim().match(/(\d+)\s*$/);
        if (m) pids.push(m[1]);
      }
      break; // 命令执行成功即采用其结果
    } catch { /* 尝试下一种方式 */ }
  }
  for (const pid of [...new Set(pids)]) {
    try { execSync(`taskkill /PID ${pid} /F /T`, { windowsHide: true }); } catch {}
  }
  return new Set(pids).size;
}

// 运行中的实例注册表
const running = new Map(); // profileId -> { browser, dataDir, wsEndpoint, geo, pid }

// ---------- 手动导入Cookie（cookies.json，兼容 EditThisCookie / AdsPower 导出的JSON数组） ----------
function normalizeCookie(c) {
  if (!c || typeof c !== 'object') return null;
  if (!c.name && c.name !== '') return null;
  const out = { name: String(c.name), value: String(c.value ?? '') };
  if (c.url) out.url = String(c.url);
  if (c.domain) out.domain = String(c.domain);
  if (!out.url && !out.domain) return null; // Cookie必须可定位到域
  out.path = c.path || '/';
  if (c.secure) out.secure = true;
  if (c.httpOnly) out.httpOnly = true;
  const exp = c.expires ?? c.expirationDate ?? c.expiry;
  if (exp !== undefined && exp !== null && exp !== '' && Number(exp) > 0) {
    let sec = Number(exp);
    if (sec > 1e12) sec = Math.floor(sec / 1000); // 容错毫秒级时间戳
    if (sec > Date.now() / 1000) out.expires = sec; // 已过期的不注入
  }
  if (c.sameSite) {
    const ss = String(c.sameSite).toLowerCase().replace(/[\s_-]/g, '');
    if (ss === 'none' || ss === 'norestrict') out.sameSite = 'None';
    else if (ss === 'lax') out.sameSite = 'Lax';
    else if (ss === 'strict') out.sameSite = 'Strict';
  }
  if (out.sameSite === 'None') out.secure = true; // Chrome要求 SameSite=None 必须 Secure
  return out;
}

// 语言列表 → 原生 Chrome 风格 Accept-Language（如 ['en-US'] → 'en-US,en;q=0.9'）
function buildAcceptLanguage(langs) {
  const list = (langs && langs.length ? langs.slice() : ['en-US']);
  const primary = String(list[0]).split('-')[0];
  if (!list.some(l => String(l).split('-')[0] === primary && String(l).indexOf('-') === -1)) list.push(primary);
  return list.map((l, i) => (i === 0 ? l : `${l};q=${Math.max(0.1, 1 - i * 0.1).toFixed(1)}`)).join(',');
}

// 构造引擎层 UA 覆盖用的 User-Agent Client Hints 元数据（sec-ch-ua 全熵版本）
// 主版本取 fp.browserVersion（启动时已与真实内核对齐），完整版本优先用内核真实版本号
function buildUaMetadata(fp, fullVersion) {
  const ch = fp.clientHints || {};
  const major = String(fp.browserVersion || (String(fp.ua).match(/Chrome\/(\d+)/) || [])[1] || '120');
  const full = /^\d+\.\d+\.\d+\.\d+$/.test(fullVersion || '') ? fullVersion : major + '.0.0.0';
  const grease = { brand: 'Not/A)Brand', version: '99' };
  const brands = [
    grease,
    { brand: 'Chromium', version: major },
    { brand: 'Google Chrome', version: major }
  ];
  const isMacOS = process.platform === 'darwin';
  return {
    brands,
    fullVersionList: [
      grease,
      { brand: 'Chromium', version: full },
      { brand: 'Google Chrome', version: full }
    ],
    fullVersion: full,
    platform: ch.platform || (isMacOS ? 'macOS' : 'Windows'),
    platformVersion: ch.platformVersion || (isMacOS ? '10_15_7' : '15.0.0'),
    architecture: ch.architecture || (isMacOS ? (process.arch === 'arm64' ? 'arm' : 'x86') : 'x86'),
    bitness: ch.bitness || '64',
    model: ch.model || '',
    mobile: !!ch.mobile,
    wow64: false
  };
}

// 每个环境独立下载目录：浏览器级 CDP 下发全局默认，所有标签页/弹窗下载自动落入该环境文件夹
async function setupDownloadDir(browser, dir, onEvent) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const client = await browser.target().createCDPSession();
    await client.send('Browser.setDownloadBehavior', {
      behavior: 'allow',        // 自动下载，不弹"另存为"
      downloadPath: dir,
      eventsEnabled: true
    });
    onEvent && onEvent('sync', `下载文件将独立保存到：${dir}`);
  } catch (e) {
    onEvent && onEvent('sync-fail', '独立下载目录设置失败：' + e.message);
  }
}

// 读取本地 Cookie 清单文件（不存在/损坏返回空数组）
function readCookieFile(f) {
  try {
    if (!fs.existsSync(f)) return [];
    const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function cookieKey(c) { return [c.domain || '', c.path || '/', c.name || ''].join('|'); }

// 浏览器启动后、页面导航前注入 Cookie：
// ① cookies.json —— 用户手动导入/编辑的清单
// ② cookies.runtime.json —— 上次运行期自动导出的浏览器真实 Cookie（含会话级 Cookie；
//    网页邮箱等不勾"保持登录"时鉴权 Cookie 是会话级，Chrome 关窗即从内存清除、不落 Cookies 库，
//    必须由我们在运行期导出、启动时回注，登录态才能跨重启保留）
// 同名同域同路径以运行期快照为准（更新）
async function injectManualCookies(browser, dataDir, onEvent) {
  let list = [];
  try {
    const f = path.join(dataDir, 'cookies.json');
    if (fs.existsSync(f)) {
      const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (Array.isArray(arr)) list = arr;
    }
  } catch (e) {
    onEvent && onEvent('sync-fail', '手动Cookie文件解析失败：' + e.message);
  }
  const runtime = readCookieFile(path.join(dataDir, RUNTIME_COOKIE_FILE));
  const merged = new Map();
  for (const c of list) { const n = normalizeCookie(c); if (n) merged.set(cookieKey(n), n); }
  const manualCount = merged.size;
  for (const c of runtime) {
    const n = normalizeCookie(c);
    if (n) merged.set(cookieKey(n), n); // 同键运行期快照覆盖手动值（会话 Cookie 会轮换，旧值会顶掉登录态）
  }
  const cookies = [...merged.values()];
  if (!cookies.length) return;
  try {
    // 裸会话注入后立即 detach：Cookie 写入浏览器网络服务持久保存，会话断开不影响；
    // 不使用 browser.pages()（会实例化常驻 Runtime 的 Puppeteer Page）
    const target = browser.targets().find(t => t.type() === 'page');
    if (!target) return;
    const session = await target.createCDPSession();
    let ok = 0;
    try {
      await session.send('Network.enable');
      try {
        await session.send('Network.setCookies', { cookies });
        ok = cookies.length;
      } catch {
        for (const c of cookies) {
          try { await session.send('Network.setCookie', c); ok++; } catch {}
        }
      }
    } finally {
      await session.detach().catch(() => {});
    }
    onEvent && onEvent('sync', `已恢复Cookie ${ok} 条（手动导入 ${manualCount} · 上次运行快照含会话Cookie ${runtime.length}，按域/路径/名称去重）`);
  } catch (e) {
    onEvent && onEvent('sync-fail', 'Cookie注入失败：' + e.message);
  }
}

// 运行期导出浏览器全部 Cookie（含会话级）到 cookies.runtime.json。
// Storage.getCookies 用浏览器级会话；极少数老内核不支持时回退页面级 Network.getAllCookies
// 原子写（tmp+rename）避免云同步读到半文件；文件名常量见文件顶部
async function fetchAllCookies(browser) {
  const bs = await browser.target().createCDPSession();
  try {
    const r = await bs.send('Storage.getCookies');
    return r.cookies || [];
  } catch {
    const pt = browser.targets().find(t => t && t.type() === 'page');
    if (!pt) throw new Error('no page target for cookie fallback');
    const ps = await pt.createCDPSession();
    try {
      const r = await ps.send('Network.getAllCookies');
      return r.cookies || [];
    } finally {
      await ps.detach().catch(() => {});
    }
  } finally {
    await bs.detach().catch(() => {});
  }
}
async function exportRuntimeCookies(browser, dataDir) {
  try {
    const raw = await fetchAllCookies(browser);
    const out = raw.map(normalizeCookie).filter(Boolean);
    const tmp = path.join(dataDir, RUNTIME_COOKIE_FILE + '.tmp');
    fs.writeFileSync(tmp, JSON.stringify(out));
    fs.renameSync(tmp, path.join(dataDir, RUNTIME_COOKIE_FILE));
    return out.length;
  } catch { return 0; }
}

// ---------- IP/环境检测信息页：每次启动自动打开，直观确认出口IP与指纹是否自洽 ----------
function writeInfoPage(dataDir, info) {
  const rows = [
    ['出口 IP', info.ip],
    ['国家/地区', info.country ? `${info.country} (${info.countryCode || '-'})` : '-'],
    ['州/省', info.region || '-'],
    ['城市', info.city || '-'],
    ['时区', `${info.timezone || '-'}（GMT${(info.offsetMin || 0) <= 0 ? '+' : '-'}${Math.abs((info.offsetMin || 0) / 60)}）`],
    ['本地时间', new Date().toLocaleString('zh-CN', { timeZone: info.timezone || undefined, hour12: false })],
    ['语言', info.languages || info.language || '-'],
    ['经纬度', (Number.isFinite(info.lat) && Number.isFinite(info.lon)) ? `${info.lat}, ${info.lon}` : '-'],
    ['代理方式', info.proxyType || '直连（本机网络）'],
    ['User-Agent', info.ua || '使用内核默认 UA']
  ];
  const escHtml = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>环境检测 - ${escHtml(info.ip || '')}</title>
<style>
 *{box-sizing:border-box;margin:0;padding:0}
 body{font-family:'Microsoft YaHei',Segoe UI,sans-serif;background:#f5f7fb;color:#1f2937;padding:28px}
 .wrap{max-width:760px;margin:0 auto}
 h1{font-size:22px;margin-bottom:18px;color:#111827}
 .card{background:#fff;border-radius:14px;box-shadow:0 2px 12px rgba(0,0,0,.06);padding:24px 28px;margin-bottom:18px}
 .ip{font-size:34px;font-weight:700;color:#16a34a;text-align:center;margin:6px 0 14px}
 .ok{color:#16a34a;font-weight:600}
 .checks{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;margin-bottom:6px}
 .chip{background:#ecfdf5;color:#15803d;border-radius:20px;padding:5px 14px;font-size:13px}
 .row{display:flex;padding:9px 0;border-bottom:1px dashed #eef0f4;font-size:14px}
 .row:last-child{border-bottom:0}
 .k{width:110px;color:#6b7280;flex-shrink:0}
 .v{word-break:break-all;flex:1}
 .tip{font-size:13px;color:#6b7280;line-height:1.8}
 .badge{display:inline-block;background:#dbeafe;color:#1d4ed8;border-radius:6px;padding:2px 10px;font-size:13px;margin-left:8px}
</style></head><body><div class="wrap">
<h1>🔍 当前环境检测 <span class="badge">槿盾浏览器</span></h1>
<div class="card">
  <div class="ip">✅ ${escHtml(info.ip || '未知IP')}</div>
  <div class="checks">
    <span class="chip">✓ IP 已通过代理</span><span class="chip">✓ 时区已对齐</span><span class="chip">✓ 指纹隔离</span>
  </div>
</div>
<div class="card">${rows.map(([k, v]) => `<div class="row"><div class="k">${k}</div><div class="v">${escHtml(v)}</div></div>`).join('')}</div>
<div class="card tip">
  • 本页由客户端在浏览器启动后自动打开，用于确认<b>出口IP、时区、语言</b>与代理线路一致（如使用美国节点，时区应显示 America/* 且本地时间为美国时间）。<br>
  • 此页面不会在下次启动时自动恢复；关闭本标签页不影响任何功能。<br>
  • 数据来源：代理出口IP的GeoIP探测，每次启动实时更新。
</div>
</div></body></html>`;
  try {
    const f = path.join(dataDir, 'ip-info.html');
    fs.writeFileSync(f, html);
    return f;
  } catch { return ''; }
}
async function openInfoTab(browser, dataDir, info, onEvent) {
  try {
    const f = writeInfoPage(dataDir, info);
    if (!f) return;
    const bc = await browser.target().createCDPSession();
    const u = 'file:///' + f.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace(/^file:\/\/\/([A-Za-z])%3A/, 'file:///$1:');
    await bc.send('Target.createTarget', { url: u });
    onEvent && onEvent('geo', 'IP检测信息页已打开：' + (info.ip || ''));
  } catch {}
}

// ---------- 标签页会话：关闭浏览器前保存打开的页面，下次启动自动恢复 ----------
function tabsFile(dataDir) { return path.join(dataDir, 'saved-tabs.json'); }
async function collectOpenUrls(browser) {
  const urls = [];
  try {
    for (const t of browser.targets()) {
      if (t.type() !== 'page') continue;
      let u = '';
      try { u = t.url(); } catch { continue; }
      if (!u || u === 'about:blank' || !/^https?:\/\//i.test(u)) continue; // 只恢复http(s)页面
      if (!urls.includes(u)) urls.push(u);
    }
  } catch {}
  return urls;
}
function persistTabs(dataDir, urls) {
  try { fs.writeFileSync(tabsFile(dataDir), JSON.stringify({ urls, savedAt: Date.now() })); } catch {}
}
function readSavedTabs(dataDir) {
  try {
    const d = JSON.parse(fs.readFileSync(tabsFile(dataDir), 'utf8'));
    return Array.isArray(d.urls) ? [...new Set(d.urls.filter(u => /^https?:\/\//i.test(u)))] : [];
  } catch { return []; }
}
// 启动后恢复上次页面（由浏览器进程直接创建标签导航，不阻塞启动返回）
async function restoreTabs(browser, dataDir, onEvent) {
  const urls = readSavedTabs(dataDir);
  if (!urls.length) return;
  try {
    // 不使用 browser.pages()（会实例化常驻 Runtime 的 Page）；初始空白页用 Target 元数据定位
    const initial = browser.targets().find(t => t.type() === 'page' && t.url() === 'about:blank');
    // 用浏览器级CDP会话创建目标页：导航由Chrome进程发起（等同地址栏输入），比page.goto更稳
    const bc = await browser.target().createCDPSession();
    let opened = 0;
    for (const u of urls) {
      try { await bc.send('Target.createTarget', { url: u }); opened++; } catch {}
    }
    if (opened > 0 && initial) {
      // 恢复成功后关掉初始空白页（浏览器级命令关闭，不碰页面会话）
      try { await bc.send('Target.closeTarget', { targetId: initial._targetId }); } catch {}
    }
    onEvent && onEvent('sync', `已恢复上次打开的 ${opened} 个页面`);
  } catch (e) {
    onEvent && onEvent('sync-fail', '页面恢复失败：' + e.message);
  }
}

async function launchProfile(profile, opts, store, onEvent) {
  if (running.has(profile.id)) {
    return { ok: true, wsEndpoint: running.get(profile.id).wsEndpoint, already: true };
  }
  const fp = profile.fingerprint_config || {};
  const fpOrigSnapshot = JSON.stringify(fp); // 指纹原始快照：GeoIP自动对齐 + UA内核对齐后统一判断是否需回写
  const dataDir = store.profileDir(profile.id); // 本地cookie/缓存目录（云同步走加密通道）
  const downloadDir = store.downloadsDir(profile.id); // 该环境独立下载目录

  // ===== 启动前强制检测：每次启动必须先探测出口IP/时区，失败立即中止（浏览器不会打开） =====
  onEvent && onEvent('step', `[1/5] 获取出口IP/时区信息${profile.proxy_type ? '（走代理 ' + ['','HTTP','HTTPS','SOCKS5'][profile.proxy_type] + '://...）' : '（直连）'}`);
  let probe;
  try {
    probe = await geoLookupAdaptive(profile);
  } catch (e) {
    const msg = `启动中止：出口IP/时区检测失败（${e.message}）。请检查代理可用性或本机网络后重试。`;
    onEvent && onEvent('geo-fail', msg);
    return { ok: false, error: msg };
  }
  const geo = probe.geo;
  // 实际生效的代理配置（HTTP自适应后按HTTP连接浏览器）
  const eff = probe.adapted ? { ...profile, proxy_type: 1 } : profile;
  let geoNote = `出口IP ${geo.query} (${geo.countryCode}) 时区 ${geo.timezone}`;
  if (probe.adapted) geoNote += ' · SOCKS5握手失败，已自动按HTTP协议连接';
  onEvent && onEvent('geo', geoNote);

  // 固定IP校验：如果环境设置了固定出口IP，实际出口IP必须完全一致，否则中止启动
  if (profile.fixed_ip && String(profile.fixed_ip).trim()) {
    const want = String(profile.fixed_ip).trim();
    if (geo.query !== want) {
      const msg = `启动中止：出口IP不匹配。设置的固定IP为 ${want}，实际出口IP为 ${geo.query}。请检查代理是否变更或更换为固定IP代理后重试。`;
      onEvent && onEvent('geo-fail', msg);
      return { ok: false, error: msg };
    }
    onEvent && onEvent('geo', `✓ 固定IP校验通过：${geo.query}`);
  }

  // GeoIP 强制对齐：时区/经纬度每次启动都跟随真实出口IP（美国IP=美国时间），保证指纹与IP自洽
  if (geo.timezone) {
    fp.timezone = geo.timezone;
    fp.timezoneOffset = tzOffsetOf(geo.timezone, fp.timezoneOffset);
  }
  if (Number.isFinite(geo.lat) && Number.isFinite(geo.lon)) {
    fp.geolocation = { latitude: geo.lat, longitude: geo.lon, accuracy: 100 };
  }
  // 语言/公网IP仅在开启自动匹配时跟随（设置页可关）
  if (opts.autoGeoMatch !== false) {
    if (COUNTRY_LANG[geo.countryCode]) fp.language = COUNTRY_LANG[geo.countryCode].split(',')[0];
    fp.languages = (COUNTRY_LANG[geo.countryCode] || fp.language || 'en-US').split(',');
    fp.publicIp = geo.query;
  }
  if (JSON.stringify(fp) !== fpOrigSnapshot) onEvent && onEvent('geo', `时区已跟随出口IP自动更新：${fp.timezone}`);
  onEvent && onEvent('step', `[2/5] 同步指纹配置（时区 ${fp.timezone} · 语言 ${fp.language}）`);

  // 本地代理中继：Chrome 的 --proxy-server 不支持内嵌账号密码，page.authenticate 对新标签有竞态
  // （会弹"代理要求用户名密码"原生框）。统一在本地起无认证中继，由它向上游注入认证。
  // 注意：中继仅支持 HTTP/HTTPS 上游；SOCKS5 无认证 Chrome 原生支持，直接走原参数
  let relayServer = null;
  let chromeProxy = '';
  const upstreamProxyUrl = (eff.proxy_type === 1 || eff.proxy_type === 2) ? proxyUrl(eff) : '';
  if (upstreamProxyUrl) {
    try {
      relayServer = new ProxyChainServer({
        port: 0,
        verbose: false,
        prepareRequestFunction: () => ({ upstreamProxyUrl, requestAuthentication: false })
      });
      await relayServer.listen();
      chromeProxy = `http://127.0.0.1:${relayServer.port}`;
      onEvent && onEvent('sync', `代理认证中继已启动（本地端口 ${relayServer.port}），代理账号密码自动注入，不会再弹认证框`);
    } catch (e) {
      relayServer = null;
      onEvent && onEvent('sync', '代理中继启动失败，回退直连代理模式：' + (e.message || e));
    }
  }
  if (!chromeProxy) chromeProxy = chromeProxyArg(eff); // SOCKS5 / 无代理 / 中继失败回退

  // 物理窗口必须完整落在屏幕工作区内：指纹 screen 常为 1920×1080，但当前物理屏可能是
  // 768p 笔记本 / 系统缩放 125%~150% / 远程桌面。照搬指纹分辨率会导致：
  // ①整窗底部伸出屏幕看不到；②模拟视口大于物理内容区时页面不生成滚动条（无法下拉，
  //   弹窗底部按钮也在可视区外）。这里按主屏工作区 clamp 内容区尺寸；
  //   screen 指纹本身保持原值（真实用户非最大化窗口时 inner<screen 也完全正常）。
  const work = primaryWorkArea();
  const wantW = fp.screen && Number.isFinite(fp.screen.width) ? fp.screen.width : 1280;
  const wantH = fp.screen && Number.isFinite(fp.screen.height) ? fp.screen.height : 800;
  const contentW = Math.max(1024, Math.min(wantW, work.width - SCROLLBAR_W));
  const contentH = Math.max(600, Math.min(wantH, work.height - CHROME_FRAME_H));

  const args = [
    '--user-data-dir=' + dataDir,
    '--no-first-run', '--no-default-browser-check',
    '--disable-infobars', '--disable-blink-features=AutomationControlled',
    // CDP 远程调试：允许 Playwright / Puppeteer / Selenium 等外部自动化工具通过 connectOverCDP 连接
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    // WebRTC 引擎级防泄漏（指纹未显式选"允许"时生效）：ICE 只走代理通道，本机真实 IP
    // 不会经 WebRTC 候选泄漏。不在 JS 里删除 RTCPeerConnection（真实 Chrome 必有该 API，
    // "没有"本身就是机器人特征）
    ...(fp.webrtc === 'real' ? [] : ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp']),
    '--window-size=' + contentW + ',' + contentH,
    // 初始位置也钉到工作区左上角（Chrome 可能从数据目录恢复上次在其他屏幕的位置，CDP 阶段还会再纠正）
    '--window-position=' + work.x + ',' + work.y
  ];
  if (chromeProxy) args.push('--proxy-server=' + chromeProxy);
  if (fp.customDns && fp.customDns.length) {
    // 自定义DNS：host映射规则
    args.push('--host-resolver-rules=' + fp.customDns.map(r => `MAP ${r.host} ${r.target}`).join(','));
  }
  const exts = fp.extensions || [];
  if (exts.length) args.push('--load-extension=' + exts.join(','));

  // 内核选择优先级：环境指定内核(指纹kernel) > 全局内核路径 > 自动(最新已装CfT) > 系统Chrome/Edge
  const pinnedKernel = String(fp.kernel || '').trim();
  let kernelExe = '';
  let kernelLabel = '';
  let willAutoInstall = false;
  try {
    const r = km.resolveForFp(fp, opts.chromePath || '');
    kernelExe = r.exe || detectChrome();
    if (pinnedKernel === 'system') kernelLabel = '系统安装的 Chrome/Edge';
    else if (pinnedKernel) kernelLabel = r.missing ? `指定内核 v${pinnedKernel} 已删除，已回退` : ('指定内核 v' + (r.version || pinnedKernel));
    else if (r.auto && r.version) kernelLabel = '自动选择最新已装内核 v' + r.version;
    else if (r.global) kernelLabel = '全局设置的内核路径';
    else kernelLabel = '系统安装的 Chrome/Edge';
  } catch {
    kernelExe = opts.chromePath || detectChrome();
    kernelLabel = '系统安装的 Chrome/Edge';
  }
  // 找不到内核 → 自动下载最新 Stable 版（全程无感，不需要用户去设置页手动操作）
  if (!kernelExe) {
    willAutoInstall = true;
    onEvent && onEvent('step', '[内核自动安装] 未检测到浏览器内核，正在自动获取最新稳定版…');
    try {
      // 1) 拿 Stable 频道最新版本号
      const channels = await km.fetchChannels(true);
      const stable = (channels.list.find(c => c.key === 'Stable') || {}).version;
      if (!stable) throw new Error('无法获取谷歌官方最新内核版本号（下载源：' + channels.source + '）');
      onEvent && onEvent('step', `[内核自动安装] 开始下载 Chrome 内核 v${stable}（约 150~180MB，首次安装请耐心等待）…`);

      // 2) 监听下载/解压进度，实时推送前端
      const progressHandler = (info) => {
        if (!info) return;
        if (info.pct >= 0) onEvent && onEvent('kernel-progress', { phase: info.phase, pct: info.pct, msg: info.msg });
        else if (info.phase === 'extract') onEvent && onEvent('step', '[内核自动安装] 下载完成，正在解压…');
      };
      const noticeHandler = (msg) => {
        onEvent && onEvent('kernel-notice', msg);
      };
      km.bus.on('progress', progressHandler);
      km.bus.on('notice', noticeHandler);

      try {
        const res = await km.install(stable, { channel: 'Stable' });
        onEvent && onEvent('step', `[内核自动安装] ✓ Chrome v${stable} 安装完成`);
      } finally {
        km.bus.off('progress', progressHandler);
        km.bus.off('notice', noticeHandler);
      }

      // 3) 重新解析内核路径并继续启动
      const r2 = km.resolveForFp(fp, opts.chromePath || '');
      kernelExe = r2.exe || km.autoExe();
      if (!kernelExe) throw new Error('内核安装成功但可执行文件校验失败');
      kernelLabel = '自动下载安装 v' + stable;
    } catch (e) {
      // 自动安装失败 → 给出明确错误，引导用户手动处理
      const msg = `内核自动安装失败：${e.message}。请检查网络后重试，或到「软件设置 → 浏览器内核管理」手动下载谷歌官方内核。`;
      onEvent && onEvent('geo-fail', msg);
      return { ok: false, error: msg };
    }
  }

  const launchOpts = () => ({
    executablePath: kernelExe,
    headless: false,
    defaultViewport: null,
    // 关键：去掉 Puppeteer 默认的 --enable-automation（否则浏览器顶部显示"正受到自动测试软件的控制"
    // 且网站可通过 navigator.webdriver / window.cdc_ 等特征识别自动化）
    ignoreDefaultArgs: ['--enable-automation'],
    args
  });
  let kv = '';
  onEvent && onEvent('step', '[3/5] 正在打开浏览器内核进程…');
  try { kv = km.exeVersion(kernelExe); } catch {}
  onEvent && onEvent('sync', `浏览器内核：${kv ? 'Chrome v' + kv + ' · ' : ''}${kernelLabel}`);
  // UA 主版本自动对齐真实内核：启动后 HTTP UA 头 / sec-ch-ua / navigator 会由引擎层按 fp.ua
  // 统一下发，若 UA 宣称版本 ≠ 实际内核版本，JS 引擎特性、HTTP 头与 Client Hints 互相矛盾，
  // 是 Etsy/Akamai 一类风控的强机器人信号。这里把随机指纹里的版本号改为真实内核主版本
  if (fp.ua && kv) {
    const realMajor = parseInt(kv, 10);
    const uaMajor = String(fp.ua).match(/Chrome\/(\d+)\./);
    if (realMajor && uaMajor && Number(uaMajor[1]) !== realMajor) {
      fp.ua = fp.ua.replace(/Chrome\/\d+\./, 'Chrome/' + realMajor + '.');
      fp.browserVersion = String(realMajor);
      onEvent && onEvent('geo', `UA 主版本已自动对齐实际内核 Chrome ${realMajor}（避免头部/JS 版本矛盾触发机器人验证）`);
    }
  }
  try {
    browser = await puppeteer.launch(launchOpts());
  } catch (e) {
    // 启动失败常见原因：数据目录被残留内核进程占用（如客户端重启后旧窗口仍在）→ 清理后重试一次
    const exe = require('path').basename(kernelExe) || (process.platform === 'darwin' ? 'Google Chrome for Testing' : 'chrome.exe');
    const killed = await killStaleBrowser(dataDir, exe);
    if (killed > 0) {
      onEvent && onEvent('sync', `检测到 ${killed} 个残留内核进程占用该环境数据目录，已强制结束并重试启动`);
      try { browser = await puppeteer.launch(launchOpts()); }
      catch (e2) {
        if (relayServer) { try { relayServer.close(); } catch {} relayServer = null; }
        return { ok: false, error: '内核启动失败：' + (e2.message || '未知错误') };
      }
    } else {
      if (relayServer) { try { relayServer.close(); } catch {} relayServer = null; }
      let msg = '内核启动失败：' + (e.message || '未知错误');
      if (/Failed to launch/i.test(msg)) {
        msg += '。可能原因：内核路径不正确，或该环境数据目录被其他程序占用。请在设置中检测内核路径，或在任务管理器结束残留的浏览器进程后重试。';
      }
      return { ok: false, error: msg };
    }
  }
  onEvent && onEvent('step', `内核已启动：PID=${browser.process() ? browser.process().pid : '?'}，正在注入指纹脚本…`);

  // 窗口入屏纠正 + 实测真实内容区：
  // 独立 user-data-dir 会让 Chrome 记住并恢复上次关闭时的窗口位置/大小（可能来自另一块更大的屏），
  // 必须通过 CDP Browser.setWindowBounds 强制把整窗放进当前屏幕工作区并居中；
  // 随后用 window.innerWidth/Height 实测内容区尺寸作为模拟视口——模拟视口绝不能大于物理
  // 内容区，否则页面按大视口布局、Chrome 不出滚动条，底部与弹窗按钮会被裁且无法下拉。
  let viewport = { width: contentW, height: contentH };
  try {
    const bcs = await browser.target().createCDPSession();
    const winInfo = await bcs.send('Browser.getWindowForTarget');
    // 窗口当前实际所在的显示器（多屏时可能不是主屏），取其工作区做约束
    let area = work;
    try {
      const disp = electronScreen.getDisplayMatching(winInfo.bounds) || electronScreen.getPrimaryDisplay();
      const wa = disp && disp.workArea;
      if (wa && wa.width >= 1024 && wa.height >= 700) {
        area = { x: wa.x, y: wa.y, width: wa.width, height: wa.height };
      }
    } catch {}
    const outerW = Math.min(area.width, contentW + SCROLLBAR_W);
    const outerH = Math.min(area.height, contentH + CHROME_FRAME_H);
    const left = area.x + Math.max(0, Math.round((area.width - outerW) / 2));
    const top = area.y + Math.max(0, Math.round((area.height - outerH) / 2));
    await bcs.send('Browser.setWindowBounds', {
      windowId: winInfo.windowId,
      bounds: { left, top, width: outerW, height: outerH, windowState: 'normal' }
    });
    // 等窗口管理器把新尺寸/位置落地后再测内容区
    await new Promise(r => setTimeout(r, 400));
    // 裸会话单次 Runtime.evaluate 后立即 detach：不留下常驻 Runtime 域（browser.pages()
    // 会实例化 Puppeteer Page 并常驻 Runtime，初始空白页随后常被用户拿去直接浏览网站）
    const probeTargets = browser.targets().filter(t => t.type() === 'page');
    if (probeTargets[0]) {
      const ps = await probeTargets[0].createCDPSession().catch(() => null);
      if (ps) {
        const ev = await ps.send('Runtime.evaluate', {
          expression: '({w: window.innerWidth, h: window.innerHeight})',
          returnByValue: true
        }).catch(() => null);
        await ps.detach().catch(() => {});
        const real = ev && ev.result && ev.result.value;
        if (real && Number.isFinite(real.w) && Number.isFinite(real.h) && real.w >= 900 && real.h >= 500) {
          viewport = { width: real.w, height: real.h };
        }
      }
    }
    onEvent && onEvent('geo', `窗口已适配屏幕并居中（整窗 ${outerW}×${outerH}，页面视口 ${viewport.width}×${viewport.height}，底部与弹窗可完整滚动）`);
  } catch (e) {
    onEvent && onEvent('sync-fail', '窗口屏幕适配失败（不影响启动，如底部仍显示不全请手动把窗口拖入屏幕后重启该环境）：' + (e && e.message));
  }

  // 代理认证兜底：仅在中继启动失败回退直连模式时，用 page.authenticate 注入凭据
  if (!relayServer && eff.proxy_username && eff.proxy_type !== 3) {
    try {
      const pages = await browser.pages();
      const auth = { username: profile.proxy_username, password: profile.proxy_password || '' };
      for (const pg of pages) await pg.authenticate(auth);
      browser.on('targetcreated', async t => {
        try { if (t.type() === 'page') await (await t.page()).authenticate(auth); } catch {}
      });
    } catch {}
  }

  // CDP 指纹注入（反检测关键）：对每个页面目标挂【裸 CDP 会话】——只开 Page 域下发
  // addScriptToEvaluateOnNewDocument 与 Emulation/Network 覆盖，绝不启用 Runtime 域。
  // Puppeteer 的 page.evaluateOnNewDocument/setViewport 会常驻 Runtime+Page，
  // Akamai/PerimeterX 等可借 console/Error 调试器探针识别出 CDP 自动化；裸会话无此痕迹。
  const stealthSessions = new Map(); // target -> CDPSession（保持引用，覆盖随会话存活）
  async function attachStealth(target) {
    let session;
    try { session = await target.createCDPSession(); } catch { return; }
    stealthSessions.set(target, session);
    try {
      await session.send('Page.enable');
      await session.send('Page.addScriptToEvaluateOnNewDocument', { script: buildInjectionScript(fp) });
      // 视口用实测物理内容区尺寸（≤ 物理内容区，页面必有滚动条，底部/弹窗不被裁）；
      // screen 指纹由注入脚本 hook 为 fp.screen，二者不相等是真实窗口常态
      await session.send('Emulation.setDeviceMetricsOverride', {
        width: viewport.width, height: viewport.height,
        deviceScaleFactor: fp.devicePixelRatio || 1, mobile: false
      });
      // 引擎级时区/语言/地理位置：Intl/Date/navigator.language/地理 API 原生返回目标值，
      // 比纯 JS hook 自洽（JS hook 仅作内核命令失败时的兜底，仍保留在注入脚本中）
      if (fp.timezone) {
        await session.send('Emulation.setTimezoneOverride', { timezoneId: fp.timezone }).catch(() => {});
      }
      if (fp.language) {
        await session.send('Emulation.setLocaleOverride', { locale: fp.language }).catch(() => {});
      }
      if (fp.geolocation && Number.isFinite(fp.geolocation.latitude)) {
        await session.send('Emulation.setGeolocationOverride', {
          latitude: fp.geolocation.latitude,
          longitude: fp.geolocation.longitude,
          accuracy: fp.geolocation.accuracy || 100
        }).catch(() => {});
      }
      // 引擎级 UA 覆盖：HTTP User-Agent 头、sec-ch-ua、navigator.userAgent(userAgentData)
      // 全部统一为 fp.ua（已与真实内核主版本对齐），彻底消除"JS 宣称 130 / 头部实为 122"矛盾
      if (fp.ua) {
        const langs = (fp.languages && fp.languages.length ? fp.languages : [fp.language || 'en-US']);
        const payload = {
          userAgent: fp.ua,
          acceptLanguage: buildAcceptLanguage(langs),
          platform: fp.platform || undefined,
          userAgentMetadata: buildUaMetadata(fp, kv)
        };
        await session.send('Network.setUserAgentOverride', payload).catch(async () => {
          await session.send('Emulation.setUserAgentOverride', payload).catch(() => {}); // 旧内核回退
        });
      }
    } catch { /* 单个目标注入失败不阻塞浏览器启动 */ }
  }
  for (const t of browser.targets()) {
    if (t && t.type() === 'page') attachStealth(t);
  }
  browser.on('targetcreated', t => {
    try { if (t && t.type() === 'page') attachStealth(t); } catch {}
  });
  browser.on('targetdestroyed', async t => {
    const s = stealthSessions.get(t);
    if (s) {
      stealthSessions.delete(t);
      try { await s.detach(); } catch {}
    }
  });
  onEvent && onEvent('step', '[4/5] 注入代理认证 / 指纹脚本 / 手动Cookie…');

  // 独立下载目录：该环境所有下载自动保存到自己的 downloads 文件夹，不混入系统下载
  await setupDownloadDir(browser, downloadDir, onEvent);

  // 手动导入Cookie：页面导航前注入（编辑保存后下次启动自动带入登录态）
  await injectManualCookies(browser, dataDir, onEvent);

  // 标签页会话：恢复上次关闭前打开的页面（后台导航，不阻塞启动）
  restoreTabs(browser, dataDir, onEvent);

  // IP检测信息页：自动打开一个标签，显示出口IP/国家/州省/城市/时区/语言，方便确认代理与指纹自洽
  onEvent && onEvent('step', '[5/5] 打开环境检测信息页（IP / 国家 / 州省 / 城市 / 时区）…');
  openInfoTab(browser, dataDir, {
    ip: geo.query, country: geo.country, countryCode: geo.countryCode,
    region: geo.region, city: geo.city,
    timezone: fp.timezone, offsetMin: fp.timezoneOffset,
    language: fp.language, languages: (fp.languages || []).join(', '),
    lat: fp.geolocation && fp.geolocation.latitude, lon: fp.geolocation && fp.geolocation.longitude,
    ua: fp.ua,
    proxyType: chromeProxy ? `${['', 'HTTP', 'HTTPS', 'SOCKS5'][eff.proxy_type || 0]} 代理` : ''
  }, onEvent);

  // 运行期间持续保存标签页 + 导出实时Cookie（含会话级）：
  // 标签变化3秒防抖 + 15秒标签/12秒Cookie定时兜底（用户直接点X关闭时，
  // CDP 已断无法补导，靠最近一次定时快照保住登录态）
  let tabSaveTimer = null;
  const scheduleTabSave = () => {
    if (tabSaveTimer) return;
    tabSaveTimer = setTimeout(() => {
      tabSaveTimer = null;
      collectOpenUrls(browser).then(urls => persistTabs(dataDir, urls));
      exportRuntimeCookies(browser, dataDir);
    }, 3000);
  };
  browser.on('targetcreated', t => { if (t && t.type && t.type() === 'page') scheduleTabSave(); });
  browser.on('targetdestroyed', t => { if (t && t.type && t.type() === 'page') scheduleTabSave(); });
  const tabSaveInterval = setInterval(() => {
    collectOpenUrls(browser).then(urls => persistTabs(dataDir, urls));
  }, 15000);
  const cookieFlushInterval = setInterval(() => {
    exportRuntimeCookies(browser, dataDir);
  }, 12000);

  // 浏览器被用户直接关闭时也能感知：清理中继端口、注册表并通知上层（触发状态刷新/关单/云同步）
  browser.on('disconnected', () => {
    clearInterval(tabSaveInterval);
    clearInterval(cookieFlushInterval);
    if (tabSaveTimer) { clearTimeout(tabSaveTimer); tabSaveTimer = null; }
    if (relayServer) { try { relayServer.close(); } catch {} relayServer = null; }
    running.delete(profile.id);
    onEvent && onEvent('closed', profile.id);
  });

  const wsEndpoint = browser.wsEndpoint();
  // 从 wsEndpoint 解析端口号：格式 ws://127.0.0.1:PORT/devtools/browser/UUID
  const portMatch = wsEndpoint.match(/:(\d+)\//);
  const debugPort = portMatch ? parseInt(portMatch[1], 10) : 0;

  running.set(profile.id, {
    browser,
    dataDir,
    downloadDir,
    relay: relayServer,
    wsEndpoint,
    debugPort,
    httpEndpoint: debugPort ? `http://127.0.0.1:${debugPort}` : '',
    pid: browser.process() ? browser.process().pid : 0,
    geo: fp.publicIp || ''
  });
  return { ok: true, wsEndpoint, debugPort, httpEndpoint: debugPort ? `http://127.0.0.1:${debugPort}` : '', pid: running.get(profile.id).pid, geo: geoNote, proxyAdapted: probe.adapted, fpChanged: JSON.stringify(fp) !== fpOrigSnapshot, fp };
}

async function closeProfile(profileId) {
  const inst = running.get(profileId);
  if (!inst) return { ok: true, notRunning: true };
  // 关闭前最后保存一次标签页 + 全量Cookie（含会话级；browser.close为优雅关闭，CDP仍可读）
  try {
    const urls = await collectOpenUrls(inst.browser);
    persistTabs(inst.dataDir, urls);
  } catch {}
  try { await exportRuntimeCookies(inst.browser, inst.dataDir); } catch {}
  try { await inst.browser.close(); } catch {}
  if (inst.relay) { try { inst.relay.close(); } catch {} }
  running.delete(profileId);
  return { ok: true };
}

function listRunning() {
  const out = [];
  for (const [id, inst] of running) {
    out.push({ profileId: id, wsEndpoint: inst.wsEndpoint, httpEndpoint: inst.httpEndpoint || '', debugPort: inst.debugPort || 0, pid: inst.pid, publicIp: inst.geo });
  }
  return out;
}

function getRunning(profileId) { return running.get(profileId); }

// IANA时区 → UTC偏移（分钟）粗算（用于指纹自洽）
function tzOffsetOf(timezone, fallback) {
  if (!timezone) return fallback;
  try {
    const dtf = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const parts = {};
    for (const p of dtf.formatToParts(new Date())) parts[p.type] = p.value;
    const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
    return Math.round((asUTC - Date.now()) / 60000 / 15) * 15; // 分钟
  } catch { return fallback; }
}

module.exports = { launchProfile, closeProfile, listRunning, getRunning, detectChrome, proxyUrl, geoLookup, geoLookupAdaptive, proxyErrorHint, COUNTRY_LANG, buildUaMetadata, buildAcceptLanguage, fetchAllCookies, exportRuntimeCookies, injectStartupCookies: injectManualCookies };
