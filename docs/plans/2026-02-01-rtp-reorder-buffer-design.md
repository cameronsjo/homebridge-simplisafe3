# RTP Reorder Buffer Design

**Date:** 2026-02-01
**Status:** Approved
**Author:** Cameron (with Claude)

## Problem

The Kinesis WebRTC stream delivers H.264 video as RTP packets over UDP. UDP does not guarantee packet ordering, causing FU-A (fragmentation unit) reassembly failures:

```
Expected: [FU-A Start] → [FU-A Middle] → [FU-A End] → Complete NAL
Actual:   [FU-A Middle] → [FU-A Start] → [FU-A End] → Corrupted NAL
                ↑ discarded (no start seen)
```

**Symptoms observed:**
- FFmpeg decode errors: `cabac decode of qscale diff failed`
- Concealment errors in both I-frames and P-frames
- Glitchy but viewable video

## Solution

Add an `RtpReorderBuffer` class that sits between the WebRTC track and the H264 depacketizer. It buffers incoming packets briefly and emits them in sequence number order.

### Data Flow

```
videoTrack.onReceiveRtp → RtpReorderBuffer → H264Depacketizer → FFmpeg
```

### Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Latency budget | ~50ms (~2 frames @ 30fps) | Security cameras prioritize low latency over perfect quality |
| Buffer location | Separate class | Single responsibility, testable, reusable for LiveKit |
| Sequence wrap handling | Yes (16-bit rollover at 65535) | RTP spec requirement |
| Gap handling | Emit after timeout | Don't wait forever for lost packets |

## RtpReorderBuffer Specification

### Constructor

```javascript
new RtpReorderBuffer({
    maxBufferSize: 30,      // Max packets to hold (prevent memory leak)
    maxWaitMs: 50,          // Max time to wait for missing packet
    onPacket: (rtp) => {}   // Callback for ordered packets
})
```

### Behavior

1. **Receive packet** → Store in buffer keyed by sequence number
2. **Check if next expected sequence is available** → Emit it, increment expected
3. **If gap detected** → Wait up to `maxWaitMs` for missing packet
4. **If timeout or buffer full** → Skip missing packet, emit what we have, log gap
5. **Handle sequence wraparound** → 65535 → 0 is valid continuation

### State

```javascript
{
    expectedSeq: number,      // Next sequence number we expect
    buffer: Map<seq, rtp>,    // Packets waiting to be emitted
    initialized: boolean,     // False until first packet sets expectedSeq
    lastEmitTime: number,     // Timestamp of last emission (for timeout)
    stats: {
        received: number,
        emitted: number,
        reordered: number,    // Packets that arrived out of order
        dropped: number       // Gaps we gave up waiting for
    }
}
```

### Sequence Number Math

RTP sequence numbers are 16-bit unsigned integers (0-65535). Comparison must handle wraparound:

```javascript
// Is seqA "before" seqB (accounting for wrap)?
function seqBefore(seqA, seqB) {
    const diff = (seqB - seqA + 65536) % 65536;
    return diff > 0 && diff < 32768;
}
```

## Files to Create/Modify

| File | Change |
|------|--------|
| `src/lib/rtpReorderBuffer.js` | New file - the reorder buffer class |
| `src/lib/kinesisStreamingDelegate.js` | Import and use RtpReorderBuffer |
| `src/lib/liveKitStreamingDelegate.js` | Import and use RtpReorderBuffer (if needed) |

## Testing Strategy

1. **Unit tests for RtpReorderBuffer:**
   - In-order packets pass through immediately
   - Out-of-order packets get reordered
   - Sequence wraparound (65535 → 0) handled
   - Timeout emits buffered packets
   - Stats track reordering and drops

2. **Integration test:**
   - Deploy to Pi, observe FFmpeg error reduction
   - Check logs for reorder/drop stats

## Success Criteria

- Reduction in FFmpeg decode errors
- Smoother video playback
- Stats show reordering occurring (proving the buffer is working)
- No increase in perceived latency

## Rollback Plan

The buffer can be bypassed by setting `maxWaitMs: 0` which effectively disables reordering and passes packets straight through.
