// ==UserScript==
// @name         NovelAI {a|b} 抽選（スマホ・iPad用）
// @namespace    genki.novelai.prompt-tools
// @version      0.22.0
// @description  NovelAIで {red|green} eyes のように書くと、生成のたびに抽選する。(語:1.2) と 1.0-1.5::語:: の重みもPC版と同じく変換する
// @match        https://novelai.net/*
// @run-at       document-start
// @inject-into  page
// @grant        none
// @noframes
// ==/UserScript==
//
// このファイルは tools/build-userscript.py で自動で作ったもの。直接編集しない
// （元: Prompt Tools for NovelAI v0.22.0 の sdconv.js と inject-main.js）
// ・通信はしない。NovelAIが送る生成リクエストの中のプロンプトを、送る直前に書き換えるだけ
// ・プロンプト欄の文字はそのまま。抽選の結果は画面下に数秒だけ表示する

// SD形式の重み付け (語:1.2) → NovelAI形式 1.2::語:: の変換（共通の部品）
//   MAINワールド（inject-main.js: 送るときの自動変換）と、拡張機能側（変換ボタン）の両方で読み込む
//   ・(語:1.2) → 1.2::語::  （範囲つき (語:1.0-1.5) → 1.0-1.5::語::）
//   ・整数の重みは "2.00" にする（"2::語::" だと、NovelAIが重みとして認識しないため）
//   ・数字だけ（(16:9) のような比率）は変換しない
//   ・入れ子になっている (…:1.2) は、意味が変わってしまうため、内側も外側も変換せずそのまま残す
//   ・\( \) で書いた「ただのかっこ」は変換しない。tidy=true のときは、NovelAIでは不要な \ を外して ( ) にする
(() => {
  const NUMP = String.raw`(?:\d+\.?\d*|\.\d+)`;
  const NUMS = String.raw`-?(?:\d+\.?\d*|\.\d+)`;
  const RANGE = `${NUMS}(?:-${NUMS}(?:-${NUMP})?)?`;
  const SD_RE = new RegExp(`^([\\s\\S]+?)\\s*:\\s*(${RANGE})\\s*$`);
  const fixDots = (w) => w.replace(/(^|[^\d])\./g, "$10.");
  const wfmt = (w) => (/^-?\d+$/.test(w) ? w + ".00" : w);

  function convert(s, tidy) {
    let out = s;
    if (s.includes("(") && s.includes(":")) {
      const escaped = (i) => {
        let n = 0;
        for (let k = i - 1; k >= 0 && s[k] === "\\"; k--) n++;
        return n % 2 === 1;
      };
      const stack = [];
      const cands = [];
      for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === "(" && !escaped(i)) stack.push(i);
        else if (c === ")" && !escaped(i) && stack.length) {
          const open = stack.pop();
          const m = SD_RE.exec(s.slice(open + 1, i));
          if (m && /[^\d\s.:,-]/.test(m[1])) cands.push({ open, close: i, text: m[1].trim(), w: fixDots(m[2]) });
        }
      }
      const leaves = cands.filter(
        (c) => !cands.some((d) => d !== c && ((d.open > c.open && d.close < c.close) || (c.open > d.open && c.close < d.close)))
      );
      leaves.sort((a, b) => b.open - a.open);
      for (const c of leaves) out = out.slice(0, c.open) + `${wfmt(c.w)}::${c.text}::` + out.slice(c.close + 1);
    }
    if (tidy) out = out.replace(/\\([()])/g, "$1");
    return out;
  }
  // 変換すると変わるか（ボタンを出すかどうかの判定用）
  const needs = (s) => convert(s, true) !== s;

  (typeof window !== "undefined" ? window : globalThis).__naixSD = { convert, needs };
})();

