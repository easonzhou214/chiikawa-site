#!/usr/bin/env node
"use strict";

/*
 * 吉伊卡哇资料库 · 数据服务（stdio 形态）
 *
 * 无端口、无监听、无依赖。宿主按需拉起本进程，通过标准输入输出收发 JSON-RPC。
 * 契约见 ../README.md，实现说明见 ./implementation-notes.md。
 * 数据目录默认取工程根的 js/，可用环境变量 CHIIKAWA_DATA_DIR 覆盖。
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_NAME = "chiikawa-archive";
const SERVER_VERSION = "0.2.0";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/* ------------------------------------------------------------------ 装载 */

function resolveDataDir() {
  if (process.env.CHIIKAWA_DATA_DIR) return path.resolve(process.env.CHIIKAWA_DATA_DIR);
  return path.resolve(__dirname, "..", "..", "js");
}

function loadArchive() {
  const dir = resolveDataDir();
  if (!fs.existsSync(dir)) {
    throw new Error("找不到数据目录 " + dir + "（可用环境变量 CHIIKAWA_DATA_DIR 指定）");
  }
  const files = fs.readdirSync(dir)
    .filter((f) => /^(episodes-|data-).*\.js$/.test(f))
    .sort();
  if (!files.length) throw new Error("数据目录里没有数据文件 " + dir);

  const sandbox = { window: {} };
  const ctx = vm.createContext(sandbox);
  const hash = crypto.createHash("sha256");
  let bytes = 0;

  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    bytes += Buffer.byteLength(src);
    hash.update(f).update("\0").update(src).update("\0");
    vm.runInContext(src, ctx, { filename: f });
  }

  const CK = sandbox.window.CK;
  if (!CK) throw new Error("数据文件读到了，但没有产出 window.CK");

  return {
    dir,
    files,
    bytes,
    version: hash.digest("hex").slice(0, 12),
    // 红线：磁盘读取顺序不是集号顺序，必须显式排序
    episodes: (CK.episodes || []).slice().sort((a, b) => a.id - b.id),
    characters: CK.characters || [],
    arcs: CK.arcs || [],
  };
}

/* ------------------------------------------------------------------ 索引 */

function buildIndex(a) {
  const byEpisode = new Map();
  const byCharacter = new Map();
  const byArc = new Map();
  for (const e of a.episodes) byEpisode.set(e.id, e);
  for (const c of a.characters) byCharacter.set(c.id, c);
  for (const x of a.arcs) byArc.set(x.id, x);

  const charIdByName = new Map();
  for (const c of a.characters) {
    for (const n of [c.cn, c.jp].concat(c.alias || [])) {
      if (n && !charIdByName.has(n)) charIdByName.set(n, c.id);
    }
  }

  const epToChars = new Map();
  const charToEps = new Map();
  const unmatched = new Map();
  for (const e of a.episodes) {
    const set = new Set();
    for (const sh of e.sh || []) {
      for (const l of sh.l || []) {
        const cid = charIdByName.get(l.w);
        if (cid) {
          set.add(cid);
          if (!charToEps.has(cid)) charToEps.set(cid, new Set());
          charToEps.get(cid).add(e.id);
        } else if (l.w) {
          unmatched.set(l.w, (unmatched.get(l.w) || 0) + 1);
        }
      }
    }
    epToChars.set(e.id, set);
  }

  // 篇章 → 集，两条来源分别记，供对账
  const arcRange = new Map();
  for (const x of a.arcs) {
    const set = new Set();
    const from = Number.isFinite(x.start) ? x.start : 1;
    const to = Number.isFinite(x.end) ? x.end : from;
    for (let id = from; id <= to; id++) if (byEpisode.has(id)) set.add(id);
    arcRange.set(x.id, set);
  }
  const arcLink = new Map();
  for (const e of a.episodes) {
    for (const aid of e.a || []) {
      if (!arcLink.has(aid)) arcLink.set(aid, new Set());
      arcLink.get(aid).add(e.id);
    }
  }

  const shorts = [];
  const shortByRef = new Map();
  const searchable = [];
  let lineCount = 0;

  for (const e of a.episodes) {
    (e.sh || []).forEach((sh, i) => {
      const index = i + 1;
      const ref = e.id + ":" + index;
      const rec = {
        ref,
        episode_id: e.id,
        index,
        title: sh.t || "",
        confidence: sh.c || "",
        summary: sh.s || "",
        lines: (sh.l || []).map((l) => ({ who: l.w || "", kind: l.k || "", text: l.x || "" })),
      };
      lineCount += rec.lines.length;
      shorts.push(rec);
      shortByRef.set(ref, rec);
      searchable.push({
        kind: "short",
        ref,
        title: rec.title,
        body: rec.summary,
        lines: rec.lines,
        order: e.id * 100 + index,
      });
    });
  }

  for (const c of a.characters) {
    searchable.push({
      kind: "character",
      ref: c.id,
      title: c.cn || c.id,
      body: [c.intro || "", c.jp || "", (c.tags || []).join(" "), (c.alias || []).join(" ")].join(" "),
      lines: [],
      order: 0,
    });
  }

  for (const x of a.arcs) {
    searchable.push({
      kind: "arc",
      ref: x.id,
      title: x.cn || x.id,
      body: [x.summary || "", x.jp || "", x.tag || ""].join(" "),
      lines: [],
      order: 0,
    });
  }

  return {
    byEpisode, byCharacter, byArc, charIdByName, epToChars, charToEps,
    arcRange, arcLink, shorts, shortByRef, searchable, lineCount, unmatched,
  };
}

