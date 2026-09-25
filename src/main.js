// 槿盾浏览器 Electron 主进程
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('./store');
const api = require('./server-api');
const launcher = require('./launcher');
const km = require('./kernel-manager');
const cookieSync = require('./cookie-sync');
const { createLocalApi } = require('./local-api');

const store = new Store();
let mainWindow = null;
let localApiServer = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 820,
    minWidth: 1080, minHeight: 700,
    title: '槿盾浏览器',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  startLocalApi();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

  // 浏览器内核：进度/通知推送到渲染进程
  km.bus.on('progress', p => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('kernel:progress', p); });
  km.bus.on('notice', msg => notifyEvent(0, 'kernel', msg));
  // 启动 15 秒后按"每24小时"策略后台检查谷歌 Stable 更新并自动下载
  setTimeout(() => { km.autoCheckIfDue().catch(() => {}); }, 15000);
});
app.on('window-all-closed', async () => {
  // 退出前关闭全部已打开的浏览器实例（触发关单/云同步后再退出）
  for (const r of launcher.listRunning()) {
    try { await stopOne(r.profileId); } catch {}
  }
  // 兜底：仍未落盘的运行日志（如关闭异常）全部保存
  for (const id of Array.from(RUN_LOGS.keys())) {
    flushRunLog(id, { type: 'warn', msg: '客户端退出，日志兜底保存' });
  }
  app.quit();
});

// ---------- 本地API服务 ----------
function startLocalApi() {
  try {
    const app2 = createLocalApi(store, { startOne, stopOne });
    localApiServer = app2.listen(store.get('localApiPort'), '127.0.0.1', () => {
      console.log(`[local-api] http://127.0.0.1:${store.get('localApiPort')}`);
    });
  } catch (e) {
    console.error('[local-api] 启动失败', e.message);
  }
}

// ---------- 工具 ----------
function loggedIn() {
  return !!store.get('token');
}
function syncApi() {
  api.setup(store.get('serverUrl'), store.get('token') || '');
}

// 创建/更新环境时带了合法代理 → 自动 upsert 到服务端 proxy_pool（失败不阻塞主流程）
async function autoSyncProxyToPool(p) {
  if (!p || !p.proxy_type || !p.proxy_host || !p.proxy_port) return;
  try {
    syncApi();
    await api.saveProxy({
      label: String(p.name || '').slice(0, 128),
      proxy_type: p.proxy_type,
      host: String(p.proxy_host).trim(),
      port: +p.proxy_port,
      username: p.proxy_username || null,
      password: p.proxy_password || null
    });
  } catch (e) { console.warn('[proxy-pool] 自动入池失败：', e.message); }
}
// ---------- 运行日志：每次环境运行的全量日志，关闭浏览器时自动落盘为文本 ----------
const RUN_LOGS = new Map(); // profileId -> { name, startedAt, lines:[] }

function runLogDir() {
  return path.join(app.getPath('userData'), 'run-logs');
}
function ts() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function fileTs(t) {
  const d = new Date(t);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|\r\n\t]/g, '_').slice(0, 60) || '未命名';
}
const LOG_TYPE_CN = {
  step: '步骤', geo: 'IP信息', 'geo-fail': 'IP检测失败',
  sync: '同步', 'sync-fail': '同步失败', running: '运行中',
  closed: '已关闭', error: '错误', warn: '警告'
};
function initRunLog(p) {
  const proxyText = p.proxy_type && p.proxy_host
    ? `${['', 'HTTP', 'HTTPS', 'SOCKS5'][p.proxy_type] || '?'}://${p.proxy_host}:${p.proxy_port}`
    : '直连（无代理）';
  RUN_LOGS.set(p.id, {
    name: p.name,
    startedAt: Date.now(),
    lines: [`========== 环境启动 ==========`,
      `环境ID：${p.id}`, `环境名称：${p.name}`, `代理：${proxyText}`,
      `固定IP校验：${p.fixed_ip || '未设置（不校验）'}`, `启动时间：${ts()}`, ``]
  });
}
function appendRunLog(profileId, type, msg) {
  const log = RUN_LOGS.get(profileId);
  if (!log) return;
  log.lines.push(`[${ts()}] [${LOG_TYPE_CN[type] || type || '信息'}] ${msg == null ? '' : msg}`);
}
// 关闭/失败时把本次运行日志写入文本（幂等，写完即清缓冲）
function flushRunLog(profileId, endNote) {
  const log = RUN_LOGS.get(profileId);
  if (!log) return null;
  try {
    if (endNote) log.lines.push(`[${ts()}] [${LOG_TYPE_CN[endNote.type] || '信息'}] ${endNote.msg}`);
    log.lines.push(``, `========== 运行结束 ${ts()} ==========`);
    const dir = runLogDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `环境${profileId}_${safeName(log.name)}_${fileTs(log.startedAt)}.log`);
    fs.writeFileSync(file, log.lines.join('\r\n'), 'utf8');
    RUN_LOGS.delete(profileId);
    return file;
  } catch (e) {
    console.warn('[run-log] 保存失败：', e.message);
    return null;
  }
}

