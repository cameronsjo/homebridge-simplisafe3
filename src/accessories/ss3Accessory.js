class SimpliSafe3Accessory {
    services = [];

    constructor(name, id, log, debug, simplisafe, api) {
        this.id = id;
        this.log = log;
        this.debug = debug;
        this.name = name;
        this.simplisafe = simplisafe;
        this.api = api;
        this.uuid = this.api.hap.uuid.generate(id);
    }

    identify(callback) {
        if (this.debug) this.log(`Identify request for ${this.name}`);
        callback();
    }

    createAccessory() {
        const newAccessory = new this.api.platformAccessory(this.name, this.uuid);
        this.setupServices(newAccessory);
        this.setAccessory(newAccessory);
        return newAccessory;
    }

    setAccessory(accessory) {
        this.accessory = accessory;
        this.accessory.on('identify', (_paired, callback) => this.identify(callback));
    }

    setupServices(accessory) {
        for (const service of this.services) {
            accessory.addService(service);
        }
    }
}

export default SimpliSafe3Accessory;
