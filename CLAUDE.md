# CLAUDE.md - homebridge-simplisafe3 (WebRTC Fork)

## Project Overview

This is a personal fork of [homebridge-simplisafe3](https://github.com/homebridge-simplisafe3/homebridge-simplisafe3) that adds native WebRTC streaming support for SimpliSafe outdoor cameras.

**Key addition:** Outdoor cameras (Kinesis/LiveKit WebRTC) now work natively without external workarounds.

## Architecture

```
src/
├── index.js                 # Plugin entry point
├── simplisafe.js            # SimpliSafe API client
├── accessories/
│   ├── camera.js            # Camera accessory (selects streaming delegate)
│   ├── ss3Accessory.js      # Base accessory class
│   └── ...                  # Other accessories (sensors, locks, etc.)
└── lib/
    ├── authManager.js       # OAuth token management
    ├── streamingDelegate.js # FLV streaming (indoor cameras, doorbell)
    ├── kinesisClient.js     # Kinesis WebRTC signaling client
    ├── kinesisStreamingDelegate.js  # Kinesis streaming (KVS outdoor cameras)
    └── liveKitStreamingDelegate.js  # LiveKit streaming (MIST outdoor cameras)
```

## Camera Provider Selection

The camera accessory (`src/accessories/camera.js`) auto-selects the streaming delegate:

```javascript
const webrtcProvider = cameraDetails.currentState?.webrtcProvider?.toUpperCase();
// 'KVS'  -> KinesisStreamingDelegate
// 'MIST' -> LiveKitStreamingDelegate
// null   -> StreamingDelegate (FLV)
```

## Key Files for WebRTC

| File | Purpose |
|------|---------|
| `src/lib/kinesisClient.js` | WebRTC signaling for AWS Kinesis Video Streams |
| `src/lib/kinesisStreamingDelegate.js` | Homebridge delegate for KVS cameras |
| `src/lib/liveKitStreamingDelegate.js` | Homebridge delegate for LiveKit cameras |
| `src/lib/rtpReorderBuffer.js` | Reorders out-of-order RTP packets (UDP doesn't guarantee order) |

## Video Pipeline (Kinesis)

```
Camera → WebRTC → RTP packets → RtpReorderBuffer → H264Depacketizer → FFmpeg → HomeKit SRTP
                      ↓                ↓                    ↓
                 UDP/unreliable    Reorders by seq#    Converts RTP to Annex B
```

### H264Depacketizer

Converts RTP H.264 payloads to Annex B format (what FFmpeg expects). Handles:
- **Single NAL units** (types 1-23): Pass through with start code prefix
- **STAP-A** (type 24): Aggregated NALs, split and process each
- **FU-A** (type 28): Fragmented NALs, reassemble from multiple packets

Key behavior:
- Waits for SPS + PPS + IDR (keyframe) before emitting any data
- Caches SPS/PPS and prepends to each IDR for clean decoder init
- Drops P/B frames until synced to avoid decode errors

### RtpReorderBuffer

RTP over UDP can deliver packets out of order. The buffer:
- Holds packets briefly (50ms max wait)
- Emits in sequence number order
- Handles 16-bit sequence wraparound (65535 → 0)
- Logs gaps when packets are truly lost (not just late)

**Design doc:** `docs/plans/2026-02-01-rtp-reorder-buffer-design.md`

## Build & Deploy

```bash
# Build (transpile with Babel)
npm run build

# Output goes to dist/
# Deploy dist/ to Homebridge

# On Pi (example)
scp -r dist/* pi@192.168.1.222:/var/lib/homebridge/node_modules/homebridge-simplisafe3/
ssh pi@192.168.1.222 "sudo systemctl restart homebridge"
```

## Debug Scripts

```bash
# Test Kinesis WebRTC connection
node scripts/test-kinesis.js <access_token> <camera_uuid> <location_id>

# Test LiveKit connection
node scripts/test-livekit.js <livekit_token>

# Dump camera API data
node scripts/dump-camera-data.js <access_token> [--full]
```

## SimpliSafe API Endpoints

| Endpoint | Purpose |
|----------|---------|
| `/api/authCheck` | Get user ID |
| `/users/{userId}/subscriptions` | List subscriptions |
| `/subscriptions/{subId}/` | Full system including cameras |
| `/ss3/subscriptions/{subId}/sensors` | Sensor data |
| `/doorlock/{subId}` | Door lock data |
| `app-hub.../v2/cameras/{uuid}/{subId}/live-view` | WebRTC credentials |

## Camera API Fields

Important fields in `cameraDetails`:

```javascript
cameraDetails.currentState.webrtcProvider  // 'KVS', 'MIST', or 'SIMPLISAFE'
cameraDetails.supportedFeatures.battery    // boolean
cameraDetails.currentState.batteryCharging // boolean (plugged in)
cameraDetails.cameraStatus.batteryPercentage // 0-100
```

## Testing

1. Enable debug mode in Homebridge config: `"debug": true`
2. Watch logs for `[KinesisDelegate]` or `[LiveKitDelegate]` prefixes
3. Open camera in Home app, verify stream loads

## Known Issues & Quirks

### All Outdoor Cameras
- Take 4-10 seconds to wake up and start streaming
- Snapshots wake the camera (60s/5min cache depending on battery status)
- First keyframe (IDR) may take several seconds after wake

### Garage Camera (Kinesis/KVS) - Known Wi-Fi Issues
- **Location has poor Wi-Fi signal** - causes packet loss, not just reordering
- Symptoms: FFmpeg decode errors (`concealing X DC, X AC, X MV errors`), glitchy video
- Logs show `[RtpReorder] Skipping N missing packets` - these are truly lost, not late
- Snapshots work but slow (~20s due to retries)
- **Root cause is physical** - camera location, not code. Reorder buffer can't fix lost packets.

### LiveKit Cameras (Back Yard)
- Generally more reliable than Kinesis
- Faster snapshot capture (~3s)

## Debugging Video Issues

### Log Prefixes
- `[Kinesis]` - WebRTC signaling (connection, ICE, SDP)
- `[KinesisDelegate]` - Video pipeline (FFmpeg, packets, NALs)
- `[RtpReorder]` - Packet reordering/loss detection
- `[LiveKitDelegate]` - LiveKit camera pipeline

### Key Log Messages

```bash
# Good - stream working
[KinesisDelegate] First NAL unit written (X bytes)
[KinesisDelegate] Snapshot captured in Xms (size: XKB)

# Packet loss (Wi-Fi issue, not code bug)
[RtpReorder] Skipping N missing packets (X -> Y)

# Decode errors (caused by packet loss)
[h264 @ 0x...] concealing X DC, X AC, X MV errors in I/P frame

# Connection issues
[Kinesis] connection timeout - camera may be asleep
[Kinesis] Connection disconnected
```

### Checking Logs on Pi

```bash
# Recent camera activity
ssh pi@192.168.1.222 "tail -100 /var/lib/homebridge/homebridge.log | grep -E '(Kinesis|LiveKit|RtpReorder)'"

# Reorder buffer stats
ssh pi@192.168.1.222 "grep 'Reorder stats' /var/lib/homebridge/homebridge.log | tail -5"

# FFmpeg errors
ssh pi@192.168.1.222 "grep -E '(concealing|error while decoding)' /var/lib/homebridge/homebridge.log | tail -10"
```

## Documentation

- `docs/kinesis-webrtc-implementation.md` - Technical details
- `docs/kinesis-webrtc-testing.md` - Test procedures
- `docs/plans/2026-01-30-api-discovery-notes.md` - API field reference
- `docs/plans/2026-02-01-rtp-reorder-buffer-design.md` - RTP reorder buffer design & implementation notes

## Fork Maintenance

This fork diverges from upstream. To sync upstream changes:

```bash
git remote add upstream https://github.com/homebridge-simplisafe3/homebridge-simplisafe3.git
git fetch upstream
git rebase upstream/master
# Resolve conflicts
git push origin master --force-with-lease
```

Then remove upstream again: `git remote remove upstream`
