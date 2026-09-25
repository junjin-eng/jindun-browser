// 槿盾浏览器 渲染进程逻辑
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
let PROFILES = [];
let RUNNING = new Map();
let TRASH = false;
let EDIT_ID = null; // null=新建
let HIDDEN_IDS = new Set(); // 本机隐藏的环境ID（个人视图偏好，存本地设置）
let SHOW_HIDDEN = false;    // 是否显示已隐藏环境

function log(msg) {
  const v = $('#log-view');
  if (v) v.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`;
}
function toast(msg, ok = true) {
  const el = document.createElement('div');
  el.style.cssText = `position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:9999;
    padding:10px 18px;border-radius:8px;color:#fff;background:${ok ? '#2f9e62' : '#e5484d'};font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.2)`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

/* ================= 登录/注册 ================= */
let regMode = false;
$('#seg-login').onclick = () => switchAuth(false);
$('#seg-register').onclick = () => switchAuth(true);
function switchAuth(reg) {
  regMode = reg;
  $('#seg-login').classList.toggle('active', !reg);
  $('#seg-register').classList.toggle('active', reg);
  $('#lg-email').classList.toggle('hidden', !reg);
  $('#lg-sec').classList.toggle('hidden', !reg);
  $('#lg-btn').textContent = reg ? '注 册' : '登 录';
  $('#lg-msg').textContent = '';
}
$('#lg-btn').onclick = async () => {
  const u = $('#lg-user').value.trim(), p = $('#lg-pass').value;
  if (!u || !p) return $('#lg-msg').textContent = '请输入用户名和密码';
  $('#lg-btn').disabled = true;
  const d = regMode ? await window.jd.register(u, p, $('#lg-email').value.trim(), $('#lg-q').value.trim(), $('#lg-a').value) : await window.jd.login(u, p);
  $('#lg-btn').disabled = false;
  if (!d.ok) return $('#lg-msg').textContent = d.error || '操作失败';
  if (regMode) {
    $('#lg-msg').style.color = '#2f9e62';
    $('#lg-msg').textContent = '注册成功，请登录';
    switchAuth(false);
    return;
  }
  await enterApp();
};

/* ================= 主界面 ================= */
let MY_ID = null;
window.__allowClone = true;
async function enterApp() {
  $('#view-login').classList.add('hidden');
  $('#view-app').classList.remove('hidden');
  await refreshMe();
  await refreshProfiles();
  await refreshTemplates();
  await loadSettings();
  loadKernelState(false);
  await loadAnnouncements();
  window.jd.appVersion().then(v => { $('#upd-cur').textContent = v || ''; }).catch(() => {});
  const st = await window.jd.settingsGet();
  $('#doc-base').textContent = `http://127.0.0.1:${st.localApiPort}`;
}

$('#btn-logout').onclick = async () => {
  await window.jd.logout();
  location.reload();
};

async function refreshMe() {
  const d = await window.jd.me();
  if (!d.ok) {
    if (d.offline) { toast(d.error, false); }
    else { $('#view-app').classList.add('hidden'); $('#view-login').classList.remove('hidden'); return; }
  }
  if (d.ok) {
    MY_ID = d.user.id;
    GL.meRole = d.user.role || 0;
    $('#nav-admin').classList.toggle('hidden', GL.meRole !== 1);
    $('#q-user').textContent = d.user.username;
    $('#sec-user').textContent = d.user.username;
    $('#sec-q-current').textContent = d.user.security_question ? d.user.security_question : '（尚未设置）';
    const q = d.quota || {};
    $('#q-profiles').textContent = `${d.used.profiles}/${q.max_profiles ?? '-'}`;
    $('#q-opens').textContent = `${d.used.todayOpens}/${q.daily_open_limit ?? '-'}`;
    $('#q-conc').textContent = q.max_concurrent ?? '-';
    $('#q-exp').textContent = q.plan_expire_time ? q.plan_expire_time.slice(0, 10) : '免费版';
  }
}

/* ---- Tab ---- */
$$('.sidebar nav a').forEach(a => a.onclick = () => {
  $$('.sidebar nav a').forEach(x => x.classList.remove('active'));
  a.classList.add('active');
  $$('.tab').forEach(t => t.classList.add('hidden'));
  $('#tab-' + a.dataset.tab).classList.remove('hidden');
  if (a.dataset.tab === 'team') loadTeam();
  if (a.dataset.tab === 'plans') loadPlans();
  if (a.dataset.tab === 'settings') loadKernelState(false);
  if (a.dataset.tab === 'proxy') refreshProxies();
  if (a.dataset.tab === 'tpl') refreshTemplates();
  if (a.dataset.tab === 'admin') loadAdminUsers();
});

/* ================= 环境列表 ================= */
async function refreshProfiles() {
  const d = await window.jd.listProfiles(TRASH);
  PROFILES = d.ok ? d.list : [];
  if (!d.ok) toast(d.error, false);
  try {
    const st = await window.jd.settingsGet();
    HIDDEN_IDS = new Set(st.hiddenProfiles || []);
  } catch {}
  RUNNING = new Map((await window.jd.runningInstances()).map(r => [r.profileId, r]));
  renderProfiles();
}

function renderProfiles() {
  const kw = ($('#search').value || '').toLowerCase();
  let list = PROFILES.filter(p => {
    if (!SHOW_HIDDEN && !TRASH && HIDDEN_IDS.has(p.id)) return false; // 隐藏的环境默认不显示
    if (!kw) return true;
    const tags = JSON.parse(p.tags || '[]').join(',');
    return p.name.toLowerCase().includes(kw) || tags.toLowerCase().includes(kw);
  });
  $('#tb-profiles tbody').innerHTML = list.map(p => {
    const run = RUNNING.has(p.id);
    const hidden = HIDDEN_IDS.has(p.id) && !TRASH;
    const tags = JSON.parse(p.tags || '[]').join(', ');
    const proxy = p.proxy_type ? `${['', 'HTTP', 'HTTPS', 'SOCKS5'][p.proxy_type]}://${p.proxy_host}:${p.proxy_port}` : '-';
    const fixedIpTag = p.fixed_ip ? ` <span class="tag-share" title="固定出口IP: ${esc(p.fixed_ip)}">🔒${esc(p.fixed_ip)}</span>` : '';
    const mine = p.is_mine === undefined ? true : (p.is_mine === 1 || p.is_mine === true);
    const owner = mine ? '本人' : (p.owner_name || '团队');
    const share = (p.team_shared ? '<span class="tag-share">团队共享</span>' : '<span class="tag-private">私有</span>')
      + (hidden ? ' <span class="tag-private">已隐藏</span>' : '');
    // 操作列：主按钮（打开/停止）+ ⋮ 更多菜单（编辑/克隆/Cookie/隐藏/删除收纳其中）
    let mainBtn;
    if (TRASH) {
      mainBtn = `<button class="btn small" onclick="restoreP(${p.id})">恢复</button>
        <button class="btn small danger" onclick="purgeP(${p.id})">彻底删除</button>`;
    } else if (run) {
      mainBtn = `<button class="btn small" onclick="stopP(${p.id})">停止</button>
        <button class="btn small btn-more" onclick="openRowMenu(event, ${p.id})" title="更多操作">⋮</button>`;
    } else {
      mainBtn = `<button class="btn small primary" onclick="startP(${p.id})">打开</button>
        <button class="btn small btn-more" onclick="openRowMenu(event, ${p.id})" title="更多操作">⋮</button>`;
    }
    return `<tr class="${hidden ? 'row-hidden' : ''}">
      <td><input type="checkbox" class="ck" value="${p.id}"></td>
      <td>${p.id}</td>
      <td>${esc(p.name)}</td>
      <td>${esc(owner)}</td>
      <td>${esc(tags) || '-'}</td>
      <td>${esc(proxy)}${fixedIpTag}</td>
      <td>${share}</td>
      <td class="${run ? 'tag-run' : 'tag-off'}">${run ? '运行中' : (TRASH ? '回收站' : (hidden ? '已隐藏' : '已停止'))}</td>
      <td>${p.last_open_at ? String(p.last_open_at).slice(0, 19).replace('T', ' ') : '从未'}</td>
      <td>${mainBtn}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="10">${TRASH ? '回收站为空' : (SHOW_HIDDEN ? '暂无环境' : '暂无环境（可点「显示已隐藏」查看隐藏项）')}</td></tr>`;
}

/* ---- 行操作 ⋮ 菜单 ---- */
function closeRowMenu() { const m = $('#row-menu'); if (m) m.classList.add('hidden'); }
document.addEventListener('click', closeRowMenu);
window.openRowMenu = (ev, id) => {
  ev.stopPropagation();
  const p = PROFILES.find(x => x.id === id);
  if (!p) return;
  const mine = p.is_mine === undefined ? true : (p.is_mine === 1 || p.is_mine === true);
  const hidden = HIDDEN_IDS.has(id);
  const items = [];
  if (mine) items.push(['✏️ 编辑环境', () => editP(id)]);
  if (mine || window.__allowClone) items.push([mine ? '📋 克隆' : '📋 克隆为私有', () => cloneP(id)]);
  if (mine) items.push(['🍪 Cookie 导入/编辑', () => openCookieDlg(id)]);
  items.push(['📂 环境数据目录', () => openProfileDir(id, 'data')]);
  items.push(['⬇️ 下载文件目录', () => openProfileDir(id, 'downloads')]);
  items.push(['📄 运行日志', () => viewLogs(id)]);
  items.push([hidden ? '👁 取消隐藏' : '🚫 隐藏环境', () => toggleHide(id)]);
  if (mine) items.push(['🗑 删除', () => delP(id), true]);
  const menu = $('#row-menu');
  menu.innerHTML = items.map((it, i) =>
    `<button class="${it[2] ? 'danger' : ''}" data-mi="${i}">${esc(it[0])}</button>`).join('');
  menu.querySelectorAll('button').forEach((b, i) => { b.onclick = (e) => { e.stopPropagation(); closeRowMenu(); items[i][1](); }; });
  const r = ev.target.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(r.left - 120, window.innerWidth - 170)) + 'px';
  menu.style.top = (r.bottom + 6) + 'px';
  menu.classList.remove('hidden');
};

// 打开环境本地目录（data=数据根目录，downloads=独立下载目录）
window.openProfileDir = async (id, kind) => {
  const d = await window.jd.openProfileDir(id, kind === 'downloads' ? 'downloads' : undefined);
  if (!d.ok) toast(d.error || '打开失败', false);
  else toast(kind === 'downloads' ? '已打开该环境的下载目录' : '已打开该环境的数据目录');
};

// 隐藏/取消隐藏（本机视图偏好，存本地设置，不影响他人与服务端数据）
window.toggleHide = async (id) => {
  const st = await window.jd.settingsGet();
  const arr = st.hiddenProfiles || [];
  const i = arr.indexOf(id);
  if (i >= 0) { arr.splice(i, 1); toast('已取消隐藏'); }
  else { arr.push(id); toast('环境已隐藏（可点「显示已隐藏」查看）'); }
  await window.jd.settingsSet({ hiddenProfiles: arr });
  HIDDEN_IDS = new Set(arr);
  renderProfiles();
};
$('#btn-hidden').onclick = () => {
  SHOW_HIDDEN = !SHOW_HIDDEN;
  $('#btn-hidden').textContent = SHOW_HIDDEN ? '隐藏已隐藏项' : '显示已隐藏';
  $('#btn-hidden').classList.toggle('primary', SHOW_HIDDEN);
  renderProfiles();
};

/* ---- 运行日志（每次关闭浏览器自动保存为文本） ---- */
let LOGS_PID = null;
window.viewLogs = async (id) => {
  LOGS_PID = id;
  const dlg = $('#dlg-logs');
  await renderLogsList();
  dlg.showModal();
};
async function renderLogsList() {
  const list = await window.jd.listLogs(LOGS_PID);
  $('#logs-tb').innerHTML = list.length
    ? list.map(f => `<tr>
        <td>${esc(f.file)}</td>
        <td style="white-space:nowrap">${(f.size / 1024).toFixed(1)} KB</td>
        <td style="white-space:nowrap">${esc(f.mtime.replace('T', ' ').slice(0, 19))}</td>
        <td><button class="btn small">打开</button></td>
      </tr>`).join('')
    : '<tr><td colspan="4" style="text-align:center;color:#888">暂无运行日志。启动并关闭一次环境后会自动生成。</td></tr>';
  $('#logs-tb').querySelectorAll('button').forEach((b, i) => {
    b.onclick = () => window.jd.openLogFile(list[i].file);
  });
}
window.openLogsDirAll = () => window.jd.openLogsDir();
$('#logs-refresh').onclick = renderLogsList;
$('#logs-folder').onclick = () => window.jd.openLogsDir(LOGS_PID);
$('#logs-x').onclick = () => $('#dlg-logs').close();
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

$('#search').oninput = renderProfiles;
$('#ck-all').onchange = () => $$('.ck').forEach(c => c.checked = $('#ck-all').checked);
function selectedIds() { return $$('.ck').filter(c => c.checked).map(c => +c.value); }

$('#btn-trash').onclick = () => { TRASH = !TRASH; $('#btn-trash').textContent = TRASH ? '返回列表' : '回收站'; refreshProfiles(); };
$('#btn-new').onclick = () => openProfileDlg(null);
window.editP = (id) => openProfileDlg(PROFILES.find(p => p.id === id));
window.cloneP = async (id) => {
  const d = await window.jd.cloneProfile(id);
  if (d.ok) { toast('克隆成功'); refreshProfiles(); } else toast(d.error, false);
};
window.delP = async (id) => {
  if (!confirm('删除该环境？数据将进入回收站')) return;
  const d = await window.jd.deleteProfile(id);
  if (d.ok) refreshProfiles(); else toast(d.error, false);
};
window.restoreP = async (id) => {
  const d = await window.jd.restoreProfile(id);
  if (d.ok) refreshProfiles(); else toast(d.error, false);
};
window.purgeP = async (id) => {
  if (!confirm('彻底删除该环境？本地数据目录需手动清理')) return;
  const d = await window.jd.purgeProfile(id);
  if (d.ok) refreshProfiles(); else toast(d.error, false);
};

async function startP(id) {
  const d = await window.jd.startInstance(id);
  if (d.ok) { toast('启动成功' + (d.geo ? ' · ' + d.geo : '')); log('启动环境 #' + id); }
  else { toast(d.error, false); log('启动失败 #' + id + ' ' + d.error); }
  refreshProfiles();
}
window.startP = startP;
window.stopP = async (id) => {
  const d = await window.jd.stopInstance(id);
  if (d.ok) toast('已停止'); else toast(d.error, false);
  refreshProfiles();
};

/* ================= Cookie 导入/编辑/导出（每个环境独立，启动时CDP自动注入） ================= */
let CK_ID = null;
window.openCookieDlg = async (id) => {
  CK_ID = id;
  const p = PROFILES.find(x => x.id === id);
  $('#ck-pname').textContent = '#' + id + (p ? ' ' + p.name : '');
  $('#ck-text').value = '加载中…';
  $('#ck-count').textContent = '';
  $('#ck-fix-rpt').className = 'fix-rpt hidden';
  $('#dlg-cookie').showModal();
  const d = await window.jd.cookieLoad(id);
  const arr = d.ok ? d.cookies : [];
  $('#ck-text').value = arr.length ? JSON.stringify(arr, null, 2) : '';
  $('#ck-count').textContent = d.ok ? (arr.length ? `已保存 ${arr.length} 条Cookie` : '暂无Cookie，可粘贴或导入') : ('读取失败：' + d.error);
  // 环境运行中：启用实时读取并自动抓取浏览器内真实Cookie（含会话Cookie，CDP内存中）
  // 先向主进程实时核对运行态，避免本地缓存滞后导致按钮置灰/自动读取被跳过
  const list = await window.jd.runningInstances();
  RUNNING = new Map(list.map(r => [r.profileId, r]));
  const running = RUNNING.has(id);
  $('#ck-read-live').disabled = !running;
  if (running) loadLiveCookies(id, true);
};

// 读取运行中浏览器的实时Cookie并填入编辑框（保存=写入启动注入清单，不动浏览器内现有登录态）
async function loadLiveCookies(id, silent) {
  $('#ck-count').textContent = '正在读取浏览器内Cookie…';
  const r = await window.jd.cookieReadLive(id);
  if (!r.ok) {
    if (r.error === 'NOT_RUNNING') {
      $('#ck-read-live').disabled = true;
      $('#ck-count').textContent = '该环境未运行，请先启动环境并在浏览器内登录网站后再读取';
      if (!silent) toast('请先启动该环境，再读取浏览器内Cookie', false);
    } else {
      // 静默（自动读取）也要把失败原因显示在弹窗里，否则用户看到的就是"没有任何信息"
      $('#ck-count').textContent = '读取浏览器Cookie失败：' + r.error + '（可点"📥 读取浏览器Cookie"重试）';
      if (!silent) toast('读取浏览器Cookie失败：' + r.error, false);
    }
    return;
  }
  const n = r.cookies.length;
  $('#ck-text').value = n ? JSON.stringify(r.cookies, null, 2) : '';
  $('#ck-count').textContent = n
    ? `浏览器实时Cookie ${n} 条（修改后保存将作为下次启动注入清单，不影响浏览器内现有登录态）`
    : '浏览器内暂无Cookie（请先在浏览器中登录网站）';
  if (!silent) toast(n ? `已读取浏览器内 ${n} 条Cookie，记得点保存` : '浏览器内暂无Cookie');
}
$('#ck-read-live').onclick = () => { if (CK_ID != null) loadLiveCookies(CK_ID, false); };
$('#ck-cancel').onclick = () => $('#dlg-cookie').close();
$('#ck-save').onclick = async () => {
  const txt = $('#ck-text').value.trim();
  if (!txt) {
    if (!confirm('内容为空，将清空该环境已保存的Cookie（不影响浏览器内已有登录态）。确认？')) return;
  }
  const d = await window.jd.cookieSave(CK_ID, txt || '[]');
  if (d.ok) {
    toast(`Cookie已保存（${d.count}条），下次启动该环境自动注入`);
    $('#ck-count').textContent = `已保存 ${d.count} 条Cookie`;
    $('#dlg-cookie').close();
  } else toast(d.error + '（可点【🔧 一键自动修复】尝试自动纠正）', false);
};
$('#ck-import-file').onclick = async () => {
  const d = await window.jd.cookieImportFile(CK_ID);
  if (d.canceled) return;
  if (!d.ok) { toast(d.error, false); return; }
  toast(`已从文件导入 ${d.count} 条Cookie，记得点保存`);
  const l = await window.jd.cookieLoad(CK_ID);
  if (l.ok) {
    $('#ck-text').value = l.cookies.length ? JSON.stringify(l.cookies, null, 2) : '';
    $('#ck-count').textContent = `已保存 ${d.count} 条Cookie`;
  }
};
$('#ck-export').onclick = async () => {
  const d = await window.jd.cookieExportFile(CK_ID);
  if (d.canceled) return;
  if (d.ok) toast('已导出到文件'); else toast(d.error, false);
};
$('#ck-clear').onclick = () => { $('#ck-text').value = ''; $('#ck-fix-rpt').className = 'fix-rpt hidden'; $('#ck-text').focus(); };

/* ================= Cookie 一键自动修复（兼容他人浏览器/各类插件导出） =================
 * 处理：JSON 宽松解析（BOM/尾逗号/单引号/无引号键）、{cookies:[]} 包裹、
 * Netscape cookies.txt 转换、域名清洗(协议/端口/路径/hostOnly前导点)、
 * 毫秒/ISO 过期时间、丢弃过期项、sameSite 各家枚举统一、SameSite=None 强制 Secure、
 * __Host-/__Secure- 前缀强制规则、布尔字段归一、去除 Firefox 等专有字段、同名域路径去重。 */
function parseLooseCookieJson(raw) {
  try { return { data: JSON.parse(raw) }; } catch {}
  let s = raw.replace(/^﻿/, '').trim();
  s = s.replace(/([{,]\s*)([A-Za-z_$][\w$\-]*)\s*:/g, '$1"$2":')   // 无引号键名
       .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (m, v) => '"' + v.replace(/"/g, '\\"') + '"') // 单引号字符串
       .replace(/,\s*([}\]])/g, '$1');                               // 尾逗号
  return { data: JSON.parse(s), loose: true };
}
function parseNetscapeCookies(raw) {
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const f = line.split('\t');
    if (f.length < 7) continue;
    const c = { domain: f[0].trim(), path: f[2] || '/', name: f[5], value: f.slice(6).join('\t') };
    if (/^(true|1)$/i.test(f[3].trim())) c.secure = true;
    const ex = Number(f[4]);
    if (Number.isFinite(ex) && ex > 0) c.expirationDate = ex; // 0 = 会话Cookie
    out.push(c);
  }
  return out;
}
const CK_BOOL = v => v === true || v === 1 || /^(true|1)$/i.test(String(v ?? '').trim());
function repairCookies(raw) {
  const rpt = { format: 'JSON', in: 0, out: 0, loose: 0, unwrap: 0, dropInvalid: 0, dropExpired: 0,
    dedup: 0, sameSite: 0, ts: 0, domain: 0, secure: 0 };
  let arr;
  try {
    const r = parseLooseCookieJson(raw);
    arr = r.data;
    if (r.loose) rpt.loose = 1;
  } catch {
    const ns = parseNetscapeCookies(raw);
    if (ns.length) { arr = ns; rpt.format = 'Netscape(cookies.txt)'; }
    else return { error: '无法识别内容：既不是有效的 JSON Cookie 数组，也不是 Netscape 格式的 cookies.txt，请检查文件内容' };
  }
  if (!Array.isArray(arr)) {
    if (arr && Array.isArray(arr.cookies)) { arr = arr.cookies; rpt.unwrap = 1; }
    else return { error: 'JSON 顶层不是数组，应为 [ { "name": ..., "value": ..., "domain": ... }, ... ]' };
  }
  rpt.in = arr.length;
  const now = Math.floor(Date.now() / 1000);
  const map = new Map();
  for (const c0 of arr) {
    if (!c0 || typeof c0 !== 'object') { rpt.dropInvalid++; continue; }
    const name = c0.name ?? c0.Name ?? c0.cookieName;
    if (name === undefined || name === null || String(name).trim() === '') { rpt.dropInvalid++; continue; }
    // 域名：兼容 url/host/hostname，剥协议、端口、路径
    let domain = String(c0.domain ?? c0.Domain ?? c0.host ?? c0.hostname ?? '').trim().toLowerCase();
    let urlStr = c0.url ? String(c0.url).trim() : '';
    domain = domain.replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
    if (!domain && urlStr) { try { domain = new URL(urlStr).hostname; } catch {} }
    if (!domain) { rpt.dropInvalid++; continue; }
    const hostOnly = CK_BOOL(c0.hostOnly) && !c0.url;
    if (hostOnly && domain.startsWith('.')) { domain = domain.slice(1); rpt.domain++; }
    let cp = String(c0.path ?? c0.Path ?? '/').trim() || '/';
    if (!cp.startsWith('/')) cp = '/' + cp;
    cp = cp.split('?')[0] || '/';
    const c = { name: String(name), value: String(c0.value ?? c0.Value ?? c0.cookieValue ?? ''), domain, path: cp };
    if (CK_BOOL(c0.secure) || CK_BOOL(c0.isSecure)) c.secure = true;
    if (CK_BOOL(c0.httpOnly) || CK_BOOL(c0.isHttpOnly) || CK_BOOL(c0.httponly)) c.httpOnly = true;
    // __Host- 前缀：必须 Secure + path=/ + 无 domain 点前缀；__Secure- 前缀：必须 Secure
    if (/^__host-/i.test(c.name)) {
      if (!c.secure) { c.secure = true; rpt.secure++; }
      c.path = '/';
      if (c.domain.startsWith('.')) { c.domain = c.domain.slice(1); rpt.domain++; }
    } else if (/^__secure-/i.test(c.name) && !c.secure) { c.secure = true; rpt.secure++; }
    // 过期时间：expires/expirationDate/expiry，秒/毫秒/ISO 字符串；session:true 或缺失 = 会话Cookie
    const expRaw = c0.expires ?? c0.expirationDate ?? c0.expiry ?? c0.Expires ?? null;
    if (!(c0.session === true && (expRaw === null || expRaw === undefined || expRaw === ''))) {
      if (expRaw !== null && expRaw !== undefined && expRaw !== '' && typeof expRaw !== 'boolean') {
        let sec = Number(expRaw);
        if (!Number.isFinite(sec) && typeof expRaw === 'string') { const ms = Date.parse(expRaw); if (ms > 0) sec = ms / 1000; }
        if (Number.isFinite(sec) && sec > 0) {
          if (sec > 1e12) { sec = Math.floor(sec / 1000); rpt.ts++; }
          if (sec <= now) { rpt.dropExpired++; continue; } // 已过期的Cookie注入也无意义
          c.expires = sec;
        }
      }
    }
    // sameSite 各家枚举：Strict/Lax/None、数字(-1,0,1,2)、no_restriction、unspecified
    const ssRaw = c0.sameSite ?? c0.SameSite ?? c0.samesite;
    if (ssRaw !== undefined && ssRaw !== null && ssRaw !== '') {
      const v = String(ssRaw).trim().toLowerCase().replace(/[\s_-]/g, '');
      let mapped = null;
      if (v === 'strict' || v === '2') mapped = 'Strict';
      else if (v === 'lax' || v === '1') mapped = 'Lax';
      else if (v === 'none' || v === 'norestriction' || v === 'norestrict') mapped = 'None';
      // unspecified/-1/0/未知值 → 不设置 sameSite，交给浏览器默认策略
      if (mapped) {
        if (String(ssRaw) !== mapped) rpt.sameSite++;
        c.sameSite = mapped;
        if (mapped === 'None' && !c.secure) { c.secure = true; rpt.secure++; } // Chrome 强制 SameSite=None 必须 Secure
      } else if (!['unspecified', '-1', '0', ''].includes(v)) rpt.sameSite++;
    }
    const key = c.name + '\n' + c.domain + '\n' + c.path;
    if (map.has(key)) rpt.dedup++;
    map.set(key, c); // 同名+域+路径重复时保留最后一条
  }
  rpt.out = map.size;
  return { list: [...map.values()], rpt };
}
$('#ck-fix').onclick = () => {
  const txt = $('#ck-text').value.trim();
  const box = $('#ck-fix-rpt');
  if (!txt) { box.className = 'fix-rpt err'; box.textContent = '内容为空，没有可修复的 Cookie'; return; }
  const r = repairCookies(txt);
  if (r.error) { box.className = 'fix-rpt err'; box.textContent = '❌ ' + r.error; return; }
  $('#ck-text').value = JSON.stringify(r.list, null, 2);
  const x = r.rpt;
  const fixes = [];
  if (x.loose) fixes.push('JSON 语法已纠正');
  if (x.unwrap) fixes.push('已拆出 cookies 包裹层');
  if (x.dedup) fixes.push(`去重 ${x.dedup}`);
  if (x.dropExpired) fixes.push(`丢弃已过期 ${x.dropExpired}`);
  if (x.dropInvalid) fixes.push(`丢弃无效 ${x.dropInvalid}`);
  if (x.sameSite) fixes.push(`SameSite 修正 ${x.sameSite}`);
  if (x.ts) fixes.push(`毫秒时间戳转换 ${x.ts}`);
  if (x.domain) fixes.push(`域名规范化 ${x.domain}`);
  if (x.secure) fixes.push(`补 Secure 标记 ${x.secure}`);
  const detail = fixes.length ? fixes.join('、') + ' 条' : '内容已是标准格式，无需修改';
  const fmt = x.format !== 'JSON' ? `<b>已将 ${x.format} 转换为标准 JSON</b>；` : '';
  box.className = 'fix-rpt ok';
  box.innerHTML = `✅ <b>修复完成</b>：${fmt}原始 ${x.in} 条 → 有效 <b>${x.out}</b> 条。${detail}。点「保存」后下次启动自动注入。`;
  $('#ck-count').textContent = `修复后 ${x.out} 条有效Cookie，记得点保存`;
  toast(`Cookie 修复完成：${x.out} 条有效`);
};

/* ================= 主进程实例事件（关闭自动刷新状态 / IP检测 / 云同步进度） ================= */
if (window.jd.onInstanceEvent) window.jd.onInstanceEvent(ev => {
  if (ev.type === 'closed') {
    RUNNING.delete(ev.profileId);
    renderProfiles();
    toast('环境 #' + ev.profileId + ' 已关闭');
    log('环境 #' + ev.profileId + ' 已关闭，状态已更新');
  } else if (ev.type === 'running') {
    // 外部API或本地启动环境成功后通知，刷新运行状态
    window.jd.runningInstances().then(list => {
      RUNNING = new Map(list.map(r => [r.profileId, r]));
      renderProfiles();
    });
  } else if (ev.type === 'geo-fail' || ev.type === 'sync-fail') {
    toast(ev.msg, false);
    log('环境 #' + ev.profileId + ' ' + ev.msg);
  } else if (ev.type === 'update') {
    log('[更新] ' + ev.msg);
    const ur = $('#upd-result');
    if (ur) ur.textContent = ev.msg;
  } else if (ev.type === 'kernel') {
    // 浏览器内核下载/自动更新通知（后台静默下载，仅气泡提示）
    toast(ev.msg);
    log('[内核] ' + ev.msg);
  } else if (ev.msg) {
    log('环境 #' + ev.profileId + ' ' + ev.msg);
  }
});

/* ================= 公告栏 ================= */
const LEVEL_TXT = ['', '<span class="tag-share">重要</span>', '<span class="tag-off" style="color:#dc2626;border-color:#dc2626">紧急</span>'];
async function loadAnnouncements() {
  const d = await window.jd.announcements();
  const box = $('#announce-box');
  if (!d.ok || !(d.list || []).length) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  $('#announce-list').innerHTML = d.list.map(a => `
    <div style="padding:6px 0;border-bottom:1px dashed #e5e7eb">
      <b>${esc(a.title)}</b> ${LEVEL_TXT[a.level] || ''} <span class="hint">${String(a.created_at).slice(0, 16)}</span>
      <div class="tiny" style="margin-top:2px;white-space:pre-wrap">${esc(a.content)}</div>
    </div>`).join('');
}
$('#btn-announce-refresh').onclick = loadAnnouncements;

/* ================= 版本与更新 ================= */
$('#btn-check-update').onclick = async () => {
  const el = $('#upd-result');
  el.textContent = '正在检查更新…';
  const d = await window.jd.checkUpdate();
  if (!d.ok) { el.textContent = '检查更新失败：' + d.error; return; }
  $('#upd-cur').textContent = d.current;
  const info = d.info || {};
  if (d.updateAvailable) {
    el.innerHTML = `发现新版本 <b>v${esc(info.version)}</b>（当前 v${esc(d.current)}）\n${esc(info.notes || '')}`
      + (info.kernel && info.kernel.version ? `\n推荐内核：v${esc(info.kernel.version)}` : '')
      + `\n<button class="btn primary" id="btn-do-update" style="margin-top:6px">立即更新</button>`;
    $('#btn-do-update').onclick = async () => {
      if (!info.url) { toast('服务端未配置更新包下载地址，请联系管理员', false); return; }
      if (!confirm(`确认更新到 v${info.version}？更新完成后客户端将自动重启。`)) return;
      el.textContent = '开始更新…';
      const r = await window.jd.doUpdate(info.url);
      if (!r.ok) { el.textContent = '更新失败：' + r.error; toast(r.error, false); }
      else el.textContent = r.msg;
    };
  } else {
    el.textContent = `当前已是最新版本 v${d.current}`;
  }
};
/* ================= 浏览器内核管理（Chrome for Testing 多版本） ================= */
let KM = null;
async function loadKernelState(withRemote) {
  const d = await window.jd.kernelState(!!withRemote);
  if (d.ok) { KM = d.state; renderKernel(); }
  else toast(d.error || '内核状态获取失败', false);
  return d;
}
const KM_CH_NAME = { Stable: '稳定版', Beta: '测试版', Dev: '开发版', Canary: '金丝雀版' };
function kmFmtSize(n) {
  if (!n) return '-';
  return n > 1073741824 ? (n / 1073741824).toFixed(2) + ' GB' : Math.round(n / 1048576) + ' MB';
}
function kmFmtTime(t) { return t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '-'; }

// 同步"默认内核"下拉与环境编辑弹窗里的内核下拉（选项来自已安装列表）
function fillKernelSelects(preserveFp) {
  const inst = (KM && KM.installed) || [];
  const def = $('#km-default');
  def.innerHTML = '<option value="">自动（始终使用已安装的最新版）</option>'
    + '<option value="system">系统 Chrome / Edge</option>'
    + inst.map(v => `<option value="${v.version}">v${v.version}${v.channel ? '（' + (KM_CH_NAME[v.channel] || v.channel) + '）' : ''}</option>`).join('');
  def.value = KM ? KM.defaultVersion : '';

  const fk = $('#fp-kernel');
  if (fk) {
    const cur = preserveFp ? fk.value : (window.__editFp && window.__editFp.kernel) || '';
    fk.innerHTML = '<option value="">自动（跟随默认内核 / 最新版）</option>'
      + '<option value="system">系统安装的 Chrome / Edge</option>'
      + inst.map(v => `<option value="${v.version}">Chrome v${v.version}</option>`).join('');
    fk.value = cur || '';
  }
}

function renderKernel() {
  if (!KM) return;
  $('#km-auto').checked = !!KM.autoUpdate;
  $('#km-source').value = KM.source || 'auto';
  fillKernelSelects(true);

  const eff = KM.effectiveAuto;
  $('#km-eff').innerHTML = eff
    ? `自动模式当前内核：<b>Chrome v${esc(eff.version)}</b>`
      + (eff.fileVersion && eff.fileVersion !== eff.version ? `（文件版本 ${esc(eff.fileVersion)}）` : '')
      + ` · <span class="hint">${esc(eff.exe)}</span>`
    : '当前无内置内核，自动模式将使用系统安装的 Chrome/Edge（可在上方频道表一键下载谷歌官方内核）';

  const have = new Set((KM.installed || []).map(x => x.version));
  const chs = KM.channels || [];
  $('#km-channels tbody').innerHTML =
    chs.filter(c => c.version).map(c => `<tr>
      <td>${esc(c.name)}</td>
      <td><span class="ver-tag">v${esc(c.version)}</span></td>
      <td>${have.has(c.version)
        ? '<span style="color:#16a34a;font-weight:600">✓ 已安装</span>'
        : `<button class="btn small primary" data-km-install="${esc(c.version)}" data-channel="${esc(c.key)}">下载安装</button>`}</td>
    </tr>`).join('')
    + (chs.length ? '' : '<tr><td colspan="3" class="hint">点「刷新版本列表」获取最新 Stable / Beta / Dev / Canary 版本</td></tr>')
    + (KM.channelsError ? `<tr><td colspan="3" class="hint">官方列表获取失败（${esc(KM.channelsError)}）：国内网络可点「加载历史版本」走镜像下载</td></tr>` : '');

  const inst = KM.installed || [];
  $('#km-installed tbody').innerHTML = inst.length
    ? inst.map(v => `<tr>
      <td>v${esc(v.version)}${v.isDefault ? '<span class="km-def">默认</span>' : ''}</td>
      <td>${v.channel ? esc(KM_CH_NAME[v.channel] || v.channel) : '-'}</td>
      <td>${kmFmtSize(v.size)}</td>
      <td>${kmFmtTime(v.installedAt)}</td>
      <td>${v.isDefault ? '' : `<button class="btn small" data-km-default="${v.version}">设为默认</button>`}
        <button class="btn small danger" data-km-remove="${v.version}">删除</button></td>
    </tr>`).join('')
    : '<tr><td colspan="5" class="hint">尚未下载内置内核（可并存多个版本，每个环境单独选择）</td></tr>';

  if (KM.installing) kmShowProgress(KM.installing); else kmHideProgress();
}

function kmShowProgress(p) {
  $('#km-prog').classList.remove('hidden');
  const bar = $('#km-prog-bar');
  if (p.phase === 'extract') { bar.style.width = '100%'; $('#km-prog-txt').textContent = 'v' + p.version + ' 下载完成，正在解压（约1~3分钟）…'; }
  else if (p.pct >= 0) { bar.style.width = p.pct + '%'; $('#km-prog-txt').textContent = `v${p.version} 下载中 ${p.pct}%${p.msg ? '（' + p.msg + '）' : ''}`; }
  else { $('#km-prog-txt').textContent = 'v' + p.version + ' ' + (p.msg || '准备下载…'); }
}
function kmHideProgress() { $('#km-prog').classList.add('hidden'); $('#km-prog-bar').style.width = '0'; }

async function kmDoInstall(version, channel) {
  if (!confirm(`确认下载安装 Chrome v${version}？\n压缩包约 150~180MB，解压后约占 300MB 磁盘空间。`)) return;
  const r = await window.jd.kernelInstall(version, channel);
  if (r && r.exists) toast('该版本已安装');
  else if (r && r.ok) toast('✓ 内核 v' + version + ' 安装完成');
  else toast((r && r.error) || '安装失败', false);
  await loadKernelState(false);
  fillKernelSelects(false);
}

$('#km-default').onchange = async () => {
  const r = await window.jd.kernelConfig({ defaultVersion: $('#km-default').value });
  if (r.ok) { KM = r.state; renderKernel(); toast('默认内核已切换'); }
  else toast(r.error || '设置失败', false);
};
$('#km-auto').onchange = async () => { await window.jd.kernelConfig({ autoUpdate: $('#km-auto').checked }); toast($('#km-auto').checked ? '已开启自动跟随谷歌更新' : '已关闭自动更新'); };
$('#km-source').onchange = async () => { await window.jd.kernelConfig({ source: $('#km-source').value }); toast('下载源已切换'); };
$('#km-refresh').onclick = () => loadKernelState(true);
$('#km-check').onclick = async () => {
  toast('正在检查谷歌最新稳定版…');
  const r = await window.jd.kernelCheckUpdate();
  if (!r.ok) return toast(r.error || '检查失败', false);
  const info = r.info || {};
  if (info.error) toast('检查失败：' + info.error, false);
  else if (info.alreadyLatest) toast('已是谷歌最新稳定版 v' + info.stable);
  else if (info.stable) toast('发现新版本 v' + info.stable + ($('#km-auto').checked ? '，已开始后台自动下载' : '（开启自动更新或在频道表手动下载）'));
  await loadKernelState(true);
};
$('#km-dir').onclick = () => window.jd.kernelOpenDir();

// 频道表/已安装表按钮（事件委托）
$('#km-channels').onclick = (ev) => {
  const b = ev.target.closest('[data-km-install]');
  if (b) kmDoInstall(b.getAttribute('data-km-install'), b.getAttribute('data-channel'));
};
$('#km-installed').onclick = async (ev) => {
  const def = ev.target.closest('[data-km-default]');
  const rm = ev.target.closest('[data-km-remove]');
  if (def) {
    const r = await window.jd.kernelConfig({ defaultVersion: def.getAttribute('data-km-default') });
    if (r.ok) { KM = r.state; renderKernel(); toast('已设为默认内核'); } else toast(r.error, false);
  } else if (rm) {
    const v = rm.getAttribute('data-km-remove');
    if (!confirm(`确认删除内核 v${v}？\n使用该内核的环境之后将回退到自动/系统内核，正在运行的浏览器不受影响。`)) return;
    const r = await window.jd.kernelRemove(v);
    if (r.ok) { toast('已删除'); await loadKernelState(false); fillKernelSelects(false); }
    else toast(r.error, false);
  }
};

// 历史版本
$('#km-hist-btn').onclick = async () => {
  $('#km-hist-btn').textContent = '加载中…';
  const d = await window.jd.kernelHistory();
  $('#km-hist-btn').textContent = '刷新历史版本';
  if (!d.ok) return toast(d.error || '历史版本加载失败', false);
  const have = new Set(((KM && KM.installed) || []).map(x => x.version));
  $('#km-hist-sel').innerHTML = (d.versions || []).map(v =>
    `<option value="${v}" ${have.has(v) ? 'disabled' : ''}>v${v}${have.has(v) ? '（已安装）' : ''}</option>`).join('');
  $('#km-hist-sel').classList.remove('hidden');
  $('#km-hist-install').classList.remove('hidden');
};
$('#km-hist-install').onclick = () => {
  const v = $('#km-hist-sel').value;
  if (v) kmDoInstall(v, '历史版本');
};

// 下载/解压实时进度（完成或失败时 p 为 null → 刷新列表）
if (window.jd.onKernelProgress) window.jd.onKernelProgress(p => {
  if (!p) { kmHideProgress(); loadKernelState(false); }
  else kmShowProgress(p);
});

$('#btn-batch-open').onclick = async () => {
  const ids = selectedIds();
  if (!ids.length) return toast('请先勾选环境', false);
  const d = await window.jd.batchStart(ids);
  const ok = (d.results || []).filter(r => r.ok).length;
  toast(`批量启动完成：成功${ok} / 共${ids.length}`, ok > 0);
  refreshProfiles();
};
$('#btn-batch-close').onclick = async () => {
  const ids = selectedIds();
  if (!ids.length) return toast('请先勾选环境', false);
  await window.jd.batchStop(ids);
  toast('批量关闭完成');
  refreshProfiles();
};
$('#btn-batch-del').onclick = async () => {
  const ids = selectedIds();
  if (!ids.length) return toast('请先勾选环境', false);
  if (!confirm(`删除选中的${ids.length}个环境？`)) return;
  for (const id of ids) await window.jd.deleteProfile(id);
  refreshProfiles();
};
$('#btn-import').onclick = async () => {
  const d = await window.jd.importProfiles();
  if (d.canceled) return;
  if (d.ok) { toast('导入完成'); refreshProfiles(); } else toast(d.error, false);
};
$('#btn-export').onclick = async () => {
  const ids = selectedIds();
  const d = await window.jd.exportProfiles(ids);
  if (d.ok) toast(`已导出${d.count}个环境配置`); else if (!d.canceled) toast(d.error, false);
};

/* ================= 环境编辑弹窗 ================= */
let TPLS = [];
async function refreshTemplates() {
  TPLS = await window.jd.templatesList();
  $('#pf-tpl').innerHTML = '<option value="">不加载</option>' + TPLS.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  renderTplTable();
}
function renderTplTable() {
  $('#tb-tpl tbody').innerHTML = TPLS.map(t => `<tr>
    <td>${esc(t.name)}</td><td>${esc((t.config.ua || '').slice(0, 60)) || '-'}</td><td>${esc(t.config.timezone || '-')}</td>
    <td><button class="btn small" onclick="applyTpl(${t.id})">应用到选中环境</button>
        <button class="btn small danger" onclick="delTpl(${t.id})">删除</button></td></tr>`).join('')
    || '<tr><td colspan="4">暂无模板</td></tr>';
}
window.delTpl = async (id) => { await window.jd.templatesDelete(id); refreshTemplates(); };
window.applyTpl = async (id) => {
  const ids = selectedIds();
  if (!ids.length) return toast('请先勾选环境', false);
  const tpl = TPLS.find(t => t.id === id);
  for (const pid of ids) await window.jd.updateProfile(pid, { fingerprint_config: tpl.config });
  toast('模板已应用到' + ids.length + '个环境');
  refreshProfiles();
};
$('#btn-new-tpl').onclick = () => {
  const name = prompt('模板名称');
  if (!name) return;
  window.jd.templatesSave({ id: Date.now(), name, config: defaultFp() }).then(refreshTemplates);
};
$('#btn-tpl-from-profile').onclick = async () => {
  const ids = selectedIds();
  if (!ids.length) return toast('请先在环境列表勾选一个环境', false);
  const p = PROFILES.find(x => x.id === ids[0]);
  if (!p) return;
  const name = prompt(`为「${p.name}」的指纹保存为模板，模板名称：`, p.name + '-指纹');
  if (!name) return;
  // kernel 偏好是本机相关的（其他机器未必装了该版本），不写入模板
  const tplConfig = { ...(p.fingerprint_config || {}) };
  delete tplConfig.kernel;
  window.jd.templatesSave({ id: Date.now(), name, config: tplConfig }).then(r => {
    refreshTemplates();
    toast(`已从环境 #${p.id} 保存模板「${name}」`);
  });
};

$$('.dlg-tabs button').forEach(b => b.onclick = () => {
  $$('.dlg-tabs button').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  $$('.dt-page').forEach(p => p.classList.add('hidden'));
  $('#dt-' + b.dataset.dt).classList.remove('hidden');
});

// 客户端运行平台（Electron 界面进程的 navigator.platform 是真实宿主平台，不受环境指纹注入影响）
const IS_MAC = navigator.platform === 'MacIntel';

function defaultFp() {
  if (IS_MAC) {
    return {
      ua: '', browserVersion: '', platform: 'MacIntel', language: 'zh-CN', languages: ['zh-CN'],
      timezone: 'Asia/Shanghai', timezoneOffset: -480,
      screen: { width: 1920, height: 1080, colorDepth: 24, pixelDepth: 24 },
      devicePixelRatio: 2, hardwareConcurrency: 8, deviceMemory: 8,
      webgl: { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)' },
      canvasNoise: { enabled: true, seed: Math.floor(Math.random() * 1e6) },
      audioNoise: { enabled: true, seed: Math.floor(Math.random() * 1e6) },
      webrtc: 'disabled', fonts: [],
      geolocation: { latitude: 31.2304, longitude: 121.4737, accuracy: 100 },
      clientHints: { enabled: true, mobile: false, platform: 'macOS', platformVersion: '10_15_7', architecture: 'arm', bitness: '64' },
      extensions: [], customDns: []
    };
  }
  return {
    ua: '', browserVersion: '', platform: 'Win32', language: 'zh-CN', languages: ['zh-CN'],
    timezone: 'Asia/Shanghai', timezoneOffset: -480,
    screen: { width: 1920, height: 1080, colorDepth: 24, pixelDepth: 24 },
    devicePixelRatio: 1, hardwareConcurrency: 8, deviceMemory: 8,
    webgl: { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    canvasNoise: { enabled: true, seed: Math.floor(Math.random() * 1e6) },
    audioNoise: { enabled: true, seed: Math.floor(Math.random() * 1e6) },
    webrtc: 'disabled', fonts: [],
    geolocation: { latitude: 31.2304, longitude: 121.4737, accuracy: 100 },
    clientHints: { enabled: true, mobile: false, platform: 'Windows', platformVersion: '15.0.0', architecture: 'x86', bitness: '64' },
    extensions: [], customDns: []
  };
}

function applyFpToInputs(fp) {
  $('#fp-ua').value = fp.ua || ''; $('#fp-ver').value = fp.browserVersion || '';
  $('#fp-platform').value = fp.platform || ''; $('#fp-lang').value = fp.language || '';
  $('#fp-tz').value = fp.timezone || ''; $('#fp-tzo').value = fp.timezoneOffset ?? '';
  $('#fp-sw').value = fp.screen.width; $('#fp-sh').value = fp.screen.height;
  $('#fp-cd').value = fp.screen.colorDepth; $('#fp-dpr').value = fp.devicePixelRatio;
  $('#fp-cores').value = fp.hardwareConcurrency; $('#fp-mem').value = fp.deviceMemory;
  $('#fp-glvendor').value = fp.webgl.vendor; $('#fp-glrenderer').value = fp.webgl.renderer;
  $('#fp-canvas').checked = !!fp.canvasNoise.enabled; $('#fp-cseed').value = fp.canvasNoise.seed;
  $('#fp-audio').checked = !!fp.audioNoise.enabled;
  $('#fp-webrtc').value = fp.webrtc || 'disabled';
  $('#fp-fonts').value = (fp.fonts || []).join(', ');
  $('#fp-lat').value = fp.geolocation.latitude; $('#fp-lng').value = fp.geolocation.longitude;
  $('#fp-ch').checked = !!fp.clientHints.enabled; $('#fp-ch-mobile').checked = !!fp.clientHints.mobile;
}

// 一键随机指纹：UA/版本/屏幕/GPU/硬件/噪声随机；时区/语言/经纬度与代理IP绑定不随机
const GPU_POOL_WIN = [
  ['Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
  ['Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)'],
  ['Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
  ['Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
  ['Google Inc. (AMD)', 'ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
  ['Google Inc. (AMD)', 'ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)'],
  ['Google Inc. (Intel)', 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)'],
  ['Google Inc. (Intel)', 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)']
];
// macOS 真实 ANGLE 走 Metal（Apple Silicon）/ OpenGL（Intel 核显），不能出现 Direct3D/D3D 字样
const GPU_POOL_MAC = [
  ['Google Inc. (Apple)', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)'],
  ['Google Inc. (Apple)', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)'],
  ['Google Inc. (Apple)', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)'],
  ['Google Inc. (Apple)', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)'],
  ['Google Inc. (Intel)', 'ANGLE (Intel Inc., Intel(R) Iris(TM) Plus Graphics 645, OpenGL 4.1)'],
  ['Google Inc. (Intel)', 'ANGLE (Intel Inc., Intel(R) UHD Graphics 630, OpenGL 4.1)']
];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
$('#fp-random').onclick = () => {
  const fp = window.__editFp || defaultFp();
  const ver = pick(['126', '127', '128', '129', '130', '131']);
  const [w, h] = pick(IS_MAC
    ? [[1920, 1080], [2560, 1440], [1440, 900], [1512, 982], [1800, 1169], [1680, 1050]]
    : [[1920, 1080], [2560, 1440], [1366, 768], [1536, 864], [1440, 900], [1600, 900]]);
  const gpu = pick(IS_MAC ? GPU_POOL_MAC : GPU_POOL_WIN);
  if (IS_MAC) {
    fp.ua = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver}.0.0.0 Safari/537.36`;
    fp.platform = 'MacIntel';
    fp.devicePixelRatio = pick([1, 2, 2, 2]);
  } else {
    fp.ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver}.0.0.0 Safari/537.36`;
    fp.platform = 'Win32';
    fp.devicePixelRatio = pick([1, 1, 1.25, 1.5, 2]);
  }
  fp.browserVersion = ver;
  fp.screen = { width: w, height: h, colorDepth: 24, pixelDepth: 24 };
  fp.hardwareConcurrency = pick(IS_MAC ? [8, 8, 10, 12] : [4, 6, 8, 12, 16]);
  fp.deviceMemory = pick([4, 8, 8, 16]);
  fp.webgl = { vendor: gpu[0], renderer: gpu[1] };
  fp.canvasNoise = { enabled: true, seed: Math.floor(Math.random() * 1e6) };
  fp.audioNoise = { enabled: true, seed: Math.floor(Math.random() * 1e6) };
  fp.webrtc = 'disabled';
  fp.clientHints = IS_MAC
    ? { ...(fp.clientHints || defaultFp().clientHints), enabled: true, mobile: false, platform: 'macOS',
        platformVersion: pick(['10_15_7', '13_5_0', '14_4_0', '14_6_0']), architecture: pick(['arm', 'arm', 'x86']), bitness: '64' }
    : { ...(fp.clientHints || defaultFp().clientHints), enabled: true, mobile: false, platform: 'Windows',
        platformVersion: pick(['10.0.0', '13.0.0', '14.0.0', '15.0.0']), architecture: 'x86', bitness: '64' };
  applyFpToInputs(fp);
  window.__editFp = fp;
  toast('已生成随机指纹（时区/语言/经纬度保持与代理IP匹配）');
};

async function openProfileDlg(p) {
  EDIT_ID = p ? p.id : null;
  $('#dlg-title').textContent = p ? '编辑环境 #' + p.id : '新建环境';
  const fp = p ? { ...defaultFp(), ...(p.fingerprint_config || {}) } : defaultFp();
  fp.screen = { ...defaultFp().screen, ...(fp.screen || {}) };
  fp.webgl = { ...defaultFp().webgl, ...(fp.webgl || {}) };
  fp.geolocation = { ...defaultFp().geolocation, ...(fp.geolocation || {}) };
  fp.canvasNoise = { ...defaultFp().canvasNoise, ...(fp.canvasNoise || {}) };
  fp.audioNoise = { ...defaultFp().audioNoise, ...(fp.audioNoise || {}) };
  fp.clientHints = { ...defaultFp().clientHints, ...(fp.clientHints || {}) };
  $('#pf-name').value = p ? p.name : '';
  $('#pf-tags').value = p ? JSON.parse(p.tags || '[]').join(',') : '';
  $('#pf-standalone').checked = p ? !!p.standalone : false;

  applyFpToInputs(fp);

  $('#px-type').value = p ? (p.proxy_type || 0) : 0;
  $('#px-host').value = p ? (p.proxy_host || '') : '';
  $('#px-port').value = p ? (p.proxy_port || '') : '';
  $('#px-user').value = p ? (p.proxy_username || '') : '';
  $('#px-pass').value = p ? (p.proxy_password || '') : '';
  $('#px-fixed-ip').value = p ? (p.fixed_ip || '') : '';
  $('#px-result').textContent = '';

  renderList('#ext-list', fp.extensions || [], '扩展目录路径');
  renderList('#dns-list', (fp.customDns || []).map(r => `${r.host}=${r.target}`), 'host=目标IP');
  window.__editFp = fp;
  // 内核下拉项来自已安装内核列表；按环境保存的 kernel 偏好回填
  fillKernelSelects(true);
  $('#fp-kernel').value = fp.kernel || '';
  $('#dlg-profile').showModal();
}
function renderList(sel, arr, placeholder) {
  $(sel).innerHTML = arr.map((v, i) => `<div class="item">
    <input value="${esc(v)}" data-idx="${i}" placeholder="${placeholder}">
    <button class="btn small danger" onclick="this.parentElement.remove()">删</button></div>`).join('');
}

$('#ext-add').onclick = async () => {
  const dirs = await window.jd.pickExts();
  const fp = window.__editFp;
  fp.extensions = [...new Set([...(fp.extensions || []), ...dirs])];
  renderList('#ext-list', fp.extensions, '扩展目录路径');
};
$('#dns-add').onclick = () => {
  const div = document.createElement('div');
  div.className = 'item';
  div.innerHTML = `<input placeholder="host=目标IP"><button class="btn small danger" onclick="this.parentElement.remove()">删</button>`;
  $('#dns-list').appendChild(div);
};

$('#px-test').onclick = async () => {
  $('#px-result').textContent = '测试中...';
  const proxy = { proxy_type: +$('#px-type').value, proxy_host: $('#px-host').value.trim(), proxy_port: +$('#px-port').value, proxy_username: $('#px-user').value, proxy_password: $('#px-pass').value };
  const d = await window.jd.proxyTest(proxy.proxy_type ? proxy : null);
  if (d.ok) {
    if (d.adapted) {
      $('#px-type').value = '1';
      $('#px-result').innerHTML = `<span style="color:#2f9e62">SOCKS5握手失败，但该节点按HTTP协议连通 ✓（已自动切换代理类型为HTTP，保存后生效）<br>出口IP ${d.ip} · ${d.country}(${d.countryCode}) · 时区 ${d.timezone} · 坐标 ${d.lat},${d.lon}</span>`;
    } else {
      $('#px-result').innerHTML = `<span style="color:#2f9e62">连通 ✓ 出口IP ${d.ip} · ${d.country}(${d.countryCode}) · 时区 ${d.timezone} · 坐标 ${d.lat},${d.lon}</span>`;
    }
  } else $('#px-result').innerHTML = `<span style="color:#e5484d">失败：${esc(d.error)}</span>`;
};

$('#pf-tpl').onchange = () => {
  const t = TPLS.find(x => x.id === +$('#pf-tpl').value);
  if (!t) return;
  const fp = { ...defaultFp(), ...t.config };
  window.__editFp = fp;
  $('#fp-ua').value = fp.ua || ''; $('#fp-tz').value = fp.timezone || ''; $('#fp-tzo').value = fp.timezoneOffset ?? '';
  $('#fp-sw').value = fp.screen.width; $('#fp-sh').value = fp.screen.height;
  $('#fp-glvendor').value = fp.webgl.vendor; $('#fp-glrenderer').value = fp.webgl.renderer;
  $('#fp-lang').value = fp.language || ''; $('#fp-lat').value = fp.geolocation.latitude; $('#fp-lng').value = fp.geolocation.longitude;
  $('#fp-canvas').checked = !!fp.canvasNoise.enabled; $('#fp-audio').checked = !!fp.audioNoise.enabled;
  toast('模板已加载，其余参数请检查后保存');
};

$('#dlg-cancel').onclick = () => $('#dlg-profile').close();

// 单机模式与团队共享互斥
$('#pf-standalone').onchange = () => { if ($('#pf-standalone').checked) $('#pf-share').checked = false; };
$('#pf-share').onchange = () => { if ($('#pf-share').checked) $('#pf-standalone').checked = false; };

$('#dlg-save').onclick = async () => {
  const name = $('#pf-name').value.trim();
  if (!name) return toast('名称必填', false);
  const fp = window.__editFp || defaultFp();
  fp.ua = $('#fp-ua').value.trim();
  fp.kernel = $('#fp-kernel').value; // ''=自动 / system=系统Chrome / 具体版本号
  fp.browserVersion = $('#fp-ver').value.trim();
  fp.platform = $('#fp-platform').value.trim();
  fp.language = $('#fp-lang').value.trim();
  fp.languages = fp.language ? [fp.language] : [];
  fp.timezone = $('#fp-tz').value.trim();
  fp.timezoneOffset = $('#fp-tzo').value === '' ? null : +$('#fp-tzo').value;
  fp.screen = { width: +$('#fp-sw').value || 1920, height: +$('#fp-sh').value || 1080, colorDepth: +$('#fp-cd').value || 24, pixelDepth: +$('#fp-cd').value || 24 };
  fp.devicePixelRatio = +$('#fp-dpr').value || 1;
  fp.hardwareConcurrency = +$('#fp-cores').value || 8;
  fp.deviceMemory = +$('#fp-mem').value || 8;
  fp.webgl = { vendor: $('#fp-glvendor').value.trim(), renderer: $('#fp-glrenderer').value.trim() };
  fp.canvasNoise = { enabled: $('#fp-canvas').checked, seed: +$('#fp-cseed').value || Math.floor(Math.random() * 1e6) };
  fp.audioNoise = { enabled: $('#fp-audio').checked, seed: Math.floor(Math.random() * 1e6) };
  fp.webrtc = $('#fp-webrtc').value;
  fp.fonts = $('#fp-fonts').value.split(',').map(s => s.trim()).filter(Boolean);
  fp.geolocation = { latitude: +$('#fp-lat').value || 0, longitude: +$('#fp-lng').value || 0, accuracy: 100 };
  fp.clientHints.enabled = $('#fp-ch').checked;
  fp.clientHints.mobile = $('#fp-ch-mobile').checked;
  fp.extensions = $$('#ext-list input').map(i => i.value.trim()).filter(Boolean);
  fp.customDns = $$('#dns-list input').map(i => {
    const [h, t] = i.value.split('=');
    return h && t ? { host: h.trim(), target: t.trim() } : null;
  }).filter(Boolean);

  const body = {
    name,
    tags: $('#pf-tags').value.split(',').map(s => s.trim()).filter(Boolean),
    team_shared: $('#pf-share').checked ? 1 : 0,
    standalone: $('#pf-standalone').checked ? 1 : 0,
    proxy_type: +$('#px-type').value,
    proxy_host: $('#px-host').value.trim() || null,
    proxy_port: +$('#px-port').value || null,
    proxy_username: $('#px-user').value.trim() || null,
    proxy_password: $('#px-pass').value || null,
    fixed_ip: $('#px-fixed-ip').value.trim() || null,
    fingerprint_config: fp
  };
  const d = EDIT_ID ? await window.jd.updateProfile(EDIT_ID, body) : await window.jd.createProfile(body);
  if (d.ok) { $('#dlg-profile').close(); toast('保存成功'); refreshProfiles(); refreshMe(); }
  else toast(d.error, false);
};

/* ================= 代理池管理 ================= */
let PROXIES = [];
const PROXY_TYPE_NAMES = { 1: 'HTTP', 2: 'HTTPS', 3: 'SOCKS5' };
let pxEditingId = null;

async function refreshProxies() {
  const d = await window.jd.listProxies();
  PROXIES = d.ok ? d.list : [];
  if (!d.ok) toast(d.error, false);
  renderProxies();
}
function renderProxies() {
  $('#tb-proxy tbody').innerHTML = PROXIES.map(p => `<tr>
    <td>${esc(p.label || '-')}</td>
    <td>${PROXY_TYPE_NAMES[p.proxy_type] || p.proxy_type}</td>
    <td>${esc(p.host)}:${p.port}</td>
    <td>${p.username ? esc(p.username) + ' / 有密码' : '-'}</td>
    <td>${String(p.created_at).slice(0, 16).replace('T', ' ')}</td>
    <td>
      <button class="btn small" onclick="pxEdit(${p.id})">编辑</button>
      <button class="btn small" onclick="pxApplyToEnv(${p.id})">应用到选中环境</button>
      <button class="btn small" onclick="pxTestOne(${p.id})">测试</button>
      <button class="btn small danger" onclick="pxDelete(${p.id})">删除</button>
    </td>
  </tr>`).join('') || '<tr><td colspan="6">代理池为空。创建/编辑环境时填入代理会自动保存到这里</td></tr>';
}
window.pxEdit = (id) => {
  const p = PROXIES.find(x => x.id === id);
  if (!p) return;
  pxEditingId = id;
  $('#pxp-label').value = p.label || '';
  $('#pxp-type').value = p.proxy_type;
  $('#pxp-host').value = p.host;
  $('#pxp-port').value = p.port;
  $('#pxp-user').value = p.username || '';
  $('#pxp-pass').value = p.password || '';
  $('#proxy-editor').classList.remove('hidden');
};
window.pxDelete = async (id) => {
  if (!confirm('确认删除此代理？')) return;
  await window.jd.deleteProxy(id);
  refreshProxies();
};
window.pxTestOne = async (id) => {
  const p = PROXIES.find(x => x.id === id);
  if (!p) return;
  $('#proxy-result').innerHTML = '测试中...';
  const d = await window.jd.proxyTest({ proxy_type: p.proxy_type, proxy_host: p.host, proxy_port: p.port, proxy_username: p.username, proxy_password: p.password });
  if (d.ok) {
    $('#proxy-result').innerHTML = `<div style="color:#2f9e62">✓ ${PROXY_TYPE_NAMES[p.proxy_type]}://${p.host}:${p.port} → ${d.ip} ${d.country}(${d.countryCode}) 时区 ${d.timezone}${d.adapted ? '（SOCKS5握手失败，已按HTTP协议连通）' : ''}</div>`;
  } else {
    $('#proxy-result').innerHTML = `<div style="color:#e5484d">✗ ${PROXY_TYPE_NAMES[p.proxy_type]}://${p.host}:${p.port} → ${esc(d.error)}</div>`;
  }
};
window.pxApplyToEnv = async (id) => {
  const ids = selectedIds();
  if (!ids.length) return toast('请先在环境列表勾选要应用的环境', false);
  const p = PROXIES.find(x => x.id === id);
  if (!p) return;
  let ok = 0;
  for (const pid of ids) {
    const r = await window.jd.updateProfile(pid, {
      proxy_type: p.proxy_type, proxy_host: p.host, proxy_port: p.port,
      proxy_username: p.username || null, proxy_password: p.password || null
    });
    if (r.ok) ok++;
  }
  toast(`已应用到 ${ok}/${ids.length} 个环境`);
  refreshProfiles();
};

$('#btn-proxy-add').onclick = () => {
  pxEditingId = null;
  $('#pxp-label').value = '';
  $('#pxp-type').value = 1;
  $('#pxp-host').value = '';
  $('#pxp-port').value = '';
  $('#pxp-user').value = '';
  $('#pxp-pass').value = '';
  $('#proxy-editor').classList.remove('hidden');
};
$('#pxp-cancel').onclick = () => $('#proxy-editor').classList.add('hidden');
$('#pxp-save').onclick = async () => {
  const p = {
    label: $('#pxp-label').value.trim(),
    proxy_type: +$('#pxp-type').value,
    host: $('#pxp-host').value.trim(),
    port: +$('#pxp-port').value,
    username: $('#pxp-user').value.trim() || null,
    password: $('#pxp-pass').value || null
  };
  if (!p.host || !p.port) return toast('主机和端口必填', false);
  const d = await window.jd.saveProxy(p);
  if (d.ok) { $('#proxy-editor').classList.add('hidden'); toast('代理已保存'); refreshProxies(); }
  else toast(d.error, false);
};

// 批量导入：粘贴代理串（支持 socks5://user:pass@host:port / http://host:port / host:port 默认 HTTP）
$('#btn-proxy-import').onclick = async () => {
  const text = prompt('每行一条代理，支持格式：\nsocks5://user:pass@host:port\nhttp://host:port\nhost:port（默认HTTP）');
  if (!text) return;
  const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
  const items = [];
  const results = [];
  for (const line of lines) {
    let m = line.match(/^(https?|socks5):\/\/(?:([^:@]+)(?::([^@]*))?@)?([^:\/]+):(\d+)/i);
    let type, host, port, user, pass;
    if (m) {
      type = { 'http': 1, 'https': 2, 'socks5': 3 }[m[1].toLowerCase()];
      user = m[2]; pass = m[3]; host = m[4]; port = +m[5];
    } else {
      const m2 = line.match(/^([^:\s]+):(\d+)$/);
      if (!m2) { results.push({ line, ok: false, error: '格式错误' }); continue; }
      type = 1; host = m2[1]; port = +m2[2];
    }
    items.push({ label: '', proxy_type: type, host, port, username: user || null, password: pass || null });
    results.push({ line, ok: true });
  }
  if (items.length) {
    const r = await window.jd.saveProxies(items);
    $('#proxy-result').innerHTML = results.map(r =>
      `<div style="color:${r.ok ? '#2f9e62' : '#e5484d'}">${r.ok ? '✓' : '✗'} ${esc(r.line)} ${r.error || ''}</div>`).join('')
      + (r.ok ? `<div style="color:#2f9e62;margin-top:4px">已导入 ${r.inserted} 条（重复自动跳过）</div>` : '');
    refreshProxies();
  } else {
    $('#proxy-result').innerHTML = results.map(r => `<div style="color:#e5484d">✗ ${esc(r.line)} ${r.error}</div>`).join('');
  }
};

$('#btn-proxy-test').onclick = async () => {
  if (!PROXIES.length) return toast('代理池为空，请先添加代理', false);
  $('#proxy-result').innerHTML = '逐个测试中...';
  let html = '';
  for (const p of PROXIES) {
    const d = await window.jd.proxyTest({ proxy_type: p.proxy_type, proxy_host: p.host, proxy_port: p.port, proxy_username: p.username, proxy_password: p.password });
    if (d.ok) html += `<div style="color:#2f9e62">✓ #${p.id} ${esc(p.label || PROXY_TYPE_NAMES[p.proxy_type] + '://' + p.host + ':' + p.port)} → ${d.ip} ${d.country}(${d.countryCode}) 时区 ${d.timezone}</div>`;
    else html += `<div style="color:#e5484d">✗ #${p.id} ${esc(p.label || PROXY_TYPE_NAMES[p.proxy_type] + '://' + p.host + ':' + p.port)} → ${esc(d.error)}</div>`;
  }
  $('#proxy-result').innerHTML = html;
};

/* ================= 环境弹窗：代理池选择 ================= */
let PP_SEL = null;
const PP_TYPE_NAMES = { 1: 'HTTP', 2: 'HTTPS', 3: 'SOCKS5' };

async function openProxyPoolPicker() {
  const d = await window.jd.listProxies();
  const list = d.ok ? d.list : [];
  if (!list.length) { toast('代理池为空，先到「代理管理」添加或保存几个代理', false); return; }
  PP_SEL = null;
  renderProxyPoolPicker(list);
  $('#dlg-proxy-pool').showModal();
}
function renderProxyPoolPicker(list) {
  const kw = $('#pp-search').value.trim().toLowerCase();
  const filtered = list.filter(x => !kw || (x.label || '').toLowerCase().includes(kw) || String(x.host).toLowerCase().includes(kw));
  $('#pp-list').innerHTML = filtered.map(p => {
    const on = PP_SEL && PP_SEL.id === p.id;
    return `<div class="pp-item ${on ? 'on' : ''}" data-id="${p.id}">
      <div class="pp-meta">
        <div><b>${esc(p.label || '未命名')}</b> <span class="tag-private">${PP_TYPE_NAMES[p.proxy_type]}</span></div>
        <div class="tiny">${esc(p.host)}:${p.port}${p.username ? ' · 用户 ' + esc(p.username) + (p.password ? '（有密码）' : '') : ''}</div>
      </div>
      <div class="pp-radio">${on ? '✓' : ''}</div>
    </div>`;
  }).join('') || '<p class="hint" style="padding:12px">无匹配代理</p>';
  $$('#pp-list .pp-item').forEach(el => el.onclick = () => {
    const id = +el.dataset.id;
    PP_SEL = list.find(x => x.id === id);
    renderProxyPoolPicker(list);
  });
}

$('#pp-search').oninput = async () => {
  const d = await window.jd.listProxies();
  if (d.ok) renderProxyPoolPicker(d.list);
};
$('#pp-cancel').onclick = () => $('#dlg-proxy-pool').close();
$('#pp-x').onclick = () => $('#dlg-proxy-pool').close();
$('#pp-ok').onclick = () => {
  if (!PP_SEL) return toast('请先选择一个代理', false);
  $('#px-type').value = PP_SEL.proxy_type;
  $('#px-host').value = PP_SEL.host;
  $('#px-port').value = PP_SEL.port;
  $('#px-user').value = PP_SEL.username || '';
  $('#px-pass').value = PP_SEL.password || '';
  $('#px-result').textContent = '已应用代理：' + PP_TYPE_NAMES[PP_SEL.proxy_type] + '://' + PP_SEL.host + ':' + PP_SEL.port;
  $('#dlg-proxy-pool').close();
};

$('#px-pool-btn').onclick = openProxyPoolPicker;
$('#px-pool-save-btn').onclick = async () => {
  const pt = +$('#px-type').value, host = $('#px-host').value.trim(), port = +$('#px-port').value;
  if (!pt || !host || !port) return toast('先填写代理类型/主机/端口再保存', false);
  const d = await window.jd.saveProxy({
    label: EDIT_ID ? `环境-${EDIT_ID}` : $('#pf-name').value.trim() || '未命名',
    proxy_type: pt, host, port,
    username: $('#px-user').value.trim() || null,
    password: $('#px-pass').value || null
  });
  if (d.ok) toast('已保存到代理池，以后可直接选择');
  else toast(d.error, false);
};


/* ================= 设置页 ================= */
async function loadSettings() {
  const s = await window.jd.settingsGet();
  $('#st-server').value = s.serverUrl;
  $('#st-chrome').value = s.chromePath || '';
  $('#st-port').value = s.localApiPort;
  $('#st-token').value = s.localApiToken;
  $('#st-datapath').value = s.dataRoot;
  $('#st-geo').checked = !!s.autoGeoMatch;
}
$('#st-detect').onclick = async () => {
  const p = await window.jd.detectChrome();
  if (p) { $('#st-chrome').value = p; toast('检测到内核: ' + p); }
  else toast('未检测到Chrome/Edge，请手动选择', false);
};
$('#st-chrome-pick').onclick = async () => { const d = await window.jd.pickFolder(); if (d) {} };
$('#st-data-pick').onclick = async () => { const d = await window.jd.pickFolder(); if (d) $('#st-datapath').value = d; };
$('#st-data-open').onclick = () => window.jd.openPath($('#st-datapath').value);
$('#st-logs-dir').onclick = () => window.jd.openLogsDir();
$('#st-save').onclick = async () => {
  await window.jd.settingsSet({
    serverUrl: $('#st-server').value.trim(),
    chromePath: $('#st-chrome').value.trim(),
    localApiPort: +$('#st-port').value || 8848,
    dataRoot: $('#st-datapath').value.trim(),
    autoGeoMatch: $('#st-geo').checked
  });
  $('#doc-base').textContent = `http://127.0.0.1:${$('#st-port').value}`;
  $('#st-msg').textContent = '已保存';
  setTimeout(() => $('#st-msg').textContent = '', 2000);
};

// 账号安全：保存安全问题
$('#sec-q-save').onclick = async () => {
  const q = $('#sec-q-new').value.trim(), a = $('#sec-a-new').value;
  const a2 = $('#sec-a-new2').value;
  if (!q) return toast('安全问题必填', false);
  if (!a) return toast('安全答案必填', false);
  if (a !== a2) return toast('两次输入的答案不一致', false);
  const d = await window.jd.setSecurity(q, a);
  if (d.ok) { toast('安全问题已保存'); $('#sec-q-new').value = ''; $('#sec-a-new').value = ''; $('#sec-a-new2').value = ''; refreshMe(); }
  else toast(d.error, false);
};
// 账号安全：修改密码
$('#pwd-save').onclick = async () => {
  const cur = $('#pwd-cur').value;
  const next = $('#pwd-new').value;
  const next2 = $('#pwd-new2').value;
  if (!cur || !next || next.length < 6) return $('#pwd-msg').textContent = '请填写旧密码和新密码（新密码至少6位）';
  if (next !== next2) return $('#pwd-msg').textContent = '两次新密码输入不一致';
  $('#pwd-save').disabled = true;
  const d = await window.jd.changePassword(cur, next);
  $('#pwd-save').disabled = false;
  $('#pwd-msg').textContent = d.ok ? '密码已修改成功' : (d.error || '修改失败');
  $('#pwd-msg').style.color = d.ok ? '#2f9e62' : '#e5484d';
  if (d.ok) { $('#pwd-cur').value = ''; $('#pwd-new').value = ''; $('#pwd-new2').value = ''; }
};

// 忘记密码
$('#lg-forgot').onclick = () => {
  $('#fg-user').value = ''; $('#fg-q').value = ''; $('#fg-a').value = '';
  $('#fg-new').value = ''; $('#fg-new2').value = ''; $('#fg-q-fill').disabled = true;
  $('#dlg-forgot').showModal();
};

// 登录页 · 服务器设置（改地址立即生效）
$('#lg-srv-btn').onclick = async () => {
  const s = await window.jd.settingsGet();
  $('#srv-url').value = s.serverUrl || '';
  $('#srv-msg').textContent = '';
  $('#dlg-srv').showModal();
};
$('#srv-x').onclick = () => $('#dlg-srv').close();
$('#srv-cancel').onclick = () => $('#dlg-srv').close();
$('#srv-save').onclick = async () => {
  const u = $('#srv-url').value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/.+/i.test(u)) {
    $('#srv-msg').style.color = '#e5484d';
    $('#srv-msg').textContent = '地址必须以 http:// 或 https:// 开头';
    return;
  }
  await window.jd.settingsSet({ serverUrl: u });
  $('#srv-url').value = u;
  $('#srv-msg').style.color = '#2f9e62';
  $('#srv-msg').textContent = '已保存：' + u;
};
$('#fg-cancel').onclick = () => $('#dlg-forgot').close();
$('#fg-x').onclick = () => $('#dlg-forgot').close();
$('#fg-user').onblur = async () => {
  const u = $('#fg-user').value.trim();
  if (!u) return;
  const d = await window.jd.securityQuestion(u);
  if (d.ok && d.security_question) {
    $('#fg-q').value = d.security_question;
    $('#fg-q-fill').disabled = false;
    toast('已自动填入此账号的安全问题');
  } else if (d.ok) {
    toast('该账号未设置密码找回安全问题，请联系管理员重置', false);
  } else {
    toast(d.error || '服务不可达，安全问题需手动输入', false);
  }
};
$('#fg-submit').onclick = async () => {
  const u = $('#fg-user').value.trim(), q = $('#fg-q').value.trim(), a = $('#fg-a').value;
  const n1 = $('#fg-new').value, n2 = $('#fg-new2').value;
  if (!u || !q || !a || !n1 || !n2) return toast('请填写所有字段', false);
  if (n1.length < 6) return toast('新密码至少6位', false);
  if (n1 !== n2) return toast('两次新密码不一致', false);
  const d = await window.jd.forgotPassword(u, q, a, n1);
  if (d.ok) { toast('密码已重设成功，请用新密码重新登录'); $('#dlg-forgot').close(); }
  else toast(d.error, false);
};

/* ================= 套餐购买 ================= */
async function loadPlans() {
  const d = await window.jd.plans();
  if (!d.ok) { $('#plan-cards').innerHTML = `<div class="tiny">${esc(d.error || '加载失败')}</div>`; return; }
  $('#plan-cards').innerHTML = d.list.map(p => `
    <div class="plan-card ${p.price > 0 ? 'featured' : ''}">
      <h4>${esc(p.name)}</h4>
      <div class="price">¥${p.price}<small> / ${p.duration_days >= 3650 ? '永久' : p.duration_days + '天'}</small></div>
      <ul>
        <li>环境窗口 ${p.max_profiles} 个</li>
        <li>每日打开 ${p.daily_open_limit} 次</li>
        <li>并发实例 ${p.max_concurrent} 个</li>
        <li>有效期 ${p.duration_days >= 3650 ? '长期有效' : p.duration_days + ' 天'}</li>
      </ul>
      ${p.price > 0
        ? `<button class="btn primary" onclick="buyPlan(${p.id})">立即购买</button>`
        : `<button class="btn" disabled>注册默认套餐</button>`}
    </div>`).join('');
  loadOrders();
}
window.buyPlan = async (id) => {
  const d = await window.jd.createOrder(id);
  if (!d.ok) return toast(d.error, false);
  if (!confirm(`已创建订单 ${d.order.order_no}，金额 ¥${d.order.amount}。\n确认支付？（当前为模拟支付通道，支付后即时生效）`)) return;
  const p = await window.jd.payOrder(d.order.id);
  if (p.ok) { toast('支付成功，套餐已生效'); refreshMe(); loadOrders(); }
  else toast(p.error, false);
};
async function loadOrders() {
  const d = await window.jd.myOrders();
  if (!d.ok) return;
  $('#tb-myorders tbody').innerHTML = d.list.map(o => `<tr>
    <td>${esc(o.order_no)}</td><td>${esc(o.plan_name || '-')}</td><td>¥${o.amount}</td>
    <td class="${o.status === 1 ? 'tag-run' : 'tag-off'}">${o.status === 1 ? '已支付' : (o.status === 0 ? '待支付' : '已取消')}</td>
    <td>${String(o.created_at).slice(0, 16)}</td>
    <td>${o.paid_at ? String(o.paid_at).slice(0, 16) : '-'}</td>
    <td>${o.plan_expire_time ? String(o.plan_expire_time).slice(0, 10) : '-'}</td>
    <td>${o.status === 0 ? `<button class="btn small primary" onclick="payMyOrder(${o.id})">立即支付</button>` : ''}</td>
  </tr>`).join('') || '<tr><td colspan="8">暂无订单</td></tr>';
}
window.payMyOrder = async (id) => {
  const p = await window.jd.payOrder(id);
  if (p.ok) { toast('支付成功，套餐已生效'); refreshMe(); loadOrders(); }
  else toast(p.error, false);
};

/* ================= 团队协作 ================= */
async function loadTeam() {
  const d = await window.jd.teamInfo();
  if (!d.ok) { toast(d.error, false); return; }
  if (!d.team) {
    window.__allowClone = false;
    $('#team-none').classList.remove('hidden');
    $('#team-view').classList.add('hidden');
    renderProfiles();
    return;
  }
  $('#team-none').classList.add('hidden');
  $('#team-view').classList.remove('hidden');
  $('#team-name').textContent = d.team.name;
  $('#team-myrole').textContent = d.myRole === 1 ? '创建者' : '成员';
  $('#team-code').textContent = d.team.invite_code;
  $('#team-owner-actions').classList.toggle('hidden', d.myRole !== 1);
  $('#team-member-actions').classList.toggle('hidden', d.myRole === 1);
  $('#btn-team-rotate').style.display = d.myRole === 1 ? '' : 'none';
  // 多团队切换器（卡片式：点击卡片即切换；当前团队高亮不可点）
  $('#team-switcher').innerHTML = d.teams.map(t => {
    const active = t.id === d.active_team_id;
    const clickAttr = active ? 'title="当前使用的团队"' : `onclick="switchTeamTo(${t.id})" title="点击切换到该团队"`;
    return `<div class="team-card ${active ? 'active' : ''}" ${clickAttr}>
      <div class="tc-name">${esc(t.name)}${active ? ' <span class="tc-check">✓</span>' : ''}</div>
      <div class="tc-meta">${t.role === 1 ? '👑 创建者' : '👤 成员'} · ${t.member_count} 名成员${active ? ' · 使用中' : ' · 点击切换'}</div>
    </div>`;
  }).join('');
  // 团队共享用量（所有成员共享创建者配额）
  const u = d.usage;
  $('#team-usage').textContent = u
    ? `团队共享环境打开次数（全体成员共享创建者配额）：今日 ${u.today} 次 · 本月 ${u.month} 次 · 累计 ${u.total} 次`
    : '';
  // 成员表（含克隆授权列）
  $('#tb-members tbody').innerHTML = d.members.map(m => `<tr>
    <td>${esc(m.username)}${m.user_id === d.team.owner_id ? ' 👑' : ''}</td>
    <td>${m.role === 1 ? '<b>创建者</b>' : '成员'}</td>
    <td>${String(m.joined_at).slice(0, 16)}</td>
    <td>${m.role === 0
      ? (d.myRole === 1
        ? `<button class="btn small ${m.allow_clone ? '' : 'primary'}" onclick="toggleClone(${m.user_id},${m.allow_clone ? 0 : 1})">${m.allow_clone ? '已授权，点击取消' : '未授权，点击授权'}</button>`
        : (m.allow_clone ? '<span class="tag-run">已授权</span>' : '<span class="tag-off">未授权</span>'))
      : '-'}</td>
    <td>${(d.myRole === 1 && m.role !== 1) ? `<button class="btn small danger" onclick="kickMember(${m.user_id})">移除</button>` : '-'}</td>
  </tr>`).join('');
  // 环境授权面板（仅创建者可见，弹窗操作）
  $('#grant-panel').classList.toggle('hidden', d.myRole !== 1);
  // 成员端：克隆按钮可见性
  const mine = d.members.find(m => m.user_id === MY_ID);
  window.__allowClone = !!(mine && mine.allow_clone);
  renderProfiles();
}

// ---- 环境使用授权弹窗：左=我的共享环境，中=所有成员（搜索/全选），右=已选成员标签 ----
const GL = { envs: [], members: [], pid: 0, selected: new Set(), meRole: 0 };

async function openGrantDlg() {
  const [pr, ti] = await Promise.all([window.jd.listProfiles(0), window.jd.teamInfo()]);
  GL.envs = pr.ok ? (pr.list || []).filter(p => (p.is_mine === 1 || p.is_mine === true) && p.team_shared) : [];
  GL.members = ti.ok ? (ti.members || []).filter(m => m.role === 0) : [];
  GL.selected = new Set();
  GL.pid = GL.envs[0] ? GL.envs[0].id : 0;
  $('#gl-search').value = '';
  $('#dlg-grant').showModal();
  renderGrantEnvs();
  renderGrantMemberCols();
  if (GL.pid) await glLoadGrants(GL.pid);
}
async function glLoadGrants(pid) {
  GL.pid = pid;
  GL.selected = new Set();
  renderGrantEnvs();
  const gs = await window.jd.getGrants(pid);
  if (gs.ok) (gs.user_ids || []).forEach(id => GL.selected.add(+id));
  renderGrantMemberCols();
}
function renderGrantEnvs() {
  $('#gl-env-list').innerHTML = GL.envs.map(p =>
    `<div class="gl-env ${p.id === GL.pid ? 'active' : ''}" onclick="glPickEnv(${p.id})">
      <div class="gl-env-name">${esc(p.name)}</div><div class="gl-env-id">#${p.id}</div>
    </div>`).join('') || '<p class="hint" style="padding:12px">暂无共享环境<br>请先在环境列表编辑环境并勾选「团队共享」</p>';
}
function glFilteredMembers() {
  const kw = $('#gl-search').value.trim().toLowerCase();
  return GL.members.filter(m => !kw || String(m.username).toLowerCase().includes(kw));
}
function glMemberName(uid) {
  const m = GL.members.find(x => +x.user_id === +uid);
  return m ? m.username : ('用户#' + uid);
}
function renderGrantMemberCols() {
  const list = glFilteredMembers();
  const emptyMsg = GL.members.length === 0
    ? '该团队暂无其他成员，无需授权（仅创建者）'
    : '暂无匹配成员';
  $('#gl-members').innerHTML = list.map(m => {
    const on = GL.selected.has(+m.user_id);
    return `<div class="gl-member ${on ? 'on' : ''}" onclick="glToggleMember(${m.user_id})">
      <span>${esc(m.username)}</span>${on ? '<span class="gl-tick">✓</span>' : ''}
    </div>`;
  }).join('') || `<p class="hint" style="padding:12px">${emptyMsg}</p>`;
  const all = $('#gl-all');
  all.checked = list.length > 0 && list.every(m => GL.selected.has(+m.user_id));
  $('#gl-sel-count').textContent = GL.selected.size;
  $('#gl-selected').innerHTML = [...GL.selected].map(uid =>
    `<span class="gl-chip">${esc(glMemberName(uid))} <a href="javascript:void(0)" onclick="glToggleMember(${uid})">✕</a></span>`).join('');
  $('#gl-hint').style.display = GL.selected.size ? 'none' : '';
}
window.glPickEnv = (pid) => glLoadGrants(pid);
window.glToggleMember = (uid) => {
  uid = +uid;
  if (GL.selected.has(uid)) GL.selected.delete(uid); else GL.selected.add(uid);
  renderGrantMemberCols();
};
$('#btn-grant-open').onclick = openGrantDlg;
$('#gl-search').oninput = renderGrantMemberCols;
$('#gl-all').onchange = () => {
  const list = glFilteredMembers();
  if ($('#gl-all').checked) list.forEach(m => GL.selected.add(+m.user_id));
  else list.forEach(m => GL.selected.delete(+m.user_id));
  renderGrantMemberCols();
};
$('#gl-clear').onclick = () => { GL.selected.clear(); renderGrantMemberCols(); };
$('#gl-cancel').onclick = () => $('#dlg-grant').close();
$('#gl-x').onclick = () => $('#dlg-grant').close();
$('#gl-save').onclick = async () => {
  if (!GL.pid) return toast('请先选择共享环境', false);
  const ids = [...GL.selected];
  const d = await window.jd.setGrants(GL.pid, ids);
  if (d.ok) { toast(ids.length ? `已授权 ${ids.length} 名成员使用该环境` : '已设为全体成员可用'); $('#dlg-grant').close(); }
  else toast(d.error, false);
};
window.switchTeamTo = async (teamId) => {
  const d = await window.jd.switchTeam(teamId);
  if (d.ok) { toast('已切换当前团队'); loadTeam(); refreshProfiles(); }
  else toast(d.error, false);
};
window.toggleClone = async (uid, allow) => {
  const d = await window.jd.grantClone(uid, allow);
  if (d.ok) { toast(allow ? '已授权该成员克隆共享环境' : '已取消克隆授权'); loadTeam(); }
  else toast(d.error, false);
};
$('#btn-team-create').onclick = async () => {
  const name = $('#team-create-name').value.trim();
  if (!name) return toast('请输入团队名称', false);
  const d = await window.jd.createTeam(name);
  if (d.ok) { toast('团队已创建，邀请码：' + d.invite_code); $('#team-create-name').value = ''; loadTeam(); }
  else toast(d.error, false);
};
$('#btn-team-join').onclick = async () => {
  const code = $('#team-join-code').value.trim();
  if (!code) return toast('请输入邀请码', false);
  const d = await window.jd.joinTeam(code);
  if (d.ok) { toast('已加入团队：' + d.teamName); $('#team-join-code').value = ''; loadTeam(); refreshProfiles(); }
  else toast(d.error, false);
};
// 团队视图内：再创建/再加入团队的内联表单（有团队后 team-none 表单已隐藏，这里保留入口）
$('#btn-team-new2').onclick = () => {
  $('#team-new-form').classList.toggle('hidden');
  $('#team-join-form').classList.add('hidden');
  if (!$('#team-new-form').classList.contains('hidden')) $('#team-create-name2').focus();
};
$('#btn-team-new2-cancel').onclick = () => $('#team-new-form').classList.add('hidden');
$('#btn-team-create2').onclick = async () => {
  const name = $('#team-create-name2').value.trim();
  if (!name) return toast('请输入团队名称', false);
  const d = await window.jd.createTeam(name);
  if (d.ok) {
    toast('团队已创建并切换，邀请码：' + d.invite_code);
    $('#team-create-name2').value = '';
    $('#team-new-form').classList.add('hidden');
    loadTeam(); refreshProfiles();
  } else toast(d.error, false);
};
$('#team-create-name2').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btn-team-create2').click(); });
$('#btn-team-join2').onclick = () => {
  $('#team-join-form').classList.toggle('hidden');
  $('#team-new-form').classList.add('hidden');
  if (!$('#team-join-form').classList.contains('hidden')) $('#team-join-code2').focus();
};
$('#btn-team-join2-cancel').onclick = () => $('#team-join-form').classList.add('hidden');
$('#btn-team-join2-go').onclick = async () => {
  const code = $('#team-join-code2').value.trim();
  if (!code) return toast('请输入邀请码', false);
  const d = await window.jd.joinTeam(code);
  if (d.ok) {
    toast('已加入团队：' + d.teamName + '，并切换为当前团队');
    $('#team-join-code2').value = '';
    $('#team-join-form').classList.add('hidden');
    loadTeam(); refreshProfiles();
  } else toast(d.error, false);
};
$('#team-join-code2').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btn-team-join2-go').click(); });

$('#btn-team-leave').onclick = async () => {
  if (!confirm('确认退出该团队？退出后将无法看到团队共享环境。')) return;
  const d = await window.jd.leaveTeam();
  if (d.ok) { toast('已退出团队'); loadTeam(); refreshProfiles(); } else toast(d.error, false);
};
$('#btn-team-disband').onclick = async () => {
  if (!confirm('确认解散团队？成员将立即失去共享环境访问权限，共享环境自动恢复为私有。')) return;
  const d = await window.jd.disbandTeam();
  if (d.ok) { toast('团队已解散'); loadTeam(); refreshProfiles(); } else toast(d.error, false);
};
$('#btn-team-rotate').onclick = async () => {
  const d = await window.jd.rotateTeamCode();
  if (d.ok) { toast('新邀请码：' + d.invite_code); loadTeam(); } else toast(d.error, false);
};
$('#btn-team-copy').onclick = () => {
  const code = $('#team-code').textContent;
  try {
    navigator.clipboard.writeText(code).then(() => toast('邀请码已复制：' + code));
  } catch {
    const ta = document.createElement('textarea');
    ta.value = code; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove(); toast('邀请码已复制：' + code);
  }
};
window.kickMember = async (uid) => {
  if (!confirm('移除该成员？')) return;
  const d = await window.jd.removeMember(uid);
  if (d.ok) { toast('已移除'); loadTeam(); } else toast(d.error, false);
};

/* ================= 启动 ================= */
(async function init() {
  const me = await window.jd.me();
  if (me.ok) await enterApp();
  // 未登录留在登录页：未登录不可使用浏览器功能
})();

/* ================= 管理员用户管理 ================= */
let ADMIN_USERS = [];

async function loadAdminUsers() {
  const d = await window.jd.adminListUsers();
  if (!d.ok) { toast(d.error || '拉取用户列表失败', false); return; }
  ADMIN_USERS = d.list || [];
  renderAdminUsers();
}
function renderAdminUsers() {
  const kw = ($('#admin-search').value || '').trim().toLowerCase();
  const now = new Date();
  const rows = ADMIN_USERS.filter(u => !kw
    || String(u.username).toLowerCase().includes(kw)
    || String(u.email || '').toLowerCase().includes(kw)
  ).map(u => {
    const locked = u.locked_until && new Date(u.locked_until) > now;
    const status = u.status === 1
      ? '<span class="tag-bad">已冻结</span>'
      : locked
        ? `<span class="tag-bad">锁至 ${u.locked_until.slice(11,16)}</span>`
        : u.login_fail_count > 0
          ? `<span style="color:#b54708">失败${u.login_fail_count}次</span>`
          : '<span class="tag-ok">正常</span>';
    return `<tr>
      <td>${u.id}</td>
      <td>${esc(u.username)}${u.role===1?' <span class="tag-run">👑管理员</span>':''}</td>
      <td>${esc(u.email||'-')}</td>
      <td>${esc(u.plan_name||'免费')}</td>
      <td>${u.max_profiles ?? '-'}</td>
      <td>${u.daily_open_limit ?? '-'}</td>
      <td title="安全问题">${u.security_question ? esc(u.security_question).slice(0,16)+(u.security_question.length>16?'…':'') : '<span style="color:#d4380d">未设</span>'}</td>
      <td>${status}</td>
      <td>${(u.created_at||'').slice(0,10)}</td>
      <td>
        <button class="btn small" onclick="doResetPwd(${u.id},'${esc(u.username)}')">重置密码</button>
        <button class="btn small ${u.status===0?'danger':''}" onclick="doToggleFreeze(${u.id},${u.status===0?1:0})">${u.status===0?'冻结':'解冻'}</button>
      </td></tr>`;
  }).join('') || '<tr><td colspan="10" class="hint">无匹配用户</td></tr>';
  $('#tb-admin-users tbody').innerHTML = rows;
}
window.doResetPwd = async (id, username) => {
  if (!confirm(`确认重置用户「${username}」的密码？\n将自动生成强随机临时密码，该用户所有会话立即下线。`)) return;
  const d = await window.jd.adminResetPassword(id);
  if (!d.ok) return toast(d.error, false);
  const copyable = `用户 ${d.username} 的临时密码（仅本次可见）：\n${d.temp_password}`;
  setTimeout(() => {
    prompt('⚠️ 此临时密码只显示一次，请立即复制：\n用户：' + d.username + '\n\n点击右侧输入框 → Ctrl+A 全选 → Ctrl+C 复制', d.temp_password);
  }, 200);
  toast('已重置！下一个弹窗将显示临时密码，请立即复制发给用户', true);
};
window.doToggleFreeze = async (id, frozen) => {
  if (!confirm(frozen ? '确认冻结该用户？' : '确认解冻该用户？')) return;
  const d = await window.jd.adminToggleFreeze(id, frozen);
  if (d.ok) { toast('操作成功'); loadAdminUsers(); }
  else toast(d.error, false);
};

$('#admin-refresh').onclick = loadAdminUsers;
$('#admin-search').oninput = renderAdminUsers;
$('#admin-open-web').onclick = () => {
  try { window.jd.openPath('http://127.0.0.1:3000/admin/'); } catch {}
};
