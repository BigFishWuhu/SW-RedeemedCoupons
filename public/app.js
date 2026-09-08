const state = { user: null, accounts: [], recordPage: 1, poller: null };
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const pageTitles = { dashboard: '运行总览', accounts: '兑换账号', records: '兑换记录', security: '安全设置' };
const serverNames = { china: '中国服', global: '全球服', asia: '亚洲服', europe: '欧洲服', korea: '韩国服', japan: '日本服' };
const statusNames = { redeemed: '兑换成功', 'already-redeemed': '此前已兑换', failed: '兑换失败' };

async function api(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: { 'Content-Type': 'application/json', 'X-SW-Coupon': 'web', ...(options.headers || {}) }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        if (response.status === 401 && url !== '/api/login') showLogin();
        throw new Error(data.error || `请求失败（${response.status}）`);
    }
    return data;
}

async function boot() {
    bindEvents();
    try {
        const setup = await api('/api/setup-status');
        if (setup.required) return showSetup();
        const { user } = await api('/api/me');
        state.user = user;
        showApp();
        await loadAll();
    } catch { showLogin(); }
}

function bindEvents() {
    $('#setupForm').addEventListener('submit', setupAdmin);
    $('#loginForm').addEventListener('submit', login);
    $('#logoutButton').addEventListener('click', logout);
    $('#redeemAllButton').addEventListener('click', () => redeem());
    $('#addAccountButton').addEventListener('click', () => openAccount());
    $('#accountForm').addEventListener('submit', saveAccount);
    $('#passwordForm').addEventListener('submit', changePassword);
    $('#filterButton').addEventListener('click', () => { state.recordPage = 1; loadRecords(); });
    $('#recordQuery').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); state.recordPage = 1; loadRecords(); } });
    $('#navigation').addEventListener('click', (event) => { const button = event.target.closest('[data-page]'); if (button) go(button.dataset.page); });
    document.addEventListener('click', (event) => { const button = event.target.closest('[data-go]'); if (button) go(button.dataset.go); });
    $$('[data-close]').forEach((button) => button.addEventListener('click', () => $('#accountDialog').close()));
    $('#menuButton').addEventListener('click', () => $('.sidebar').classList.toggle('open'));
}

async function login(event) {
    event.preventDefault();
    const form = event.currentTarget;
    $('#authError').textContent = '';
    const body = Object.fromEntries(new FormData(form));
    try {
        const { user } = await api('/api/login', { method: 'POST', body: JSON.stringify(body) });
        state.user = user;
        form.reset();
        showApp();
        await loadAll();
    } catch (error) { $('#authError').textContent = error.message; }
}

async function setupAdmin(event) {
    event.preventDefault();
    const form = event.currentTarget;
    $('#authError').textContent = '';
    const body = Object.fromEntries(new FormData(form));
    if (body.password !== body.confirmPassword) {
        $('#authError').textContent = '两次输入的密码不一致';
        return;
    }
    try {
        const { user } = await api('/api/setup', { method: 'POST', body: JSON.stringify(body) });
        state.user = user;
        form.reset();
        showApp();
        await loadAll();
        toast('管理员创建成功');
    } catch (error) { $('#authError').textContent = error.message; }
}

async function logout() {
    try { await api('/api/logout', { method: 'POST' }); } catch {}
    showLogin();
}

function showLogin() {
    clearInterval(state.poller);
    $('#appView').classList.add('hidden');
    $('#loginView').classList.remove('hidden');
    $('#setupForm').classList.add('hidden');
    $('#loginForm').classList.remove('hidden');
    $('#authTitle').textContent = '兑换控制台';
    $('#authDescription').textContent = '管理兑换账号，自动领取最新礼包。';
    $('#authError').textContent = '';
}

function showSetup() {
    clearInterval(state.poller);
    $('#appView').classList.add('hidden');
    $('#loginView').classList.remove('hidden');
    $('#loginForm').classList.add('hidden');
    $('#setupForm').classList.remove('hidden');
    $('#authTitle').textContent = '创建管理员';
    $('#authDescription').textContent = '首次使用，请创建用于登录控制台的账户和密码。';
    $('#authError').textContent = '';
}

function showApp() {
    $('#loginView').classList.add('hidden');
    $('#appView').classList.remove('hidden');
    $('#currentUser').textContent = state.user.username;
    clearInterval(state.poller);
    state.poller = setInterval(loadDashboard, 4000);
}

async function loadAll() {
    await loadAccounts();
    await Promise.all([loadDashboard(), loadRecords(), loadRecentRecords()]);
}

function go(page) {
    $$('.page').forEach((item) => item.classList.toggle('active', item.id === `page-${page}`));
    $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.page === page));
    $('#pageTitle').textContent = pageTitles[page];
    $('.sidebar').classList.remove('open');
    if (page === 'records') loadRecords();
}