/* ------------------------------------------------------------------ 检索 */

function runSearch(idx, query, kind, limit) {
  const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];

  const hits = [];
  for (const rec of idx.searchable) {
    if (kind && rec.kind !== kind) continue;

    const title = String(rec.title).toLowerCase();
    const body = String(rec.body).toLowerCase();
    let score = 0;
    let all = true;

    for (const t of terms) {
      let hit = 0;
      if (title.indexOf(t) >= 0) hit += 6;
      if (body.indexOf(t) >= 0) hit += 2;
      const snippets = [];
      for (const l of rec.lines) {
        const text = String(l.text);
        if (text.toLowerCase().indexOf(t) >= 0) {
          hit += 2;
          if (snippets.length < 3) snippets.push(l.who + "：" + text);
        }
      }
      if (hit === 0) { all = false; break; }
      score += hit;
      if (snippets.length) rec._snip = snippets;
    }
    if (!all) continue;

    const snips = (rec._snip || []).slice(0, 3);
    delete rec._snip;
    hits.push({
      kind: rec.kind,
      ref: rec.ref,
      title: rec.title,
      snippet: snips.length ? snips : [String(rec.body).slice(0, 80)],
      score,
      order: rec.order,
    });
  }

  hits.sort((x, y) => y.score - x.score || x.order - y.order);
  return hits.slice(0, limit);
}

/* ------------------------------------------------------------------ 工具 */

const KIND_ENUM = ["episode", "short", "character", "arc"];

const TOOLS = [
  {
    name: "list_entries",
    description:
      "分页浏览词条概要；需要完整目录时按 has_more 和 offset 翻页。",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: KIND_ENUM, description: "词条类型" },
        filter: {
          type: "object",
          description: "按类型生效的过滤条件，多余字段会被忽略",
          properties: {
            season: { type: "integer", enum: [1, 2, 3], description: "仅 episode：第几季" },
            arc_id: { type: "string", description: "仅 episode：属于该篇章" },
            has_arc: { type: "boolean", description: "仅 episode：是否已关联篇章" },
            episode_id: { type: "integer", description: "仅 short：属于该集" },
            confidence: { type: "string", enum: ["A", "B"], description: "仅 short：可信度等级" },
            tag: { type: "string", description: "仅 arc：篇章标签" },
            role: { type: "string", description: "仅 character：角色定位" },
            q: { type: "string", description: "标题包含该字符串" },
          },
        },
        offset: { type: "integer", minimum: 0, description: "从第几条开始，默认 0" },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: "本页条数，默认 50，上限 200" },
      },
      required: ["kind"],
    },
  },
  {
    name: "get_entry",
    description:
      "取单个词条。id：episode 用集号；short 用集号:序号（从 1 开始）；character/arc 用其 id。",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: KIND_ENUM },
        id: { type: ["string", "integer"], description: "词条 id，形式见工具说明" },
        compact: { type: "boolean", description: "精简台词明细，默认 false" },
      },
      required: ["kind", "id"],
    },
  },
  {
    name: "search_entries",
    description:
      "检索短篇、角色与篇章，返回定位及最多 3 条片段，不返全文。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索词，空格分隔表示全部命中" },
        kind: { type: "string", enum: KIND_ENUM, description: "限定类型，省略则全部" },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: "默认 20" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_related",
    description:
      "查集、角色、篇章的关联。episode_ids 包含库内全部关联集号；覆盖来源见 coverage。",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["episode", "character", "arc"] },
        id: { type: ["string", "integer"] },
        limit: {
          type: "integer", minimum: 1, maximum: MAX_LIMIT,
          description: "可读集列表的条数上限，默认 60；episode_ids 始终完整",
        },
      },
      required: ["kind", "id"],
    },
  },
  {
    name: "describe_schema",
    description:
      "返回字段语义、规模、版本与已知缺口；本会话首次使用时调用。",
    inputSchema: { type: "object", properties: {} },
  },
];

