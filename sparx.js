const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const USERNAME = 'matteoferrari';
const PASSWORD = 'bloom123';
const SCHOOL = process.env.SPARX_SCHOOL || '';
const HEADLESS = process.env.HEADLESS !== '0';
const SHOTS = path.join(__dirname, 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

const shot = async (page, name) => {
  const file = path.join(SHOTS, `${Date.now()}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  console.log(`screenshot: ${file}`);
};

const log = (...a) => console.log('[sparx]', ...a);

(async () => {
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  try {
    log('navigating to sparxmaths.uk');
    await page.goto('https://www.sparxmaths.uk/', { waitUntil: 'domcontentloaded' });
    await shot(page, 'home');

    // Try to find a "Student login" / "Login" link
    const loginCandidates = [
      'a:has-text("Student login")',
      'a:has-text("Student Login")',
      'a:has-text("Log in")',
      'a:has-text("Login")',
      'a[href*="login"]',
    ];
    for (const sel of loginCandidates) {
      const link = page.locator(sel).first();
      if (await link.count()) {
        log(`clicking login link: ${sel}`);
        await Promise.all([
          page.waitForLoadState('domcontentloaded'),
          link.click({ timeout: 5000 }).catch(() => {}),
        ]);
        break;
      }
    }
    await page.waitForTimeout(1500);
    await shot(page, 'login-landing');

    // Direct fallback to known student login URL
    if (!/login|auth|sign/i.test(page.url())) {
      log('falling back to direct student login URL');
      await page.goto('https://app.sparxmaths.uk/login', { waitUntil: 'domcontentloaded' }).catch(() => {});
      await shot(page, 'login-direct');
    }

    log('current url: ' + page.url());

    // School field (if present)
    const schoolField = page.locator(
      'input[placeholder*="school" i], input[name*="school" i], input[id*="school" i]'
    ).first();
    if (await schoolField.count()) {
      if (!SCHOOL) {
        log('!! school field detected but SPARX_SCHOOL env var not provided. Aborting.');
        await shot(page, 'needs-school');
        await browser.close();
        process.exit(2);
      }
      log('filling school field');
      await schoolField.fill(SCHOOL);
      await page.waitForTimeout(500);
      // try clicking suggestion
      const suggestion = page.locator(`[role="option"]:has-text("${SCHOOL}"), li:has-text("${SCHOOL}")`).first();
      if (await suggestion.count()) await suggestion.click().catch(() => {});
      await page.keyboard.press('Enter').catch(() => {});
      await page.waitForTimeout(1500);
      await shot(page, 'after-school');
    }

    // Username
    const userField = page.locator(
      'input[name*="user" i], input[id*="user" i], input[placeholder*="user" i], input[name="username"]'
    ).first();
    await userField.waitFor({ state: 'visible', timeout: 15000 });
    log('filling username');
    await userField.fill(USERNAME);

    // Password
    const passField = page.locator('input[type="password"]').first();
    await passField.waitFor({ state: 'visible', timeout: 15000 });
    log('filling password');
    await passField.fill(PASSWORD);
    await shot(page, 'creds-filled');

    // Submit
    const submit = page.locator(
      'button[type="submit"], button:has-text("Log in"), button:has-text("Login"), button:has-text("Sign in")'
    ).first();
    log('submitting login');
    await Promise.all([
      page.waitForLoadState('networkidle').catch(() => {}),
      submit.click(),
    ]);
    await page.waitForTimeout(3000);
    await shot(page, 'post-login');
    log('post-login url: ' + page.url());

    // Detect login failure
    const errLoc = page.locator('text=/incorrect|wrong|invalid|try again/i').first();
    if (await errLoc.count()) {
      log('!! login appears to have failed: ' + (await errLoc.textContent().catch(() => '')));
      await browser.close();
      process.exit(3);
    }

    // Find homework / compulsory homework section
    log('looking for homework list');
    const hwLink = page.locator(
      'a:has-text("Homework"), button:has-text("Homework"), [href*="homework" i]'
    ).first();
    if (await hwLink.count()) {
      await hwLink.click().catch(() => {});
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(2000);
    }
    await shot(page, 'homework-page');

    // Try to find homework cards with due dates and pick soonest
    log('scanning for homework due dates');
    const items = await page.evaluate(() => {
      const out = [];
      const cards = Array.from(document.querySelectorAll('a, button, div, li'));
      for (const el of cards) {
        const text = (el.innerText || '').trim();
        if (!text) continue;
        const m = text.match(/Due\s+([^\n]+)/i);
        if (m) {
          const rect = el.getBoundingClientRect();
          out.push({ text: text.slice(0, 200), due: m[1].trim(), x: rect.x, y: rect.y, w: rect.width, h: rect.height });
        }
      }
      return out;
    });
    log('candidates: ' + JSON.stringify(items.slice(0, 10), null, 2));

    // Pick the soonest "due" by parsing date
    const parseDue = (s) => {
      const now = Date.now();
      if (/today/i.test(s)) return now;
      if (/tomorrow/i.test(s)) return now + 86400000;
      const d = Date.parse(s);
      return Number.isFinite(d) ? d : Number.MAX_SAFE_INTEGER;
    };
    items.sort((a, b) => parseDue(a.due) - parseDue(b.due));
    if (items.length === 0) {
      log('!! no homework cards with "Due" found. Listing visible buttons/links instead.');
      const all = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a,button')).slice(0, 50).map(e => e.innerText).filter(Boolean)
      );
      log(JSON.stringify(all, null, 2));
      await shot(page, 'no-homework');
      await browser.close();
      process.exit(4);
    }

    const target = items[0];
    log('soonest due: ' + target.due + ' — text: ' + target.text.slice(0, 80));
    // click center of bounding box
    await page.mouse.click(target.x + target.w / 2, target.y + target.h / 2);
    await page.waitForTimeout(2500);
    await shot(page, 'homework-opened');

    // Look for a "Start", "Continue" or first task button
    const startBtn = page.locator(
      'button:has-text("Start"), button:has-text("Continue"), a:has-text("Start"), a:has-text("Continue")'
    ).first();
    if (await startBtn.count()) {
      log('clicking start/continue');
      await startBtn.click().catch(() => {});
      await page.waitForTimeout(2500);
      await shot(page, 'started');
    }

    log('reached solving view. Stopping here for review.');
    log('final url: ' + page.url());
    await page.waitForTimeout(2000);
  } catch (err) {
    log('ERROR: ' + (err && err.stack || err));
    await shot(page, 'error');
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
