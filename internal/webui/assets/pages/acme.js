// nunt 前端页面模块：acme.js
//
// 阶段 2 批次 C：渲染层迁移到 kit（组件层），数据流与接口一字未改。
//   * 证书任务表 / 证书列表换成 nunt-table：操作列走 actions（右对齐、不换行），
//     列标题全部有文字，消掉迁移前的 empty-table-header；
//   * 新建 / 编辑任务走 openDialog + formGrid（域名多行、密钥类型、挑战方式、DNS 提供商与
//     由 /api/v1/ddns/providers 元数据动态生成的凭据表单、解析服务器、续期天数），
//     选 dns-01 才显示 DNS 字段（迁移前同款联动）；
//   * 剩余天数用 sl-progress-bar + 剩余天数文案（沿用「按 90 天有效期估算」的口径）；
//   * 签发走 POST /api/v1/acme/jobs/{id}/issue（异步）：每 5 秒轮询 /certificates，
//     出现该域名即结束，期间显示进度、可取消等待（清理函数会停掉轮询）；
//   * 上传证书对话框保留 PEM 两个文本域 + 文件选择读为文本 + 域名，提交体保持多别名写法；
//   * 删除确认走 confirmDialog，空 / 加载 / 错误态走 nunt-empty / nunt-loading / nunt-error；
//   * 卡片标题一律 h2，页面私有样式用 pacme- 前缀并随 mount 的清理函数移除。
//
// 接口与提交体形状与迁移前逐条一致：
//   GET/POST/PUT/DELETE /api/v1/acme/jobs[/{id}]、POST /api/v1/acme/jobs/{id}/toggle
//   POST /api/v1/acme/jobs/{id}/issue、GET /api/v1/acme/certificates
//   DELETE /api/v1/acme/certificates/{id}、POST /api/v1/acme/certificates/upload
//   GET  /api/v1/ddns/providers（DNS 凭据表单的元数据来源）
// 任务提交体：name/enable/domains/keyType/challenge/dnsProvider/dnsCreds/dnsResolvers/
//             renewDays/remark；上传提交体：name/domains/cert/certificate/key/privateKey/chain。
import {
  NuntElement, html, nothing, define, renderInto, formGrid, openDialog, confirmDialog, toast,
  errorMessage, fmtTime,
} from '../lib/kit.js';

const EOL = String.fromCharCode(10);
const TAB = String.fromCharCode(9);
const ISSUE_POLL_MS = 5000;

const CHALLENGE_LABEL = { 'http-01': 'HTTP-01', 'dns-01': 'DNS-01', 'tls-alpn-01': 'TLS-ALPN-01' };
const KEY_LABEL = { ecdsa: 'ECDSA P-256', rsa2048: 'RSA 2048', rsa4096: 'RSA 4096' };

const CHALLENGE_OPTIONS = [
  { value: 'http-01', label: 'HTTP-01（需要 80 端口可访问）' },
  { value: 'dns-01', label: 'DNS-01（泛域名必须用这个）' },
  { value: 'tls-alpn-01', label: 'TLS-ALPN-01（需要 443 端口）' },
];

const KEY_OPTIONS = [
  { value: '', label: '使用全局默认' },
  { value: 'ecdsa', label: 'ECDSA P-256' },
  { value: 'rsa2048', label: 'RSA 2048' },
  { value: 'rsa4096', label: 'RSA 4096' },
];

/* ------------------------------------------------------------------ 局部样式 */

const PAGE_CSS = [
  '.pacme-name{font-weight:600;word-break:break-word}',
  '.pacme-remark{font-size:11px;color:var(--text-faint);word-break:break-word}',
  '.pacme-chips{display:flex;flex-wrap:wrap;gap:4px}',
  '.pacme-ip{font-family:var(--sl-font-mono);font-size:12.5px;word-break:break-all}',
  '.pacme-switch{font-size:12px}',
  '.pacme-note{margin:0 0 10px;font-size:12.5px;color:var(--text-dim)}',
  '.pacme-creds{margin-bottom:4px}',
  '.pacme-legend{font-size:12px;font-weight:600;color:var(--text-dim);margin:6px 0 8px}',
  '.pacme-days{display:flex;align-items:center;gap:8px;min-width:150px}',
  '.pacme-bar{flex:1 1 auto;min-width:90px;--height:8px;--track-color:var(--line);--indicator-color:var(--ok)}',
  '.pacme-bar.is-warn{--indicator-color:var(--warn)}',
  '.pacme-bar.is-err{--indicator-color:var(--err)}',
  '.pacme-bar.is-neutral{--indicator-color:var(--sl-color-neutral-400)}',
  '.pacme-daystext{font-size:12.5px;white-space:nowrap}',
  '.pacme-pem{display:flex;flex-direction:column;gap:6px;align-items:flex-start}',
  '.pacme-pem sl-textarea{width:100%}',
  '.pacme-progress{--height:6px;margin:4px 0 10px}',
].join(EOL);

