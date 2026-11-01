/* 短语切分：把识别结果切成较短的“自然短语”，用于方块化显示。
 *
 * 不变量：splitPhrases(text).join("") === text
 * 即每个字都属于且只属于一个方块，既不重合也不遗漏。
 *
 * 分语言规则：含假名（ひらがな/カタカナ）时用日语规则；整段没有汉字/假名但有
 * 拉丁字母时用英语规则；其余用中文规则。中文规则与旧版完全一致；日语规则补上了
 * “、”断点、日语助词/接续词，并放宽了单块长度（日语同样信息量需要更多字）。
 * 英语规则按空格分词，块边界只落在词与词之间——绝不把单词切成两半。
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.PhraseSplit = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // 句末标点：一定断开
  const STRONG_CHARS = "。！？!?…";
  const CLOSER = new Set("”’」』）)】》〉\"'".split(""));
  const SOFT_SUFFIX = new Set(["～", "~", "ー"]);

  // 这些字后面常是短语的自然边界
  const ZH_SOFT_AFTER = "的了着过吗呢吧啊呀哦嘛么啦呗".split("");
  // 日语助词/终助词：后面断句读起来最自然（日文字幕的常规断法）
  const JA_SOFT_AFTER = "はがをにでとものへやかねよな".split("");
  // 这些“前字+后字”组合是一个词，不能从中间切开
  const JA_NO_CUT = [
    "です", "でし", "でせ", "でた", "でな", "では",
    "にな", "によ", "につ", "には", "にし",
    "のは", "のに", "ので", "のを", "のな",
    "とは", "とも", "とか", "とい", "とお",
    "てし", "てく", "ちゃ", "じゃ", "かな", "けど", "ので", "んで",
    "ます", "ませ", "まし"
  ];

  // 这些词前面常是短语的自然边界
  const ZH_SOFT_WORDS = [
    "然后", "但是", "可是", "因为", "所以", "如果", "虽然", "不过", "而且", "并且",
    "或者", "还是", "就是", "其实", "比如", "例如", "另外", "总之", "于是", "因此",
    "只要", "只有", "即使", "无论", "不管", "现在", "今天", "明天", "昨天", "刚才",
    "后来", "我们", "你们", "他们", "大家", "这个", "那个", "什么", "怎么", "为什么",
    "可以", "应该", "需要", "已经", "正在", "马上", "突然", "结果", "反正", "至少",
    "大概", "可能", "一定", "必须", "的话", "的时候", "以后", "以前", "之后", "之前",
    "还有", "一个", "这种", "那种", "这里", "那里", "这些", "那些", "自己", "别人"
  ];

  const JA_SOFT_WORDS = [
    "そして", "しかし", "だから", "ですから", "でも", "それで", "ところで", "つまり",
    "たとえば", "例えば", "また", "じゃあ", "では", "これは", "それは", "あれは",
    "これから", "それから", "今日", "明日", "昨日", "本当に", "ちょっと", "やっぱり",
    "ありがとう", "すみません", "お願い"
  ];

  // 英语靠空格分词，块边界只能落在词与词之间，绝不能切在单词内部。
  // 这些词前面常是分句的自然边界（块已经接近上限时优先在这里断开）。
  const EN_SOFT_WORDS = new Set([
    "and", "but", "so", "because", "then", "however", "actually", "anyway",
    "maybe", "also", "if", "when", "while", "after", "before", "though",
    "although", "since", "or", "yet", "plus", "else", "otherwise", "besides"
  ]);
  // 这些缩写后面的句点不是句末，不能在这里断块
  const EN_ABBREV = new Set([
    "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc", "no", "fig", "approx", "e.g", "i.e"
  ]);
  // 英文的弱标点（断块时可以断，但只在块已经够长时）
  const EN_WEAK_TAIL = /[,;:，；：]$/;

  function makeProfile(key, maxLen, minLen, weakMin, weakChars, softAfterChars, softWords, noCut) {
    const byFirst = new Map();
    for (const w of softWords) {
      const k = w[0];
      if (!byFirst.has(k)) byFirst.set(k, []);
      byFirst.get(k).push(w);
    }
    return {
      key,
      maxLen,
      minLen,
      weakMin,
      strong: new Set(STRONG_CHARS.split("")),
      weak: new Set(weakChars.split("")),
      softAfter: new Set(softAfterChars),
      noCut: new Set(noCut || []),
      byFirst,
      trailing: new Set([...STRONG_CHARS.split(""), ...weakChars.split(""), ...CLOSER, ...SOFT_SUFFIX]),
    };
  }

  const PROFILES = {
    // 中文：保持旧行为（8 字上限，顿号“、”不断开）
    zh: makeProfile("zh", 8, 3, 4, "，；：,;:", ZH_SOFT_AFTER, ZH_SOFT_WORDS),
    // 日语：“、”就是逗号，必须参与断句；单块放宽到 11 字
    ja: makeProfile("ja", 11, 4, 5, "、，；：,;:", JA_SOFT_AFTER, JA_SOFT_WORDS, JA_NO_CUT),
    // 英语：maxLen / minLen 直接按字符算，切分走 splitEnWords（按词断，不切单词）
    en: makeProfile("en", 26, 3, 6, ",;:", "", [], []),
  };
  PROFILES.en.wordAware = true;

  const KANA = /[\u3040-\u30ff]/;
  const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
  const LATIN = /[A-Za-z]/;

  function detectProfile(src) {
    if (KANA.test(src)) return PROFILES.ja;
    // 完全没有汉字/假名、但有拉丁字母：按英语处理（中文里夹英文词仍走中文规则）
    if (!CJK.test(src) && LATIN.test(src)) return PROFILES.en;
    return PROFILES.zh;
  }

  function softWordAt(prof, s, i) {
    const list = prof.byFirst.get(s[i]);
    if (!list) return 0;
    for (const w of list) if (s.startsWith(w, i)) return w.length;
    return 0;
  }

  function isAsciiWord(ch) {
    return !!ch && /[A-Za-z0-9_'\-.]/.test(ch);
  }

  // 日语：小写假名 / 促音 / 长音符不能出现在块首（“ゃ”“っ”“ー”开头会很难读）
  function isBadHead(ch) {
    return !!ch && /[\u3041\u3043\u3045\u3047\u3049\u3063\u3083\u3085\u3087\u308E\u30A1\u30A3\u30A5\u30A7\u30A9\u30C3\u30E3\u30E5\u30E7\u30EE\u30FC]/.test(ch);
  }

  // 片假名外来词内部不能切（クリア / ゲーム …）
  function isKatakana(ch) {
    return !!ch && /[\u30A0-\u30FF]/.test(ch) && ch !== "ー";
  }

  // 切口两侧是否正好拼成一个词（です / のに / ます …）
  function isForbiddenCut(prof, s, c) {
    if (!prof.noCut.size || c <= 0) return false;
    return prof.noCut.has(s.slice(c - 1, c + 1));
  }

  function weight(ch) {
    const c = ch.codePointAt(0);
    if (c === 32 || c === 0x3000) return 0.5;
    if (c < 0x2e80) return 0.55;
    return 1;
  }

  function visibleLength(s) {
    let n = 0;
    for (const ch of s) n += weight(ch);
    return n;
  }

  function findCut(prof, s, start, maxLen, minLen) {
    const n = s.length;
    if (n - start <= maxLen) return n;
    const minEnd = Math.min(n, start + minLen);
    const maxEnd = Math.min(n, start + maxLen);
    // 连接词断点不要离起点太近，否则会切出“所以我”这种碎片
    const softMin = start + Math.max(minLen, Math.ceil(maxLen * 0.55));

    // 1) 优先断在“的 / 了 / は / が”等虚词之后
    let best = -1;
    for (let c = minEnd; c <= maxEnd; c++) {
      if (prof.softAfter.has(s[c - 1]) && !prof.trailing.has(s[c] || "") && !isBadHead(s[c]) && !isForbiddenCut(prof, s, c)) best = c;
    }
    if (best > 0 && n - best >= minLen) return best;

    // 2) 其次断在“然后 / しかし / だから”等连接词之前（允许略微超出上限）
    best = -1;
    const softEnd = Math.min(n, start + maxLen + 3);
    for (let c = Math.max(softMin, minEnd); c <= softEnd; c++) {
      if (softWordAt(prof, s, c) && !prof.trailing.has(s[c]) && !isForbiddenCut(prof, s, c)) best = c;
    }
    if (best > 0 && n - best >= minLen) return best;

    // 3) 兜底：按上限切，但不能切开英文单词/数字，也不要把虚词甩到下一块开头
    let c = maxEnd;
    while (c > minEnd && isAsciiWord(s[c - 1]) && isAsciiWord(s[c] || "")) c--;
    if (c <= minEnd && isAsciiWord(s[c - 1]) && isAsciiWord(s[c] || "")) {
      // 整个 [minEnd, maxEnd] 窗口都落在同一个英文单词内部（interesting / supermarket …）：
      // 向后找到词尾再切，宁可这一块略超上限，也不能把单词劈成两半。
      let f = maxEnd;
      while (f < n && isAsciiWord(s[f - 1]) && isAsciiWord(s[f] || "")) f++;
      c = f;
    }
    while (c > minEnd && isBadHead(s[c])) c--;
    while (c > minEnd && isKatakana(s[c - 1]) && isKatakana(s[c] || "")) c--;
    while (c > minEnd && isForbiddenCut(prof, s, c)) c--;
    let shift = 0;
    while (shift < 2 && c + shift < n && prof.softAfter.has(s[c + shift])) shift++;
    c += shift;
    // 空格归前一块，避免出现以空格开头的方块
    while (c < n && /\s/.test(s[c])) c++;
    if (n - c < minLen) return n;
    return c;
  }

  function subSplit(prof, s, maxLen, minLen) {
    const pieces = [];
    let start = 0;
    let guard = 0;
    while (start < s.length && guard++ < 1000) {
      const cut = findCut(prof, s, start, maxLen, minLen);
      const next = cut > start ? cut : Math.min(s.length, start + maxLen);
      pieces.push(s.slice(start, next));
      start = next;
    }
    return pieces;
  }

  // 句首标点/空格向前归并，避免出现以“，”或空格开头的方块
  function rebalanceLeadingPunct(prof, pieces) {
    for (let i = 1; i < pieces.length; i++) {
      let lead = "";
      let j = 0;
      while (j < pieces[i].length && (prof.trailing.has(pieces[i][j]) || /\s/.test(pieces[i][j]))) {
        lead += pieces[i][j];
        j++;
      }
      if (lead && j < pieces[i].length) {
        pieces[i - 1] += lead;
        pieces[i] = pieces[i].slice(j);
      }
    }
    return pieces.filter((p) => p.length > 0);
  }

  // 过短的碎片并入相邻方块，但不跨句末标点
  function mergeTiny(prof, pieces) {
    const out = [];
    for (const p of pieces) {
      const prev = out[out.length - 1];
      const prevEndsSentence = prev ? prof.strong.has(prev[prev.length - 1]) : false;
      const startsWithPunct = prof.trailing.has(p[0]);
      if (prev && !prevEndsSentence && !startsWithPunct && visibleLength(p) < 2) {
        out[out.length - 1] = prev + p;
      } else {
        out.push(p);
      }
    }
    return out;
  }

  // 英语：块边界只能落在词与词之间。先按「词 + 后续空白」切成单元，
  // 再按 maxLen（字符数）贪心拼块，拼接结果与原文完全一致。
  function isEnSentenceEnd(word) {
    const m = /[.!?…。！？]$/.exec(word);
    if (!m) return false;
    if (m[0] !== ".") return true;
    const bare = word.slice(0, -1);
    if (!bare) return false;
    if (/\d$/.test(bare)) return false;                    // 3. / 1.
    if (EN_ABBREV.has(bare.toLowerCase())) return false;   // Mr. / etc. / e.g.
    if (/^[A-Z]$/.test(bare)) return false;                // J. Smith
    return true;
  }

  function lastWordOf(piece) {
    const core = piece.replace(/\s+$/, "");
    return core.slice(core.lastIndexOf(" ") + 1);
  }

  function splitEnWords(text, maxLen, minLen) {
    const units = [];
    for (const raw of text.match(/\s*\S+\s*/g) || [text]) {
      const m = /^(\s*)(\S+)(\s*)$/.exec(raw);
      if (!m) { units.push(raw); continue; }
      const lead = m[1], core = m[2], tail = m[3];
      if (core.length <= maxLen) { units.push(raw); continue; }
      // 单个单词本身就超过上限（罕见）：只能硬切，否则永远装不下
      let rest = core, first = true;
      while (rest.length > maxLen) {
        units.push((first ? lead : "") + rest.slice(0, maxLen));
        rest = rest.slice(maxLen);
        first = false;
      }
      units.push((first ? lead : "") + rest + tail);
    }

    const softAt = Math.max(minLen, Math.ceil(maxLen * 0.6));
    const out = [];
    let cur = "";
    for (const u of units) {
      const core = u.trim();
      if (!cur) { cur = u; continue; }
      const prevCore = cur.replace(/\s+$/, "");
      const fits = (cur + core).replace(/\s+$/, "").length <= maxLen;
      const softNext = EN_SOFT_WORDS.has(core.toLowerCase().replace(/[^a-z']/g, ""));
      const nearLimit = prevCore.length >= softAt;
      if (
        isEnSentenceEnd(lastWordOf(cur)) ||        // 上一块已到句末
        !fits ||                                   // 装不下了
        (nearLimit && (EN_WEAK_TAIL.test(prevCore) || softNext))  // 接近上限且正好有自然边界
      ) {
        out.push(cur);
        cur = u;
      } else {
        cur += u;
      }
    }
    if (cur) out.push(cur);

    // 末尾过短的碎片并入前一块，但不跨句末标点
    if (out.length > 1) {
      const last = out[out.length - 1];
      const prev = out[out.length - 2];
      if (last.trim().length < minLen && !isEnSentenceEnd(lastWordOf(prev))) {
        out.splice(out.length - 2, 2, prev + last);
      }
    }

    // 末块明显偏短时从前一块借词，避免出现「like」这种孤立方块
    const floor = Math.ceil(maxLen * 0.4);
    for (let guard = 0; guard < 8 && out.length > 1; guard++) {
      const last = out[out.length - 1];
      const prev = out[out.length - 2];
      if (last.trim().length >= floor) break;
      // 只在空白规整时借词：重排会重新拼接空格，换行/制表符不能被动到
      if (/[\n\t\r]|  /.test(prev)) break;
      const words = prev.replace(/\s+$/, "").split(/\s+/);
      if (words.length <= 2) break;
      const give = words.pop() + " ";
      const nextLast = give + last;
      if (nextLast.replace(/\s+$/, "").length > maxLen) break;
      out[out.length - 2] = words.join(" ") + " ";
      out[out.length - 1] = nextLast;
    }
    return out;
  }

  function splitPhrases(text, opts) {
    const src = String(text == null ? "" : text);
    if (!src) return [];

    const prof = (opts && opts.lang && PROFILES[opts.lang]) || detectProfile(src);
    const maxLen = (opts && opts.maxLen) || prof.maxLen;
    const minLen = (opts && opts.minLen) || prof.minLen;
    const weakMin = (opts && opts.weakMin) || prof.weakMin;

    if (prof.wordAware) return splitEnWords(src, maxLen, minLen);

    // 第一轮：按标点切分，标点跟着前一个方块
    const chunks = [];
    let buf = "";
    let visible = 0;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      buf += ch;
      visible += weight(ch);
      if (prof.strong.has(ch) || prof.weak.has(ch)) {
        while (i + 1 < src.length && prof.trailing.has(src[i + 1])) {
          i++;
          buf += src[i];
          visible += weight(src[i]);
        }
        if (prof.strong.has(ch) || visible >= weakMin) {
          chunks.push(buf);
          buf = "";
          visible = 0;
        }
      }
    }
    if (buf) chunks.push(buf);

    // 第二轮：仍然过长的方块按虚词/连接词再切
    const pieces = [];
    for (const c of chunks) {
      if (visibleLength(c) <= maxLen) pieces.push(c);
      else for (const p of subSplit(prof, c, maxLen, minLen)) pieces.push(p);
    }

    return mergeTiny(prof, rebalanceLeadingPunct(prof, pieces));
  }

  return { splitPhrases, visibleLength, detectProfile: (s) => detectProfile(String(s || "")).key };
});