for (const tool of TOOLS) {
  tool.annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
}

/* ------------------------------------------------------------------ 实现 */

function seasonOf(id) {
  return id <= 120 ? 1 : id <= 240 ? 2 : 3;
}

function epBrief(idx, id) {
  const e = idx.byEpisode.get(id);
  if (!e) return null;
  return { id: e.id, cn: e.cn || "", jp: e.jp || "", date: e.d || "" };
}

function arcIdsForEpisode(idx, e) {
  const set = new Set(e.a || []);
  idx.arcRange.forEach((eps, aid) => { if (eps.has(e.id)) set.add(aid); });
  return Array.from(set);
}

function tList(idx, kind, filter, offset, limit) {
  const f = filter || {};
  let rows = [];

  if (kind === "episode") {
    rows = idx.byEpisode.get(0) ? [] : [];
    rows = Array.from(idx.byEpisode.values());
    if (f.season) rows = rows.filter((e) => seasonOf(e.id) === f.season);
    if (f.arc_id) rows = rows.filter((e) => (e.a || []).indexOf(f.arc_id) >= 0);
    if (typeof f.has_arc === "boolean") {
      rows = rows.filter((e) => Boolean((e.a || []).length) === f.has_arc);
    }
    if (f.q) {
      const q = String(f.q).toLowerCase();
      rows = rows.filter((e) =>
        (e.cn || "").toLowerCase().indexOf(q) >= 0 || (e.jp || "").toLowerCase().indexOf(q) >= 0);
    }
    rows.sort((x, y) => x.id - y.id);
    var mapped = rows.map((e) => ({
      id: e.id, cn: e.cn || "", jp: e.jp || "", date: e.d || "",
      shorts: (e.sh || []).length, arcs: arcIdsForEpisode(idx, e),
    }));
  } else if (kind === "short") {
    rows = idx.shorts.slice();
    if (f.episode_id) rows = rows.filter((s) => s.episode_id === f.episode_id);
    if (f.confidence) rows = rows.filter((s) => s.confidence === f.confidence);
    if (f.q) {
      const q = String(f.q).toLowerCase();
      rows = rows.filter((s) => s.title.toLowerCase().indexOf(q) >= 0);
    }
    rows.sort((x, y) => x.episode_id - y.episode_id || x.index - y.index);
    var mapped = rows.map((s) => ({
      ref: s.ref, episode_id: s.episode_id, index: s.index,
      title: s.title, confidence: s.confidence,
      summary: s.summary.slice(0, 60),
    }));
  } else if (kind === "arc") {
    rows = Array.from(idx.byArc.values());
    if (f.tag) rows = rows.filter((x) => x.tag === f.tag);
    if (f.q) {
      const q = String(f.q).toLowerCase();
      rows = rows.filter((x) =>
        (x.cn || "").toLowerCase().indexOf(q) >= 0 || (x.jp || "").toLowerCase().indexOf(q) >= 0);
    }
    rows.sort((x, y) => (x.start || 0) - (y.start || 0));
    var mapped = rows.map((x) => ({
      id: x.id, cn: x.cn || "", jp: x.jp || "",
      range: [x.start, x.end], tag: x.tag || "", status: x.status || "",
    }));
  } else if (kind === "character") {
    rows = Array.from(idx.byCharacter.values());
    if (f.role) rows = rows.filter((c) => c.role === f.role);
    if (f.q) {
      const q = String(f.q).toLowerCase();
      rows = rows.filter((c) =>
        (c.cn || "").toLowerCase().indexOf(q) >= 0 || (c.jp || "").toLowerCase().indexOf(q) >= 0);
    }
    rows.sort((x, y) => String(x.id).localeCompare(String(y.id)));
    var mapped = rows.map((c) => ({
      id: c.id, cn: c.cn || "", jp: c.jp || "", role: c.role || "", tags: c.tags || [],
    }));
  } else {
    throw new Error("未知的 kind：" + kind);
  }

  const total = mapped.length;
  const page = mapped.slice(offset, offset + limit);
  return {
    kind, total, offset, limit,
    returned: page.length,
    has_more: offset + page.length < total,
    items: page,
  };
}

