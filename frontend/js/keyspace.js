/* Mini-Spark — Base-36 keyspace math + formatting helpers.
 * Mirrors index_to_password() in src_w6_w7/src/sha256_serial.c exactly:
 * CHARSET = "abcdefghijklmnopqrstuvwxyz0123456789", most significant char first. */
window.MS = window.MS || {};

(function () {
  const CHARSET = "abcdefghijklmnopqrstuvwxyz0123456789";
  const MAX_LEN = 10; // 36^10 ≈ 3.66e15 < 2^53, so plain JS numbers stay exact

  MS.CHARSET = CHARSET;
  MS.MAX_LEN = MAX_LEN;

  MS.keyspaceSize = (len) => Math.pow(36, len);

  MS.indexToPassword = function (index, len) {
    const out = new Array(len);
    for (let pos = len - 1; pos >= 0; pos--) {
      out[pos] = CHARSET[index % 36];
      index = Math.floor(index / 36);
    }
    return out.join("");
  };

  MS.passwordToIndex = function (pw) {
    let idx = 0;
    for (const ch of pw) {
      const v = CHARSET.indexOf(ch);
      if (v < 0) return -1;
      idx = idx * 36 + v;
    }
    return idx;
  };

  MS.isHash = (s) => /^[0-9a-f]{64}$/.test(s);

  /* ---- formatting ---- */
  MS.fmtInt = (n) => Math.round(n).toLocaleString("en-US");

  MS.fmtCompact = function (n) {
    const abs = Math.abs(n);
    if (abs >= 1e12) return (n / 1e12).toFixed(2) + "T";
    if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (abs >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (abs >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return String(Math.round(n));
  };

  MS.fmtMhs = (v) => (v >= 1000 ? (v / 1000).toFixed(2) + " GH/s" : v.toFixed(v >= 100 ? 0 : 1) + " MH/s");

  MS.fmtDuration = function (ms) {
    if (!isFinite(ms) || ms < 0) return "—";
    const s = ms / 1000;
    if (s < 60) return s.toFixed(1) + " s";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m " + Math.floor(s % 60).toString().padStart(2, "0") + "s";
    const h = Math.floor(m / 60);
    if (h < 48) return h + "h " + (m % 60).toString().padStart(2, "0") + "m";
    return Math.round(h / 24).toLocaleString("en-US") + " days";
  };

  MS.fmtClock = function (ms) {
    const t = Math.max(0, ms);
    const m = Math.floor(t / 60000);
    const s = Math.floor((t % 60000) / 1000);
    const cs = Math.floor((t % 1000) / 10);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
  };

  MS.esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
})();
