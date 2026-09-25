// 服务端API客户端（携带登录token）
const fetch = require('node-fetch');

class ServerApi {
  constructor() { this.baseUrl = ''; this.token = ''; }
  setup(baseUrl, token) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
  }
  async req(method, path, body) {
    const res = await fetch(this.baseUrl + '/api' + path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.token },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json();
    if (res.status === 401) { const e = new Error(data.error || '登录已过期'); e.code = 401; throw e; }
    return data;
  }
  login(username, password, deviceInfo) { return this.req('POST', '/auth/login', { username, password, deviceInfo }); }
  register(username, password, email, security_question, security_answer) {
    const body = { username, password, email };
    if (security_question) body.security_question = security_question;
    if (security_answer) body.security_answer = security_answer;
    return this.req('POST', '/auth/register', body);
  }
  me() { return this.req('GET', '/auth/me'); }
  logout() { return this.req('POST', '/auth/logout', {}).catch(() => {}); }

  checkQuota(action, profileId) { return this.req('POST', '/quota/check', { action, profile_id: profileId || undefined }); }
  recordOpen(profileId) { return this.req('POST', '/quota/open', { profile_id: profileId }); }
  recordClose(profileId) { return this.req('POST', '/quota/close', { profile_id: profileId }); }

  listProfiles(trash = 0) { return this.req('GET', `/profiles?trash=${trash}`); }
  createProfile(p) { return this.req('POST', '/profiles', p); }
  updateProfile(id, p) { return this.req('PUT', `/profiles/${id}`, p); }
  deleteProfile(id) { return this.req('DELETE', `/profiles/${id}`); }
  restoreProfile(id) { return this.req('POST', `/profiles/${id}/restore`, {}); }
  purgeProfile(id) { return this.req('DELETE', `/profiles/${id}/purge`); }
  cloneProfile(id) { return this.req('POST', `/profiles/${id}/clone`, {}); }
  importProfiles(items) { return this.req('POST', '/profiles/import', { items }); }
  getSync(id) { return this.req('GET', `/profiles/${id}/sync`); }
  putSync(id, payload) { return this.req('PUT', `/profiles/${id}/sync`, payload); }

  plans() { return this.req('GET', '/plans'); }
  myOrders() { return this.req('GET', '/orders/mine'); }
  createOrder(planId) { return this.req('POST', '/orders', { plan_id: planId }); }
  payOrder(id) { return this.req('POST', `/orders/${id}/pay`, {}); }

  teamInfo() { return this.req('GET', '/team/info'); }
  createTeam(name) { return this.req('POST', '/team/create', { name }); }
  joinTeam(code) { return this.req('POST', '/team/join', { invite_code: code }); }
  leaveTeam() { return this.req('POST', '/team/leave', {}); }
  disbandTeam() { return this.req('POST', '/team/disband', {}); }
  rotateTeamCode() { return this.req('POST', '/team/rotate-code', {}); }
  removeMember(userId) { return this.req('DELETE', `/team/members/${userId}`, {}); }
  switchTeam(teamId) { return this.req('POST', '/team/switch', { team_id: teamId }); }
  grantClone(userId, allow) { return this.req('POST', '/team/grant-clone', { user_id: userId, allow: allow ? 1 : 0 }); }
  getGrants(profileId) { return this.req('GET', `/team/grants?profile_id=${profileId}`); }
  setGrants(profileId, userIds) { return this.req('POST', '/team/grants', { profile_id: profileId, user_ids: userIds }); }

  // 代理池
  listProxies() { return this.req('GET', '/proxies'); }
  saveProxy(p) { return this.req('POST', '/proxies', p); }
  saveProxies(items) { return this.req('POST', '/proxies/batch', items); }
  deleteProxy(id) { return this.req('DELETE', `/proxies/${id}`, {}); }

  // 密码 / 安全问题
  setSecurity(question, answer) { return this.req('POST', '/auth/set-security', { security_question: question, security_answer: answer }); }
  changePassword(current, next) { return this.req('POST', '/auth/change-password', { current_password: current, new_password: next }); }
  forgotPassword(username, question, answer, newPwd) { return this.req('POST', '/auth/forgot-password', { username, security_question: question, security_answer: answer, new_password: newPwd }); }

  appUpdate() { return this.req('GET', '/app/update'); }
  announcements() { return this.req('GET', '/app/announcements'); }

  // 管理员 API（Express 侧已用 adminOnly 中间件保护）
  adminListUsers() { return this.req('GET', '/admin/users'); }
  adminResetUserPassword(id) { return this.req('POST', `/admin/users/${id}/reset-password`, {}); }
  adminToggleFreeze(id, frozen) { return this.req('PUT', `/admin/users/${id}`, { status: frozen ? 1 : 0 }); }
  adminEditUserQuota(id, q) { return this.req('PUT', `/admin/users/${id}/quota`, q); }
}

module.exports = new ServerApi();
