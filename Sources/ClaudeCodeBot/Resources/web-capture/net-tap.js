// ClaudeCodeBot's network tap for its web bots (Gemini, ChatGPT, Claude). Put in the page's
// own world before the page's scripts run, it wraps fetch, XMLHttpRequest, EventSource and
// WebSocket and hands the app each request and each piece of every answer, as the page reads
// it. It only watches: it never sends, changes or delays a request, and an error in it never
// reaches the page. The app keeps the last minutes in memory (WebNetBuffer) and writes them to
// disk only when you press Capture.
(function (root) {
  "use strict";
  if (!root || root.__ccbNetTap) return;
  var handler = root.webkit && root.webkit.messageHandlers && root.webkit.messageHandlers.ccbWebNet;
  if (!handler) return;
  try { Object.defineProperty(root, "__ccbNetTap", { value: true }); } catch (e) { return; }

  // Bodies of these kinds are left out (only that they came is kept).
  var BINARY_TYPE = /^(image|video|audio|font)\/|octet-stream|wasm|zip|pdf|protobuf(?!\+json)/i;
  var STATIC_URL = /\.(png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|css|m?js|map|mp4|webm|mp3|wav|ogg)(\?|#|$)/i;
  // One answer's body is kept up to this many characters.
  var MAX_BODY = 8 * 1024 * 1024;

  var seq = 0;
  var nextID = function (kind) { seq += 1; return kind + "-" + seq.toString(36) + "-" + Date.now().toString(36); };
  var post = function (event) {
    event.t = Date.now();
    try { handler.postMessage(event); } catch (e) { /* the app is gone */ }
  };
  var absolute = function (url) {
    try { return new URL(String(url), root.location.href).href; } catch (e) { return String(url); }
  };
  var headersOf = function (headers) {
    var out = {};
    try {
      if (!headers) return out;
      if (typeof headers.forEach === "function" && !Array.isArray(headers)) {
        headers.forEach(function (value, name) { out[String(name).toLowerCase()] = String(value); });
      } else if (Array.isArray(headers)) {
        headers.forEach(function (pair) { out[String(pair[0]).toLowerCase()] = String(pair[1]); });
      } else {
        Object.keys(headers).forEach(function (name) { out[name.toLowerCase()] = String(headers[name]); });
      }
    } catch (e) { /* unreadable headers */ }
    return out;
  };
  // A request's body as text, or what it was when it is not text.
  var bodyOf = function (body) {
    try {
      if (body == null) return undefined;
      if (typeof body === "string") return body.length > MAX_BODY ? body.slice(0, MAX_BODY) : body;
      if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return body.toString();
      if (typeof FormData !== "undefined" && body instanceof FormData) {
        var parts = [];
        body.forEach(function (value, name) { parts.push(encodeURIComponent(name) + "=" + (typeof value === "string" ? encodeURIComponent(value) : "[file]")); });
        return parts.join("&");
      }
      if (typeof Blob !== "undefined" && body instanceof Blob) return "[blob " + body.size + " bytes]";
      if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
        var bytes = body.byteLength;
        try { return new TextDecoder("utf-8", { fatal: true }).decode(body); } catch (e) { return "[binary " + bytes + " bytes]"; }
      }
    } catch (e) { /* unreadable body */ }
    return "[" + typeof body + "]";
  };
  var skipReason = function (url, type) {
    if (BINARY_TYPE.test(type || "")) return "binary";
    if (STATIC_URL.test(url || "")) return "static file";
    return null;
  };

  // ---- fetch ----
  var realFetch = root.fetch;
  if (typeof realFetch === "function") {
    var readBody = function (id, response, url) {
      var type = (response.headers && response.headers.get && response.headers.get("content-type")) || "";
      post({ id: id, kind: "fetch", phase: "response", url: response.url || url, status: response.status, headers: headersOf(response.headers), contentType: type });
      var skip = skipReason(url, type);
      if (skip || !response.body || typeof response.clone !== "function") { post({ id: id, kind: "fetch", phase: "end", note: skip || undefined }); return; }
      var reader, decoder = new TextDecoder(), total = 0;
      try { reader = response.clone().body.getReader(); } catch (e) { post({ id: id, kind: "fetch", phase: "end", note: "unreadable body" }); return; }
      var pump = function () {
        reader.read().then(function (part) {
          if (part.done) {
            var rest = decoder.decode();
            if (rest) post({ id: id, kind: "fetch", phase: "chunk", body: rest });
            post({ id: id, kind: "fetch", phase: "end" });
            return;
          }
          var text = decoder.decode(part.value, { stream: true });
          if (total < MAX_BODY && text) {
            if (total + text.length > MAX_BODY) text = text.slice(0, MAX_BODY - total);
            total += text.length;
            post({ id: id, kind: "fetch", phase: "chunk", body: text });
          }
          pump();
        }, function (error) { post({ id: id, kind: "fetch", phase: "error", note: String(error) }); });
      };
      pump();
    };
    var tappedFetch = function fetch(input, init) {
      var id = nextID("f"), url = "";
      try {
        var isRequest = typeof Request !== "undefined" && input instanceof Request;
        url = absolute(isRequest ? input.url : input);
        var method = String((init && init.method) || (isRequest ? input.method : "GET")).toUpperCase();
        var headers = headersOf((init && init.headers) || (isRequest ? input.headers : null));
        post({ id: id, kind: "fetch", phase: "request", url: url, method: method, headers: headers, body: bodyOf(init && init.body) });
      } catch (e) { /* never in the page's way */ }
      var promise = realFetch.apply(this, arguments);
      try {
        promise.then(function (response) { try { readBody(id, response, url); } catch (e) { /* ignore */ } },
          function (error) { post({ id: id, kind: "fetch", phase: "error", note: String(error) }); });
      } catch (e) { /* ignore */ }
      return promise;
    };
    root.fetch = tappedFetch;
  }

  // ---- XMLHttpRequest ----
  var XHR = root.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    var proto = XHR.prototype, open = proto.open, send = proto.send, setHeader = proto.setRequestHeader;
    proto.open = function (method, url) {
      try { this.__ccb = { id: nextID("x"), method: String(method || "GET").toUpperCase(), url: absolute(url), headers: {}, seen: 0, started: false }; } catch (e) { /* ignore */ }
      return open.apply(this, arguments);
    };
    proto.setRequestHeader = function (name, value) {
      try { if (this.__ccb) this.__ccb.headers[String(name).toLowerCase()] = String(value); } catch (e) { /* ignore */ }
      return setHeader.apply(this, arguments);
    };
    proto.send = function (body) {
      var xhr = this, tap = this.__ccb;
      if (tap) {
        try {
          post({ id: tap.id, kind: "xhr", phase: "request", url: tap.url, method: tap.method, headers: tap.headers, body: bodyOf(body) });
          var headersOfXHR = function () {
            var out = {};
            String(xhr.getAllResponseHeaders() || "").trim().split(/[\r\n]+/).forEach(function (line) {
              var at = line.indexOf(":");
              if (at > 0) out[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
            });
            return out;
          };
          var textual = function () { return xhr.responseType === "" || xhr.responseType === "text"; };
          var flush = function () {
            if (tap.skip || !textual()) return;
            var text = "";
            try { text = xhr.responseText || ""; } catch (e) { return; }
            if (text.length > tap.seen && tap.seen < MAX_BODY) {
              var piece = text.slice(tap.seen, Math.min(text.length, MAX_BODY));
              tap.seen = text.length;
              post({ id: tap.id, kind: "xhr", phase: "chunk", body: piece });
            }
          };
          xhr.addEventListener("readystatechange", function () {
            try {
              if (xhr.readyState >= 2 && !tap.started) {
                tap.started = true;
                var type = xhr.getResponseHeader("content-type") || "";
                tap.skip = skipReason(tap.url, type);
                post({ id: tap.id, kind: "xhr", phase: "response", url: xhr.responseURL || tap.url, status: xhr.status, headers: headersOfXHR(), contentType: type });
              }
              if (xhr.readyState === 3) flush();
              if (xhr.readyState === 4) {
                flush();
                var note = tap.skip || undefined;
                if (!tap.skip && !textual()) {
                  if (xhr.responseType === "json") {
                    try { post({ id: tap.id, kind: "xhr", phase: "chunk", body: JSON.stringify(xhr.response) }); } catch (e) { /* ignore */ }
                  } else { note = "response type " + xhr.responseType; }
                }
                post({ id: tap.id, kind: "xhr", phase: "end", note: note });
              }
            } catch (e) { /* ignore */ }
          });
          ["error", "abort", "timeout"].forEach(function (name) {
            xhr.addEventListener(name, function () { post({ id: tap.id, kind: "xhr", phase: "error", note: name }); });
          });
        } catch (e) { /* ignore */ }
      }
      return send.apply(this, arguments);
    };
  }

  // ---- EventSource ----
  var RealEventSource = root.EventSource;
  if (typeof RealEventSource === "function") {
    var TappedEventSource = function EventSource(url, options) {
      var source = new RealEventSource(url, options);
      try {
        var id = nextID("s"), full = absolute(url), watched = {};
        post({ id: id, kind: "sse", phase: "request", url: full, method: "GET", headers: {} });
        var watch = function (type) {
          if (watched[type]) return;
          watched[type] = true;
          RealEventSource.prototype.addEventListener.call(source, type, function (event) {
            post({ id: id, kind: "sse", phase: "chunk", body: (type === "message" ? "" : "event: " + type + "\n") + "data: " + String(event.data) });
          });
        };
        watch("message");
        // Named events the page listens to are watched too.
        source.addEventListener = function (type) {
          try { watch(String(type)); } catch (e) { /* ignore */ }
          return RealEventSource.prototype.addEventListener.apply(source, arguments);
        };
        RealEventSource.prototype.addEventListener.call(source, "open", function () { post({ id: id, kind: "sse", phase: "response", status: 200, url: full }); });
        RealEventSource.prototype.addEventListener.call(source, "error", function () {
          if (source.readyState === 2) post({ id: id, kind: "sse", phase: "end", note: "closed" });
        });
      } catch (e) { /* ignore */ }
      return source;
    };
    TappedEventSource.prototype = RealEventSource.prototype;
    ["CONNECTING", "OPEN", "CLOSED"].forEach(function (name) { try { TappedEventSource[name] = RealEventSource[name]; } catch (e) { /* ignore */ } });
    root.EventSource = TappedEventSource;
  }

  // ---- WebSocket ----
  var RealWebSocket = root.WebSocket;
  if (typeof RealWebSocket === "function") {
    var dataOf = function (data) {
      if (typeof data === "string") return data.length > MAX_BODY ? data.slice(0, MAX_BODY) : data;
      if (data && typeof data.size === "number") return "[binary " + data.size + " bytes]";
      if (data && typeof data.byteLength === "number") return "[binary " + data.byteLength + " bytes]";
      return "[" + typeof data + "]";
    };
    var realSend = RealWebSocket.prototype.send;
    var TappedWebSocket = function WebSocket(url, protocols) {
      var socket = arguments.length > 1 ? new RealWebSocket(url, protocols) : new RealWebSocket(url);
      try {
        var id = nextID("w");
        socket.__ccbID = id;
        post({ id: id, kind: "ws", phase: "request", url: absolute(url), method: "GET", headers: {} });
        socket.addEventListener("open", function () { post({ id: id, kind: "ws", phase: "response", status: 101 }); });
        socket.addEventListener("message", function (event) { post({ id: id, kind: "ws", phase: "message", body: dataOf(event.data) }); });
        socket.addEventListener("close", function (event) { post({ id: id, kind: "ws", phase: "end", note: "closed " + event.code }); });
      } catch (e) { /* ignore */ }
      return socket;
    };
    TappedWebSocket.prototype = RealWebSocket.prototype;
    ["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach(function (name) { try { TappedWebSocket[name] = RealWebSocket[name]; } catch (e) { /* ignore */ } });
    RealWebSocket.prototype.send = function (data) {
      try { if (this.__ccbID) post({ id: this.__ccbID, kind: "ws", phase: "send", body: dataOf(data) }); } catch (e) { /* ignore */ }
      return realSend.apply(this, arguments);
    };
    root.WebSocket = TappedWebSocket;
  }
})(typeof window !== "undefined" ? window : undefined);
