const BaseAccessory = require('./BaseAccessory');

const STATE_OTHER = 9;

// Маппинг строк Tuya -> проценты HomeKit (и обратно)
const FAN_TO_PERCENT = {
    auto: 0,
    mute: 10,
    low: 25,
    mid_low: 40,
    mid: 55,
    mid_high: 70,
    high: 85,
    strong: 100,
};
function percentToFan(p) {
    let best = 'auto', bestDiff = Number.POSITIVE_INFINITY;
    for (const [k, v] of Object.entries(FAN_TO_PERCENT)) {
        const d = Math.abs(p - v);
        if (d < bestDiff) { bestDiff = d; best = k; }
    }
    return best;
}

class AirConditionerAccessory extends BaseAccessory {
    static getCategory(Categories) {
        return Categories.AIR_CONDITIONER;
    }

    constructor(...props) {
        super(...props);

        this.cmdCool = 'COOL';
        if (this.device.context.cmdCool) {
            if (/^c[a-z]+$/i.test(this.device.context.cmdCool)) this.cmdCool = ('' + this.device.context.cmdCool).trim();
            else throw new Error('The cmdCool doesn\'t appear to be valid: ' + this.device.context.cmdCool);
        }

        this.cmdHeat = 'HEAT';
        if (this.device.context.cmdHeat) {
            if (/^h[a-z]+$/i.test(this.device.context.cmdHeat)) this.cmdHeat = ('' + this.device.context.cmdHeat).trim();
            else throw new Error('The cmdHeat doesn\'t appear to be valid: ' + this.device.context.cmdHeat);
        }

        this.cmdAuto = 'AUTO';
        if (this.device.context.cmdAuto) {
            if (/^a[a-z]+$/i.test(this.device.context.cmdAuto)) this.cmdAuto = ('' + this.device.context.cmdAuto).trim();
            else throw new Error('The cmdAuto doesn\'t appear to be valid: ' + this.device.context.cmdAuto);
        }

        // Disabling auto mode because I have not found a Tuya device config that has a temperature range for AUTO
        this.device.context.noAuto = true;

        // подготовим ступени "числового" вентилятора (оставляем совместимость с прежней логикой)
        if (!this.device.context.noRotationSpeed) {
            const fanSpeedSteps = (this.device.context.fanSpeedSteps && isFinite(this.device.context.fanSpeedSteps) && this.device.context.fanSpeedSteps > 0 && this.device.context.fanSpeedSteps < 100) ? this.device.context.fanSpeedSteps : 100;
            this._rotationSteps = [0];
            this._rotationStops = {0: 0};
            for (let i = 0; i++ < 100;) {
                const _rotationStep = Math.floor(fanSpeedSteps * (i - 1) / 100) + 1;
                this._rotationSteps.push(_rotationStep);
                this._rotationStops[_rotationStep] = i;
            }
        }
    }

    // ===== Helpers for target temperature divisors (dpThreshold) =====
    _getTargetTempDivisor() {
        return this.device.context.targetTemperatureDivisor || this.device.context.temperatureDivisor || 1;
    }
    _toHumanTargetTemp(raw) {
        const d = this._getTargetTempDivisor();
        return (typeof raw === 'number') ? (raw / d) : raw;
    }
    _fromHumanTargetTemp(human) {
        const d = this._getTargetTempDivisor();
        return (typeof human === 'number') ? Math.round(human * d) : human;
    }

    _registerPlatformAccessory() {
        const {Service} = this.hap;

        this.accessory.addService(Service.HeaterCooler, this.device.context.name);

        super._registerPlatformAccessory();
    }

