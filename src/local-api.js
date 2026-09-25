// 本地自动化API服务：兼容 puppeteer / playwright
// 所有接口需携带 X-Local-Token（与软件设置中的Token一致）
// 启动/停止统一走主进程的 startOne/stopOne（含IP强检、云同步、关单）
const express = require('express');
const { listRunning } = require('./launcher');
const api = require('./server-api');

function createLocalApi(store, hooks = {}) {
  const app = express();
  app.use(express.json());

  // 本地鉴权
  app.use((req, res, next) => {
    if (req.path === '/health') return next();
    if (req.headers['x-local-token'] !== store.get('localApiToken')) {
      return res.status(401).json({ ok: false, error: '本地Token无效' });
    }
    if (!store.get('token')) return res.status(403).json({ ok: false, error: '客户端未登录云端账号' });
    next();
  });

  app.get('/health', (req, res) => res.json({ ok: true, name: 'jindun-local-api', version: '1.0.0' }));

  // 环境列表
  app.get('/api/v1/profiles', async (req, res) => {
    try {
      const d = await api.listProfiles(req.query.trash === '1' ? 1 : 0);
      res.json({ ok: true, list: d.list.map(p => ({ id: p.id, name: p.name, running: !!listRunning().find(r => r.profileId === p.id) })) });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // 启动实例（返回CDP websocket地址）
  app.post('/api/v1/profiles/:id/start', async (req, res) => {
    try {
      const d = await api.listProfiles(0);
      const p = d.list.find(x => x.id === +req.params.id);
      if (!p) return res.status(404).json({ ok: false, error: 'profile不存在' });
      if (hooks.startOne) {
        const r = await hooks.startOne(p);
        res.json({ ok: true, profile_id: p.id, wsEndpoint: r.wsEndpoint, ws: r.wsEndpoint, http: r.httpEndpoint || '', debugPort: r.debugPort || 0 });
      } else {
        const chk = await api.checkQuota('open');
        if (!chk.ok || !chk.allowed) return res.status(403).json({ ok: false, error: chk.error || '配额不足' });
        const r = await require('./launcher').launchProfile(p, { chromePath: store.get('chromePath'), autoGeoMatch: store.get('autoGeoMatch') }, store);
        if (!r.ok) return res.status(502).json({ ok: false, error: r.error || '启动失败' });
        await api.recordOpen(p.id);
        res.json({ ok: true, profile_id: p.id, wsEndpoint: r.wsEndpoint, ws: r.wsEndpoint, http: r.httpEndpoint || '', debugPort: r.debugPort || 0 });
      }
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // 停止实例
  app.post('/api/v1/profiles/:id/stop', async (req, res) => {
    try {
      const r = hooks.stopOne ? await hooks.stopOne(+req.params.id) : await require('./launcher').closeProfile(+req.params.id);
      res.json(r);
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // 批量启动
  app.post('/api/v1/profiles/batch-start', async (req, res) => {
    const ids = req.body.ids || [];
    const results = [];
    for (const id of ids) {
      try {
        const d = await api.listProfiles(0);
        const p = d.list.find(x => x.id === +id);
        if (!p) { results.push({ id, ok: false, error: '不存在' }); continue; }
        const r = await (hooks.startOne ? hooks.startOne(p) : (async () => {
          const chk = await api.checkQuota('open');
          if (!chk.ok || !chk.allowed) throw new Error(chk.error || '配额不足');
          return require('./launcher').launchProfile(p, { chromePath: store.get('chromePath'), autoGeoMatch: store.get('autoGeoMatch') }, store);
        })());
        if (hooks.startOne && r && !r.ok) { results.push({ id, ok: false, error: r.error }); continue; }
        if (!hooks.startOne) await api.recordOpen(p.id);
        results.push({ id, ok: true, ws: r.wsEndpoint, http: r.httpEndpoint || '', debugPort: r.debugPort || 0 });
      } catch (e) { results.push({ id, ok: false, error: e.message }); }
    }
    res.json({ ok: true, results });
  });

  // 批量关闭
  app.post('/api/v1/profiles/batch-stop', async (req, res) => {
    const ids = req.body.ids || [];
    for (const id of ids) {
      try { if (hooks.stopOne) await hooks.stopOne(+id); else await require('./launcher').closeProfile(+id); } catch {}
    }
    res.json({ ok: true });
  });

  // 查询运行中实例
  app.get('/api/v1/profiles/running', (req, res) => {
    res.json({ ok: true, list: listRunning() });
  });

  // 扩展批量安装：为多个profile追加扩展路径
  app.post('/api/v1/profiles/extensions', async (req, res) => {
    try {
      const { ids, extensions } = req.body; // extensions: 本地扩展目录绝对路径数组
      const d = await api.listProfiles(0);
      const results = [];
      for (const id of ids) {
        const p = d.list.find(x => x.id === +id);
        if (!p) continue;
        const fp = p.fingerprint_config || {};
        const set = new Set([...(fp.extensions || []), ...(extensions || [])]);
        fp.extensions = [...set];
        await api.updateProfile(p.id, { fingerprint_config: fp });
        results.push({ id, ok: true });
      }
      res.json({ ok: true, results });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  return app;
}

module.exports = { createLocalApi };
