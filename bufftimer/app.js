'use strict';
(() => {
  const config = window.BUFFTIMER_CONFIG || {};
  const url = String(config.url || '').trim().replace(/\/+$/, '');
  const key = String(config.key || '').trim();
  const $ = (id) => document.getElementById(id);
  const SESSION_KEY = 'bufftimer-web-session-v2';
  const PAGE_LIMIT = 250;
  const ONLINE_SECONDS = 90;
  const labelForStatus = {approved: '승인 완료', pending: '승인 대기', blocked: '차단'};
  let session = null;
  let profile = null;
  let users = [];
  let activeFilter = 'all';
  let loadingUsers = false;
  let noticeTimeout = null;

  function notice(message, isError = false) {
    clearTimeout(noticeTimeout);
    const node = $('notice');
    node.hidden = false;
    node.className = 'notice' + (isError ? ' bad' : '');
    node.textContent = message;
    if (!isError) noticeTimeout = setTimeout(() => { node.hidden = true; }, 9500);
  }
  function clearNotice() {
    clearTimeout(noticeTimeout);
    $('notice').hidden = true;
  }
  function reportError(error) {
    const raw = String(error?.message || error || '알 수 없는 오류');
    const known = {
      'Invalid login credentials': '이메일 또는 비밀번호를 확인해 주세요.',
      'Email not confirmed': '이메일 인증이 필요합니다. 인증 메일을 확인해 주세요.',
      'User already registered': '이미 가입된 이메일입니다.',
      'email rate limit exceeded': '잠시 후 다시 시도해 주세요. 이메일 발송 제한이 적용됐습니다.',
      'ADMIN_REQUIRED': '관리자 권한이 없습니다.',
      'APPROVAL_REQUIRED': '승인되지 않은 계정입니다.',
      'PROFILE_MISSING': '회원 프로필이 없습니다. 관리자에게 문의해 주세요.',
      'Failed to fetch': 'Supabase 연결에 실패했습니다. 설정, 인터넷 또는 프로젝트 일시중지 상태를 확인해 주세요.'
    };
    notice(known[raw] || raw.slice(0, 230), true);
  }
  function lockForm(form, locked) {
    for (const ctrl of form.querySelectorAll('input, button')) ctrl.disabled = locked;
  }
  function saveSession() {
    try {
      if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
      else sessionStorage.removeItem(SESSION_KEY);
    } catch (_) { /* Storage may be blocked by browser privacy settings. */ }
  }
  function setScreen(authenticated) {
    $('authPanel').hidden = authenticated;
    $('accountPanel').hidden = !authenticated;
    $('adminPanel').hidden = true;
    if (!authenticated) {
      profile = null;
      users = [];
    }
  }
  function selectTab(tab, focus = false) {
    const login = tab === 'login';
    $('tabLogin').classList.toggle('active', login);
    $('tabSignup').classList.toggle('active', !login);
    $('tabLogin').setAttribute('aria-selected', String(login));
    $('tabSignup').setAttribute('aria-selected', String(!login));
    $('tabLogin').tabIndex = login ? 0 : -1;
    $('tabSignup').tabIndex = login ? -1 : 0;
    $('loginPane').hidden = !login;
    $('signupPane').hidden = login;
    if (focus) (login ? $('loginEmail') : $('signupUsername')).focus();
  }
  function validateConfig() {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/i.test(parsed.hostname)
          || parsed.pathname !== '/' || parsed.port || parsed.username || parsed.password) return false;
      if (!key || key.startsWith('sb_secret_') || key.length > 6000) return false;
      if (key.split('.').length === 3) {
        // Security-sensitive secrets must never be embedded in a static public site.
        try {
          const body = JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
          if (body.role === 'service_role') return false;
        } catch (_) { /* A malformed public key is rejected by Supabase itself. */ }
      }
      return true;
    } catch (_) { return false; }
  }
  async function request(path, data, token = null, method = 'POST') {
    const response = await fetch(url + path, {
      method,
      headers: {
        apikey: key,
        'content-type': 'application/json',
        ...(token ? {Authorization: 'Bearer ' + token} : {})
      },
      body: data === undefined ? undefined : JSON.stringify(data),
      cache: 'no-store'
    });
    let value;
    try { value = await response.json(); } catch (_) { value = {}; }
    if (!response.ok) {
      const error = new Error(String(value.message || value.msg || value.error_description || value.error || 'HTTP ' + response.status));
      error.status = response.status;
      throw error;
    }
    return value;
  }
  async function fresh() {
    if (!session) throw new Error('다시 로그인해 주세요.');
    if (session.access_token && Date.now() < Number(session.expires_at) * 1000 - 90000) return session.access_token;
    if (!session.refresh_token) throw new Error('로그인이 만료됐어요. 다시 로그인해 주세요.');
    const value = await request('/auth/v1/token?grant_type=refresh_token', {refresh_token: session.refresh_token});
    session = {...value, expires_at: Math.floor(Date.now() / 1000) + Number(value.expires_in || 3600)};
    saveSession();
    return session.access_token;
  }
  async function rpc(name, body = {}) {
    const token = await fresh();
    try { return await request('/rest/v1/rpc/' + name, body, token); }
    catch (e) {
      if (e.status !== 401 || !session?.refresh_token) throw e;
      session.expires_at = 0;
      const newToken = await fresh();
      return request('/rest/v1/rpc/' + name, body, newToken);
    }
  }
  function koreanDate(iso) {
    if (!iso) return '접속 기록 없음';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '기록 없음';
    return new Intl.DateTimeFormat('ko-KR', {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false}).format(d);
  }
  function online(row) {
    if (!row || row.status !== 'approved' || !row.last_seen) return false;
    const ms = new Date(row.last_seen).getTime();
    return Number.isFinite(ms) && Date.now() - ms < ONLINE_SECONDS * 1000 && Date.now() >= ms - 15_000;
  }
  function statusText(status) { return labelForStatus[status] || '상태 확인 필요'; }
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }
  function renderAccount(me) {
    profile = me;
    setScreen(true);
    $('hello').textContent = `${me.display_name}님, 반가워요!`;
    $('accountInfo').textContent = '@' + me.username + ' · ' + me.email;
    $('avatar').textContent = (me.display_name || 'B').trim().charAt(0).toUpperCase();
    const badge = $('accountStatus');
    badge.className = 'status-badge' + (me.status === 'pending' ? ' wait' : me.status === 'blocked' ? ' blocked' : '');
    badge.textContent = statusText(me.status);
    $('accountHelpTitle').textContent = me.status === 'approved' ? '계정 승인이 완료됐어요.' : me.status === 'pending' ? '관리자 승인을 기다리고 있어요.' : '계정 사용이 중지됐어요.';
    $('accountHelp').textContent = me.status === 'approved'
      ? 'Windows 버프타이머에서 가입한 이메일과 비밀번호로 로그인하세요. 프리셋을 동기화할 수 있어요.'
      : me.status === 'pending'
        ? '관리자가 가입 신청을 승인하면 Windows 버프타이머를 사용할 수 있어요.'
        : '관리자에게 문의해 주세요. 승인되지 않은 계정은 프로그램에 로그인할 수 없습니다.';
    $('accountDetails').hidden = me.status !== 'approved';
    $('adminPanel').hidden = !(me.role === 'admin' && me.status === 'approved');
  }
  async function loadAccount() {
    const me = await rpc('bt_me');
    renderAccount(me);
    clearNotice();
    if (me.status === 'approved') {
      rpc('bt_get_settings').then(value => {
        if (profile?.id !== me.id) return;
        const settings = value?.settings || {};
        const presets = settings.presets && typeof settings.presets === 'object' ? settings.presets : {};
        $('presetCount').textContent = Object.keys(presets).length + '개';
        $('currentPreset').textContent = settings.current || '아직 없음';
      }).catch(() => {
        $('presetCount').textContent = '확인 불가';
        $('currentPreset').textContent = '—';
      });
    }
    if (me.role === 'admin' && me.status === 'approved') await loadUsers();
  }
  function filterRows() {
    const search = $('memberSearch').value.trim().toLocaleLowerCase();
    return users.filter(row => {
      const matches = !search || `${row.username || ''} ${row.display_name || ''}`.toLocaleLowerCase().includes(search);
      const status = activeFilter === 'all' || (activeFilter === 'online' ? online(row) : row.status === activeFilter);
      return matches && status;
    });
  }
  function actionButton(label, status, row) {
    const button = element('button', label, 'action-btn' + (status === 'approved' ? ' primary-action' : status === 'blocked' ? ' danger-action' : ''));
    button.type = 'button';
    button.disabled = row.role === 'admin' || row.status === status;
    button.addEventListener('click', async () => {
      if (!confirm(`@${row.username} 님의 상태를 '${statusText(status)}'로 변경할까요?`)) return;
      button.disabled = true;
      try {
        await rpc('bt_admin_status', {target_id: row.id, new_status: status});
        notice(`@${row.username} 님의 상태가 '${statusText(status)}'로 변경됐어요.`);
        await loadUsers();
      } catch (error) { reportError(error); button.disabled = false; }
    });
    return button;
  }
  function renderUsers() {
    const parent = $('usersList');
    const rows = filterRows();
    $('listCount').textContent = String(rows.length);
    parent.replaceChildren();
    if (!rows.length) {
      parent.append(element('div', users.length ? '검색 조건에 맞는 회원이 없어요.' : '아직 등록된 회원이 없어요.', 'empty-list'));
      return;
    }
    const frag = document.createDocumentFragment();
    for (const row of rows.slice(0, PAGE_LIMIT)) {
      const wrapper = element('div', null, 'user-row');
      const avatar = element('div', (row.display_name || 'B').trim().charAt(0).toUpperCase(), 'user-icon');
      avatar.setAttribute('aria-hidden', 'true');
      const main = element('div', null, 'user-main');
      const name = element('div');
      name.append(element('strong', row.display_name || '(이름 없음)'), element('span', '@' + (row.username || ''), 'handle'));
      const meta = element('div', null, 'user-meta');
      meta.append(element('span', online(row) ? '● 지금 사용 중' + (Number(row.devices) > 1 ? ` · ${row.devices}대` : '') : '○ 오프라인', 'user-presence ' + (online(row) ? 'online' : 'offline')),
        element('span', '마지막 접속: ' + koreanDate(row.last_seen)));
      if (row.role === 'admin') meta.append(element('span', '관리자'));
      main.append(name, meta);
      const badge = element('span', statusText(row.status), 'user-status ' + row.status);
      const actions = element('div', null, 'user-actions');
      actions.append(actionButton('승인', 'approved', row), actionButton('대기', 'pending', row), actionButton('차단', 'blocked', row));
      wrapper.append(avatar, main, badge, actions);
      frag.append(wrapper);
    }
    parent.append(frag);
    if (rows.length > PAGE_LIMIT) parent.append(element('p', `처음 ${PAGE_LIMIT}명만 표시됩니다. 검색으로 찾으세요.`, 'admin-disclaimer'));
  }
  async function loadUsers() {
    if (!profile || profile.role !== 'admin' || profile.status !== 'approved' || loadingUsers) return;
    loadingUsers = true;
    try {
      const list = await rpc('bt_admin_activity');
      if (!Array.isArray(list)) throw new Error('접속 상태 데이터를 읽지 못했어요. Supabase SQL 설정을 확인해 주세요.');
      users = list;
      $('statOnline').textContent = String(users.filter(online).length);
      $('statPending').textContent = String(users.filter(x => x.status === 'pending').length);
      $('statTotal').textContent = String(users.length);
      renderUsers();
    } catch (error) { reportError(error); }
    finally { loadingUsers = false; }
  }

  $('tabLogin').addEventListener('click', () => selectTab('login'));
  $('tabSignup').addEventListener('click', () => selectTab('signup'));
  $('goSignup').addEventListener('click', () => selectTab('signup', true));
  // Arrow keys work on tabs for keyboard accessibility.
  for (const tab of [$('tabLogin'), $('tabSignup')]) {
    tab.addEventListener('keydown', e => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const to = tab.id === 'tabLogin' ? 'signup' : 'login';
        selectTab(to);
        (to === 'login' ? $('tabLogin') : $('tabSignup')).focus();
      }
    });
  }
  $('signupForm').addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.currentTarget;
    lockForm(form, true);
    try {
      const username = $('signupUsername').value.trim().toLowerCase();
      const display_name = $('signupNickname').value.trim();
      const email = $('signupEmail').value.trim();
      if (!/^[a-z0-9_]{4,24}$/.test(username) || display_name.length < 1 || display_name.length > 32)
        throw new Error('아이디는 영문·숫자·밑줄 4~24자, 닉네임은 1~32자로 입력해 주세요.');
      const value = await request('/auth/v1/signup', {
        email, password: $('signupPassword').value, data: {username, display_name}
      });
      form.reset();
      $('loginEmail').value = email;
      selectTab('login');
      notice(value?.user?.identities?.length === 0
        ? '가입 정보가 접수됐어요. 이미 사용 중인 이메일이라면 기존 계정으로 로그인해 주세요.'
        : '가입 신청이 접수됐어요! 이메일 인증 설정에 따라 인증 후 로그인하고, 관리자 승인을 기다려 주세요.');
    } catch (error) { reportError(error); }
    finally { lockForm(form, false); }
  });
  $('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.currentTarget;
    lockForm(form, true);
    try {
      const response = await request('/auth/v1/token?grant_type=password', {
        email: $('loginEmail').value.trim(), password: $('loginPassword').value
      });
      session = {...response, expires_at: Math.floor(Date.now() / 1000) + Number(response.expires_in || 3600)};
      saveSession();
      form.reset();
      await loadAccount();
    } catch (error) { reportError(error); }
    finally { lockForm(form, false); }
  });
  $('refreshButton').addEventListener('click', () => loadAccount().catch(reportError));
  $('logoutButton').addEventListener('click', async () => {
    try { if (session) await request('/auth/v1/logout', {}, await fresh()); } catch (_) { /* Local logout still works. */ }
    session = null; saveSession(); setScreen(false); clearNotice();
    $('loginPassword').value = '';
  });
  $('loadUsersButton').addEventListener('click', () => loadUsers());
  $('memberSearch').addEventListener('input', renderUsers);
  for (const filter of document.querySelectorAll('.filter')) {
    filter.addEventListener('click', () => {
      activeFilter = filter.dataset.filter;
      for (const other of document.querySelectorAll('.filter')) {
        const selected = other === filter;
        other.classList.toggle('active', selected);
        other.setAttribute('aria-pressed', String(selected));
      }
      renderUsers();
    });
  }
  window.setInterval(() => {
    if (profile?.role === 'admin' && profile?.status === 'approved' && !document.hidden) loadUsers();
  }, 30000);
  if (!validateConfig()) {
    $('setupNotice').hidden = false;
    for (const form of [$('loginForm'), $('signupForm')]) lockForm(form, true);
    return;
  }
  try { session = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch (_) { session = null; }
  if (session) {
    loadAccount().catch(error => {
      session = null; saveSession(); setScreen(false); reportError(error);
    });
  }
})();
