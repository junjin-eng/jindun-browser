// 槿盾浏览器 指纹注入脚本生成器
// 通过 CDP Page.addScriptToEvaluateOnNewDocument 注入，自动覆盖 iframe。
// 原则：只修改时区偏移/DST相关的本地化展示，禁止篡改 Date.now() 等 Unix 绝对时间戳。
// 限制：JS层无法修改 TLS JA3/JA4 网络层指纹。

function buildInjectionScript(cfg) {
  const config = JSON.stringify(cfg || {});
  return `
(function () {
  if (globalThis.__jdNi) return;
  try { Object.defineProperty(globalThis, '__jdNi', { value: 1, enumerable: false, writable: false, configurable: false }); } catch (e) {}
  var CFG = ${config};

  function def(obj, key, val) {
    try { Object.defineProperty(obj, key, { get: function(){ return val; }, configurable: true }); } catch (e) {}
  }
  function override(obj, key, fn) {
    try { Object.defineProperty(obj, key, { value: fn, writable: true, configurable: true }); } catch (e) {}
  }
  // 让被改写的函数 toString 呈现原生形态，避免 fn.toString() 暴露改写源码
  function nat(fn, label) {
    try {
      Object.defineProperty(fn, 'toString', {
        value: function () { return 'function ' + label + '() { [native code] }'; },
        writable: true, configurable: true
      });
    } catch (e) {}
    return fn;
  }
  function mulberry32(a) {
    return function() {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- 1. navigator 基础 ----------
  // 注意：userAgent / languages / userAgentData / Accept-Language / sec-ch-ua 已由启动器经
  // CDP Network.setUserAgentOverride + Emulation.setLocaleOverride 在引擎层统一覆盖，
  // JS 层不再挂自有属性（自有 getter 可被 hasOwnProperty 检出，与引擎值矛盾更危险）
  if (CFG.platform) def(navigator, 'platform', CFG.platform);
  if (CFG.osName) def(navigator, 'oscpu', CFG.osName);
  if (typeof CFG.hardwareConcurrency === 'number') def(navigator, 'hardwareConcurrency', CFG.hardwareConcurrency);
  if (typeof CFG.deviceMemory === 'number') def(navigator, 'deviceMemory', CFG.deviceMemory);

  // 关闭 webdriver 标记：--disable-blink-features=AutomationControlled 已让原生值为 false；
  // 仅在异常仍为 true 时改原型兜底（不挂 navigator 自有属性，避免 hasOwnProperty 检出）
  try {
    if (navigator.webdriver) {
      var navProto = Object.getPrototypeOf(navigator);
      delete navProto.webdriver;
      Object.defineProperty(navProto, 'webdriver', { get: function () { return false; }, configurable: true });
    }
  } catch (e) {}

  // ---------- 2. 屏幕与DPR ----------
  if (CFG.screen) {
    if (typeof CFG.screen.width === 'number') {
      def(screen, 'width', CFG.screen.width);
      def(screen, 'availWidth', CFG.screen.width);
    }
    if (typeof CFG.screen.height === 'number') {
      def(screen, 'height', CFG.screen.height);
      def(screen, 'availHeight', Math.max(0, CFG.screen.height - 40));
    }
    if (typeof CFG.screen.colorDepth === 'number') def(screen, 'colorDepth', CFG.screen.colorDepth);
    if (typeof CFG.screen.pixelDepth === 'number') def(screen, 'pixelDepth', CFG.screen.pixelDepth);
  }
  if (typeof CFG.devicePixelRatio === 'number') def(window, 'devicePixelRatio', CFG.devicePixelRatio);

  // ---------- 3. 时区（仅偏移与IANA名称，不篡改绝对时间戳） ----------
  if (CFG.timezone || typeof CFG.timezoneOffset === 'number') {
    var tzOffset = typeof CFG.timezoneOffset === 'number' ? CFG.timezoneOffset : null;
    var origGetTZOffset = Date.prototype.getTimezoneOffset;
    if (tzOffset !== null) {
      Object.defineProperty(Date.prototype, 'getTimezoneOffset', {
        value: function () { return tzOffset; }, writable: true, configurable: true
      });
      nat(Date.prototype.getTimezoneOffset, 'getTimezoneOffset');
    }
    if (CFG.timezone) {
      var origDTF = Intl.DateTimeFormat;
      function patchedDTF() {
        var args = Array.prototype.slice.call(arguments);
        if (!args[1]) args[1] = {};
        if (!args[1].timeZone) args[1].timeZone = CFG.timezone;
        return new origDTF(args[0], args[1]);
      }
      patchedDTF.prototype = origDTF.prototype;
      patchedDTF.supportedLocalesOf = origDTF.supportedLocalesOf;
      window.Intl.DateTimeFormat = patchedDTF;
      nat(patchedDTF, 'DateTimeFormat');

      var origResolved = origDTF.prototype.resolvedOptions;
      Intl.DateTimeFormat.prototype.resolvedOptions = function () {
        var opts = origResolved.apply(this, arguments);
        if (opts.timeZone) opts.timeZone = CFG.timezone;
        return opts;
      };
      nat(Intl.DateTimeFormat.prototype.resolvedOptions, 'resolvedOptions');
    }
  }

  // ---------- 4. JS 地理位置 ----------
  if (CFG.geolocation && typeof CFG.geolocation.latitude === 'number') {
    var pos = {
      coords: {
        latitude: CFG.geolocation.latitude,
        longitude: CFG.geolocation.longitude,
        accuracy: CFG.geolocation.accuracy || 100,
        altitude: null, altitudeAccuracy: null, heading: null, speed: null
      },
      timestamp: Date.now()
    };
    var geo = navigator.geolocation;
    if (geo) {
      override(geo, 'getCurrentPosition', function (ok, err, opt) { setTimeout(function(){ ok(pos); }, 30); });
      override(geo, 'watchPosition', function (ok, err, opt) { setTimeout(function(){ ok(pos); }, 30); return 1; });
      nat(geo.getCurrentPosition, 'getCurrentPosition');
      nat(geo.watchPosition, 'watchPosition');
    }
  }

  // ---------- 5. WebGL 厂商/渲染器 ----------
  if (CFG.webgl && (CFG.webgl.vendor || CFG.webgl.renderer)) {
    var VENDOR = CFG.webgl.vendor || 'Google Inc. (NVIDIA)';
    var RENDERER = CFG.webgl.renderer || 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)';
    function hookGetParameter(glProto) {
      var orig = glProto.getParameter;
      glProto.getParameter = function (p) {
        if (p === 37445) return VENDOR;          // UNMASKED_VENDOR_WEBGL
        if (p === 37446) return RENDERER;        // UNMASKED_RENDERER_WEBGL
        if (p === 7936) return VENDOR;           // VENDOR
        if (p === 7937) return RENDERER;         // RENDERER
        return orig.apply(this, arguments);
      };
      nat(glProto.getParameter, 'getParameter');
    }
    try { hookGetParameter(WebGLRenderingContext.prototype); } catch (e) {}
    try { hookGetParameter(WebGL2RenderingContext.prototype); } catch (e) {}
    // getExtension 返回调试信息也要一致
    var origGetExt = WebGLRenderingContext.prototype.getExtension;
    WebGLRenderingContext.prototype.getExtension = function (name) {
      var ext = origGetExt.apply(this, arguments);
      if (ext && name === 'WEBGL_debug_renderer_info') {
        var self = this;
        var origG = Object.getOwnPropertyDescriptor(WebGLRenderingContext.prototype, 'getParameter');
        return ext;
      }
      return ext;
    };
  }

  // ---------- 6. Canvas 噪声（确定性种子） ----------
  if (CFG.canvasNoise && CFG.canvasNoise.enabled) {
    var cSeed = CFG.canvasNoise.seed || 1;
    function noiseData(data, len) {
      var rnd = mulberry32(cSeed);
      for (var i = 0; i < len; i += 4) {
        data[i] = data[i] ^ Math.floor(rnd() * 3);      // R
        data[i + 1] = data[i + 1] ^ Math.floor(rnd() * 3); // G
        data[i + 2] = data[i + 2] ^ Math.floor(rnd() * 3); // B
      }
    }
    var origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function () {
      try {
        var ctx = this.getContext('2d');
        if (ctx) {
          var img = ctx.getImageData(0, 0, this.width, this.height);
          noiseData(img.data, img.data.length);
          ctx.putImageData(img, 0, 0);
        }
      } catch (e) {}
      return origToDataURL.apply(this, arguments);
    };
    nat(HTMLCanvasElement.prototype.toDataURL, 'toDataURL');
    var origToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (cb, type, q) {
      try {
        var ctx = this.getContext('2d');
        if (ctx) {
          var img = ctx.getImageData(0, 0, this.width, this.height);
          noiseData(img.data, img.data.length);
          ctx.putImageData(img, 0, 0);
        }
      } catch (e) {}
      return origToBlob.apply(this, arguments);
    };
    nat(HTMLCanvasElement.prototype.toBlob, 'toBlob');
    var origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function () {
      var img = origGetImageData.apply(this, arguments);
      try { noiseData(img.data, img.data.length); } catch (e) {}
      return img;
    };
    nat(CanvasRenderingContext2D.prototype.getImageData, 'getImageData');
  }

  // ---------- 7. AudioContext 噪声 ----------
  if (CFG.audioNoise && CFG.audioNoise.enabled) {
    var aSeed = CFG.audioNoise.seed || 7;
    function patchAudio(Ctor) {
      if (!Ctor) return;
      var origGetChannelData = Ctor.prototype.getChannelData;
      Ctor.prototype.getChannelData = function () {
        var arr = origGetChannelData.apply(this, arguments);
        try {
          if (arr && arr.length) {
            var rnd = mulberry32(aSeed);
            for (var i = 0; i < arr.length; i += 500) {
              arr[i] = arr[i] + (rnd() - 0.5) * 0.0005;
            }
          }
        } catch (e) {}
        return arr;
      };
      var origGetFloatFreq = Ctor.prototype.getFloatFrequencyData;
      Ctor.prototype.getFloatFrequencyData = function (arr) {
        origGetFloatFreq.apply(this, arguments);
        try {
          var rnd = mulberry32(aSeed + 1);
          for (var i = 0; i < arr.length; i++) arr[i] += (rnd() - 0.5) * 0.01;
        } catch (e) {}
      };
      nat(Ctor.prototype.getChannelData, 'getChannelData');
      nat(Ctor.prototype.getFloatFrequencyData, 'getFloatFrequencyData');
    }
    try { patchAudio(AudioBuffer); } catch (e) {}
    try { patchAudio(window.OfflineAudioContext && OfflineAudioContext.prototype.constructor === OfflineAudioContext ? AudioBuffer : null); } catch (e) {}
  }

  // ---------- 8. WebRTC 保护 ----------
  // 本机真实 IP 泄漏由内核开关 --force-webrtc-ip-handling-policy=disable_non_proxied_udp
  // 在引擎层阻断（ICE 候选只走代理/mDNS）。JS 层刻意保留原生 RTCPeerConnection——
  // 真实 Chrome 必然存在该构造器，直接删除 API（"WebRTC is disabled"）本身就是机器人特征。

  // ---------- 9. 字体指纹 ----------
  if (CFG.fonts && CFG.fonts.length) {
    if (window.queryLocalFonts) {
      window.queryLocalFonts = function () {
        return Promise.resolve(CFG.fonts.map(function (f) {
          return { family: f, fullName: f, postscriptName: f.replace(/\\s+/g, ''), style: 'Regular' };
        }));
      };
      nat(window.queryLocalFonts, 'queryLocalFonts');
    }
  }

  // ---------- 10. Client Hints ----------
  // navigator.userAgentData 与 sec-ch-ua 头已由启动器经 Network.setUserAgentOverride
  // 的 userAgentMetadata 在引擎层统一伪造（原型原生 getter），JS 层不再覆盖（避免自有属性矛盾）。

  // ---------- 11. OffscreenCanvas 一致性（canvas噪声同样生效） ----------
  if (CFG.canvasNoise && CFG.canvasNoise.enabled && typeof OffscreenCanvasRenderingContext2D !== 'undefined') {
    var origOffGet = OffscreenCanvasRenderingContext2D.prototype.getImageData;
    if (origOffGet) {
      OffscreenCanvasRenderingContext2D.prototype.getImageData = function () {
        var img = origOffGet.apply(this, arguments);
        try { noiseData(img.data, img.data.length); } catch (e) {}
        return img;
      };
      nat(OffscreenCanvasRenderingContext2D.prototype.getImageData, 'getImageData');
    }
  }
})();
`;
}

module.exports = { buildInjectionScript };