// 向渲染进程推送实例事件（geo/关闭/云同步状态），同时写入该环境运行日志缓冲
function notifyEvent(profileId, type, msg) {
  if (profileId) appendRunLog(profileId, type, msg);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('instance-event', { profileId, type, msg });
  }
}

// ---------- IPC: 通用 ----------
ipcMain.handle('settings:get', () => {
  const d = { ...store.data };
  delete d.token;
  return d;
});
ipcMain.handle('settings:set', (e, patch) => {
  for (const [k, v] of Object.entries(patch)) store.set(k, v);
  syncApi();
  return true;
});
ipcMain.handle('app:version', () => app.getVersion());

// ---------- IPC: 公告 / 检查更新 / 自动更新 / 内核 ----------
const { execSync, spawn } = require('child_process');
const APP_DIR = path.join(__dirname, '..');

function cmpVer(a, b) {
  const pa = String(a || '0').split('.').map(Number);
  const pb = String(b || '0').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

function extractZip(zip, dest) {
  if (process.platform === 'darwin') {
    // macOS: 系统自带 tar(bsdtar) 原生支持 zip；失败再用 ditto
    try {
      execSync(`tar -xf "${zip}" -C "${dest}"`, { timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      execSync(`ditto -x -k "${zip}" "${dest}"`, { timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'] });
    }
    return;
  }
  const ps = `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dest}' -Force`;
  execSync(`powershell -NoProfile -Command "${ps.replace(/'/g, "''")}"`, { windowsHide: true, timeout: 300000 });
}

async function downloadTo(url, dest, onProgress) {
  const fetch = require('node-fetch');
  const res = await fetch(url);
  if (!res.ok) throw new Error('下载失败：HTTP ' + res.status);
  const total = Number(res.headers.get('content-length') || 0);
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(dest);
    let got = 0;
    res.body.on('data', c => {
      got += c.length;
      if (onProgress) { try { onProgress(total ? Math.round(got / total * 100) : -1); } catch {} }
    });
    res.body.pipe(ws).on('error', reject);
    ws.on('finish', () => ws.close(() => resolve(dest)));
    ws.on('error', reject);
  });
}

ipcMain.handle('announce:list', async () => {
  try { syncApi(); return await api.announcements(); } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('app:check-update', async () => {
  try {
    syncApi();
    const d = await api.appUpdate();
    if (!d.ok) return d;
    const current = app.getVersion();
    return { ok: true, current, info: d.info || {}, updateAvailable: cmpVer(d.info && d.info.version, current) > 0 };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('app:do-update', async (e, url) => {
  try {
    if (!url) return { ok: false, error: '更新包地址为空，请联系管理员在管理后台配置' };
    // macOS 暂不支持应用内热更新（包结构与权限模型不同），引导用户下载新版 dmg 手动安装
    if (process.platform === 'darwin') {
      return { ok: false, error: 'macOS 版请联系管理员获取最新 .dmg 安装包，拖入「应用程序」覆盖安装即可（环境数据不会丢失）' };
    }
    notifyEvent(0, 'update', '开始下载更新包…');
    const tmpZip = path.join(app.getPath('temp'), 'jindun-update-' + Date.now() + '.zip');
    await downloadTo(url, tmpZip, pct => notifyEvent(0, 'update', '更新包下载中 ' + (pct >= 0 ? pct + '%' : '…')));
    notifyEvent(0, 'update', '下载完成，正在解压…');
    const staging = path.join(APP_DIR, 'update_staging');
    fs.rmSync(staging, { recursive: true, force: true });
    extractZip(tmpZip, staging);
    fs.rmSync(tmpZip, { force: true });
    // 升级脚本：等本进程退出 → 覆盖程序目录 → 自动重启
    const bat = path.join(APP_DIR, 'update.bat');
    const pid = process.pid;
    fs.writeFileSync(bat, [
      '@echo off',
      'chcp 65001 >nul',
      ':wait',
      `tasklist /FI "PID eq ${pid}" | find "${pid}" >nul`,
      'if not errorlevel 1 ( timeout /t 1 /nobreak >nul & goto wait )',
      `xcopy /E /Y /I "${staging}\\*.*" "${APP_DIR}\\" >nul`,
      `rmdir /S /Q "${staging}"`,
      `cd /d "${APP_DIR}"`,
      `start "" "${path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe')}" "${APP_DIR}"`,
      'del "%~f0"'
    ].join('\r\n'));
    notifyEvent(0, 'update', '升级包已就绪，客户端即将自动重启完成更新…');
    const child = spawn('cmd.exe', ['/c', bat], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    setTimeout(() => app.exit(0), 1200);
    return { ok: true, msg: '客户端即将自动重启完成更新' };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('kernel:version', () => {
  try {
    // 优先多版本内核管理器的"自动/默认"内核，其次全局路径，最后系统Chrome
    let p = '';
    try { const r = km.resolveForFp({}, store.get('chromePath')); p = r.exe || ''; } catch {}
    if (!p) p = launcher.detectChrome();
    if (!p) return { ok: false, error: '未检测到内核（可在 设置→浏览器内核管理 中一键下载谷歌官方内核）' };
    const v = km.exeVersion(p);
    return { ok: true, path: p, version: v };
  } catch (err) { return { ok: false, error: err.message }; }
});

// ---------- 多版本 Chrome for Testing 内核管理 ----------
ipcMain.handle('kernel:state', async (e, withRemote) => {
  try { return { ok: true, state: await km.stateAsync(!!withRemote) }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('kernel:history', async () => {
  try { return { ok: true, versions: await km.fetchHistory(15) }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('kernel:install', async (e, payload) => {
  try {
    const r = await km.install((payload || {}).version, { channel: (payload || {}).channel, urlOfficial: (payload || {}).urlOfficial });
    return { ok: true, ...r };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('kernel:remove', async (e, version) => {
  try { await km.remove(version); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('kernel:config', async (e, patch) => {
  try { return { ok: true, state: km.setConfig(patch || {}) }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('kernel:check-update', async () => {
  try { const info = await km.autoCheckIfDue(true); return { ok: true, info }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('kernel:open-dir', () => {
  try {
    const d = km.root();
    fs.mkdirSync(d, { recursive: true });
    shell.openPath(d);
    return { ok: true, path: d };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('app:do-kernel-update', async (e, url) => {
  try {
    if (!url) return { ok: false, error: '内核下载地址为空，请联系管理员在管理后台配置' };
    notifyEvent(0, 'update', '开始下载内核包…');
    const tmpZip = path.join(app.getPath('temp'), 'jindun-kernel-' + Date.now() + '.zip');
    await downloadTo(url, tmpZip, pct => notifyEvent(0, 'update', '内核包下载中 ' + (pct >= 0 ? pct + '%' : '…')));
    notifyEvent(0, 'update', '下载完成，正在解压内核…');
    const dest = path.join(APP_DIR, 'chrome-kernel');
    fs.rmSync(dest, { recursive: true, force: true });
    extractZip(tmpZip, dest);
    fs.rmSync(tmpZip, { force: true });
    // 在解压目录中查找内核主程序（Windows: chrome/msedge.exe；macOS: .app 内的可执行文件）
    let found = '';
    const isMacOS = process.platform === 'darwin';
    const walk = (dir, depth) => {
      if (found || depth > 6) return;
      let ents = [];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const d of ents) {
        const fp2 = path.join(dir, d.name);
        if (d.isDirectory()) walk(fp2, depth + 1);
        else if (isMacOS) {
          if (d.name === 'Google Chrome for Testing' || d.name === 'Google Chrome' ||
              d.name === 'Microsoft Edge' || d.name === 'Chromium') {
            if (/\.app[\\/]Contents[\\/]MacOS[\\/]/.test(fp2)) { found = fp2; return; }
          }
        }
        else if (/^(chrome|msedge)\.exe$/i.test(d.name)) { found = fp2; return; }
      }
    };
    walk(dest, 0);
    if (!found) return { ok: false, error: '解压完成，但未在压缩包中找到浏览器内核可执行文件' };
    store.set('chromePath', found);
    notifyEvent(0, 'update', '内核已更新：' + found + '（已设为默认内核）');
    return { ok: true, path: found };
  } catch (err) { return { ok: false, error: err.message }; }
});

// ---------- IPC: 登录/注册（未登录不可使用浏览器功能） ----------
ipcMain.handle('auth:login', async (e, { username, password }) => {
  try {
    syncApi();
    const d = await api.login(username, password, (process.platform === 'darwin' ? 'mac-client:' : 'win-client:') + require('os').hostname());
    if (!d.ok) return d;
    store.set('token', d.token);
    store.set('user', d.user);
    syncApi();
    return d;
  } catch (err) {
    return { ok: false, error: '无法连接服务器，请检查服务端地址与网络' };
  }
});
ipcMain.handle('auth:register', async (e, { username, password, email, security_question, security_answer }) => {
  try {
    syncApi();
    return await api.register(username, password, email, security_question, security_answer);
  } catch { return { ok: false, error: '无法连接服务器' }; }
});
ipcMain.handle('auth:me', async () => {
  if (!loggedIn()) return { ok: false, error: '未登录' };
  try {
    syncApi();
    return await api.me();
  } catch (err) {
    return { ok: false, offline: true, error: err.code === 401 ? '登录已过期' : '离线：无法连接服务器' };
  }
});
ipcMain.handle('auth:logout', async () => {
  await api.logout();
  store.set('token', '');
  store.set('user', null);
  return { ok: true };
});
ipcMain.handle('auth:set-security', async (e, { question, answer }) => {
  try { syncApi(); return await api.setSecurity(question, answer); }
  catch (err) { return { ok: false, error: err.code === 401 ? '登录已过期' : err.message }; }
});
ipcMain.handle('auth:change-password', async (e, { current, next }) => {
  try { syncApi(); return await api.changePassword(current, next); }
  catch (err) { return { ok: false, error: err.code === 401 ? '登录已过期' : err.message }; }
});
ipcMain.handle('auth:forgot-password', async (e, { username, question, answer, next }) => {
  try { syncApi(); return await api.forgotPassword(username, question, answer, next); }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('auth:security-question', async (e, username) => {
  try {
    syncApi();
    // 这个接口不需要 token；直接请求（server.req 会自动拼 Authorization 头，跳过）
    const fetch = require('node-fetch');
    const base = (store.get('serverUrl') || '').replace(/\/$/, '');
    if (!base) return { ok: false, error: '请先在设置里配置服务端地址' };
    const r = await fetch(`${base}/api/auth/security-question?username=${encodeURIComponent(username)}`);
    return await r.json();
  } catch (err) { return { ok: false, error: err.message }; }
});

// ---------- IPC: Profile 管理 ----------
ipcMain.handle('profiles:list', async (e, trash) => {
  syncApi();
  try { return await api.listProfiles(trash ? 1 : 0); }
  catch (err) { return { ok: false, offline: true, error: '离线：无法获取环境列表（本地已打开的窗口可继续运行）' }; }
});
ipcMain.handle('profiles:create', async (e, p) => {
  try {
    syncApi();
    const r = await api.createProfile(p);
    if (r.ok) autoSyncProxyToPool(p);
    return r;
  } catch (err) { return { ok: false, error: err.code === 401 ? '登录已过期' : '离线：无法创建，需连接服务器校验配额' }; }
});
ipcMain.handle('profiles:update', async (e, { id, patch }) => {
  try {
    const r = await api.updateProfile(id, patch);
    if (r.ok) autoSyncProxyToPool(patch);
    return r;
  } catch (err) { return { ok: false, error: '更新失败：' + err.message }; }
});
ipcMain.handle('profiles:delete', async (e, id) => { try { return await api.deleteProfile(id); } catch { return { ok: false, error: '离线' }; } });
ipcMain.handle('profiles:restore', async (e, id) => { try { return await api.restoreProfile(id); } catch { return { ok: false, error: '离线' }; } });
ipcMain.handle('profiles:purge', async (e, id) => { try { return await api.purgeProfile(id); } catch { return { ok: false, error: '离线' }; } });
ipcMain.handle('profiles:clone', async (e, id) => { try { return await api.cloneProfile(id); } catch (err) { return { ok: false, error: err.message }; } });

// ---------- 代理池 IPC ----------
ipcMain.handle('proxies:list', async () => {
  try { syncApi(); return await api.listProxies(); } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('proxies:save', async (e, p) => {
  try { syncApi(); return await api.saveProxy(p); } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('proxies:saveBatch', async (e, items) => {
  try { syncApi(); return await api.saveProxies(items); } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('proxies:delete', async (e, id) => {
  try { syncApi(); return await api.deleteProxy(id); } catch (err) { return { ok: false, error: err.message }; }
});

// ---------- IPC: 管理员操作（Express 侧 adminOnly 中间件会二次校验角色） ----------
ipcMain.handle('admin:list-users', async () => {
  try { syncApi(); return await api.adminListUsers(); } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('admin:reset-password', async (e, id) => {
  try { syncApi(); return await api.adminResetUserPassword(id); } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('admin:toggle-freeze', async (e, id, frozen) => {
  try { syncApi(); return await api.adminToggleFreeze(id, frozen); } catch (err) { return { ok: false, error: err.message }; }
});

// ---------- IPC: 环境Cookie 导入/编辑/导出（存本地数据目录 cookies.json，启动时CDP注入） ----------
function cookieFile(profileId) {
  return path.join(store.profileDir(profileId), 'cookies.json');
}
function parseCookieArray(raw) {
  let arr;
  try { arr = JSON.parse(raw); } catch (err) { return { error: 'JSON格式错误：' + err.message }; }
  if (!Array.isArray(arr)) return { error: '内容必须是Cookie数组（[]）' };
  for (const c of arr) {
    if (!c || typeof c !== 'object' || (!c.name && c.name !== '')) return { error: '存在缺少 name 字段的Cookie' };
    if (!c.domain && !c.url) return { error: `Cookie「${c.name || '?'}」缺少 domain 字段` };
  }
  return { arr };
}
ipcMain.handle('cookie:load', async (e, profileId) => {
  try {
    const f = cookieFile(profileId);
    if (!fs.existsSync(f)) return { ok: true, cookies: [] };
    const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
    return { ok: true, cookies: Array.isArray(arr) ? arr : [] };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('cookie:save', async (e, { profileId, cookies }) => {
  try {
    const r = parseCookieArray(cookies || '[]');
    if (r.error) return { ok: false, error: r.error };
    fs.writeFileSync(cookieFile(profileId), JSON.stringify(r.arr, null, 2));
    return { ok: true, count: r.arr.length };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('cookie:importFile', async (e, profileId) => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: '导入Cookie文件（JSON数组，兼容EditThisCookie导出格式）',
      filters: [{ name: 'JSON/TXT', extensions: ['json', 'txt'] }], properties: ['openFile']
    });
    if (canceled || !filePaths.length) return { ok: false, canceled: true };
    const r = parseCookieArray(fs.readFileSync(filePaths[0], 'utf8'));
    if (r.error) return { ok: false, error: r.error };
    fs.writeFileSync(cookieFile(profileId), JSON.stringify(r.arr, null, 2));
    return { ok: true, count: r.arr.length };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('cookie:exportFile', async (e, profileId) => {
  try {
    const f = cookieFile(profileId);
    if (!fs.existsSync(f)) return { ok: false, error: '该环境暂无已保存的Cookie' };
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: '导出Cookie', defaultPath: `cookies-env${profileId}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    fs.copyFileSync(f, filePath);
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

// CDP 读取运行中浏览器的实时 Cookie（用户登录后网站下发的真实 Cookie 存于 Chrome
// 加密的 Network/Cookies 库，不会出现在手动导入的 cookies.json 里；运行时经 CDP 直接取明文）
function cdpCookiesToEditable(list) {
  return (list || []).map(c => {
    const out = {
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      hostOnly: !!c.hostOnly
    };
    // 会话 Cookie 不带 expirationDate；持久化 Cookie 用秒级 expires
    if (!c.session && Number.isFinite(c.expires) && c.expires > 0) out.expirationDate = c.expires;
    if (c.sameSite && /^(Strict|Lax|None)$/.test(c.sameSite)) out.sameSite = c.sameSite;
    return out;
  }).sort((a, b) => (a.domain === b.domain ? a.name.localeCompare(b.name) : a.domain.localeCompare(b.domain)));
}
ipcMain.handle('cookie:readLive', async (e, profileId) => {
  try {
    const inst = launcher.getRunning(profileId);
    if (!inst || !inst.browser) return { ok: false, error: 'NOT_RUNNING' };
    // 复用启动器的读取链：浏览器级 Storage.getCookies，失败回退页面级 Network.getAllCookies
    // （Network.getAllCookies 在浏览器级会话上不存在，旧回退实现必然失败）
    const cookies = await launcher.fetchAllCookies(inst.browser);
    return { ok: true, cookies: cdpCookiesToEditable(cookies) };
  } catch (err) { return { ok: false, error: err.message }; }
});

// 打开环境的本地数据目录 / 独立下载目录
ipcMain.handle('profile:open-dir', async (e, { id, sub } = {}) => {
  try {
    if (!id) return { ok: false, error: '缺少环境ID' };
    const dir = sub === 'downloads' ? store.downloadsDir(id) : store.profileDir(id);
    const errMsg = await shell.openPath(dir);
    if (errMsg) return { ok: false, error: errMsg };
    return { ok: true, path: dir };
  } catch (err) { return { ok: false, error: err.message }; }
});

// 导出（元数据JSON，不含cookie缓存）
ipcMain.handle('profiles:export', async (e, ids) => {
  try {
    syncApi();
    const d = await api.listProfiles(0);
    const list = d.list.filter(p => !ids || ids.length === 0 || ids.includes(p.id));
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: '导出环境配置', defaultPath: 'jindun-profiles.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    fs.writeFileSync(filePath, JSON.stringify(list, null, 2));
    return { ok: true, count: list.length };
  } catch (err) { return { ok: false, error: err.message }; }
});

// 导入
ipcMain.handle('profiles:import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: '导入环境配置', filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile']
  });
  if (!canceled && filePaths.length) {
    try {
      const items = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
      syncApi();
      return await api.importProfiles(Array.isArray(items) ? items : [items]);
    } catch (err) { return { ok: false, error: '导入失败: ' + err.message }; }
  }
  return { ok: false, canceled: true };
});

// ---------- 实例生命周期：启动（含云同步拉取）/ 停止（含加密上传） ----------
const PROFILE_CACHE = new Map();      // profileId -> profile元数据（含standalone）
const lastCloseHandled = new Map();   // 关闭事件去重（8秒窗口，disconnected与手动stop只处理一次）

// 云端拉取并解密应用Cookie/缓存（单机模式跳过；失败不阻塞启动，用本地数据）
async function pullCloudData(p) {
  if (p.standalone) {
    notifyEvent(p.id, 'sync', '单机模式：Cookie/缓存仅存本机，不上传不共享');
    return;
  }
  try {
    const d = await api.getSync(p.id);
    if (!d.ok) throw new Error(d.error || '获取密钥失败');
    if (d.standalone || !d.data) return;
    const manifest = cookieSync.decryptSnapshot(d.key, d.data);
    cookieSync.applySnapshot(store.profileDir(p.id), manifest);
    notifyEvent(p.id, 'sync', '已从云端拉取AES-256加密Cookie/缓存并解密应用');
  } catch (e) {
    notifyEvent(p.id, 'sync-fail', '云端数据拉取失败，使用本地数据：' + e.message);
  }
}

// 收集本地Cookie/缓存 → AES-256加密 → 上传云端（单机模式跳过）
async function pushCloudData(p) {
  if (p.standalone) {
    notifyEvent(p.id, 'sync', '单机模式：数据仅保存在本地');
    return;
  }
  const dir = store.profileDir(p.id);
  const manifest = cookieSync.collectSnapshot(dir);
  if (!manifest.files.length) return;
  const d = await api.getSync(p.id);
  if (!d.ok) throw new Error(d.error || '获取加密密钥失败');
  if (d.standalone) return;
  const payload = cookieSync.encryptSnapshot(d.key, manifest);
  const r = await api.putSync(p.id, payload);
  if (!r.ok) throw new Error(r.error || '上传失败');
  notifyEvent(p.id, 'sync', 'Cookie/缓存已AES-256加密上传云端（成员下次启动自动拉取）');
}

async function startOne(p) {
  PROFILE_CACHE.set(p.id, p);
  initRunLog(p);
  try {
  // 1) 服务端配额校验 + 团队共享环境单点在线锁（全部由服务端判断，浏览器未启动前拦截）
  const chk = await api.checkQuota('open', p.id);
  if (!chk.ok || !chk.allowed) throw new Error(chk.error || '配额校验未通过');
  // 2) 云同步拉取（非单机模式）
  await pullCloudData(p);
  // 3) 启动（内部先做出口IP/时区强检，失败返回ok:false，浏览器不会打开）
  const r = await launcher.launchProfile(p, {
    chromePath: store.get('chromePath'),
    autoGeoMatch: store.get('autoGeoMatch')
  }, store, (type, payload) => {
    if (type === 'closed') handleBrowserClosed(p.id);
    else notifyEvent(p.id, type, payload);
  });
  if (!r.ok) throw new Error(r.error || '启动失败');
  // SOCKS5握手失败但HTTP可达：已按HTTP协议启动，自动修正环境代理类型
  if (r.proxyAdapted) {
    notifyEvent(p.id, 'sync', 'SOCKS5握手失败，已自动按HTTP协议连接，代理类型已修正为HTTP');
    await api.updateProfile(p.id, { proxy_type: 1 }).catch(() => {});
    p.proxy_type = 1;
    PROFILE_CACHE.set(p.id, p);
  }
  // 时区/经纬度已跟随出口IP自动更新：回写服务端，下次启动即用新值
  if (r.fpChanged && r.fp) {
    await api.updateProfile(p.id, { fingerprint_config: r.fp }).catch(() => {});
    p.fingerprint_config = r.fp;
    PROFILE_CACHE.set(p.id, p);
  }
  // 4) 记录打开事件（并发抢占到单点锁失败：浏览器已开也立即关闭，提示被占用）
  const ro = await api.recordOpen(p.id).catch(e => ({ ok: false, error: e.message }));
  if (!ro || ro.ok === false) {
    try { await launcher.closeProfile(p.id); } catch {}
    throw new Error(ro.error || '该环境正被其他成员使用中（团队共享环境同一时间仅允许一人在线）');
  }
  // 5) 同步本地数据路径信息（仅元数据）
  await api.updateProfile(p.id, { data_path: store.profileDir(p.id) }).catch(() => {});
  // 6) 通知渲染层：环境已启动（供外部API启动时前端状态实时刷新）
  notifyEvent(p.id, 'running', '');
  return r;
  } catch (err) {
    // 启动失败（含固定IP不匹配/配额拦截等）：同样保存本次运行日志
    const f = flushRunLog(p.id, { type: 'error', msg: '启动失败/已中止：' + (err.message || err) });
    if (f) console.log('[run-log] 失败日志已保存：' + f);
    throw err;
  }
}

// 浏览器关闭（手动停止或用户直接关窗口）统一入口：关单 + 加密上传 + 通知渲染层刷新状态
async function handleBrowserClosed(profileId) {
  const now = Date.now();
  if (now - (lastCloseHandled.get(profileId) || 0) < 8000) return;
  lastCloseHandled.set(profileId, now);
  try {
    if (loggedIn()) {
      syncApi();
      await api.recordClose(profileId).catch(() => {});
      const meta = PROFILE_CACHE.get(profileId);
      if (meta) {
        try { await pushCloudData(meta); }
        catch (e) { notifyEvent(profileId, 'sync-fail', '云端同步失败：' + e.message); }
      }
    }
  } finally {
    // 浏览器已关闭：把本次运行的全部日志自动保存为文本文件
    const f = flushRunLog(profileId, { type: 'closed', msg: '浏览器已关闭' });
    if (f) console.log('[run-log] 运行日志已保存：' + f);
    notifyEvent(profileId, 'closed', '');
  }
}

async function stopOne(profileId) {
  const r = await launcher.closeProfile(profileId);
  await handleBrowserClosed(profileId);
  return r;
}

ipcMain.handle('instance:start', async (e, profileId) => {
  if (!loggedIn()) return { ok: false, error: '未登录，无法启动浏览器' };
  try {
    syncApi();
    const d = await api.listProfiles(0);
    const p = d.list.find(x => x.id === profileId);
    if (!p) return { ok: false, error: '环境不存在' };
    return await startOne(p);
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('instance:batchStart', async (e, ids) => {
  if (!loggedIn()) return { ok: false, error: '未登录' };
  syncApi();
  const results = [];
  try {
    const d = await api.listProfiles(0);
    for (const id of ids) {
      const p = d.list.find(x => x.id === id);
      if (!p) { results.push({ id, ok: false, error: '不存在' }); continue; }
      try {
        const r = await startOne(p);
        results.push({ id, ok: true, ws: r.wsEndpoint });
      } catch (err) { results.push({ id, ok: false, error: err.message }); }
    }
    return { ok: true, results };
  } catch (err) { return { ok: false, error: err.message, results }; }
});

ipcMain.handle('instance:stop', async (e, profileId) => stopOne(profileId));
ipcMain.handle('instance:batchStop', async (e, ids) => {
  for (const id of ids) { try { await stopOne(id); } catch {} }
  return { ok: true };
});
ipcMain.handle('instance:running', () => launcher.listRunning());

// ---------- 运行日志文件 ----------
ipcMain.handle('logs:open-dir', async (e, profileId) => {
  const dir = runLogDir();
  fs.mkdirSync(dir, { recursive: true });
  await shell.openPath(dir);
  return dir;
});
ipcMain.handle('logs:list', async (e, profileId) => {
  const dir = runLogDir();
  try {
    let files = fs.readdirSync(dir).filter(f => f.endsWith('.log'));
    if (profileId) files = files.filter(f => f.startsWith(`环境${profileId}_`));
    return files.map(f => {
      const st = fs.statSync(path.join(dir, f));
      return { file: f, size: st.size, mtime: st.mtime.toISOString() };
    }).sort((a, b) => b.mtime.localeCompare(a.mtime));
  } catch { return []; }
});
ipcMain.handle('logs:open-file', async (e, file) => {
  // 只允许打开日志目录内的文件，防路径穿越
  const dir = runLogDir();
  const full = path.join(dir, path.basename(file));
  if (!full.startsWith(dir) || !fs.existsSync(full)) return false;
  await shell.openPath(full);
  return true;
});

// ---------- IPC: 代理测试 ----------
ipcMain.handle('proxy:test', async (e, proxy) => {
  try {
    const { geoLookupAdaptive } = launcher;
    const probe = await geoLookupAdaptive(proxy || {});
    const geo = probe.geo;
    return {
      ok: true, ip: geo.query, country: geo.country, countryCode: geo.countryCode,
      timezone: geo.timezone, lat: geo.lat, lon: geo.lon, adapted: probe.adapted
    };
  } catch (err) { return { ok: false, error: err.message }; }
});

// ---------- IPC: 套餐与订单 ----------
ipcMain.handle('plans:list', async () => { try { syncApi(); return await api.plans(); } catch (e) { return { ok: false, error: '离线：无法获取套餐' }; } });
ipcMain.handle('orders:mine', async () => { try { return await api.myOrders(); } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('orders:create', async (e, planId) => { try { return await api.createOrder(planId); } catch (err) { return { ok: false, error: err.message }; } });
ipcMain.handle('orders:pay', async (e, id) => { try { const d = await api.payOrder(id); return d; } catch (err) { return { ok: false, error: err.message }; } });

// ---------- IPC: 团队 ----------
ipcMain.handle('team:info', async () => { try { syncApi(); return await api.teamInfo(); } catch (e) { return { ok: false, error: '离线：无法获取团队信息' }; } });
ipcMain.handle('team:create', async (e, name) => { try { return await api.createTeam(name); } catch (err) { return { ok: false, error: err.message }; } });
ipcMain.handle('team:join', async (e, code) => { try { return await api.joinTeam(code); } catch (err) { return { ok: false, error: err.message }; } });
ipcMain.handle('team:leave', async () => { try { return await api.leaveTeam(); } catch (err) { return { ok: false, error: err.message }; } });
ipcMain.handle('team:disband', async () => { try { return await api.disbandTeam(); } catch (err) { return { ok: false, error: err.message }; } });
ipcMain.handle('team:rotate', async () => { try { return await api.rotateTeamCode(); } catch (err) { return { ok: false, error: err.message }; } });
ipcMain.handle('team:remove', async (e, uid) => { try { return await api.removeMember(uid); } catch (err) { return { ok: false, error: err.message }; } });
ipcMain.handle('team:switch', async (e, teamId) => { try { return await api.switchTeam(teamId); } catch (err) { return { ok: false, error: err.message }; } });
ipcMain.handle('team:grant-clone', async (e, a) => { try { return await api.grantClone(a.uid, a.allow); } catch (err) { return { ok: false, error: err.message }; } });
ipcMain.handle('team:grants', async (e, pid) => { try { return await api.getGrants(pid); } catch (err) { return { ok: false, error: err.message }; } });
ipcMain.handle('team:set-grants', async (e, a) => { try { return await api.setGrants(a.pid, a.userIds); } catch (err) { return { ok: false, error: err.message }; } });

// ---------- IPC: 模板 ----------
ipcMain.handle('templates:list', () => store.get('templates') || []);
ipcMain.handle('templates:save', (e, tpl) => {
  const list = store.get('templates') || [];
  const i = list.findIndex(t => t.id === tpl.id);
  if (i >= 0) list[i] = tpl; else list.push(tpl);
  store.set('templates', list);
  return true;
});
ipcMain.handle('templates:delete', (e, id) => {
  store.set('templates', (store.get('templates') || []).filter(t => t.id !== id));
  return true;
});

// ---------- IPC: 其他 ----------
ipcMain.handle('shell:openPath', (e, p) => shell.openPath(p));
ipcMain.handle('dialog:pickFolder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return canceled ? '' : filePaths[0];
});
ipcMain.handle('dialog:pickExts', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: '选择扩展目录（manifest.json所在文件夹，可多选）', properties: ['openDirectory', 'multiSelections']
  });
  return canceled ? [] : filePaths;
});
ipcMain.handle('detectChrome', () => launcher.detectChrome());
