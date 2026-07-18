import Alarm from './accessories/alarm';
import Camera from './accessories/camera';
import CODetector from './accessories/coDetector';
import DoorLock from './accessories/doorLock';
import EntrySensor from './accessories/entrySensor';
import FreezeSensor from './accessories/freezeSensor';
import MotionSensor from './accessories/motionSensor';
import SmokeDetector from './accessories/smokeDetector';
import UnreachableAccessory from './accessories/unreachableAccessory';
import WaterSensor from './accessories/waterSensor';
import SimpliSafe3AuthenticationManager, { AUTH_EVENTS } from './lib/authManager';
import SimpliSafe3, { RateLimitError, SENSOR_TYPES } from './simplisafe';

const PLUGIN_NAME = 'homebridge-simplisafe3';
const PLATFORM_NAME = 'SimpliSafe 3';

const INITIAL_STARTUP_RETRY_DELAY = 30 * 1000;
const MAX_STARTUP_RETRY_DELAY = 5 * 60 * 1000;

let UUIDGen;

class SS3Platform {
    constructor(log, config, api) {
        this.log = log;
        this.name = config.name;
        this.enableCameras = config.cameras || false;
        this.cameraOptions = config.cameraOptions || null;
        this.debug = config.debug || false;
        this.persistAccessories = config.persistAccessories !== undefined ? config.persistAccessories : true;
        this.excludedDevices = config.excludedDevices || [];
        this.devices = [];
        this.accessories = [];
        this.api = api;

        this.cachedAccessoryConfig = [];
        this.unreachableAccessories = [];

        this.startupRetryPending = false;
        this.retryInProgress = false;
        this.startupRetryDelay = INITIAL_STARTUP_RETRY_DELAY;
        this.initRetryTimerID = null;

        let refreshInterval = 15000;
        if (config.sensorRefresh) {
            refreshInterval = config.sensorRefresh * 1000;
        }

        this.authManager = new SimpliSafe3AuthenticationManager(this.api.user.storagePath(), log, this.debug);
        this.simplisafe = new SimpliSafe3(
            refreshInterval,
            this.authManager,
            this.api.user.storagePath(),
            log,
            this.debug
        );

        if (config.subscriptionId) {
            if (this.debug) this.log(`Specifying account number: ${config.subscriptionId}`);
            this.simplisafe.setDefaultSubscription(config.subscriptionId);
        }

        if (config.auth?.username && config.auth.password && !this.authManager.accountsFileExists()) {
            // this will flag authManager to try username / pw login
            this.authManager.username = config.auth.username;
            this.authManager.password = config.auth.password;
        }

        // If initialization is still pending when credentials recover (driven by the
        // cached alarm's refresh loop, which keeps running through outages), re-run it.
        this.authManager.on(AUTH_EVENTS.REFRESH_CREDENTIALS_SUCCESS, () => {
            if (this.startupRetryPending && !this.retryInProgress) {
                if (this.debug) this.log('Credentials recovered with initialization pending, retrying');
                this.retryBlockedAccessories();
            }
        });

        this.initialLoad = this.authManager
            .refreshCredentials()
            .then(() => {
                return this.discoverSimpliSafeDevices();
            })
            .catch((err) => {
                const errClass = this._classifyInitError(err);
                if (errClass === 'fatal') {
                    this.log.error('SimpliSafe login failed with error:', err.toJSON ? err.toJSON() : err);
                    this.log.error('See the plugin README for more information on authenticating with SimpliSafe.');
                } else {
                    this.startupRetryPending = true;
                    if (errClass === 'ratelimit') {
                        this.log.error('Initial load failed due to rate limiting, trying again later');
                    } else {
                        this.log.error(
                            'Initial load failed due to a connectivity problem, retrying until it succeeds:',
                            err.message ?? err
                        );
                    }
                    this._scheduleInitRetry(errClass);
                }
            });

        this.api.on('didFinishLaunching', () => {
            if (this.debug) this.log(`Found ${this.cachedAccessoryConfig.length} cached accessories to be configured.`);
            if (this.debug) this.log('Attempting intial SimpliSafe credentials refresh.');
            this.initialLoad
                .then(() => {
                    return Promise.all(this.cachedAccessoryConfig);
                })
                .then(() => {
                    if (!this.authManager.isAuthenticated()) {
                        if (this.startupRetryPending) {
                            this.log.warn('SimpliSafe initialization deferred pending connectivity, retrying automatically.');
                            return;
                        }
                        throw new Error('Not authenticated with SimpliSafe.');
                    } else {
                        this.simplisafe.startListening();
                        this.createNewPlatformAccessories();
                    }
                })
                .catch((err) => {
                    this.log.error('Initial accessories refresh failed with error:', err.toJSON ? err.toJSON() : err);
                });
        });
    }

