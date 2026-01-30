# Design: Native Kinesis WebRTC Support for Outdoor Cameras

**Date:** 2026-01-29
**Status:** Approved
**Author:** Claude (with Cameron)

## Problem Statement

SimpliSafe outdoor cameras (model `SSOBCM4`) use AWS Kinesis Video Streams with WebRTC instead of the FLV streaming protocol used by indoor cameras and doorbells. The current plugin explicitly skips these cameras, resulting in "No Response" in HomeKit.

| Camera Type | Model | Protocol | Current Status |
|-------------|-------|----------|----------------|
| SimpliCam | SS001, SS003 | FLV over HTTP | Supported |
| Video Doorbell Pro | SS002 | FLV over HTTP | Supported |
| Outdoor Camera | SSOBCM4 | AWS Kinesis WebRTC | **Not Supported** |

## Solution

Implement native TypeScript WebRTC support using the `werift` library to handle Kinesis signaling and media transport, then pipe RTP packets to FFmpeg for HomeKit SRTP delivery.

## Architecture Decisions

### Decision 1: Pure TypeScript WebRTC via `werift`

**Chosen:** `werift` - pure TypeScript WebRTC implementation

**Rationale:**
- No native binaries - works on ARM (Raspberry Pi), x86, Mac, Linux, Docker without prebuild issues
- Direct access to RTP packets for FFmpeg piping
- Actively maintained with good documentation
- ~500KB bundle vs ~50MB for node-webrtc
- Fits existing TypeScript codebase

**Rejected alternatives:**
- `node-webrtc`: Native binary dependency hell across platforms
- Headless browser: Heavy runtime, not suitable for Homebridge plugin
- Go addon: Cross-language complexity, build system overhead

### Decision 2: Separate `KinesisStreamingDelegate` Class

**Chosen:** Create a new `KinesisStreamingDelegate` class specifically for outdoor cameras

**Rationale:**
- Single Responsibility Principle - each delegate handles one protocol
- Easier to debug and maintain independently
- No risk of breaking existing FLV streaming
- Cleaner testing surface
- Camera.js selects delegate based on `supportedFeatures.providers.recording`

**Rejected alternative:**
- Extending existing StreamingDelegate with conditionals: Mixes concerns, harder to maintain

### Decision 3: RTP-to-FFmpeg Pipeline

**Chosen:** Extract RTP packets from werift and pipe directly to FFmpeg via stdin

**Rationale:**
- Mirrors existing FLV→FFmpeg pattern
- FFmpeg handles transcoding/muxing for HomeKit SRTP
- Reuses existing FFmpeg configuration and hardware acceleration
- No intermediate file or socket needed

**Flow:**
```
SimpliSafe API → Kinesis WSS → werift (WebRTC) → RTP → FFmpeg stdin → SRTP → HomeKit
```

### Decision 4: Reuse Existing Authentication

**Chosen:** Use existing `AuthManager` bearer tokens for the Kinesis live-view endpoint

**Rationale:**
- SimpliSafe uses the same OAuth tokens across all endpoints
- No additional authentication flow needed
- Token refresh already handled

## Technical Design

### New Files

```
src/
├── lib/
│   ├── kinesisStreamingDelegate.ts    # WebRTC streaming for outdoor cameras
│   └── kinesisClient.ts               # Kinesis signaling client
```

### Modified Files

```
src/
├── accessories/
│   └── camera.js → camera.ts          # Select delegate based on provider
├── lib/
│   └── streamingDelegate.js           # Minor refactor for shared utilities
├── package.json                        # Add werift dependency
```

### API Integration

**Endpoint:** `GET https://app-hub.prd.aser.simplisafe.com/v2/cameras/{serial}/{locationId}/live-view`

**Headers:** `Authorization: Bearer {accessToken}`

**Response:**
```typescript
interface LiveViewResponse {
  signedChannelEndpoint: string;  // WSS URL for Kinesis signaling
  clientId: string;               // Client ID for signaling
  iceServers: RTCIceServer[];     // STUN/TURN servers
}
```

### Kinesis Signaling Protocol

The signaling follows standard WebRTC over WebSocket:

```typescript
// Outbound messages
interface KinesisRequest {
  action: 'SDP_OFFER' | 'ICE_CANDIDATE';
  recipientClientId: string;
  messagePayload: string;  // JSON-encoded SDP or ICE candidate
}

// Inbound messages
interface KinesisResponse {
  messageType: 'SDP_ANSWER' | 'ICE_CANDIDATE';
  messagePayload: string;  // JSON-encoded SDP or ICE candidate
}
```

