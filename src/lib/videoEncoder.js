/**
 * H.264 encoder resolution for camera streaming pipelines.
 *
 * Prefers the Raspberry Pi's hardware encoder (h264_v4l2m2m) when a probe
 * confirms it actually works - being listed in `ffmpeg -encoders` is not
 * enough, the V4L2 device must exist and accept a test encode. Falls back
 * to software libx264 everywhere else (including dev machines).
 */

/*global process */
import { spawn } from 'node:child_process';

const PROBE_TIMEOUT_MS = 5000;

let resolvedEncoderPromise = null;

export function resolveEncoder(ffmpegPath, cameraOptions, log) {
    if (cameraOptions?.forceSoftwareEncoder === true) {
        return Promise.resolve('libx264');
    }

    if (!resolvedEncoderPromise) {
        resolvedEncoderPromise = probeHardwareEncoder(ffmpegPath).then((works) => {
            if (works) {
                log('Using hardware H.264 encoder (h264_v4l2m2m) for camera streams');
                return 'h264_v4l2m2m';
            }
            log('Hardware H.264 encoder unavailable, using software libx264 for camera streams');
            return 'libx264';
        });
    }

    return resolvedEncoderPromise;
}

/**
 * Encoder-specific ffmpeg output args. libx264 tuning flags are private
 * options that other encoders reject, so each encoder gets its own set.
 */
export function encoderArgs(encoder) {
    if (encoder === 'h264_v4l2m2m') {
        return ['-vcodec', 'h264_v4l2m2m'];
    }
    return ['-vcodec', 'libx264', '-tune', 'zerolatency', '-preset', 'ultrafast'];
}

function probeHardwareEncoder(ffmpegPath) {
    return new Promise((resolve) => {
        const ffmpeg = spawn(
            ffmpegPath,
            [
                '-hide_banner',
                '-loglevel',
                'error',
                '-f',
                'lavfi',
                '-i',
                'color=black:s=320x240:r=10:d=0.3',
                '-c:v',
                'h264_v4l2m2m',
                '-f',
                'null',
                '-'
            ],
            { env: process.env }
        );

        const timer = setTimeout(() => {
            ffmpeg.kill('SIGKILL');
            resolve(false);
        }, PROBE_TIMEOUT_MS);

        ffmpeg.on('close', (code) => {
            clearTimeout(timer);
            resolve(code === 0);
        });

        ffmpeg.on('error', () => {
            clearTimeout(timer);
            resolve(false);
        });
    });
}

export default resolveEncoder;
