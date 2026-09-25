// Cookie/缓存 云同步模块：本地快照收集/还原 + AES-256-GCM 加解密
// 服务端只存密文：明文仅在客户端内存中出现；密钥由服务端按环境签发
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

// 不参与同步的缓存/临时目录与文件（Cookie/登录态/偏好设置会同步，纯缓存不同步）
const SKIP_DIRS = new Set([
  'Cache', 'Code Cache', 'GPUCache', 'GrShaderCache', 'ShaderCache', 'DawnCache',
  'DawnGraphiteCache', 'DawnWebGPUCache', 'Media Cache', 'Crashpad', 'CrashpadMetrics',
  'Crash Reports', 'component_crx_cache', 'OptimizationGuidePredictionModels', 'Safe Browsing',
  'FontLookupTableCache', 'CertificateRevocation', 'BrowserMetrics', 'TEMPPERM',
  'SingletonLock', 'SingletonCookie', 'SingletonSocket', 'Lock', 'lockfile'
]);
// cookies.runtime.json 是运行期导出的明文全量Cookie（含会话级鉴权Cookie），仅本机回注用，不上云
const SKIP_FILE_RE = /^(lockfile|LOCK|SingletonLock|SingletonCookie|SingletonSocket|DevToolsActivePort|saved-tabs.json|cookies\.json|cookies\.runtime\.json|ip-info\.html)$/i;
// 浏览器运行期独占/内存映射文件（崩溃统计.pma、SQLite的-wal/-shm等），被锁时直接跳过而非中断整次同步
const SKIP_FILE_SUFFIX_RE = /(\.pma|\.tmp|\.journal)$/i;
const SKIP_FILES = new Set(['lockfile', 'LOCK', 'SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort', 'saved-tabs.json', 'cookies.json', 'cookies.runtime.json']);
const MAX_FILE = 20 * 1024 * 1024;   // 单文件上限20MB
const MAX_TOTAL = 48 * 1024 * 1024;  // 快照总上限48MB（密文base64后约64MB）

// 收集快照：遍历数据目录 → {v:1, files:[{p:相对路径, d:base64内容}]}
function collectSnapshot(dir) {
  const files = [];
  let total = 0;
  function walk(cur, rel) {
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const r = rel ? rel + '/' + ent.name : ent.name;
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        walk(full, r);
      } else if (ent.isFile()) {
        if (SKIP_FILE_RE.test(ent.name) || SKIP_FILE_SUFFIX_RE.test(ent.name)) continue;
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        if (st.size > MAX_FILE) continue; // 超大文件跳过（多为缓存残留）
        let buf;
        try { buf = fs.readFileSync(full); } catch { continue; } // 文件被内核独占锁定（如.pma/SQLite-wal）：跳过该文件而非中断整次同步
        total += buf.length;
        if (total > MAX_TOTAL) throw new Error('本地数据超过48MB，无法云端同步（多为缓存残留，请清理后重试）');
        files.push({ p: r.replace(/\\/g, '/'), d: buf.toString('base64') });
      }
    }
  }
  walk(dir, '');
  return { v: 1, files };
}

// 还原快照：按清单覆盖写入（不删除清单外文件，避免误删本地新增数据；被锁的缓存类文件跳过，不影响登录态还原）
function applySnapshot(dir, manifest) {
  if (!manifest || manifest.v !== 1 || !Array.isArray(manifest.files)) throw new Error('快照格式无效');
  for (const f of manifest.files) {
    const name = f.p.split('/').pop() || '';
    if (SKIP_FILE_RE.test(name) || SKIP_FILE_SUFFIX_RE.test(name)) continue;
    try {
      const dest = path.join(dir, ...f.p.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, Buffer.from(f.d, 'base64'));
    } catch { /* 个别文件被内核/杀软占用时跳过，关键登录态文件（Cookies/Login Data）不受影响 */ }
  }
}

// AES-256-GCM 加密：密钥hex → { iv, tag, data }（全部base64）
function encryptSnapshot(keyHex, manifest) {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) throw new Error('加密密钥无效');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const raw = zlib.gzipSync(Buffer.from(JSON.stringify(manifest)));
  const enc = Buffer.concat([cipher.update(raw), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: enc.toString('base64')
  };
}

// AES-256-GCM 解密（tag校验失败会抛错，防篡改）→ 快照对象
function decryptSnapshot(keyHex, payload) {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) throw new Error('加密密钥无效');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  const raw = Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]);
  return JSON.parse(zlib.gunzipSync(raw).toString('utf8'));
}

module.exports = { collectSnapshot, applySnapshot, encryptSnapshot, decryptSnapshot };