function characterEpisodes(idx, c) {
  const declared = (c.eps || []).filter((n) => idx.byEpisode.has(n)).sort((x, y) => x - y);
  const inferred = Array.from(idx.charToEps.get(c.id) || []).sort((x, y) => x - y);
  const union = Array.from(new Set(declared.concat(inferred))).sort((x, y) => x - y);
  return { declared, inferred, union };
}

function tGet(idx, archive, kind, id, compact) {
  if (kind === "episode") {
    const e = idx.byEpisode.get(Number(id));
    if (!e) return { found: false, error: "没有第 " + id + " 集" };
    const out = {
      found: true, kind: "episode", id: e.id, cn: e.cn || "", jp: e.jp || "",
      date: e.d || "", season: seasonOf(e.id), arcs: arcIdsForEpisode(idx, e),
      characters: Array.from(idx.epToChars.get(e.id) || []),
      shorts: (e.sh || []).map((sh, i) => {
        const base = {
          ref: e.id + ":" + (i + 1), index: i + 1,
          title: sh.t || "", confidence: sh.c || "", summary: sh.s || "",
        };
        if (!compact) {
          base.lines = (sh.l || []).map((l) => ({ who: l.w || "", kind: l.k || "", text: l.x || "" }));
        } else {
          base.line_count = (sh.l || []).length;
        }
        return base;
      }),
    };
    return out;
  }

  if (kind === "short") {
    const ref = typeof id === "number" ? String(id) : String(id);
    const rec = idx.shortByRef.get(ref);
    if (!rec) return { found: false, error: "没有短篇 " + ref + "（形式应为 集号:序号）" };
    return {
      found: true, kind: "short", ref: rec.ref,
      episode: epBrief(idx, rec.episode_id),
      index: rec.index, title: rec.title, confidence: rec.confidence,
      summary: rec.summary,
      lines: rec.lines.map((l) =>
        compact ? { who: l.who, kind: l.kind } : { who: l.who, kind: l.kind, text: l.text }),
    };
  }

  if (kind === "character") {
    const c = idx.byCharacter.get(String(id));
    if (!c) return { found: false, error: "没有角色 " + id };
    const ep = characterEpisodes(idx, c);
    const out = {
      found: true, kind: "character", id: c.id, cn: c.cn || "", jp: c.jp || "",
      romaji: c.romaji || "", role: c.role || "", tags: c.tags || [], alias: c.alias || [],
      cvJp: c.cvJp || "", cvCn: c.cvCn || "",
      intro: c.intro || "", sample_line: c.line || "",
      episodes: ep.union,
      episode_coverage: {
        declared: ep.declared.length,
        inferred: ep.inferred.length,
        union: ep.union.length,
        note:
          "characters[].eps 是代表性出场，不是全集；inferred 由台词/动作倒推，" +
          "没有台词的出场推不出来，因此是下界。episodes 取两者并集。",
      },
    };
    if (!compact) {
      out.declared_episodes = ep.declared;
      out.inferred_episodes = ep.inferred;
    }
    return out;
  }

  if (kind === "arc") {
    const x = idx.byArc.get(String(id));
    if (!x) return { found: false, error: "没有篇章 " + id };
    const linked = idx.arcLink.get(x.id) || new Set();
    const ranged = idx.arcRange.get(x.id) || new Set();
    const union = new Set([...linked, ...ranged]);
    return {
      found: true, kind: "arc", id: x.id, cn: x.cn || "", jp: x.jp || "",
      range: [x.start, x.end], tag: x.tag || "", status: x.status || "",
      summary: x.summary || "",
      episode_count: union.size,
      episodes: Array.from(union).sort((p, q) => p - q),
      coverage: {
        from_episode_links: linked.size,
        from_arc_range: ranged.size,
        note:
          "两来源语义不同：arcs[].start/end 是主体连续区间，episodes[].a 还含呼应/回访集，" +
          "二者不构成倒排关系，episode_count 取并集。差异是设计如此，不是数据错误。",
      },
    };
  }

  throw new Error("未知的 kind：" + kind);
}

