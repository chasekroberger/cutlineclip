/* Cutline full editor. Everything runs in the browser. The server is only used for accounts, clip limits,
   auto captions, and opening Google Drive and Dropbox links. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var video = $("video"), view = $("view"), vctx = view.getContext("2d");
  var reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  var MIN_CLIP = 1, MAX_CLIP = 180, BINS = 400, ENV_RATE = 20;
  var ASPECTS = { "9:16": [1080, 1920], "1:1": [1080, 1080], "4:5": [1080, 1350] };

  /* ---------- State ---------- */
  var E = { src: null, clips: [], active: 0, bins: [], env: null, moments: [], t: 0, playing: false, aspect: "9:16", tab: "captions",
    sel: null, safe: false, exporting: false, user: null, history: [], future: [], loaded: false, jumping: false, tlZoom: 1 };
  var uid = function () { return Math.random().toString(36).slice(2, 9); };
  function clip() { return E.clips[E.active]; }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function fmt(s, tenths) { s = Math.max(0, s || 0); var m = Math.floor(s / 60), r = s - m * 60, h = Math.floor(m / 60); m = m % 60; var sec = tenths ? r.toFixed(1).padStart(4, "0") : String(Math.floor(r)).padStart(2, "0"); return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + sec; }
  function status(m) { $("status").textContent = m || ""; }
  function savedCrops() { try { return JSON.parse(localStorage.getItem("cutline_crops")) || null; } catch (e) { return null; } }
  function defaultCrops() {
    return savedCrops() || { cam: { x: .17, y: .2, w: .3 }, game: { x: .5, y: .5, w: .62 }, full: { x: .5, y: .5, w: .32 }, pip: { x: .15, y: .18, w: .22 } };
  }
  function newClip(a, b, name) {
    var prev = clip();
    return { id: uid(), name: name || "Clip " + (E.clips.length + 1), a: a, b: b, segs: [{ s: a, e: b, cut: false }],
      layout: prev ? prev.layout : "split", crops: prev ? JSON.parse(JSON.stringify(prev.crops)) : defaultCrops(), split: prev ? prev.split : .42,
      cap: prev ? Object.assign({}, prev.cap, { on: false, words: [], range: null }) : { on: false, words: [], range: null, style: "karaoke", color: "#ffd400", per: 3, pos: "middle", size: 100, caps: true, shake: true, font: "anybody" },
      texts: [], zooms: [], audio: prev ? Object.assign({}, prev.audio) : { vol: 1, hp: false, comp: false }, progress: prev ? prev.progress : false, state: "Editing" };
  }

  /* ---------- Undo, redo and saved drafts ---------- */
  function snapshot() { return JSON.stringify({ clips: E.clips, active: E.active }); }
  var lastSnap = null, saveTimer = null;
  function commit() {
    var s = snapshot();
    if (s === lastSnap) return;
    if (lastSnap !== null) { E.history.push(lastSnap); if (E.history.length > 80) E.history.shift(); E.future = []; }
    lastSnap = s; undoButtons(); scheduleSave();
  }
  function restore(s) { var d = JSON.parse(s); E.clips = d.clips; E.active = clamp(d.active, 0, E.clips.length - 1); lastSnap = s; E.sel = null; if (E.t < clip().a || E.t > clip().b) seek(keptStart()); renderAll(); scheduleSave(); }
  function undo() { if (!E.history.length) return; E.future.push(lastSnap); restore(E.history.pop()); undoButtons(); status("Undone."); }
  function redo() { if (!E.future.length) return; E.history.push(lastSnap); restore(E.future.pop()); undoButtons(); status("Redone."); }
  function undoButtons() { $("undoBtn").disabled = !E.history.length; $("redoBtn").disabled = !E.future.length; }
  function draftKey() { return E.src ? "cutline_draft_" + E.src.name + "_" + Math.round(E.src.dur) : ""; }
  function scheduleSave() {
    if (!E.src) return; clearTimeout(saveTimer); $("savedNote").textContent = "Saving...";
    saveTimer = setTimeout(function () {
      try { localStorage.setItem(draftKey(), JSON.stringify({ at: Date.now(), clips: E.clips.map(function (c) { var o = Object.assign({}, c); o.state = c.state === "Exported" ? "Exported" : "Editing"; return o; }), active: E.active })); $("savedNote").textContent = "Saved on this device"; }
      catch (e) { $("savedNote").textContent = ""; }
    }, 500);
  }
  function loadDraft() { try { return JSON.parse(localStorage.getItem(draftKey())); } catch (e) { return null; } }

  /* ---------- Pieces of a clip ---------- */
  function kept(c) { c = c || clip(); return c.segs.filter(function (g) { return !g.cut; }); }
  function keptLength(c) { return kept(c).reduce(function (n, g) { return n + g.e - g.s; }, 0); }
  function keptStart() { var k = kept(); return k.length ? k[0].s : clip().a; }
  function keptEnd() { var k = kept(); return k.length ? k[k.length - 1].e : clip().b; }
  function keptBefore(t) { return kept().reduce(function (n, g) { return n + clamp(t, g.s, g.e) - g.s; }, 0); }
  function cutAt(t) { return clip().segs.filter(function (g) { return g.cut && t >= g.s && t < g.e; })[0] || null; }
  function segAt(t) { var s = clip().segs; for (var i = 0; i < s.length; i++) if (t < s[i].e || i === s.length - 1) return i; return 0; }
  function fitSegs(c) {
    c = c || clip(); var out = [];
    c.segs.forEach(function (g) { var a = Math.max(g.s, c.a), b = Math.min(g.e, c.b); if (b - a > .05) out.push({ s: a, e: b, cut: g.cut }); });
    if (!out.length) out = [{ s: c.a, e: c.b, cut: false }];
    out[0].s = c.a; out[out.length - 1].e = c.b;
    if (out.every(function (g) { return g.cut; })) out.forEach(function (g) { g.cut = false; });
    c.segs = out;
  }
  function setRange(a, b) {
    var c = clip(), d = E.src.dur; a = clamp(a, 0, d - MIN_CLIP); b = clamp(b, a + MIN_CLIP, Math.min(d, a + MAX_CLIP));
    c.a = a; c.b = b; fitSegs(c);
  }
  function moveRange(a) { var c = clip(), len = c.b - c.a, na = clamp(a, 0, E.src.dur - len), dlt = na - c.a; c.a = na; c.b = na + len; c.segs.forEach(function (g) { g.s += dlt; g.e += dlt; }); c.texts.forEach(function (x) { x.s += dlt; x.e += dlt; }); c.zooms.forEach(function (z) { z.t += dlt; }); c.cap.words = []; c.cap.range = null; fitSegs(c); }
  function splitAt(t) {
    var c = clip(), i = segAt(t), g = c.segs[i];
    if (t <= c.a + .2 || t >= c.b - .2 || t - g.s < .2 || g.e - t < .2) { status("Move the playhead inside the clip, a little away from the last split."); return; }
    c.segs.splice(i, 1, { s: g.s, e: t, cut: g.cut }, { s: t, e: g.e, cut: g.cut }); E.sel = { type: "seg", i: i + 1 }; commit(); renderAll(); status("Split. Select a piece and press Delete to cut it out.");
  }
  function toggleCut(i) {
    var c = clip(), g = c.segs[i]; if (!g) return;
    if (c.segs.length < 2) { status("Split the clip first, then cut out a piece."); return; }
    if (!g.cut && kept().length === 1) { status("That's the only piece left. Restore another piece first."); return; }
    g.cut = !g.cut; if (E.playing && cutAt(E.t)) seek(nextKept(E.t)); commit(); renderAll(); status(g.cut ? "Piece cut out. Press Delete again to bring it back." : "Piece restored.");
  }
  function nextKept(t) { var k = kept().filter(function (g) { return g.e > t; })[0]; return k ? Math.max(k.s, t) : keptStart(); }

  /* ---------- Loading a video ---------- */
  function resetFor(name, url, file, shared) {
    pause(); clearTimeout(saveTimer);
    if (E.src && E.src.url && E.src.url.indexOf("blob:") === 0) URL.revokeObjectURL(E.src.url);
    E.src = { name: name, url: url, file: file || null, shared: !!shared, dur: 0, w: 0, h: 0 };
    E.bins = []; E.env = null; E.moments = []; E.clips = []; E.history = []; E.future = []; lastSnap = null; undoButtons();
  }
  function openVideo(name, url, file, shared) {
    if (E.exporting) return;
    resetFor(name, url, file, shared);
    $("emptyStatus").textContent = "Opening " + name + "..."; status("");
    video.onerror = function () { $("emptyStatus").textContent = shared ? "That link didn't load. Make sure the file is a video shared with anyone who has the link." : "This browser can't play that file. Try an MP4."; };
    video.onloadedmetadata = function () {
      if (!isFinite(video.duration) || video.duration < 2) { $("emptyStatus").textContent = "That video is too short. Use one at least 2 seconds long."; return; }
      E.src.dur = video.duration; E.src.w = video.videoWidth; E.src.h = video.videoHeight;
      var draft = loadDraft();
      E.clips = [newClip(0, Math.min(30, E.src.dur))]; E.active = 0; lastSnap = snapshot();
      E.loaded = true; $("empty").hidden = true; $("newVideoBtn").hidden = false;
      $("thumbVid").hidden = !file; if (file) $("thumbVid").src = url; $("projName").textContent = name.replace(/\.[a-z0-9]+$/i, "");
      seek(0); renderAll(); scanAudio();
      if (draft && draft.clips && draft.clips.length) toast("You edited this video before (" + new Date(draft.at).toLocaleString() + ").", "Restore my edits", function () { E.history.push(lastSnap); E.clips = draft.clips; E.active = clamp(draft.active || 0, 0, draft.clips.length - 1); lastSnap = snapshot(); undoButtons(); seek(keptStart()); renderAll(); status("Your edits are back."); });
      status("Video loaded. Drag the white box under the timeline to pick the part for this clip.");
    };
    video.src = url; video.load();
  }
  function loadFile(f) {
    if (!f) return;
    if (f.type && f.type.indexOf("video/") !== 0) { $("emptyStatus").textContent = "That file isn't a video. Choose an MP4, MOV, or WebM file."; return; }
    openVideo(f.name, URL.createObjectURL(f), f, false);
  }
  var SHARE_HOSTS = /^(drive\.google\.com|docs\.google\.com|(www\.)?dropbox\.com|dl\.dropboxusercontent\.com)$/;
  var EMBED_HOSTS = /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|twitch\.tv)$/;
  async function loadLink(raw) {
    var say = function (m) { $("emptyStatus").textContent = m; };
    var u; try { u = new URL(String(raw).trim()); } catch (e) { u = null; }
    if (!u || !/^https?:$/.test(u.protocol)) { say("Paste the full link, starting with https://."); return; }
    var host = u.hostname.toLowerCase();
    if (EMBED_HOSTS.test(host)) { say("YouTube, Vimeo, and Twitch don't let other sites save their videos, so they can't be edited here. You can still trim them in the quick editor on the homepage. For full editing, upload the file or use a Drive or Dropbox link."); return; }
    if (SHARE_HOSTS.test(host)) {
      if (!E.user) { say("Log in to open Google Drive and Dropbox links."); return; }
      var src = "/api/import/file?url=" + encodeURIComponent(u.href);
      say("Opening your shared file...");
      try {
        var r = await fetch(src, { headers: { Range: "bytes=0-1" }, credentials: "same-origin" });
        if (!r.ok) { var d = {}; try { d = await r.json(); } catch (e) {} say(d.message || "That file couldn't be opened. Check that it's shared with anyone who has the link."); return; }
        try { r.body && r.body.cancel(); } catch (e) {}
      } catch (e) { say("Couldn't reach Cutline. Check your connection and try again."); return; }
      openVideo(/dropbox/.test(host) ? "Dropbox video" : "Google Drive video", src, null, true); return;
    }
    openVideo(decodeURIComponent(u.pathname.split("/").pop() || "") || "Linked video", u.href, null, true);
  }

  /* ---------- Hype moments from the audio ---------- */
  async function sourceBlob(limit) {
    if (E.src.file) return E.src.file;
    var r = await fetch(E.src.url, { credentials: "same-origin" }); if (!r.ok) throw new Error("fetch");
    if (limit && +r.headers.get("content-length") > limit) throw new Error("big");
    return r.blob();
  }
  async function scanAudio() {
    var src = E.src;
    var AC = window.OfflineAudioContext || window.webkitOfflineAudioContext; if (!AC) return;
    try {
      var blob = await sourceBlob(600 * 1024 * 1024);
      if (blob.size > 600 * 1024 * 1024) { status("Big file. Hype moments are skipped, so drag the white box to find your clip."); return; }
      status("Finding the hype moments...");
      var audio = await new AC(1, 8000, 8000).decodeAudioData(await blob.arrayBuffer());
      if (E.src !== src) return;
      var d = audio.getChannelData(0), per = Math.max(1, Math.round(audio.sampleRate / ENV_RATE)), env = new Float32Array(Math.ceil(d.length / per)), max = 0, q, k;
      for (q = 0; q < env.length; q++) { var s = 0, n = 0; for (k = q * per; k < Math.min(d.length, (q + 1) * per); k += 4) { s += d[k] * d[k]; n++; } env[q] = Math.sqrt(s / Math.max(1, n)); max = Math.max(max, env[q]); }
      if (!max) { status("This video has no sound, so hype moments and captions are skipped."); E.env = null; renderAll(); return; }
      for (q = 0; q < env.length; q++) env[q] = env[q] / max;
      E.env = env;
      var step = Math.max(1, Math.floor(env.length / BINS)); E.bins = [];
      for (q = 0; q < BINS; q++) { var m = 0; for (k = q * step; k < Math.min(env.length, (q + 1) * step); k++) m = Math.max(m, env[k]); E.bins.push(m); }
      /* Loudest stretches, judged over about 2 seconds, kept apart from each other. */
      var win = ENV_RATE * 2, sm = [], acc = 0; for (q = 0; q < env.length; q++) { acc += env[q]; if (q >= win) acc -= env[q - win]; sm.push(acc / Math.min(q + 1, win)); }
      var order = sm.map(function (v, i) { return [v, i]; }).sort(function (x, y) { return y[0] - x[0]; }), picks = [], gap = Math.max(8, E.src.dur / 25) * ENV_RATE, top = order.length ? order[0][0] : 1;
      for (var j = 0; j < order.length && picks.length < 8; j++) { var at = order[j][1]; if (picks.every(function (p) { return Math.abs(p.i - at) > gap; })) picks.push({ i: at, v: order[j][0] }); }
      E.moments = picks.map(function (p) { return { t: Math.max(0, p.i / ENV_RATE - 1), score: Math.round(60 + 39 * p.v / top) }; }).sort(function (x, y) { return x.t - y.t; });
      renderAll(); status("Found " + E.moments.length + " hype moments. Select one to jump there, or make a clip from each.");
    } catch (e) { status(e && e.message === "big" ? "Big file. Hype moments are skipped, so drag the white box to find your clip." : "Hype moments use the video's sound, and this video's sound couldn't be read. Drag the white box to pick your clip."); }
  }
  function envAt(t) { if (!E.env) return 0; return E.env[clamp(Math.floor(t * ENV_RATE), 0, E.env.length - 1)] || 0; }

  /* ---------- Drawing a frame ---------- */
  function canvasSize(scale) { var a = ASPECTS[E.aspect]; return [Math.round(a[0] * scale), Math.round(a[1] * scale)]; }
  function zoomAt(c, t) {
    var zs = c.zooms.slice().sort(function (x, y) { return x.t - y.t; }), prev = 1, cur = 1;
    for (var i = 0; i < zs.length; i++) {
      if (zs[i].t > t) break;
      prev = cur; cur = zs[i].scale;
      var p = clamp((t - zs[i].t) / .22, 0, 1); p = 1 - Math.pow(1 - p, 3);
      if (i === zs.length - 1 || zs[i + 1].t > t) return prev + (cur - prev) * p;
    }
    return cur;
  }
  function cropAspect(box, dw, dh) { var vw = E.src.w || 16, vh = E.src.h || 9; return { w: box.w, h: Math.min(1, box.w * vw * dh / dw / vh) }; }
  function drawCrop(ctx, box, dx, dy, dw, dh, z) {
    var vw = video.videoWidth, vh = video.videoHeight; if (!vw) return;
    var sw = box.w * vw / (z || 1), sh = sw * dh / dw;
    if (sh > vh) { sh = vh; sw = sh * dw / dh; }
    if (sw > vw) { sw = vw; sh = sw * dh / dw; }
    var sx = clamp(box.x * vw - sw / 2, 0, vw - sw), sy = clamp(box.y * vh - sh / 2, 0, vh - sh);
    ctx.drawImage(video, sx, sy, sw, sh, dx, dy, dw, dh);
  }
  function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); }
  var FONTS = { anybody: '"Anybody", "Arial Black", sans-serif', montserrat: '"Montserrat", "Arial Black", sans-serif', bangers: '"Bangers", "Arial Black", sans-serif' };
  var CAP_STYLES = {
    karaoke: { name: "Karaoke" }, pop: { name: "Bold pop" }, neon: { name: "Neon" }, box: { name: "Box" }, minimal: { name: "Minimal" }, outline: { name: "Outline" }
  };
  function chunkWords(words, per) {
    var out = [], cur = [];
    words.forEach(function (w) {
      var prev = cur[cur.length - 1];
      if (cur.length && (cur.length >= per || w.s - prev.e > .6 || /[.?!,]$/.test(prev.w))) { out.push(cur); cur = []; }
      cur.push(w);
    });
    if (cur.length) out.push(cur);
    return out.map(function (g, i) { var next = out[i + 1], last = g[g.length - 1].e; return { words: g, s: g[0].s, end: next && next[0].s - last < 1.2 ? next[0].s : last + .6 }; });
  }
  var groupCache = { key: "", groups: [] };
  function groupsFor(c) {
    var key = c.id + ":" + c.cap.per + ":" + c.cap.words.length + ":" + (c.cap.words[0] ? c.cap.words[0].s : 0) + ":" + c.cap.words.map(function (w) { return w.w; }).join("").length;
    if (groupCache.key !== key) groupCache = { key: key, groups: chunkWords(c.cap.words, c.cap.per) };
    return groupCache.groups;
  }
  function drawCaptions(ctx, W, H, c, t) {
    if (!c.cap.on || !c.cap.words.length) return;
    var g = groupsFor(c).filter(function (x) { return t >= x.s && t < x.end; })[0]; if (!g) return;
    var cap = c.cap, size = Math.round(W * .088 * cap.size / 100), fam = FONTS[cap.font] || FONTS.anybody;
    var italic = cap.font === "anybody" && cap.style !== "minimal" ? "italic " : "", weight = cap.style === "minimal" ? 800 : 900;
    ctx.save(); ctx.font = italic + weight + " " + size + "px " + fam; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.lineJoin = "round";
    var words = g.words.map(function (w) { var txt = cap.caps ? w.w.toUpperCase() : w.w; return { txt: txt, w: w, width: ctx.measureText(txt).width }; });
    var space = size * .28, maxW = W * .86, lines = [[]], lw = 0;
    words.forEach(function (x) { if (lines[lines.length - 1].length && lw + space + x.width > maxW) { lines.push([]); lw = 0; } lines[lines.length - 1].push(x); lw += (lw ? space : 0) + x.width; });
    var lh = size * 1.12, y0;
    if (cap.pos === "top") y0 = H * .2;
    else if (cap.pos === "bottom") y0 = H * .72;
    else y0 = c.layout === "split" && E.aspect === "9:16" ? H * c.split : H * .58;
    y0 -= (lines.length - 1) * lh / 2;
    var shake = cap.shake && !reduced ? envAt(t) : 0, jx = 0, jy = 0;
    if (shake > .78) { jx = (Math.random() - .5) * W * .012; jy = (Math.random() - .5) * W * .012; }
    var current = null; g.words.forEach(function (w) { if (t >= w.s - .03) current = w; });
    lines.forEach(function (line, li) {
      var total = line.reduce(function (n, x, i) { return n + x.width + (i ? space : 0); }, 0), x = (W - total) / 2 + jx, y = y0 + li * lh + jy;
      line.forEach(function (it) {
        var on = it.w === current, col = cap.color, pad = size * .14;
        ctx.save();
        if (cap.style === "pop" && on) { ctx.translate(x + it.width / 2, y); ctx.scale(1.12, 1.12); ctx.translate(-(x + it.width / 2), -y); }
        if (cap.style === "box" && on) { ctx.fillStyle = col; roundRect(ctx, x - pad, y - size * .58, it.width + pad * 2, size * 1.14, size * .16); ctx.fill(); }
        if (cap.style === "karaoke" || cap.style === "box" || cap.style === "pop") { ctx.lineWidth = size * (cap.style === "pop" ? .1 : .16); ctx.strokeStyle = "#000"; if (!(cap.style === "box" && on)) ctx.strokeText(it.txt, x, y); }
        if (cap.style === "pop") { ctx.fillStyle = "#000"; ctx.fillText(it.txt, x + size * .06, y + size * .07); }
        if (cap.style === "neon") { ctx.shadowColor = on ? col : "#27e8f2"; ctx.shadowBlur = size * .45; }
        if (cap.style === "minimal") { ctx.shadowColor = "rgba(0,0,0,.65)"; ctx.shadowBlur = size * .3; }
        if (cap.style === "outline") { ctx.lineWidth = size * .07; ctx.strokeStyle = on ? col : "#fff"; ctx.strokeText(it.txt, x, y); if (on) { ctx.fillStyle = col; ctx.fillText(it.txt, x, y); } }
        else { ctx.fillStyle = cap.style === "box" && on ? "#111" : on ? col : cap.style === "neon" ? "#e9fdff" : "#fff"; ctx.fillText(it.txt, x, y); if (cap.style === "neon") ctx.fillText(it.txt, x, y); }
        ctx.restore();
        x += it.width + space;
      });
    });
    ctx.restore();
  }
  function drawTexts(ctx, W, H, c, t) {
    c.texts.forEach(function (tx) {
      if (t < tx.s || t >= tx.e || !tx.text.trim()) return;
      var age = t - tx.s, size = Math.round(W * .068), txt = tx.text.toUpperCase();
      if (tx.anim === "type") txt = txt.slice(0, Math.max(1, Math.ceil(txt.length * clamp(age / .6, 0, 1))));
      ctx.save(); ctx.font = "italic 900 " + size + "px " + FONTS.anybody; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.lineJoin = "round";
      var y = tx.pos === "top" ? H * .11 : tx.pos === "bottom" ? H * .84 : H * .44, x = W / 2, wdt = Math.min(ctx.measureText(txt).width, W * .9);
      if (tx.anim === "slide") { var p = clamp(age / .3, 0, 1); ctx.globalAlpha = p; y += (1 - p) * size * 1.2; }
      if (tx.anim === "pop") { var q = clamp(age / .25, 0, 1), s = q < 1 ? .6 + .52 * q - .12 * Math.sin(q * Math.PI) : 1; ctx.translate(x, y); ctx.scale(s, s); ctx.translate(-x, -y); }
      ctx.translate(x, y); ctx.rotate(-.025); ctx.translate(-x, -y);
      if (tx.look === "box" || tx.look === "pink") { ctx.fillStyle = tx.look === "pink" ? "#ff2e88" : "#fff"; roundRect(ctx, x - wdt / 2 - size * .35, y - size * .7, wdt + size * .7, size * 1.4, size * .22); ctx.fill(); ctx.fillStyle = tx.look === "pink" ? "#fff" : "#111"; ctx.fillText(txt, x, y, W * .9); }
      else { ctx.lineWidth = size * .16; ctx.strokeStyle = "#000"; ctx.strokeText(txt, x, y, W * .9); ctx.fillStyle = "#fff"; ctx.fillText(txt, x, y, W * .9); }
      ctx.restore();
    });
  }
  function drawFrame(ctx, W, H, t, forExport) {
    var c = clip(); ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
    if (!c || !video.videoWidth) return;
    var z = zoomAt(c, t), cr = c.crops, lay = c.layout;
    if (lay === "split") {
      var top = Math.round(H * c.split);
      drawCrop(ctx, cr.cam, 0, 0, W, top, 1); drawCrop(ctx, cr.game, 0, top, W, H - top, z);
      ctx.fillStyle = "#000"; ctx.fillRect(0, top - Math.round(W * .003), W, Math.max(2, Math.round(W * .006)));
    } else if (lay === "full") {
      drawCrop(ctx, cr.full, 0, 0, W, H, z);
    } else if (lay === "pip") {
      drawCrop(ctx, cr.game, 0, 0, W, H, z);
      var s = Math.round(W * .38), pad = Math.round(W * .045), bx = W - s - pad, by = pad + Math.round(H * .06);
      ctx.save(); roundRect(ctx, bx, by, s, s, s * .14); ctx.clip(); drawCrop(ctx, cr.pip, bx, by, s, s, 1); ctx.restore();
      ctx.lineWidth = Math.max(3, W * .008); ctx.strokeStyle = "#fff"; roundRect(ctx, bx, by, s, s, s * .14); ctx.stroke();
    } else {
      var vw = video.videoWidth, vh = video.videoHeight, cov = Math.max(W / vw, H / vh);
      ctx.save(); ctx.filter = "blur(" + Math.round(W * .045) + "px) brightness(.55)"; ctx.drawImage(video, (W - vw * cov) / 2 - W * .05, (H - vh * cov) / 2 - H * .05, vw * cov * 1.1, vh * cov * 1.1); ctx.restore();
      var fw = W, fh = W * vh / vw; if (fh > H) { fh = H; fw = H * vw / vh; }
      drawCrop(ctx, { x: .5, y: .5, w: 1 }, (W - fw) / 2, (H - fh) / 2, fw, fh, z);
    }
    drawTexts(ctx, W, H, c, t);
    drawCaptions(ctx, W, H, c, t);
    if (c.progress) { var p = clamp(keptBefore(t) / Math.max(.01, keptLength()), 0, 1), bh = Math.max(4, Math.round(H * .006)); ctx.fillStyle = "rgba(255,255,255,.25)"; ctx.fillRect(0, H - bh, W, bh); ctx.fillStyle = "#ff2e88"; ctx.fillRect(0, H - bh, W * p, bh); }
    if (!forExport && E.safe) {
      ctx.save(); ctx.fillStyle = "rgba(255,46,136,.18)"; ctx.strokeStyle = "rgba(255,143,189,.9)"; ctx.lineWidth = 2; ctx.setLineDash([8, 6]);
      ctx.fillRect(W * .84, H * .38, W * .16, H * .46); ctx.strokeRect(W * .84, H * .38, W * .16, H * .46);
      ctx.fillRect(0, H * .86, W, H * .14); ctx.strokeRect(0, H * .86, W, H * .14);
      ctx.fillRect(0, 0, W, H * .07); ctx.strokeRect(0, 0, W, H * .07);
      ctx.setLineDash([]); ctx.fillStyle = "#fff"; ctx.font = "600 " + Math.round(W * .03) + "px Geist, sans-serif"; ctx.textAlign = "center";
      ctx.fillText("App buttons cover these areas", W / 2, H * .93); ctx.restore();
    }
  }
  function renderView() {
    var sz = canvasSize(.5); if (view.width !== sz[0] || view.height !== sz[1]) { view.width = sz[0]; view.height = sz[1]; }
    drawFrame(vctx, view.width, view.height, E.t, false);
  }

  /* ---------- Audio ---------- */
  var actx = null, nodes = null;
  function audioGraph() {
    if (nodes) return nodes;
    var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;
    try {
      actx = new AC(); var src = actx.createMediaElementSource(video), hp = actx.createBiquadFilter(), comp = actx.createDynamicsCompressor(), gain = actx.createGain(), dest = actx.createMediaStreamDestination();
      hp.type = "highpass"; src.connect(hp); hp.connect(comp); comp.connect(gain); gain.connect(actx.destination); gain.connect(dest);
      nodes = { hp: hp, comp: comp, gain: gain, dest: dest }; applyAudio(); return nodes;
    } catch (e) { return null; }
  }
  function applyAudio() {
    if (!nodes || !clip()) return; var a = clip().audio;
    nodes.gain.gain.value = a.vol; nodes.hp.frequency.value = a.hp ? 90 : 10;
    nodes.comp.threshold.value = a.comp ? -30 : 0; nodes.comp.ratio.value = a.comp ? 5 : 1; nodes.comp.knee.value = a.comp ? 10 : 0;
  }

  /* ---------- Playback ---------- */
  function seek(t) { if (!E.src) return; E.t = clamp(t, 0, E.src.dur || 0); try { video.currentTime = E.t; } catch (e) {} }
  function waitSeek() { return new Promise(function (ok) { var done = false, fin = function () { if (!done) { done = true; video.removeEventListener("seeked", fin); ok(); } }; video.addEventListener("seeked", fin); setTimeout(fin, 3000); }); }
  function play() {
    if (!E.loaded || E.playing) return; audioGraph(); if (actx && actx.state === "suspended") actx.resume();
    if (E.t < keptStart() - .05 || E.t >= keptEnd() - .05) seek(keptStart());
    E.playing = true; playIcon(); var p = video.play(); if (p) p.catch(function () { E.playing = false; playIcon(); });
  }
  function pause() { E.playing = false; video.pause(); playIcon(); }
  function playIcon() { $("playIcon").innerHTML = E.playing ? '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>' : '<path d="M8 5v14l11-7z"/>'; $("playBtn").setAttribute("aria-label", E.playing ? "Pause" : "Play"); }
  function jumpTo(t) {
    E.jumping = true; var rec = recorder && recorder.state === "recording"; if (rec) recorder.pause(); video.pause();
    var done = waitSeek(); seek(t);
    done.then(function () { if (rec && recorder.state === "paused") recorder.resume(); if (E.playing) video.play().catch(function () {}); E.jumping = false; });
  }
  var lastUi = 0;
  function frame(now) {
    if (E.loaded) {
      if (E.playing && !E.jumping) {
        E.t = video.currentTime;
        var c = cutAt(E.t);
        if (E.t >= keptEnd() - .02 || video.ended) { if (E.exporting) finishExport(); else { seek(keptStart()); video.play().catch(function () {}); } }
        else if (c) jumpTo(c.e);
      }
      renderView();
      if (E.exporting && exportCtx) drawFrame(exportCtx, exportCanvas.width, exportCanvas.height, E.t, true);
      if (now - lastUi > 60) { lastUi = now; uiTick(); }
    }
    requestAnimationFrame(frame);
  }
  function uiTick() {
    var c = clip(); if (!c) return;
    $("timeText").textContent = fmt(keptBefore(E.t), true) + " / " + fmt(keptLength(), true);
    $("playhead").style.left = ((E.t - c.a) / (c.b - c.a) * 100) + "%";
    if (E.exporting) { var tot = keptLength(); status("Exporting " + fmt(keptBefore(E.t)) + " of " + fmt(tot) + ". Keep this tab open."); }
    if (E.tab === "layout") drawCropSource();
  }
  video.addEventListener("seeked", function () { if (!E.playing) renderView(); });

  /* ---------- Left column ---------- */
  function renderLeft() {
    var has = !!(E.src && E.loaded);
    $("sourceCard").hidden = !has; $("clipsBox").hidden = !has; $("leftEmpty").hidden = has; $("momentsBox").hidden = !has || !E.moments.length;
    if (!has) return;
    $("srcName").textContent = E.src.name; $("srcMeta").textContent = fmt(E.src.dur) + " · " + (E.src.h ? E.src.h + "p" : "");
    $("momentCount").textContent = E.moments.length + " found";
    var box = $("moments"); box.textContent = "";
    E.moments.forEach(function (m, i) {
      var row = document.createElement("div"); row.className = "card moment";
      var jump = document.createElement("button"); jump.type = "button"; jump.className = "jump"; jump.title = "Jump there";
      jump.innerHTML = '<span class="at mono"></span><span style="flex:1;font-size:13px">Loud moment ' + (i + 1) + '</span><span class="score"></span>';
      jump.querySelector(".at").textContent = fmt(m.t); jump.querySelector(".score").textContent = m.score;
      jump.addEventListener("click", function () { pause(); var c = clip(), len = Math.min(c.b - c.a, 30); moveRange(Math.max(0, m.t - len / 3)); commit(); seek(keptStart()); renderAll(); status("Moved this clip to loud moment " + (i + 1) + ". Press Space to watch it."); });
      var add = document.createElement("button"); add.type = "button"; add.className = "btn icon"; add.textContent = "+"; add.setAttribute("aria-label", "New clip at loud moment " + (i + 1)); add.title = "Make a new clip here";
      add.addEventListener("click", function () { addClipAt(m.t, "Moment " + (i + 1)); });
      row.append(jump, add); box.appendChild(row);
    });
    var list = $("clips"); list.textContent = "";
    E.clips.forEach(function (c, i) {
      var b = document.createElement("button"); b.type = "button"; b.className = "card clipbtn"; b.setAttribute("aria-pressed", String(i === E.active));
      b.innerHTML = '<span class="bar"></span><span style="flex:1;min-width:0"><b></b><small class="mono"></small></span><small></small>';
      b.querySelector("b").textContent = c.name; b.querySelectorAll("small")[0].textContent = fmt(keptLength(c)) + " · starts " + fmt(c.a);
      var st = b.querySelectorAll("small")[1]; st.textContent = c.state; st.style.color = c.state === "Exported" ? "var(--ok)" : "var(--dim)";
      b.addEventListener("click", function () { if (E.exporting || i === E.active) return; pause(); E.active = i; E.sel = null; groupCache.key = ""; commit(); seek(keptStart()); renderAll(); });
      b.addEventListener("dblclick", function () { var n = prompt("Name this clip", c.name); if (n && n.trim()) { c.name = n.trim().slice(0, 60); commit(); renderLeft(); } });
      list.appendChild(b);
    });
    $("delClipBtn").disabled = E.clips.length < 2;
  }
  function addClipAt(t, name) {
    if (E.exporting) return; pause();
    var len = Math.min(30, E.src.dur), a = clamp(t - len / 3, 0, Math.max(0, E.src.dur - len));
    E.clips.push(newClip(a, Math.min(E.src.dur, a + len), name)); E.active = E.clips.length - 1; E.sel = null; commit(); seek(a); renderAll(); status(clip().name + " added. Trim it, then export.");
  }
  $("clipAllBtn").addEventListener("click", function () {
    if (!E.moments.length || E.exporting) return; pause();
    var fresh = E.clips.length === 1 && E.clips[0].a === 0 && !E.clips[0].texts.length && E.clips[0].segs.length === 1;
    if (fresh) E.clips = [];
    E.moments.slice().sort(function (x, y) { return x.t - y.t; }).forEach(function (m, i) { var len = Math.min(30, E.src.dur), a = clamp(m.t - len / 3, 0, Math.max(0, E.src.dur - len)); E.clips.push(newClip(a, Math.min(E.src.dur, a + len), "Moment " + (i + 1))); });
    E.active = fresh ? 0 : E.clips.length - E.moments.length; commit(); seek(keptStart()); renderAll(); status("Made " + E.moments.length + " clips. Open each one to trim and caption it.");
  });
  $("newClipBtn").addEventListener("click", function () { addClipAt(E.t); });
  $("dupClipBtn").addEventListener("click", function () { if (E.exporting) return; var c = JSON.parse(JSON.stringify(clip())); c.id = uid(); c.name = clip().name + " copy"; c.state = "Editing"; E.clips.splice(E.active + 1, 0, c); E.active++; commit(); renderAll(); status("Duplicated. Try a different caption style or layout on this copy."); });
  $("delClipBtn").addEventListener("click", function () { if (E.clips.length < 2 || E.exporting) return; var n = clip().name; E.clips.splice(E.active, 1); E.active = clamp(E.active, 0, E.clips.length - 1); commit(); seek(keptStart()); renderAll(); status(n + " deleted. Press Undo to bring it back."); });

  /* ---------- Right panel ---------- */
  document.querySelectorAll(".tabs button").forEach(function (b) { b.addEventListener("click", function () { showTab(b.dataset.tab); }); });
  function showTab(t) { E.tab = t; document.querySelectorAll(".tabs button").forEach(function (b) { b.setAttribute("aria-selected", String(b.dataset.tab === t)); }); document.querySelectorAll("[data-panel]").forEach(function (p) { p.hidden = p.dataset.panel !== t; }); renderRight(); }
  var COLORS = [["Yellow", "#ffd400"], ["Green", "#4ade80"], ["Pink", "#ff2e88"], ["Cyan", "#27e8f2"], ["Orange", "#ff8a1f"], ["White", "#ffffff"]];
  (function buildStatic() {
    var sb = $("capStyles");
    Object.keys(CAP_STYLES).forEach(function (k) { var b = document.createElement("button"); b.type = "button"; b.className = "preset"; b.dataset.style = k; b.innerHTML = '<span class="sample">Clutch</span><span></span>'; b.lastChild.textContent = CAP_STYLES[k].name; b.addEventListener("click", function () { capSet({ style: k }); }); sb.appendChild(b); });
    var cb = $("capColors");
    COLORS.forEach(function (c) { var b = document.createElement("button"); b.type = "button"; b.dataset.color = c[1]; b.setAttribute("aria-label", c[0]); b.style.cssText = "width:32px;height:32px;border-radius:50%;border:3px solid transparent;background:" + c[1]; b.addEventListener("click", function () { capSet({ color: c[1] }); }); cb.appendChild(b); });
    var lb = $("layouts");
    [["split", "Split screen", "height:42%;background:#3b2a52;border-bottom:1px solid #000"], ["full", "Full crop", "height:0"], ["pip", "Cam in corner", "width:40%;height:24%;margin:4px 4px 0 auto;background:#3b2a52;border:1px solid #fff;border-radius:2px"], ["blur", "Fit with blur", "height:33%;margin-top:34%;background:#2b4a6a"]].forEach(function (l) {
      var b = document.createElement("button"); b.type = "button"; b.className = "preset"; b.dataset.layout = l[0];
      b.innerHTML = '<span style="width:36px;height:60px;border-radius:5px;overflow:hidden;display:flex;flex-direction:column;background:#17304a;border:1px solid rgba(255,255,255,.2)"><span style="' + l[2] + '"></span></span><span></span>'; b.lastChild.textContent = l[1];
      b.addEventListener("click", function () { clip().layout = l[0]; commit(); renderRight(); renderView(); });
      lb.appendChild(b);
    });
  })();
  function capSet(o) { Object.assign(clip().cap, o); groupCache.key = ""; commit(); renderRight(); renderView(); }
  function renderRight() {
    var c = clip(); if (!c) return; var cap = c.cap;
    document.querySelectorAll("#capStyles .preset").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.style === cap.style)); var s = b.querySelector(".sample"); s.style.color = cap.style === "outline" ? "transparent" : cap.color; s.style.webkitTextStroke = cap.style === "outline" ? "1.5px " + cap.color : ""; s.style.textShadow = b.dataset.style === "neon" ? "0 0 10px " + cap.color : b.dataset.style === "pop" ? "2px 2px 0 #000" : ""; s.style.background = b.dataset.style === "box" ? cap.color : ""; if (b.dataset.style === "box") s.style.color = "#111"; s.style.padding = b.dataset.style === "box" ? "0 5px" : ""; s.style.borderRadius = "4px"; });
    document.querySelectorAll("#capColors button").forEach(function (b) { var on = b.dataset.color === cap.color; b.setAttribute("aria-pressed", String(on)); b.style.borderColor = on ? "#fff" : "transparent"; });
    document.querySelectorAll("#capPos button").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.pos === cap.pos)); });
    $("capOn").checked = cap.on; $("capOn").disabled = !cap.words.length; $("capPer").value = String(cap.per); $("capFont").value = cap.font; $("capSize").value = cap.size; $("capSizeText").textContent = cap.size + "%"; $("capCaps").checked = cap.caps; $("capShake").checked = cap.shake;
    $("capGen").textContent = cap.words.length ? "Make captions again" : "Make captions for this clip";
    $("capNote").textContent = cap.words.length ? cap.words.length + " words, timed to the speech" : "Word by word, timed to the speech";
    renderTranscript();
    document.querySelectorAll("#layouts .preset").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.layout === c.layout)); });
    $("splitArea").hidden = c.layout !== "split"; $("cropArea").hidden = c.layout === "blur";
    $("splitRange").value = Math.round(c.split * 100); $("splitText").textContent = "Facecam " + Math.round(c.split * 100) + "%, gameplay " + (100 - Math.round(c.split * 100)) + "%";
    renderCropBoxes(); renderTextPanel(); renderZoomPanel();
    $("volRange").value = Math.round(c.audio.vol * 100); $("volText").textContent = Math.round(c.audio.vol * 100) + "%"; $("audHp").checked = c.audio.hp; $("audComp").checked = c.audio.comp;
    $("progressOn").checked = !!c.progress;
  }
  $("capOn").addEventListener("change", function () { capSet({ on: this.checked }); });
  $("capPer").addEventListener("change", function () { capSet({ per: +this.value }); });
  $("capFont").addEventListener("change", function () { capSet({ font: this.value }); });
  $("capSize").addEventListener("input", function () { clip().cap.size = +this.value; $("capSizeText").textContent = this.value + "%"; renderView(); });
  $("capSize").addEventListener("change", function () { commit(); });
  $("capCaps").addEventListener("change", function () { capSet({ caps: this.checked }); });
  $("capShake").addEventListener("change", function () { capSet({ shake: this.checked }); });
  document.querySelectorAll("#capPos button").forEach(function (b) { b.addEventListener("click", function () { capSet({ pos: b.dataset.pos }); }); });

  function renderTranscript() {
    var c = clip(), box = $("transcript"); box.textContent = ""; $("transcriptNote").hidden = !!c.cap.words.length;
    groupsFor(c).forEach(function (g) {
      var row = document.createElement("div"); row.style.cssText = "display:flex;gap:8px;align-items:center";
      var at = document.createElement("button"); at.type = "button"; at.className = "mono"; at.style.cssText = "background:none;border:0;color:var(--cyan);font-size:12px;width:46px;padding:0;text-align:left"; at.textContent = fmt(keptBefore(g.s)); at.title = "Jump here";
      at.addEventListener("click", function () { pause(); seek(g.s + .01); renderView(); });
      var inp = document.createElement("input"); inp.type = "text"; inp.value = g.words.map(function (w) { return w.w; }).join(" "); inp.setAttribute("aria-label", "Caption words at " + fmt(keptBefore(g.s)));
      inp.addEventListener("change", function () {
        var parts = inp.value.trim().split(/\s+/).filter(Boolean), all = c.cap.words, i0 = all.indexOf(g.words[0]), s = g.words[0].s, e = g.words[g.words.length - 1].e;
        var repl = parts.length === g.words.length ? g.words.map(function (w, k) { return { w: parts[k], s: w.s, e: w.e }; }) : parts.map(function (p, k) { return { w: p, s: s + (e - s) * k / parts.length, e: s + (e - s) * (k + 1) / parts.length }; });
        all.splice.apply(all, [i0, g.words.length].concat(repl)); groupCache.key = ""; commit(); renderRight(); renderView(); renderTimeline();
      });
      row.append(at, inp); box.appendChild(row);
    });
  }

  /* Auto captions: the clip's sound goes to the server as a small 16 kHz WAV. */
  async function clipWav(a, b) {
    var AC = window.OfflineAudioContext || window.webkitOfflineAudioContext, rate = 16000;
    var blob = await sourceBlob(1500 * 1024 * 1024);
    var audio = await new AC(1, rate, rate).decodeAudioData(await blob.arrayBuffer());
    var s0 = Math.max(0, Math.floor(a * rate)), s1 = Math.min(audio.length, Math.ceil(b * rate)), n = Math.max(0, s1 - s0), mix = new Float32Array(n), i;
    for (var ch = 0; ch < audio.numberOfChannels; ch++) { var d = audio.getChannelData(ch); for (i = 0; i < n; i++) mix[i] += d[s0 + i] / audio.numberOfChannels; }
    try {
      var off = new AC(1, Math.max(1, n), rate), src = off.createBufferSource(), buf = off.createBuffer(1, Math.max(1, n), rate);
      buf.copyToChannel(mix, 0); src.buffer = buf;
      var hp = off.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 90;
      var comp = off.createDynamicsCompressor(); comp.threshold.value = -38; comp.knee.value = 12; comp.ratio.value = 6; comp.attack.value = .004; comp.release.value = .2;
      src.connect(hp); hp.connect(comp); comp.connect(off.destination); src.start(); mix = (await off.startRendering()).getChannelData(0);
    } catch (e) {}
    var peak = 0; for (i = 0; i < n; i++) peak = Math.max(peak, Math.abs(mix[i])); if (peak > 0) { var gn = .95 / peak; for (i = 0; i < n; i++) mix[i] *= gn; }
    var out = new DataView(new ArrayBuffer(44 + n * 2)), str = function (o, t) { for (var k = 0; k < t.length; k++) out.setUint8(o + k, t.charCodeAt(k)); };
    str(0, "RIFF"); out.setUint32(4, 36 + n * 2, true); str(8, "WAVE"); str(12, "fmt "); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
    out.setUint32(24, rate, true); out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true); str(36, "data"); out.setUint32(40, n * 2, true);
    for (i = 0; i < n; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, mix[i])) * 32767, true);
    return new Blob([out.buffer], { type: "audio/wav" });
  }
  $("capGen").addEventListener("click", async function () {
    if (!E.loaded || E.exporting) return;
    if (!E.user) { needLogin("Log in to make auto captions."); return; }
    var c = clip(), a = c.a, b = c.b;
    if (b - a > 240) { status("Auto captions work on clips up to 4 minutes. Trim the clip first."); return; }
    var btn = this; btn.disabled = true; btn.textContent = "Listening to your clip..."; status("Listening to your clip. This takes a few seconds.");
    try {
      var wav = await clipWav(a, b);
      var r = await fetch("/api/captions", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav, credentials: "same-origin" }), d = {};
      try { d = await r.json(); } catch (e) {}
      if (!r.ok || !d.ok) { status(d.message || "Auto captions didn't work this time. Try again in a minute."); return; }
      var words = (d.words || []).map(function (w) { return { w: w.w, s: w.s + a, e: Math.max(w.e, w.s + .05) + a }; }).filter(function (w) { return w.s < b; });
      if (!words.length) { status("Cutline didn't hear any talking in this clip."); return; }
      c.cap.words = words; c.cap.range = [a, b]; c.cap.on = true; groupCache.key = ""; commit(); renderAll(); status("Captions made. Pick a style, and fix any word in the transcript.");
    } catch (e) { status("This video's sound couldn't be read for captions. Try an MP4 file."); }
    finally { btn.disabled = false; renderRight(); }
  });

  /* Layout crop boxes */
  var cropFrameAt = 0, cropCtx = $("cropCanvas").getContext("2d");
  function drawCropSource() {
    var cv = $("cropCanvas"); if (!video.videoWidth || $("cropArea").hidden) return;
    var now = performance.now(); if (E.playing && now - cropFrameAt < 250) return; cropFrameAt = now;
    if (cv.width !== 320) { cv.width = 320; cv.height = 180; }
    cropCtx.fillStyle = "#000"; cropCtx.fillRect(0, 0, 320, 180);
    var vw = video.videoWidth, vh = video.videoHeight, s = Math.min(320 / vw, 180 / vh); cropCtx.drawImage(video, (320 - vw * s) / 2, (180 - vh * s) / 2, vw * s, vh * s);
  }
  function boxDims(kind) {
    var c = clip(), sz = canvasSize(1), W = sz[0], H = sz[1];
    if (kind === "cam") return [W, H * c.split]; if (kind === "game" && c.layout === "split") return [W, H * (1 - c.split)];
    if (kind === "pip") return [1, 1]; return [W, H];
  }
  function renderCropBoxes() {
    var c = clip(), box = $("cropbox"); box.querySelectorAll(".crop").forEach(function (n) { n.remove(); }); if (!c || !E.src || !E.src.w) return;
    var kinds = c.layout === "split" ? ["cam", "game"] : c.layout === "pip" ? ["pip", "game"] : c.layout === "full" ? ["full"] : [];
    var sx = 1, sy = 1, ox = 0, oy = 0, vw = E.src.w, vh = E.src.h, s = Math.min(16 / vw, 9 / vh); sx = vw * s / 16; sy = vh * s / 9; ox = (1 - sx) / 2; oy = (1 - sy) / 2;
    kinds.forEach(function (k) {
      var cr = c.crops[k], d = boxDims(k), dim = cropAspect(cr, d[0], d[1]), el = document.createElement("div");
      el.className = "crop" + (k === "game" || k === "full" ? " game" : ""); el.innerHTML = "<span></span><i></i>";
      el.firstChild.textContent = k === "cam" || k === "pip" ? "Facecam" : "Gameplay";
      var place = function () { var dm = cropAspect(cr, d[0], d[1]); el.style.left = (ox + (cr.x - dm.w / 2) * sx) * 100 + "%"; el.style.top = (oy + (cr.y - dm.h / 2) * sy) * 100 + "%"; el.style.width = dm.w * sx * 100 + "%"; el.style.height = dm.h * sy * 100 + "%"; };
      place();
      el.addEventListener("pointerdown", function (e) {
        e.preventDefault(); el.setPointerCapture(e.pointerId);
        var rect = box.getBoundingClientRect(), resize = e.target.tagName === "I", x0 = e.clientX, y0 = e.clientY, start = Object.assign({}, cr);
        var move = function (ev) {
          var dx = (ev.clientX - x0) / rect.width / sx, dy = (ev.clientY - y0) / rect.height / sy;
          if (resize) { cr.w = clamp(start.w + dx * 2, .05, 1); } else { var dm = cropAspect(cr, d[0], d[1]); cr.x = clamp(start.x + dx, dm.w / 2, 1 - dm.w / 2); cr.y = clamp(start.y + dy, dm.h / 2, 1 - dm.h / 2); }
          var dm2 = cropAspect(cr, d[0], d[1]); cr.x = clamp(cr.x, dm2.w / 2, 1 - dm2.w / 2); cr.y = clamp(cr.y, dm2.h / 2, 1 - dm2.h / 2);
          place(); renderView();
        };
        var up = function () { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up); try { localStorage.setItem("cutline_crops", JSON.stringify(c.crops)); } catch (x) {} commit(); };
        el.addEventListener("pointermove", move); el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
      });
      box.appendChild(el);
    });
    cropFrameAt = 0; drawCropSource();
  }
  $("splitRange").addEventListener("input", function () { clip().split = this.value / 100; $("splitText").textContent = "Facecam " + this.value + "%, gameplay " + (100 - this.value) + "%"; renderCropBoxes(); renderView(); });
  $("splitRange").addEventListener("change", function () { commit(); });

  /* Text layers */
  var QUICK = { hook: ["Wait for it", "top", "pop", "box"], part2: ["Part 2?", "center", "pop", "pink"], follow: ["Follow for more", "bottom", "slide", "box"], blank: ["New text", "center", "pop", "box"] };
  document.querySelectorAll("[data-quick]").forEach(function (b) { b.addEventListener("click", function () { addText(b.dataset.quick); }); });
  function addText(kind) {
    if (!E.loaded) return; var c = clip(), q = QUICK[kind] || QUICK.blank, s, e;
    if (kind === "hook") { s = keptStart(); e = Math.min(keptEnd(), s + 3); }
    else if (kind === "part2" || kind === "follow") { e = keptEnd(); s = Math.max(keptStart(), e - 3); }
    else { s = clamp(E.t, c.a, c.b - .5); e = Math.min(c.b, s + 3); }
    var t = { id: uid(), text: q[0], s: s, e: e, pos: q[1], anim: q[2], look: q[3] }; c.texts.push(t); E.sel = { type: "text", id: t.id }; commit(); showTab("text"); renderAll(); $("txText").focus(); $("txText").select();
  }
  function selText() { var c = clip(); return E.sel && E.sel.type === "text" ? c.texts.filter(function (x) { return x.id === E.sel.id; })[0] : null; }
  function renderTextPanel() {
    var c = clip(), list = $("textList"); list.textContent = "";
    c.texts.slice().sort(function (x, y) { return x.s - y.s; }).forEach(function (t) {
      var b = document.createElement("button"); b.type = "button"; b.className = "card clipbtn"; b.setAttribute("aria-pressed", String(!!(E.sel && E.sel.id === t.id)));
      b.innerHTML = '<span class="bar"></span><span style="flex:1;min-width:0"><b></b><small class="mono"></small></span>';
      b.querySelector("b").textContent = t.text || "(empty)"; b.querySelector("small").textContent = fmt(keptBefore(t.s), true) + " to " + fmt(keptBefore(t.e), true);
      b.addEventListener("click", function () { E.sel = { type: "text", id: t.id }; pause(); seek(t.s + .05); renderAll(); });
      list.appendChild(b);
    });
    var t = selText(); $("textEdit").hidden = !t; if (!t) return;
    if (document.activeElement !== $("txText")) $("txText").value = t.text;
    $("txStart").textContent = fmt(keptBefore(t.s), true); $("txEnd").textContent = fmt(keptBefore(t.e), true); $("txAnim").value = t.anim;
    document.querySelectorAll("#txPos button").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.v === t.pos)); });
    document.querySelectorAll("#txLook button").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.v === t.look)); });
  }
  $("txText").addEventListener("input", function () { var t = selText(); if (!t) return; t.text = this.value; renderView(); renderTimeline(); });
  $("txText").addEventListener("change", function () { commit(); renderTextPanel(); });
  $("txStartHere").addEventListener("click", function () { var t = selText(); if (!t) return; t.s = clamp(E.t, clip().a, t.e - .2); commit(); renderAll(); });
  $("txEndHere").addEventListener("click", function () { var t = selText(); if (!t) return; t.e = clamp(E.t, t.s + .2, clip().b); commit(); renderAll(); });
  $("txAnim").addEventListener("change", function () { var t = selText(); if (!t) return; t.anim = this.value; commit(); renderView(); });
  document.querySelectorAll("#txPos button").forEach(function (b) { b.addEventListener("click", function () { var t = selText(); if (!t) return; t.pos = b.dataset.v; commit(); renderTextPanel(); renderView(); }); });
  document.querySelectorAll("#txLook button").forEach(function (b) { b.addEventListener("click", function () { var t = selText(); if (!t) return; t.look = b.dataset.v; commit(); renderTextPanel(); renderView(); }); });
  $("txDelete").addEventListener("click", function () { deleteSelection(); });
  $("progressOn").addEventListener("change", function () { clip().progress = this.checked; commit(); renderView(); });

  /* Zoom points */
  var SCALES = [[1, "Back to 100%"], [1.15, "In to 115%"], [1.3, "In to 130%"], [1.5, "In to 150%"], [1.8, "In to 180%"]];
  function addZoom(t, scale) { var c = clip(), z = { id: uid(), t: clamp(t, c.a, c.b), scale: scale || 1.3 }; c.zooms.push(z); return z; }
  $("addZoomBtn").addEventListener("click", function () { if (!E.loaded) return; var z = addZoom(E.t, 1.3); E.sel = { type: "zoom", id: z.id }; commit(); renderAll(); status("Zoom point added. Add another later in the clip set to 100% to zoom back out."); });
  $("autoZoomBtn").addEventListener("click", function () {
    if (!E.loaded) return; if (!E.env) { status("This video's sound couldn't be read, so loud parts can't be found. Add zoom points by hand."); return; }
    var c = clip(), peaks = [], k;
    for (k = Math.ceil(keptStart() * ENV_RATE); k < Math.floor(keptEnd() * ENV_RATE); k++) { var t = k / ENV_RATE; if (cutAt(t)) continue; var v = E.env[k]; if (v > .7 && v >= (E.env[k - 1] || 0) && v >= (E.env[k + 1] || 0)) peaks.push({ t: t, v: v }); }
    peaks.sort(function (x, y) { return y.v - x.v; }); var picks = [];
    peaks.forEach(function (p) { if (picks.length < 3 && picks.every(function (q) { return Math.abs(q.t - p.t) > 3.5; })) picks.push(p); });
    if (!picks.length) { status("No big spikes in this clip. Add zoom points by hand with Z."); return; }
    c.zooms = c.zooms.filter(function (z) { return !z.auto; });
    picks.forEach(function (p) { var a = addZoom(p.t - .15, 1.3); a.auto = true; var b = addZoom(Math.min(p.t + 1.6, keptEnd() - .1), 1); b.auto = true; });
    commit(); renderAll(); status("Added " + picks.length + (picks.length === 1 ? " zoom" : " zooms") + " on the loudest parts.");
  });
  function renderZoomPanel() {
    var c = clip(), list = $("zoomList"); list.textContent = ""; $("zoomEmpty").hidden = !!c.zooms.length;
    c.zooms.slice().sort(function (x, y) { return x.t - y.t; }).forEach(function (z) {
      var row = document.createElement("div"); row.className = "card"; row.style.cssText = "padding:8px 10px;display:flex;align-items:center;gap:8px" + (E.sel && E.sel.id === z.id ? ";border-color:var(--cyan)" : "");
      var at = document.createElement("button"); at.type = "button"; at.className = "mono"; at.style.cssText = "background:none;border:0;color:var(--cyan);font-size:12.5px;width:52px;padding:0;text-align:left"; at.textContent = fmt(keptBefore(z.t), true);
      at.addEventListener("click", function () { E.sel = { type: "zoom", id: z.id }; pause(); seek(z.t); renderAll(); });
      var sel = document.createElement("select"); sel.setAttribute("aria-label", "Zoom at " + fmt(keptBefore(z.t), true)); SCALES.forEach(function (s) { var o = new Option(s[1], s[0]); o.selected = Math.abs(s[0] - z.scale) < .01; sel.add(o); });
      sel.addEventListener("change", function () { z.scale = +sel.value; commit(); renderView(); });
      var del = document.createElement("button"); del.type = "button"; del.className = "btn icon"; del.textContent = "×"; del.setAttribute("aria-label", "Delete zoom point");
      del.addEventListener("click", function () { c.zooms = c.zooms.filter(function (x) { return x !== z; }); commit(); renderAll(); });
      row.append(at, sel, del); list.appendChild(row);
    });
  }

  /* Audio controls */
  $("volRange").addEventListener("input", function () { clip().audio.vol = this.value / 100; $("volText").textContent = this.value + "%"; applyAudio(); });
  $("volRange").addEventListener("change", function () { commit(); });
  $("audHp").addEventListener("change", function () { clip().audio.hp = this.checked; applyAudio(); commit(); });
  $("audComp").addEventListener("change", function () { clip().audio.comp = this.checked; applyAudio(); commit(); });

  /* ---------- Timeline ---------- */
  function tx(t) { var c = clip(); return (t - c.a) / (c.b - c.a) * 100; }
  function timeFromX(clientX) { var r = $("tlInner").getBoundingClientRect(), c = clip(); return c.a + clamp((clientX - r.left) / r.width, 0, 1) * (c.b - c.a); }
  function renderTimeline() {
    var c = clip(); if (!c) return;
    $("tlInner").style.width = (E.tlZoom * 100) + "%";
    var ruler = $("ruler"); ruler.textContent = ""; var len = c.b - c.a, wpx = $("tlScroll").clientWidth * E.tlZoom || 800;
    var step = [.5, 1, 2, 5, 10, 15, 30, 60].filter(function (s) { return s / len * wpx >= 56; })[0] || 60;
    for (var t = Math.ceil(c.a / step) * step; t <= c.b + .001; t += step) { var sp = document.createElement("span"); sp.style.left = tx(t) + "%"; sp.textContent = fmt(t - c.a, step < 1); ruler.appendChild(sp); }
    var tv = $("trVideo"); tv.textContent = "";
    c.segs.forEach(function (g, i) {
      var el = document.createElement("div"); el.className = "seg" + (g.cut ? " cut" : "") + (E.sel && E.sel.type === "seg" && E.sel.i === i ? " sel" : "");
      el.style.left = tx(g.s) + "%"; el.style.width = (tx(g.e) - tx(g.s)) + "%";
      if (!g.cut && E.env) { var cv = document.createElement("canvas"); el.appendChild(cv); requestAnimationFrame(function () { drawSegWave(cv, g); }); }
      el.addEventListener("pointerdown", function (e) { if (e.button) return; E.sel = { type: "seg", i: i }; renderTimeline(); });
      tv.appendChild(el);
      if (i) { var sl = document.createElement("div"); sl.className = "splitline"; sl.style.left = tx(g.s) + "%"; sl.title = "Drag to move this split"; dragSplit(sl, i); tv.appendChild(sl); }
    });
    var tc = $("trCaps"); tc.textContent = "";
    if (c.cap.words.length) c.cap.words.forEach(function (w) { if (w.e < c.a || w.s > c.b) return; var el = document.createElement("div"); el.className = "word"; el.style.left = tx(w.s) + "%"; el.style.width = Math.max(.3, tx(w.e) - tx(w.s)) + "%"; el.textContent = w.w; tc.appendChild(el); });
    var tt = $("trText"); tt.textContent = "";
    c.texts.forEach(function (t) {
      var el = document.createElement("div"); el.className = "tblock" + (E.sel && E.sel.id === t.id ? " sel" : ""); el.style.left = tx(t.s) + "%"; el.style.width = (tx(t.e) - tx(t.s)) + "%";
      el.innerHTML = '<b class="l"></b><span></span><b class="r"></b>'; el.querySelector("span").textContent = t.text || "Text"; el.title = "Drag to move. Drag an edge to change how long it shows.";
      dragBlock(el, t); tt.appendChild(el);
    });
    var tz = $("trZoom"); tz.textContent = "";
    c.zooms.forEach(function (z) { var el = document.createElement("button"); el.type = "button"; el.className = "zdot" + (E.sel && E.sel.id === z.id ? " sel" : ""); el.style.left = tx(z.t) + "%"; el.setAttribute("aria-label", "Zoom to " + Math.round(z.scale * 100) + "% at " + fmt(keptBefore(z.t), true)); dragZoom(el, z); tz.appendChild(el); });
    var cuts = c.segs.filter(function (g) { return g.cut; }).length;
    $("tlNote").textContent = (cuts ? fmt(keptLength(), true) + " kept of " + fmt(c.b - c.a, true) + ", " + cuts + (cuts === 1 ? " piece cut" : " pieces cut") : fmt(c.b - c.a, true) + " clip");
    $("cutBtn").disabled = c.segs.length < 2; $("resetCutsBtn").disabled = !cuts && c.segs.length < 2;
    $("playhead").style.left = tx(E.t) + "%";
    renderSrcStrip();
  }
  function drawSegWave(cv, g) {
    var r = cv.getBoundingClientRect(); if (!r.width || !E.env) return; cv.width = Math.round(r.width); cv.height = 36; var cx = cv.getContext("2d");
    var gr = cx.createLinearGradient(0, 0, cv.width, 0); gr.addColorStop(0, "#ff2e88"); gr.addColorStop(1, "#8a5cff"); cx.fillStyle = gr;
    for (var x = 0; x < cv.width; x += 3) { var t = g.s + (g.e - g.s) * x / cv.width, h = Math.max(2, envAt(t) * 32); cx.fillRect(x, 18 - h / 2, 2, h); }
  }
  function drag(el, onMove, onUp) {
    el.addEventListener("pointerdown", function (e) {
      if (e.button) return; e.preventDefault(); e.stopPropagation(); el.setPointerCapture(e.pointerId); pause();
      var x0 = e.clientX, moved = false, kind = e.target.tagName === "B" ? e.target.className : "body";
      var mv = function (ev) { moved = true; var r = $("tlInner").getBoundingClientRect(), c = clip(); onMove((ev.clientX - x0) / r.width * (c.b - c.a), kind, ev); };
      var up = function () { el.removeEventListener("pointermove", mv); el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up); onUp(moved); };
      el.addEventListener("pointermove", mv); el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
    });
  }
  function dragSplit(el, i) {
    var c = clip(), L = c.segs[i - 1], R = c.segs[i], s0 = R.s;
    drag(el, function (d) { var t = clamp(s0 + d, L.s + .2, R.e - .2); L.e = t; R.s = t; seek(t); el.style.left = tx(t) + "%"; renderView(); }, function () { commit(); renderTimeline(); });
  }
  function dragBlock(el, t) {
    var s0, e0;
    el.addEventListener("pointerdown", function () { s0 = t.s; e0 = t.e; E.sel = { type: "text", id: t.id }; document.querySelectorAll(".tblock").forEach(function (n) { n.classList.toggle("sel", n === el); }); }, true);
    drag(el, function (d, kind) {
      var c = clip();
      if (kind === "l") t.s = clamp(s0 + d, c.a, t.e - .2); else if (kind === "r") t.e = clamp(e0 + d, t.s + .2, c.b);
      else { var len = e0 - s0; t.s = clamp(s0 + d, c.a, c.b - len); t.e = t.s + len; }
      el.style.left = tx(t.s) + "%"; el.style.width = (tx(t.e) - tx(t.s)) + "%"; seek(kind === "r" ? t.e - .05 : t.s + .05); renderView();
    }, function () { commit(); showTab("text"); renderAll(); });
  }
  function dragZoom(el, z) {
    var t0;
    el.addEventListener("pointerdown", function () { t0 = z.t; E.sel = { type: "zoom", id: z.id }; }, true);
    drag(el, function (d) { var c = clip(); z.t = clamp(t0 + d, c.a, c.b); el.style.left = tx(z.t) + "%"; seek(z.t); renderView(); }, function () { commit(); showTab("zoom"); renderAll(); });
  }
  var inner = $("tlInner");
  inner.addEventListener("pointerdown", function (e) {
    if (e.button || !E.loaded || e.target.closest(".tblock,.zdot,.splitline")) return;
    var scrub = function (ev) { var t = timeFromX(ev.clientX); seek(cutAt(t) && E.playing ? nextKept(t) : t); $("playhead").style.left = tx(E.t) + "%"; renderView(); };
    if (!e.target.closest(".seg")) { E.sel = null; }
    scrub(e); inner.setPointerCapture(e.pointerId);
    var up = function () { inner.removeEventListener("pointermove", scrub); inner.removeEventListener("pointerup", up); renderTimeline(); renderRight(); };
    inner.addEventListener("pointermove", scrub); inner.addEventListener("pointerup", up);
  });
  $("tlZoom").addEventListener("input", function () { E.tlZoom = +this.value; renderTimeline(); });

  /* Source strip: the whole video, with this clip's part as a draggable box */
  function renderSrcStrip() {
    var st = $("srcStrip"), c = clip(); if (!c || !E.src.dur) return;
    st.querySelectorAll(".region,.other,.dot").forEach(function (n) { n.remove(); });
    var cv = $("srcWave"), r = st.getBoundingClientRect(); if (r.width && cv.width !== Math.round(r.width)) { cv.width = Math.round(r.width); cv.height = 26; }
    var cx = cv.getContext("2d"); cx.clearRect(0, 0, cv.width, cv.height); cx.fillStyle = "rgba(255,255,255,.22)";
    if (E.bins.length) for (var x = 0; x < cv.width; x += 3) { var h = Math.max(2, E.bins[Math.floor(x / cv.width * E.bins.length)] * 22); cx.fillRect(x, 13 - h / 2, 2, h); }
    var pct = function (t) { return t / E.src.dur * 100; };
    E.clips.forEach(function (o, i) { if (i === E.active) return; var d = document.createElement("div"); d.className = "other"; d.style.left = pct(o.a) + "%"; d.style.width = (pct(o.b) - pct(o.a)) + "%"; st.appendChild(d); });
    E.moments.forEach(function (m) { var d = document.createElement("div"); d.className = "dot"; d.style.left = pct(m.t + 1) + "%"; st.appendChild(d); });
    var reg = document.createElement("div"); reg.className = "region"; reg.innerHTML = '<b class="l" title="Clip start"></b><b class="r" title="Clip end"></b>';
    reg.style.left = pct(c.a) + "%"; reg.style.width = Math.max(.4, pct(c.b) - pct(c.a)) + "%"; st.appendChild(reg);
    reg.addEventListener("pointerdown", function (e) {
      if (e.button || E.exporting) return; e.preventDefault(); e.stopPropagation(); reg.setPointerCapture(e.pointerId); pause();
      var kind = e.target.tagName === "B" ? e.target.className : "body", x0 = e.clientX, a0 = c.a, b0 = c.b, w = st.getBoundingClientRect().width;
      var orig = JSON.stringify({ segs: c.segs, texts: c.texts, zooms: c.zooms });
      var mv = function (ev) {
        var d = (ev.clientX - x0) / w * E.src.dur;
        if (kind === "l") setRange(a0 + d, b0); else if (kind === "r") setRange(a0, b0 + d);
        else { var o = JSON.parse(orig); c.a = a0; c.b = b0; c.segs = o.segs; c.texts = o.texts; c.zooms = o.zooms; moveRange(a0 + d); }
        reg.style.left = pct(c.a) + "%"; reg.style.width = (pct(c.b) - pct(c.a)) + "%"; seek(kind === "r" ? c.b - .05 : c.a); renderView();
      };
      var up = function () { reg.removeEventListener("pointermove", mv); reg.removeEventListener("pointerup", up); c.cap.words = c.cap.words.filter(function (w) { return w.s >= c.a && w.e <= c.b; }); groupCache.key = ""; c.texts.forEach(function (t) { t.s = clamp(t.s, c.a, c.b - .2); t.e = clamp(t.e, t.s + .2, c.b); }); c.zooms = c.zooms.filter(function (z) { return z.t >= c.a && z.t <= c.b; }); commit(); renderAll(); };
      reg.addEventListener("pointermove", mv); reg.addEventListener("pointerup", up);
    });
  }
  $("srcStrip").addEventListener("pointerdown", function (e) {
    if (e.button || !E.loaded || E.exporting || e.target.closest(".region")) return;
    var r = this.getBoundingClientRect(), t = clamp((e.clientX - r.left) / r.width, 0, 1) * E.src.dur, c = clip();
    pause(); moveRange(t - (c.b - c.a) / 2); commit(); seek(keptStart()); renderAll();
  });

  /* Editing buttons */
  $("splitBtn").addEventListener("click", function () { if (E.loaded) splitAt(E.t); });
  $("cutBtn").addEventListener("click", function () { if (!E.loaded) return; toggleCut(E.sel && E.sel.type === "seg" ? E.sel.i : segAt(E.t)); });
  $("resetCutsBtn").addEventListener("click", function () { var c = clip(); c.segs = [{ s: c.a, e: c.b, cut: false }]; E.sel = null; commit(); renderAll(); status("All cuts undone."); });
  $("silenceBtn").addEventListener("click", function () {
    if (!E.loaded) return; if (!E.env) { status("This video's sound couldn't be read, so silences can't be found."); return; }
    var c = clip(), runs = [], start = null, k, lo = Math.ceil(c.a * ENV_RATE), hi = Math.floor(c.b * ENV_RATE);
    var level = 0; for (k = lo; k < hi; k++) level += E.env[k] || 0; level = level / Math.max(1, hi - lo); var thr = Math.max(.04, level * .22);
    for (k = lo; k <= hi; k++) { var q = k < hi && (E.env[k] || 0) < thr; if (q && start === null) start = k; if (!q && start !== null) { if ((k - start) / ENV_RATE >= .7) runs.push([start / ENV_RATE + .15, k / ENV_RATE - .15]); start = null; } }
    if (!runs.length) { status("No quiet gaps long enough to cut in this clip."); return; }
    runs.forEach(function (r) {
      [r[0], r[1]].forEach(function (t) { var i = segAt(t), g = c.segs[i]; if (t - g.s > .1 && g.e - t > .1) c.segs.splice(i, 1, { s: g.s, e: t, cut: g.cut }, { s: t, e: g.e, cut: g.cut }); });
      c.segs.forEach(function (g) { if (g.s >= r[0] - .01 && g.e <= r[1] + .01) g.cut = true; });
    });
    fitSegs(c); commit(); renderAll(); status("Cut out " + runs.length + (runs.length === 1 ? " quiet gap." : " quiet gaps.") + " Press Undo if it cut too much.");
  });
  function deleteSelection() {
    if (!E.sel) { toggleCut(segAt(E.t)); return; }
    var c = clip();
    if (E.sel.type === "seg") toggleCut(E.sel.i);
    else if (E.sel.type === "text") { c.texts = c.texts.filter(function (t) { return t.id !== E.sel.id; }); E.sel = null; commit(); renderAll(); status("Text deleted."); }
    else if (E.sel.type === "zoom") { c.zooms = c.zooms.filter(function (z) { return z.id !== E.sel.id; }); E.sel = null; commit(); renderAll(); status("Zoom point deleted."); }
  }

  /* ---------- Stage controls ---------- */
  $("playBtn").addEventListener("click", function () { E.playing ? pause() : play(); });
  $("backBtn").addEventListener("click", function () { seek(Math.max(clip().a, E.t - 1)); renderView(); });
  $("fwdBtn").addEventListener("click", function () { seek(Math.min(clip().b, E.t + 1)); renderView(); });
  document.querySelectorAll("[data-aspect]").forEach(function (b) { b.addEventListener("click", function () { if (E.exporting) return; E.aspect = b.dataset.aspect; document.querySelectorAll("[data-aspect]").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); }); $("screen").dataset.aspect = E.aspect; var a = ASPECTS[E.aspect]; $("exportRes").textContent = a[0] + "×" + a[1]; renderCropBoxes(); renderView(); }); });
  $("safeBtn").addEventListener("click", function () { E.safe = !E.safe; this.setAttribute("aria-pressed", String(E.safe)); renderView(); });
  $("undoBtn").addEventListener("click", undo); $("redoBtn").addEventListener("click", redo);
  $("newVideoBtn").addEventListener("click", function () { if (E.exporting) return; pause(); E.loaded = false; $("empty").hidden = false; $("emptyStatus").textContent = "Your edits on the last video are saved on this device."; renderAll(); });
  function toast(msg, action, fn) {
    var t = $("toast"); t.textContent = ""; var s = document.createElement("span"); s.textContent = msg; t.appendChild(s);
    if (action) { var b = document.createElement("button"); b.type = "button"; b.className = "btn go"; b.textContent = action; b.addEventListener("click", function () { t.hidden = true; fn(); }); t.appendChild(b); }
    var x = document.createElement("button"); x.type = "button"; x.className = "btn icon"; x.textContent = "×"; x.setAttribute("aria-label", "Dismiss"); x.addEventListener("click", function () { t.hidden = true; }); t.appendChild(x);
    t.hidden = false;
  }

  /* Keyboard shortcuts */
  document.addEventListener("keydown", function (e) {
    var tag = (e.target.tagName || "").toLowerCase(); if (tag === "input" || tag === "textarea" || tag === "select" || e.target.isContentEditable) return;
    if (!E.loaded || E.exporting) return;
    var mod = e.metaKey || e.ctrlKey, k = e.key;
    if (mod && (k === "z" || k === "Z")) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && (k === "y" || k === "Y")) { e.preventDefault(); redo(); return; }
    if (mod) return;
    if (k === " ") { e.preventDefault(); E.playing ? pause() : play(); }
    else if (k === "s" || k === "S") { e.preventDefault(); splitAt(E.t); }
    else if (k === "Backspace" || k === "Delete") { e.preventDefault(); deleteSelection(); }
    else if (k === "z" || k === "Z") { e.preventDefault(); $("addZoomBtn").click(); }
    else if (k === "t" || k === "T") { e.preventDefault(); addText("blank"); }
    else if (k === "i" || k === "I") { e.preventDefault(); setRange(E.t, clip().b); commit(); renderAll(); status("Clip now starts here."); }
    else if (k === "o" || k === "O") { e.preventDefault(); setRange(clip().a, E.t); commit(); renderAll(); status("Clip now ends here."); }
    else if (k === "j" || k === "J" || k === "l" || k === "L" || k === "ArrowLeft" || k === "ArrowRight") {
      e.preventDefault(); var d = (k === "j" || k === "J") ? -1 : (k === "l" || k === "L") ? 1 : (k === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 1 : .1);
      seek(clamp(E.t + d, clip().a, clip().b)); renderView(); $("playhead").style.left = tx(E.t) + "%";
    }
    else if (k === "Escape") { E.sel = null; renderAll(); }
  });

  /* ---------- Export ---------- */
  var recorder = null, exportCanvas = document.createElement("canvas"), exportCtx = null, claimId = null, canceled = false, lastResult = null;
  function pickType() { var l = ["video/mp4;codecs=avc1.640028,mp4a.40.2", "video/mp4;codecs=avc1.4D401F,mp4a.40.2", "video/mp4;codecs=avc1.42E01F,mp4a.40.2", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"]; for (var i = 0; i < l.length; i++) if (window.MediaRecorder && MediaRecorder.isTypeSupported(l[i])) return l[i]; return ""; }
  function needLogin(msg) { status(msg + " "); var a = document.createElement("a"); a.href = "/#login"; a.textContent = "Log in"; var b = document.createElement("a"); b.href = "/#signup"; b.textContent = "create a free account"; $("status").append(a, " or ", b, "."); }
  function finishExport() { E.playing = false; video.pause(); playIcon(); if (recorder && recorder.state !== "inactive") recorder.stop(); }
  function endExportUI() { E.exporting = false; $("exportBtn").disabled = !E.loaded; refreshAllowance(); document.body.style.cursor = ""; }
  async function api(path, body) { try { var r = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) }); var d = await r.json(); d.status = r.status; return d; } catch (e) { return { ok: false, message: "Couldn't reach Cutline. Check your connection." }; } }
  $("exportBtn").addEventListener("click", async function () {
    if (E.exporting) { canceled = "Export canceled."; finishExport(); return; }
    if (lastResult && lastResult.clipId === clip().id && lastResult.sig === snapshotClip()) { saveResult(); return; }
    if (!E.loaded) return;
    if (!E.user) { needLogin("Log in to export your clip."); return; }
    var type = view.captureStream ? pickType() : "";
    if (!type) { status("This browser can't export video. Use the latest Chrome or Edge on a computer."); return; }
    var sz = canvasSize(1); exportCanvas.width = sz[0]; exportCanvas.height = sz[1]; exportCtx = exportCanvas.getContext("2d");
    canceled = false; pause(); E.exporting = true; this.disabled = false; this.firstChild.textContent = "Cancel export ";
    try {
      var stream = exportCanvas.captureStream(30), g = audioGraph();
      if (g) { if (actx.state === "suspended") await actx.resume(); applyAudio(); g.dest.stream.getAudioTracks().forEach(function (t) { stream.addTrack(t); }); }
      var sought = waitSeek(); seek(keptStart()); await sought; drawFrame(exportCtx, sz[0], sz[1], E.t, true);
      var claim = await api("/api/clips/claim");
      if (!claim.ok) {
        stream.getVideoTracks().forEach(function (t) { t.stop(); }); endExportUI(); this.firstChild.textContent = "Export clip ";
        if (claim.code === "limit_reached") { status("You're out of clips. "); var a = document.createElement("a"); a.href = "/#pricing"; a.textContent = "Get more clips"; $("status").append(a); }
        else if (claim.code === "auth_required") needLogin("Your login expired."); else status(claim.message || "Couldn't start the export. Try again.");
        return;
      }
      claimId = claim.id; refreshAllowance();
      var chunks = [], btn = this; recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 12000000, audioBitsPerSecond: 192000 });
      recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.onstop = function () {
        stream.getVideoTracks().forEach(function (t) { t.stop(); }); endExportUI(); btn.firstChild.textContent = "Export clip ";
        if (canceled) { release(); status(canceled); return; }
        var blob = new Blob(chunks, { type: type.split(";")[0] }); if (!blob.size) { release(); status("Export failed. Try a shorter clip or the latest Chrome."); return; }
        var ext = type.indexOf("mp4") > -1 ? "mp4" : "webm", slug = clip().name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "clip";
        lastResult = { blob: blob, name: "cutline-" + slug + "." + ext, clipId: clip().id, sig: snapshotClip() }; claimId = null;
        clip().state = "Exported"; scheduleSave(); renderLeft(); saveResult();
        status("Your clip is ready (" + (blob.size / 1048576).toFixed(1) + " MB). If it didn't download, press Export clip again to save it.");
      };
      recorder.start(500); E.playing = true; playIcon(); await video.play();
    } catch (err) { endExportUI(); this.firstChild.textContent = "Export clip "; release(); E.playing = false; playIcon(); status("Export failed. Try a shorter clip or the latest Chrome."); }
  });
  function snapshotClip() { return JSON.stringify(clip()).replace(/"state":"[^"]*"/, ""); }
  function release() { if (!claimId) return; var id = claimId; claimId = null; api("/api/clips/release", { id: id }).then(refreshAllowance); }
  function saveResult() { if (!lastResult) return; var a = document.createElement("a"), u = URL.createObjectURL(lastResult.blob); a.href = u; a.download = lastResult.name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(u); }, 60000); }
  document.addEventListener("visibilitychange", function () { if (document.hidden && E.exporting) { canceled = "Export stopped because the tab was hidden. Keep this tab open and export again."; finishExport(); } });

  /* ---------- Account ---------- */
  async function refreshAllowance() {
    var el = $("allowance");
    try {
      var r = await fetch("/api/me", { credentials: "same-origin" }); if (!r.ok) throw new Error();
      var d = await r.json(); if (!d.ok) throw new Error(); E.user = d.user;
      var u = d.user, left = u.clipLimit == null ? null : Math.max(0, u.clipLimit - u.clipsUsed);
      el.textContent = left == null ? "Unlimited clips" : left + (u.plan === "free" ? " free" : "") + (left === 1 ? " clip" : " clips") + " left" + (u.coins ? ", " + u.coins + (u.coins === 1 ? " coin" : " coins") : "");
      el.hidden = false; $("loginLink").hidden = true;
    } catch (e) { E.user = null; el.hidden = true; $("loginLink").hidden = false; }
  }

  /* ---------- Wiring the empty state ---------- */
  $("fileInput").addEventListener("change", function (e) { loadFile(e.target.files[0]); e.target.value = ""; });
  $("demoBtn").addEventListener("click", function () { openVideo("example-video.mp4", "/demo.mp4", null, true); });
  $("linkForm").addEventListener("submit", function (e) { e.preventDefault(); loadLink($("linkInput").value); });
  ["dragenter", "dragover"].forEach(function (n) { document.addEventListener(n, function (e) { e.preventDefault(); $("drop").classList.add("over"); }); });
  ["dragleave", "drop"].forEach(function (n) { document.addEventListener(n, function (e) { e.preventDefault(); $("drop").classList.remove("over"); }); });
  document.addEventListener("drop", function (e) { if (E.exporting) return; var f = e.dataTransfer && e.dataTransfer.files[0]; if (f) { $("empty").hidden = false; loadFile(f); } });
  window.addEventListener("beforeunload", function (e) { if (E.exporting) { e.preventDefault(); e.returnValue = ""; } });
  addEventListener("resize", function () { renderTimeline(); });

  function renderAll() {
    $("exportBtn").disabled = !E.loaded && !E.exporting;
    renderLeft();
    if (!E.loaded || !clip()) return;
    renderRight(); renderTimeline(); renderView(); applyAudio();
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { if (E.loaded) renderView(); });
  refreshAllowance(); renderAll(); requestAnimationFrame(frame);
  window.CutlineEditor = E; /* for debugging in the browser console */
})();