// {a|b|c} 記法（ダイナミックプロンプト）の展開
//
// NovelAIが画像生成のリクエストを送る直前に、プロンプト中の {a|b|c} を
// ランダムに1つ選んだ文字列に置き換えます。{{red|green} bikini|uniform} のような
// ネストにも対応していて、選ばれた側の中にある {red|green} もあらためて抽選します。
// 生成のたびにリクエストが送られるので、くり返し生成すると毎回引き直されます。
//
// ・ | を含まない {tag} は、NovelAI標準の強調としてそのまま残します
// ・ ||a|b|| のNovelAI標準ランダマイザの中身には触りません
//
// あわせて、次の変換も送信の直前に行います（プロンプト欄の文字は書き換えません）。
// ・確率つきの選択肢   {3::red|1::blue}   … 3:1 の割合で選ぶ（数字がない選択肢は 1）
// ・SD形式の重み付け   (anime coloring:1.5) → 1.5::anime coloring::
// ・重みの範囲抽選     1.0-1.5::anime coloring::  … 1.0〜1.5を0.05刻みでランダムに選ぶ
//                      (anime coloring:1.0-1.5) でも同じ。1.0-1.5-0.1 のように刻み幅も指定できる
// v0.22.0:
// ・ワイルドカード     __outfit__   … 🎲抽選パネルで登録したリスト「outfit」から1行を選ぶ（行の中の {a|b} や __x__ も展開）
// ・抽選の固定         🎲抽選パネルで固定した {a|b} / __x__ は、いつも同じ選択肢にする
// ・選ばれた結果（picks）を記録し、当たり率の集計に使う

