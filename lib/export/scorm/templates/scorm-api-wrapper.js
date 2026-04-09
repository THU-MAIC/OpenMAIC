/**
 * SCORM API wrapper (supports SCORM 1.2 and SCORM 2004).
 *
 * Looks for the LMS API object in the window hierarchy and normalizes
 * the differences between the two standards behind a small facade.
 *
 * This file is copied verbatim into every exported SCORM package.
 */
(function (global) {
  'use strict';

  var api = null;
  var version = null; // '1.2' | '2004'
  var initialized = false;

  function findAPI(win) {
    var tries = 0;
    while (win && !win.API && !win.API_1484_11 && win.parent && win.parent !== win && tries < 50) {
      tries++;
      win = win.parent;
    }
    if (!win) return null;
    if (win.API_1484_11) {
      version = '2004';
      return win.API_1484_11;
    }
    if (win.API) {
      version = '1.2';
      return win.API;
    }
    return null;
  }

  function getAPI() {
    if (api) return api;
    api = findAPI(global);
    if (!api && global.opener) api = findAPI(global.opener);
    return api;
  }

  function call(name, args) {
    var fn = api && api[name];
    if (typeof fn !== 'function') return '';
    try {
      return fn.apply(api, args || []);
    } catch (e) {
      console.warn('[SCORM] ' + name + ' failed:', e);
      return '';
    }
  }

  var ScormAPI = {
    version: function () {
      return version;
    },

    init: function () {
      if (initialized) return true;
      if (!getAPI()) {
        console.warn('[SCORM] No LMS API found — running in standalone preview mode.');
        return false;
      }
      var result = version === '2004' ? call('Initialize', ['']) : call('LMSInitialize', ['']);
      initialized = String(result) === 'true';
      return initialized;
    },

    getValue: function (key) {
      if (!initialized) return '';
      var mapped = mapKey(key);
      return version === '2004' ? call('GetValue', [mapped]) : call('LMSGetValue', [mapped]);
    },

    setValue: function (key, value) {
      if (!initialized) return false;
      var mapped = mapKey(key);
      var result =
        version === '2004'
          ? call('SetValue', [mapped, String(value)])
          : call('LMSSetValue', [mapped, String(value)]);
      return String(result) === 'true';
    },

    commit: function () {
      if (!initialized) return false;
      var result = version === '2004' ? call('Commit', ['']) : call('LMSCommit', ['']);
      return String(result) === 'true';
    },

    terminate: function () {
      if (!initialized) return false;
      var result = version === '2004' ? call('Terminate', ['']) : call('LMSFinish', ['']);
      initialized = false;
      return String(result) === 'true';
    },

    setScore: function (score, max, min) {
      if (version === '2004') {
        this.setValue('cmi.score.raw', score);
        if (typeof max === 'number') this.setValue('cmi.score.max', max);
        if (typeof min === 'number') this.setValue('cmi.score.min', min);
        if (typeof max === 'number' && max > 0) {
          this.setValue('cmi.score.scaled', Math.max(-1, Math.min(1, score / max)));
        }
      } else {
        this.setValue('cmi.core.score.raw', score);
        if (typeof max === 'number') this.setValue('cmi.core.score.max', max);
        if (typeof min === 'number') this.setValue('cmi.core.score.min', min);
      }
    },

    setCompletion: function (status) {
      // status: 'completed' | 'incomplete' | 'not_attempted' | 'unknown'
      if (version === '2004') {
        this.setValue('cmi.completion_status', status);
      } else {
        // SCORM 1.2 combines success & completion in lesson_status
        var mapped =
          status === 'completed'
            ? 'completed'
            : status === 'incomplete'
              ? 'incomplete'
              : 'not attempted';
        this.setValue('cmi.core.lesson_status', mapped);
      }
    },

    setSuccess: function (status) {
      // status: 'passed' | 'failed' | 'unknown'
      if (version === '2004') {
        this.setValue('cmi.success_status', status);
      } else {
        // In 1.2 success is merged into lesson_status; caller decides whether to promote
        if (status === 'passed') this.setValue('cmi.core.lesson_status', 'passed');
        else if (status === 'failed') this.setValue('cmi.core.lesson_status', 'failed');
      }
    },

    setLocation: function (location) {
      if (version === '2004') this.setValue('cmi.location', location);
      else this.setValue('cmi.core.lesson_location', location);
    },

    getLocation: function () {
      return version === '2004'
        ? this.getValue('cmi.location')
        : this.getValue('cmi.core.lesson_location');
    },

    setSessionTime: function (seconds) {
      var iso = version === '2004' ? toIso8601Duration(seconds) : toScorm12Time(seconds);
      var key = version === '2004' ? 'cmi.session_time' : 'cmi.core.session_time';
      this.setValue(key, iso);
    },

    setSuspendData: function (data) {
      var key = version === '2004' ? 'cmi.suspend_data' : 'cmi.suspend_data';
      this.setValue(key, typeof data === 'string' ? data : JSON.stringify(data));
    },

    getSuspendData: function () {
      var key = version === '2004' ? 'cmi.suspend_data' : 'cmi.suspend_data';
      return this.getValue(key);
    },
  };

  /** Translate our canonical keys to the version-specific ones when needed */
  function mapKey(key) {
    if (version === '2004') return key;
    // Naive 1.2 mapping for the subset we use
    var map = {
      'cmi.location': 'cmi.core.lesson_location',
      'cmi.completion_status': 'cmi.core.lesson_status',
      'cmi.success_status': 'cmi.core.lesson_status',
      'cmi.score.raw': 'cmi.core.score.raw',
      'cmi.score.max': 'cmi.core.score.max',
      'cmi.score.min': 'cmi.core.score.min',
      'cmi.session_time': 'cmi.core.session_time',
    };
    return map[key] || key;
  }

  function toIso8601Duration(totalSeconds) {
    var s = Math.max(0, Math.floor(totalSeconds));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    return 'PT' + h + 'H' + m + 'M' + sec + 'S';
  }

  function toScorm12Time(totalSeconds) {
    var s = Math.max(0, Math.floor(totalSeconds));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    function pad(n) {
      return n < 10 ? '0' + n : '' + n;
    }
    return pad(h) + ':' + pad(m) + ':' + pad(sec) + '.00';
  }

  global.ScormAPI = ScormAPI;
})(window);