    _registerCharacteristics(dps) {
        const {Service, Characteristic} = this.hap;
        const service = this.accessory.getService(Service.HeaterCooler);
        this._checkServiceName(service, this.device.context.name);

        this.dpActive = this._getCustomDP(this.device.context.dpActive) || '1';
        this.dpThreshold = this._getCustomDP(this.device.context.dpThreshold) || '2'; // desired temp
        this.dpCurrentTemperature = this._getCustomDP(this.device.context.dpCurrentTemperature) || '3';
        this.dpMode = this._getCustomDP(this.device.context.dpMode) || '4';
        this.dpRotationSpeed = this._getCustomDP(this.device.context.dpRotationSpeed) || '5';
        this.dpChildLock = this._getCustomDP(this.device.context.dpChildLock) || '6';
        this.dpTempUnits = this._getCustomDP(this.device.context.dpTempUnits) || '19';
        this.dpSwingMode = this._getCustomDP(this.device.context.dpSwingMode) || '104';

        const characteristicActive = service.getCharacteristic(Characteristic.Active)
            .updateValue(this._getActive(this.dpActive))
            .on('get', this.getActive.bind(this))
            .on('set', this.setActive.bind(this));

        const characteristicCurrentHeaterCoolerState = service.getCharacteristic(Characteristic.CurrentHeaterCoolerState)
            .updateValue(this._getCurrentHeaterCoolerState(dps))
            .on('get', this.getCurrentHeaterCoolerState.bind(this));

        const _validTargetHeaterCoolerStateValues = [STATE_OTHER];
        if (!this.device.context.noCool) _validTargetHeaterCoolerStateValues.unshift(Characteristic.TargetHeaterCoolerState.COOL);
        if (!this.device.context.noHeat) _validTargetHeaterCoolerStateValues.unshift(Characteristic.TargetHeaterCoolerState.HEAT);
        if (!this.device.context.noAuto) _validTargetHeaterCoolerStateValues.unshift(Characteristic.TargetHeaterCoolerState.AUTO);

        const characteristicTargetHeaterCoolerState = service.getCharacteristic(Characteristic.TargetHeaterCoolerState)
            .setProps({
                maxValue: 9,
                validValues: _validTargetHeaterCoolerStateValues
            })
            .updateValue(this._getTargetHeaterCoolerState(dps[this.dpMode]))
            .on('get', this.getTargetHeaterCoolerState.bind(this))
            .on('set', this.setTargetHeaterCoolerState.bind(this));

        const characteristicCurrentTemperature = service.getCharacteristic(Characteristic.CurrentTemperature)
            .updateValue(dps[this.dpCurrentTemperature])
            .on('get', this.getState.bind(this, this.dpCurrentTemperature));

        let characteristicSwingMode;
        if (!this.device.context.noSwing) {
            characteristicSwingMode = service.getCharacteristic(Characteristic.SwingMode)
                .updateValue(this._getSwingMode(dps[this.dpSwingMode]))
                .on('get', this.getSwingMode.bind(this))
                .on('set', this.setSwingMode.bind(this));
        } else this._removeCharacteristic(service, Characteristic.SwingMode);

        let characteristicLockPhysicalControls;
        if (!this.device.context.noChildLock) {
            characteristicLockPhysicalControls = service.getCharacteristic(Characteristic.LockPhysicalControls)
                .updateValue(this._getLockPhysicalControls(dps[this.dpChildLock]))
                .on('get', this.getLockPhysicalControls.bind(this))
                .on('set', this.setLockPhysicalControls.bind(this));
        } else this._removeCharacteristic(service, Characteristic.LockPhysicalControls);

        let characteristicCoolingThresholdTemperature;
        if (!this.device.context.noCool) {
            characteristicCoolingThresholdTemperature = service.getCharacteristic(Characteristic.CoolingThresholdTemperature)
                .setProps({
                    minValue: this.device.context.minTemperature || 10,
                    maxValue: this.device.context.maxTemperature || 35,
                    minStep: this.device.context.minTemperatureSteps || 1
                })
                // BUGFIX: раньше тут стояло .updateValue(this.dpThreshold) — это строка '2'.
                .updateValue(this._toHumanTargetTemp(dps[this.dpThreshold]))
                .on('get', this.getTargetThresholdTemperature.bind(this))
                .on('set', this.setTargetThresholdTemperature.bind(this, 'cool'));
        } else this._removeCharacteristic(service, Characteristic.CoolingThresholdTemperature);

        let characteristicHeatingThresholdTemperature;
        if (!this.device.context.noHeat) {
            characteristicHeatingThresholdTemperature = service.getCharacteristic(Characteristic.HeatingThresholdTemperature)
                .setProps({
                    minValue: this.device.context.minTemperature || 10,
                    maxValue: this.device.context.maxTemperature || 35,
                    minStep: this.device.context.minTemperatureSteps || 1
                })
                .updateValue(this._toHumanTargetTemp(dps[this.dpThreshold]))
                .on('get', this.getTargetThresholdTemperature.bind(this))
                .on('set', this.setTargetThresholdTemperature.bind(this, 'heat'));
        } else this._removeCharacteristic(service, Characteristic.HeatingThresholdTemperature);

        const characteristicTemperatureDisplayUnits = service.getCharacteristic(Characteristic.TemperatureDisplayUnits)
            .updateValue(this._getTemperatureDisplayUnits(dps[this.dpTempUnits]))
            .on('get', this.getTemperatureDisplayUnits.bind(this))
            .on('set', this.setTemperatureDisplayUnits.bind(this));

        let characteristicRotationSpeed;
        if (!this.device.context.noRotationSpeed) {
            characteristicRotationSpeed = service.getCharacteristic(Characteristic.RotationSpeed)
                .updateValue(this._getRotationSpeed(dps))
                .on('get', this.getRotationSpeed.bind(this))
                .on('set', this.setRotationSpeed.bind(this));
        } else this._removeCharacteristic(service, Characteristic.RotationSpeed);

        this.characteristicCoolingThresholdTemperature = characteristicCoolingThresholdTemperature;
        this.characteristicHeatingThresholdTemperature = characteristicHeatingThresholdTemperature;

        // Инициализация порогов не нулём, а текущей целью (нормализованной)
        const initialRaw = (this.device && this.device.state) ? this.device.state[this.dpThreshold] : undefined;
        const initialT = this._toHumanTargetTemp(
            (typeof initialRaw === 'number') ? initialRaw : (this.device.context.minTemperature || 16)
        );
        if (characteristicCoolingThresholdTemperature) characteristicCoolingThresholdTemperature.updateValue(initialT);
        if (characteristicHeatingThresholdTemperature) characteristicHeatingThresholdTemperature.updateValue(initialT);

        this.device.on('change', (changes, state) => {
            if (changes.hasOwnProperty(this.dpActive)) {
                const newActive = this._getActive(changes[this.dpActive]);
                if (characteristicActive.value !== newActive) {
                    characteristicActive.updateValue(newActive);

                    if (!changes.hasOwnProperty(this.dpMode)) {
                        characteristicCurrentHeaterCoolerState.updateValue(this._getCurrentHeaterCoolerState(state));
                    }

                    if (characteristicRotationSpeed && !changes.hasOwnProperty(this.dpRotationSpeed)) {
                        characteristicRotationSpeed.updateValue(this._getRotationSpeed(state));
                    }
                }
            }

            if (characteristicLockPhysicalControls && changes.hasOwnProperty(this.dpChildLock)) {
                const newLockPhysicalControls = this._getLockPhysicalControls(changes[this.dpChildLock]);
                if (characteristicLockPhysicalControls.value !== newLockPhysicalControls) {
                    characteristicLockPhysicalControls.updateValue(newLockPhysicalControls);
                }
            }

            if (changes.hasOwnProperty(this.dpThreshold)) {
                const humanT = this._toHumanTargetTemp(changes[this.dpThreshold]);
                if (!this.device.context.noCool && characteristicCoolingThresholdTemperature && characteristicCoolingThresholdTemperature.value !== humanT)
                    characteristicCoolingThresholdTemperature.updateValue(humanT);
                if (!this.device.context.noHeat && characteristicHeatingThresholdTemperature && characteristicHeatingThresholdTemperature.value !== humanT)
                    characteristicHeatingThresholdTemperature.updateValue(humanT);
            }

            if (changes.hasOwnProperty(this.dpCurrentTemperature) && characteristicCurrentTemperature.value !== changes[this.dpCurrentTemperature]) {
                characteristicCurrentTemperature.updateValue(changes[this.dpCurrentTemperature]);
            }

            if (changes.hasOwnProperty(this.dpMode)) {
                const newTargetHeaterCoolerState = this._getTargetHeaterCoolerState(changes[this.dpMode]);
                const newCurrentHeaterCoolerState = this._getCurrentHeaterCoolerState(state);
                if (characteristicTargetHeaterCoolerState.value !== newTargetHeaterCoolerState) characteristicTargetHeaterCoolerState.updateValue(newTargetHeaterCoolerState);
                if (characteristicCurrentHeaterCoolerState.value !== newCurrentHeaterCoolerState) characteristicCurrentHeaterCoolerState.updateValue(newCurrentHeaterCoolerState);
            }

            if (changes.hasOwnProperty(this.dpSwingMode)) {
                const newSwingMode = this._getSwingMode(changes[this.dpSwingMode]);
                if (characteristicSwingMode && characteristicSwingMode.value !== newSwingMode) characteristicSwingMode.updateValue(newSwingMode);
            }

            if (changes.hasOwnProperty(this.dpTempUnits)) {
                const newTemperatureDisplayUnits = this._getTemperatureDisplayUnits(changes[this.dpTempUnits]);
                if (characteristicTemperatureDisplayUnits.value !== newTemperatureDisplayUnits) characteristicTemperatureDisplayUnits.updateValue(newTemperatureDisplayUnits);
            }

            if (characteristicRotationSpeed && changes.hasOwnProperty(this.dpRotationSpeed)) {
                const newRotationSpeed = this._getRotationSpeed(state);
                if (characteristicRotationSpeed.value !== newRotationSpeed) characteristicRotationSpeed.updateValue(newRotationSpeed);

                if (!changes.hasOwnProperty(this.dpMode)) {
                    characteristicCurrentHeaterCoolerState.updateValue(this._getCurrentHeaterCoolerState(state));
                }
            }
        });
    }