(() => {
  if (window.__naixFetchHooked) return;
  window.__naixFetchHooked = true;

  const URL_RE = /\/ai\/generate-image/; // 画像生成のAPI（stream版も含む）
  const rand = (n) => Math.floor(Math.random() * n);

  // 動作確認用のログ（Consoleで「NAIX」で絞り込むと見えます）
  // 普段は静かにしておく。詳しいログが欲しいときは、Consoleで
  //   localStorage.setItem("naix-debug", "1")   を実行してから再読み込み
  let DEBUG = false;
  try {
    DEBUG = localStorage.getItem("naix-debug") === "1";
  } catch (e) {}
  const say = (...a) => console.log("[NAIX]", ...a);
  const dbg = (...a) => DEBUG && say(...a);
  const methodOf = (input, init) =>
    String((init && init.method) || (input && input.method) || "GET").toUpperCase();

  // 文字列 s の、位置 i から始まる || ... || を飛ばした次の位置を返す（なければ -1）
  const skipRandomizer = (s, i) => {
    if (s[i] !== "|" || s[i + 1] !== "|") return -1;
    const end = s.indexOf("||", i + 2);
    return end < 0 ? -1 : end + 2;
  };

  // { の位置から、対応する } の位置を返す（なければ -1）
  function matchBrace(s, start) {
    let depth = 0;
    for (let j = start; j < s.length; j++) {
      if (s[j] === "{") depth++;
      else if (s[j] === "}" && --depth === 0) return j;
    }
    return -1;
  }

  // 一番外側の | で分割する（入れ子の {} と || || の中は分割しない）
  function splitTop(inner) {
    const parts = [];
    let depth = 0;
    let cur = "";
    for (let i = 0; i < inner.length; i++) {
      const skip = skipRandomizer(inner, i);
      if (skip > 0) {
        cur += inner.slice(i, skip);
        i = skip - 1;
        continue;
      }
      const c = inner[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      if (c === "|" && depth === 0) {
        parts.push(cur);
        cur = "";
      } else {
        cur += c;
      }
    }
    parts.push(cur);
    return parts;
  }

  // ---- ワイルドカードと抽選の固定（lottery.js が localStorage "naix-lottery" に書く） ----
  //   { wild: { 名前: [行, ...] }, locks: { キー: 選択肢 } }
  //   キーは {a|b} なら "{a|b}"（空白をそろえたもの）、ワイルドカードなら "__名前__"
  let cfg = { wild: {}, locks: {} };
  const loadCfg = () => {
    try {
      const v = JSON.parse(localStorage.getItem("naix-lottery") || "null");
      cfg = { wild: (v && v.wild) || {}, locks: (v && v.locks) || {} };
    } catch (e) {
      cfg = { wild: {}, locks: {} };
    }
  };
  let picks = null; // いま処理中のリクエストで選ばれたもの [{ k, c }]
  const normKey = (s) => String(s).replace(/\s+/g, " ").trim();
  const record = (k, c) => {
    if (picks && picks.length < 300) picks.push({ k, c: normKey(c) });
  };
  const WILD_RE = /^__([^\s_,{}|:()\[\]][^\s,{}|:()\[\]]*?)__/u;
  const MAX_DEPTH = 10; // ワイルドカードが自分自身を呼ぶような書き方でも、止まるように

  // 選択肢の先頭の「数字::」を確率（重み）として読む。
  // ただし 1.2::red hair:: のようにNovelAIの重み付け（閉じの :: がある形）のときは、確率として扱わない。
  const NUMP = String.raw`(?:\d+\.?\d*|\.\d+)`;
  const LEAD_WEIGHT = new RegExp(`^\\s*(${NUMP})::`);
  function parseOption(part) {
    const m = LEAD_WEIGHT.exec(part);
    if (m) {
      const rest = part.slice(m[0].length);
      const colons = (rest.match(/::/g) || []).length;
      if (colons % 2 === 0) return { w: parseFloat(m[1]), text: rest };
    }
    return { w: 1, text: part };
  }
  function pickWeighted(parts) {
    const opts = parts.map(parseOption);
    let total = 0;
    for (const o of opts) total += Math.max(0, o.w);
    if (total <= 0) return opts[rand(opts.length)].text;
    let r = Math.random() * total;
    for (const o of opts) {
      const w = Math.max(0, o.w);
      if (r < w) return o.text;
      r -= w;
    }
    return opts[opts.length - 1].text;
  }
  // 固定されていれば、その選択肢を使う（選択肢が見つからなければ、ふつうに抽選）。選んだものは記録する
  function choose(parts, key) {
    const lk = cfg.locks[key];
    if (lk != null) {
      const hit = parts.map(parseOption).find((o) => normKey(o.text) === lk);
      if (hit) {
        record(key, hit.text);
        return hit.text;
      }
    }
    const t = pickWeighted(parts);
    record(key, t);
    return t;
  }

  function expand(s, depth) {
    depth = depth || 0;
    let out = "";
    for (let i = 0; i < s.length; i++) {
      const skip = skipRandomizer(s, i);
      if (skip > 0) {
        out += s.slice(i, skip);
        i = skip - 1;
        continue;
      }
      if (s[i] === "_" && s[i + 1] === "_" && depth < MAX_DEPTH) {
        const m = WILD_RE.exec(s.slice(i, i + 80));
        const lines = m && cfg.wild[m[1]];
        if (lines && lines.length) {
          out += expand(choose(lines, "__" + m[1] + "__"), depth + 1);
          i += m[0].length - 1;
          continue;
        }
      }
      if (s[i] !== "{") {
        out += s[i];
        continue;
      }
      const close = matchBrace(s, i);
      if (close < 0) {
        out += s[i];
        continue;
      }
      const inner = s.slice(i + 1, close);
      const parts = splitTop(inner);
      if (parts.length > 1) {
        out += expand(choose(parts, "{" + normKey(inner) + "}"), depth + 1); // 選んだ側の中も、もう一度抽選
      } else {
        out += "{" + expand(inner, depth) + "}"; // | が無い {} は標準の強調
      }
      i = close;
    }
    return out;
  }

  // ---- (text:1.5) → 1.5::text:: （SD形式の重み付けをNovelAI形式にする） ----
  const NUMS = String.raw`-?(?:\d+\.?\d*|\.\d+)`;
  const RANGE = `${NUMS}(?:-${NUMS}(?:-${NUMP})?)?`;
  const SD_RE = new RegExp(`^([\\s\\S]+?)\\s*:\\s*(${RANGE})\\s*$`);
  const fixDots = (w) => w.replace(/(^|[^\d])\./g, "$10.");

  // 中身は sdconv.js（変換ボタンと同じ処理を使う）
  function convertSD(s) {
    return window.__naixSD ? window.__naixSD.convert(s, false) : s;
  }

  // ---- 1.0-1.5::text:: の範囲を、ランダムな1つの数字にする ----
  const BACK = new RegExp(`(?<![\\w.])(${NUMS})(?:-(${NUMS})(?:-(${NUMP}))?)?$`);
  function pickRange(lo, hi, step) {
    lo = parseFloat(lo);
    hi = parseFloat(hi);
    if (lo > hi) [lo, hi] = [hi, lo];
    const st = step && parseFloat(step) > 0 ? parseFloat(step) : 0.05;
    const n = Math.floor((hi - lo) / st + 1e-9);
    const v = Math.round((lo + rand(n + 1) * st) * 100) / 100;
    return Number.isInteger(v) ? v.toFixed(2) : String(v); // 整数は "2.00" に（NovelAIが重みとして認識するように）
  }
  function expandRanges(s) {
    if (!s.includes("::")) return s;
    const reps = [];
    let open = null;
    const re = /::/g;
    let m;
    while ((m = re.exec(s))) {
      const pos = m.index;
      if (!open) {
        const nm = BACK.exec(s.slice(Math.max(0, pos - 40), pos));
        if (nm) open = { start: pos - nm[0].length, end: pos, range: nm[2] !== undefined, lo: nm[1], hi: nm[2], step: nm[3] };
      } else {
        if (open.range) reps.push({ start: open.start, end: open.end, val: pickRange(open.lo, open.hi, open.step) });
        open = null;
      }
    }
    for (let i = reps.length - 1; i >= 0; i--) s = s.slice(0, reps[i].start) + reps[i].val + s.slice(reps[i].end);
    return s;
  }

  // 展開の順番: {a|b} の抽選 → SD形式の変換 → 重みの範囲抽選
  const transform = (v) => expandRanges(convertSD(expand(v)));
  const needs = (v) => (v.includes("{") && v.includes("|")) || (v.includes("(") && v.includes(":")) || v.includes("::") || v.includes("__");

  // リクエストのJSONの文字列をすべて確認して展開する
  // 同じ文字列は同じ結果にそろえる（input と v4_prompt の中身がずれないように）
  // ただし、キャラクターごと（char_captions / characterPrompts の何番目か）には別々に抽選する
  // （v0.18.1: 以前はキャラ1と2が同じ文だと、必ず同じ結果になっていた）
  function rewrite(bodyText, quiet) {
    let json;
    try {
      json = JSON.parse(bodyText);
    } catch (e) {
      if (!quiet) dbg("リクエストをJSONとして読めませんでした。先頭:", JSON.stringify(bodyText.slice(0, 80)));
      return bodyText;
    }
    // 使ったモデルを、拡張機能のメモ欄に知らせる（モデル別のメモ・バックアップ用）
    try {
      if (json && typeof json.model === "string") window.postMessage({ __naix: "model", model: json.model }, "*");
    } catch (e) {}
    // 生成の設定を、プリセット（preset.js）に知らせる（v0.22.0）
    try {
      const p = json && json.parameters;
      if (p && typeof p === "object" && (p.width || p.steps)) {
        window.postMessage(
          {
            __naix: "params",
            params: {
              model: json.model, width: p.width, height: p.height, steps: p.steps, scale: p.scale, sampler: p.sampler,
              cfg_rescale: p.cfg_rescale, noise_schedule: p.noise_schedule, n_samples: p.n_samples,
              uc: typeof p.negative_prompt === "string" ? p.negative_prompt : undefined,
            },
          },
          "*"
        );
      }
    } catch (e) {}
    const memo = new Map();
    let changed = false;

    dbg("生成リクエストを検出。input =", String(json.input).slice(0, 300));
    const cap = json.parameters && json.parameters.v4_prompt && json.parameters.v4_prompt.caption;
    if (cap) dbg("base_caption =", String(cap.base_caption).slice(0, 300));

    const CHAR_LISTS = new Set(["char_captions", "characterPrompts"]);
    const walk = (v, slot, key) => {
      if (typeof v === "string") {
        if (!needs(v)) return v;
        const mk = slot + "\u0000" + v;
        if (!memo.has(mk)) memo.set(mk, { before: v, after: transform(v) });
        const r = memo.get(mk).after;
        if (r !== v) changed = true;
        return r;
      }
      if (Array.isArray(v)) return v.map((x, i) => walk(x, CHAR_LISTS.has(key) ? "c" + i : slot));
      if (v && typeof v === "object") {
        const o = {};
        for (const k of Object.keys(v)) o[k] = walk(v[k], slot, k);
        return o;
      }
      return v;
    };

    const result = walk(json, "m", "");
    if (!changed) {
      dbg("{a|b} は見つかりませんでした（そのまま送信します）");
      return bodyText;
    }
    for (const { before, after } of memo.values()) {
      if (before !== after) say("展開:", before, "→", after);
    }
    // 抽選の前・後のプロンプトを、拡張の履歴に渡す（画像のメタデータには、抽選後しか残らないため）
    try {
      const pick = (j) => {
        const p = (j && j.parameters) || {};
        const cap = p.v4_prompt && p.v4_prompt.caption;
        const main = cap && typeof cap.base_caption === "string" ? cap.base_caption : typeof j.input === "string" ? j.input : "";
        const chars = ((cap && cap.char_captions) || []).map((c) => (c && typeof c.char_caption === "string" ? c.char_caption : ""));
        return { main, chars, seed: p.seed };
      };
      const b = pick(json);
      const a = pick(result);
      const pk = picks ? picks.slice() : [];
      window.postMessage({ __naix: "gen", ts: Date.now(), seed: a.seed, before: { main: b.main, chars: b.chars }, after: { main: a.main, chars: a.chars }, picks: pk }, "*");
      rememberOrig({ seed: a.seed, before: { main: b.main, chars: b.chars }, after: { main: a.main, chars: a.chars }, picks: pk });
    } catch (e) {}
    return JSON.stringify(result);
  }

  // ---- 文字列以外のbody（バイナリ・gzip圧縮など）にも対応する ----
  const hex = (u8) => Array.from(u8.slice(0, 12), (x) => x.toString(16).padStart(2, "0")).join(" ");

  async function toBytes(body) {
    if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    return null;
  }
  const pipe = async (bytes, stream) =>
    new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
  const gunzip = (bytes) => pipe(bytes, new DecompressionStream("gzip"));
  const gzip = (bytes) => pipe(bytes, new CompressionStream("gzip"));

  // フォーム形式(FormData)のbody: 全項目を調べて、文字列・JSONファイルの中の {a|b} を展開する
  async function rewriteForm(fd) {
    const out = new FormData();
    const memo = new Map();
    let changed = false;
    for (const [name, v] of fd.entries()) {
      if (typeof v === "string") {
        dbg("フォーム項目:", name, "（文字列", v.length, "文字）");
        let r = rewrite(v, true);
        if (r === v && needs(v)) {
          let isJson = true;
          try {
            JSON.parse(v);
          } catch (e) {
            isJson = false;
          }
          if (!isJson) {
            // JSONではない普通の文字列（プロンプトそのもの）
            if (!memo.has(v)) memo.set(v, transform(v));
            r = memo.get(v);
            if (r !== v) say("展開:", v, "→", r);
          }
        }
        if (r !== v) changed = true;
        out.append(name, r);
      } else {
        dbg("フォーム項目:", name, "（ファイル", v.type || "typeなし", v.size + "バイト", v.name || "", "）");
        let nv = v;
        if (v.size <= 2 * 1024 * 1024) {
          const head = new Uint8Array(await v.slice(0, 2).arrayBuffer());
          // { で始まる(JSON) か gzip のファイルだけ調べる。画像などは触らない
          if (head[0] === 0x7b || (head[0] === 0x1f && head[1] === 0x8b)) {
            const r = await rewriteAny(v);
            if (r !== v) {
              nv = typeof File !== "undefined" && v instanceof File ? new File([r], v.name, { type: v.type }) : r;
              changed = true;
            }
          }
        }
        if (v.name !== undefined) out.append(name, nv, v.name);
        else out.append(name, nv);
      }
    }
    return changed ? out : fd;
  }

  // body を書き換えた新しい body を返す（変更がなければ元の body をそのまま返す）
  async function rewriteAny(body) {
    dbg("リクエストbodyの種類:", Object.prototype.toString.call(body));
    if (typeof body === "string") return rewrite(body);
    if (typeof FormData !== "undefined" && body instanceof FormData) return rewriteForm(body);

    const bytes = await toBytes(body);
    if (!bytes) {
      dbg("このbodyの種類には対応していません（そのまま送信します）");
      return body;
    }
    dbg("body先頭バイト:", hex(bytes), "/ サイズ:", bytes.length);
    const gz = bytes[0] === 0x1f && bytes[1] === 0x8b;
    const raw = gz ? await gunzip(bytes) : bytes;
    const text = new TextDecoder().decode(raw);
    const out = rewrite(text);
    if (out === text) return body;

    let enc = new TextEncoder().encode(out);
    if (gz) enc = await gzip(enc);
    return body instanceof Blob ? new Blob([enc], { type: body.type }) : enc;
  }

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    try {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (methodOf(input, init) !== "GET" && /novelai/i.test(url)) dbg("送信:", methodOf(input, init), url);
      if (URL_RE.test(url)) {
        loadCfg();
        picks = [];
        const h = new Headers((init && init.headers) || (input instanceof Request ? input.headers : undefined));
        dbg("Content-Type:", h.get("content-type"), "/ Content-Encoding:", h.get("content-encoding"));
        if (init && init.body != null) {
          const nb = await rewriteAny(init.body);
          if (nb !== init.body) init = Object.assign({}, init, { body: nb });
        } else if (input instanceof Request) {
          const buf = new Uint8Array(await input.clone().arrayBuffer());
          const nb = await rewriteAny(buf);
          if (nb !== buf) input = new Request(input, { body: nb });
        }
      }
    } catch (e) {
      console.warn("[NAIX] 展開に失敗しました（そのまま送ります）", e);
    }
    return origFetch.call(this, input, init);
  };

  const xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (String(method).toUpperCase() !== "GET" && /novelai/i.test(String(url))) dbg("XHR送信:", method, String(url));
    return xhrOpen.apply(this, arguments);
  };

  // ユーザースクリプト版: 抽選前の記録（画像のメタデータ用）は使わない
  function rememberOrig() {}

  say("{a|b} 展開を有効にしました（ユーザースクリプト版）");
})();

