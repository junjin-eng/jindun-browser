// 浏览器内核管理器：多版本 Chrome for Testing（谷歌官方免安装绿色版）
// - 版本清单来自谷歌官方 JSON API（chrome-for-testing），国内可切换 npmmirror 镜像下载
// - 内核按版本号独立存放：
//     Windows: userData/kernels/<版本号>/chrome-win64/chrome.exe
//     macOS:   userData/kernels/<版本号>/chrome-mac-{x64,arm64}/Google Chrome for Testing.app/...
// - 每个环境可在指纹设置里单独指定内核；默认"自动"始终使用已安装的最新版
// - 开启自动更新后，每 24 小时检查一次 Stable 频道，谷歌发新版后台静默下载，下次启动即用
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { app } = require('electron');
const fetch = require('node-fetch');
const { EventEmitter } = require('events');

// ---------- 平台常量（Chrome for Testing 平台标识 / 包目录名 / 可执行文件相对路径） ----------
const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';
const CF_PLATFORM = isMac ? (process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64') : 'win64';
const KERNEL_DIR = isMac ? (process.arch === 'arm64' ? 'chrome-mac-arm64' : 'chrome-mac-x64') : 'chrome-win64';
const EXE_REL = isMac
  ? path.join('Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')
  : path.join('chrome.exe');

const META_URL = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json';
const HISTORY_URL = 'https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json';
const MIRROR_LIST_URL = 'https://registry.npmmirror.com/-/binary/chrome-for-testing/';
const CHANNELS = [
  { key: 'Stable', name: '稳定版 Stable' },
  { key: 'Beta', name: '测试版 Beta' },
  { key: 'Dev', name: '开发版 Dev' },
  { key: 'Canary', name: '金丝雀 Canary' }
];
const CHECK_INTERVAL_MS = 24 * 3600 * 1000;

const bus = new EventEmitter();
let reg = null;          // 持久化配置
let channelsCache = null; // {at, data}
let channelsPromise = null;
let installing = null;   // { version, pct, phase }

function root() { return path.join(app.getPath('userData'), 'kernels'); }
function regFile() { return path.join(root(), 'registry.json'); }
function versionDir(v) { return path.join(root(), String(v)); }
function exeFor(v) {
  if (!v || v === 'system') return '';
  const p = path.join(versionDir(v), KERNEL_DIR, EXE_REL);
  try { return fs.existsSync(p) ? p : ''; } catch { return ''; }
}

function defaultReg() {
  return { autoUpdate: true, source: 'auto', defaultVersion: '', lastCheck: 0, installed: {} };
}
function load() {
  if (reg) return reg;
  reg = defaultReg();
  try { Object.assign(reg, JSON.parse(fs.readFileSync(regFile(), 'utf8'))); } catch {}
  if (!reg.installed || typeof reg.installed !== 'object') reg.installed = {};
  scanDisk();
  return reg;
}
function save() {
  try { fs.mkdirSync(root(), { recursive: true }); fs.writeFileSync(regFile(), JSON.stringify(reg, null, 2)); } catch {}
}
// 磁盘上存在但注册表里没有的版本（手动拷入/旧版本残留）自动补登记
function scanDisk() {
  let ents = [];
  try { ents = fs.readdirSync(root(), { withFileTypes: true }); } catch { return; }
  for (const d of ents) {
    if (!d.isDirectory()) continue;
    const v = d.name;
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(v)) continue;
    if (exeFor(v) && !reg.installed[v]) reg.installed[v] = { channel: '', installedAt: 0 };
    if (!exeFor(v) && reg.installed[v]) delete reg.installed[v]; // 解压不完整的残留
  }
}

// ---------- 版本号比较（4段数字） ----------
function cmpVer(a, b) {
  const pa = String(a || '0').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 4; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}
