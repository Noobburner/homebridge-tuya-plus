const BaseAccessory = require('./BaseAccessory');

const STATE_OTHER = 9;

// Tuya enum -> %
const FAN_TO_PERCENT = {
  auto: 0,
  mute: 10,
  low: 33,
  mid_low: 40,
  mid: 66,
  mid_high: 70,
  high: 100,
  strong: 100,
};
function nearestEnumByPercent(pct) {
  if (pct <= 33) return 'low';
  if (pct <= 66) return 'mid';
  return 'strong';
}

class AirConditionerAccessory extends BaseAccessory {
  static getCategory(Categories) {
    return Categories.AIR_CONDITIONER;
  }

  constructor(...props) {
    super(...props);

    this.cmdCool = (this.device.context.cmdCool && /^c[a-z]+$/i.test(this.device.context.cmdCool))
      ? ('' + this.device.context.cmdCool).trim() : 'cold';
    this.cmdHeat = (this.device.context.cmdHeat && /^h[a-z]+$/i.test(this.device.context.cmdHeat))
      ? ('' + this.device.context.cmdHeat).trim() : 'hot';
    this.cmdAuto = (this.device.context.cmdAuto && /^a[a-z]+$/i.test(this.device.context.cmdAuto))
      ? ('' + this.device.context.cmdAuto).trim() : 'auto';

    if (typeof this.device.context.singleSetpoint === 'undefined') {
      this.device.context.singleSetpoint = true;
    }
    this.useThermostatUI = !!this.device.context.useThermostatUI;

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

  // ==== Температура (DP2) со scale х10 ====
  _getTargetTempDivisor() {
    return this.device.context.targetTemperatureDivisor || this.device.context.temperatureDivisor || 1;
  }
  _toHumanTargetTemp(raw) {
    const d = this._getTargetTempDivisor();
    return (typeof raw === 'number') ? (raw / d) : (Number.isFinite(+raw) ? (+raw / d) : 0);
  }
  _fromHumanTargetTemp(human) {
    const d = this._getTargetTempDivisor();
    return (typeof human === 'number') ? Math.round(human * d) : Math.round((+human) * d);
  }

  _registerPlatformAccessory() {
    const { Service, Characteristic } = this.hap;

    if (this.useThermostatUI) {
      const s = this.accessory.getService(Service.Thermostat) ||
        this.accessory.addService(Service.Thermostat, this.device.context.name);
      s.setCharacteristic(Characteristic.ConfiguredName, this.device.context.name);
      s.setPrimaryService(true);
    } else {
      const s = this.accessory.getService(Service.HeaterCooler) ||
        this.accessory.addService(Service.HeaterCooler, this.device.context.name);
      s.setCharacteristic(Characteristic.ConfiguredName, this.device.context.name);
      s.setPrimaryService(true);
    }

    super._registerPlatformAccessory();
  }

  _registerCharacteristics(dps) {
    const { Service, Characteristic } = this.hap;

    // DPs
    this.dpActive               = this._getCustomDP(this.device.context.dpActive)             || '1';
    this.dpThreshold            = this._getCustomDP(this.device.context.dpThreshold)          || '2';
    this.dpCurrentTemperature   = this._getCustomDP(this.device.context.dpCurrentTemperature) || '3';
    this.dpMode                 = this._getCustomDP(this.device.context.dpMode)               || '4';
    this.dpRotationSpeed        = this._getCustomDP(this.device.context.dpRotationSpeed)      || '5';
    this.dpTempUnits            = this._getCustomDP(this.device.context.dpTempUnits)          || '19';
    this.dpFreshAir             = this._getCustomDP(this.device.context.dpFreshAir)           || '102';
    this.dpHumidity             = this._getCustomDP(this.device.context.dpHumidity)           || '18';

    // ===== Thermostat UI =====
    if (this.useThermostatUI) {
      const service = this.accessory.getService(Service.Thermostat);
      this._checkServiceName(service, this.device.context.name);

      service.getCharacteristic(Characteristic.CurrentTemperature)
        .updateValue(Number.isFinite(+dps[this.dpCurrentTemperature]) ? +dps[this.dpCurrentTemperature] : 0)
        .on('get', this.getState.bind(this, this.dpCurrentTemperature));

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

      service.getCharacteristic(Characteristic.TargetHeatingCoolingState)
        .setProps({ validValues: [
          Characteristic.TargetHeatingCoolingState.OFF,
          Characteristic.TargetHeatingCoolingState.HEAT,
          Characteristic.TargetHeatingCoolingState.COOL,
          Characteristic.TargetHeatingCoolingState.AUTO
        ] })
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

      service.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
        .updateValue(this._hkCurrentFromDps(dps))
        .on('get', (cb) => this.getState([this.dpActive, this.dpMode], (e, st) => cb(e, e ? undefined : this._hkCurrentFromDps(st))));

      service.getCharacteristic(Characteristic.TemperatureDisplayUnits)
        .updateValue(this._getTemperatureDisplayUnits(dps[this.dpTempUnits]))
        .on('get', this.getTemperatureDisplayUnits.bind(this))
        .on('set', this.setTemperatureDisplayUnits.bind(this));

      // Вентилятор кондиционера
      if (!this.device.context.hideIndoorFan && !this.device.context.noRotationSpeed) {
        let acFan = this.accessory.getService('ACFan');
        if (!acFan) {
          const fanName = this.device.context.indoorFanName || `${this.device.context.name} — Вентилятор`;
          acFan = this.accessory.addService(Service.Fanv2, fanName, 'ACFan');
        }
        acFan.setCharacteristic(Characteristic.ConfiguredName, this.device.context.indoorFanName || `${this.device.context.name} — Вентилятор`);
        acFan.setPrimaryService(false);
        this.accessory.addLinkedService(acFan);

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

      // Приточка
      if (this.device.context.freshAirAsSwitches) {
        this._setupFreshAirAsSwitches();
      } else {
        this._setupFreshAirFanSegmented();
      }

      this.device.on('change', (changes, state) => {
        try {
          if (changes.hasOwnProperty(this.dpCurrentTemperature)) {
            service.getCharacteristic(Characteristic.CurrentTemperature).updateValue(Number.isFinite(+changes[this.dpCurrentTemperature]) ? +changes[this.dpCurrentTemperature] : 0);
          }
          if (changes.hasOwnProperty(this.dpThreshold)) {
            service.getCharacteristic(Characteristic.TargetTemperature).updateValue(this._toHumanTargetTemp(changes[this.dpThreshold]));
          }
          if (changes.hasOwnProperty(this.dpActive) || changes.hasOwnProperty(this.dpMode)) {
            service.getCharacteristic(Characteristic.TargetHeatingCoolingState).updateValue(this._hkTargetFromDps(state));
            service.getCharacteristic(Characteristic.CurrentHeatingCoolingState).updateValue(this._hkCurrentFromDps(state));
          }
        } catch (e) {
          this.log.warn('[Thermostat] change handler error: %s', e.message);
        }
      });

    // ===== HeaterCooler UI =====
    } else {
      const service = this.accessory.getService(this.hap.Service.HeaterCooler);
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
        .updateValue(Number.isFinite(+dps[this.dpCurrentTemperature]) ? +dps[this.dpCurrentTemperature] : 0)
        .on('get', this.getState.bind(this, this.dpCurrentTemperature));

      const characteristicCoolingThresholdTemperature = service.getCharacteristic(Characteristic.CoolingThresholdTemperature)
        .setProps({
          minValue: this.device.context.minTemperature || 10,
          maxValue: this.device.context.maxTemperature || 35,
          minStep:  this.device.context.minTemperatureSteps || 0.5
        })
        .updateValue(this._toHumanTargetTemp(dps[this.dpThreshold]))
        .on('get', this.getTargetThresholdTemperature.bind(this))
        .on('set', this.setTargetThresholdTemperatureSingle.bind(this));
      this._removeCharacteristic(service, this.hap.Characteristic.HeatingThresholdTemperature);
      this.characteristicCoolingThresholdTemperature = characteristicCoolingThresholdTemperature;

      service.getCharacteristic(Characteristic.TemperatureDisplayUnits)
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

      if (!this.device.context.noHumiditySensor) {
        const hum = this.accessory.getService(Service.HumiditySensor)
          || this.accessory.addService(Service.HumiditySensor, `${this.device.context.name} Humidity`);
        hum.setPrimaryService(false);
        hum.getCharacteristic(Characteristic.CurrentRelativeHumidity)
          .updateValue(Number.isFinite(+dps[this.dpHumidity]) ? +dps[this.dpHumidity] : 0)
          .on('get', this.getState.bind(this, this.dpHumidity));
      }

      if (this.device.context.freshAirAsSwitches) {
        this._setupFreshAirAsSwitches();
      } else {
        this._setupFreshAirFanSegmented();
      }

      this.device.on('change', (changes, state) => {
        try {
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
            characteristicCurrentTemperature.updateValue(Number.isFinite(+changes[this.dpCurrentTemperature]) ? +changes[this.dpCurrentTemperature] : 0);
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
        } catch (e) {
          this.log.warn('[HeaterCooler] change handler error: %s', e.message);
        }
      });
    }
  }

  // ==== Thermostat mapping with guards ====
  _hkTargetFromDps(dps) {
    const { Characteristic } = this.hap;
    if (!dps || typeof dps !== 'object') return Characteristic.TargetHeatingCoolingState.OFF;
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
    if (!dps || typeof dps !== 'object') return Characteristic.CurrentHeatingCoolingState.OFF;
    if (!dps[this.dpActive]) return Characteristic.CurrentHeatingCoolingState.OFF;

    if (dps[this.dpMode] === this.cmdCool) return Characteristic.CurrentHeatingCoolingState.COOL;
    if (dps[this.dpMode] === this.cmdHeat) return Characteristic.CurrentHeatingCoolingState.HEAT;

    if (dps[this.dpMode] === this.cmdAuto) {
      const curr = Number(dps[this.dpCurrentTemperature]);
      const tgtHuman = this._toHumanTargetTemp(dps[this.dpThreshold]);
      if (Number.isFinite(curr) && Number.isFinite(tgtHuman)) {
        const hysteresis = 0.3;
        if (curr > tgtHuman + hysteresis) return Characteristic.CurrentHeatingCoolingState.COOL;
        if (curr < tgtHuman - hysteresis) return Characteristic.CurrentHeatingCoolingState.HEAT;
      }
      return Characteristic.CurrentHeatingCoolingState.OFF;
    }
    return Characteristic.CurrentHeatingCoolingState.OFF;
  }

  // ====== HeaterCooler helpers ======
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
    if (value === Characteristic.Active.ACTIVE) return this.setState(this.dpActive, true, callback);
    if (value === Characteristic.Active.INACTIVE) return this.setState(this.dpActive, false, callback);
    callback();
  }

  getCurrentHeaterCoolerState(callback) {
    this.getState([this.dpActive, this.dpMode], (err, dps) => {
      if (err) return callback(err);
      callback(null, this._getCurrentHeaterCoolerState(dps));
    });
  }
  _getCurrentHeaterCoolerState(dps) {
    const { Characteristic } = this.hap;
    if (!dps || typeof dps !== 'object') return Characteristic.CurrentHeaterCoolerState.INACTIVE;
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
    if (value === Characteristic.TargetHeaterCoolerState.COOL)  return this.setState(this.dpMode, this.cmdCool, callback);
    if (value === Characteristic.TargetHeaterCoolerState.HEAT)  return this.setState(this.dpMode, this.cmdHeat, callback);
    if (value === Characteristic.TargetHeaterCoolerState.AUTO)  return this.setState(this.dpMode, this.cmdAuto, callback);
    callback();
  }

  // ==== Target Temp single ====
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

  // ==== Units ====
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

  // ==== Вентилятор кондиционера (числовой / enum) ====
  _rsGetPercent(dps) {
    if (!dps || !dps[this.dpActive]) return 0;
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

  // ==== Приточка: Fanv2 (ползунок) ====
  _setupFreshAirFanSegmented() {
    const { Service, Characteristic } = this.hap;
    if (this.device.context.noFreshAir) return;

    let fresh = this.accessory.getService('FreshAir');
    if (!fresh) {
      fresh = this.accessory.addService(Service.Fanv2, 'Приточка', 'FreshAir');
    }
    fresh.setCharacteristic(Characteristic.ConfiguredName, 'Приточка');
    fresh.setPrimaryService(false);

    fresh.getCharacteristic(Characteristic.Active)
      .on('get', (cb) => this.getState(this.dpFreshAir, (e, dp) => {
        if (e) return cb(e);
        cb(null, (dp && dp !== 'off') ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE);
      }))
      .on('set', (v, cb) => {
        const tuya = (v === Characteristic.Active.ACTIVE) ? 'auto' : 'off';
        this.setState(this.dpFreshAir, tuya, cb);
      });

    fresh.getCharacteristic(Characteristic.TargetFanState)
      .updateValue(Characteristic.TargetFanState.AUTO)
      .on('get', (cb) => this.getState(this.dpFreshAir, (e, dp) => {
        if (e) return cb(e);
        const auto = (dp === 'auto');
        cb(null, auto ? Characteristic.TargetFanState.AUTO : Characteristic.TargetFanState.MANUAL);
      }))
      .on('set', (val, cb) => {
        if (val === Characteristic.TargetFanState.AUTO) {
          this.setState(this.dpFreshAir, 'auto', cb);
        } else {
          this.getState(this.dpFreshAir, (e, dp) => {
            if (e) return cb(e);
            if (dp === 'auto' || dp === 'off') {
              this.setState(this.dpFreshAir, 'low', cb);
            } else {
              cb();
            }
          });
        }
      });

    fresh.getCharacteristic(Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 33 })
      .on('get', (cb) => this.getState(this.dpFreshAir, (e, dp) => {
        if (e) return cb(e);
        if (!dp || dp === 'off') return cb(null, 0);
        if (dp === 'auto') return cb(null, 0);
        const pct = FAN_TO_PERCENT[dp];
        cb(null, Number.isFinite(pct) ? pct : 0);
      }))
      .on('set', (val, cb) => {
        this.getState(this.dpFreshAir, (e, dp) => {
          if (e) return cb(e);
          if (dp === 'auto') return cb();
          const tuya = (val <= 1) ? 'low' : nearestEnumByPercent(val);
          this.setState(this.dpFreshAir, tuya, cb);
        });
      });
  }

  // ==== Приточка: 4 свитча (Авто/1/2/3) ====
  _setupFreshAirAsSwitches() {
    const { Service, Characteristic } = this.hap;
    if (this.device.context.noFreshAir) return;

    const defs = [
      { key: 'FreshAirAuto',  name: 'Приточка Авто',    tuya: 'auto'   },
      { key: 'FreshAirL1',    name: 'Приточка 1',       tuya: 'low'    },
      { key: 'FreshAirL2',    name: 'Приточка 2',       tuya: 'mid'    },
      { key: 'FreshAirL3',    name: 'Приточка 3',       tuya: 'strong' },
    ];

    const ensureSwitch = ({ key, name, tuya }) => {
      let sw = this.accessory.getService(key);
      if (!sw) sw = this.accessory.addService(Service.Switch, name, key);
      sw.setCharacteristic(Characteristic.ConfiguredName, name);
      sw.setPrimaryService(false);

      sw.getCharacteristic(Characteristic.On)
        .on('get', (cb) => this.getState(this.dpFreshAir, (e, dp) => cb(e, e ? undefined : dp === tuya)))
        .on('set', (val, cb) => {
          if (!val) {
            // выключение конкретного пресета — уходим в off
            return this.setState(this.dpFreshAir, 'off', cb);
          }
          // включение пресета — выставляем его и гасим остальные
          this.setState(this.dpFreshAir, tuya, (err) => cb(err));
        });

      return sw;
    };

    defs.forEach(ensureSwitch);

    // подписка: синхронизируем свитчи при изменении DP
    this.device.on('change', (changes) => {
      if (!changes.hasOwnProperty(this.dpFreshAir)) return;
      const dp = changes[this.dpFreshAir];
      defs.forEach(({ key, tuya }) => {
        const sw = this.accessory.getService(key);
        if (sw) {
          const isOn = (dp === tuya);
          const ch = sw.getCharacteristic(Characteristic.On);
          if (ch.value !== isOn) ch.updateValue(isOn);
        }
      });
    });
  }
}

module.exports = AirConditionerAccessory;
