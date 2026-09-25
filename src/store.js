const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// 本地设置持久化（内核路径/服务端地址/API端口/本地token/登录态）
class Store {
  constructor() {
    this.dir = path.join(app.getPath('userData'), 'config');
    this.file = path.join(this.dir, 'settings.json');
    this.data = {
      serverUrl: 'https://jindun.ganot.cn:25410',
      chromePath: '',          // Chromium内核路径（留空自动检测）
      localApiPort: 8848,
      localApiToken: require('crypto').randomBytes(16).toString('hex'),
      dataRoot: path.join(app.getPath('userData'), 'profiles'), // 本地缓存数据根目录
      autoGeoMatch: true,      // 启动时GeoIP自动匹配时区/语言/经纬度
      token: '',               // 登录token
      user: null,
      templates: []            // 本地指纹模板
    };
    try { Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch {}
  }
  save() {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
  get(k) { return this.data[k]; }
  set(k, v) { this.data[k] = v; this.save(); }
  // profile 本地数据目录（每个环境独立：Cookie/缓存/标签/下载全部隔离）
  profileDir(uuid) {
    const d = path.join(this.data.dataRoot, String(uuid));
    fs.mkdirSync(d, { recursive: true });
    return d;
  }
  // profile 独立下载目录（位于该环境数据目录内的 downloads 子文件夹）
  downloadsDir(uuid) {
    const d = path.join(this.profileDir(uuid), 'downloads');
    fs.mkdirSync(d, { recursive: true });
    return d;
  }
}

module.exports = Store;