### KinesisStreamingDelegate Class

```typescript
class KinesisStreamingDelegate implements CameraStreamingDelegate {
  private readonly api: SimpliSafe;
  private readonly camera: Camera;
  private readonly log: Logger;

  // Active WebRTC sessions keyed by sessionId
  private sessions: Map<string, KinesisSession>;

  async handleSnapshotRequest(request: SnapshotRequest): Promise<Buffer>;
  async prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): Promise<void>;
  async handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): Promise<void>;
  async stopStream(sessionId: string): Promise<void>;
}

interface KinesisSession {
  peer: RTCPeerConnection;
  videoTrack: MediaStreamTrack;
  audioTrack: MediaStreamTrack;
  ffmpegProcess: ChildProcess;
}
```

### RTP to FFmpeg Pipeline

werift exposes RTP packets via event handlers on media tracks:

```typescript
videoTrack.onReceiveRtp.subscribe((rtp: RtpPacket) => {
  // Write RTP packet to FFmpeg stdin
  ffmpegProcess.stdin.write(rtp.serialize());
});
```

FFmpeg input configuration:
```
-protocol_whitelist pipe,udp,rtp
-f rtp
-i pipe:0
```

### Camera Detection Logic

```typescript
// In camera.ts
const isKinesisCamera = (camera: Camera): boolean => {
  return camera.supportedFeatures?.providers?.recording !== 'simplisafe';
};

// Select appropriate delegate
const streamingDelegate = isKinesisCamera(camera)
  ? new KinesisStreamingDelegate(api, camera, log)
  : new StreamingDelegate(api, camera, log);
```

### Snapshot Handling

Outdoor cameras don't have the `/mjpg` endpoint. Options:

1. **Capture frame from WebRTC stream** - Start brief stream, grab I-frame
2. **Use placeholder image** - Show camera-offline style image
3. **Cache last frame** - Store frame from most recent stream

**Chosen:** Option 1 with Option 3 as optimization. Start a brief WebRTC connection to capture a keyframe, then cache it for subsequent snapshot requests within a TTL window.

### Error Handling

| Scenario | Handling |
|----------|----------|
| Camera asleep/offline | Retry with exponential backoff, surface "No Response" after timeout |
| Token expired mid-stream | Refresh token, reconnect signaling |
| ICE connection failed | Log error, try TURN fallback, surface failure |
| FFmpeg crash | Clean up WebRTC session, log error |

### Wake-up Latency

Outdoor cameras are battery-powered and sleep aggressively. Expected wake-up time: 4-10 seconds.

**Mitigation:**
- Keep WebRTC connection alive during active streaming
- Implement connection pooling for rapid re-streams
- Log wake-up latency for debugging

## Dependencies

```json
{
  "werift": "^0.19.0"
}
```

No other new dependencies required - reuses existing FFmpeg infrastructure.

## Testing Strategy

1. **Unit tests:** KinesisClient signaling logic with mocked WebSocket
2. **Integration tests:** Full pipeline with mock Kinesis server
3. **Manual testing:** Real outdoor camera hardware validation

## Migration Path

1. Remove the `providers.recording !== 'simplisafe'` exclusion in camera detection
2. Add KinesisStreamingDelegate as alternative to StreamingDelegate
3. No changes to existing FLV camera behavior
4. Feature flag not needed - detection is automatic based on camera model

## Limitations

| Limitation | Reason | Mitigation |
|------------|--------|------------|
| No 2-way audio | WebRTC send not implemented | Future enhancement |
| Higher latency | WebRTC negotiation + camera wake | Unavoidable with battery cameras |
| Snapshot delay | Requires WebRTC connection | Cache frames, brief connection |

## Success Criteria

- [ ] Outdoor cameras appear in HomeKit without "No Response"
- [ ] Live video streams successfully
- [ ] Snapshots work for notifications
- [ ] Motion events trigger correctly (existing functionality)
- [ ] No regression for indoor cameras and doorbells
- [ ] Works on Raspberry Pi (ARM) without native binary issues

## References

- [simplirtc](https://github.com/gilliginsisland/simplirtc) - Python reference implementation
- [go2rtc kinesis.go](https://github.com/AlexxIT/go2rtc/blob/master/internal/webrtc/kinesis.go) - Go reference
- [werift](https://github.com/shinyoshiaki/werift-webrtc) - TypeScript WebRTC library
- [homebridge-simplisafe3 #240](https://github.com/homebridge-simplisafe3/homebridge-simplisafe3/discussions/240) - Original issue
