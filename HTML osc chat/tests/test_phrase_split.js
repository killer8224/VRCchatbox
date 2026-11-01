/* 短语切分回归测试（无需浏览器）：node 'HTML osc chat/tests/test_phrase_split.js'
 *
 * 重点守住两条不变量：
 *   1. splitPhrases(text).join("") === text —— 不重不漏
 *   2. 英文方块绝不能切在单词内部（"your interesting song" 曾被切成 "your int" + "eresting"）
 */
"use strict";
const assert = require("assert");
const path = require("path");
const { splitPhrases, detectProfile } = require(path.join(__dirname, "..", "static", "phrase.js"));

let passed = 0;
function check(text, expected) {
  const out = splitPhrases(text);
  assert.strictEqual(out.join(""), text, "拼接后必须与原文一致：" + JSON.stringify(text));
  if (expected) assert.deepStrictEqual(out, expected, JSON.stringify(text));
  passed++;
}

// 回归：interesting 不能被劈成两半
check("your interesting song", ["your interesting song"]);
check("I really like your interesting song", ["I really like your ", "interesting song"]);
check("I want to go to the supermarket tomorrow", ["I want to go to the ", "supermarket tomorrow"]);

// 句末标点必须断块
check("Hello there. How are you doing today?", ["Hello there. ", "How are you doing today?"]);

// 缩写、数字后面的句点不是句末
check("Mr. Smith went to Washington with Dr. Brown.", ["Mr. Smith went to ", "Washington with Dr. Brown."]);

// 超长单词只能硬切，但不能死循环
const long = "supercalifragilisticexpialidocious is a very long word indeed";
const longOut = splitPhrases(long);
assert.ok(longOut.length > 1 && longOut.join("") === long);
passed++;

// 中文、日文行为保持不变（切分点与旧版一致）
check("你好，请问你叫什么名字？我是新来的玩家。", ["你好，请问你叫", "什么名字？", "我是新来的玩家。"]);
check("我今天去超市买了很多好吃的东西然后回家做饭", ["我今天去超市买了", "很多好吃的", "东西然后回家做饭"]);
check("短", ["短"]);

// 中英混排：英文单词同样不能被切开
const mixed = "今天听了一首 interesting song 很不错";
const mixedOut = splitPhrases(mixed);
assert.strictEqual(mixedOut.join(""), mixed);
let at = 0;
for (let i = 0; i < mixedOut.length - 1; i++) {
  at += mixedOut[i].length;
  const left = mixed[at - 1], right = mixed[at];
  assert.ok(!(/[A-Za-z]/.test(left) && /[A-Za-z]/.test(right)),
    "混排时切在了英文单词内部：" + JSON.stringify(mixedOut));
}
passed++;

// 语种判定
assert.strictEqual(detectProfile("hello world"), "en");
assert.strictEqual(detectProfile("你好"), "zh");
assert.strictEqual(detectProfile("こんにちは"), "ja");
passed++;

console.log(`PASS: phrase split — ${passed} cases`);