    configureAccessory(accessory) {
        const config = new Promise((resolve, reject) => {
            this.initialLoad
                .then(() => {
                    const isAlarmAccessory = accessory.services.find(
                        (s) => s.UUID === this.api.hap.Service.SecuritySystem.UUID
                    );
                    // The alarm is exempt from the unreachable wrap: the cached-alarm branch
                    // below starts the refresh loop that drives credential recovery, and a
                    // faulted-but-live alarm tile beats "not responding" during an outage.
                    if ((this.simplisafe.isBlocked || this.startupRetryPending) && !isAlarmAccessory) {
                        const unreachableAccessory = new UnreachableAccessory(accessory, this.api);
                        this.unreachableAccessories.push(unreachableAccessory);

                        return resolve();
                    }

                    const device = this.devices.find((device) => device.uuid === accessory.UUID);

                    if (device) {
                        if (this.debug)
                            this.log(
                                `Initializing device ${device.constructor.name} '${device.name ? device.name : device.uuid}' with cached accessory`
                            );
                        device.setAccessory(accessory);
                        this.accessories.push(accessory);
                    } else {
                        if (this.debug)
                            this.log(`Cached accessory {${accessory.UUID}} not matched to a SimpliSafe device`);
                        if (
                            !this.authManager.isAuthenticated() &&
                            accessory.services.find((s) => s.UUID === this.api.hap.Service.SecuritySystem.UUID) &&
                            accessory._associatedPlugin === PLUGIN_NAME
                        ) {
                            // In the case of initial auth failure instantiate the cached alarm and set fault
                            const alarmAccessory = new Alarm(
                                'SimpliSafe 3',
                                '000',
                                this.log,
                                this.debug,
                                this.simplisafe,
                                this.api
                            );

                            // Adopt the cached accessory's identity so a post-recovery
                            // discovery pass reuses this device instead of creating a
                            // duplicate alarm (the placeholder serial hashes differently)
                            alarmAccessory.uuid = accessory.UUID;
                            this.devices.push(alarmAccessory);
                            alarmAccessory.setAccessory(accessory);
                            this.accessories.push(accessory);
                            alarmAccessory.setFault();
                        } else {
                            this.removeAccessory(accessory);
                        }
                    }

                    resolve();
                })
                .catch((err) => {
                    reject(err);
                });
        });

        this.cachedAccessoryConfig.push(config);
    }

    removeAccessory(accessory) {
        if (accessory) {
            if (!this.persistAccessories && !this.simplisafe.isBlocked) {
                if (this.debug) this.log('Removing accessory', accessory.name ?? accessory.UUID);
                this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
            }
            if (this.accessories.indexOf(accessory) > -1) {
                this.accessories.splice(this.accessories.indexOf(accessory), 1);
            }
        }
    }

    createNewPlatformAccessories() {
        for (const device of this.devices) {
            const existingAccessory = this.accessories.find((acc) => acc.UUID === device.uuid);
            if (!existingAccessory) {
                if (this.debug) this.log(`Initializing SS device '${device.name}' with new accessory.`);
                const accessory = device.createAccessory(); // from SimpliSafe3Accessory
                try {
                    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
                    this.accessories.push(accessory);
                } catch (err) {
                    this.log.error('An error occurred while adding accessory:', err.toJSON ? err.toJSON() : err);
                }
            }
        }
    }

