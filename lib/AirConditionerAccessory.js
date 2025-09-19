const BaseAccessory = require('./BaseAccessory');

const STATE_OTHER = 9;

// Tuya fan (windspeed / fresh_air) enum -> HomeKit %
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
function nearestEnumByPercent(pct, map = FAN_TO_PERCENT) {
    let bestKey = 'auto', bestDiff = Number.POSITIVE_INFINITY;
    for (const [k, v] of Object.entries(map)) {
        const d = Math.abs(pct - v);
        if (d < bestDiff) { bestDiff = d; bestKey = k; }
    }
    return bestKey;
}

class AirConditionerAccessory extends BaseAccessory {
    static getCategory(Categories) {
        return Categories.AIR_CONDITIONER;
    }

    constructor(...props) {
        super(...props);

        // Режимы: у тебя DP4 = "cold" | "hot" | "auto" | ...
        this.cmdCool = 'cold';
        if (this.device.context.cmdCool) {
            if (/^c[a-z]+$/i.test(this.device.context.cmdCool)) this.cmdCool = ('' + this.device.context.cmdCool).trim();
            else throw new Error('The cmdCool doesn\'t appear to be valid: ' + this.device.context.cmdCool);
        }

        this.cmdHeat = 'hot';
        if (this.device.context.cmdHeat) {
            if (/^h[a-z]+$/i.test(this.device.context.cmdHeat)) this.cmdHeat = ('' + this.device.context.cmdHeat).trim();
            else throw new Error('The cmdHeat doesn\'t appear to be valid: ' + this.device.context.cmdHeat);
        }

        // ВАЖНО: AUTO в твоей модели — "auto" (нижний регистр)
        this.cmdAuto = 'auto';
        if (this.device.context.cmdAuto) {
            if (/^a[a-z]+$/i.test(this.device.context.cmdAuto)) this.cmdAuto = ('' + this.device.context.cmdAuto).trim();
            else throw new Error('The cmdAuto doesn\'t appear to be valid: ' + this.device.context.cmdAuto);
        }

        // НЕ выключаем AUTO насильно:
        // this.device.context.noAuto = true;

        // Числовые ступени вентилятора (совместимость со старой схемой)
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

    // ===== Делители целевой температуры (DP2) =====
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
        const { Service } = this.hap;
        this.accessory.addService(Service.HeaterCooler, this.device.context.name);
        super._registerPlatformAccessory();
    }