function tRelated(idx, kind, id, limit) {
  const packEpisodes = (ids) => {
    const sorted = Array.from(new Set(ids)).filter((n) => idx.byEpisode.has(n)).sort((a, b) => a - b);
    const page = sorted.slice(0, limit);
    return {
      episodes: page.map((n) => epBrief(idx, n)),
      episode_ids: sorted,
      episode_total: sorted.length,
      has_more: sorted.length > page.length,
    };
  };

  const packArcs = (ids) =>
    Array.from(new Set(ids)).map((aid) => {
      const x = idx.byArc.get(aid);
      return { id: aid, cn: x ? x.cn : aid, range: x ? [x.start, x.end] : null };
    });

  const packChars = (ids) =>
    Array.from(new Set(ids)).map((cid) => {
      const c = idx.byCharacter.get(cid);
      return { id: cid, cn: c ? c.cn : cid };
    });

  if (kind === "episode") {
    const e = idx.byEpisode.get(Number(id));
    if (!e) return { found: false, error: "没有第 " + id + " 集" };
    return Object.assign(
      { found: true, kind: "episode", id: e.id, cn: e.cn || "", jp: e.jp || "" },
      { characters: packChars(idx.epToChars.get(e.id) || []), arcs: packArcs(arcIdsForEpisode(idx, e)) }
    );
  }

  if (kind === "character") {
    const c = idx.byCharacter.get(String(id));
    if (!c) return { found: false, error: "没有角色 " + id };
    const ep = characterEpisodes(idx, c);
    const arcs = new Set();
    for (const n of ep.union) arcIdsForEpisode(idx, idx.byEpisode.get(n)).forEach((aid) => arcs.add(aid));
    return Object.assign(
      {
        found: true, kind: "character", id: c.id, cn: c.cn || "", jp: c.jp || "",
        coverage: { declared: ep.declared.length, inferred: ep.inferred.length, union: ep.union.length },
      },
      packEpisodes(ep.union),
      { arcs: packArcs(arcs) }
    );
  }

  if (kind === "arc") {
    const x = idx.byArc.get(String(id));
    if (!x) return { found: false, error: "没有篇章 " + id };
    const linked = idx.arcLink.get(x.id) || new Set();
    const ranged = idx.arcRange.get(x.id) || new Set();
    const union = new Set([...linked, ...ranged]);
    const chars = new Set();
    for (const n of union) (idx.epToChars.get(n) || new Set()).forEach((cid) => chars.add(cid));
    return Object.assign(
      {
        found: true, kind: "arc", id: x.id, cn: x.cn || "", jp: x.jp || "",
        coverage: { from_episode_links: linked.size, from_arc_range: ranged.size },
      },
      packEpisodes(union),
      { characters: packChars(chars) }
    );
  }

  throw new Error("get_related 的 kind 只支持 episode / character / arc");
}

function arcMissingLinks(idx, archive) {
  const out = [];
  for (const x of archive.arcs) {
    for (let i = x.start; i <= x.end; i++) {
      const e = idx.byEpisode.get(i);
      if (e && (e.a || []).indexOf(x.id) < 0) {
        out.push({ arc_id: x.id, arc_cn: x.cn || x.id, episode_id: i, episode_cn: e.cn || "" });
      }
    }
  }
  return out;
}

