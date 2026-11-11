/* ============================================================
 * 程序化音效与无版权音乐引擎（WebAudio 纯代码实时合成）
 * - 0 外部音频库依赖、0 版权风险、0 加载延迟
 * - D 小调悬疑环境配乐（Film Noir Drone）+ 生成式雨夜琴音（Generative Chimes）
 * - 室内低通白噪暴雨声 + 偶发低频超重低音闷雷
 * - AnalyserNode 实时声学能量分析器（输出低频/总体音量供 UI 律动）
 * - 开场 15 秒旁白音频驱动器（带精准时间码与平滑淡出）
 * ============================================================ */

import { storage } from './storage.js?v=3.6.0';

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.analyser = null;
    this.freqData = null;

    // 雨声节点
    this.rainNode = null;
    this.rainGain = null;

    // BGM 节点
    this.bgmOscs = [];
    this.bgmGain = null;
    this.bgmFilter = null;
    this.bgmLfo = null;
    this.bgmTimer = null;
    this.bgmRunning = false;

    // 旁白语音播放器
    this.narrationEl = null;

    // 状态
    this.muted = false;
    this.muted = storage.getItem('rain-gallery-muted') === '1';

    // 事件回调
    this.thunderCallbacks = [];
  }

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();

      // 构建 Master 增益与分析器拓扑
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.muted ? 0 : 1;

      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 64; // 32 个频带，极低 CPU 消耗
      this.freqData = new Uint8Array(this.analyser.frequencyBinCount);

      this.masterGain.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    return this.ctx;
  }

  /* ---------- 静音切换 ---------- */
  isMuted() {
    return this.muted;
  }

  toggleMute() {
    this.setMuted(!this.muted);
    return this.muted;
  }

  setMuted(muted) {
    this.muted = !!muted;
    storage.setItem('rain-gallery-muted', this.muted ? '1' : '0');

    if (this.masterGain && this.ctx) {
      const t = this.ctx.currentTime;
      this.masterGain.gain.cancelScheduledValues(t);
      this.masterGain.gain.linearRampToValueAtTime(this.muted ? 0 : 1, t + 0.1);
    }
    if (this.narrationEl) {
      this.narrationEl.muted = this.muted;
    }
  }

  /* ---------- 前后台生命周期联动（切后台自动挂起，回前台平滑恢复） ----------
   * 与玩家手动静音互不干扰：这里只动主增益，不改 this.muted，
   * 因此玩家静音时回前台依旧保持静音。 */
  suspendMaster() {
    if (!this.ctx || !this.masterGain) return;
    const t = this.ctx.currentTime;
    this.masterGain.gain.cancelScheduledValues(t);
    this.masterGain.gain.setTargetAtTime(0, t, 0.03);
    if (this.narrationEl) this.narrationEl.muted = true;
  }

  resumeMaster() {
    if (!this.ctx || !this.masterGain) return;
    const t = this.ctx.currentTime;
    this.masterGain.gain.cancelScheduledValues(t);
    this.masterGain.gain.setTargetAtTime(this.muted ? 0 : 1, t, 0.08);
    if (this.narrationEl) this.narrationEl.muted = this.muted;
  }

  /** 安装 visibilitychange / blur 管线（幂等，重复调用安全） */
  initLifecycle() {
    if (typeof document === 'undefined' || this._lifecycleBound) return;
    this._lifecycleBound = true;

    const suspend = () => this.suspendMaster();
    const resume = () => {
      if (document.hidden) return;
      // 浏览器可能在后台挂起 AudioContext，回前台需显式恢复
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      this.resumeMaster();
    };

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) suspend(); else resume();
    });
    window.addEventListener('blur', suspend);
    window.addEventListener('focus', resume);
  }

  /* ---------- 实时音频能量提取（给动效/律动柱调用） ---------- */  getAudioEnergy() {
    if (!this.analyser || !this.freqData || this.muted) {
      return { bass: 0, mid: 0, treble: 0, volume: 0 };
    }
    this.analyser.getByteFrequencyData(this.freqData);
    const len = this.freqData.length;
    // 低频段 [0..3]，中频段 [4..12]，高频段 [13..31]
    let bassSum = 0, midSum = 0, trebleSum = 0, total = 0;
    for (let i = 0; i < len; i++) {
      const v = this.freqData[i];
      total += v;
      if (i <= 3) bassSum += v;
      else if (i <= 12) midSum += v;
      else trebleSum += v;
    }
    return {
      bass: Math.min(1, bassSum / (4 * 255)),
      mid: Math.min(1, midSum / (9 * 255)),
      treble: Math.min(1, trebleSum / (19 * 255)),
      volume: Math.min(1, total / (len * 255)),
    };
  }

  /* ---------- 背景雨声：白噪 + 低通 + 慢 LFO 起伏 ---------- */
  startRain() {
    const ctx = this.ensure();
    if (!ctx || this.rainNode) return;

    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 300;

    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0.042;

    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.13;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.015;
    lfo.connect(lfoGain).connect(this.rainGain.gain);

    src.connect(hp).connect(lp).connect(this.rainGain).connect(this.masterGain);
    src.start();
    lfo.start();
    this.rainNode = src;
  }

  stopRain() {
    if (this.rainNode) {
      try { this.rainNode.stop(); } catch (e) { /* ignore */ }
      this.rainNode = null;
    }
  }

  /* ---------- 程序化悬疑配乐：D 小调 Film Noir Suspense Drone ---------- */
  startBgm() {
    const ctx = this.ensure();
    if (!ctx || this.bgmRunning) return;
    this.bgmRunning = true;

    const t = ctx.currentTime;
    this.bgmGain = ctx.createGain();
    this.bgmGain.gain.setValueAtTime(0.0001, t);
    this.bgmGain.gain.linearRampToValueAtTime(0.038, t + 3.0); // 3秒平滑淡入

    // 低通滤波器（220Hz 附近，带慢速 LFO 调制呼吸感）
    this.bgmFilter = ctx.createBiquadFilter();
    this.bgmFilter.type = 'lowpass';
    this.bgmFilter.frequency.setValueAtTime(220, t);
    this.bgmFilter.Q.value = 2.2;

    this.bgmLfo = ctx.createOscillator();
    this.bgmLfo.frequency.value = 0.065; // ~15 秒循环呼吸周期
    const bgmLfoGain = ctx.createGain();
    bgmLfoGain.gain.value = 80;
    this.bgmLfo.connect(bgmLfoGain).connect(this.bgmFilter.frequency);
    this.bgmLfo.start();

    // D 小调根音与五度双振荡器失谐（D2 73.4Hz + A2 110Hz + F2 87.3Hz）
    const chord = [
      { f: 73.42, detune: -4, type: 'triangle' },
      { f: 73.42, detune: +5, type: 'sine' },
      { f: 110.00, detune: -3, type: 'sine' },
      { f: 87.31, detune: +2, type: 'sine' }, // 降E / F 小三度悬疑色彩
    ];

    this.bgmOscs = chord.map((n) => {
      const osc = ctx.createOscillator();
      osc.type = n.type;
      osc.frequency.setValueAtTime(n.f, t);
      osc.detune.setValueAtTime(n.detune, t);
      osc.connect(this.bgmFilter);
      osc.start();
      return osc;
    });

    this.bgmFilter.connect(this.bgmGain).connect(this.masterGain);

    // 启动生成式悬疑琴音泛音循环
    this._scheduleChime();
  }

  _scheduleChime() {
    if (!this.bgmRunning) return;
    const nextInterval = 4200 + Math.random() * 4500; // 每 4~8.7 秒触发一次
    this.bgmTimer = setTimeout(() => {
      this._playGenerativeChime();
      this._scheduleChime();
    }, nextInterval);
  }

  _playGenerativeChime() {
    if (!this.ctx || !this.bgmRunning || this.muted) return;
    // D Dorian / 自然小调音阶：D3, F3, G3, A3, C4, D4, E4
    const scale = [146.83, 174.61, 196.00, 220.00, 261.63, 293.66, 329.63];
    const freq = scale[Math.floor(Math.random() * scale.length)];

    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    const filt = this.ctx.createBiquadFilter();

    osc.type = Math.random() > 0.4 ? 'sine' : 'triangle';
    osc.frequency.setValueAtTime(freq, t);

    filt.type = 'bandpass';
    filt.frequency.setValueAtTime(freq * 1.5, t);
    filt.Q.value = 1.8;

    const dur = 2.4 + Math.random() * 1.2;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.022, t + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    osc.connect(filt).connect(g).connect(this.masterGain);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  stopBgm() {
    this.bgmRunning = false;
    if (this.bgmTimer) {
      clearTimeout(this.bgmTimer);
      this.bgmTimer = null;
    }
    if (this.ctx && this.bgmGain) {
      const t = this.ctx.currentTime;
      this.bgmGain.gain.cancelScheduledValues(t);
      this.bgmGain.gain.linearRampToValueAtTime(0.0001, t + 0.8);
      setTimeout(() => {
        this.bgmOscs.forEach(o => { try { o.stop(); } catch (e) { /* ignore */ } });
        this.bgmOscs = [];
        if (this.bgmLfo) { try { this.bgmLfo.stop(); } catch (e) { /* ignore */ } this.bgmLfo = null; }
      }, 900);
    }
  }

  /* ---------- 基础振荡器发生器 ---------- */
  tone(freq, dur, { type = 'sine', vol = 0.12, when = 0, slide = 0 } = {}) {
    if (this.muted) return;
    const ctx = this.ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime + when;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.masterGain);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  /* ---------- 音效词典 ---------- */
  click()      { this.tone(660, 0.07, { type: 'triangle', vol: 0.08 }); }
  hover()      { this.tone(440, 0.04, { type: 'sine', vol: 0.03 }); }
  discover()   {
    this.tone(523, 0.12, { type: 'triangle', vol: 0.1 });
    this.tone(784, 0.22, { type: 'triangle', vol: 0.1, when: 0.1 });
  }
  type()       { this.tone(1800 + Math.random() * 500, 0.015, { type: 'square', vol: 0.012 }); }
  suspect()    { this.tone(196, 0.3, { type: 'sine', vol: 0.08, slide: -60 }); }
  crack()      { // 戳穿谎言 / 防线攻破
    this.tone(880, 0.05, { type: 'sawtooth', vol: 0.07 });
    this.tone(587, 0.09, { type: 'sawtooth', vol: 0.07, when: 0.05 });
    this.tone(392, 0.18, { type: 'sawtooth', vol: 0.07, when: 0.11 });
  }
  wrong()      { this.tone(220, 0.25, { type: 'square', vol: 0.06, slide: -80 }); }
  verdict() {
    [262, 330, 392, 523].forEach((f, i) => this.tone(f, 0.6, { type: 'triangle', vol: 0.08, when: i * 0.14 }));
  }
  // 结案四档音色：S 上扬号角 / A 沉稳定音 / B 中性收束 / C 下行提示。
  // 复用现有 tone 基元，零新素材；四档之前只有「A 以上 vs 其他」二值，
  // 拿 S 和 B 听起来一样（CodeRabbit 抓到）。
  rankS() {
    [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.5, { type: 'triangle', vol: 0.09, when: i * 0.12 }));
  }
  rankA() {
    [392, 523].forEach((f, i) => this.tone(f, 0.45, { type: 'sine', vol: 0.08, when: i * 0.16 }));
  }
  rankB() {
    this.tone(392, 0.3, { type: 'sine', vol: 0.07 });
    this.tone(440, 0.35, { type: 'sine', vol: 0.07, when: 0.14 });
  }
  rankC() {
    this.tone(330, 0.3, { type: 'sine', vol: 0.06 });
    this.tone(247, 0.4, { type: 'sine', vol: 0.06, when: 0.15 });
  }

  onThunder(callback) {
    if (typeof callback === 'function') {
      this.thunderCallbacks.push(callback);
    }
  }

  thunder() {
    if (this.muted) return;
    const ctx = this.ensure();
    if (!ctx) return;
    const len = ctx.sampleRate * 1.5;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      const decay = Math.exp(-3 * (i / len));
      d[i] = (Math.random() * 2 - 1) * decay;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 120;
    const g = ctx.createGain();
    g.gain.value = 0.38;
    src.connect(lp).connect(g).connect(this.masterGain);
    src.start();

    // 触发闪电视听联动回调
    this.thunderCallbacks.forEach((cb) => {
      try { cb({ energy: 0.95 }); } catch (e) { /* ignore */ }
    });
  }

  /* ---------- 开场 15 秒情景讲述音频播放器 ---------- */
  playNarration(src = 'assets/audio/intro-narration.mp3', { onTimeUpdate, onEnded, onError } = {}) {
    this.stopNarration(0);
    const el = new Audio(src);
    el.muted = this.muted;
    el.volume = 1.0;

    if (onTimeUpdate) {
      el.addEventListener('timeupdate', () => {
        onTimeUpdate(el.currentTime, el.duration || 12.64);
      });
    }
    if (onEnded) {
      el.addEventListener('ended', onEnded);
    }
    el.addEventListener('error', (e) => {
      if (onError) onError(e);
    });

    const resumeOnce = () => {
      this._clearNarrationResume();
      if (this.narrationEl === el && !el.ended) {
        el.play().catch(() => {});
      }
    };

    el.play().catch(() => {
      // 浏览器若因无交互拦截，等待用户第一次交互自动续播
      this.narrationResumeHandler = resumeOnce;
      window.addEventListener('pointerdown', resumeOnce, { once: true });
      window.addEventListener('keydown', resumeOnce, { once: true });
    });

    this.narrationEl = el;
    return el;
  }

  _clearNarrationResume() {
    if (this.narrationResumeHandler) {
      window.removeEventListener('pointerdown', this.narrationResumeHandler);
      window.removeEventListener('keydown', this.narrationResumeHandler);
      this.narrationResumeHandler = null;
    }
  }

  stopNarration(fadeMs = 300) {
    this._clearNarrationResume();
    if (!this.narrationEl) return;
    const el = this.narrationEl;
    this.narrationEl = null;

    if (fadeMs > 0 && el.volume > 0) {
      const step = 0.05;
      const interval = fadeMs / (el.volume / step);
      const timer = setInterval(() => {
        if (el.volume > step) {
          el.volume = Math.max(0, el.volume - step);
        } else {
          clearInterval(timer);
          try { el.pause(); el.src = ''; } catch (e) { /* ignore */ }
        }
      }, interval);
    } else {
      try { el.pause(); el.src = ''; } catch (e) { /* ignore */ }
    }
  }
}

export const audio = new AudioEngine();

/* 每 25~45 秒随机来一声沉闷夜雷 */
let thunderTimer = null;
export function scheduleThunder() {
  if (thunderTimer) clearTimeout(thunderTimer);
  const next = 25000 + Math.random() * 20000;
  thunderTimer = setTimeout(() => {
    audio.thunder();
    scheduleThunder();
  }, next);
}
