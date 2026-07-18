// SS3 resilience harness: boots real homebridge in-process with this fork's
// dist as the plugin and nock intercepting the SimpliSafe API. Zero live
// credentials - never point this at a real account (Auth0 refresh-token
// rotation can invalidate the production token).
//
// Setup (one time, from this directory):
//   npm install
//   (cd ../.. && npm run build)
//
// Usage: node run.js <scenario> [flipAfterMs] [exitAfterMs]
//   scenario: happy | outage | fatal | ratelimit
//   flipAfterMs: when to flip mocks to OK (outage/fatal/ratelimit; default 40000)
//   exitAfterMs: hard exit (default 240000)
//
// Reading results: grep the output for 'Retrying SimpliSafe initialization',
// 'initialization recovered', 'with cached accessory', 'with new accessory'.
// Reset cached-accessory state between scenario sequences by deleting
// storage/accessories and storage/persist, then reseeding with a happy run.
const path = require('path');
const mocks = require('./mocks');

const scenario = process.argv[2] || 'happy';
const flipAfterMs = parseInt(process.argv[3] || '40000', 10);
const exitAfterMs = parseInt(process.argv[4] || '240000', 10);

mocks.nock.disableNetConnect();

if (scenario === 'happy') {
    mocks.setupOk();
} else if (scenario === 'outage') {
    mocks.setupOutage();
} else if (scenario === 'fatal') {
    mocks.setupFatal();
} else if (scenario === 'ratelimit') {
    mocks.setupRatelimit();
} else {
    console.error(`[HARNESS] unknown scenario ${scenario}`);
    process.exit(2);
}

if (scenario !== 'happy') {
    setTimeout(() => {
        console.log(`[HARNESS] t+${flipAfterMs}ms: flipping mocks to OK`);
        mocks.setupOk();
    }, flipAfterMs);
}

setTimeout(() => {
    console.log('[HARNESS] exit timer reached, shutting down');
    process.exit(0);
}, exitAfterMs);

const storage = path.join(__dirname, 'storage');
const pluginDist = path.resolve(__dirname, '..', '..', 'dist');
process.argv = [process.argv[0], 'homebridge', '-U', storage, '-P', pluginDist, '-D', '-I'];

console.log(`[HARNESS] scenario=${scenario} flipAfterMs=${flipAfterMs} exitAfterMs=${exitAfterMs}`);
require('homebridge/lib/cli')();