function sortedInstalled() {
  return Object.keys(load().installed).filter(v => exeFor(v)).sort(cmpVer);
}
// 默认"自动"时实际使用的内核（已安装的最高版本）
function autoExe() {
  const all = sortedInstalled();
  return all.length ? exeFor(all[all.length - 1]) : '';
}
// 按环境指纹配置解析应使用的内核路径；'' 表示回退（全局配置/系统Chrome）
function resolveForFp(fp, globalPath) {
  const k = String((fp && fp.kernel) || '').trim();
  if (k === 'system') return { exe: '', system: true };
  if (k) {
    const e = exeFor(k);
    if (e) return { exe: e, version: k };
    return { exe: globalPath || '', missing: k }; // 指定版本已删除 → 回退全局/系统内核
  }
  const def = load().defaultVersion;
  if (def && def !== 'system') {
    const e = exeFor(def);
    if (e) return { exe: e, version: def };
  }
  if (globalPath) return { exe: globalPath, global: true };
  const ae = autoExe();
  return ae ? { exe: ae, version: sortedInstalled().slice(-1)[0], auto: true } : { exe: '' };
}

// ---------- 远端版本清单 ----------
function fetchJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 12000);
  return fetch(url, { signal: ctrl.signal, redirect: 'follow' })
    .then(async r => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .finally(() => clearTimeout(timer));
}

// 取四个频道（Stable/Beta/Dev/Canary）的最新版本；官方接口失败时用镜像目录兜底
async function fetchChannels(force) {
  load();
  if (!force && channelsCache && Date.now() - channelsCache.at < 10 * 60 * 1000) return channelsCache.data;
  if (channelsPromise) return channelsPromise;
  channelsPromise = (async () => {
    let out = null;
    try {
      const j = await fetchJson(META_URL, 12000);
      if (j && j.channels) {
        out = { source: 'official', list: CHANNELS.map(c => {
          const ch = j.channels[c.key] || {};
          const dl = (ch.downloads && ch.downloads.chrome || []).find(x => x.platform === CF_PLATFORM);
          return { key: c.key, name: c.name, version: ch.version || '', updated: ch.revision || '', urlOfficial: dl ? dl.url : '' };
        }) };
      }
    } catch { /* 国内网络可能无法直连 github.io，走镜像兜底 */ }
    if (!out) {
      const latest = await fetchMirrorLatest();
      out = {
        source: 'mirror',
        list: CHANNELS.map(c => ({ key: c.key, name: c.name, version: c.key === 'Stable' ? latest : '', updated: '', urlOfficial: '' }))
      };
    }
    channelsCache = { at: Date.now(), data: out };
    return out;
  })().finally(() => { channelsPromise = null; });
  return channelsPromise;
}
// 镜像目录列表 → 最高版本号（仅用于官方接口不可达时兜底）
async function fetchMirrorLatest() {
  try {
    const arr = await fetchJson(MIRROR_LIST_URL, 12000);
    const vers = (Array.isArray(arr) ? arr : []).map(x => String((x && x.name) || '').replace(/\/$/, ''))
      .filter(v => /^\d+\.\d+\.\d+\.\d+$/.test(v)).sort(cmpVer);
    return vers.length ? vers[vers.length - 1] : '';
  } catch { return ''; }
}

// 历史版本（最近若干个谷歌认证的 known-good 版本）
async function fetchHistory(limit) {
  limit = limit || 15;
  let vers = [];
  try {
    const j = await fetchJson(HISTORY_URL, 20000);
    if (j && Array.isArray(j.versions)) vers = j.versions.map(x => x.version).filter(v => /^\d+\.\d+\.\d+\.\d+$/.test(v));
  } catch { /* 镜像兜底 */ }
  if (!vers.length) {
    try {
      const arr = await fetchJson(MIRROR_LIST_URL, 15000);
      vers = (Array.isArray(arr) ? arr : []).map(x => String((x && x.name) || '').replace(/\/$/, ''))
        .filter(v => /^\d+\.\d+\.\d+\.\d+$/.test(v));
    } catch {}
  }
  return vers.sort(cmpVer).slice(-limit).reverse();
}

// 某版本在选定下载源下的候选地址（按优先级）
function candidateUrls(version, officialUrl) {
  const mirror = `https://cdn.npmmirror.com/binaries/chrome-for-testing/${version}/${CF_PLATFORM}/${KERNEL_DIR}.zip`;
  const official = officialUrl || `https://storage.googleapis.com/chrome-for-testing-public/${version}/${CF_PLATFORM}/${KERNEL_DIR}.zip`;
  const src = load().source;
  if (src === 'official') return [official, mirror];
  if (src === 'mirror') return [mirror, official];
  return [official, mirror]; // auto：先试官方，失败立刻切镜像
}