    _registerCharacteristics(dps) {
        const { Service, Characteristic } = this.hap;
        const service = this.accessory.getService(Service.HeaterCooler);
        this._checkServiceName(service, this.device.context.name);

        // DPs
        this.dpActive               = this._getCustomDP(this.device.context.dpActive)            || '1';
        this.dpThreshold            = this._getCustomDP(this.device.context.dpThreshold)         || '2';   // target setpoint (scale x10)
        this.dpCurrentTemperature   = this._getCustomDP(this.device.context.dpCurrentTemperature)|| '3';
        this.dpMode                 = this._getCustomDP(this.device.context.dpMode)              || '4';
        this.dpRotationSpeed        = this._getCustomDP(this.device.context.dpRotationSpeed)     || '5';
        this.dpTempUnits            = this._getCustomDP(this.device.context.dpTempUnits)         || '19';  // не у всех есть — ок
        this.dpSwingMode            = this._getCustomDP(this.device.context.dpSwingMode)         || '104'; // у тебя есть 113/114/133 — подключим позже, опционально
        this.dpFreshAir             = this._getCustomDP(this.device.context.dpFreshAir)          || '102'; // fresh_air enum
        this.dpHumidity             = this._getCustomDP(this.device.context.dpHumidity)          || '18';  // humidity_current

        // Active
        const characteristicActive = service.getCharacteristic(Characteristic.Active)
            .updateValue(this._getActive(dps[this.dpActive])) // FIX: раньше подставляли номер DP, а не значение
            .on('get', this.getActive.bind(this))
            .on('set', this.setActive.bind(this));

        // States
        const characteristicCurrentHeaterCoolerState = service.getCharacteristic(Characteristic.CurrentHeaterCoolerState)
            .updateValue(this._getCurrentHeaterCoolerState(dps))
            .on('get', this.getCurrentHeaterCoolerState.bind(this));

        const validStates = [STATE_OTHER];
        if (!this.device.context.noCool) validStates.unshift(Characteristic.TargetHeaterCoolerState.COOL);
        if (!this.device.context.noHeat) validStates.unshift(Characteristic.TargetHeaterCoolerState.HEAT);
        if (!this.device.context.noAuto) validStates.unshift(Characteristic.TargetHeaterCoolerState.AUTO);

        const characteristicTargetHeaterCoolerState = service.getCharacteristic(Characteristic.TargetHeaterCoolerState)
            .setProps({ maxValue: 9, validValues: validStates })
            .updateValue(this._getTargetHeaterCoolerState(dps[this.dpMode]))
            .on('get', this.getTargetHeaterCoolerState.bind(this))
            .on('set', this.setTargetHeaterCoolerState.bind(this));

        // Current temp (DP3 у тебя scale:0 — целые градусы, это норма)
        const characteristicCurrentTemperature = service.getCharacteristic(Characteristic.CurrentTemperature)
            .updateValue(dps[this.dpCurrentTemperature])
            .on('get', this.getState.bind(this, this.dpCurrentTemperature));

        // Cooling/Heating thresholds из DP2 (scale x10)
        let characteristicCoolingThresholdTemperature, characteristicHeatingThresholdTemperature;
        if (!this.device.context.noCool) {
            characteristicCoolingThresholdTemperature = service.getCharacteristic(Characteristic.CoolingThresholdTemperature)
                .setProps({
                    minValue: this.device.context.minTemperature || 10,
                    maxValue: this.device.context.maxTemperature || 35,
                    minStep:  this.device.context.minTemperatureSteps || 1
                })
                .updateValue(this._toHumanTargetTemp(dps[this.dpThreshold]))
                .on('get', this.getTargetThresholdTemperature.bind(this))
                .on('set', this.setTargetThresholdTemperature.bind(this, 'cool'));
        } else this._removeCharacteristic(service, Characteristic.CoolingThresholdTemperature);

        if (!this.device.context.noHeat) {
            characteristicHeatingThresholdTemperature = service.getCharacteristic(Characteristic.HeatingThresholdTemperature)
                .setProps({
                    minValue: this.device.context.minTemperature || 10,
                    maxValue: this.device.context.maxTemperature || 35,
                    minStep:  this.device.context.minTemperatureSteps || 1
                })
                .updateValue(this._toHumanTargetTemp(dps[this.dpThreshold]))
                .on('get', this.getTargetThresholdTemperature.bind(this))
                .on('set', this.setTargetThresholdTemperature.bind(this, 'heat'));
        } else this._removeCharacteristic(service, Characteristic.HeatingThresholdTemperature);

        const characteristicTemperatureDisplayUnits = service.getCharacteristic(Characteristic.TemperatureDisplayUnits)
            .updateValue(this._getTemperatureDisplayUnits(dps[this.dpTempUnits]))
            .on('get', this.getTemperatureDisplayUnits.bind(this))
            .on('set', this.setTemperatureDisplayUnits.bind(this));

        // Rotation Speed (DP5: строковый enum)
        let characteristicRotationSpeed;
        if (!this.device.context.noRotationSpeed) {
            characteristicRotationSpeed = service.getCharacteristic(Characteristic.RotationSpeed)
                .updateValue(this._getRotationSpeed(dps))
                .on('get', this.getRotationSpeed.bind(this))
                .on('set', this.setRotationSpeed.bind(this));
        } else this._removeCharacteristic(service, Characteristic.RotationSpeed);

        // Сохраним ссылки
        this.characteristicCoolingThresholdTemperature  = characteristicCoolingThresholdTemperature;
        this.characteristicHeatingThresholdTemperature  = characteristicHeatingThresholdTemperature;

        // Инициализируем пороги из текущей цели
        const initialRaw = (this.device && this.device.state) ? this.device.state[this.dpThreshold] : undefined;
        const initialT   = this._toHumanTargetTemp(typeof initialRaw === 'number' ? initialRaw : (this.device.context.minTemperature || 16));
        if (characteristicCoolingThresholdTemperature) characteristicCoolingThresholdTemperature.updateValue(initialT);
        if (characteristicHeatingThresholdTemperature) characteristicHeatingThresholdTemperature.updateValue(initialT);

        // === (Опционально) Влажность как отдельный сервис ===
        let humidityService;
        if (!this.device.context.noHumiditySensor) {
            humidityService = this.accessory.getService(Service.HumiditySensor) ||
                              this.accessory.addService(Service.HumiditySensor, `${this.device.context.name} Humidity`);
            humidityService.getCharacteristic(Characteristic.CurrentRelativeHumidity)
                .updateValue(dps[this.dpHumidity])
                .on('get', this.getState.bind(this, this.dpHumidity));
        }

        // === Приточка / "fresh_air" (DP102) как Fanv2 ===
        let freshAirService;
        if (!this.device.context.noFreshAir) {
            freshAirService = this.accessory.getService('FreshAir') ||
                              this.accessory.addService(Service.Fanv2, `${this.device.context.name} Fresh Air`, 'FreshAir');

            // Active: любое, кроме "off", считаем ВКЛ
            freshAirService.getCharacteristic(Characteristic.Active)
                .updateValue(this._freshAirActive(dps[this.dpFreshAir]))
                .on('get', this.getFreshAirActive.bind(this))
                .on('set', this.setFreshAirActive.bind(this));

            // Скорость: маппинг enum -> %
            freshAirService.getCharacteristic(Characteristic.RotationSpeed)
                .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
                .updateValue(this._freshAirToPercent(dps[this.dpFreshAir]))
                .on('get', this.getFreshAirSpeed.bind(this))
                .on('set', this.setFreshAirSpeed.bind(this));
        }

        // === Подписка на изменения DP ===
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

            if (changes.hasOwnProperty(this.dpThreshold)) {
                const humanT = this._toHumanTargetTemp(changes[this.dpThreshold]);
                if (!this.device.context.noCool  && this.characteristicCoolingThresholdTemperature  && this.characteristicCoolingThresholdTemperature.value  !== humanT)
                    this.characteristicCoolingThresholdTemperature.updateValue(humanT);
                if (!this.device.context.noHeat  && this.characteristicHeatingThresholdTemperature  && this.characteristicHeatingThresholdTemperature.value !== humanT)
                    this.characteristicHeatingThresholdTemperature.updateValue(humanT);
            }

            if (changes.hasOwnProperty(this.dpCurrentTemperature) && characteristicCurrentTemperature.value !== changes[this.dpCurrentTemperature]) {
                characteristicCurrentTemperature.updateValue(changes[this.dpCurrentTemperature]);
            }

            if (changes.hasOwnProperty(this.dpMode)) {
                const newTarget = this._getTargetHeaterCoolerState(changes[this.dpMode]);
                const newCurrent = this._getCurrentHeaterCoolerState(state);
                if (characteristicTargetHeaterCoolerState.value !== newTarget) characteristicTargetHeaterCoolerState.updateValue(newTarget);
                if (characteristicCurrentHeaterCoolerState.value !== newCurrent) characteristicCurrentHeaterCoolerState.updateValue(newCurrent);
            }

            if (characteristicRotationSpeed && changes.hasOwnProperty(this.dpRotationSpeed)) {
                const newRotationSpeed = this._getRotationSpeed(state);
                if (characteristicRotationSpeed.value !== newRotationSpeed) characteristicRotationSpeed.updateValue(newRotationSpeed);
                if (!changes.hasOwnProperty(this.dpMode)) {
                    characteristicCurrentHeaterCoolerState.updateValue(this._getCurrentHeaterCoolerState(state));
                }
            }

            if (humidityService && changes.hasOwnProperty(this.dpHumidity)) {
                humidityService.getCharacteristic(Characteristic.CurrentRelativeHumidity).updateValue(changes[this.dpHumidity]);
            }

            if (freshAirService && changes.hasOwnProperty(this.dpFreshAir)) {
                const on = this._freshAirActive(changes[this.dpFreshAir]);
                const pct = this._freshAirToPercent(changes[this.dpFreshAir]);
                freshAirService.getCharacteristic(Characteristic.Active).updateValue(on);
                freshAirService.getCharacteristic(Characteristic.RotationSpeed).updateValue(pct);
            }
        });
    }

    // ===== Active =====
    getActive(callback) {
        this.getState(this.dpActive, (err, dp) => {
            if (err) return callback(err);
            callback(null, this._getActive(dp));
        });
    }
    _getActive(dp) {
        const { Characteristic } = this.hap;
        return dp ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE;
    }
    setActive(value, callback) {
        const { Characteristic } = this.hap;
        switch (value) {
            case Characteristic.Active.ACTIVE:   return this.setState(this.dpActive, true, callback);
            case Characteristic.Active.INACTIVE: return this.setState(this.dpActive, false, callback);
        }
        callback();
    }

    // ===== Heater/Cooler States =====
    getCurrentHeaterCoolerState(callback) {
        this.getState([this.dpActive, this.dpMode], (err, dps) => {
            if (err) return callback(err);
            callback(null, this._getCurrentHeaterCoolerState(dps));
        });
    }
    _getCurrentHeaterCoolerState(dps) {
        const { Characteristic } = this.hap;
        if (!dps[this.dpActive]) return Characteristic.CurrentHeaterCoolerState.INACTIVE;
        switch (dps[this.dpMode]) {
            case this.cmdCool: return Characteristic.CurrentHeaterCoolerState.COOLING;
            case this.cmdHeat: return Characteristic.CurrentHeaterCoolerState.HEATING;
            case this.cmdAuto: return Characteristic.CurrentHeaterCoolerState.IDLE; // в AUTO считаем «включен, но не греет/не холодит»
            default:           return Characteristic.CurrentHeaterCoolerState.IDLE;
        }
    }
    getTargetHeaterCoolerState(callback) {
        this.getState(this.dpMode, (err, dp) => {
            if (err) return callback(err);
            callback(null, this._getTargetHeaterCoolerState(dp));
        });
    }
    _getTargetHeaterCoolerState(dp) {
        const { Characteristic } = this.hap;
        switch (dp) {
            case this.cmdCool: if (this.device.context.noCool) return STATE_OTHER; return Characteristic.TargetHeaterCoolerState.COOL;
            case this.cmdHeat: if (this.device.context.noHeat) return STATE_OTHER; return Characteristic.TargetHeaterCoolerState.HEAT;
            case this.cmdAuto: if (this.device.context.noAuto) return STATE_OTHER; return Characteristic.TargetHeaterCoolerState.AUTO;
            default: return STATE_OTHER;
        }
    }
    setTargetHeaterCoolerState(value, callback) {
        const { Characteristic } = this.hap;
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

    // ===== Температура (DP2) =====
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
            if (mode === 'cool' && !this.device.context.noHeat && this.characteristicHeatingThresholdTemperature) {
                this.characteristicHeatingThresholdTemperature.updateValue(value);
            } else if (mode === 'heat' && !this.device.context.noCool && this.characteristicCoolingThresholdTemperature) {
                this.characteristicCoolingThresholdTemperature.updateValue(value);
            }
            callback();
        });
    }

    // ===== Единицы измерения =====
    getTemperatureDisplayUnits(callback) {
        this.getState(this.dpTempUnits, (err, dp) => {
            if (err) return callback(err);
            callback(null, this._getTemperatureDisplayUnits(dp));
        });
    }
    _getTemperatureDisplayUnits(dp) {
        const { Characteristic } = this.hap;
        return dp === 'F' ? Characteristic.TemperatureDisplayUnits.FAHRENHEIT : Characteristic.TemperatureDisplayUnits.CELSIUS;
    }
    setTemperatureDisplayUnits(value, callback) {
        const { Characteristic } = this.hap;
        // если у девайса нет dpTempUnits, это просто проигнорируется устройством — ок
        this.setState(this.dpTempUnits, value === Characteristic.TemperatureDisplayUnits.FAHRENHEIT ? 'F' : 'C', callback);
    }

    // ===== Вентилятор кондиционера (DP5) =====
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
        const { Characteristic } = this.hap;
        if (value === 0) {
            this.setActive(Characteristic.Active.INACTIVE, callback);
        } else {
            this._hkRotationSpeed = value;
            const tuyaVal = this.convertRotationSpeedFromHomeKitToTuya(value);
            this.setMultiState({ [this.dpActive]: true, [this.dpRotationSpeed]: tuyaVal }, callback);
        }
    }
    convertRotationSpeedFromTuyaToHomeKit(value) {
        if (typeof value === 'string' && Object.prototype.hasOwnProperty.call(FAN_TO_PERCENT, value)) {
            return FAN_TO_PERCENT[value];
        }
        const n = parseInt(value);
        if (Number.isFinite(n) && this._rotationStops && this._rotationStops[n] !== undefined) {
            return this._rotationStops[n];
        }
        return 0;
    }
    convertRotationSpeedFromHomeKitToTuya(value) {
        if (this.device && this.device.context && !this.device.context.forceNumericFan) {
            return nearestEnumByPercent(value);
        }
        return this.device.context.fanSpeedSteps ? '' + this._rotationSteps[value] : this._rotationSteps[value];
    }

    // ===== Fresh Air (DP102) как Fanv2 =====
    _freshAirActive(dp) {
        const { Characteristic } = this.hap;
        return (dp && dp !== 'off') ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE;
    }
    _freshAirToPercent(dp) {
        if (typeof dp === 'string' && Object.prototype.hasOwnProperty.call(FAN_TO_PERCENT, dp)) {
            return FAN_TO_PERCENT[dp];
        }
        return 0;
    }
    _percentToFreshAir(pct) {
        // 0 = auto для удобства (можно сменить на 'off' если выключено)
        if (pct <= 1) return 'auto';
        return nearestEnumByPercent(pct);
    }
    getFreshAirActive(callback) {
        this.getState(this.dpFreshAir, (err, dp) => {
            if (err) return callback(err);
            callback(null, this._freshAirActive(dp));
        });
    }
    setFreshAirActive(value, callback) {
        const { Characteristic } = this.hap;
        const tuya = (value === Characteristic.Active.ACTIVE) ? 'auto' : 'off';
        this.setState(this.dpFreshAir, tuya, callback);
    }
    getFreshAirSpeed(callback) {
        this.getState(this.dpFreshAir, (err, dp) => {
            if (err) return callback(err);
            callback(null, this._freshAirToPercent(dp));
        });
    }
    setFreshAirSpeed(value, callback) {
        const tuya = this._percentToFreshAir(value);
        this.setState(this.dpFreshAir, tuya, callback);
    }
}

module.exports = AirConditionerAccessory;
