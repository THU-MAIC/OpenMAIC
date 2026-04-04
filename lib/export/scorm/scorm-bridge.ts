/**
 * Returns the scorm_bridge.js source string — a self-contained SCORM 1.2 API
 * wrapper embedded verbatim into every SCORM package.
 */
export function getScormBridgeJs(): string {
  return `
(function (root) {
  'use strict';

  var API = null;

  function findAPI(win) {
    var attempts = 0;
    while (win.API == null && win.parent != null && win.parent !== win) {
      attempts++;
      if (attempts > 7) return null;
      win = win.parent;
    }
    return win.API || null;
  }

  function getAPI() {
    if (API) return API;
    API = findAPI(window);
    if (!API && window.opener) API = findAPI(window.opener);
    return API;
  }

  root.SCORM = {
    initialized: false,

    init: function () {
      var api = getAPI();
      if (!api) {
        // No LMS present — running standalone, silently continue
        this.initialized = true;
        return true;
      }
      var result = api.LMSInitialize('');
      this.initialized = (result === 'true' || result === true);
      return this.initialized;
    },

    finish: function () {
      var api = getAPI();
      if (!api || !this.initialized) return;
      api.LMSFinish('');
      this.initialized = false;
    },

    getValue: function (key) {
      var api = getAPI();
      if (!api || !this.initialized) return '';
      return api.LMSGetValue(key) || '';
    },

    setValue: function (key, value) {
      var api = getAPI();
      if (!api || !this.initialized) return;
      api.LMSSetValue(key, String(value));
    },

    commit: function () {
      var api = getAPI();
      if (!api || !this.initialized) return;
      api.LMSCommit('');
    },

    // ── High-level helpers ──

    setCompleted: function () {
      this.setValue('cmi.core.lesson_status', 'completed');
      this.commit();
    },

    setPassed: function () {
      this.setValue('cmi.core.lesson_status', 'passed');
      this.commit();
    },

    setFailed: function () {
      this.setValue('cmi.core.lesson_status', 'failed');
      this.commit();
    },

    setScore: function (raw, min, max) {
      this.setValue('cmi.core.score.raw', raw);
      this.setValue('cmi.core.score.min', min);
      this.setValue('cmi.core.score.max', max);
      this.commit();
    },

    // Log a single interaction (question response)
    // index: 0-based interaction index
    // type: 'choice' for single/multiple select
    // response: student answer string (values joined by '[,]' for multiple)
    // correct: correct answer pattern string
    // result: 'correct' | 'wrong'
    logInteraction: function (index, id, type, response, correct, result) {
      var pre = 'cmi.interactions.' + index + '.';
      this.setValue(pre + 'id', id);
      this.setValue(pre + 'type', type);
      this.setValue(pre + 'student_response', response);
      this.setValue(pre + 'correct_responses.0.pattern', correct);
      this.setValue(pre + 'result', result);
    },

    // ── Navigation ──
    // sceneHrefs: JSON array of all SCO href strings (relative to ZIP root)
    // currentHref: this SCO's href (e.g. 'scos/scene_01.html')
    // direction: 'next' | 'prev'
    navigate: function (sceneHrefs, currentHref, direction) {
      var idx = sceneHrefs.indexOf(currentHref);
      var next = direction === 'next' ? idx + 1 : idx - 1;
      if (next < 0 || next >= sceneHrefs.length) return;
      this.finish();
      // Try parent frame first (LMS frameset), fall back to self
      if (window.parent && window.parent !== window) {
        try {
          window.parent.location.href = sceneHrefs[next];
          return;
        } catch (e) { /* cross-origin, fall through */ }
      }
      window.location.href = sceneHrefs[next];
    }
  };

})(window);
`.trim();
}
