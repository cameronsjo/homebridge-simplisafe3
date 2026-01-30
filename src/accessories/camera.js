/**
 * SimpliSafe Camera Accessory
 *
 * Supports three streaming modes based on camera type:
 * - Standard FLV streaming (indoor cameras, doorbell): Uses streamingDelegate.js
 * - Kinesis WebRTC (outdoor cameras with KVS provider): Uses kinesisStreamingDelegate.js
 * - LiveKit WebRTC (outdoor cameras with MIST provider): Uses liveKitStreamingDelegate.js
 *
 * The streaming delegate is selected based on cameraDetails.currentState.webrtcProvider:
 * - 'KVS' -> Kinesis (AWS Kinesis Video Streams WebRTC)
 * - 'MIST' -> LiveKit (SimpliSafe's LiveKit deployment)
 * - null/undefined -> Standard FLV streaming
 */

import ffmpegPath from 'ffmpeg-for-homebridge';
import isDocker from 'is-docker';
import KinesisStreamingDelegate from '../lib/kinesisStreamingDelegate';
import LiveKitStreamingDelegate from '../lib/liveKitStreamingDelegate';

import StreamingDelegate from '../lib/streamingDelegate';
import { EVENT_TYPES } from '../simplisafe';
import SimpliSafe3Accessory from './ss3Accessory';

class SS3Camera extends SimpliSafe3Accessory {
    constructor(name, id, cameraDetails, cameraOptions, log, debug, simplisafe, authManager, api) {
        super(name, id, log, debug, simplisafe, api);
        this.cameraDetails = cameraDetails;
        this.cameraOptions = cameraOptions;
        this.authManager = authManager;
        this.reachable = true;
        this.nSocketConnectFailures = 0;

        this.ffmpegPath = isDocker() ? 'ffmpeg' : ffmpegPath;
        if (this.debug && isDocker()) this.log('Detected running in docker, initializing with docker-bundled ffmpeg');
        if (this.cameraOptions?.ffmpegPath) {
            this.ffmpegPath = this.cameraOptions.ffmpegPath;
        }

        // Select appropriate streaming delegate based on camera's WebRTC provider
        let delegate;
        const webrtcProvider = this._getWebRTCProvider();

        if (webrtcProvider === 'KVS') {
            delegate = new KinesisStreamingDelegate(this);
            if (this.debug) this.log(`Camera '${name}' using Kinesis WebRTC streaming`);
        } else if (webrtcProvider === 'MIST') {
            delegate = new LiveKitStreamingDelegate(this);
            if (this.debug) this.log(`Camera '${name}' using LiveKit streaming`);
        } else {
            delegate = new StreamingDelegate(this);
            if (this.debug) this.log(`Camera '${name}' using standard FLV streaming`);
        }

        this.controller = delegate.controller;

        this.startListening();
    }

    setAccessory(accessory) {
        super.setAccessory(accessory);

        this.accessory
            .getService(this.api.hap.Service.AccessoryInformation)
            .setCharacteristic(this.api.hap.Characteristic.Manufacturer, 'SimpliSafe')
            .setCharacteristic(this.api.hap.Characteristic.Model, this.cameraDetails.model)
            .setCharacteristic(this.api.hap.Characteristic.SerialNumber, this.id)
            .setCharacteristic(
                this.api.hap.Characteristic.FirmwareRevision,
                this.cameraDetails.cameraSettings.admin.firmwareVersion
            );

        this.accessory.configureController(this.controller);

        // add motion sensor after configureController as HKSV creates it own linked motion service
        if (!this.accessory.getService(this.api.hap.Service.MotionSensor))
            this.accessory.addService(this.api.hap.Service.MotionSensor);
        this.accessory
            .getService(this.api.hap.Service.MotionSensor)
            .getCharacteristic(this.api.hap.Characteristic.MotionDetected)
            .on('get', (callback) =>
                this.getState(
                    callback,
                    this.accessory.getService(this.api.hap.Service.MotionSensor),
                    this.api.hap.Characteristic.MotionDetected
                )
            );

        // add doorbell after configureController as HKSV creates it own linked motion service
        if (this.cameraDetails.model === 'SS002') {
            // SSO02 is doorbell cam
            if (!this.accessory.getService(this.api.hap.Service.Doorbell))
                this.accessory.addService(this.api.hap.Service.Doorbell);
            this.accessory
                .getService(this.api.hap.Service.Doorbell)
                .getCharacteristic(this.api.hap.Characteristic.ProgrammableSwitchEvent)
                .on('get', (callback) =>
                    this.getState(
                        callback,
                        this.accessory.getService(this.api.hap.Service.Doorbell),
                        this.api.hap.Characteristic.ProgrammableSwitchEvent
                    )
                );
        }

        // Add battery service for battery-capable cameras
        if (this._isBatteryCamera()) {
            this._setupBatteryService();
        }
    }

    /**
     * Check if this camera supports battery power
     */
    _isBatteryCamera() {
        return this.cameraDetails.supportedFeatures?.battery === true;
    }

