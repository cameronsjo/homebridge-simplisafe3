class SS3UnreachableAccessory {
    // This is a dummy accessory used to let Homebridge know that the real
    // accessory is not reachable (due to rate limiting)

    constructor(accessory, api) {
        this.api = api;
        this.setAccessory(accessory);
    }

    identify(callback) {
        const err = new Error('Identify not supported');
        callback(err);
    }

    setAccessory(accessory) {
        this.accessory = accessory;
        this.accessory.on('identify', (_paired, callback) => this.identify(callback));

        for (const service of accessory.services) {
            if (service.UUID === this.api.hap.Service.AccessoryInformation.UUID) {
                // Don't mess with the accessory information
                continue;
            }

            for (const characteristic of service.characteristics) {
                if (characteristic.props.perms.indexOf('pr') > -1) {
                    // Read
                    characteristic.on('get', (callback) => this.unreachable(callback));
                }

                if (characteristic.props.perms.indexOf('pw') > -1) {
                    // Write
                    characteristic.on('set', (_state, callback) => this.unreachable(callback));
                }
            }
        }
    }

    clearAccessory() {
        for (const service of this.accessory.services) {
            if (service.UUID === this.api.hap.Service.AccessoryInformation.UUID) {
                // Don't mess with the accessory information
                continue;
            }

            for (const characteristic of service.characteristics) {
                if (characteristic.props.perms.indexOf('pr') > -1) {
                    // Read
                    characteristic.removeAllListeners('get');
                }

                if (characteristic.props.perms.indexOf('pw') > -1) {
                    // Write
                    characteristic.removeAllListeners('set');
                }
            }
        }
    }

    updateReachability() {
        return false;
    }

    unreachable(callback) {
        const err = new Error('Accessory unreachable');
        callback(err);
    }
}

export default SS3UnreachableAccessory;