    getActive(callback) {
        this.getState(this.dpActive, (err, dp) => {
            if (err) return callback(err);

            callback(null, this._getActive(dp));
        });
    }

    _getActive(dp) {
        const {Characteristic} = this.hap;

        return dp ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE;
    }

    setActive(value, callback) {
        const {Characteristic} = this.hap;

        switch (value) {
            case Characteristic.Active.ACTIVE:
                return this.setState(this.dpActive, true, callback);

            case Characteristic.Active.INACTIVE:
                return this.setState(this.dpActive, false, callback);
        }

        callback();
    }

    getLockPhysicalControls(callback) {
        this.getState(this.dpChildLock, (err, dp) => {
            if (err) return callback(err);

            callback(null, this._getLockPhysicalControls(dp));
        });
    }

    _getLockPhysicalControls(dp) {
        const {Characteristic} = this.hap;

        return dp ? Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED : Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED;
    }

    setLockPhysicalControls(value, callback) {
        const {Characteristic} = this.hap;

        switch (value) {
            case Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED:
                return this.setState(this.dpChildLock, true, callback);

            case Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED:
                return this.setState(this.dpChildLock, false, callback);
        }

        callback();
    }

    getCurrentHeaterCoolerState(callback) {
        this.getState([this.dpActive, this.dpMode], (err, dps) => {
            if (err) return callback(err);

            callback(null, this._getCurrentHeaterCoolerState(dps));
        });
    }

