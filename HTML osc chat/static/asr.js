/* 语音输入标签页（本地 ASR + 方块编辑）。
 *
 * 采集与识别逻辑移植自 VRCChatbox-ASR-Prototype/static/app.js，差别只有三点：
 *   1. 所有元素 id 加 asr- 前缀，避免与主界面冲突；
 *   2. 发送 / 保存复用主界面 window.VRCApp 的 OSC 与常用短语通道；
 *   3. 只在本标签页可见时采集，离开标签页立即释放麦克风。
 */
"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const split = window.PhraseSplit ? window.PhraseSplit.splitPhrases : (t) => (t ? [t] : []);
  const detectLang = window.PhraseSplit ? window.PhraseSplit.detectProfile : () => "zh";
  const TARGET_RATE = 16000;
  const MAX_QUEUE = 5;
  const MAX_CHARS = 144;
  const LANG_KEY = "vrc.asr.lang";

  const placeholderEl = $("asrPlaceholder");
  const app = () => window.VRCApp || {};

  /* ---------------------------- 状态 ---------------------------- */

  const state = {
    blocks: [],
    selection: new Set(),
    interim: "",
    interimMode: "append",
    replaceIds: [],
    utteranceOpen: false,
    nextId: 1,
  };
  let undoStack = [];
  let freshIds = new Set();
  let freshTimer = null;
  let sendBusy = false;
  let saveBusy = false;

  let listening = false, mediaStream = null, audioCtx = null, source = null, processor = null;
  let frameBuffer = [], frameSamples = 0, lastSpeechAt = 0;
  let currentUtteranceHasAudio = false, finalizing = false, micStreamRate = 48000, speechRms = 0;

  let modelReady = false;
  let statusTimer = null;

  /* ---------------------------- 渲染 ---------------------------- */

  function blockEl(text, opts) {
    const el = document.createElement("span");
    el.className = "asr-block" + (opts.cls ? " " + opts.cls : "");
    el.textContent = text;
    // 关键：给方块标上语言，浏览器才会用日文字体渲染日文汉字
    el.lang = detectLang(text);
    if (opts.id != null) {
      el.dataset.id = String(opts.id);
      el.setAttribute("role", "option");
      el.setAttribute("aria-selected", opts.cls && opts.cls.includes("sel") ? "true" : "false");
      el.title = "点击选中 / 取消";
    } else {
      el.dataset.pending = "1";
      el.setAttribute("aria-hidden", "true");
    }
    return el;
  }

  function targetSet() {
    return state.selection.size ? new Set(state.selection) : new Set(state.replaceIds);
  }

  function render() {
    const host = $("asrBlocks");
    const frag = document.createDocumentFragment();

    const showGhost = state.interimMode === "replace" && !!state.interim;
    const targets = showGhost ? targetSet() : new Set();
    let ghostAt = -1;
    if (showGhost) {
      state.blocks.forEach((b, i) => {
        if (targets.has(b.id) && (ghostAt < 0 || i < ghostAt)) ghostAt = i;
      });
      if (ghostAt < 0) ghostAt = state.blocks.length;
    }

    const emitGhost = () => {
      if (!state.interim) return;
      for (const t of split(state.interim)) frag.appendChild(blockEl(t, { cls: "pending" }));
    };

    state.blocks.forEach((b, i) => {
      if (i === ghostAt) emitGhost();
      const cls = [];
      if (state.selection.has(b.id)) cls.push("sel");
      if (targets.has(b.id)) cls.push("target");
      if (freshIds.has(b.id)) cls.push("fresh");
      frag.appendChild(blockEl(b.text, { id: b.id, cls: cls.join(" ") }));
    });
    if (ghostAt < 0 || ghostAt >= state.blocks.length) emitGhost();

    const empty = !state.blocks.length && !state.interim;
    placeholderEl.hidden = !empty;
    host.replaceChildren(frag);
    if (empty) host.appendChild(placeholderEl);

    updateCount();
  }

  function blocksText() {
    return state.blocks.map((b) => b.text).join("");
  }

  function charCount(text) {
    return [...String(text || "")].length;
  }

  function updateCount() {
    const n = charCount(blocksText()) + charCount(state.interim);
    const el = $("asrCount");
    el.textContent = `${n} / ${MAX_CHARS}`;
    el.classList.toggle("over", n > MAX_CHARS);
  }

  function updateSelectionUI() {
    const n = state.selection.size;
    $("asrSelectionBar").hidden = n === 0;
    $("asrDelSel").disabled = n === 0;
    if (!n) return;
    const chars = [...state.selection].reduce((sum, id) => {
      const b = findBlock(id);
      return sum + (b ? charCount(b.text) : 0);
    }, 0);
    $("asrSelectionText").textContent =
      `已选中 ${n} 个方块 · ${chars} 字 — 现在重新说一遍，完整识别后会整体替换`;
  }

  function findBlock(id) {
    return state.blocks.find((b) => b.id === id) || null;
  }
  function indexOfId(id) {
    return state.blocks.findIndex((b) => b.id === id);
  }

  function notice(text) {
    $("asrNotice").textContent = text;
  }

  function toast(text, error) {
    if (typeof app().showToast === "function") app().showToast(text, !!error);
    else notice(text);
  }

  function flash(ids) {
    freshIds = new Set(ids);
    clearTimeout(freshTimer);
    freshTimer = setTimeout(() => {
      freshIds = new Set();
      render();
    }, 900);
  }

  /* ---------------------------- 撤销 ---------------------------- */

  function pushUndo() {
    undoStack.push({
      blocks: state.blocks.map((b) => ({ ...b })),
      selection: new Set(state.selection),
    });
    if (undoStack.length > 50) undoStack.shift();
  }

  function undo() {
    const snap = undoStack.pop();
    if (!snap) {
      notice("没有可撤销的操作。");
      return;
    }
    state.blocks = snap.blocks;
    state.selection = snap.selection;
    state.interim = "";
    state.replaceIds = [];
    state.interimMode = "append";
    render();
    updateSelectionUI();
    notice("已撤销。");
  }

  /* ---------------------------- 选区 ---------------------------- */

  function toggleSelect(id) {
    const idx = indexOfId(id);
    if (idx < 0) return;
    const sel = state.selection;
    const wasEmpty = sel.size === 0;

    if (sel.has(id)) {
      sel.delete(id);                                  // 再次点击：只取消该块
    } else if (wasEmpty) {
      sel.add(id);                                     // 单击选择
    } else if (sel.has(state.blocks[idx - 1]?.id) || sel.has(state.blocks[idx + 1]?.id)) {
      sel.add(id);                                     // 相邻扩选
    } else {
      sel.clear();                                     // 点击远处：直接切换
      sel.add(id);
    }

    // 从「无选区」进入「有选区」时，丢弃服务端可能残留的上半句音频
    if (wasEmpty && sel.size && !state.utteranceOpen && !queue.length && !sending) {
      fetch("/api/asr/reset", { method: "POST" }).catch(() => {});
    }

    render();
    updateSelectionUI();
  }

  function clearSelection() {
    if (!state.selection.size) return;
    state.selection.clear();
    render();
    updateSelectionUI();
  }

  function deleteSelection() {
    if (!state.selection.size) return;
    pushUndo();
    const remove = new Set(state.selection);
    state.blocks = state.blocks.filter((b) => !remove.has(b.id));
    state.selection.clear();
    render();
    updateSelectionUI();
    notice("已删除选中的方块。");
  }

  /* ---------------------------- 识别结果 ---------------------------- */

  function beginUtterance() {
    if (state.utteranceOpen) return;
    state.utteranceOpen = true;
    state.interimMode = state.selection.size ? "replace" : "append";
    state.replaceIds = [...state.selection];
  }

  function applyInterim(text) {
    beginUtterance();
    state.interim = text || "";
    if (state.interimMode === "replace") {
      notice("正在听替换内容…完整识别后会整体替换选区。");
    }
    render();
  }

  function applyFinal(rawText) {
    const text = (rawText || "").trim();
    const mode = state.interimMode;
    const snapshot = new Set(state.replaceIds);

    state.utteranceOpen = false;
    state.interim = "";
    state.interimMode = "append";
    state.replaceIds = [];
    currentUtteranceHasAudio = false;
    finalizing = false;

    if (!text) {
      render();
      updateSelectionUI();
      $("asrMicStatus").textContent = "没有识别到内容，请再说一次。";
      return;
    }

    const targets = state.selection.size ? new Set(state.selection) : (mode === "replace" ? snapshot : new Set());
    if (mode === "replace" && targets.size) replaceTargets(targets, text);
    else appendPhrases(text);

    render();
    updateSelectionUI();
  }

  function appendPhrases(text) {
    const phrases = split(text);
    if (!phrases.length) return;
    pushUndo();
    const added = phrases.map((t) => ({ id: state.nextId++, text: t }));
    state.blocks.push(...added);
    flash(added.map((b) => b.id));
    notice(`已追加 ${added.length} 个方块。`);
  }

  function replaceTargets(targets, text) {
    const idxs = [...targets].map(indexOfId).filter((i) => i >= 0).sort((a, b) => a - b);
    if (!idxs.length) {
      appendPhrases(text);
      return;
    }
    const at = idxs[0];
    pushUndo();
    state.blocks = state.blocks.filter((b) => !targets.has(b.id));
    const added = split(text).map((t) => ({ id: state.nextId++, text: t }));
    state.blocks.splice(at, 0, ...added);
    state.selection.clear();                            // 替换后清空选区
    flash(added.map((b) => b.id));
    notice(`已用 ${added.length} 个方块替换选区，选区已清空。`);
  }

  /* ---------------------------- 音频上传队列 ---------------------------- */

  const queue = [];
  let sending = false;

  function enqueue(samples, final) {
    if ((!samples || !samples.length) && !final) return;
    queue.push({ samples, final });
    while (queue.length > MAX_QUEUE) {
      const i = queue.findIndex((j) => !j.final);
      if (i < 0) break;
      queue.splice(i, 1);
      $("asrMicStatus").textContent = "识别跟不上语速，已丢弃最旧的一小段音频。";
    }
    pump();
  }

  async function pump() {
    if (sending) return;
    sending = true;
    try {
      while (queue.length) {
        const job = queue.shift();
        try {
          await postAudio(job.samples, job.final);
        } catch (e) {
          $("asrMicStatus").textContent = "识别错误：" + e.message;
        }
      }
    } finally {
      sending = false;
    }
  }

  async function postAudio(samples, final) {
    const pcm = samples && samples.length ? b64Float32(samples) : "";
    const r = await fetch("/api/asr/audio", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pcm, final, language: $("asrLang").value }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "识别请求失败");
    if (data.final) {
      applyFinal(data.text);
      $("asrMicStatus").textContent = "当前语句已定稿。";
    } else {
      applyInterim(data.text);
      $("asrMicStatus").lang = detectLang(data.text || "");
      $("asrMicStatus").textContent = `正在识别… ${data.text || ""}`;
    }
  }

  /* ---------------------------- 模型状态 ---------------------------- */

  function setStatus(text, kind) {
    const el = $("asrStatus");
    el.textContent = text;
    el.className = "pill" + (kind ? " " + kind : "");
  }

  function applyStatus(s) {
    modelReady = s.status === "ready";
    syncStartButton();
    const lang = $("asrLang");
    const saved = localStorage.getItem(LANG_KEY);
    const wanted = saved !== null ? saved : (s.language || "");
    if (wanted === "" || [...lang.options].some((o) => o.value === wanted)) lang.value = wanted;

    if (s.status === "ready") {
      setStatus("模型已就绪", "ok");
      $("asrModelInfo").textContent =
        `模型已加载（${s.load_seconds}s）· CPU 线程 ${s.threads} · 采样率 ${s.sample_rate} Hz · ${s.model_dir}`;
      $("asrStatus").title = "模型已就绪";
    } else if (s.status === "loading") {
      setStatus("模型加载中…", "warn");
      $("asrModelInfo").textContent = "首次打开需要把模型读入内存，通常十几秒，请稍候…";
      $("asrStatus").title = "模型加载中";
      scheduleStatusPoll();
    } else if (s.status === "idle") {
      setStatus("模型未加载", "");
      $("asrModelInfo").textContent = "进入本页会自动加载模型（约 2 秒）。";
      $("asrStatus").title = "点击立即加载";
    } else {
      setStatus("模型未加载", "bad");
      $("asrModelInfo").textContent = s.error || "模型尚未加载，请检查 models 目录与依赖。";
      $("asrStatus").title = "点击重试加载";
    }
  }

  function scheduleStatusPoll() {
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => checkStatus(false), 1500);
  }

  async function checkStatus(load) {
    clearTimeout(statusTimer);
    try {
      const r = await fetch("/api/asr/status" + (load ? "?load=1" : ""), { cache: "no-store" });
      const s = await r.json();
      applyStatus(s);
    } catch (e) {
      modelReady = false;
      $("asrStart").disabled = true;
      setStatus("本地服务不可用", "bad");
      $("asrModelInfo").textContent = String(e);
    }
  }

  /* ---------------------------- 采集 ---------------------------- */

  // 浏览器只在「安全上下文 + 顶层页面（或被授权麦克风的 iframe）」里暴露
  // navigator.mediaDevices。为 undefined 时给出真正的原因，而不是笼统的「浏览器不支持」。
  function micSupport() {
    const framed = window.top !== window.self;
    const insecure = window.isSecureContext === false
      || (location.protocol !== "https:"
        && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname));
    const md = navigator.mediaDevices;
    if (!md || typeof md.getUserMedia !== "function") {
      let reason;
      if (framed) {
        reason = "页面嵌在内嵌预览窗口里，浏览器按权限策略禁用了麦克风。点右上「在新窗口打开」，在独立标签页里就能录音。";
      } else if (insecure) {
        reason = `当前地址 ${location.origin} 不是安全上下文，浏览器不允许录音。请在本机用 http://127.0.0.1:${location.port || 5000}/ 打开。`;
      } else {
        reason = "浏览器没有提供麦克风接口（navigator.mediaDevices 不可用）：请确认使用最新版 Chrome / Edge，且未被组策略禁用。";
      }
      return { ok: false, framed, insecure, reason };
    }
    try {
      const policy = document.permissionsPolicy || document.featurePolicy;
      if (policy && typeof policy.allowsFeature === "function" && !policy.allowsFeature("microphone")) {
        return {
          ok: false, framed, insecure,
          reason: framed
            ? "外层页面的权限策略禁止了麦克风（iframe 缺少 allow=\"microphone\"）。点右上「在新窗口打开」即可。"
            : "当前页面的权限策略禁止了麦克风，请检查浏览器策略设置。",
        };
      }
    } catch (_) { /* 旧浏览器没有该接口，交给 getUserMedia 自己报错 */ }
    return { ok: true, framed, insecure, reason: "" };
  }

  let micOk = true;

  function syncStartButton() {
    const btn = $("asrStart");
    if (btn) btn.disabled = !modelReady || !micOk || listening;
  }

  function refreshMicSupport() {
    const support = micSupport();
    micOk = support.ok;
    const popout = $("asrPopout");
    if (popout) popout.hidden = !(!support.ok || support.framed || support.insecure);
    const hint = $("asrMicStatus");
    if (!support.ok && hint) hint.textContent = support.reason;
    const startBtn = $("asrStart");
    if (startBtn) startBtn.title = support.ok ? "" : support.reason;
    syncStartButton();
    return support;
  }

  function micErrorText(e) {
    const name = (e && e.name) || "";
    if (name === "NotAllowedError" || name === "SecurityError")
      return "浏览器拒绝了麦克风权限：点地址栏左侧的图标允许麦克风，或检查 Windows 设置 → 隐私 → 麦克风。";
    if (name === "NotFoundError" || name === "OverconstrainedError")
      return "没有找到可用的麦克风，请检查设备连接，或在「麦克风设备」里换一个。";
    if (name === "NotReadableError")
      return "麦克风被其他程序占用（例如 VRChat、OBS），请先关闭占用它的程序。";
    return (e && e.message) || String(e);
  }

  async function listDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const select = $("asrDevice");
      const current = select.value;
      select.innerHTML = '<option value="">系统默认麦克风</option>';
      devices.filter((d) => d.kind === "audioinput").forEach((d) => {
        const o = document.createElement("option");
        o.value = d.deviceId;
        o.textContent = d.label || "麦克风";
        select.appendChild(o);
      });
      if (current && [...select.options].some((o) => o.value === current)) select.value = current;
    } catch (e) { /* 没有权限时忽略，开始监听会再次申请 */ }
  }

  function downsample(input, fromRate, toRate) {
    if (fromRate === toRate) return input;
    const ratio = fromRate / toRate;
    const outLength = Math.floor(input.length / ratio);
    const out = new Float32Array(outLength);
    for (let i = 0; i < outLength; i++) {
      const pos = i * ratio;
      const left = Math.floor(pos);
      const right = Math.min(left + 1, input.length - 1);
      const frac = pos - left;
      out[i] = input[left] * (1 - frac) + input[right] * frac;
    }
    return out;
  }

  function joinFloat32(chunks, n) {
    const out = new Float32Array(n);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }

  function b64Float32(float32) {
    const bytes = new Uint8Array(float32.buffer, float32.byteOffset, float32.byteLength);
    let binary = "";
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
      binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + step, bytes.length)));
    }
    return btoa(binary);
  }

  function flushAudio(final) {
    if (!frameSamples) {
      if (final) enqueue(null, true);
      return;
    }
    const chunk = joinFloat32(frameBuffer, frameSamples);
    frameBuffer = [];
    frameSamples = 0;
    enqueue(chunk, final);
  }

  async function start() {
    if (!modelReady) {
      toast("模型还没准备好，请等状态变成「模型已就绪」。", true);
      return;
    }
    const support = refreshMicSupport();
    if (!support.ok) {
      notice(support.reason);
      toast(support.reason, true);
      return;
    }
    try {
      const deviceId = $("asrDevice").value;
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      await listDevices();
      // 开始监听前清掉服务端缓冲，保证第一句从干净状态开始
      await fetch("/api/asr/reset", { method: "POST" }).catch(() => {});
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      micStreamRate = audioCtx.sampleRate;
      source = audioCtx.createMediaStreamSource(mediaStream);
      processor = audioCtx.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (e) => {
        if (!listening) return;
        const input = e.inputBuffer.getChannelData(0);
        let sum = 0;
        for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
        speechRms = Math.sqrt(sum / input.length);
        $("asrMeterFill").style.width = Math.min(100, Math.round(speechRms * 600)) + "%";

        const down = downsample(input, micStreamRate, TARGET_RATE);
        frameBuffer.push(down);
        frameSamples += down.length;

        const now = performance.now();
        if (speechRms > 0.012) {
          lastSpeechAt = now;
          currentUtteranceHasAudio = true;
        }
        const target = Math.round(TARGET_RATE * (Number($("asrChunkMs").value) / 1000));
        if (frameSamples >= target) {
          const take = [];
          let remain = target;
          while (remain > 0 && frameBuffer.length) {
            const first = frameBuffer[0];
            if (first.length <= remain) {
              take.push(first);
              remain -= first.length;
              frameBuffer.shift();
            } else {
              take.push(first.slice(0, remain));
              frameBuffer[0] = first.slice(remain);
              remain = 0;
            }
          }
          frameSamples -= target;
          enqueue(joinFloat32(take, target), false);
        }
        if (currentUtteranceHasAudio && !finalizing && now - lastSpeechAt > Number($("asrPauseMs").value)) {
          finalizing = true;
          flushAudio(true);
        }
      };
      source.connect(processor);
      processor.connect(audioCtx.destination);
      listening = true;
      lastSpeechAt = performance.now();
      syncStartButton();
      $("asrStop").disabled = false;
      $("asrMicStatus").textContent = `正在监听 · 输入采样率 ${micStreamRate} Hz。说一句话试试。`;
      notice("正在监听。选中方块后重新说一遍，可整体替换。");
    } catch (e) {
      $("asrMicStatus").textContent = "无法打开麦克风：" + micErrorText(e);
      toast("无法打开麦克风：" + micErrorText(e), true);
      stop();
    }
  }

  function stop() {
    const wasListening = listening;
    listening = false;
    if (processor) {
      processor.disconnect();
      processor.onaudioprocess = null;
      processor = null;
    }
    if (source) { source.disconnect(); source = null; }
    if (mediaStream) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null; }
    if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
    frameBuffer = [];
    frameSamples = 0;
    finalizing = false;
    currentUtteranceHasAudio = false;
    state.utteranceOpen = false;
    state.interim = "";
    syncStartButton();
    $("asrStop").disabled = true;
    $("asrMeterFill").style.width = "0%";
    if (wasListening) $("asrMicStatus").textContent = "已停止监听。";
    render();
    // 丢弃服务端残留的半句话，避免下次监听时把它接在新句子前面
    fetch("/api/asr/reset", { method: "POST" }).catch(() => {});
  }

  /* ---------------------------- 发送 / 清空 / 删除 / 撤销 / 保存 ---------------------------- */

  function setSendBusy(value) {
    sendBusy = value;
    $("asrSend").disabled = value;
    $("asrSend").textContent = value ? "发送中…" : "↗ 发送";
  }

  async function sendDraft() {
    if (sendBusy) return;
    const text = blocksText();
    if (!text.trim()) {
      notice("草稿为空，先说一句话或输入文字。");
      toast("草稿为空，没有可发送的内容。", true);
      return;
    }
    if (typeof app().sendFromDraft !== "function") {
      toast("发送通道未就绪，请刷新页面。", true);
      return;
    }
    setSendBusy(true);
    try {
      const result = await app().sendFromDraft(text);
      if (!result || !result.sent) {
        notice("没有可发送的内容。");
        return;
      }
      pushUndo();
      const remaining = String(result.remaining || "").trim();
      if (remaining) {
        // 超出 144 字符 / 9 行的部分按标点断开，重新切块留在草稿里继续编辑
        state.blocks = split(remaining).map((t) => ({ id: state.nextId++, text: t }));
        notice(`已发送 ${charCount(result.sent)} 字，剩余 ${charCount(remaining)} 字留在草稿里，可以继续发送。`);
        toast("已发送首段，剩余内容留在草稿。");
      } else {
        state.blocks = [];
        notice(`已发送 ${charCount(result.sent)} 字，草稿已清空。`);
        toast("已发送到 VRChat。");
      }
      state.selection.clear();
      state.interim = "";
      state.replaceIds = [];
      state.interimMode = "append";
      render();
      updateSelectionUI();
    } catch (e) {
      notice("发送失败，草稿已保留：" + e.message);
      toast("发送失败：" + e.message, true);
    } finally {
      setSendBusy(false);
    }
  }

  async function saveDraft() {
    if (saveBusy) return;
    const text = blocksText();
    if (!text.trim()) {
      notice("草稿为空，无法保存。");
      toast("草稿为空，无法保存。", true);
      return;
    }
    if (typeof app().saveQuickPhrase !== "function") {
      toast("保存通道未就绪，请刷新页面。", true);
      return;
    }
    saveBusy = true;
    $("asrSave").disabled = true;
    try {
      await app().saveQuickPhrase(text);
      notice("已保存到「常用短语」，可在短语页直接发送。");
      toast("已保存到「常用短语」。");
    } catch (e) {
      notice("保存失败：" + e.message);
      toast("保存失败：" + e.message, true);
    } finally {
      saveBusy = false;
      $("asrSave").disabled = false;
    }
  }

  async function clearDraft() {
    if (!state.blocks.length && !state.interim) {
      notice("草稿已经是空的。");
      return;
    }
    pushUndo();
    state.blocks = [];
    state.selection.clear();
    state.interim = "";
    state.replaceIds = [];
    state.interimMode = "append";
    currentUtteranceHasAudio = false;
    render();
    updateSelectionUI();
    notice("草稿已清空，可用「撤销」恢复。");
    await fetch("/api/asr/reset", { method: "POST" }).catch(() => {});
  }

  async function copyDraft() {
    const text = blocksText();
    if (!text) {
      notice("草稿为空。");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      notice("已复制整段草稿。");
    } catch (e) {
      notice("复制失败，请手动选择文本。");
    }
  }

  /* ---------------------------- 绑定 ---------------------------- */

  // 模板与脚本可能因缓存/未重启而不一致：元素缺失时静默跳过，
  // 绝不让一个缺失的按钮把整个标签页的初始化打断。
  function on(id, type, handler) {
    const el = $(id);
    if (el) el.addEventListener(type, handler);
    return el;
  }

  on("asrBlocks", "click", (e) => {
    const el = e.target.closest(".asr-block");
    if (!el || el.dataset.pending) return;
    toggleSelect(Number(el.dataset.id));
  });

  on("asrStart", "click", start);
  on("asrStop", "click", stop);
  on("asrClearSel", "click", clearSelection);
  on("asrDelSel", "click", deleteSelection);
  on("asrUndo", "click", undo);
  on("asrClear", "click", clearDraft);
  on("asrSend", "click", sendDraft);
  on("asrSave", "click", saveDraft);
  on("asrCopy", "click", copyDraft);
  on("asrStatus", "click", () => {
    if (!modelReady) checkStatus(true);
  });
  // 内嵌预览窗口 / 非安全上下文里拿不到麦克风时，引导用户跳到独立标签页
  on("asrPopout", "click", () => {
    const opened = window.open(location.href, "_blank", "noopener");
    if (!opened) toast("浏览器拦截了新窗口，请手动复制地址在新标签页打开。", true);
  });

  // 切换语种：服务端缓冲里是旧设置下累积的音频，必须丢弃
  on("asrLang", "change", async () => {
    localStorage.setItem(LANG_KEY, $("asrLang").value);
    finalizing = false;
    currentUtteranceHasAudio = false;
    frameBuffer = [];
    frameSamples = 0;
    state.utteranceOpen = false;
    state.interim = "";
    render();
    const label = $("asrLang").selectedOptions[0].textContent;
    $("asrMicStatus").textContent = `识别语种已切换为 ${label}，缓冲已清空。`;
    await fetch("/api/asr/reset", { method: "POST" }).catch(() => {});
  });

  // 快捷键只在本标签页生效，且焦点不在输入框里，避免干扰主界面
  document.addEventListener("keydown", (e) => {
    if ($("view-asr").hidden) return;
    const tag = (e.target && e.target.tagName) || "";
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || e.target?.isContentEditable) return;
    if (e.key === "Escape") {
      if (state.selection.size) {
        e.preventDefault();
        clearSelection();
      } else if (listening) {
        stop();
      }
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && state.selection.size) {
      e.preventDefault();
      deleteSelection();
      return;
    }
    if (e.ctrlKey && e.key === "Enter") {
      e.preventDefault();
      copyDraft();
    }
  });

  window.addEventListener("pagehide", () => {
    if (listening) stop();
  });

  navigator.mediaDevices?.addEventListener?.("devicechange", listDevices);

  /* ---------------------------- 对外接口 ---------------------------- */

  window.VRCASR = {
    // 进入标签页：首次进入才触发模型加载，避免开机就读 942MB
    resume() {
      refreshMicSupport();
      checkStatus(!modelReady);
    },
    // 离开标签页：释放麦克风，避免浏览器一直显示录音中
    suspend() {
      if (listening) {
        stop();
        notice("已离开语音输入标签页，麦克风已停止。");
      }
    },
    isListening: () => listening,
  };

  try {
    render();
    updateSelectionUI();
    refreshMicSupport();
  } catch (e) {
    // 界面元素与脚本版本不一致时仍然继续查询模型状态，避免卡在「正在检查模型…」
    console.error("[asr] 初始化异常：", e);
  }
  setStatus("正在检查模型…");
  checkStatus(false);
})();