    /**
     * Set up HomeKit BatteryService for battery-capable cameras
     */
    _setupBatteryService() {
        if (!this.accessory.getService(this.api.hap.Service.Battery)) {
            this.accessory.addService(this.api.hap.Service.Battery, `${this.name} Battery`);
        }

        const batteryService = this.accessory.getService(this.api.hap.Service.Battery);

        // Battery Level (0-100)
        batteryService
            .getCharacteristic(this.api.hap.Characteristic.BatteryLevel)
            .on('get', (callback) => this._getBatteryLevel(callback));

        // Charging State
        batteryService
            .getCharacteristic(this.api.hap.Characteristic.ChargingState)
            .on('get', (callback) => this._getChargingState(callback));

        // Status Low Battery (triggered at 20%)
        batteryService
            .getCharacteristic(this.api.hap.Characteristic.StatusLowBattery)
            .on('get', (callback) => this._getStatusLowBattery(callback));

        // Set initial values
        this._updateBatteryStatus();

        if (this.debug) {
            const level = this.cameraDetails.cameraStatus?.batteryPercentage ?? 'unknown';
            const charging = this.cameraDetails.currentState?.batteryCharging ? 'charging' : 'not charging';
            this.log(`Battery service added for '${this.name}': ${level}%, ${charging}`);
        }
    }

    /**
     * Update battery status from camera details
     */
    _updateBatteryStatus() {
        if (!this._isBatteryCamera()) return;

        const batteryService = this.accessory.getService(this.api.hap.Service.Battery);
        if (!batteryService) return;

        const level = this.cameraDetails.cameraStatus?.batteryPercentage ?? 100;
        const isCharging = this.cameraDetails.currentState?.batteryCharging === true;
        const isLowBattery = level <= 20;

        batteryService.updateCharacteristic(this.api.hap.Characteristic.BatteryLevel, level);
        batteryService.updateCharacteristic(
            this.api.hap.Characteristic.ChargingState,
            isCharging
                ? this.api.hap.Characteristic.ChargingState.CHARGING
                : this.api.hap.Characteristic.ChargingState.NOT_CHARGING
        );
        batteryService.updateCharacteristic(
            this.api.hap.Characteristic.StatusLowBattery,
            isLowBattery
                ? this.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
                : this.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
        );
    }

    _getBatteryLevel(callback) {
        const level = this.cameraDetails.cameraStatus?.batteryPercentage ?? 100;
        callback(null, level);
    }

    _getChargingState(callback) {
        const isCharging = this.cameraDetails.currentState?.batteryCharging === true;
        callback(
            null,
            isCharging
                ? this.api.hap.Characteristic.ChargingState.CHARGING
                : this.api.hap.Characteristic.ChargingState.NOT_CHARGING
        );
    }

    _getStatusLowBattery(callback) {
        const level = this.cameraDetails.cameraStatus?.batteryPercentage ?? 100;
        const isLowBattery = level <= 20;
        callback(
            null,
            isLowBattery
                ? this.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
                : this.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
        );
    }

    getState(callback, service, characteristicType) {
        if (this.simplisafe.isBlocked && Date.now() < this.simplisafe.nextAttempt) {
            callback(new Error('Request blocked (rate limited)'));
            return;
        }
        const characteristic = service.getCharacteristic(characteristicType);
        callback(null, characteristic.value);
    }

    async updateReachability() {
        try {
            const cameras = await this.simplisafe.getCameras();
            const camera = cameras.find((cam) => cam.uuid === this.id);
            if (!camera) {
                this.reachable = false;
            } else {
                this.reachable = camera.status === 'online';
            }

            return this.reachable;
        } catch (err) {
            this.log.error(`An error occurred while updating reachability for ${this.name}`);
            this.log.error(err);
        }
    }

    supportsPrivacyShutter() {
        // so far SS001 & SS003
        return this.cameraDetails.supportedFeatures?.privacyShutter;
    }

    isUnsupported() {
        // Outdoor cameras are now supported via Kinesis WebRTC
        // Only return true for cameras with unknown/unsupported providers
        return false;
    }

    _getWebRTCProvider() {
        // Get the WebRTC provider from camera details
        // KVS = AWS Kinesis Video Streams (outdoor cameras)
        // MIST = LiveKit (some outdoor cameras)
        // null/undefined = standard FLV streaming (indoor cameras)
        return this.cameraDetails.currentState?.webrtcProvider?.toUpperCase() || null;
    }

    _isKinesisCamera() {
        return this._getWebRTCProvider() === 'KVS';
    }

    _isLiveKitCamera() {
        return this._getWebRTCProvider() === 'MIST';
    }

    startListening() {
        this.simplisafe.on(EVENT_TYPES.CAMERA_MOTION, (data) => {
            if (!this._validateEvent(EVENT_TYPES.CAMERA_MOTION, data)) return;
            this.accessory
                .getService(this.api.hap.Service.MotionSensor)
                .updateCharacteristic(this.api.hap.Characteristic.MotionDetected, true);
            this.motionIsTriggered = true;
            setTimeout(() => {
                this.accessory
                    .getService(this.api.hap.Service.MotionSensor)
                    .updateCharacteristic(this.api.hap.Characteristic.MotionDetected, false);
                this.motionIsTriggered = false;
            }, 5000);
        });
        this.simplisafe.on(EVENT_TYPES.DOORBELL, (data) => {
            if (!this._validateEvent(EVENT_TYPES.DOORBELL, data)) return;
            this.accessory
                .getService(this.api.hap.Service.Doorbell)
                .getCharacteristic(this.api.hap.Characteristic.ProgrammableSwitchEvent)
                .setValue(0);
        });
    }

    _validateEvent(event, data) {
        let valid;
        if (!this.accessory || !data) valid = false;
        else {
            const eventCameraIds = [data.sensorSerial];
            if (data.internal) eventCameraIds.push(data.internal.mainCamera);
            valid = eventCameraIds.indexOf(this.id) > -1;
        }

        if (this.debug && valid) this.log(`${this.name} camera received event: ${event}`);
        return valid;
    }
}

export default SS3Camera;
