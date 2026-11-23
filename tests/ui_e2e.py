"""Browser end-to-end check of the whole user path against tests/ui_harness.mjs (real worker, fake Telegram).
Run: node tests/ui_harness.mjs 8799 &  python3 tests/ui_e2e.py"""
import json, sys, urllib.parse, urllib.request, time
from playwright.sync_api import sync_playwright, expect

BASE = 'http://localhost:8799'
KEY = 'ui-test-admin-token-0123456789'
SHOTS = '/home/claude/shots'
problems, passed = [], []

def hit(op, **q):
    qs = '?' + urllib.parse.urlencode(q) if q else ''
    urllib.request.urlopen(f'{BASE}/__test/{op}{qs}').read()

def say(target, id, text, sender):
    hit('say', m=json.dumps({'target': target, 'id': id, 'text': text, 'sender': sender}))

def check(name, fn):
    try:
        fn(); passed.append(name); print('PASS', name)
    except Exception as e:
        problems.append((name, str(e)[:400])); print('FAIL', name, '->', str(e)[:400])

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={'width': 1440, 'height': 900}, accept_downloads=True)
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
    page.on('console', lambda m: errors.append(f'console.{m.type}: {m.text}') if m.type == 'error' else None)
    page.goto(BASE + '/')

    def gate():
        expect(page.locator('#gate')).to_be_visible()
        expect(page.locator('#shell')).to_be_hidden()
        page.fill('#gateKey', 'wrong-key'); page.click('#gateButton')
        expect(page.locator('#gateError')).to_contain_text('не принят')
        page.fill('#gateKey', KEY); page.click('#gateButton')
        expect(page.locator('#shell')).to_be_visible()
        expect(page.locator('#pageTitle')).to_have_text('Обзор')
        page.screenshot(path=f'{SHOTS}/01_overview.png')
    check('gate: wrong key refused, right key opens panel', gate)

    def overview():
        expect(page.locator('#dbPill')).to_have_text('Подключена')
        expect(page.locator('#tgPill')).to_have_text('Не подключён')
        expect(page.locator('#checklist li')).to_have_count(6)
    check('overview shows real D1 / Telegram status + checklist', overview)

    def creds():
        page.click('[data-nav=account]')
        expect(page.locator('#pageTitle')).to_have_text('Аккаунт Telegram')
        page.fill('#apiId', '12'); page.fill('#apiHash', 'abc'); page.click('#credsButton')
        expect(page.locator('#toast')).to_contain_text('API ID')
        page.fill('#apiId', '1234567'); page.fill('#apiHash', 'a' * 32); page.click('#credsButton')
        expect(page.locator('#credsPill')).to_have_text('Сохранены')
        expect(page.locator('#apiHash')).to_have_value('')
    check('credentials: invalid rejected with a clear message, valid saved, field cleared', creds)

    def qr():
        page.click('text=Показать QR-код')
        expect(page.locator('.qr-box svg')).to_be_visible()
        expect(page.locator('#loginPill')).to_have_text('Ждём сканирования')
        expect(page.locator('text=Войти вручную (по номеру телефона)')).to_be_visible()
        page.screenshot(path=f'{SHOTS}/02_qr.png')
        hit('scan')
        expect(page.locator('.account-card')).to_be_visible(timeout=8000)
        expect(page.locator('#loginPill')).to_have_text('Подключён')
        expect(page.locator('.account-info')).to_contain_text('@tester')
        page.screenshot(path=f'{SHOTS}/03_connected.png')
    check('QR login: QR rendered, scan -> connected account card', qr)

    def diag():
        page.click('#diagButton')
        expect(page.locator('#diagList li').first).to_be_visible(timeout=8000)
        page.screenshot(path=f'{SHOTS}/04_diag.png')
    check('diagnostics runs and lists steps', diag)

    def monitor():
        page.click('[data-nav=monitor]')
        say('-1001', 1, 'Куплю цемент оптом, нужна доставка', {'id': '1001', 'firstName': 'Иван', 'lastName': 'Петров', 'username': 'ivan', 'phone': '380501112233', 'isBot': False})
        say('-1001', 2, 'Всем привет!', {'id': '1002', 'firstName': 'Мария', 'lastName': None, 'username': 'maria', 'phone': None, 'isBot': False})
        say('-1001', 3, 'Ищу поставщика, куплю плитку', {'id': '1003', 'firstName': 'Олег', 'lastName': None, 'username': None, 'phone': None, 'isBot': False})
        say('-1003', 1, 'куплю кирпич, дорого не предлагать', {'id': '1001', 'firstName': 'Иван', 'lastName': 'Петров', 'username': 'ivan', 'phone': '380501112233', 'isBot': False})
        page.click('#loadDialogs')
        expect(page.locator('#dialogList li')).to_have_count(3)
        page.locator('#dialogList li', has_text='Будівельний ринок').locator('button').click()
        expect(page.locator('#sourcesBody tr', has_text='Будівельний ринок')).to_be_visible()
        page.locator('#dialogList li', has_text='Новини будівництва').locator('button').click()
        expect(page.locator('#sourcesBody tr', has_text='Новини будівництва')).to_be_visible()
        page.locator('#dialogList li', has_text='без комментариев').locator('button').click()
        expect(page.locator('#toast')).to_contain_text('нет группы комментариев')
        expect(page.locator('#sourcesBody tr')).to_have_count(2)
        page.screenshot(path=f'{SHOTS}/05_monitor_sources.png')
    check('monitor: pick chats; channel with comments added, channel without refused', monitor)

    def no_rules():
        page.click('#checkNow')
        expect(page.locator('#checkResult')).to_contain_text('ключевые слова', timeout=8000)
    check('manual check without keywords gives a clear message', no_rules)

    def rules_and_check():
        page.fill('#keywords', 'куплю\nоптом'); page.click('#rulesForm button[type=submit]')
        expect(page.locator('#toast')).to_contain_text('сохранены')
        page.click('#checkNow')
        expect(page.locator('#checkResult')).to_contain_text('новых пользователей: 2', timeout=8000)
        page.screenshot(path=f'{SHOTS}/06_monitor_result.png')
    check('manual check: 4 messages read, same person in 2 chats = 1 lead (2 new total)', rules_and_check)

    def leads():
        page.click('[data-nav=leads]')
        expect(page.locator('#leadsBody tr')).to_have_count(2)
        expect(page.locator('#leadsTotal')).to_have_text('2')
        row_oleg = page.locator('#leadsBody tr', has_text='Олег')
        expect(row_oleg.locator('td').nth(2)).to_have_text('Nope')
        expect(row_oleg.locator('td').nth(1)).to_have_text('—')
        row_ivan = page.locator('#leadsBody tr', has_text='Иван')
        expect(row_ivan).to_contain_text('@ivan'); expect(row_ivan).to_contain_text('×2')
        page.fill('#leadSearch', 'олег'); expect(page.locator('#leadsBody tr')).to_have_count(1)
        page.fill('#leadSearch', 'zzzz'); expect(page.locator('#leadsEmpty')).to_be_visible()
        page.fill('#leadSearch', ''); expect(page.locator('#leadsBody tr')).to_have_count(2)
        page.screenshot(path=f'{SHOTS}/07_leads.png')
    check('leads table: columns, Nope for missing phone, hit counter, search', leads)

    def export():
        with page.expect_download() as d:
            page.click('#exportButton')
        path = f'/home/claude/shots/{d.value.suggested_filename}'
        d.value.save_as(path)
        import openpyxl
        ws = openpyxl.load_workbook(path).active
        rows = [[c.value for c in r] for r in ws.iter_rows()]
        print('   xlsx rows:', rows)
        assert rows[0] == ['Имя', 'Ник', 'Номер телефона', 'Источник', 'Дата добавления в базу', 'Текст сообщения (триггер)'], rows[0]
        assert len(rows) == 3, len(rows)
        by = {r[0]: r for r in rows[1:]}
        assert by['Иван Петров'][1] == '@ivan' and by['Иван Петров'][2] == '380501112233' or by['Иван Петров'][2] == '+380501112233', by['Иван Петров']
        assert by['Олег'][2] == 'Nope' and by['Олег'][1] == '—'
        assert 'Куплю цемент' in by['Иван Петров'][5] or 'куплю кирпич' in by['Иван Петров'][5]
    check('Excel export downloads a real .xlsx with the requested columns', export)

    def logout_and_manual():
        page.click('[data-nav=account]')
        page.click('text=Выйти из аккаунта'); page.click('#modalOk')
        expect(page.locator('#loginPill')).to_have_text('Не подключён', timeout=8000)
        page.click('text=Войти вручную (по номеру телефона)')
        page.fill('#phoneInput', '12'); page.click('text=Получить код')
        expect(page.locator('#toast')).to_contain_text('международном формате')
        hit('twofa')
        page.fill('#phoneInput', '+380501234567'); page.click('text=Получить код')
        expect(page.locator('#codeInput')).to_be_visible(timeout=8000)
        page.fill('#codeInput', '11111'); page.click('text=Подтвердить')
        expect(page.locator('.result-message', has_text='Неверный код')).to_be_visible(timeout=8000)
        page.fill('#codeInput', '12345'); page.click('text=Подтвердить')
        expect(page.locator('#pwInput')).to_be_visible(timeout=8000)
        page.screenshot(path=f'{SHOTS}/08_password.png')
        page.fill('#pwInput', 'wrong'); page.click('#loginBody button:has-text("Войти")')
        expect(page.locator('.result-message', has_text='Неверный пароль')).to_be_visible(timeout=8000)
        page.fill('#pwInput', 'secret2fa'); page.click('#loginBody button:has-text("Войти")')
        expect(page.locator('.account-card')).to_be_visible(timeout=8000)
    check('manual login: bad number, wrong code, 2FA wrong/right password -> connected', logout_and_manual)

    def clear_and_lock():
        page.click('[data-nav=leads]')
        page.click('#clearButton'); page.click('#modalOk')
        expect(page.locator('#leadsTotal')).to_have_text('0')
        expect(page.locator('#leadsEmpty')).to_be_visible()
        page.click('#lockButton')
        expect(page.locator('#gate')).to_be_visible()
        page.reload()
        expect(page.locator('#gate')).to_be_visible()
    check('clear base needs confirmation; sign-out locks the panel (key not kept)', clear_and_lock)

    page.set_viewport_size({'width': 390, 'height': 800})
    page.fill('#gateKey', KEY); page.click('#gateButton')
    page.wait_for_selector('#shell:not([hidden])')
    page.screenshot(path=f'{SHOTS}/09_mobile.png')
    browser.close()

real_errors = [e for e in errors if 'favicon' not in e and 'Failed to load resource: the server responded with a status of 4' not in e]
print('\nbrowser errors:', real_errors or 'none')
print(f'\n{len(passed)} passed, {len(problems)} failed')
sys.exit(1 if problems or real_errors else 0)