function pageStyle(root, css) {
  if (!css) return () => {};
  const tag = document.createElement('style');
  tag.textContent = css;
  root.appendChild(tag);
  return () => { if (tag.parentNode) tag.parentNode.removeChild(tag); };
}

/* ------------------------------------------------------------------ 纯函数（语义与迁移前一致） */

function unwrap(data, keys) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const key of (keys || ['items', 'list', 'data'])) {
      if (Array.isArray(data[key])) return data[key];
    }
  }
  return [];
}

// splitLines / splitDomains：换行、逗号（上传的域名还接受空白）分隔，避免正则转义。
function splitLines(value) {
  return String(value === undefined || value === null ? '' : value)
    .split(EOL).join(',')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function splitDomains(value) {
  return String(value === undefined || value === null ? '' : value)
    .split(EOL).join(',')
    .split(TAB).join(',')
    .split(' ').join(',')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function certDomains(c) {
  const list = c.domains || (c.domain ? [c.domain] : []);
  return list.filter((x) => x);
}

// baseDomain：去掉通配前缀（迁移前是 replace(/^\*\./, '')）。
function baseDomain(value) {
  const text = String(value === undefined || value === null ? '' : value);
  return text.slice(0, 2) === '*.' ? text.slice(2) : text;
}

function certExpiry(c) {
  return c.notAfter || c.expiresAt || c.expiry || c.expireTime || c.validTo || null;
}

function certRemainDays(c) {
  const direct = c.remainDays !== undefined ? c.remainDays : (c.remainingDays !== undefined ? c.remainingDays : (c.daysLeft !== undefined ? c.daysLeft : undefined));
  if (direct !== undefined && direct !== null) return Number(direct);
  const exp = certExpiry(c);
  if (!exp) return null;
  const d = new Date(exp);
  if (isNaN(d.getTime())) return null;
  return Math.round((d.getTime() - Date.now()) / 86400000);
}

// daysPercent / daysTone：迁移前的进度条口径（按 90 天有效期估算），换成 sl-progress-bar。
function daysPercent(days) {
  if (days === null || days === undefined || !isFinite(days)) return null;
  return Math.max(0, Math.min(100, (days / 90) * 100));
}

function daysTone(days) {
  if (days === null || days === undefined || !isFinite(days)) return 'neutral';
  if (days <= 0) return 'err';
  if (days <= 15) return 'warn';
  return 'ok';
}

function dateAgo(t) {
  if (!t) return '-';
  const date = (t instanceof Date) ? t : new Date(String(t));
  if (isNaN(date.getTime())) return String(t);
  const secs = Math.floor((Date.now() - date.getTime()) / 1000);
  if (secs < 0) return fmtTime(t);
  if (secs < 60) return secs + ' 秒前';
  if (secs < 3600) return Math.floor(secs / 60) + ' 分钟前';
  if (secs < 86400) return Math.floor(secs / 3600) + ' 小时前';
  return Math.floor(secs / 86400) + ' 天前';
}

function certPairs(c) {
  const cert = c || {};
  const days = certRemainDays(cert);
  return [
    { key: 'domains', label: '域名', value: certDomains(cert).join(', ') || '-', mono: true },
    { key: 'issuer', label: '签发者', value: cert.issuer || cert.ca || '-' },
    { key: 'expiry', label: '到期时间', value: fmtTime(certExpiry(cert)) },
    { key: 'remain', label: '剩余', value: (days === null || days === undefined || !isFinite(days)) ? '-' : String(days) + ' 天' },
  ];
}

// --- DNS 提供商元数据（与 ddns 页同一份 /api/v1/ddns/providers） -----------------

function fallbackProviderFields(id) {
  const map = {
    cloudflare: [{ key: 'token', label: 'API Token', secret: true, required: true, placeholder: 'Zone.DNS 编辑权限的 API Token' }],
    alidns: [{ key: 'accessKeyId', label: 'AccessKey ID', required: true }, { key: 'accessKeySecret', label: 'AccessKey Secret', secret: true, required: true }],
    dnspod: [{ key: 'id', label: 'SecretId', required: true }, { key: 'token', label: 'SecretKey', secret: true, required: true }],
    godaddy: [{ key: 'key', label: 'API Key', required: true }, { key: 'secret', label: 'API Secret', secret: true, required: true }],
    porkbun: [{ key: 'apiKey', label: 'API Key', required: true }, { key: 'secretKey', label: 'Secret Key', secret: true, required: true }],
    huawei: [{ key: 'accessKeyId', label: 'AccessKey ID', required: true }, { key: 'secretAccessKey', label: 'Secret Access Key', secret: true, required: true }],
    callback: [{ key: 'url', label: '回调地址', required: true, placeholder: 'https://example.com/ddns?ip={ip}' }],
  };
  return map[id] || null;
}

function normalizeProviders(data) {
  return unwrap(data, ['providers', 'items']).map((p) => ({
    id: p.id || p.name || p.provider,
    title: p.title || p.label || p.name || p.id || p.provider,
    fields: (p.fields || []).map((f) => ({
      key: f.key,
      label: f.label || f.key,
      secret: !!f.secret,
      required: !!f.required,
      placeholder: f.placeholder || '',
      help: f.help || '',
    })),
    authNote: p.authNote || p.note || '',
  })).filter((p) => p.id);
}

let providerCache = null;
let providerFinal = false;
let providerInflight = null;

// loadDNSProviders 带缓存：404 视为该接口不存在并记住，其它失败下次重试（迁移前同款）。
async function loadDNSProviders(api) {
  if (providerCache && providerCache.length) return providerCache;
  if (providerFinal) return providerCache || [];
  if (providerInflight) return providerInflight;
  providerInflight = (async () => {
    try {
      const data = await api.get('/api/v1/ddns/providers');
      const list = normalizeProviders(data);
      providerCache = list;
      providerFinal = true;
      return list;
    } catch (err) {
      if (err && (err.notFound === true || err.status === 404)) {
        providerFinal = true;
        providerCache = [];
        return [];
      }
      return [];
    } finally {
      providerInflight = null;
    }
  })();
  return providerInflight;
}

/* ------------------------------------------------------------------ PEM 文本域 + 文件选择 */

// pemBox：一个带「选择文件…」按钮的 PEM 文本域。读文件用 FileReader.readAsText，
// 与迁移前一致（不新增接口、不产生外部请求）。
function pemBox(label, placeholder) {
  const box = document.createElement('div');
  box.className = 'pacme-pem';

  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = '.pem,.crt,.cer,.key,.txt';
  picker.style.display = 'none';

  const area = document.createElement('sl-textarea');
  area.setAttribute('label', label);
  area.setAttribute('rows', '6');
  area.setAttribute('placeholder', placeholder);
  area.setAttribute('help-text', '可以直接粘贴 PEM 文本，也可以用「选择文件…」把文件读成文本');

  const pick = document.createElement('sl-button');
  pick.setAttribute('size', 'small');
  pick.textContent = '选择文件…';
  pick.addEventListener('click', () => picker.click());
  picker.addEventListener('change', () => {
    const file = picker.files && picker.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      area.value = String(reader.result || '');
      toast('已读取文件 ' + file.name, 'ok');
    };
    reader.onerror = () => toast('读取文件失败', 'err');
    reader.readAsText(file);
  });

  box.appendChild(pick);
  box.appendChild(picker);
  box.appendChild(area);
  return { box, area };
}

/* ------------------------------------------------------------------ 页面 */

class AcmePage extends NuntElement {
  static properties = {
    jobs: { attribute: false },
    jobsLoading: { type: Boolean },
    jobsError: { attribute: false },
    certs: { attribute: false },
    certsLoading: { type: Boolean },
    certsError: { attribute: false },
    busyId: { type: String },
  };

  constructor() {
    super();
    this.ctx = null;
    this.jobs = [];
    this.jobsLoading = true;
    this.jobsError = null;
    this.certs = [];
    this.certsLoading = true;
    this.certsError = null;
    this.busyId = '';
    this.providers = [];
    this.pollers = new Set();
    this.dialogHosts = new Set();
    this.dialogs = new Set();
    this.disposed = false;
  }

  connectedCallback() {
    super.connectedCallback();
    this.loadProviders();
    this.loadJobs();
    this.loadCerts();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.disposed = true;
  }

  /** dispose 由 mount 返回的清理函数调用：停掉签发轮询、关掉对话框、移除元素。 */
  dispose() {
    this.disposed = true;
    this.stopPollers();
    for (const host of Array.from(this.dialogHosts)) {
      try { renderInto(host, nothing); } catch (err) { /* 忽略 */ }
    }
    this.dialogHosts.clear();
    for (const dialog of Array.from(this.dialogs)) {
      try { dialog.close(); } catch (err) { /* 忽略 */ }
    }
    this.dialogs.clear();
    this.remove();
  }

  stopPollers() {
    for (const stop of Array.from(this.pollers)) {
      try { stop(); } catch (err) { /* 忽略 */ }
    }
    this.pollers.clear();
  }

  openPageDialog(options) {
    const api = openDialog(options);
    this.dialogs.add(api);
    if (api.dialog) api.dialog.addEventListener('sl-after-hide', () => this.dialogs.delete(api));
    return api;
  }

  /* ---------------------------------------------------------------- 取数 */

  async loadProviders() {
    try {
      const list = await loadDNSProviders(this.ctx.api);
      if (this.disposed) return;
      this.providers = list;
    } catch (err) {
      // 提供商列表拿不到时凭据表单退回 fallbackProviderFields。
    }
  }

  async loadJobs() {
    this.jobsLoading = true;
    try {
      const data = await this.ctx.api.get('/api/v1/acme/jobs');
      if (this.disposed) return;
      this.jobs = unwrap(data, ['jobs', 'items']);
      this.jobsError = null;
    } catch (err) {
      if (this.disposed) return;
      this.jobs = [];
      this.jobsError = err;
    } finally {
      if (!this.disposed) this.jobsLoading = false;
    }
  }

  async loadCerts() {
    this.certsLoading = true;
    try {
      const data = await this.ctx.api.get('/api/v1/acme/certificates');
      if (this.disposed) return;
      this.certs = unwrap(data, ['certificates', 'items']);
      this.certsError = null;
    } catch (err) {
      if (this.disposed) return;
      this.certs = [];
      this.certsError = err;
    } finally {
      if (!this.disposed) this.certsLoading = false;
    }
  }

  loadAll() {
    this.loadJobs();
    this.loadCerts();
  }

  /* ---------------------------------------------------------------- 动作 */

  async toggleJob(job, next) {
    const want = (next === undefined) ? !job.enable : !!next;
    this.busyId = String(job.id || '');
    try {
      try {
        await this.ctx.api.post('/api/v1/acme/jobs/' + encodeURIComponent(job.id) + '/toggle');
      } catch (err) {
        // 兼容没有 toggle 路由的旧后端：退回整条任务的更新（与迁移前一致）。
        await this.ctx.api.put('/api/v1/acme/jobs/' + encodeURIComponent(job.id), Object.assign({}, job, { enable: want }));
      }
      if (this.disposed) return;
      toast(want ? '已启用' : '已停用', 'ok');
      await this.loadJobs();
    } catch (err) {
      if (this.disposed) return;
      toast('切换失败：' + errorMessage(err), 'err');
    } finally {
      if (!this.disposed) this.busyId = '';
    }
  }

  async removeJob(job) {
    const ok = await confirmDialog('确定删除证书任务「' + (job.name || job.id) + '」吗？已签发的证书不会被删除。', { danger: true, okLabel: '删除' });
    if (!ok) return;
    try {
      await this.ctx.api.del('/api/v1/acme/jobs/' + encodeURIComponent(job.id));
      if (this.disposed) return;
      toast('已删除', 'ok');
      await this.loadJobs();
    } catch (err) {
      if (this.disposed) return;
      toast('删除失败：' + errorMessage(err), 'err');
    }
  }

  async removeCert(cert) {
    const label = certDomains(cert).join(', ') || cert.name || cert.id;
    const ok = await confirmDialog('确定删除证书「' + label + '」吗？使用该证书的站点会失去 TLS。', { danger: true, okLabel: '删除' });
    if (!ok) return;
    try {
      await this.ctx.api.del('/api/v1/acme/certificates/' + encodeURIComponent(cert.id || cert.name));
      if (this.disposed) return;
      toast('已删除', 'ok');
      await this.loadCerts();
    } catch (err) {
      if (this.disposed) return;
      toast('删除失败：' + errorMessage(err), 'err');
    }
  }

  /* ---------------------------------------------------------------- 任务表单 */

  openJobForm(job) {
    const base = job || {};
    const editing = !!base.id;
    const providers = Array.isArray(this.providers) ? this.providers : [];
    const creds = Object.assign({}, base.dnsCreds || {});
    const initialProvider = base.dnsProvider || '';

    // DNS 凭据：字段由 /api/v1/ddns/providers 的元数据决定，换提供商时整块重建。
    const credsHost = document.createElement('div');
    credsHost.className = 'pacme-creds';
    let credForm = null;
    let credFields = [];

    const paintCreds = (providerId) => {
      const meta = providers.filter((p) => p.id === providerId)[0] || null;
      const fields = providerId ? ((meta && meta.fields.length) ? meta.fields : (fallbackProviderFields(providerId) || [])) : [];
      credForm = null;
      credFields = fields;
      while (credsHost.firstChild) credsHost.removeChild(credsHost.firstChild);
      if (!providerId) {
        const note = document.createElement('p');
        note.className = 'pacme-note';
        note.textContent = '选择 DNS 提供商后，这里会按它的元数据生成凭据字段。';
        credsHost.appendChild(note);
        return;
      }
      if (!fields.length) {
        const note = document.createElement('p');
        note.className = 'pacme-note';
        note.textContent = '未获取到该提供商的凭据说明（/ddns/providers 可能不可用）。';
        credsHost.appendChild(note);
        return;
      }
      credForm = formGrid(fields.map((f) => ({
        name: 'cred_' + f.key,
        label: f.label + (f.required ? ' *' : ''),
        type: f.secret ? 'password' : 'text',
        value: creds[f.key] || '',
        placeholder: f.placeholder || (editing ? '留空表示不修改' : ''),
        autocomplete: 'new-password',
        hint: f.help || (f.secret ? '密钥不会明文回显，留空表示不修改' : ''),
      })));
      credsHost.appendChild(credForm.node);
      if (meta && meta.authNote) {
        const note = document.createElement('p');
        note.className = 'pacme-note';
        note.textContent = meta.authNote;
        credsHost.appendChild(note);
      }
    };
    paintCreds(initialProvider);

    const form = formGrid([
      { name: 'name', label: '名称', value: base.name || '', placeholder: '例如 主站证书' },
      { name: 'enable', label: '启用', type: 'switch', value: base.enable !== false, text: '启用（参与自动续期）' },
      { name: 'domains', label: '域名', type: 'textarea', rows: 4, wide: true, value: (base.domains || []).join(EOL), placeholder: '每行一个域名：' + EOL + 'example.com' + EOL + '*.example.com', hint: '每行一个；泛域名必须使用 DNS-01' },
      { name: 'keyType', label: '密钥类型', type: 'select', value: base.keyType || '', options: KEY_OPTIONS },
      {
        name: 'challenge',
        label: '挑战方式',
        type: 'select',
        value: base.challenge || 'http-01',
        options: CHALLENGE_OPTIONS,
        onChange: (value) => paintChallenge(String(value || 'http-01')),
      },
      { name: 'renewDays', label: '续期提前天数', type: 'number', min: 1, value: String(base.renewDays || 30), placeholder: '30' },

      legendFieldJob('legendDns', 'DNS 挑战'),
      {
        name: 'dnsProvider',
        label: 'DNS 提供商',
        type: 'select',
        value: initialProvider,
        options: [{ value: '', label: '（不使用 DNS 提供商）' }].concat(providers.length
          ? providers.map((p) => ({ value: p.id, label: p.title }))
          : (base.dnsProvider ? [{ value: base.dnsProvider, label: base.dnsProvider + '（未获取到提供商列表）' }] : [])),
        hint: '用于自动添加 TXT 记录',
        onChange: (value) => paintCreds(String(value || '')),
      },
      { name: 'dnsResolvers', label: '解析服务器', type: 'textarea', rows: 2, wide: true, value: (base.dnsResolvers || []).join(EOL), placeholder: '每行一个 DNS 解析服务器：' + EOL + '1.1.1.1:53' + EOL + '8.8.8.8:53', hint: '校验时使用的 DNS 服务器' },
      { name: 'dnsCreds', label: false, type: 'custom', wide: true, node: credsHost },

      legendFieldJob('legendOther', '其他'),
      { name: 'remark', label: '备注', value: base.remark || '', placeholder: '备注（可选）', wide: true },
    ]);

    // 选 dns-01 才显示 DNS 字段（迁移前同款联动；值仍然照旧提交）。
    function paintChallenge(value) {
      const isDNS = value === 'dns-01';
      form.toggle('dnsProvider', isDNS);
      form.toggle('dnsResolvers', isDNS);
      form.toggle('dnsCreds', isDNS);
    }
    paintChallenge(String(base.challenge || 'http-01'));

    this.openPageDialog({
      title: editing ? '编辑证书任务' : '新建证书任务',
      body: form.node,
      wide: true,
      actions: [
        { label: '取消' },
        {
          label: '保存',
          kind: 'primary',
          close: false,
          onClick: async (dlg, button) => {
            form.clearErrors();
            const values = form.read();
            const name = String(values.name || '').trim();
            const list = splitLines(values.domains);
            const challenge = String(values.challenge || 'http-01');
            const dnsProvider = String(values.dnsProvider || '').trim();
            if (!name) { form.fieldError('name', '请填写任务名称'); return; }
            if (!list.length) { form.fieldError('domains', '请至少填写一个域名'); return; }
            if (challenge === 'dns-01' && !dnsProvider) { form.fieldError('dnsProvider', 'DNS-01 挑战需要选择 DNS 提供商'); return; }

            const outCreds = Object.assign({}, creds);
            if (credForm) {
              const credValues = credForm.read();
              for (const field of credFields) {
                const value = String(credValues['cred_' + field.key] || '').trim();
                if (value) outCreds[field.key] = value;
              }
            }
            const payload = {
              name,
              enable: !!values.enable,
              domains: list,
              keyType: String(values.keyType || ''),
              challenge: challenge || 'http-01',
              dnsProvider,
              dnsCreds: outCreds,
              dnsResolvers: splitLines(values.dnsResolvers),
              renewDays: Number(values.renewDays) || 30,
              remark: String(values.remark || '').trim(),
            };
            dlg.setBusy(true, button);
            try {
              if (editing) await this.ctx.api.put('/api/v1/acme/jobs/' + encodeURIComponent(base.id), payload);
              else await this.ctx.api.post('/api/v1/acme/jobs', payload);
              if (this.disposed) return;
              toast('保存成功', 'ok');
              dlg.close();
              await this.loadJobs();
            } catch (err) {
              form.error(errorMessage(err, '保存失败'));
            } finally {
              dlg.setBusy(false, button);
            }
          },
        },
      ],
    });
  }

  /* ---------------------------------------------------------------- 签发（异步 + 5 秒轮询） */

  issueJob(job) {
    const state = { phase: 'submitting', message: '正在提交签发请求…', waited: 0, polls: 0, cert: null, error: null };
    const host = document.createElement('div');
    this.dialogHosts.add(host);

    let timer = null;
    let stopped = false;
    let api = null;
    const stop = () => {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      this.pollers.delete(stop);
    };
    this.pollers.add(stop);

    const paint = () => renderInto(host, this.issueView(state));

    const finish = (message, tone) => {
      state.phase = 'done';
      state.message = message;
      stop();
      paint();
      toast(message, tone || 'ok');
      if (!this.disposed) this.loadAll();
      const button = api && api.buttons['取消等待'];
      if (button) {
        button.textContent = '关闭';
        button.removeAttribute('outline');
      }
    };

    // poll：每 5 秒读一次 /certificates，直到出现该任务的全部域名（去掉通配前缀后比较）。
    const poll = async () => {
      if (this.disposed || stopped) return;
      if (state.polls > 0) state.waited += ISSUE_POLL_MS;
      state.polls += 1;
      try {
        const data = await this.ctx.api.get('/api/v1/acme/certificates');
        if (this.disposed || stopped) return;
        const list = unwrap(data, ['certificates', 'items']);
        const want = (job.domains || []).map(baseDomain);
        const hit = list.filter((c) => {
          const ds = certDomains(c).map(baseDomain);
          return want.length && want.every((d) => ds.indexOf(d) >= 0);
        })[0];
        state.error = null;
        if (hit) {
          state.cert = hit;
          finish('证书已签发：' + (certDomains(hit).join(', ') || ''), 'ok');
          return;
        }
        state.phase = 'waiting';
        paint();
      } catch (err) {
        if (this.disposed || stopped) return;
        state.error = err;
        state.phase = 'waiting';
        paint();
      }
      if (!stopped) timer = setTimeout(poll, ISSUE_POLL_MS);
    };

    api = this.openPageDialog({
      title: '签发证书 - ' + (job.name || job.id),
      body: host,
      wide: true,
      actions: [{
        label: '取消等待',
        kind: 'ghost',
        onClick: () => {
          if (state.phase === 'done') return;
          stop();
          toast('已停止等待，签发仍在后台继续', 'info');
        },
      }],
      onClose: () => { stop(); this.dialogHosts.delete(host); this.dialogs.delete(api); },
    });
    paint();

    (async () => {
      try {
        const res = await this.ctx.api.post('/api/v1/acme/jobs/' + encodeURIComponent(job.id) + '/issue');
        if (this.disposed) return;
        const data = res || {};
        state.message = data.message || '签发请求已提交，正在等待结果…';
        state.phase = 'waiting';
      } catch (err) {
        if (this.disposed) return;
        finish('签发失败：' + errorMessage(err), 'err');
        return;
      }
      paint();
      poll();
    })();
  }

  issueView(state) {
    const waiting = state.phase !== 'done';
    const waitingText = state.error
      ? '读取证书列表失败，会自动重试；签发仍在后台继续。'
      : '已等待 ' + Math.round(state.waited / 1000) + ' 秒，尚未在证书列表中看到该域名…';
    return html`
      <p class="pacme-note">签发在后台异步执行：DNS-01 需要等待 TXT 记录生效，通常需要几十秒到几分钟。每 5 秒刷新一次证书列表。</p>
      <sl-progress-bar class="pacme-progress" ?indeterminate=${waiting} value=${waiting ? 0 : 100}></sl-progress-bar>
      <p class="pacme-note">${state.message}</p>
      ${state.error
        ? html`<nunt-error .error=${state.error} heading="读取证书列表失败" compact
            hint="签发仍在后台继续，稍后可在证书列表中查看结果。"></nunt-error>`
        : nothing}
      ${waiting ? html`<p class="pacme-note">${waitingText}</p>` : nothing}
      ${state.cert
        ? html`<nunt-table caption="已签发的证书" .columns=${this.pairColumns()} .rows=${certPairs(state.cert)} .rowKey=${(row) => row.key}></nunt-table>`
        : nothing}
    `;
  }

  /* ---------------------------------------------------------------- 上传证书 */

  openUpload() {
    const certBox = pemBox('证书（PEM）', '-----BEGIN CERTIFICATE-----' + EOL + '（把证书全文粘贴到这里）');
    const keyBox = pemBox('私钥（PEM）', '-----BEGIN PRIVATE KEY-----' + EOL + '（把私钥全文粘贴到这里）');

    const form = formGrid([
      { name: 'name', label: '名称', value: '', placeholder: '名称（可选）' },
      { name: 'domains', label: '域名', value: '', wide: true, placeholder: '证书包含的域名，逗号分隔，例如 example.com,*.example.com', hint: '逗号或换行分隔' },
      { name: 'cert', label: false, type: 'custom', wide: true, node: certBox.box },
      { name: 'key', label: false, type: 'custom', wide: true, node: keyBox.box },
      { name: 'chain', label: '证书链（可选）', type: 'textarea', rows: 3, wide: true, value: '', placeholder: '中间证书链（可选）' },
    ]);

    this.openPageDialog({
      title: '上传证书',
      body: form.node,
      wide: true,
      actions: [
        { label: '取消' },
        {
          label: '上传',
          kind: 'primary',
          close: false,
          onClick: async (dlg, button) => {
            form.clearErrors();
            const values = form.read();
            const cert = String(certBox.area.value || '').trim();
            const key = String(keyBox.area.value || '').trim();
            if (!cert) { form.error('请粘贴或选择证书文件'); return; }
            if (!key) { form.error('请粘贴或选择私钥文件'); return; }
            // 提交体保持迁移前的多别名写法（cert/certificate、key/privateKey 都带上）。
            const payload = {
              name: String(values.name || '').trim(),
              domains: splitDomains(values.domains),
              cert,
              certificate: cert,
              key,
              privateKey: key,
              chain: String(values.chain || '').trim(),
            };
            dlg.setBusy(true, button);
            try {
              await this.ctx.api.post('/api/v1/acme/certificates/upload', payload);
              if (this.disposed) return;
              toast('上传成功', 'ok');
              dlg.close();
              await this.loadCerts();
            } catch (err) {
              form.error(errorMessage(err, '上传失败'));
            } finally {
              dlg.setBusy(false, button);
            }
          },
        },
      ],
    });
  }

  /* ---------------------------------------------------------------- 渲染 */

  pairColumns() {
    return [
      { key: 'label', title: '项目', width: 140, render: (row) => html`<span class="muted">${row.label}</span>` },
      { key: 'value', title: '值', render: (row) => (row.mono ? html`<span class="pacme-ip">${row.value}</span>` : html`<span>${row.value}</span>`) },
    ];
  }

  jobColumns() {
    return [
      {
        key: 'name',
        title: '名称',
        sort: (row) => String((row && (row.name || row.id)) || ''),
        render: (row) => html`<div>
          <div class="pacme-name">${String(row.name || row.id || '')}</div>
          ${row.remark ? html`<div class="pacme-remark">${String(row.remark)}</div>` : nothing}
        </div>`,
      },
      {
        key: 'domains',
        title: '域名',
        sort: (row) => certDomains(row).join(','),
        render: (row) => {
          const list = certDomains(row);
          if (!list.length) return html`<span class="muted">-</span>`;
          const shown = list.slice(0, 2);
          return html`<span class="pacme-chips">
            ${shown.map((name) => html`<sl-tag size="small">${String(name)}</sl-tag>`)}
            ${list.length > shown.length ? html`<span class="muted">+${list.length - shown.length}</span>` : nothing}
          </span>`;
        },
      },
      {
        key: 'challenge',
        title: '挑战',
        width: 130,
        sort: (row) => String((row && row.challenge) || ''),
        render: (row) => html`<sl-badge pill variant="neutral">${CHALLENGE_LABEL[row.challenge] || row.challenge || '-'}</sl-badge>`,
      },
      {
        key: 'dnsProvider',
        title: 'DNS 提供商',
        width: 150,
        render: (row) => (row.dnsProvider
          ? html`<sl-badge pill variant="neutral">${String(row.dnsProvider)}</sl-badge>`
          : html`<span class="muted">-</span>`),
      },
      {
        key: 'keyType',
        title: '密钥',
        width: 130,
        render: (row) => html`<span>${KEY_LABEL[row.keyType] || row.keyType || '默认'}</span>`,
      },
      {
        key: 'renewDays',
        title: '续期提前',
        width: 110,
        sort: (row) => Number((row && row.renewDays) || 30),
        render: (row) => html`<span>${String((row.renewDays || 30))} 天</span>`,
      },
      {
        key: 'enable',
        title: '状态',
        width: 130,
        sort: (row) => (row && row.enable ? 1 : 0),
        // 状态文字必须放进 sl-switch 的可见标签（原因见 forward.js 同名列的说明）。
        render: (row) => html`<sl-switch size="small" class="pacme-switch"
          ?checked=${!!row.enable} ?disabled=${this.busyId === String(row.id || '')}
          title=${row.enable ? '点击停用' : '点击启用'}
          @sl-change=${(event) => this.toggleJob(row, !!event.target.checked)}>${row.enable ? '已启用' : '已停用'}</sl-switch>`,
      },
      {
        title: '操作',
        actions: true,
        width: 200,
        render: (row) => html`
          <sl-button size="small" variant="primary" ?loading=${this.busyId === String(row.id || '')}
            @click=${() => this.issueJob(row)}>签发</sl-button>
          <sl-button size="small" title="编辑" @click=${() => this.openJobForm(row)}>
            <sl-icon name="pencil-square" label="编辑"></sl-icon>
          </sl-button>
          <sl-button size="small" variant="danger" outline title="删除" @click=${() => this.removeJob(row)}>
            <sl-icon name="trash" label="删除"></sl-icon>
          </sl-button>`,
      },
    ];
  }

  certColumns() {
    return [
      {
        key: 'domains',
        title: '域名',
        render: (row) => {
          const list = certDomains(row);
          if (!list.length) return html`<span class="muted">${String(row.name || row.id || '-')}</span>`;
          const shown = list.slice(0, 3);
          return html`<span class="pacme-chips">
            ${shown.map((name) => html`<sl-tag size="small">${String(name)}</sl-tag>`)}
            ${list.length > shown.length ? html`<span class="muted">+${list.length - shown.length}</span>` : nothing}
          </span>`;
        },
      },
      {
        key: 'issuer',
        title: '签发者',
        width: 200,
        render: (row) => html`<span class="pacme-issuer">${String(row.issuer || row.ca || row.issuerCN || '-')}</span>`,
      },
      {
        key: 'notAfter',
        title: '到期时间',
        width: 190,
        sort: (row) => {
          const time = certExpiry(row) ? new Date(String(certExpiry(row))).getTime() : 0;
          return isNaN(time) ? 0 : time;
        },
        render: (row) => {
          const exp = certExpiry(row);
          return html`<div>
            <div>${fmtTime(exp)}</div>
            ${exp ? html`<div class="pacme-remark">${dateAgo(exp)} 到期</div>` : nothing}
          </div>`;
        },
      },
      {
        key: 'remainDays',
        title: '剩余天数',
        width: 200,
        sort: (row) => {
          const days = certRemainDays(row);
          return (days === null || days === undefined || !isFinite(days)) ? -1 : Number(days);
        },
        // 剩余天数进度条：sl-progress-bar + 剩余天数文案（进度按 90 天有效期估算，与迁移前一致）。
        render: (row) => {
          const days = certRemainDays(row);
          const percent = daysPercent(days);
          if (percent === null) return html`<span class="muted">-</span>`;
          const tone = daysTone(days);
          return html`<div class="pacme-days">
            <sl-progress-bar class=${'pacme-bar is-' + tone} value=${Math.round(percent)}></sl-progress-bar>
            <span class="pacme-daystext">${String(days)} 天</span>
          </div>`;
        },
      },
      {
        key: 'source',
        title: '来源',
        width: 120,
        render: (row) => html`<sl-badge pill variant="neutral">${String(row.source || row.type || (row.uploaded ? '手动上传' : 'ACME'))}</sl-badge>`,
      },
      {
        title: '操作',
        actions: true,
        width: 110,
        render: (row) => html`<sl-button size="small" variant="danger" outline title="删除证书"
          @click=${() => this.removeCert(row)}>
          <sl-icon name="trash" label="删除证书"></sl-icon>
        </sl-button>`,
      },
    ];
  }

  render() {
    return html`<section class="card">
      <div class="card-header">
        <h2>证书任务</h2>
        <span class="sub">${this.jobs.length ? '共 ' + this.jobs.length + ' 个任务' : ''}</span>
        <span class="spacer"></span>
        <sl-button size="small" ?loading=${this.jobsLoading} @click=${() => this.loadJobs()}>
          <sl-icon slot="prefix" name="arrow-clockwise" aria-hidden="true"></sl-icon>刷新
        </sl-button>
        <sl-button size="small" variant="primary" @click=${() => this.openJobForm(null)}>
          <sl-icon slot="prefix" name="plus-lg" aria-hidden="true"></sl-icon>新建任务
        </sl-button>
      </div>
      <div class="card-body tight">
        <nunt-table caption="证书任务"
          .columns=${this.jobColumns()} .rows=${this.jobs} .loading=${this.jobsLoading}
          .error=${this.jobsError} .onRetry=${() => this.loadJobs()}
          .rowKey=${(row) => (row && row.id) || ''}
          empty="还没有证书任务"
          emptyHint="点右上角「新建任务」配置 ACME 签发与自动续期。"></nunt-table>
      </div>
    </section>

    <section class="card">
      <div class="card-header">
        <h2>证书列表</h2>
        <span class="sub">剩余天数按 90 天有效期估算进度</span>
        <span class="spacer"></span>
        <sl-button size="small" ?loading=${this.certsLoading} @click=${() => this.loadCerts()}>
          <sl-icon slot="prefix" name="arrow-clockwise" aria-hidden="true"></sl-icon>刷新
        </sl-button>
        <sl-button size="small" @click=${() => this.openUpload()}>
          <sl-icon slot="prefix" name="upload" aria-hidden="true"></sl-icon>上传证书
        </sl-button>
      </div>
      <div class="card-body tight">
        <nunt-table caption="证书列表"
          .columns=${this.certColumns()} .rows=${this.certs} .loading=${this.certsLoading}
          .error=${this.certsError} .onRetry=${() => this.loadCerts()}
          .rowKey=${(row) => (row && (row.id || row.name)) || ''}
          empty="暂无已签发的证书"
          emptyHint="签发任务完成后，证书会出现在这里；也可以手动上传已有证书。"></nunt-table>
      </div>
    </section>`;
  }
}

// legendFieldJob：任务表单里的小标题（div，避免 h3 触发 heading-order）。
function legendFieldJob(name, text) {
  const node = document.createElement('div');
  node.className = 'pacme-legend';
  node.textContent = text;
  return { name, label: false, type: 'custom', wide: true, node };
}

define('nunt-page-acme', AcmePage);

export default {
  id: 'acme',
  title: '证书',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z"/><path d="M9 12l2 2 4-4"/></svg>',
  async mount(root, ctx) {
    const offStyle = pageStyle(root, PAGE_CSS);
    const page = document.createElement('nunt-page-acme');
    page.ctx = ctx;              // 必须在 appendChild 之前赋值：connectedCallback 里要取数据
    root.appendChild(page);
    return () => { page.dispose(); offStyle(); };
  },
};
