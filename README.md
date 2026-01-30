<span align="center">

# Homebridge SimpliSafe 3 (WebRTC Fork)

[![GitHub Release](https://img.shields.io/github/v/release/cameronsjo/homebridge-simplisafe3?style=flat-square)](https://github.com/cameronsjo/homebridge-simplisafe3/releases)
[![GitHub Last Commit](https://img.shields.io/github/last-commit/cameronsjo/homebridge-simplisafe3?style=flat-square)](https://github.com/cameronsjo/homebridge-simplisafe3/commits/main)
[![License](https://img.shields.io/github/license/cameronsjo/homebridge-simplisafe3?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-20-brightgreen?style=flat-square&logo=nodedotjs)](https://nodejs.org)
[![mise](https://img.shields.io/badge/mise-enabled-blue?style=flat-square&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0iI2ZmZiIgZD0iTTEyIDJMMiA3bDEwIDUgMTAtNS0xMC01ek0yIDE3bDEwIDUgMTAtNS0xMC01LTEwIDV6Ii8+PC9zdmc+)](https://mise.jdx.dev)
[![Biome](https://img.shields.io/badge/biome-enabled-60a5fa?style=flat-square&logo=biome)](https://biomejs.dev)
[![Code Style](https://img.shields.io/badge/code%20style-biome-60a5fa?style=flat-square)](https://biomejs.dev)
[![Complexity](https://img.shields.io/badge/complexity%20warnings-21-yellow?style=flat-square)](docs/plans/2026-01-30-api-discovery-notes.md)

A fork of [homebridge-simplisafe3](https://github.com/homebridge-simplisafe3/homebridge-simplisafe3) with **native WebRTC support for outdoor cameras**.

</span>

## Fork Attribution

This is a personal fork of the excellent [homebridge-simplisafe3](https://github.com/homebridge-simplisafe3/homebridge-simplisafe3) plugin.

**Original authors:**
- [Niccolò Zapponi](https://twitter.com/nzapponi)
- [Michael Shamoon](https://github.com/shamoon)

**Fork maintained by:** [Cameron Sjo](https://github.com/cameronsjo)

Thank you to the original authors for creating and maintaining the upstream plugin. This fork exists to add experimental features that are too large or experimental for the upstream project.

## What's Different in This Fork?

### Native WebRTC Support for Outdoor Cameras

This fork adds native streaming support for SimpliSafe outdoor cameras using WebRTC:

| Camera Type | Upstream | This Fork |
|-------------|----------|-----------|
| SimpliCam (indoor) | ✅ FLV streaming | ✅ FLV streaming |
| Video Doorbell | ✅ FLV streaming | ✅ FLV streaming |
| Outdoor Camera | ❌ Not supported | ✅ **Kinesis/LiveKit WebRTC** |

**Supported outdoor camera models:**
- `SSOBCM4` - Uses LiveKit (MIST provider)
- `olympus` - Uses Kinesis (KVS provider)

The streaming delegate is automatically selected based on the camera's `webrtcProvider` field.

## Installation

Since this is a personal fork, install directly from GitHub:

```bash
npm install github:cameronsjo/homebridge-simplisafe3
```

Or in your Homebridge `config.json`:

```json
{
    "platform": "homebridge-simplisafe3.SimpliSafe 3",
    "name": "Home Alarm",
    "cameras": true,
    "debug": true
}
```

## Requirements

- Node.js 14.13.1+
- Homebridge 1.3.5+ or 2.0.0-beta.0+
- Works with native Homebridge and [oznu/docker-homebridge](https://github.com/oznu/docker-homebridge)

## Features

All features from the upstream plugin, plus:

- **Outdoor camera streaming** via native WebRTC (Kinesis/LiveKit)
- **Automatic provider detection** - no configuration needed
- **Snapshot caching** - reduces API calls and camera wake-ups

### Inherited Features

- **Real time event streaming:** immediate notifications for alarm armed/disarmed/triggered
- **Sensors:** entry sensors, motion sensors, smoke/CO detectors, water sensors, freeze sensors
- **Door locks:** lock, unlock, and battery monitoring
- **Indoor cameras:** SimpliCam and Video Doorbell Pro via FLV streaming
- **Battery monitoring:** low battery warnings for all devices

## Supported Devices

Device             | Supported          | Notes
------------------ | ------------------ | -------------------------------------------------
Alarm              | ✅ | Arming/disarming to home, away and off modes
SimpliCam          | ✅ | Audio, video, motion (FLV streaming)
Doorbell           | ✅ | Audio, video, motion, doorbell notifications (FLV streaming)
Outdoor Camera     | ✅ | **WebRTC streaming** - 4-10s startup (battery wake-up)
Smart lock         | ✅ | Lock, unlock, battery status
Entry sensor       | ✅ | Polled based on `sensorRefresh`
Smoke detector     | ✅ | Includes tamper & fault
CO detector        | ✅ | Includes tamper & fault
Water sensor       | ✅ |
Freeze sensor      | ✅ | Temperature readings
Motion sensor      | ✅ | Requires "Secret Alert" or "Alarm" mode
Glassbreak sensor  | ❌ | State not provided by SimpliSafe
Keypad             | ❌ | State not provided by SimpliSafe
Panic button       | ❌ | State not provided by SimpliSafe

## Configuration

### Basic Configuration

```json
{
    "platform": "homebridge-simplisafe3.SimpliSafe 3",
    "name": "Home Alarm",
    "cameras": true
}
```

### Optional Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `cameras` | boolean | `false` | Enable camera support |
| `debug` | boolean | `false` | Enable debug logging |
| `subscriptionId` | string | - | Account number (for multiple locations) |
| `sensorRefresh` | integer | `15` | Sensor polling interval in seconds |
| `persistAccessories` | boolean | `true` | Persist accessories across restarts |
| `excludedDevices` | array | `[]` | Serial numbers to exclude |

### Camera Options

```json
{
    "cameraOptions": {
        "ffmpegPath": "/path/to/custom/ffmpeg",
        "sourceOptions": "-format: flv ...",
        "videoOptions": "-vcodec h264_omx -tune false ...",
        "audioOptions": "-ar 256k ...",
        "enableHwaccelRpi": true
    }
}
```

## Authentication

SimpliSafe uses OAuth for authentication. Two methods available:

1. **Config UI X** (recommended) - Use the "Launch SimpliSafe Login" button in plugin settings
2. **Command line** - Run `homebridge-simplisafe3 login`

See the [upstream documentation](https://github.com/homebridge-simplisafe3/homebridge-simplisafe3#simplisafe-authentication) for detailed instructions.

## Outdoor Camera Notes

- **Startup time:** 4-10 seconds (camera must wake from sleep)
- **Best results:** Set camera shutter to "Open" in SimpliSafe app
- **Battery impact:** Streaming wakes the camera; snapshots use caching to minimize wake-ups

## Debug Scripts

This fork includes debug scripts for troubleshooting:

```bash
# Test Kinesis connection
node scripts/test-kinesis.js <access_token> <camera_uuid> <location_id>

# Test LiveKit connection
node scripts/test-livekit.js <livekit_token>

# Dump camera API data
node scripts/dump-camera-data.js <access_token> [--full]
```

## Documentation

- [WebRTC Implementation Details](docs/kinesis-webrtc-implementation.md)
- [Testing Documentation](docs/kinesis-webrtc-testing.md)
- [API Discovery Notes](docs/plans/2026-01-30-api-discovery-notes.md)

## Code Quality

This fork uses [Biome](https://biomejs.dev) for linting and formatting.

```bash
npx biome check src/          # Check for issues
npx biome check --write src/  # Auto-fix issues
npx biome format --write src/ # Format only
```

### Complexity Warnings (21)

Functions flagged for future refactoring:

| File | Function | Complexity |
|------|----------|------------|
| `simplisafe.js` | WebSocket message handler | 33 |
| `simplisafe.js` | `subscribeToSensor` | 27 |
| `simplisafe.js` | `subscribeToAlarmSystem` | 27 |
| `index.js` | Plugin initialization | High |
| `kinesisClient.js` | Session creation | High |
| `streamingDelegate.js` | Stream handling | High |
| Various sensors | Callback handlers | Medium |

These are warnings, not errors - the code works correctly.

## Known Issues

- Outdoor camera initial stream startup takes 4-10 seconds
- Some frame corruption possible with Kinesis cameras (mitigated with FFmpeg error tolerance)
- Docker environments may limit resolution to 720p

## Contributing

This is a personal fork. For issues specific to WebRTC/outdoor camera support, please open an issue here.

For issues with the core plugin functionality, consider reporting to the [upstream project](https://github.com/homebridge-simplisafe3/homebridge-simplisafe3).

## License

MIT - See [LICENSE](LICENSE)

## Acknowledgments

- [homebridge-simplisafe3](https://github.com/homebridge-simplisafe3/homebridge-simplisafe3) - Original plugin
- [Niccolò Zapponi](https://twitter.com/nzapponi) & [Michael Shamoon](https://github.com/shamoon) - Original authors
- [werift](https://github.com/aspect-build/aspect-build/tree/main/packages/werift) - WebRTC implementation
- [@livekit/rtc-node](https://github.com/livekit/node-sdks) - LiveKit SDK
