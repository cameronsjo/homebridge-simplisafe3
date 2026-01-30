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

## Known Quirks

- Outdoor cameras take 4-10 seconds to wake up and start streaming
- Kinesis may have occasional frame corruption (mitigated with FFmpeg error tolerance)
- Snapshots wake the camera (60s cache to reduce impact)

## Documentation

- `docs/kinesis-webrtc-implementation.md` - Technical details
- `docs/kinesis-webrtc-testing.md` - Test procedures
- `docs/plans/2026-01-30-api-discovery-notes.md` - API field reference

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