// ---------- 下载 / 解压 ----------
function downloadOnce(url, dest, onProgress) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000); // 15秒拿不到响应头判定该源不可用
  return fetch(url, { signal: ctrl.signal, redirect: 'follow' }).then(res => {
    clearTimeout(timer);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const total = Number(res.headers.get('content-length') || 0);
    return new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(dest);
      let got = 0;
      res.body.on('data', c => {
        got += c.length;
        if (onProgress) { try { onProgress(total ? Math.round(got / total * 100) : -1); } catch {} }
      });
      res.body.on('error', reject);
      ws.on('error', reject);
      res.body.pipe(ws);
      ws.on('finish', () => ws.close(() => resolve(dest)));
    });
  });
}
async function downloadAuto(urls, dest, onProgress) {
  let lastErr = null;
  for (let i = 0; i < urls.length; i++) {
    try {
      if (i > 0) onProgress && onProgress(-1, '自动切换到备用下载源…');
      return await downloadOnce(urls[i], dest, onProgress);
    } catch (e) {
      lastErr = e;
      try { fs.rmSync(dest, { force: true }); } catch {}
    }
  }
  throw lastErr || new Error('所有下载源均不可用');
}
// 检查 zip 文件有效性（PK magic bytes）
function isZipValid(zip) {
  try {
    const fd = fs.openSync(zip, 'r');
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    return buf[0] === 0x50 && buf[1] === 0x4B; // 'PK'
  } catch { return false; }
}

