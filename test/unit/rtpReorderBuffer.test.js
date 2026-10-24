// Runs against the Babel build in dist/ (npm test builds first).
// Needs Node >= 20.11 for the options form of mock.timers.enable().
const test = require('node:test');
const assert = require('node:assert/strict');
const RtpReorderBuffer = require('../../dist/lib/rtpReorderBuffer').default;

const pkt = (seq) => ({ header: { sequenceNumber: seq }, payload: Buffer.alloc(0) });

function makeBuffer(opts = {}) {
    const out = [];
    const buf = new RtpReorderBuffer({ maxWaitMs: 0, onPacket: (rtp) => out.push(rtp.header.sequenceNumber), ...opts });
    return { buf, out };
}

test('emits in-order packets immediately', () => {
    const { buf, out } = makeBuffer();
    [10, 11, 12].forEach((s) => {
        buf.push(pkt(s));
    });
    assert.deepEqual(out, [10, 11, 12]);
    assert.equal(buf.getStats().buffered, 0);
});

test('reorders a swapped pair', () => {
    const { buf, out } = makeBuffer();
    [10, 12, 11, 13].forEach((s) => {
        buf.push(pkt(s));
    });
    assert.deepEqual(out, [10, 11, 12, 13]);
    assert.equal(buf.getStats().reordered, 1);
});

test('handles 16-bit sequence wraparound', () => {
    const { buf, out } = makeBuffer();
    [65534, 0, 65535, 1].forEach((s) => {
        buf.push(pkt(s));
    });
    assert.deepEqual(out, [65534, 65535, 0, 1]);
});

test('drops packets that arrive after the buffer moved past them', () => {
    const { buf, out } = makeBuffer();
    [10, 11, 9].forEach((s) => {
        buf.push(pkt(s));
    });
    assert.deepEqual(out, [10, 11]);
    assert.equal(buf.getStats().dropped, 1);
});

test('overflow skips a lost packet', () => {
    const { buf, out } = makeBuffer({ maxBufferSize: 3 });
    [0, 2, 3, 4, 5].forEach((s) => {
        buf.push(pkt(s));
    });
    assert.deepEqual(out, [0, 2, 3, 4, 5]);
    assert.equal(buf.getStats().dropped, 1);
});

test('flush() drains every buffered packet across several gaps', () => {
    const { buf, out } = makeBuffer();
    [0, 2, 3, 5, 6].forEach((s) => {
        buf.push(pkt(s));
    });
    assert.deepEqual(out, [0]);
    buf.flush();
    assert.deepEqual(out, [0, 2, 3, 5, 6]);
    assert.equal(buf.getStats().buffered, 0);
});

test('timeout flush keeps going until gaps on both sides are drained', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { buf, out } = makeBuffer({ maxWaitMs: 50 });
    [0, 2, 4].forEach((s) => {
        buf.push(pkt(s));
    });
    assert.deepEqual(out, [0]);
    t.mock.timers.tick(50);
    assert.deepEqual(out, [0, 2]);
    t.mock.timers.tick(50);
    assert.deepEqual(out, [0, 2, 4]);
    assert.equal(buf.getStats().buffered, 0);
    buf.destroy();
});