    _getCurrentHeaterCoolerState(dps) {
        const {Characteristic} = this.hap;
        if (!dps[this.dpActive]) return Characteristic.CurrentHeaterCoolerState.INACTIVE;

        switch (dps[this.dpMode]) {
            case this.cmdCool:
                return Characteristic.CurrentHeaterCoolerState.COOLING;

            case this.cmdHeat:
                return Characteristic.CurrentHeaterCoolerState.HEATING;

            default:
                return Characteristic.CurrentHeaterCoolerState.IDLE;
        }
    }

    getTargetHeaterCoolerState(callback) {
        this.getState(this.dpMode, (err, dp) => {
            if (err) return callback(err);

            callback(null, this._getTargetHeaterCoolerState(dp));
        });
    }

    _getTargetHeaterCoolerState(dp) {
        const {Characteristic} = this.hap;

        switch (dp) {
            case this.cmdCool:
                if (this.device.context.noCool) return STATE_OTHER;
                return Characteristic.TargetHeaterCoolerState.COOL;

            case this.cmdHeat:
                if (this.device.context.noHeat) return STATE_OTHER;
                return Characteristic.TargetHeaterCoolerState.HEAT;

            case this.cmdAuto:
                if (this.device.context.noAuto) return STATE_OTHER;
                return Characteristic.TargetHeaterCoolerState.AUTO;

            default:
                return STATE_OTHER;
        }
    }

    setTargetHeaterCoolerState(value, callback) {
        const {Characteristic} = this.hap;

        switch (value) {
            case Characteristic.TargetHeaterCoolerState.COOL:
                if (this.device.context.noCool) return callback();
                return this.setState(this.dpMode, this.cmdCool, callback);

            case Characteristic.TargetHeaterCoolerState.HEAT:
                if (this.device.context.noHeat) return callback();
                return this.setState(this.dpMode, this.cmdHeat, callback);

            case Characteristic.TargetHeaterCoolerState.AUTO:
                if (this.device.context.noAuto) return callback();
                return this.setState(this.dpMode, this.cmdAuto, callback);
        }

        callback();
    }

    getSwingMode(callback) {
        this.getState(this.dpSwingMode, (err, dp) => {
            if (err) return callback(err);

            callback(null, this._getSwingMode(dp));
        });
    }

    _getSwingMode(dp) {
        const {Characteristic} = this.hap;

        return dp ? Characteristic.SwingMode.SWING_ENABLED : Characteristic.SwingMode.SWING_DISABLED;
    }