function extractZip(zip, dest) {
  if (!fs.existsSync(zip)) throw new Error('zip 文件不存在: ' + zip);
  const stat = fs.statSync(zip);
  if (stat.size < 100) throw new Error('zip 文件过小（' + stat.size + ' bytes），可能下载不完整');
  if (!isZipValid(zip)) throw new Error('zip 文件无效：不是有效的 PK 格式压缩包（可能下载源返回了错误页面或 HTML）');

  if (isMac) {
    // macOS: 优先系统自带 tar（bsdtar/libarchive，原生支持 zip），失败再用 ditto（系统原生 unzip 工具）
    try {
      execSync(`tar -xf "${zip}" -C "${dest}"`, { timeout: 600000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return;
    } catch (e) {
      try {
        execSync(`ditto -x -k "${zip}" "${dest}"`, { timeout: 600000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return;
      } catch (e2) {
        const tarErr = (e && (e.stderr || e.message)) ? String(e.stderr || e.message).slice(0, 500) : '';
        const dittoErr = (e2 && (e2.stderr || e2.message)) ? String(e2.stderr || e2.message).slice(0, 500) : '';
        throw new Error(`解压失败 — tar: ${tarErr} | ditto: ${dittoErr}`);
      }
    }
  }

  // Windows: 优先用 tar.exe（Win10 1803+ 自带，libarchive），它对长路径/特殊字符处理最可靠
  try {
    execSync(`tar -xf "${zip}" -C "${dest}"`, {
      windowsHide: true, timeout: 600000, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return;
  } catch (e) {
    // 如果 tar 不存在或失败，fallback 到 PowerShell（兼容 Win7/8）
    const ps = `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dest}' -Force`;
    try {
      execSync(`powershell -NoProfile -Command "${ps.replace(/'/g, "''")}"`, { windowsHide: true, timeout: 600000 });
      return;
    } catch (e2) {
      // 两个方案都失败，带上完整错误信息
      const tarErr = (e && (e.stderr || e.message)) ? String(e.stderr || e.message).slice(0, 500) : '';
      const psErr = (e2 && e2.message) ? String(e2.message).slice(0, 500) : '';
      throw new Error(`解压失败 — tar: ${tarErr} | PowerShell: ${psErr}`);
    }
  }
}
function dirSize(d) {
  let n = 0;
  const walk = (dir) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else { try { n += fs.statSync(p).size; } catch {} }
    }
  };
  walk(d);
  return n;
}
const verCache = new Map();
function exeVersion(exe) {
  if (!exe) return '';
  if (verCache.has(exe)) return verCache.get(exe);
  let v = '';
  try {
    if (isMac) {
      // macOS: 已安装的 CfT 内核目录名就是版本号；系统 Chrome 则读 .app/Contents/Info.plist
      const m = exe.match(/[\\/]kernels[\\/](\d+\.\d+\.\d+\.\d+)[\\/]/);
      if (m) { v = m[1]; }
      else if (/\.app[\\/]Contents[\\/]MacOS[\\/]/.test(exe)) {
        const plist = path.join(path.dirname(path.dirname(exe)), 'Info.plist');
        v = String(execSync(`plutil -extract CFBundleShortVersionString raw -o - "${plist}"`, {
          timeout: 15000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
        })).trim();
      }
    } else {
      v = String(execSync(
        `powershell -NoProfile -Command "(Get-Item -LiteralPath '${exe}').VersionInfo.FileVersion"`,
        { windowsHide: true, timeout: 15000, encoding: 'utf8' }
      )).trim();
    }
  } catch {}
  verCache.set(exe, v);
  return v;
}

// ---------- 安装 / 删除 ----------
async function install(version, opts) {
  load();
  opts = opts || {};
  version = String(version || '').trim();
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(version)) throw new Error('版本号格式不正确：' + version);
  if (installing) throw new Error('已有内核正在下载安装，请等待完成');
  if (exeFor(version)) { bus.emit('notice', '版本 ' + version + ' 已安装，无需重复安装'); return { ok: true, exists: true }; }

  installing = { version, pct: 0, phase: 'download' };
  bus.emit('progress', { ...installing });
  const tmpZip = path.join(app.getPath('temp'), 'jindun-kernel-' + version + '-' + Date.now() + '.zip');
  const tmpDir = path.join(root(), '.tmp-' + Date.now());
  try {
    fs.mkdirSync(root(), { recursive: true });
    const urls = candidateUrls(version, opts.urlOfficial);
    bus.emit('notice', '开始下载 Chrome 内核 v' + version + '（约 150~180MB）');
    await downloadAuto(urls, tmpZip, (pct, msg) => {
      installing.pct = pct;
      bus.emit('progress', { ...installing, msg });
    });
    installing.phase = 'extract'; installing.pct = -1;
    bus.emit('progress', { ...installing, msg: '下载完成，正在解压（约需1~3分钟）…' });
    fs.mkdirSync(tmpDir, { recursive: true });
    extractZip(tmpZip, tmpDir);
    // 压缩包内顶层目录：Windows 为 chrome-win64，macOS 为 chrome-mac-x64 / chrome-mac-arm64
    const finalDir = versionDir(version);
    fs.rmSync(finalDir, { recursive: true, force: true });
    fs.mkdirSync(finalDir, { recursive: true });
    let inner = path.join(tmpDir, KERNEL_DIR);
    if (!fs.existsSync(path.join(inner, EXE_REL))) {
      // 容错：个别打包结构多嵌一层，递归查找内核可执行文件所在目录
      const exeName = path.basename(EXE_REL);
      const found = (function walk(d0) {
        let ents = [];
        try { ents = fs.readdirSync(d0, { withFileTypes: true }); } catch { return ''; }
        for (const e of ents) {
          const p = path.join(d0, e.name);
          if (e.isDirectory()) { const r = walk(p); if (r) return r; }
          else if (e.name === exeName) return d0;
        }
        return '';
      })(tmpDir);
      if (!found) throw new Error('解压完成但未找到内核可执行文件（' + exeName + '）');
      // Windows 找到的是 chrome.exe 所在目录；macOS 找到的是 MacOS 目录，需要回退到 .app 包根
      // 统一规范：inner 必须是包含 EXE_REL 相对结构的目录
      if (isMac) {
        // found = .../Google Chrome for Testing.app/Contents/MacOS → 回退三级到压缩包顶层 KERNEL_DIR
        const rel = path.relative(tmpDir, found).split(path.sep);
        const topIdx = rel.indexOf(KERNEL_DIR);
        inner = topIdx >= 0
          ? path.join(tmpDir, ...rel.slice(0, topIdx + 1))
          : path.join(tmpDir, KERNEL_DIR);
        if (!fs.existsSync(path.join(inner, EXE_REL))) inner = path.dirname(path.dirname(path.dirname(found)));
      } else {
        inner = found;
      }
    }
    fs.renameSync(inner, path.join(root(), version, KERNEL_DIR));
    if (!exeFor(version)) throw new Error('内核安装后校验失败：可执行文件不存在');
    if (isMac) {
      // macOS: 解压后 app bundle 内的可执行文件可能丢失 +x 权限，补上
      try { fs.chmodSync(exeFor(version), 0o755); } catch {}
    }
    reg.installed[version] = { channel: opts.channel || '', installedAt: Date.now() };
    save();
    bus.emit('notice', '✓ 内核 v' + version + ' 安装完成，下次启动环境即可选用');
    return { ok: true, version, exe: exeFor(version) };
  } catch (e) {
    bus.emit('notice', '内核 v' + version + ' 安装失败：' + (e.message || e));
    throw e;
  } finally {
    try { fs.rmSync(tmpZip, { force: true }); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    installing = null;
    bus.emit('progress', null);
  }
}

async function remove(version) {
  load();
  const v = String(version || '');
  if (!reg.installed[v]) throw new Error('该版本未安装');
  fs.rmSync(versionDir(v), { recursive: true, force: true });
  delete reg.installed[v];
  if (reg.defaultVersion === v) { reg.defaultVersion = ''; }
  save();
  return { ok: true };
}

function setConfig(patch) {
  load();
  if (typeof patch.autoUpdate === 'boolean') reg.autoUpdate = patch.autoUpdate;
  if (['auto', 'official', 'mirror'].includes(patch.source)) reg.source = patch.source;
  if (patch.defaultVersion !== undefined) {
    const d = String(patch.defaultVersion || '');
    if (d && d !== 'system' && !exeFor(d)) throw new Error('该版本未安装，无法设为默认');
    reg.defaultVersion = d;
  }
  save();
  return state();
}

// ---------- 自动更新 ----------
async function autoCheckIfDue(force) {
  load();
  if (!force && (!reg.autoUpdate || Date.now() - (reg.lastCheck || 0) < CHECK_INTERVAL_MS)) return null;
  let info = null;
  try {
    const ch = await fetchChannels(true);
    reg.lastCheck = Date.now(); save();
    const stable = (ch.list.find(x => x.key === 'Stable') || {}).version;
    info = { stable };
    if (stable && !exeFor(stable)) {
      bus.emit('notice', '检测到谷歌发布新稳定版内核 v' + stable + '，开始后台自动下载…');
      try { await install(stable, { channel: 'Stable' }); } catch {}
    } else if (stable) {
      info.alreadyLatest = true;
    }
  } catch (e) { info = { error: e.message || String(e) }; }
  return info;
}

// ---------- 给界面的状态 ----------
function state() {
  load();
  const inst = sortedInstalled().reverse().map(v => {
    const info = reg.installed[v] || {};
    return {
      version: v,
      channel: info.channel || '',
      installedAt: info.installedAt || 0,
      size: dirSize(versionDir(v)),
      isDefault: reg.defaultVersion === v
    };
  });
  let eff = autoExe();
  let effVersion = '';
  if (eff) {
    const top = sortedInstalled().slice(-1)[0];
    effVersion = top;
  }
  return {
    root: root(),
    autoUpdate: !!reg.autoUpdate,
    source: reg.source,
    defaultVersion: reg.defaultVersion || '',
    lastCheck: reg.lastCheck || 0,
    installing: installing ? { version: installing.version, pct: installing.pct, phase: installing.phase } : null,
    installed: inst,
    effectiveAuto: eff ? { version: effVersion, exe: eff, fileVersion: exeVersion(eff) } : null
  };
}
async function stateAsync(withRemote) {
  const s = state();
  if (withRemote) {
    try {
      const ch = await fetchChannels(false);
      const have = new Set(s.installed.map(x => x.version));
      s.channels = ch.list.map(c => ({ ...c, installed: c.version ? have.has(c.version) : false }));
      s.remoteSource = ch.source;
    } catch (e) { s.channelsError = e.message || String(e); s.channels = []; }
  } else {
    s.channels = (channelsCache ? channelsCache.data.list : []).map(c => ({ ...c, installed: s.installed.some(x => x.version === c.version) }));
  }
  return s;
}

module.exports = {
  bus, CHANNELS, cmpVer,
  state, stateAsync, fetchChannels, fetchHistory,
  install, remove, setConfig, autoCheckIfDue,
  exeFor, autoExe, resolveForFp, exeVersion, root
};
