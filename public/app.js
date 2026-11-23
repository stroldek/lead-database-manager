/* Lead Database Manager 0.1.2 — browser UI.
   Classic script (not a module) so the interface also opens from a local file; the Excel builder is loaded lazily. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var isLocalPreview = window.location.protocol === 'file:';
  var KEY_STORE = 'ldm_access_key';
  var PAGES = {
    overview: ['СИСТЕМА УПРАВЛЕНИЯ ЛИДАМИ', 'Обзор'],
    account: ['ПОДКЛЮЧЕНИЕ', 'Аккаунт Telegram'],
    monitor: ['ТЕСТОВЫЙ МОНИТОРИНГ', 'Мониторинг чатов'],
    leads: ['ТЕСТОВАЯ БАЗА', 'Найденные пользователи']
  };
  var current = 'overview';
  var timers = { login: null, search: null };
  var leadsState = { page: 1, total: 0, q: '' };
  var dialogsCache = [];

  // ---------- helpers ----------
  function h(tag, attrs) {
    var el = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      if (k === 'class') el.className = attrs[k];
      else if (k === 'text') el.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== false && attrs[k] != null) el.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null || c === false) continue;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
  function setPill(el, label, kind) { if (!el) return; el.textContent = label; el.className = ('status-pill ' + (kind || '')).trim(); }
  function toast(message) {
    var t = $('toast'); if (!t) return;
    t.textContent = message; t.classList.add('show');
    clearTimeout(toast.t); toast.t = setTimeout(function () { t.classList.remove('show'); }, 4000);
  }
  function fmtDate(iso) {
    if (!iso) return '—';
    var d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : String(iso).replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleString('ru-RU', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function num(n) { return Number(n || 0).toLocaleString('ru-RU'); }

  function confirmModal(title, text, okLabel) {
    return new Promise(function (resolve) {
      var m = $('modal');
      $('modalTitle').textContent = title;
      $('modalText').textContent = text;
      $('modalOk').textContent = okLabel || 'Подтвердить';
      m.addEventListener('close', function once() { m.removeEventListener('close', once); resolve(m.returnValue === 'ok'); });
      if (typeof m.showModal === 'function') m.showModal(); else resolve(window.confirm(text));
    });
  }

  // ---------- API ----------
  function getKey() { try { return sessionStorage.getItem(KEY_STORE) || ''; } catch (e) { return ''; } }
  function setKey(v) { try { if (v) sessionStorage.setItem(KEY_STORE, v); else sessionStorage.removeItem(KEY_STORE); } catch (e) { /* storage may be blocked */ } }

  function api(path, opts) {
    opts = opts || {};
    var headers = { Authorization: 'Bearer ' + getKey() };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(path, {
      method: opts.method || 'GET', headers: headers, cache: 'no-store',
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    }).then(function (res) {
      return res.json().catch(function () { return { ok: false, error: 'Сервер вернул не-JSON ответ (' + res.status + ').' }; })
        .then(function (data) {
          if (res.status === 401 || res.status === 429) { lock(res.status === 429 ? 'Слишком много неверных попыток. Подождите 10 минут.' : 'Ключ не принят.'); }
          if (!res.ok || data.ok === false) { var err = new Error(data.error || ('Ошибка ' + res.status)); err.status = res.status; throw err; }
          return data.data;
        });
    });
  }
  function post(path, body) { return api(path, { method: 'POST', body: body || {} }); }

  // ---------- gate ----------
  function lock(message) {
    setKey('');
    stopLoginPolling();
    $('shell').hidden = true;
    $('gate').hidden = false;
    $('gateError').textContent = message || '';
    $('gateKey').value = '';
    $('gateKey').focus();
  }
  function unlock() {
    $('gate').hidden = true;
    $('shell').hidden = false;
    route();
  }
  function tryEnter(key) {
    setKey(key);
    return api('/api/auth/check').then(unlock);
  }

  // ---------- routing ----------
  function route() {
    var name = (location.hash || '#overview').slice(1);
    if (!PAGES[name]) name = 'overview';
    current = name;
    Array.prototype.forEach.call(document.querySelectorAll('.page'), function (p) { p.hidden = p.getAttribute('data-page') !== name; });
    Array.prototype.forEach.call(document.querySelectorAll('[data-nav]'), function (a) { a.classList.toggle('active', a.getAttribute('data-nav') === name); });
    $('pageEyebrow').textContent = PAGES[name][0];
    $('pageTitle').textContent = PAGES[name][1];
    stopLoginPolling();
    refresh();
  }
  function refresh() {
    if (isLocalPreview) return;
    var job = { overview: loadOverview, account: loadAccount, monitor: loadMonitor, leads: loadLeads }[current];
    job().catch(function (e) { if (e.status !== 401) toast(e.message); });
    refreshSide();
  }
  function refreshSide() {
    api('/api/tg/status').then(function (s) {
      var ok = s.state === 'connected';
      $('sideStatus').textContent = ok ? 'Telegram подключён' : 'Telegram не подключён';
      $('sideSub').textContent = ok && s.me ? ((s.me.firstName || '') + (s.me.username ? ' @' + s.me.username : '')).trim() : 'Технический прототип';
    }).catch(function () { /* side status is optional */ });
  }

  // ---------- overview ----------
  function loadOverview() {
    return Promise.all([
      fetch('/api/health', { cache: 'no-store' }).then(function (r) { return r.json(); }).catch(function () { return null; }),
      api('/api/tg/status').catch(function () { return null; }),
      api('/api/monitor/state').catch(function () { return null; })
    ]).then(function (r) {
      var health = r[0], st = r[1], mon = r[2];
      var db = health && health.checks && health.checks.database;
      var migrated = !!mon;
      if (db === 'connected' && migrated) { setPill($('dbPill'), 'Подключена', 'ok'); $('dbText').textContent = 'Worker читает и пишет в D1.'; }
      else if (db === 'connected') { setPill($('dbPill'), 'Нужна миграция 0002', 'error'); $('dbText').textContent = 'Выполните 0002_live_telegram_test.sql в D1 → SQL Console.'; }
      else { setPill($('dbPill'), db === 'not_configured' ? 'Нет binding' : 'Ошибка', 'error'); $('dbText').textContent = 'Проверьте D1 binding «DB» и миграции.'; }
      $('leadCount').textContent = mon ? num(mon.leadsCount) : '—';

      if (st && st.state === 'connected') { setPill($('tgPill'), 'Подключён', 'ok'); $('tgText').textContent = 'Аккаунт на связи с Telegram.'; $('tgWho').textContent = st.me ? ((st.me.firstName || '') + (st.me.username ? ' @' + st.me.username : '')).trim() : '—'; }
      else if (st && st.state === 'disconnected') { setPill($('tgPill'), 'Спит', 'preview'); $('tgText').textContent = 'Сессия сохранена, переподключается при первом запросе.'; $('tgWho').textContent = st.me ? (st.me.firstName || '') : '—'; }
      else { setPill($('tgPill'), 'Не подключён', 'error'); $('tgText').textContent = (st && st.error) || 'Войдите на вкладке «Аккаунт Telegram».'; $('tgWho').textContent = '—'; }

      if (mon) {
        var running = mon.settings.running;
        setPill($('monPill'), running ? 'Работает' : 'Остановлен', running ? 'ok' : 'preview');
        $('monText').textContent = running ? 'Проверка каждые ' + mon.settings.intervalSeconds + ' с.' : 'Запустите на вкладке «Мониторинг».';
        $('monSources').textContent = num(mon.sources.length);
      } else { setPill($('monPill'), '—', 'preview'); $('monText').textContent = 'Нет данных (проверьте миграцию).'; $('monSources').textContent = '—'; }

      var items = [
        ['Ключи my.telegram.org сохранены', !!(st && st.hasCredentials)],
        ['Аккаунт Telegram подключён', !!(st && (st.state === 'connected' || st.hasSession))],
        ['Добавлен хотя бы один чат', !!(mon && mon.sources.length)],
        ['Заданы ключевые слова', !!(mon && (mon.settings.matchAny || (mon.settings.keywords || '').trim()))],
        ['В базе есть найденные пользователи', !!(mon && mon.leadsCount > 0)]
      ];
      var list = clear($('checklist'));
      items.forEach(function (it) { list.appendChild(h('li', { class: it[1] ? 'done' : '' }, h('span', { class: 'tick', 'aria-hidden': 'true', text: it[1] ? '✓' : '○' }), it[0], it[1] ? h('em', { text: ' — готово' }) : null)); });
      list.appendChild(h('li', {}, h('span', { class: 'tick', 'aria-hidden': 'true', text: '○' }), 'Excel скачан и открывается (проверьте вручную на вкладке «Тестовая база»)'));
    });
  }

  // ---------- account ----------
  function stopLoginPolling() { if (timers.login) { clearInterval(timers.login); timers.login = null; } }
  function startLoginPolling() {
    if (timers.login || current !== 'account') return;
    timers.login = setInterval(function () { api('/api/tg/status').then(renderAccount).catch(function () { /* next tick */ }); }, 2000);
  }

  function loadAccount() { return api('/api/tg/status').then(renderAccount); }

  function renderAccount(s) {
    if (current !== 'account') return;
    var credsPill = $('credsPill');
    if (s.hasCredentials) setPill(credsPill, s.credentialsSource === 'env' ? 'Заданы в Cloudflare' : 'Сохранены', 'ok'); else setPill(credsPill, 'Нужны', 'error');
    $('credsForm').hidden = s.credentialsSource === 'env';

    var pillMap = { connected: ['Подключён', 'ok'], qr_pending: ['Ждём сканирования', 'preview'], code_pending: ['Ждём код', 'preview'], password_needed: ['Нужен пароль', 'preview'], connecting: ['Соединяемся…', 'preview'], error: ['Ошибка', 'error'], disconnected: ['Сессия сохранена', 'preview'], logged_out: ['Не подключён', 'error'] };
    var p = pillMap[s.state] || ['—', 'preview'];
    setPill($('loginPill'), p[0], p[1]);

    var body = $('loginBody');
    // Do not rebuild while the user is typing into a field of the same state.
    var sig = [s.state, s.qr && s.qr.url, s.notice, s.error, s.passwordHint, s.hasCredentials].join('|');
    if (body.getAttribute('data-sig') === sig) { if (s.state !== 'connected' && s.state !== 'logged_out' && s.state !== 'error') startLoginPolling(); return; }
    body.setAttribute('data-sig', sig);
    clear(body);

    if (s.notice) body.appendChild(h('div', { class: 'result-message', text: s.notice }));
    if (s.error && (s.state === 'error' || s.state === 'logged_out' || s.state === 'disconnected')) body.appendChild(h('div', { class: 'result-message error', text: s.error }));

    if (s.state === 'connected' || s.state === 'disconnected') {
      var me = s.me || {};
      body.appendChild(h('div', { class: 'account-card' },
        h('div', { class: 'avatar', 'aria-hidden': 'true', text: (me.firstName || '?').slice(0, 1).toUpperCase() }),
        h('div', { class: 'account-info' },
          h('strong', { text: ((me.firstName || '') + ' ' + (me.lastName || '')).trim() || 'Аккаунт' }),
          h('span', { text: [me.username ? '@' + me.username : null, me.phoneMasked].filter(Boolean).join(' · ') || '—' }),
          h('small', { text: s.state === 'connected' ? 'Соединение активно' : 'Сессия сохранена — соединение откроется автоматически' })),
        h('button', { class: 'button button-danger', type: 'button', onclick: doLogout, text: 'Выйти из аккаунта' })));
      body.appendChild(h('p', { class: 'panel-text', text: 'Сессия хранится в зашифрованном виде на сервере. Сейчас программа только читает выбранные вами чаты: сообщения не отправляются, профиль не меняется. Удаление аккаунта этим подключением не предусмотрено.' }));
      stopLoginPolling();
      return;
    }

    if (s.state === 'qr_pending' && s.qr) {
      var holder = h('div', { class: 'qr-box' });
      holder.innerHTML = window.QR ? window.QR.svg(s.qr.url, { fg: '#10151a', bg: '#ffffff', quiet: 3 }) : '';
      body.appendChild(h('div', { class: 'qr-layout' }, holder,
        h('ol', { class: 'qr-steps' },
          h('li', { text: 'Откройте Telegram на телефоне.' }),
          h('li', { text: 'Настройки → Устройства → Подключить устройство.' }),
          h('li', { text: 'Наведите камеру на этот QR-код.' }),
          h('li', { text: 'Если включена двухэтапная проверка, программа попросит пароль.' }),
          h('li', { class: 'muted', text: 'Код обновляется сам примерно раз в 30 секунд.' }))));
      body.appendChild(h('div', { class: 'form-row tight' },
        h('button', { class: 'button button-quiet', type: 'button', onclick: doCancel, text: 'Отмена' }),
        h('button', { class: 'link-button', type: 'button', onclick: doStartPhoneForm, text: 'Войти вручную (по номеру телефона)' })));
      startLoginPolling();
      return;
    }

    if (s.state === 'code_pending') {
      var codeInput = h('input', { id: 'codeInput', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '12345', maxlength: '8' });
      body.appendChild(h('p', { class: 'panel-text', text: 'Telegram отправил код входа в приложение Telegram на другом вашем устройстве (или SMS). Введите его:' }));
      body.appendChild(h('form', { class: 'form-row', onsubmit: function (e) { e.preventDefault(); doSend('/api/tg/login/code', { code: codeInput.value }); } },
        h('div', { class: 'field' }, h('label', { for: 'codeInput', text: 'Код' }), codeInput),
        h('button', { class: 'button button-primary', type: 'submit', text: 'Подтвердить' }),
        h('button', { class: 'button button-quiet', type: 'button', onclick: doCancel, text: 'Отмена' })));
      setTimeout(function () { codeInput.focus(); }, 0);
      startLoginPolling();
      return;
    }

    if (s.state === 'password_needed') {
      var pw = h('input', { id: 'pwInput', type: 'password', autocomplete: 'current-password', placeholder: 'Пароль' });
      body.appendChild(h('p', { class: 'panel-text', text: 'Включена двухэтапная проверка.' + (s.passwordHint ? ' Подсказка: ' + s.passwordHint + '.' : '') + ' Введите облачный пароль Telegram. Он передаётся только на ваш сервер и не сохраняется.' }));
      body.appendChild(h('form', { class: 'form-row', onsubmit: function (e) { e.preventDefault(); var v = pw.value; pw.value = ''; doSend('/api/tg/login/password', { password: v }); } },
        h('div', { class: 'field grow' }, h('label', { for: 'pwInput', text: 'Пароль' }), pw),
        h('button', { class: 'button button-primary', type: 'submit', text: 'Войти' }),
        h('button', { class: 'button button-quiet', type: 'button', onclick: doCancel, text: 'Отмена' })));
      setTimeout(function () { pw.focus(); }, 0);
      startLoginPolling();
      return;
    }

    if (s.state === 'connecting') {
      body.appendChild(h('div', { class: 'result-message', text: 'Соединяемся с Telegram…' }));
      startLoginPolling();
      return;
    }

    // logged_out / error: offer both ways
    body.appendChild(h('p', { class: 'panel-text', text: 'Основной способ — QR-код: быстро и без SMS. Если QR не подходит, рядом есть вход по номеру телефона.' }));
    body.appendChild(h('div', { class: 'form-row tight' },
      h('button', { class: 'button button-primary', type: 'button', disabled: !s.hasCredentials, onclick: doStartQr, text: 'Показать QR-код' }),
      h('button', { class: 'link-button', type: 'button', disabled: !s.hasCredentials, onclick: doStartPhoneForm, text: 'Войти вручную (по номеру телефона)' })));
    if (!s.hasCredentials) body.appendChild(h('small', { class: 'hint', text: 'Сначала сохраните ключи на шаге 1.' }));
    stopLoginPolling();
  }

  function guard(fn) { return fn().catch(function (e) { if (e.status !== 401) toast(e.message); }); }
  function doSend(path, body) { return guard(function () { return post(path, body).then(renderAccount).then(refreshSide); }); }
  function doStartQr() { toast('Готовим QR-код…'); return guard(function () { return post('/api/tg/login/qr').then(renderAccount); }); }
  function doCancel() { return guard(function () { return post('/api/tg/login/cancel').then(function (s) { $('loginBody').removeAttribute('data-sig'); return renderAccount(s); }); }); }
  function doStartPhoneForm() {
    // Cancel a running QR flow first, then ask for the number.
    guard(function () { return post('/api/tg/login/cancel'); }).then(function () {
      stopLoginPolling();
      var body = clear($('loginBody'));
      body.setAttribute('data-sig', 'phone-form');
      var phone = h('input', { id: 'phoneInput', type: 'tel', inputmode: 'tel', autocomplete: 'tel', placeholder: '+380501234567' });
      body.appendChild(h('p', { class: 'panel-text', text: 'Введите номер аккаунта в международном формате. Код придёт в Telegram на другом вашем устройстве (или SMS).' }));
      body.appendChild(h('form', { class: 'form-row', onsubmit: function (e) { e.preventDefault(); doSend('/api/tg/login/phone', { phone: phone.value }); } },
        h('div', { class: 'field grow' }, h('label', { for: 'phoneInput', text: 'Номер телефона' }), phone),
        h('button', { class: 'button button-primary', type: 'submit', text: 'Получить код' }),
        h('button', { class: 'button button-quiet', type: 'button', onclick: function () { body.removeAttribute('data-sig'); guard(loadAccount); }, text: 'Назад' })));
      phone.focus();
    });
  }
  function doLogout() {
    confirmModal('Выйти из аккаунта?', 'Сессия будет закрыта в Telegram и удалена с сервера. Мониторинг остановится. Войти можно будет снова.', 'Выйти').then(function (ok) {
      if (!ok) return;
      guard(function () { return post('/api/tg/logout', { confirm: 'LOGOUT' }).then(function (s) { $('loginBody').removeAttribute('data-sig'); renderAccount(s); refreshSide(); }); });
    });
  }

  function runDiagnostics() {
    var btn = $('diagButton'), list = clear($('diagList'));
    btn.disabled = true; btn.textContent = 'Проверяем…';
    guard(function () { return api('/api/tg/diagnostics').then(function (d) {
      d.steps.forEach(function (st) {
        list.appendChild(h('li', { class: st.ok ? 'ok' : 'fail' }, h('span', { class: 'tick', 'aria-hidden': 'true', text: st.ok ? '✓' : '✕' }),
          h('span', { class: 'diag-title', text: st.title || st.name }), st.detail ? h('small', { text: st.detail }) : null, st.ms ? h('em', { text: st.ms + ' мс' }) : null));
      });
      if (d.steps.every(function (s) { return s.ok; })) list.appendChild(h('li', { class: 'ok summary' }, 'Все проверки пройдены: можно входить в аккаунт.'));
    }); }).then(function () { btn.disabled = false; btn.textContent = 'Запустить проверку'; });
  }

  // ---------- monitor ----------
  function loadMonitor() {
    return api('/api/monitor/state').then(function (m) { renderMonitor(m, true); });
  }
  function renderMonitor(m, fillForm) {
    if (fillForm) {
      $('keywords').value = m.settings.keywords || '';
      $('matchAny').checked = !!m.settings.matchAny;
      $('interval').value = m.settings.intervalSeconds;
    }
    var running = m.settings.running;
    $('runToggle').textContent = running ? 'Остановить мониторинг' : 'Запустить мониторинг';
    $('runToggle').className = 'button ' + (running ? 'button-danger' : 'button-primary');
    $('runToggle').setAttribute('data-running', running ? '1' : '0');
    var line = running ? 'Работает: проверка каждые ' + m.settings.intervalSeconds + ' с. Найдено пользователей: ' + num(m.leadsCount) + '.' : 'Остановлен. Найдено пользователей: ' + num(m.leadsCount) + '.';
    if (m.pausedUntil) line += ' Telegram попросил паузу до ' + new Date(m.pausedUntil).toLocaleTimeString('ru-RU') + '.';
    if (m.telegramState !== 'connected') line += ' Аккаунт сейчас: ' + ({ disconnected: 'спит (проснётся сам)', logged_out: 'не подключён', error: 'ошибка', connecting: 'подключается' }[m.telegramState] || m.telegramState) + '.';
    $('runState').textContent = line;

    var tb = clear($('sourcesBody'));
    if (!m.sources.length) tb.appendChild(h('tr', {}, h('td', { colspan: '6', class: 'empty-cell', text: 'Пока ни одного чата. Нажмите «Выбрать из моих чатов».' })));
    m.sources.forEach(function (s) {
      var kind = { group: 'Группа', supergroup: 'Супергруппа', channel: 'Канал + комментарии' }[s.kind] || s.kind;
      tb.appendChild(h('tr', {},
        h('td', {}, h('strong', { text: s.title }), s.last_error ? h('small', { class: 'cell-error', text: s.last_error }) : null),
        h('td', { text: kind }),
        h('td', { text: s.target_title && s.target_title !== s.title ? s.target_title : 'сам чат' }),
        h('td', { text: num(s.messages_seen) }),
        h('td', { text: s.baseline_done ? fmtDate(s.last_checked_at) : 'ещё не проверялся' }),
        h('td', {}, h('button', { class: 'button button-quiet small', type: 'button', onclick: function () { guard(function () { return post('/api/monitor/sources/remove', { id: s.id }).then(loadMonitor); }); }, text: 'Убрать' }))));
    });

    var log = clear($('logList'));
    if (!m.log.length) log.appendChild(h('li', { class: 'muted', text: 'Событий пока нет.' }));
    m.log.forEach(function (e) { log.appendChild(h('li', { class: e.level }, h('time', { text: fmtDate(e.at) }), h('span', { text: e.message }))); });
  }

  /** Saves keywords / interval. Resolves true on success so callers can chain. */
  function saveRules(e) {
    if (e && e.preventDefault) e.preventDefault();
    return post('/api/monitor/settings', { keywords: $('keywords').value, matchAny: $('matchAny').checked, intervalSeconds: Number($('interval').value) })
      .then(function () { if (e) toast('Условия сохранены.'); return true; })
      .catch(function (err) { if (err.status !== 401) toast(err.message); return false; });
  }
  function toggleRun() {
    var starting = $('runToggle').getAttribute('data-running') !== '1';
    return saveRules().then(function (ok) {
      if (!ok) return null;
      return guard(function () { return post('/api/monitor/settings', { running: starting }).then(function () { toast(starting ? 'Мониторинг запущен.' : 'Мониторинг остановлен.'); }); });
    }).then(function () { return guard(loadMonitor); });
  }
  function checkNow() {
    var btn = $('checkNow'), box = $('checkResult');
    btn.disabled = true; btn.textContent = 'Проверяем…'; box.textContent = '';
    box.className = 'result-box';
    saveRules().then(function (ok) {
      if (!ok) throw Object.assign(new Error('Условия не сохранены — исправьте их и повторите.'), { status: 0 });
      return post('/api/monitor/check', { backfill: Number($('backfill').value) });
    }).then(function (r) {
      box.className = 'result-box show';
      clear(box);
      box.appendChild(h('div', { class: 'result-line' }, h('strong', { text: 'Прочитано сообщений: ' + num(r.checked) }), ' · совпало: ' + num(r.matched) + ' · новых пользователей: ' + num(r.newLeads) + ' · уже были в базе: ' + num(r.knownLeads + r.repeated)));
      (r.perSource || []).forEach(function (p) {
        box.appendChild(h('div', { class: 'result-sub' + (p.error ? ' error' : '') }, p.error ? p.title + ': ' + p.error : p.title + ': прочитано ' + num(p.read) + ', совпало ' + num(p.matched) + ', новых ' + num(p.newLeads)));
      });
      if (r.checked > 0 && r.matched === 0) box.appendChild(h('div', { class: 'result-sub', text: 'Сообщения читаются, но ни одно не содержит ваших слов. Для проверки связи временно включите «Любое сообщение».' }));
      return guard(loadMonitor);
    }).catch(function (e) { if (e.status !== 401) { box.className = 'result-box show error'; box.textContent = e.message; } })
      .then(function () { btn.disabled = false; btn.textContent = 'Проверить'; });
  }

  function openDialogs() {
    var picker = $('dialogPicker'), list = clear($('dialogList'));
    picker.hidden = false;
    list.appendChild(h('li', { class: 'muted', text: 'Загружаем чаты…' }));
    api('/api/tg/dialogs').then(function (d) { dialogsCache = d; renderDialogs(); })
      .catch(function (e) { dialogsCache = []; clear(list).appendChild(h('li', { class: 'muted', text: e.message })); });
  }
  function renderDialogs() {
    var q = $('dialogFilter').value.trim().toLowerCase();
    var list = clear($('dialogList'));
    var shown = dialogsCache.filter(function (d) { return !q || d.title.toLowerCase().indexOf(q) >= 0; });
    if (!shown.length) list.appendChild(h('li', { class: 'muted', text: dialogsCache.length ? 'Ничего не найдено.' : 'Чаты не найдены.' }));
    shown.forEach(function (d) {
      var kind = { group: 'группа', supergroup: 'супергруппа', channel: 'канал' }[d.kind] || d.kind;
      var btn = h('button', { class: 'button small' + (d.monitored ? ' button-quiet' : ''), type: 'button', disabled: d.monitored, text: d.monitored ? 'Добавлен' : 'Добавить' });
      btn.addEventListener('click', function () {
        btn.disabled = true; btn.textContent = '…';
        post('/api/monitor/sources', { id: d.id }).then(function () { d.monitored = true; toast('Добавлено: ' + d.title); renderDialogs(); return loadMonitor(); })
          .catch(function (e) { btn.disabled = false; btn.textContent = 'Добавить'; if (e.status !== 401) toast(e.message); });
      });
      list.appendChild(h('li', {}, h('span', { class: 'picker-title', text: d.title }), h('small', { text: kind + (d.members ? ' · ' + num(d.members) + ' уч.' : '') }), btn));
    });
  }

  // ---------- leads ----------
  function loadLeads() {
    var size = Number($('pageSize').value) || 25;
    var qs = '?limit=' + size + '&page=' + leadsState.page + (leadsState.q ? '&q=' + encodeURIComponent(leadsState.q) : '');
    return api('/api/leads' + qs).then(function (d) {
      leadsState.total = d.total;
      $('leadsTotal').textContent = num(d.total);
      var tb = clear($('leadsBody'));
      d.rows.forEach(function (l) {
        var name = [l.first_name, l.last_name].filter(Boolean).join(' ') || '—';
        tb.appendChild(h('tr', {},
          h('td', {}, name, l.hits_count > 1 ? h('span', { class: 'hits', title: 'Сообщений, подошедших под условия', text: '×' + l.hits_count }) : null),
          h('td', { text: l.username ? '@' + l.username : '—' }),
          h('td', { text: l.phone || 'Nope' }),
          h('td', { text: l.source_title || '—' }),
          h('td', { text: fmtDate(l.created_at) }),
          h('td', { class: 'trigger', title: l.trigger_text || '' }, l.trigger_keyword ? h('span', { class: 'kw', text: l.trigger_keyword === '*' ? 'любое' : l.trigger_keyword }) : null, ' ' + (l.trigger_text || ''))));
      });
      var empty = $('leadsEmpty');
      empty.hidden = d.rows.length > 0;
      empty.textContent = leadsState.q ? 'По запросу ничего не найдено.' : 'База пока пуста. Подключите аккаунт, добавьте чат и запустите проверку на вкладке «Мониторинг».';
      var pages = Math.max(Math.ceil(d.total / size), 1);
      $('pageInfo').textContent = 'Страница ' + d.page + ' из ' + pages;
      $('prevPage').disabled = d.page <= 1;
      $('nextPage').disabled = d.page >= pages;
    });
  }

  function exportExcel() {
    var btn = $('exportButton');
    btn.disabled = true; btn.textContent = 'Готовим файл…';
    var headers = null, rows = [];
    function step(after) {
      return api('/api/export/leads?after=' + after).then(function (d) {
        headers = d.headers;
        for (var i = 0; i < d.rows.length; i++) rows.push(d.rows[i]);
        btn.textContent = 'Готовим файл… ' + num(rows.length) + (d.total ? ' из ' + num(d.total) : '');
        return d.next ? step(d.next) : null;
      });
    }
    step(0).then(function () { return import('./lib/xlsx.js'); }).then(function (mod) {
      if (!rows.length) { toast('В базе пока нет записей для выгрузки.'); return; }
      var bytes = mod.buildXlsx(headers, rows, { sheetName: 'Лиды', widths: [24, 18, 18, 32, 20, 70] });
      var blob = new Blob([bytes], { type: mod.XLSX_MIME });
      var a = document.createElement('a');
      var d = new Date();
      a.href = URL.createObjectURL(blob);
      a.download = 'leads_' + d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + '.xlsx';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
      toast('Файл скачан: ' + a.download + ' (' + num(rows.length) + ' строк).');
    }).catch(function (e) { if (e.status !== 401) toast(e.message || 'Не удалось собрать файл.'); })
      .then(function () { btn.disabled = false; btn.textContent = '⇩ Скачать Excel'; });
  }

  function clearLeads() {
    confirmModal('Очистить тестовую базу?', 'Будут удалены все найденные пользователи и их сообщения-триггеры. Подключение к Telegram и настройки останутся. Действие нельзя отменить.', 'Удалить всё').then(function (ok) {
      if (!ok) return;
      guard(function () { return post('/api/leads/clear', { confirm: 'DELETE' }).then(function () { toast('База очищена.'); leadsState.page = 1; return loadLeads(); }); });
    });
  }

  // ---------- stage-1 bot webhook (optional) ----------
  function registerWebhook() {
    var input = $('setupToken'), result = $('setupResult'), btn = $('registerButton');
    var token = input.value.trim();
    result.className = 'result-message flush'; result.textContent = '';
    if (!token) { result.textContent = 'Введите SETUP_TOKEN.'; result.classList.add('error'); return; }
    btn.disabled = true;
    fetch('/api/setup/telegram-webhook', { method: 'POST', headers: { 'X-Setup-Token': token } })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok || !d.ok) throw new Error(d.error || 'Не удалось зарегистрировать webhook.'); return d; }); })
      .then(function (d) { result.textContent = 'Webhook зарегистрирован' + (d.bot_username ? ' для @' + d.bot_username : '') + '.'; })
      .catch(function (e) { result.textContent = e.message; result.classList.add('error'); })
      .then(function () { input.value = ''; btn.disabled = false; });
  }

  // ---------- init ----------
  function saveCreds(e) {
    e.preventDefault();
    var btn = $('credsButton'); btn.disabled = true;
    post('/api/tg/credentials', { api_id: $('apiId').value, api_hash: $('apiHash').value })
      .then(function (s) { $('apiHash').value = ''; $('apiId').value = ''; $('loginBody').removeAttribute('data-sig'); toast('Ключи сохранены.'); renderAccount(s); })
      .catch(function (err) { if (err.status !== 401) toast(err.message); })
      .then(function () { btn.disabled = false; });
  }

  function init() {
    $('gateForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = $('gateButton'); btn.disabled = true; $('gateError').textContent = '';
      tryEnter($('gateKey').value.trim()).catch(function (err) {
        if (err.status === 503) { setKey(''); $('gateError').textContent = 'Сервер не настроен: ' + err.message; }
      }).then(function () { btn.disabled = false; });
    });
    $('lockButton').addEventListener('click', function () { lock(''); });
    $('refreshButton').addEventListener('click', refresh);
    $('credsForm').addEventListener('submit', saveCreds);
    $('diagButton').addEventListener('click', runDiagnostics);
    $('rulesForm').addEventListener('submit', saveRules);
    $('runToggle').addEventListener('click', toggleRun);
    $('checkNow').addEventListener('click', checkNow);
    $('loadDialogs').addEventListener('click', openDialogs);
    $('dialogFilter').addEventListener('input', renderDialogs);
    $('exportButton').addEventListener('click', exportExcel);
    $('clearButton').addEventListener('click', clearLeads);
    $('registerButton').addEventListener('click', registerWebhook);
    $('pageSize').addEventListener('change', function () { leadsState.page = 1; guard(loadLeads); });
    $('prevPage').addEventListener('click', function () { leadsState.page = Math.max(1, leadsState.page - 1); guard(loadLeads); });
    $('nextPage').addEventListener('click', function () { leadsState.page += 1; guard(loadLeads); });
    $('leadSearch').addEventListener('input', function () {
      clearTimeout(timers.search);
      timers.search = setTimeout(function () { leadsState.q = $('leadSearch').value.trim(); leadsState.page = 1; guard(loadLeads); }, 300);
    });
    window.addEventListener('hashchange', function () { if (!$('shell').hidden) route(); });

    if (isLocalPreview) {
      $('gate').hidden = true; $('shell').hidden = false; $('previewBanner').hidden = false;
      $('sideStatus').textContent = 'Локальный предпросмотр';
      route();
      return;
    }
    if (!getKey()) { lock(''); return; }
    api('/api/auth/check').then(unlock).catch(function (err) {
      if (err.status === 503) { setKey(''); $('gate').hidden = false; $('gateError').textContent = 'Сервер не настроен: ' + err.message; }
    });
  }

  init();
})();