    async discoverSimpliSafeDevices() {
        if (this.debug) this.log('Discovering devices from SimpliSafe');
        try {
            const subscription = await this.simplisafe.getSubscription();
            if (subscription.location.system.serial == null) throw new Error('System serial not found.');
            const uuid = UUIDGen.generate(subscription.location.system.serial);

            if (!this._deviceConfigured(uuid)) {
                const alarmAccessory = new Alarm(
                    'SimpliSafe 3',
                    subscription.location.system.serial,
                    this.log,
                    this.debug,
                    this.simplisafe,
                    this.api
                );

                this.devices.push(alarmAccessory);
            }

            const sensors = await this.simplisafe.getSensors();
            for (const sensor of sensors) {
                if (
                    sensor.type === SENSOR_TYPES.KEYPAD ||
                    sensor.type === SENSOR_TYPES.KEYCHAIN ||
                    sensor.type === SENSOR_TYPES.PANIC_BUTTON ||
                    sensor.type === SENSOR_TYPES.GLASSBREAK_SENSOR ||
                    sensor.type === SENSOR_TYPES.SIREN ||
                    sensor.type === SENSOR_TYPES.SIREN_2 ||
                    sensor.type === SENSOR_TYPES.DOORLOCK ||
                    sensor.type === SENSOR_TYPES.DOORLOCK_2
                ) {
                    // Ignore as no data is provided by SimpliSafe
                    // Door locks are configured below
                    continue;
                }

                const uuid = UUIDGen.generate(sensor.serial);
                const alreadyConfigured = this._deviceConfigured(uuid);
                let sensorName = sensor.name;
                if (this.debug) {
                    this.log(`Discovered sensor '${sensor.name}' from SimpliSafe:`, JSON.stringify(sensor));
                }

                if (sensor.serial && this.excludedDevices.includes(sensor.serial)) {
                    this.log.info(`Excluding sensor with serial '${sensor.serial}'`);
                    continue;
                }

                if (sensor.type === SENSOR_TYPES.ENTRY_SENSOR) {
                    if (!alreadyConfigured) {
                        sensorName = sensorName || `Entry Sensor ${sensor.serial}`;
                        const sensorAccessory = new EntrySensor(
                            sensorName,
                            sensor.serial,
                            this.log,
                            this.debug,
                            this.simplisafe,
                            this.api
                        );

                        this.devices.push(sensorAccessory);
                    }
                } else if (sensor.type === SENSOR_TYPES.CO_SENSOR) {
                    if (!alreadyConfigured) {
                        sensorName = sensorName || `CO Detector ${sensor.serial}`;
                        const sensorAccessory = new CODetector(
                            sensorName,
                            sensor.serial,
                            this.log,
                            this.debug,
                            this.simplisafe,
                            this.api
                        );

                        this.devices.push(sensorAccessory);
                    }
                } else if (sensor.type === SENSOR_TYPES.SMOKE_SENSOR) {
                    if (!alreadyConfigured) {
                        sensorName = sensorName || `Smoke Detector ${sensor.serial}`;
                        const sensorAccessory = new SmokeDetector(
                            sensorName,
                            sensor.serial,
                            this.log,
                            this.debug,
                            this.simplisafe,
                            this.api
                        );

                        this.devices.push(sensorAccessory);
                    }
                } else if (sensor.type === SENSOR_TYPES.WATER_SENSOR) {
                    if (!alreadyConfigured) {
                        sensorName = sensorName || `Water Sensor ${sensor.serial}`;
                        const sensorAccessory = new WaterSensor(
                            sensorName,
                            sensor.serial,
                            this.log,
                            this.debug,
                            this.simplisafe,
                            this.api
                        );

                        this.devices.push(sensorAccessory);
                    }
                } else if (sensor.type === SENSOR_TYPES.FREEZE_SENSOR) {
                    if (!alreadyConfigured) {
                        sensorName = sensorName || `Freeze Sensor ${sensor.serial}`;
                        const sensorAccessory = new FreezeSensor(
                            sensorName,
                            sensor.serial,
                            this.log,
                            this.debug,
                            this.simplisafe,
                            this.api
                        );

                        this.devices.push(sensorAccessory);
                    }
                } else if (sensor.type === SENSOR_TYPES.MOTION_SENSOR) {
                    sensorName = sensorName || `Motion Sensor ${sensor.serial}`;
                    // Check if secret alerts are enabled
                    if (sensor.setting.off === 0 || sensor.setting.home === 0 || sensor.setting.away === 0) {
                        this.log.warn(
                            `Motion Sensor '${sensorName}' requires secret alerts to be enabled in SimpliSafe before you can add it to Homebridge.`
                        );
                        continue;
                    }
                    if (!alreadyConfigured) {
                        const sensorAccessory = new MotionSensor(
                            sensorName,
                            sensor.serial,
                            this.log,
                            this.debug,
                            this.simplisafe,
                            this.api
                        );

                        this.devices.push(sensorAccessory);
                    }
                } else {
                    this.log.warn(`Sensor not (yet) supported: ${sensor.name}`);
                    this.log.warn(sensor);
                }
            }

            const locks = await this.simplisafe.getLocks();
            for (const lock of locks) {
                const lockName = lock.name || `Smart Lock ${lock.serial}`;
                const uuid = UUIDGen.generate(lock.serial);

                if (this.debug) {
                    this.log(`Discovered door lock '${lockName}' from SimpliSafe:`, JSON.stringify(lock));
                }

                if (!this._deviceConfigured(uuid)) {
                    const lockAccessory = new DoorLock(
                        lockName,
                        lock.serial,
                        this.log,
                        this.debug,
                        this.simplisafe,
                        this.api
                    );

                    this.devices.push(lockAccessory);
                }
            }

            if (this.enableCameras) {
                const cameras = await this.simplisafe.getCameras();

                for (const camera of cameras) {
                    const cameraName = camera.cameraSettings.cameraName || `Camera ${camera.uuid}`;
                    const uuid = UUIDGen.generate(camera.uuid);

                    if (this.debug) {
                        this.log(`Discovered camera '${cameraName}' from SimpliSafe:`, JSON.stringify(camera));
                    }

                    if (camera.serial && this.excludedDevices.includes(camera.serial)) {
                        this.log.info(`Excluding camera with serial '${camera.serial}'`);
                        continue;
                    }

                    if (!this._deviceConfigured(uuid)) {
                        const cameraAccessory = new Camera(
                            cameraName,
                            camera.uuid,
                            camera,
                            this.cameraOptions,
                            this.log,
                            this.debug,
                            this.simplisafe,
                            this.authManager,
                            this.api
                        );
                        if (cameraAccessory.isUnsupported())
                            this.log.warn(`Detected unsupported camera ${cameraName}, some features will be disabled.`);

                        this.devices.push(cameraAccessory);
                    }
                }
            }
        } catch (err) {
            if (err instanceof RateLimitError) {
                this.log.error(
                    'Accessory refresh failed due to rate limiting or connectivity:',
                    err.toJSON ? err.toJSON() : err
                );
                this.log.info(
                    'Note: this error can also occur if you are not signed up for a SimpliSafe monitoring plan.'
                );
            } else {
                this.log.error('An error occurred while refreshing accessories:', err.toJSON ? err.toJSON() : err);
            }
            throw err;
        }
    }

