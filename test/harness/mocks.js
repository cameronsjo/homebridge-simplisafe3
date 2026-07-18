// Mock SimpliSafe API via nock. State machine: setupOutage / setupFatal /
// setupRatelimit / setupOk. Flip by calling another setup (each cleans first).
const nock = require('nock');

const USER_ID = 424242;
const SUB_ID = 555;

const CAMERA = {
    uuid: 'harness-cam-0001',
    serial: 'CAM001',
    model: 'SS001',
    cameraStatus: {},
    currentState: {},
    supportedFeatures: {},
    cameraSettings: {
        cameraName: 'Harness Cam',
        pictureQuality: '1080p',
        admin: {
            firmwareVersion: '1.0.0',
            fps: 15,
            bitRate: 512,
            IRLED: 0,
            pirSens: 0,
            statusLight: 'off',
            micSens: 0,
            odLevel: 0
        }
    }
};

const MIST_CAMERA = {
    uuid: 'harness-cam-mist-0002',
    serial: 'CAM002',
    model: 'SSOBCM4',
    cameraStatus: { batteryPercentage: 100 },
    currentState: { webrtcProvider: 'MIST', batteryCharging: false },
    supportedFeatures: { battery: true },
    cameraSettings: {
        cameraName: 'Harness Mist Cam',
        pictureQuality: '1080p',
        admin: {
            firmwareVersion: '1.0.0',
            fps: 20,
            bitRate: 2000000,
            IRLED: 0,
            pirSens: 0,
            statusLight: 'off',
            micSens: 0,
            odLevel: 0
        }
    }
};

const SYSTEM = { serial: 'HARNESS001', alarmState: 'OFF', cameras: [CAMERA, MIST_CAMERA] };

const SUBSCRIPTION = {
    sid: SUB_ID,
    sStatus: 20,
    activated: 1,
    location: { account: '00011122', system: SYSTEM }
};

const ENTRY_SENSOR = {
    type: 5,
    serial: 'ES001',
    name: 'Harness Front Door',
    setting: { off: 1, home: 1, away: 1 },
    status: { triggered: false },
    flags: { offline: false, lowBattery: false, swingerShutdown: false }
};

let tokenCounter = 0;

function clean() {
    nock.cleanAll();
}

function authOk() {
    tokenCounter += 1;
    const n = tokenCounter;
    nock('https://auth.simplisafe.com')
        .persist()
        .post('/oauth/token')
        .reply(200, () => ({
            access_token: `harness-at-${n}`,
            refresh_token: `harness-rt-${n}`,
            expires_in: 3600,
            token_type: 'Bearer'
        }));
}

function apiOk() {
    const api = nock('https://api.simplisafe.com').persist();
    api.get('/v1/api/authCheck').reply(200, { userId: USER_ID });
    api.get(`/v1/users/${USER_ID}/subscriptions`)
        .query(true)
        .reply(200, { subscriptions: [SUBSCRIPTION] });
    api.get(`/v1/subscriptions/${SUB_ID}/`).reply(200, { subscription: SUBSCRIPTION });
    api.get(new RegExp(`/v1/ss3/subscriptions/${SUB_ID}/sensors.*`))
        .reply(200, { sensors: [ENTRY_SENSOR], lastUpdated: Date.now() });
    api.get(`/v1/doorlock/${SUB_ID}`).reply(200, []);
    // catch-all so accessory polling loops don't crash the harness
    api.get(/.*/).reply(200, {});
    api.post(/.*/).reply(200, {});
}

// Network-down / bad-TLS boot: the exact incident mode (self-signed cert on
// the auth host). Axios surfaces this as an error with no response.
function setupOutage() {
    clean();
    nock('https://auth.simplisafe.com')
        .persist()
        .post('/oauth/token')
        .replyWithError({ message: 'self-signed certificate', code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    nock('https://api.simplisafe.com')
        .persist()
        .get(/.*/)
        .replyWithError({ message: 'self-signed certificate', code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })
        .post(/.*/)
        .replyWithError({ message: 'self-signed certificate', code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    console.log('[HARNESS] mocks: OUTAGE (auth + api unreachable, DEPTH_ZERO_SELF_SIGNED_CERT)');
}

// True auth failure: 4xx from the token endpoint (revoked/corrupt refresh token)
function setupFatal() {
    clean();
    nock('https://auth.simplisafe.com')
        .persist()
        .post('/oauth/token')
        .reply(400, { error: 'invalid_grant', error_description: 'Unknown or invalid refresh token.' });
    apiOk(); // api reachable; auth is the failure
    console.log('[HARNESS] mocks: FATAL (token endpoint 400 invalid_grant)');
}

// Rate limited: auth OK, api answers 403
function setupRatelimit() {
    clean();
    authOk();
    const api = nock('https://api.simplisafe.com').persist();
    api.get(/.*/).reply(403, 'Forbidden');
    api.post(/.*/).reply(403, 'Forbidden');
    console.log('[HARNESS] mocks: RATELIMIT (api 403)');
}

function setupOk() {
    clean();
    authOk();
    apiOk();
    console.log('[HARNESS] mocks: OK (auth + api healthy)');
}

module.exports = { setupOutage, setupFatal, setupRatelimit, setupOk, nock };
