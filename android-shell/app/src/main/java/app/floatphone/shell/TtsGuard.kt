package app.floatphone.shell

/**
 * 语音请求兜底闸门：在 WebView 里拦下发往 MiniMax `t2a_v2` 的请求，
 * 把括号内容整块删掉。
 *
 * 为什么放在壳里：语音清洗写在网页 JS 里，但网页是缓存优先的 PWA——
 * 只要线上站点的 Service Worker 版本没变（或站点构建落后），设备就会一直
 * 跑旧 JS，旧 JS 会把 `(breath)` 原样送给 MiniMax，模型就把 breath 念成英文。
 * 浏览器缓存、不同站点、不同构建版本这些变量壳都控制不了，唯一能保证的
 * 是把闸门设在网络出口：无论网页是哪一版，进 MiniMax 的文本都不含括号。
 *
 * 规则：
 * - 括号（圆/方/中文方/书名号/花括号/尖括号）连同内容整块删除；
 * - MiniMax 的 `<#0.3#>` 停顿标记也抹掉（部分账号不认，会被念出来）；
 * - 台词正文里的英文一律保留——用户要求英文照常念出来，只有括号内不许念。
 */
object TtsGuard {

    private const val SCRIPT = """
(function () {
  if (window.__ttsBracketGuard) return;
  window.__ttsBracketGuard = true;
  var BRACKETS = /[（）()【】《》〈〉\[\]{}<>]/g;
  function clean(text) {
    if (typeof text !== 'string' || !text) return text;
    return text
      .replace(/<#[^>]*#>/g, ' ')
      .replace(/[（(][^）)]*[）)]/g, ' ')
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/【[^】]*】/g, ' ')
      .replace(/《[^》]*》/g, ' ')
      .replace(/〈[^〉]*〉/g, ' ')
      .replace(/\{[^}]*\}/g, ' ')
      .replace(BRACKETS, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/([，。！？、；：…])[，、]+/g, '${'$'}1')
      .replace(/^[，、；：\s]+/, '')
      .replace(/[，、；：\s]+${'$'}/, '')
      .trim();
  }
  function patchBody(raw) {
    try {
      var body = JSON.parse(raw);
      if (!body || typeof body.text !== 'string') return raw;
      var cleaned = clean(body.text);
      if (cleaned === body.text) return raw;
      body.text = cleaned;
      return JSON.stringify(body);
    } catch (e) { return raw; }
  }
  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      try {
        var url = typeof input === 'string' ? input : ((input && input.url) || '');
        if (url.indexOf('t2a_v2') >= 0 && init && typeof init.body === 'string') {
          var next = {}; for (var k in init) next[k] = init[k];
          next.body = patchBody(init.body);
          init = next;
        }
      } catch (e) {}
      return origFetch.call(this, input, init);
    };
  }
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) {
    try { this.__ttsUrl = String(u || ''); } catch (e) {}
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      if (String(this.__ttsUrl).indexOf('t2a_v2') >= 0 && typeof body === 'string') {
        body = patchBody(body);
      }
    } catch (e) {}
    return origSend.call(this, body);
  };
})();
"""

    /** 在每次页面加载完成后把闸门装进网页。重复注入靠页面内的标记自去重。 */
    fun install() {
        ShellBus.evalJs(SCRIPT.trimIndent())
    }
}