function tDescribe(idx, archive) {
  const missing = arcMissingLinks(idx, archive);
  const insideRange = new Set();
  for (const x of archive.arcs) {
    for (let i = x.start; i <= x.end; i++) if (idx.byEpisode.has(i)) insideRange.add(i);
  }
  const outsideRange = archive.episodes.length - insideRange.size;
  const shortSummaries = idx.shorts.map((s) => s.summary.length).sort((x, y) => x - y);
  const median = shortSummaries.length ? shortSummaries[Math.floor(shortSummaries.length / 2)] : 0;
  const truncated = idx.shorts.filter((s) => s.summary.length < 80).length;

  const seen = new Map();
  for (const e of archive.episodes) {
    for (const sh of e.sh || []) {
      for (const l of sh.l || []) {
        const k = e.id + "|" + sh.t + "|" + l.w + "|" + l.x;
        seen.set(k, (seen.get(k) || 0) + 1);
      }
    }
  }
  let dupLines = 0;
  seen.forEach((v) => { if (v > 1) dupLines += 1; });

  return {
    server: SERVER_NAME,
    server_version: SERVER_VERSION,
    data_version: archive.version,
    source_dir: archive.dir,
    source_files: archive.files.length,
    source_bytes: archive.bytes,
    counts: {
      episode: archive.episodes.length,
      short: idx.shorts.length,
      character: archive.characters.length,
      arc: archive.arcs.length,
      line: idx.lineCount,
    },
    fields: {
      "episodes[].id": "集号，1-345，连续无缺",
      "episodes[].jp / .cn": "日文原名 / 中文标题",
      "episodes[].d": "首播日期",
      "episodes[].a": "该集涉及的篇章 id 数组，含呼应/回访集，因此不限于「所属区间」；空数组多数表示该集本就不属于任何篇章",
      "episodes[].sh[]": "一集内的短篇，通常 2 个；不是「集」，别叫错",
      "sh[].t": "短篇标题",
      "sh[].c": "可信度等级 A/B（A=有资料支撑），不是分类",
      "sh[].s": "短篇概要",
      "sh[].l[]": "台词与动作行",
      "l[].w": "说话人/动作主体",
      "l[].k": "a=动作，t=台词",
      "l[].x": "文本",
      "characters[].eps": "代表性出场集号，不是全集（见 known_gaps: character-eps-is-subset）",
      "arcs[].start / .end": "篇章的主体连续区间。与 episodes[].a 语义不同，二者不构成倒排关系，取并集才是完整覆盖",
    },
    known_gaps: [
      {
        id: "load-order-trap",
        detail: "数据文件的读取顺序不是集号顺序，靠文件名排序会把靠后的区间排到前面。",
        workaround: "任何消费者都必须显式按 id 排序，而且不会报错，只会安静地返回错结果。本服务已在装载层处理。",
      },
      {
        id: "arc-fk-missing",
        detail:
          "篇章区间内有 " + missing.length + " 集没有回填 episodes[].a" +
          (missing.length
            ? "：" + missing.map((m) => "第 " + m.episode_id + " 集「" + m.episode_cn + "」（" + m.arc_cn + "）").join("、")
            : "") +
          "。另有 " + outsideRange + " 集本就不属于任何篇章，其 a[] 为空是正常的，不是缺陷。",
        workaround: "对 arc 取「区间 ∪ 反查」而非单看 a[]，本服务已这么做并返回 coverage。",
      },
      {
        id: "arc-link-not-inverse",
        detail:
          "episodes[].a 与 arcs[].start/.end 语义不同：前者含呼应/回访集（如第 125 集指向 41-43 的郎拉面篇），" +
          "后者是主体连续区间。二者本就不该互为倒排，差异不是缺陷。",
        workaround: "需要完整覆盖时取并集，不要拿任一单边当真值。",
      },
      {
        id: "character-eps-is-subset",
        detail:
          "characters[].eps 是代表性出场，不是全集——30 个角色里 11 个受影响，" +
          "例如吉伊卡哇声明 9 集、台词可推出 296 集；哈奇喵 7 / 306；乌萨奇 6 / 26。" +
          "不要拿它回答该角色出现在哪些集。",
        workaround: "get_related(character) 与 get_entry(character) 返回 episodes 并集，并给出 coverage 拆解声明数与倒推数。",
      },
      {
        id: "duplicate-lines",
        detail: "有 " + dupLines + " 条完全重复的台词/动作行（同集、同短篇、同说话人、同文本）。",
        workaround: "检索结果可能重复出现，按 ref + 序号去重。",
      },
      {
        id: "short-summaries",
        detail: "短篇概要中位数 " + median + " 字，其中 " + truncated + " 条不足 80 字。",
        workaround: "概念性检索优先用 title 与 lines，别只靠概要。",
      },
      {
        id: "unmatched-speakers",
        detail: "有说话人未登记为角色：老师×7、山佬×2、揽客君×1、哈奇喵与吉伊×1、守护君×1。",
        workaround: "这几处出场推不出角色，关系图有洞；完整清单见本响应的 unmatched_speakers。",
      },
    ],
    unmatched_speakers: Array.from(idx.unmatched.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((x, y) => y.count - x.count),
  };
}

/* ------------------------------------------------------------------ 分发 */

function callTool(idx, archive, name, args) {
  const a = args || {};
  const fallback = name === "search_entries" ? 20 : name === "get_related" ? 60 : DEFAULT_LIMIT;
  const limit = Math.min(Math.max(1, Number(a.limit) || fallback), MAX_LIMIT);
  const offset = Math.max(0, Number(a.offset) || 0);

  switch (name) {
    case "list_entries":
      return tList(idx, a.kind, a.filter, offset, limit);
    case "get_entry":
      return tGet(idx, archive, a.kind, a.id, Boolean(a.compact));
    case "search_entries":
      return {
        query: a.query,
        kind: a.kind || null,
        hits: runSearch(idx, a.query, a.kind, limit),
      };
    case "get_related":
      return tRelated(idx, a.kind, a.id, limit);
    case "describe_schema":
      return tDescribe(idx, archive);
    default:
      throw new Error("没有这个工具：" + name);
  }
}

/* ------------------------------------------------------------------ 协议 */

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

let archive = null;
let index = null;

function handle(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (err) {
    replyError(null, -32700, "请求不是合法 JSON");
    return;
  }

  const id = Object.prototype.hasOwnProperty.call(msg, "id") ? msg.id : null;
  const method = msg.method;

  if (!method) {
    if (id !== null) replyError(id, -32600, "缺少 method");
    return;
  }

  if (id === null) return; // 通知，不需要回执

  try {
    switch (method) {
      case "initialize":
        reply(id, {
          protocolVersion: (msg.params && msg.params.protocolVersion) || PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions:
            "《吉伊卡哇》只读资料库，仅用于作品内容查询。普通闲聊和技术任务不调用；" +
            "本会话首次使用先查 describe_schema，已核实信息可复用。",
        });
        return;
      case "ping":
        reply(id, {});
        return;
      case "tools/list":
        reply(id, { tools: TOOLS });
        return;
      case "tools/call": {
        const p = msg.params || {};
        const out = callTool(index, archive, p.name, p.arguments);
        reply(id, {
          content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
          isError: false,
        });
        return;
      }
      default:
        replyError(id, -32601, "不支持的方法：" + method);
    }
  } catch (err) {
    const text = err && err.message ? err.message : String(err);
    if (method === "tools/call") {
      reply(id, { content: [{ type: "text", text: "调用失败：" + text }], isError: true });
    } else {
      replyError(id, -32603, text);
    }
  }
}

function main() {
  archive = loadArchive();
  index = buildIndex(archive);
  process.stderr.write(
    "[" + SERVER_NAME + "] 已装载 " + archive.files.length + " 个文件 / " +
    archive.episodes.length + " 集 / " + index.shorts.length + " 短篇，版本 " + archive.version + "\n");

  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let at;
    while ((at = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, at).trim();
      buf = buf.slice(at + 1);
      if (line) handle(line);
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

// 探针：--selftest 直接打印装载摘要后退出，便于排查
if (process.argv.indexOf("--selftest") >= 0) {
  archive = loadArchive();
  index = buildIndex(archive);
  process.stdout.write(JSON.stringify(tDescribe(index, archive), null, 2) + "\n");
  process.exit(0);
}

main();
