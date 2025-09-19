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

    // === Режимы твоей модели (DP4): "cold" | "hot" | "auto" | (ещё "wet","wind")
    this.cmdCool = (this.device.context.cmdCool && /^c[a-z]+$/i.test(this.device.context.cmdCool))
      ? ('' + this.device.context.cmdCool).trim() : 'cold';

    this.cmdHeat = (this.device.context.cmdHeat && /^h[a-z]+$/i.test(this.device.context.cmdHeat))
      ? ('' + this.device.context.cmdHeat).trim() : 'hot';

    this.cmdAuto = (this.device.context.cmdAuto && /^a[a-z]+$/i.test(this.device.context.cmdAuto))
      ? ('' + this.device.context.cmdAuto).trim() : 'auto';

    // Включаем одиночный сетпоинт (для HeaterCooler); для Thermostat он и так один
    if (typeof this.device.context.singleSetpoint === 'undefined') {
      this.device.context.singleSetpoint = true;
    }

    // Выбор UI: Thermostat даёт однокругляш и AUTO в UI iOS гарантированно
    this.useThermostatUI = !!this.device.context.useThermostatUI;

    // Числовые ступени вентилятора (совместимость)
    if (!this.device.context.noRotationSpeed) {
      const fanSpeedSteps = (this.device.context.fanSpeedSteps && isFinite(this.device.context.fanSpeedSteps) && this.device.context.fanSpeedSteps > 0 && this.device.context.fanSpeedSteps < 100) ? this.device.context.fanSpeedSteps : 100;
      this._rotationSteps = [0];
      this._rotationStops = { 0: 0 };
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
    if (this.useThermostatUI) {
      this.accessory.addService(Service.Thermostat, this.device.context.name);
    } else {
      this.accessory.addService(Service.HeaterCooler, this.device.context.name);
    }
    super._registerPlatformAccessory();
  }

  _registerCharacteristics(dps) {
    const { Service, Characteristic } = this.hap;

    // DPs (твои реальные)
    this.dpActive               = this._getCustomDP(this.device.context.dpActive)             || '1';
    this.dpThreshold            = this._getCustomDP(this.device.context.dpThreshold)          || '2';   // target setpoint (scale x10)
    this.dpCurrentTemperature   = this._getCustomDP(this.device.context.dpCurrentTemperature) || '3';
    this.dpMode                 = this._getCustomDP(this.device.context.dpMode)               || '4';
    this.dpRotationSpeed        = this._getCustomDP(this.device.context.dpRotationSpeed)      || '5';
    this.dpTempUnits            = this._getCustomDP(this.device.context.dpTempUnits)          || '19';  // может не быть — ок
    this.dpFreshAir             = this._getCustomDP(this.device.context.dpFreshAir)           || '102'; // fresh_air enum: auto/low/mid/strong/off
    this.dpHumidity             = this._getCustomDP(this.device.context.dpHumidity)           || '18';  // humidity_current

    if (this.useThermostatUI) {
      // ==========================
      //         THERMOSTAT
      // ==========================
      const service = this.accessory.getService(Service.Thermostat);
      this._checkServiceName(service, this.device.context.name);

      // CurrentTemperature (DP3, целые градусы — норма)
      service.getCharacteristic(Characteristic.CurrentTemperature)
        .updateValue(dps[this.dpCurrentTemperature])
        .on('get', this.getState.bind(this, this.dpCurrentTemperature));

      // TargetTemperature — ОДИН кругляш (все режимы пишут в DP2)
      service.getCharacteristic(Characteristic.TargetTemperature)
        .setProps({
          minValue: this.device.context.minTemperature || 10,
          maxValue: this.device.context.maxTemperature || 35,
          minStep:  this.device.context.minTemperatureSteps || 0.5
        })
        .updateValue(this._toHumanTargetTemp(dps[this.dpThreshold]))
        .on('get', (cb) => this.getState(this.dpThreshold, (e, raw) => cb(e, e ? undefined : this._toHumanTargetTemp(raw))))
        .on('set', (value, cb) => {
          const raw = this._fromHumanTargetTemp(value);
          this.setState(this.dpThreshold, raw, (err) => {
            if (!err) service.getCharacteristic(Characteristic.TargetTemperature).updateValue(value);
            cb(err);
          });
        });

      // TargetHeatingCoolingState ↔ dpActive/dpMode
      // 0=Off, 1=Heat, 2=Cool, 3=Auto
      service.getCharacteristic(Characteristic.TargetHeatingCoolingState)
        .setProps({ validValues: [0,1,2,3] })
        .updateValue(this._hkTargetFromDps(dps))
        .on('get', (cb) => this.getState([this.dpActive, this.dpMode], (e, st) => cb(e, e ? undefined : this._hkTargetFromDps(st))))
        .on('set', (value, cb) => {
          const ops = {};
          if (value === Characteristic.TargetHeatingCoolingState.OFF) {
            ops[this.dpActive] = false;
          } else {
            ops[this.dpActive] = true;
            if (value === Characteristic.TargetHeatingCoolingState.COOL) ops[this.dpMode] = this.cmdCool;
            if (value === Characteristic.TargetHeatingCoolingState.HEAT) ops[this.dpMode] = this.cmdHeat;
            if (value === Characteristic.TargetHeatingCoolingState.AUTO) ops[this.dpMode] = this.cmdAuto;
          }
          this.setMultiState(ops, cb);
        });

      // CurrentHeatingCoolingState (для UI)
      service.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
        .updateValue(this._hkCurrentFromDps(dps))
        .on('get', (cb) => this.getState([this.dpActive, this.dpMode], (e, st) => cb(e, e ? undefined : this._hkCurrentFromDps(st))));

      // TemperatureDisplayUnits (если DP есть)
      service.getCharacteristic(Characteristic.TemperatureDisplayUnits)
        .updateValue(this._getTemperatureDisplayUnits(dps[this.dpTempUnits]))
        .on('get', this.getTemperatureDisplayUnits.bind(this))
        .on('set', this.setTemperatureDisplayUnits.bind(this));

      // Fan speed кондиционера (DP5) — как отдельная характеристика не у Thermostat,
      // поэтому добавим отдельный Fanv2 «AC Fan» (необязательно, можно отключить через noRotationSpeed)
      if (!this.device.context.noRotationSpeed) {
        const acFan = this.accessory.getService('AC Fan') ||
          this.accessory.addService(Service.Fanv2, `${this.device.context.name} Fan`, 'ACFan');
        acFan.getCharacteristic(Characteristic.Active)
          .updateValue(dps[this.dpActive] ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE)
          .on('get', (cb)=> this.getState(this.dpActive, (e, v)=> cb(e, e?undefined:(v?Characteristic.Active.ACTIVE:Characteristic.Active.INACTIVE))))
          .on('set', (v, cb)=> this.setState(this.dpActive, v === Characteristic.Active.ACTIVE, cb));
        acFan.getCharacteristic(Characteristic.RotationSpeed)
          .setProps({ minValue:0, maxValue:100, minStep:1 })
          .updateValue(this._rsGetPercent(dps))
          .on('get', (cb)=> this.getState([this.dpActive, this.dpRotationSpeed], (e, st)=> cb(e, e?undefined:this._rsGetPercent(st))))
          .on('set', (val, cb)=> this._rsSetPercent(val, cb));
      }

      // (опц.) датчик влажности
      if (!this.device.context.noHumiditySensor) {
        const hum = this.accessory.getService(Service.HumiditySensor)
          || this.accessory.addService(Service.HumiditySensor, `${this.device.context.name} Humidity`);
        hum.getCharacteristic(Characteristic.CurrentRelativeHumidity)
          .updateValue(dps[this.dpHumidity])
          .on('get', this.getState.bind(this, this.dpHumidity));
      }

      // Приточка как отдельный Fanv2
      this._setupFreshAirFan();

      // Подписка на изменения
      this.device.on('change', (changes, state) => {
        if (changes.hasOwnProperty(this.dpCurrentTemperature)) {
          service.getCharacteristic(Characteristic.CurrentTemperature).updateValue(changes[this.dpCurrentTemperature]);
        }
        if (changes.hasOwnProperty(this.dpThreshold)) {
          service.getCharacteristic(Characteristic.TargetTemperature).updateValue(this._toHumanTargetTemp(changes[this.dpThreshold]));
        }
        if (changes.hasOwnProperty(this.dpActive) || changes.hasOwnProperty(this.dpMode)) {
          service.getCharacteristic(Characteristic.TargetHeatingCoolingState).updateValue(this._hkTargetFromDps(state));
          service.getCharacteristic(Characteristic.CurrentHeatingCoolingState).updateValue(this._hkCurrentFromDps(state));
        }
      });

    } else {
      // ==========================
      //       HEATER COOLER
      // ==========================
      const service = this.accessory.getService(Service.HeaterCooler);
      this._checkServiceName(service, this.device.context.name);

      const characteristicActive = service.getCharacteristic(Characteristic.Active)
        .updateValue(this._getActive(dps[this.dpActive]))
        .on('get', this.getActive.bind(this))
        .on('set', this.setActive.bind(this));

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

      const characteristicCurrentTemperature = service.getCharacteristic(Characteristic.CurrentTemperature)
        .updateValue(dps[this.dpCurrentTemperature])
        .on('get', this.getState.bind(this, this.dpCurrentTemperature));

      // ЕДИНСТВЕННЫЙ сетпоинт => оставляем только CoolingThreshold
      const characteristicCoolingThresholdTemperature = service.getCharacteristic(Characteristic.CoolingThresholdTemperature)
        .setProps({
          minValue: this.device.context.minTemperature || 10,
          maxValue: this.device.context.maxTemperature || 35,
          minStep:  this.device.context.minTemperatureSteps || 0.5
        })
        .updateValue(this._toHumanTargetTemp(dps[this.dpThreshold]))
        .on('get', this.getTargetThresholdTemperature.bind(this))
        .on('set', this.setTargetThresholdTemperatureSingle.bind(this));
      this._removeCharacteristic(service, Characteristic.HeatingThresholdTemperature);

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

      // (опц.) влажность
      if (!this.device.context.noHumiditySensor) {
        const hum = this.accessory.getService(Service.HumiditySensor)
          || this.accessory.addService(Service.HumiditySensor, `${this.device.context.name} Humidity`);
        hum.getCharacteristic(Characteristic.CurrentRelativeHumidity)
          .updateValue(dps[this.dpHumidity])
          .on('get', this.getState.bind(this, this.dpHumidity));
      }

      // Приточка как Fanv2
      this._setupFreshAirFan();

      // Изменения
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
          if (this.characteristicCoolingThresholdTemperature &&
              this.characteristicCoolingThresholdTemperature.value !== humanT) {
            this.characteristicCoolingThresholdTemperature.updateValue(humanT);
          }
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
      });
    }
  }

  // ===== Вспомогательные маппинги для THERMOSTAT =====
  _hkTargetFromDps(dps) {
    const { Characteristic } = this.hap;
    if (!dps[this.dpActive]) return Characteristic.TargetHeatingCoolingState.OFF;
    switch (dps[this.dpMode]) {
      case this.cmdCool: return Characteristic.TargetHeatingCoolingState.COOL;
      case this.cmdHeat: return Characteristic.TargetHeatingCoolingState.HEAT;
      case this.cmdAuto: return Characteristic.TargetHeatingCoolingState.AUTO;
      default:           return Characteristic.TargetHeatingCoolingState.AUTO;
    }
  }
  _hkCurrentFromDps(dps) {
    const { Characteristic } = this.hap;
    if (!dps[this.dpActive]) return Characteristic.CurrentHeatingCoolingState.OFF;
    switch (dps[this.dpMode]) {
      case this.cmdCool: return Characteristic.CurrentHeatingCoolingState.COOL;
      case this.cmdHeat: return Characteristic.CurrentHeatingCoolingState.HEAT;
      case this.cmdAuto: return Characteristic.CurrentHeatingCoolingState.IDLE;
      default:           return Characteristic.CurrentHeatingCoolingState.IDLE;
    }
  }

  // ===== Active (HeaterCooler) =====
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

  // ===== HeaterCooler States =====
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
      case this.cmdAuto: return Characteristic.CurrentHeaterCoolerState.IDLE;
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
      case this.cmdCool: return this.device.context.noCool ? STATE_OTHER : Characteristic.TargetHeaterCoolerState.COOL;
      case this.cmdHeat: return this.device.context.noHeat ? STATE_OTHER : Characteristic.TargetHeaterCoolerState.HEAT;
      case this.cmdAuto: return this.device.context.noAuto ? STATE_OTHER : Characteristic.TargetHeaterCoolerState.AUTO;
      default:           return STATE_OTHER;
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

  // ===== Target Temperature (единый сетпоинт) =====
  getTargetThresholdTemperature(callback) {
    this.getState(this.dpThreshold, (err, raw) => {
      if (err) return callback(err);
      callback(null, this._toHumanTargetTemp(raw));
    });
  }
  setTargetThresholdTemperatureSingle(value, callback) {
    const raw = this._fromHumanTargetTemp(value);
    this.setState(this.dpThreshold, raw, err => {
      if (!err && this.characteristicCoolingThresholdTemperature) {
        this.characteristicCoolingThresholdTemperature.updateValue(value);
      }
      callback(err);
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
    this.setState(this.dpTempUnits, value === Characteristic.TemperatureDisplayUnits.FAHRENHEIT ? 'F' : 'C', callback);
  }

  // ===== Вентилятор кондиционера (DP5) =====
  _rsGetPercent(dps) {
    if (!dps[this.dpActive]) return 0;
    const val = dps[this.dpRotationSpeed];
    if (typeof val === 'string' && Object.prototype.hasOwnProperty.call(FAN_TO_PERCENT, val)) {
      return FAN_TO_PERCENT[val];
    }
    const n = parseInt(val);
    if (Number.isFinite(n) && this._rotationStops && this._rotationStops[n] !== undefined) return this._rotationStops[n];
    return 0;
  }
  _rsSetPercent(value, callback) {
    if (value === 0) return this.setState(this.dpActive, false, callback);
    const tuyaVal = (this.device && this.device.context && !this.device.context.forceNumericFan)
      ? nearestEnumByPercent(value)
      : (this.device.context.fanSpeedSteps ? '' + this._rotationSteps[value] : this._rotationSteps[value]);
    this.setMultiState({ [this.dpActive]: true, [this.dpRotationSpeed]: tuyaVal }, callback);
  }
  getRotationSpeed(callback) {
    this.getState([this.dpActive, this.dpRotationSpeed], (err, dps) => {
      if (err) return callback(err);
      callback(null, this._rsGetPercent(dps));
    });
  }
  setRotationSpeed(value, callback) { this._rsSetPercent(value, callback); }

  // ===== Fresh Air (DP102) как Fanv2 =====
  _setupFreshAirFan() {
    const { Service, Characteristic } = this.hap;
    if (this.device.context.noFreshAir) return;
    const name = `${this.device.context.name} Fresh Air`;
    const freshAirService = this.accessory.getService('FreshAir') ||
      this.accessory.addService(Service.Fanv2, name, 'FreshAir');
    // Active: любое, кроме "off", считаем ВКЛ
    freshAirService.getCharacteristic(Characteristic.Active)
      .on('get', (cb) => this.getState(this.dpFreshAir, (e, dp) => {
        if (e) return cb(e);
        cb(null, (dp && dp !== 'off') ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE);
      }))
      .on('set', (v, cb) => {
        const tuya = (v === Characteristic.Active.ACTIVE) ? 'auto' : 'off';
        this.setState(this.dpFreshAir, tuya, cb);
      });
    freshAirService.getCharacteristic(Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      .on('get', (cb) => this.getState(this.dpFreshAir, (e, dp) => {
        if (e) return cb(e);
        const pct = (typeof dp === 'string' && Object.prototype.hasOwnProperty.call(FAN_TO_PERCENT, dp)) ? FAN_TO_PERCENT[dp] : 0;
        cb(null, pct);
      }))
      .on('set', (val, cb) => {
        const tuya = (val <= 1) ? 'auto' : nearestEnumByPercent(val);
        this.setState(this.dpFreshAir, tuya, cb);
      });
  }
}

module.exports = AirConditionerAccessory;