async function loadDashboard() {
    try {
        const data = await api('/api/dashboard');
        $('#metricAccounts').textContent = `${data.enabledAccountCount} / ${data.accountCount}`;
        $('#metricRedeemed').textContent = data.redeemedCount;
        $('#metricFailed').textContent = data.failedCount;
        $('#metricTotal').textContent = data.totalRecords;
        renderJob(data.latestJob, data.job);
    } catch (error) { if (!isAuthError(error)) toast(error.message, true); }
}

function renderJob(latest, current) {
    const button = $('#redeemAllButton');
    button.disabled = current.running;
    button.innerHTML = current.running ? '兑换进行中…' : '<span>▶</span> 立即兑换';
    const banner = $('#jobBanner');
    banner.classList.toggle('hidden', !current.running);
    if (current.running) {
        const p = current.progress || {};
        banner.textContent = `正在执行兑换任务 · 成功 ${p.success || 0} · 跳过 ${p.skipped || 0} · 失败 ${p.failed || 0}`;
    }
    const item = current.running ? { ...current.progress, status: 'running', startedAt: current.startedAt, triggerType: 'manual' } : latest;
    if (!item) {
        $('#latestJobStatus').className = 'status neutral';
        $('#latestJobStatus').textContent = '暂无任务';
        $('#latestJob').className = 'empty';
        $('#latestJob').textContent = '添加账号后即可开始兑换。';
        return;
    }
    const labels = { running: '执行中', completed: '已完成', failed: '运行失败' };
    $('#latestJobStatus').className = `status ${item.status === 'completed' ? 'success' : item.status === 'failed' ? 'fail' : 'running'}`;
    $('#latestJobStatus').textContent = labels[item.status] || item.status;
    $('#latestJob').className = '';
    $('#latestJob').innerHTML = `<p class="muted">${escapeHtml(item.triggerType === 'schedule' ? '定时任务' : '手动任务')} · ${formatDate(item.startedAt)}</p>
        <div class="job-stats"><div><small>发现兑换码</small><strong>${item.fetched || 0}</strong></div><div><small>兑换成功</small><strong>${item.success || 0}</strong></div><div><small>已跳过</small><strong>${item.skipped || 0}</strong></div><div><small>失败</small><strong>${item.failed || 0}</strong></div></div>
        ${item.errorMessage || current.error ? `<p class="form-error">${escapeHtml(item.errorMessage || current.error)}</p>` : ''}`;
}

async function loadAccounts() {
    try {
        const { items } = await api('/api/accounts');
        state.accounts = items;
        renderAccounts();
        $('#recordAccount').innerHTML = '<option value="">全部账号</option>' + items.map((a) => `<option value="${a.id}">${escapeHtml(a.name || a.hiveId)} · ${serverNames[a.server]}</option>`).join('');
    } catch (error) { toast(error.message, true); }
}

function renderAccounts() {
    const root = $('#accountList');
    if (!state.accounts.length) {
        root.innerHTML = '<article class="panel"><h3>还没有兑换账号</h3><p class="muted">添加 Hive ID 后即可执行兑换。</p></article>';
        return;
    }
    root.innerHTML = state.accounts.map((a) => `<article class="account-card">
        <div class="account-top"><div><p class="eyebrow">${serverNames[a.server] || a.server}</p><h3>${escapeHtml(a.name || '未命名账号')}</h3></div><span class="status ${a.enabled ? 'success' : 'neutral'}">${a.enabled ? '已启用' : '已停用'}</span></div>
        <p class="account-id">${escapeHtml(a.hiveId)}</p><p class="account-meta">添加于 ${formatDate(a.createdAt)}</p>
        <div class="account-actions"><button class="button secondary" data-edit="${a.id}">编辑</button><button class="button primary" data-redeem="${a.id}" ${a.enabled ? '' : 'disabled'}>兑换</button><button class="button secondary" data-delete="${a.id}">删除</button></div>
    </article>`).join('');
    $$('[data-edit]', root).forEach((button) => button.addEventListener('click', () => openAccount(Number(button.dataset.edit))));
    $$('[data-redeem]', root).forEach((button) => button.addEventListener('click', () => redeem(Number(button.dataset.redeem))));
    $$('[data-delete]', root).forEach((button) => button.addEventListener('click', () => deleteAccount(Number(button.dataset.delete))));
}

function openAccount(id) {
    const form = $('#accountForm');
    form.reset();
    form.elements.id.value = '';
    form.elements.enabled.checked = true;
    $('#dialogTitle').textContent = id ? '编辑兑换账号' : '添加兑换账号';
    if (id) {
        const account = state.accounts.find((item) => item.id === id);
        if (!account) return;
        for (const key of ['id', 'name', 'hiveId', 'server']) form.elements[key].value = account[key];
        form.elements.enabled.checked = account.enabled;
    }
    $('#accountDialog').showModal();
}