// ---- 抽選の結果を、画面下に少しだけ表示する（スマホにはConsoleがないため） ----
(() => {
  let box = null;
  let timer = 0;
  const show = (text) => {
    if (!document.body) return;
    if (!box) {
      box = document.createElement("div");
      box.style.cssText =
        "position:fixed;left:8px;right:8px;bottom:calc(8px + env(safe-area-inset-bottom));z-index:2147483647;" +
        "max-height:30vh;overflow:auto;padding:8px 10px;border-radius:8px;background:#1c1d2af0;color:#e8e8f0;" +
        "border:1px solid #f5c06f;font:12px/1.45 system-ui,sans-serif;white-space:pre-wrap;word-break:break-word;";
      box.addEventListener("click", () => (box.style.display = "none"));
      document.body.appendChild(box);
    }
    box.textContent = text; // 必ず textContent（HTMLとして解釈しない）
    box.style.display = "block";
    clearTimeout(timer);
    timer = setTimeout(() => (box.style.display = "none"), 6000);
  };
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.__naix !== "gen" || !d.after) return;
    const lines = ["🎲 抽選しました（タップで閉じる）", "メイン: " + String(d.after.main || "").slice(0, 400)];
    (d.after.chars || []).forEach((c, i) => c && lines.push(`キャラ${i + 1}: ` + String(c).slice(0, 200)));
    show(lines.join("\n"));
  });
  const ready = () => show("🎲 {a|b} 抽選が有効です");
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready, { once: true });
  else ready();
})();
