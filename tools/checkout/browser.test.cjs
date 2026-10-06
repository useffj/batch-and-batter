// CHECKOUT_MOCK_BROWSER_ONLY. Run against a loopback Next development server.
// All Stripe requests are fulfilled locally; all other external requests are blocked.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdir } = require('node:fs/promises');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.CHECKOUT_TEST_URL || 'http://127.0.0.1:3109';
assert.equal(new URL(base).hostname, '127.0.0.1');
const id = '01K00000000000000000000001';
const dropId = '01K00000000000000000000002';
const productId = '01K00000000000000000000003';
const tag = '"' + 'a'.repeat(64) + '"';
const pickupDate = new Date(Date.now() + 7 * 86400000)
  .toISOString()
  .slice(0, 10);
function fixture(state = 'ready') {
  const now = Date.now();
  return {
    cart: {
      cartId: id,
      dropId,
      status:
        state === 'paid'
          ? 'CONVERTED'
          : state === 'ready'
            ? 'ACTIVE'
            : state === 'failed'
              ? 'CANCELLED'
              : 'PAYMENT_PENDING',
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      shoppingExpiresAt: new Date(now + 480000).toISOString(),
      items: [{ productId, quantity: 2, priceCents: 525, cookieUnits: 1 }],
    },
    etag: tag,
    payment:
      state === 'ready'
        ? null
        : {
            orderId: dropId,
            paymentAttemptId: productId,
            status: state,
            paymentDeadline: new Date(now + 240000).toISOString(),
            continuationGeneration: 1,
            ...(state === 'action_required'
              ? { clientSecret: 'pi_mock_secret_transient' }
              : {}),
          },
    paymentEtag: state === 'ready' ? null : tag,
    serverNow: now,
    available: state === 'ready',
    summary: { currency: 'USD', subtotal: 1050, tax: 0, fees: 0, total: 1050 },
    drop: {
      id: dropId,
      status: 'OPEN',
      name: 'Mock cookies',
      description: '',
      opensAt: new Date(now).toISOString(),
      quantityLimit: 12,
      timezone: 'UTC',
      pickupLocation: 'Neighborhood pickup kitchen',
      pickupInstructions: 'Please use the front door.',
      products: [
        {
          id: productId,
          name: 'Brown Butter Chocolate Chip',
          priceCents: 900,
          cookieUnits: 1,
          available: 10,
        },
      ],
      pickupDates: [
        {
          date: pickupDate,
          startTime: '16:00',
          endTime: '19:00',
          timezone: 'America/Denver',
        },
      ],
    },
  };
}
function installStripeMock() {
  window.__checkoutMock = { calls: [], validationError: false };
  window.Stripe = () => ({
    _registerWrapper() {},
    registerAppInfo() {},
    createToken() {},
    createPaymentMethod() {},
    confirmCardPayment() {
      throw Error('Unexpected confirmation');
    },
    elements(options) {
      window.__checkoutMock.options = options;
      return {
        create(type) {
          const handlers = {};
          let node;
          return {
            on(name, fn) {
              handlers[name] = fn;
              if (name === 'ready') queueMicrotask(() => fn({}));
            },
            off(name) {
              delete handlers[name];
            },
            update() {},
            mount(target) {
              node = document.createElement('div');
              node.style.cssText =
                'border:1px solid #aaa;padding:16px;margin:12px 0;min-height:64px;max-width:100%';
              if (type === 'expressCheckout') {
                const button = document.createElement('button');
                button.type = 'button';
                button.textContent = 'Mock wallet';
                button.onclick = () =>
                  handlers.click?.({
                    resolve: () =>
                      handlers.confirm?.({
                        paymentFailed: () =>
                          window.__checkoutMock.calls.push('wallet-failed'),
                      }),
                  });
                node.append(button);
              } else {
                node.textContent = 'Secure Payment Element — local mock';
                node.setAttribute('role', 'group');
                node.setAttribute('aria-label', 'Secure payment details');
              }
              target.append(node);
            },
            destroy() {
              node?.remove();
            },
            unmount() {
              node?.remove();
            },
          };
        },
        update() {},
        submit: async () => {
          window.__checkoutMock.calls.push('elements.submit');
          return window.__checkoutMock.validationError
            ? { error: { message: 'Not exposed' } }
            : {};
        },
      };
    },
    createConfirmationToken: async () => {
      window.__checkoutMock.calls.push('token');
      return { confirmationToken: { id: 'ctoken_browserMock' } };
    },
    handleNextAction: async () => {
      window.__checkoutMock.calls.push('action');
      await fetch('/__checkout_mock_action');
      return { paymentIntent: { status: 'succeeded' } };
    },
  });
  window.Stripe.version = 'endive';
}
test('mock checkout browser: responsive, accessible forms, wallet, recovery and canonical states', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext();
  let state = 'ready',
    startMode = 'processing',
    starts = 0;
  const requests = [],
    external = [],
    errors = [];
  let current = fixture();
  function advance(nextState) {
    const next = fixture(nextState);
    if (current.payment && next.payment)
      next.payment.paymentDeadline = current.payment.paymentDeadline;
    current = next;
  }
  await context.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === 'js.stripe.com')
      return route.fulfill({
        contentType: 'text/javascript',
        body: `(${installStripeMock.toString()})();`,
      });
    if (u.origin !== base) {
      external.push(u.origin);
      return route.abort();
    }
    if (u.pathname === '/__checkout_mock_action') {
      advance('processing');
      return route.fulfill({ json: {} });
    }
    if (u.pathname === '/api/checkout')
      return route.fulfill({ json: { ...current, serverNow: Date.now() } });
    if (u.pathname === '/api/checkout/start') {
      starts++;
      requests.push(route.request().postDataJSON());
      if (startMode === 'ambiguous') return route.abort();
      if (startMode === 'disabled')
        return route.fulfill({
          status: 503,
          json: { code: 'PAYMENTS_DISABLED' },
        });
      state = startMode;
      current = fixture(state);
      return route.fulfill({ status: 201, json: { accepted: true } });
    }
    return route.continue();
  });
  await mkdir('/tmp/bb9a-browser', { recursive: true });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on('pageerror', (e) => errors.push(e.message));
  async function ready() {
    state = 'ready';
    current = fixture();
    await page.evaluate(() => localStorage.clear()).catch(() => {});
    await page.goto(base + '/checkout');
    await page
      .getByRole('button', { name: 'Pay $10.50', exact: true })
      .waitFor();
    await page.waitForFunction(
      () => !document.querySelector('.checkout-pay')?.disabled,
      null,
      { timeout: 12000 },
    );
  }
  async function fill() {
    await page.getByLabel('Name', { exact: true }).fill('Mock Customer');
    await page.getByLabel('Email', { exact: true }).fill('mock@example.test');
    await page.getByLabel('Mobile phone', { exact: true }).fill('+13035550123');
    await page
      .getByLabel('Pickup date', { exact: true })
      .selectOption(pickupDate);
  }
  try {
    await ready();
    assert.equal(starts, 0);
    assert.deepEqual(
      await page.evaluate(
        () => window.__checkoutMock.options.allowedPaymentMethodTypes,
      ),
      ['card'],
    );
    assert.equal(
      await page.evaluate(() => window.__checkoutMock.options.amount),
      1050,
    );
    assert.deepEqual(
      await page.evaluate(() => window.__checkoutMock.calls),
      [],
    );
    for (const width of [320, 375, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await fill();
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
        `overflow at ${width}`,
      );
      for (const label of ['Name', 'Email', 'Mobile phone', 'Pickup date']) {
        const box = await page.getByLabel(label, { exact: true }).boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= width);
      }
      const amountBox = await page
        .locator('.checkout-lines strong')
        .evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          return { height: range.getBoundingClientRect().height };
        });
      assert.ok(amountBox.height < 35, 'currency amount must not wrap');
      await page.screenshot({
        path: `/tmp/bb9a-browser/checkout-${width}.png`,
        fullPage: true,
      });
    }
    await page.getByLabel('Name', { exact: true }).focus();
    await page.keyboard.press('Tab');
    assert.equal(
      await page.evaluate(() => document.activeElement.id),
      'checkout-email',
    );
    await page.getByLabel('Mobile phone', { exact: true }).fill('3035550123');
    await page.getByRole('button', { name: 'Pay $10.50', exact: true }).click();
    assert.equal(starts, 0);
    assert.equal(
      await page.evaluate(() => document.activeElement.id),
      'checkout-phone',
    );
    await fill();
    await page.evaluate(() => (window.__checkoutMock.validationError = true));
    await page.getByRole('button', { name: 'Pay $10.50', exact: true }).click();
    await page
      .getByRole('alert')
      .filter({ hasText: 'secure payment form' })
      .waitFor();
    assert.equal(starts, 0);
    assert.equal(
      await page.evaluate(() => window.__checkoutMock.calls.includes('token')),
      false,
    );
    await page.evaluate(() => (window.__checkoutMock.validationError = false));
    await fill();
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Pay $10.50', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'processing' }).waitFor();
    assert.equal(starts, 1);
    assert.equal(requests[0].customer.smsTransactionalConsent, true);
    assert.deepEqual(Object.keys(requests[0]).sort(), [
      'confirmationTokenId',
      'customer',
      'pickupDate',
    ]);
    assert.equal(
      await page.evaluate(() => document.activeElement.textContent),
      'Checkout',
    );
    const stored = await page.evaluate(() => JSON.stringify(localStorage));
    assert.equal(stored.includes('ctoken_'), false);
    assert.equal(stored.includes('mock@example'), false);
    await page.reload();
    await page.getByRole('status').filter({ hasText: 'processing' }).waitFor();
    assert.equal(starts, 1);
    state = 'paid';
    advance('paid');
    await page
      .getByRole('button', { name: 'Check payment status', exact: true })
      .click();
    await page
      .getByRole('status')
      .filter({ hasText: 'Payment confirmed' })
      .waitFor();
    await ready();
    await fill();
    startMode = 'disabled';
    await page.getByRole('button', { name: 'Pay $10.50', exact: true }).click();
    await page
      .getByRole('alert')
      .filter({ hasText: 'not available' })
      .waitFor();
    await ready();
    await fill();
    startMode = 'ambiguous';
    await page.getByRole('button', { name: 'Pay $10.50', exact: true }).click();
    await page
      .getByRole('alert')
      .filter({ hasText: 'cannot confirm' })
      .waitFor();
    const count = starts;
    await page.reload();
    await page.getByRole('status').filter({ hasText: 'unavailable' }).waitFor();
    assert.equal(starts, count);
    assert.equal(
      await page
        .getByRole('button', { name: 'Pay $10.50', exact: true })
        .count(),
      0,
    );
    await ready();
    await fill();
    startMode = 'processing';
    await page
      .getByRole('button', { name: 'Mock wallet', exact: true })
      .click();
    await page.getByRole('status').filter({ hasText: 'processing' }).waitFor();
    assert.equal(requests.at(-1).customer.smsTransactionalConsent, false);
    await ready();
    current = fixture('action_required');
    await page
      .getByRole('button', { name: 'Check payment status', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Continue bank authentication' })
      .waitFor();
    await page
      .getByRole('button', { name: 'Continue bank authentication' })
      .click();
    await page.getByRole('status').filter({ hasText: 'processing' }).waitFor();
    assert.equal(
      await page.getByText('Payment confirmed.', { exact: false }).count(),
      0,
    );
    assert.equal(
      await page.evaluate(
        () => window.__checkoutMock.calls.filter((c) => c === 'action').length,
      ),
      1,
    );
    advance('failed');
    await page
      .getByRole('button', { name: 'Check payment status', exact: true })
      .click();
    await page.getByRole('status').filter({ hasText: 'declined' }).waitFor();
    current = fixture('processing');
    current.payment.paymentDeadline = new Date(Date.now() - 1000).toISOString();
    await page.reload();
    await page.getByText('Window closed.', { exact: false }).waitFor();
    assert.equal(
      await page.getByRole('status').filter({ hasText: 'processing' }).count(),
      1,
    );
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
  } catch (error) {
    await page.screenshot({
      path: '/tmp/bb9a-browser/failure.png',
      fullPage: true,
    });
    console.error({ errors, external });
    throw error;
  } finally {
    await browser.close();
  }
});
