// Runs against the Babel build in dist/ (npm test builds first)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
    SimpliSafe3AuthenticationManager,
    AUTH_EVENTS,
    refreshIntervalMs,
    isAuthRejection
} = require('../../dist/lib/authManager');

const silentLog = Object.assign(() => {}, { error: () => {}, warn: () => {} });

function tmpStorage(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss3-auth-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

test('refreshIntervalMs refreshes five minutes before expiry', () => {
    assert.equal(refreshIntervalMs(3600), 3600 * 1000 - 300000);
    assert.equal(refreshIntervalMs('3600'), 3600 * 1000 - 300000);
});

test('refreshIntervalMs never returns a delay Node would run every 1ms', () => {
    for (const bad of [undefined, null, 'abc', 0, 60, 299, -10]) {
        assert.equal(refreshIntervalMs(bad), 60 * 1000, `expires_in=${bad}`);
    }
    // over 2^31-1 ms setInterval overflows to 1ms
    assert.ok(refreshIntervalMs(60 * 24 * 3600) <= 2 ** 31 - 1);
});

test('isAuthRejection: 4xx and Unauthorized are rejections, 429 and network errors are not', () => {
    assert.equal(isAuthRejection({ response: { status: 401 } }), true);
    assert.equal(isAuthRejection({ response: { status: 403 } }), true);
    assert.equal(isAuthRejection({ response: { status: 500, data: 'Unauthorized' } }), true);
    assert.equal(isAuthRejection({ response: { status: 429 } }), false);
    assert.equal(isAuthRejection({ response: { status: 503 } }), false);
    assert.equal(isAuthRejection(new Error('ECONNRESET')), false);
    assert.equal(isAuthRejection(undefined), false);
});

test(
    'stored token file is owner-only, including a pre-existing world-readable file',
    { skip: process.platform === 'win32' },
    async (t) => {
        const dir = tmpStorage(t);
        const file = path.join(dir, 'simplisafe3auth.json');
        fs.writeFileSync(file, '{}', { mode: 0o644 });
        fs.chmodSync(file, 0o644);

        const auth = new SimpliSafe3AuthenticationManager(dir, silentLog, false);
        t.after(() => clearInterval(auth.refreshInterval));
        await auth._storeToken({ access_token: 'a', refresh_token: 'r', expires_in: 3600, token_type: 'Bearer' });

        assert.equal(fs.statSync(file).mode & 0o777, 0o600);
        const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.equal(stored.refreshToken, 'r');
    }
);

test('a 429 on refresh keeps the tokens and emits no failure', async (t) => {
    const dir = tmpStorage(t);
    const auth = new SimpliSafe3AuthenticationManager(dir, silentLog, false);
    auth.accessToken = 'a';
    auth.refreshToken = 'r';
    let failures = 0;
    auth.on(AUTH_EVENTS.REFRESH_CREDENTIALS_FAILURE, () => failures++);

    // Stub the HTTP layer: reach into the module-level axios instance via a failing post
    const axios = require('axios');
    const rateLimited = Object.assign(new Error('Too Many Requests'), { response: { status: 429 } });
    t.mock.method(axios.Axios.prototype, 'request', async () => {
        throw rateLimited;
    });

    await assert.rejects(auth.refreshCredentials(), rateLimited);
    assert.equal(auth.refreshToken, 'r');
    assert.equal(auth.accessToken, 'a');
    assert.equal(failures, 0);
});

test('a 401 on refresh clears the tokens and emits failure', async (t) => {
    const dir = tmpStorage(t);
    const auth = new SimpliSafe3AuthenticationManager(dir, silentLog, false);
    auth.accessToken = 'a';
    auth.refreshToken = 'r';
    let failures = 0;
    auth.on(AUTH_EVENTS.REFRESH_CREDENTIALS_FAILURE, () => failures++);

    const axios = require('axios');
    const unauthorized = Object.assign(new Error('Unauthorized'), { response: { status: 401 } });
    t.mock.method(axios.Axios.prototype, 'request', async () => {
        throw unauthorized;
    });

    await assert.rejects(auth.refreshCredentials(), unauthorized);
    assert.equal(auth.refreshToken, null);
    assert.equal(failures, 1);
});

test('a failed chmod warns once without debug, and the token is still stored', async (t) => {
    const dir = tmpStorage(t);
    const warnings = [];
    const log = Object.assign(() => {}, { error: () => {}, warn: (m) => warnings.push(m) });
    const auth = new SimpliSafe3AuthenticationManager(dir, log, false);
    t.after(() => clearInterval(auth.refreshInterval));
    fs.writeFileSync(path.join(dir, 'simplisafe3auth.json'), '{}');
    t.mock.method(fs, 'chmodSync', () => {
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    });

    const token = { access_token: 'a', refresh_token: 'r', expires_in: 3600, token_type: 'Bearer' };
    await auth._storeToken(token);
    await auth._storeToken(token);

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /0600/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'simplisafe3auth.json'), 'utf8')).refreshToken, 'r');
});