    setSwingMode(value, callback) {
        if (this.device.context.noSwing) return callback();

        const {Characteristic} = this.hap;

        switch (value) {
            case Characteristic.SwingMode.SWING_ENABLED:
                return this.setState(this.dpSwingMode, true, callback);

            case Characteristic.SwingMode.SWING_DISABLED:
                return this.setState(this.dpSwingMode, false, callback);
        }

        callback();
    }

    // === Пороговые температуры: GET, SET с делителями ===
    getTargetThresholdTemperature(callback) {
        this.getState(this.dpThreshold, (err, raw) => {
            if (err) return callback(err);
            callback(null, this._toHumanTargetTemp(raw));
        });
    }

    setTargetThresholdTemperature(mode, value, callback) {
        const raw = this._fromHumanTargetTemp(value);
        this.setState(this.dpThreshold, raw, err => {
            if (err) return callback(err);

            // синхронизируем вторую характеристику (если включена)
            if (mode === 'cool' && !this.device.context.noHeat && this.characteristicHeatingThresholdTemperature) {
                this.characteristicHeatingThresholdTemperature.updateValue(value);
            } else if (mode === 'heat' && !this.device.context.noCool && this.characteristicCoolingThresholdTemperature) {
                this.characteristicCoolingThresholdTemperature.updateValue(value);
            }

            callback();
        });
    }

    getTemperatureDisplayUnits(callback) {
        this.getState(this.dpTempUnits, (err, dp) => {
            if (err) return callback(err);

            callback(null, this._getTemperatureDisplayUnits(dp));
        });
    }

    _getTemperatureDisplayUnits(dp) {
        const {Characteristic} = this.hap;

        return dp === 'F' ? Characteristic.TemperatureDisplayUnits.FAHRENHEIT : Characteristic.TemperatureDisplayUnits.CELSIUS;
    }

    setTemperatureDisplayUnits(value, callback) {
        const {Characteristic} = this.hap;

        this.setState(this.dpTempUnits, value === Characteristic.TemperatureDisplayUnits.FAHRENHEIT ? 'F' : 'C', callback);
    }

    // === Rotation Speed: поддержка строковых enum и старой числовой схемы ===
    getRotationSpeed(callback) {
        this.getState([this.dpActive, this.dpRotationSpeed], (err, dps) => {
            if (err) return callback(err);

            callback(null, this._getRotationSpeed(dps));
        });
    }

    _getRotationSpeed(dps) {
        if (!dps[this.dpActive]) return 0;

        if (this._hkRotationSpeed) {
            const currFromHK = this.convertRotationSpeedFromHomeKitToTuya(this._hkRotationSpeed);
            return currFromHK === dps[this.dpRotationSpeed]
                ? this._hkRotationSpeed
                : this.convertRotationSpeedFromTuyaToHomeKit(dps[this.dpRotationSpeed]);
        }

        return this._hkRotationSpeed = this.convertRotationSpeedFromTuyaToHomeKit(dps[this.dpRotationSpeed]);
    }

    setRotationSpeed(value, callback) {
        const {Characteristic} = this.hap;

        if (value === 0) {
            this.setActive(Characteristic.Active.INACTIVE, callback);
        } else {
            this._hkRotationSpeed = value;
            const tuyaVal = this.convertRotationSpeedFromHomeKitToTuya(value);
            this.setMultiState({[this.dpActive]: true, [this.dpRotationSpeed]: tuyaVal}, callback);
        }
    }

    convertRotationSpeedFromTuyaToHomeKit(value) {
        // если устройство отдаёт строковый enum
        if (typeof value === 'string' && Object.prototype.hasOwnProperty.call(FAN_TO_PERCENT, value)) {
            return FAN_TO_PERCENT[value];
        }
        // если приходит числовая строка/число — старая логика «ступеней»
        const n = parseInt(value);
        if (Number.isFinite(n) && this._rotationStops && this._rotationStops[n] !== undefined) {
            return this._rotationStops[n];
        }
        // fallback — 0, чтобы не было undefined-ошибки
        return 0;
    }

    convertRotationSpeedFromHomeKitToTuya(value) {
        // если хотим писать строковый enum — используем ближайший
        if (this.device && this.device.context && !this.device.context.forceNumericFan) {
            return percentToFan(value);
        }
        // иначе — старая числовая схема ступеней
        return this.device.context.fanSpeedSteps ? '' + this._rotationSteps[value] : this._rotationSteps[value];
    }
}

module.exports = AirConditionerAccessory;