async function saveAccount(event) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    values.enabled = event.currentTarget.elements.enabled.checked;
    const id = values.id;
    delete values.id;
    try {
        await api(id ? `/api/accounts/${id}` : '/api/accounts', { method: id ? 'PUT' : 'POST', body: JSON.stringify(values) });
        $('#accountDialog').close();
        toast(id ? '账号已更新' : '账号已添加');
        await loadAccounts();
        await loadDashboard();
    } catch (error) { toast(error.message, true); }
}

async function deleteAccount(id) {
    const account = state.accounts.find((item) => item.id === id);
    if (!confirm(`确定删除“${account?.name || account?.hiveId}”吗？历史记录会继续保留。`)) return;
    try {
        await api(`/api/accounts/${id}`, { method: 'DELETE' });
        toast('账号已删除');
        await loadAccounts();
        await loadDashboard();
    } catch (error) { toast(error.message, true); }
}

async function redeem(accountId = null) {
    try {
        await api('/api/redeem', { method: 'POST', body: JSON.stringify({ accountId }) });
        toast(accountId ? '该账号的兑换任务已开始' : '全部账号兑换任务已开始');
        go('dashboard');
        await loadDashboard();
    } catch (error) { toast(error.message, true); }
}

async function loadRecentRecords() {
    try {
        const data = await api('/api/records?pageSize=6');
        $('#recentRecords').innerHTML = recordTable(data.items, true);
    } catch (error) { toast(error.message, true); }
}

async function loadRecords() {
    const params = new URLSearchParams({ page: state.recordPage, pageSize: 25 });
    const query = $('#recordQuery').value.trim();
    const accountId = $('#recordAccount').value;
    const status = $('#recordStatus').value;
    if (query) params.set('query', query);
    if (accountId) params.set('accountId', accountId);
    if (status) params.set('status', status);
    try {
        const data = await api(`/api/records?${params}`);
        $('#recordTable').innerHTML = recordTable(data.items);
        renderPagination(data);
    } catch (error) { toast(error.message, true); }
}

function recordTable(items, compact = false) {
    if (!items.length) return '<div class="empty">暂无兑换记录。</div>';
    return `<table class="data-table"><thead><tr><th>兑换码</th><th>账号</th><th>服务器</th><th>结果</th>${compact ? '' : '<th>返回信息</th>'}<th>时间</th></tr></thead><tbody>${items.map((r) => `<tr>
        <td class="code">${escapeHtml(r.couponCode)}</td><td>${escapeHtml(r.accountName || r.hiveId)}<br><small class="muted">${escapeHtml(r.hiveId)}</small></td><td>${serverNames[r.server] || escapeHtml(r.server)}</td>
        <td><span class="status ${r.status === 'failed' ? 'fail' : r.status === 'already-redeemed' ? 'warning' : 'success'}">${statusNames[r.status] || escapeHtml(r.status)}</span></td>
        ${compact ? '' : `<td title="${escapeHtml(r.message || '')}">${escapeHtml(shortText(r.message || '—', 55))}</td>`}<td class="date">${formatDate(r.createdAt)}</td></tr>`).join('')}</tbody></table>`;
}

function renderPagination(data) {
    $('#pagination').innerHTML = `<button class="button secondary" data-prev ${data.page <= 1 ? 'disabled' : ''}>上一页</button><span>${data.page} / ${data.pages} · 共 ${data.total} 条</span><button class="button secondary" data-next ${data.page >= data.pages ? 'disabled' : ''}>下一页</button>`;
    $('[data-prev]')?.addEventListener('click', () => { state.recordPage -= 1; loadRecords(); });
    $('[data-next]')?.addEventListener('click', () => { state.recordPage += 1; loadRecords(); });
}

async function changePassword(event) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    if (values.newPassword !== values.confirmPassword) return toast('两次输入的新密码不一致', true);
    try {
        await api('/api/password', { method: 'POST', body: JSON.stringify(values) });
        toast('密码已更新，请重新登录');
        setTimeout(showLogin, 700);
    } catch (error) { toast(error.message, true); }
}

let toastTimer;
function toast(message, error = false) {
    const node = $('#toast');
    node.textContent = message;
    node.className = `toast show${error ? ' error' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('show'), 3000);
}
function formatDate(value) { return value ? new Date(`${value}${value.endsWith('Z') || value.includes('+') ? '' : 'Z'}`).toLocaleString('zh-CN', { hour12: false }) : '—'; }
function escapeHtml(value) { const node = document.createElement('span'); node.textContent = String(value ?? ''); return node.innerHTML; }
function shortText(value, length) { const text = String(value); return text.length > length ? `${text.slice(0, length)}…` : text; }
function isAuthError(error) { return /请先登录/.test(error.message); }

boot();
