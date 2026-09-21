(function () {
  var CK = window.CK || {};
  var EPS = (CK.episodes || []).slice().sort(function (a, b) { return a.id - b.id; });
  var ARCS = CK.arcs || [];
  var CHARS = CK.characters || [];
  var ARC_MAP = {};
  ARCS.forEach(function (a) { ARC_MAP[a.id] = a; });

  /* 万不得已加载不出来时，只显示一个「缺图」提示，不用自绘形象冒充角色 */
  var NOIMG = "data:image/svg+xml;utf8," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#F1ECE6"/><text x="50" y="55" font-size="12" text-anchor="middle" fill="#B6AAA2">缺图</text></svg>');

  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function hl(text, kw) {
    var t = esc(text);
    if (!kw) return t;
    try {
      return t.replace(new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), function (m) { return "<mark>" + m + "</mark>"; });
    } catch (e) { return t; }
  }
  function seasonOf(id) { return id <= 120 ? 1 : (id <= 240 ? 2 : 3); }
  var SEASON_LABEL = {
    1: "中文引进版 第一季（第 1–120 话）",
    2: "中文引进版 第二季（第 121–240 话）",
    3: "中文引进版尚未覆盖（第 241–345 话）"
  };
  function confBadge(c) {
    return c === "A"
      ? '<span class="badge-lv a">可信度 A · 有资料支撑</span>'
      : '<span class="badge-lv">可信度 B · 依据标题与设定整理</span>';
  }
  function arcTags(ids) {
    return (ids || []).map(function (id) {
      var a = ARC_MAP[id];
      if (!a) return "";
      return '<a class="tag pk" href="arcs.html#' + a.id + '">' + esc(a.cn) + "</a>";
    }).join("");
  }
  function imgTag(src, alt, cls) {
    return '<img src="' + esc(src) + '" alt="' + esc(alt) + '"' + (cls ? ' class="' + cls + '"' : "") +
      ' onerror="this.onerror=null;this.src=\'' + NOIMG + '\'">';
  }

  /* 把主色朝白色方向混，得到柔和的同色系浅色 */
  function soften(hex, k) {
    var h = String(hex || "#E4698F").replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var r = parseInt(h.substr(0, 2), 16), g = parseInt(h.substr(2, 2), 16), b = parseInt(h.substr(4, 2), 16);
    function mix(c) { return Math.round(c + (255 - c) * k); }
    return "rgb(" + mix(r) + "," + mix(g) + "," + mix(b) + ")";
  }

  /* 官方没有立绘的角色：统一用同一款占位符，不画角色形象 */
  function phArt(c) {
    var col = c.color || "#E4698F";
    var svg = '<svg class="ph-svg" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" aria-hidden="true">' +
      '<circle cx="50" cy="44" r="26" fill="#fff" stroke="' + soften(col, 0.45) +
      '" stroke-width="1.8" stroke-dasharray="5.5 4.5"/>' +
      '<text x="50" y="44" dy="0.34em" text-anchor="middle" font-size="25" font-weight="800" fill="' + col + '">' +
      esc(c.cn.slice(0, 1)) + "</text>" +
      '<text x="50" y="82" dy="0.32em" text-anchor="middle" font-size="7" letter-spacing="0.6" fill="#BDB1A9">' +
      "暂无官方立绘</text>" +
      "</svg>";
    return '<div class="char-ph" style="background:' + soften(col, 0.94) + '">' + svg + "</div>";
  }
  function charArtHTML(c) { return c.img ? imgTag(c.img, c.cn) : phArt(c); }

  /* ---------- 导航高亮 ---------- */
  (function () {
    var here = location.pathname.split("/").pop() || "index.html";
    $$(".nav-links a").forEach(function (a) {
      var href = a.getAttribute("href");
      if (href === here || (here === "index.html" && href === "index.html")) a.classList.add("on");
      if (here === "episode.html" && href === "episodes.html") a.classList.add("on");
    });
  })();

  /* ================= 首页 ================= */
  function initHome() {
    var box = $("#today");
    if (!box) return;
    if (!EPS.length) { box.innerHTML = '<p class="muted">剧集数据加载中……</p>'; return; }
    var d = new Date();
    var seed = d.getFullYear() * 372 + (d.getMonth() + 1) * 31 + d.getDate();
    var ep = EPS[seed % EPS.length];
    var s = ep.sh[0];
    var l = (s.l && s.l[0]) || null;
    box.innerHTML =
      '<div class="lab">今日随机一话</div>' +
      '<h3>第 ' + ep.id + ' 话 · ' + esc(ep.cn) + "</h3>" +
      '<p>' + esc(s.s.length > 130 ? s.s.slice(0, 130) + "……" : s.s) + "</p>" +
      (l ? '<p style="margin-top:10px"><b style="color:var(--pink-dark)">' + esc(l.w) + "：</b>" + esc(l.x) + "</p>" : "") +
      '<div class="acts"><a class="btn" href="episodes.html#' + ep.id + '">看这一话的完整剧情</a>' +
      '<a class="btn ghost" href="search.html">搜台词</a></div>';

    var st = $("#stats");
    if (st) {
      var shorts = 0, lines = 0;
      EPS.forEach(function (e) { e.sh.forEach(function (x) { shorts++; lines += (x.l || []).length; }); });
      st.innerHTML = [
        ["120", "话已收录"],
        [shorts, "个短篇剧情"],
        [lines, "条台词记录"],
        [CHARS.length, "位角色档案"]
      ].map(function (p) { return '<div class="stat"><b>' + p[0] + "</b><span>" + p[1] + "</span></div>"; }).join("");
    }
  }

  /* ================= 剧集总览 ================= */
  function initEpisodes() {
    var list = $("#ep-list");
    if (!list) return;
    var input = $("#q"), selArc = $("#f-arc"), selConf = $("#f-conf"), selSeason = $("#f-season");
    var state = { kw: "", arc: "all", conf: "all", season: "all" };

    var arcSet = {};
    EPS.forEach(function (e) { (e.a || []).forEach(function (id) { arcSet[id] = (arcSet[id] || 0) + 1; }); });
    if (selArc) {
      Object.keys(arcSet).forEach(function (id) {
        var a = ARC_MAP[id]; if (!a) return;
        var o = document.createElement("option");
        o.value = id; o.textContent = a.cn + "（" + arcSet[id] + " 话）";
        selArc.appendChild(o);
      });
    }

    function matches(e) {
      if (state.season !== "all" && seasonOf(e.id) !== Number(state.season)) return false;
      if (state.arc !== "all" && (e.a || []).indexOf(state.arc) < 0) return false;
      if (state.conf !== "all") {
        var has = e.sh.some(function (s) { return s.c === state.conf; });
        if (!has) return false;
      }
      if (!state.kw) return true;
      var k = state.kw.toLowerCase();
      if (("第" + e.id + "话 " + e.cn + " " + e.jp).toLowerCase().indexOf(k) >= 0) return true;
      return e.sh.some(function (s) {
        if ((s.t + " " + s.s).toLowerCase().indexOf(k) >= 0) return true;
        return (s.l || []).some(function (l) { return (l.w + l.x).toLowerCase().indexOf(k) >= 0; });
      });
    }

    function epHTML(e, kw) {
      var body = e.sh.map(function (s) {
        var lines = (s.l || []).length
          ? s.l.map(function (l) {
              return '<div class="line"><span class="who' + (l.k === "a" ? " act" : "") + '">' + esc(l.w) + '：</span><span class="txt">' + hl(l.x, kw) + "</span></div>";
            }).join("")
          : '<div class="empty">（本段落暂无台词记录）</div>';
        return '<div class="short">' +
          '<div class="short-head"><h4>' + hl(s.t, kw) + "</h4>" + confBadge(s.c) + "</div>" +
          "<p>" + hl(s.s, kw) + "</p>" +
          '<div class="lines"><div class="lt">台词与行为记录（角色名：内容）</div>' + lines + "</div>" +
          "</div>";
      }).join("");
      return '<article class="ep" id="ep-' + e.id + '">' +
        '<div class="ep-head" role="button" tabindex="0">' +
        '<div class="ep-no"><small>第</small><b>' + e.id + "</b></div>" +
        '<div class="ep-main">' +
        '<div class="cn">' + hl(e.cn, kw) + "</div>" +
        '<div class="jp">' + esc(e.jp) + "</div>" +
        '<div class="ep-meta"><span class="tag bl">' + esc(e.d) + "</span>" +
        '<span class="tag pu" title="' + esc(SEASON_LABEL[seasonOf(e.id)]) + '">中文版第 ' + seasonOf(e.id) + " 季</span>" +
        (e.a && e.a.length ? arcTags(e.a) : '<span class="tag gy">单话</span>') +
        "<span class=\"tag gy\">" + e.sh.length + " 个短篇</span></div>" +
        "</div>" +
        '<div class="ep-arrow">▾</div>' +
        "</div>" +
        '<div class="ep-body">' + body + "</div>" +
        "</article>";
    }

    function render() {
      var hits = EPS.filter(matches);
      $("#res-count").textContent = "共 " + hits.length + " 话";
      list.innerHTML = hits.length
        ? hits.map(function (e) { return epHTML(e, state.kw); }).join("")
        : '<div class="empty-state"><div class="big">🐰</div><p>没有找到符合条件的话数，换个关键词试试。</p></div>';
    }

    list.addEventListener("click", function (ev) {
      var head = ev.target.closest(".ep-head");
      if (!head) return;
      head.parentElement.classList.toggle("open");
    });
    list.addEventListener("keydown", function (ev) {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      var head = ev.target.closest(".ep-head");
      if (!head) return;
      ev.preventDefault();
      head.parentElement.classList.toggle("open");
    });

    $$(".chip[data-arc]").forEach(function (c) {
      c.addEventListener("click", function () {
        $$(".chip[data-arc]").forEach(function (x) { x.classList.remove("on"); });
        c.classList.add("on");
        state.arc = c.getAttribute("data-arc");
        if (selArc) selArc.value = state.arc;
        render();
      });
    });
    if (input) input.addEventListener("input", function () { state.kw = input.value.trim(); render(); });
    if (selArc) selArc.addEventListener("change", function () {
      state.arc = selArc.value;
      $$(".chip[data-arc]").forEach(function (x) { x.classList.toggle("on", x.getAttribute("data-arc") === state.arc); });
      render();
    });
    if (selConf) selConf.addEventListener("change", function () { state.conf = selConf.value; render(); });
    if (selSeason) selSeason.addEventListener("change", function () { state.season = selSeason.value; render(); });

    render();
    var hash = location.hash.replace("#", "");
    if (hash) {
      if (/^arc:/.test(hash)) {
        state.arc = hash.slice(4);
        if (selArc) selArc.value = state.arc;
        render();
      } else {
        var m = document.getElementById("ep-" + hash);
        if (m) { m.classList.add("open"); setTimeout(function () { m.scrollIntoView({ block: "center" }); }, 60); }
      }
    }
  }

  /* ================= 篇章地图 ================= */
  function initArcs() {
    var box = $("#arc-list");
    if (!box) return;
    var done = ARCS.filter(function (a) { return a.status === "done"; }).length;
    var note = $("#arc-note");
    if (note) note.textContent = "共 " + ARCS.length + " 个长篇，已全部按起止话数逐集写入第 1–345 话的剧集内容，点进去可以直接看该篇章的每一话。";
    var list = ARCS.slice().sort(function (a, b) { return a.start - b.start; });
    box.innerHTML = list.map(function (a) {
      return '<div class="arc ' + (a.status === "later" ? "later" : "") + '" id="' + a.id + '">' +
        '<div class="arc-card">' +
        '<div class="arc-top"><h3>' + esc(a.cn) + "</h3>" +
        '<span class="jp">' + esc(a.jp) + "</span>" +
        '<span class="tag ' + (a.status === "done" ? "pk" : "gy") + '">' + esc(a.tag) + "</span>" +
        (a.highlight ? '<span class="tag yl">重点</span>' : "") +
        '<span class="range">第 ' + a.start + "–" + a.end + " 话</span></div>" +
        "<p>" + esc(a.summary) + "</p>" +
        '<div style="margin-top:12px"><a class="btn ghost" href="episodes.html#arc:' + a.id + '">看这个篇章的话数 →</a></div>' +
        "</div></div>";
    }).join("");
  }

  /* ================= 角色图鉴 ================= */
  function initChars() {
    var box = $("#chars");
    if (!box) return;
    box.innerHTML = CHARS.map(function (c) {
      return '<article class="char" data-id="' + c.id + '">' +
        '<div class="char-img' + (c.img ? "" : " ph") + '">' + charArtHTML(c) + "</div>" +
        '<div class="char-info"><h3>' + esc(c.cn) + "</h3>" +
        '<div class="jp">' + esc(c.jp) + (c.romaji ? " / " + esc(c.romaji) : "") + "</div>" +
        '<div class="tags"><span class="tag pk">' + esc(c.role) + "</span>" +
        c.tags.slice(0, 2).map(function (t) { return '<span class="tag">' + esc(t) + "</span>"; }).join("") +
        "</div></div></article>";
    }).join("");

    var modal = $("#char-detail");
    box.addEventListener("click", function (ev) {
      var el = ev.target.closest(".char");
      if (!el) return;
      var c = CHARS.filter(function (x) { return x.id === el.getAttribute("data-id"); })[0];
      if (!c) return;
      $("#cd-body").innerHTML =
        '<div class="top' + (c.img ? "" : " ph") + '">' +
        charArtHTML(c) +
        '<div class="meta"><h3>' + esc(c.cn) + "</h3>" +
        '<div class="jp">' + esc(c.jp) + " / " + esc(c.romaji) + "</div>" +
        "<dl><dt>定位</dt><dd>" + esc(c.role) + "</dd>" +
        "<dt>日配</dt><dd>" + esc(c.cvJp) + "</dd>" +
        "<dt>中配</dt><dd>" + esc(c.cvCn) + "</dd>" +
        "<dt>标签</dt><dd>" + c.tags.map(esc).join("、") + "</dd>" +
        "<dt>代表话数</dt><dd>" + c.eps.map(function (n) { return '<a class="tag bl" href="episodes.html#' + n + '">第 ' + n + " 话</a>"; }).join(" ") + "</dd></dl>" +
        "</div></div>" +
        '<div class="bd"><p>' + esc(c.intro) + "</p>" +
        '<div class="q">' + esc(c.line) + "</div>" +
        '<div style="margin-top:14px"><a class="btn ghost" href="search.html?q=' + encodeURIComponent(c.cn) + '">搜这个词的全部记录 →</a></div></div>';
      modal.classList.add("on");
    });
    $$("[data-close]", modal).forEach(function (b) {
      b.addEventListener("click", function () { modal.classList.remove("on"); });
    });
    modal.addEventListener("click", function (ev) { if (ev.target === modal) modal.classList.remove("on"); });
    document.addEventListener("keydown", function (ev) { if (ev.key === "Escape") modal.classList.remove("on"); });
  }

  /* ================= 台词搜索 ================= */
  function initSearch() {
    var input = $("#sq"), out = $("#s-out"), cnt = $("#s-count");
    if (!input || !out) return;

    var INDEX = [];
    EPS.forEach(function (e) {
      INDEX.push({ ep: e.id, epCn: e.cn, kind: "话数标题", who: "", text: e.cn + "（" + e.jp + "）", t: e.cn });
      e.sh.forEach(function (s) {
        INDEX.push({ ep: e.id, epCn: e.cn, kind: "剧情概要", who: "", text: s.s, t: s.t });
        (s.l || []).forEach(function (l) {
          INDEX.push({ ep: e.id, epCn: e.cn, kind: l.k === "t" ? "台词" : "行为", who: l.w, text: l.x, t: s.t });
        });
      });
    });
    ARCS.forEach(function (a) {
      INDEX.push({ ep: a.start, epCn: a.cn, kind: "篇章", who: "", text: a.summary, t: a.cn, arc: a.id });
    });
    CHARS.forEach(function (c) {
      INDEX.push({ ep: c.eps[0], epCn: c.eps[0] + " 话附近", kind: "角色", who: c.cn, text: c.intro, t: c.cn });
    });

    function run(kw) {
      kw = (kw || "").trim();
      if (kw.length < 1) {
        out.innerHTML = '<div class="empty-state"><div class="big">🔍</div><p>输入角色名、关键词或者一句台词，就能翻出全部相关记录。<br>比如：<b>哈奇喵</b>、<b>除草检定</b>、<b>缎带</b>、<b>乌萨奇</b>。</p></div>';
        cnt.textContent = "";
        return;
      }
      var k = kw.toLowerCase();
      var hits = INDEX.filter(function (r) {
        return (r.text + " " + r.who + " " + r.t + " " + r.epCn).toLowerCase().indexOf(k) >= 0;
      });
      var shown = hits.slice(0, 300);
      cnt.textContent = hits.length
        ? "命中 " + hits.length + " 条" + (hits.length > 300 ? "（仅显示前 300 条）" : "")
        : "";
      out.innerHTML = shown.length
        ? shown.map(function (r) {
            var snippet = r.text;
            var i = snippet.toLowerCase().indexOf(k);
            if (i > 60) snippet = "……" + snippet.slice(i - 50);
            if (snippet.length > 200) snippet = snippet.slice(0, 200) + "……";
            return '<div class="hit"><div class="h-top">' +
              '<span class="tag gy">' + esc(r.kind) + "</span> " +
              (r.who ? "<b>（" + esc(r.who) + "）</b> " : "") +
              "第 " + r.ep + " 话 · " + esc(r.epCn) + " · " + esc(r.t) +
              '</div><div class="h-body">' +
              (r.who ? "<b>" + hl(r.who, kw) + "：</b>" : "") + hl(snippet, kw) +
              '</div><div style="margin-top:9px"><a class="tag pk" href="episodes.html#' + (r.arc ? "arc:" + r.arc : r.ep) + '">跳到第 ' + r.ep + " 话 →</a></div></div>";
          }).join("")
        : '<div class="empty-state"><div class="big">🐰</div><p>没有找到「' + esc(kw) + "」相关的记录。</p></div>";
    }

    var q0 = new URLSearchParams(location.search).get("q");
    if (q0) { input.value = q0; run(q0); } else { run(""); }
    input.addEventListener("input", function () { run(input.value); });

    window.CKSearch = run;
  }

  document.addEventListener("DOMContentLoaded", function () {
    initHome(); initEpisodes(); initArcs(); initChars(); initSearch();
  });
})();
