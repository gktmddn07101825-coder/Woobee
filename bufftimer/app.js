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
  let editTargetId = null;

  // Use the SAME manifest as the Windows auto-updater. Never guess what "latest" means:
  // other programs may publish Releases in the shared Woobee repository.
  async function loadLatestDownload() {
    const hero = $('latestDownload');
    const account = $('accountDownload');
    const message = $('downloadStatus');
    if (!hero || !account || !message) return;
    try {
      const response = await fetch('./version.json', {cache: 'no-store'});
      if (!response.ok) throw new Error('manifest unavailable');
      const manifest = await response.json();
      const version = String(manifest?.version || '');
      if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version))
        throw new Error('invalid version');
      // Pin the downloadable asset to our product and matching version, not to
      // "releases/latest" (which could be the *other* Woobee application).
      const expected = `https://github.com/gktmddn07101825-coder/Woobee/releases/download/bufftimer-v${version}/bufftimer-windows-v${version}.zip`;
      if (manifest.url !== expected) throw new Error('invalid release URL');
      if (typeof manifest.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(manifest.sha256))
        throw new Error('invalid checksum');
      for (const link of [hero, account]) {
        link.href = expected;
        link.removeAttribute('aria-disabled');
        link.removeAttribute('tabindex');
        link.classList.remove('download-unavailable');
      }
      hero.querySelector('.download-button-text').textContent = '최신 버전 다운로드';
      account.textContent = `v${version} 다운로드 ↗`;
      message.textContent = `현재 배포 버전 v${version} · Windows용 ZIP`; // Published release only.
    } catch (_) {
      // Do not silently send visitors to an unrelated release list or an old ZIP.
      hero.querySelector('.download-button-text').textContent = '다운로드 준비 중';
      account.textContent = '다운로드 정보 확인 필요';
      message.textContent = '버전 정보를 불러오지 못했어요. 잠시 후 다시 확인해 주세요.';
    }
  }

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
      'Invalid login credentials': '아이디 또는 비밀번호를 확인해 주세요.',
      'LOGIN_FAILED': '아이디 또는 비밀번호가 올바르지 않아요.',
      'USERNAME_TAKEN': '이미 사용 중인 아이디예요.',
      'INVALID_USERNAME': '아이디는 영문 소문자·숫자·밑줄 4~24자로 입력해 주세요.',
      'INVALID_PASSWORD': '비밀번호는 8~128자로 입력해 주세요.',
      'ADMIN_PASSWORD_INVALID': '관리자 본인 비밀번호가 올바르지 않아요.',
      'CANNOT_CHANGE_ADMIN': '다른 관리자 계정은 수정할 수 없어요.',
      'USER_NOT_FOUND': '회원 계정을 찾을 수 없어요.',
      '23505': '이미 사용 중인 아이디예요.',
      'Email not confirmed': '이메일 인증이 필요합니다. 인증 메일을 확인해 주세요.',
      'User already registered': '이미 가입된 계정입니다.',
      'email rate limit exceeded': '잠시 후 다시 시도해 주세요.',
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
    if (focus) (login ? $('loginUsername') : $('signupUsername')).focus();
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
  async function accountAction(action, payload, authorized = false) {
    // Only publishable key is sent. Admin privileges are checked inside the Edge Function.
    const token = authorized ? await fresh() : null;
    return request('/functions/v1/bt-account', {action, ...payload}, token);
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
    $('accountInfo').textContent = '@' + me.username;
    $('avatar').textContent = (me.display_name || 'B').trim().charAt(0).toUpperCase();
    const badge = $('accountStatus');
    badge.className = 'status-badge' + (me.status === 'pending' ? ' wait' : me.status === 'blocked' ? ' blocked' : '');
    badge.textContent = statusText(me.status);
    $('accountHelpTitle').textContent = me.status === 'approved' ? '계정 승인이 완료됐어요.' : me.status === 'pending' ? '관리자 승인을 기다리고 있어요.' : '계정 사용이 중지됐어요.';
    $('accountHelp').textContent = me.status === 'approved'
      ? 'Windows 버프타이머에서 사이트 아이디와 비밀번호로 로그인하세요. 프리셋을 동기화할 수 있어요.'
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
  function openMemberEditor(row) {
    editTargetId = row.id;
    $('editUsername').value = row.username || '';
    $('editNickname').value = row.display_name || '';
    $('resetNewPassword').value = '';
    $('resetAdminPassword').value = '';
    $('editMemberHint').textContent = '@' + row.username + ' · 관리자가 변경한 내용은 다음 로그인부터 적용돼요.';
    $('editMemberDialog').showModal();
  }
  function closeMemberEditor() {
    $('editMemberDialog').close();
    editTargetId = null;
    $('resetNewPassword').value = '';
    $('resetAdminPassword').value = '';
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
      const edit = element('button', '정보 수정', 'action-btn user-action-edit');
      edit.type = 'button';
      edit.disabled = row.role === 'admin' && row.id !== profile?.id;
      edit.addEventListener('click', () => openMemberEditor(row));
      actions.append(edit);
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
      if (!/^[a-z0-9_]{4,24}$/.test(username) || display_name.length < 1 || display_name.length > 32)
        throw new Error('아이디는 영문·숫자·밑줄 4~24자, 닉네임은 1~32자로 입력해 주세요.');
      const password = $('signupPassword').value;
      if (password.length < 8 || password.length > 128) throw new Error('비밀번호는 8~128자로 입력해 주세요.');
      // Supabase Auth internally requires an email/phone identity. Generate a
      // non-deliverable, opaque technical alias; never ask users for an email.
      // This alias is stable in Auth even if an admin later changes username.
      // getRandomValues also works where randomUUID is unavailable (file previews,
      // older browsers). Never use Math.random for account identifiers.
      if (!globalThis.crypto?.getRandomValues) throw new Error('안전한 브라우저에서 다시 시도해 주세요.');
      const randomBytes = new Uint8Array(20);
      globalThis.crypto.getRandomValues(randomBytes);
      const alias = 'bt-' + Array.from(randomBytes, x => x.toString(16).padStart(2, '0')).join('') + '@example.com';
      const value = await request('/auth/v1/signup', {
        email: alias, password, data: {username, display_name}
      });
      if (!value?.user?.id || !value?.access_token || value?.user?.identities?.length === 0)
        throw new Error('Supabase에서 이메일 확인(Confirm Email)을 끄고 다시 가입해 주세요.');
      // Do not keep an unapproved member auto-signed-in on signup.
      if (value?.access_token) {
        try { await request('/auth/v1/logout', {}, value.access_token); } catch (_) {}
      }
      form.reset();
      $('loginUsername').value = username;
      selectTab('login');
      notice('가입 신청이 접수됐어요! 관리자 승인 후 아이디와 비밀번호로 로그인해 주세요.');
    } catch (error) { reportError(error); }
    finally { lockForm(form, false); }
  });
  $('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.currentTarget;
    lockForm(form, true);
    try {
      const username = $('loginUsername').value.trim().toLowerCase();
      if (!/^[a-z0-9_]{4,24}$/.test(username)) throw new Error('아이디 형식을 확인해 주세요.');
      const response = await accountAction('login', {
        username, password: $('loginPassword').value
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
  $('editMemberClose').addEventListener('click', closeMemberEditor);
  $('editMemberDialog').addEventListener('close', () => { editTargetId = null; $('resetNewPassword').value = ''; $('resetAdminPassword').value = ''; });
  $('editProfileForm').addEventListener('submit', async e => {
    e.preventDefault();
    if (!editTargetId) return;
    const form = e.currentTarget;
    const targetId = editTargetId;
    lockForm(form, true);
    try {
      const username = $('editUsername').value.trim().toLowerCase();
      const display_name = $('editNickname').value.trim();
      if (!/^[a-z0-9_]{4,24}$/.test(username) || display_name.length < 1 || display_name.length > 32)
        throw new Error('아이디는 영문·숫자·밑줄 4~24자, 닉네임은 1~32자로 입력해 주세요.');
      await rpc('bt_admin_edit_profile', {target_id: targetId, new_username: username, new_display_name: display_name});
      notice('아이디와 닉네임을 변경했어요.');
      if (targetId === profile?.id) await loadAccount();
      else await loadUsers();
      closeMemberEditor();
    } catch (error) { reportError(error); }
    finally { lockForm(form, false); }
  });
  $('resetMemberForm').addEventListener('submit', async e => {
    e.preventDefault();
    if (!editTargetId) return;
    const form = e.currentTarget;
    const targetId = editTargetId;
    if (!confirm('선택한 회원의 비밀번호를 새 비밀번호로 재설정할까요?')) return;
    lockForm(form, true);
    try {
      await accountAction('reset_password', {
        target_id: targetId,
        new_password: $('resetNewPassword').value,
        admin_password: $('resetAdminPassword').value
      }, true);
      notice('비밀번호를 재설정했어요. 새 비밀번호는 회원에게 안전한 경로로 전달해 주세요.');
      closeMemberEditor();
    } catch (error) { reportError(error); }
    finally { lockForm(form, false); }
  });
  window.setInterval(() => {
    if (profile?.role === 'admin' && profile?.status === 'approved' && !document.hidden) loadUsers();
  }, 30000);
  // Download link is public and independent of Supabase login/configuration.
  void loadLatestDownload();
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
