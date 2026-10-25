// Runs against the Babel build in dist/ (npm test builds first).
// Needs Node >= 20.11 for the options form of mock.timers.enable().
// Swaps the `ws` module for a fake so no socket ever leaves the process.
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const Module = require('node:module');

class FakeWebSocket extends EventEmitter {
    static CONNECTING = 0;
    static OPEN = 1;
    static instances = [];
    constructor() {
        super();
        this.readyState = FakeWebSocket.OPEN;
        this.sent = [];
        this.pings = 0;
        FakeWebSocket.instances.push(this);
    }
    send(msg) {
        this.sent.push(msg);
    }
    ping() {
        this.pings++;
    }
    terminate() {}
}

const realLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === 'ws') return FakeWebSocket;
    return realLoad.call(this, request, ...rest);
};
const SimpliSafe3 = require('../../dist/simplisafe').default;
const { EVENT_TYPES } = require('../../dist/simplisafe');
Module._load = realLoad;

const silentLog = Object.assign(() => {}, { error: () => {}, warn: () => {}, debug: () => {} });

function makeClient() {
    const auth = new EventEmitter();
    auth.isAuthenticated = () => true;
    auth.accessToken = 'token';
    auth.tokenType = 'Bearer';
    const ss = new SimpliSafe3(15000, auth, '/tmp', silentLog, false);
    ss.userId = 'user-1';
    ss.subId = 'sub-1';
    return ss;
}

const subscribed = JSON.stringify({ source: 'service', type: 'com.simplisafe.namespace.subscribed' });

test('a non-JSON socket frame is ignored instead of throwing out of the listener', async () => {
    const ss = makeClient();
    await ss.startListening();
    assert.doesNotThrow(() => ss.socket.emit('message', 'not json{'));
    assert.doesNotThrow(() => ss.socket.emit('message', 'null'));
    assert.doesNotThrow(() => ss.socket.emit('message', JSON.stringify({ source: 'messagequeue' })));
});

test('messagequeue events for this subscription are still emitted', async () => {
    const ss = makeClient();
    await ss.startListening();
    let got;
    ss.on(EVENT_TYPES.AWAY_ARM, (data) => {
        got = data;
    });
    ss.socket.emit('message', JSON.stringify({ source: 'messagequeue', data: { sid: 'sub-1', eventCid: 3401 } }));
    assert.equal(got?.eventCid, 3401);
});

test('a repeated `subscribed` message leaves only one heartbeat running', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const ss = makeClient();
    await ss.startListening();
    const sock = ss.socket;
    sock.emit('message', subscribed);
    sock.emit('message', subscribed);
    // One heartbeat pings once. With a leaked second interval, it fires right after
    // the first one cleared socketIsAlive and tears down a healthy socket.
    t.mock.timers.tick(66000);
    assert.equal(sock.pings, 1);
    assert.equal(ss.socket, sock, 'healthy socket was torn down');
    clearInterval(ss.socketHeartbeatIntervalID);
});

test('socket reconnect backoff is capped below the setTimeout overflow', (t) => {
    const ss = makeClient();
    ss.nSocketConnectFailures = 40;
    const delays = [];
    // Record the delay without scheduling anything
    t.mock.method(globalThis, 'setTimeout', (_fn, ms) => {
        delays.push(ms);
    });
    ss.handleSocketConnectionFailure();
    assert.equal(delays.length, 1);
    assert.ok(delays[0] <= 30 * 60 * 1000, `delay ${delays[0]}ms`);
});

test('a rejected reconnect is caught and retried, not left floating', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const ss = makeClient();
    ss.userId = undefined;
    let calls = 0;
    ss.getUserId = async () => {
        calls++;
        throw new Error('rate limited');
    };
    const unhandled = [];
    const onUnhandled = (err) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);
    t.after(() => process.off('unhandledRejection', onUnhandled));

    ss.handleSocketConnectionFailure();
    t.mock.timers.tick(1000);
    await new Promise((r) => setImmediate(r));
    assert.equal(calls, 1);
    assert.equal(unhandled.length, 0);
    assert.equal(ss.isAwaitingSocketReconnect, true, 'another attempt is scheduled');
});

test('a reconnect rejected with no error object still schedules a retry', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const ss = makeClient();
    ss.userId = undefined;
    // request() rethrows err.response.data, which can be undefined
    ss.getUserId = () => Promise.reject(undefined);
    const unhandled = [];
    const onUnhandled = (err) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);
    t.after(() => process.off('unhandledRejection', onUnhandled));

    ss.handleSocketConnectionFailure();
    t.mock.timers.tick(1000);
    await new Promise((r) => setImmediate(r));
    assert.equal(unhandled.length, 0);
    assert.equal(ss.isAwaitingSocketReconnect, true, 'another attempt is scheduled');
});

test('unsubscribing every sensor then subscribing again restarts the refresh loop', () => {
    const ss = makeClient();
    ss.subscribeToSensor('a', () => {});
    const first = ss.sensorRefreshIntervalID;
    ss.unsubscribeFromSensor('a');
    ss.subscribeToSensor('b', () => {});
    assert.ok(ss.sensorRefreshIntervalID);
    assert.notEqual(ss.sensorRefreshIntervalID, first);
    clearInterval(ss.sensorRefreshIntervalID);
});