    updateAccessoriesReachability() {
        if (this.debug) this.log('Updating reacahability');
        for (const accessory of this.accessories) {
            accessory.updateReachability();
        }
    }

    async retryBlockedAccessories() {
        if (this.retryInProgress) return;
        this.retryInProgress = true;
        if (this.initRetryTimerID) {
            clearTimeout(this.initRetryTimerID);
            this.initRetryTimerID = null;
        }
        try {
            await this.authManager.refreshCredentials();
            if (this.debug) this.log('Credentials refreshed, re-running device discovery');
            await this.discoverSimpliSafeDevices();
            // Clear before reconfiguring so the unreachable-wrap branch in
            // configureAccessory doesn't re-wrap the accessories being restored
            this.startupRetryPending = false;
            this.cachedAccessoryConfig = [];
            for (const accessory of this.unreachableAccessories) {
                accessory.clearAccessory();
                this.configureAccessory(accessory.accessory);
            }
            await Promise.all(this.cachedAccessoryConfig);
            this.unreachableAccessories = [];
            this.createNewPlatformAccessories();
            // No-op if the socket already came up during a normal boot
            await this.simplisafe.startListening();
            this.startupRetryDelay = INITIAL_STARTUP_RETRY_DELAY;
            this.log.info('SimpliSafe initialization recovered.');
        } catch (err) {
            const errClass = this._classifyInitError(err);
            if (errClass === 'fatal') {
                // Leave startupRetryPending set: the cached alarm's refresh loop keeps
                // polling credentials, and its next success (e.g. after a re-auth through
                // the UI rewrites the accounts file) re-triggers this retry via the
                // REFRESH_CREDENTIALS_SUCCESS listener
                this.log.error(
                    'An error occurred while refreshing credentials again:',
                    err.toJSON ? err.toJSON() : err
                );
            } else {
                if (errClass === 'ratelimit') {
                    this.log.error('Credentials refresh attempt failed, still rate limited');
                } else {
                    this.log.error('Initialization retry failed due to a connectivity problem:', err.message ?? err);
                }
                this._scheduleInitRetry(errClass);
            }
        } finally {
            this.retryInProgress = false;
        }
    }

    _classifyInitError(err) {
        if (err instanceof RateLimitError) return 'ratelimit';
        if (err.isAxiosError && (!err.response || err.response.status >= 500)) return 'connectivity';
        return 'fatal';
    }

    _scheduleInitRetry(errClass) {
        if (this.initRetryTimerID) clearTimeout(this.initRetryTimerID);
        let delay;
        if (errClass === 'ratelimit') {
            delay = Math.max(this.simplisafe.nextAttempt - Date.now(), 0);
        } else {
            delay = this.startupRetryDelay;
            this.startupRetryDelay = Math.min(this.startupRetryDelay * 2, MAX_STARTUP_RETRY_DELAY);
        }
        this.log.warn(`Retrying SimpliSafe initialization in ${Math.round(delay / 1000)}s`);
        this.initRetryTimerID = setTimeout(async () => {
            this.initRetryTimerID = null;
            await this.retryBlockedAccessories();
        }, delay);
    }

    _deviceConfigured(uuid) {
        return (
            this.accessories.some((acc) => acc.UUID === uuid) ||
            this.devices.some((device) => device.uuid === uuid)
        );
    }
}

const homebridge = (homebridge) => {
    UUIDGen = homebridge.hap.uuid;

    homebridge.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, SS3Platform, true);
};

export default homebridge;
