/* Ayaz PA — Price Action motoru
 * Mum: {t, o, h, l, c, v}  (t = açılış zamanı, ms)
 * Tüm hesaplar yalnızca verilen mumlara bakar: geleceği görmez (backtest için güvenli).
 */
(function (root) {
  'use strict';

  // ---------- Göstergeler ----------
  function ema(v, n) {
    // TradingView ile aynı: ilk n değerin basit ortalaması tohum, sonra üstel ortalama
    const k = 2 / (n + 1), out = new Array(v.length);
    let p = 0, s = 0;
    for (let i = 0; i < v.length; i++) {
      if (i < n) { s += v[i]; p = s / (i + 1); }
      else p = v[i] * k + p * (1 - k);
      out[i] = p;
    }
    return out;
  }
  function sma(v, n) {
    const out = new Array(v.length); let s = 0;
    for (let i = 0; i < v.length; i++) { s += v[i]; if (i >= n) s -= v[i - n]; out[i] = s / Math.min(i + 1, n); }
    return out;
  }
  function atr(c, n = 14) {
    const out = new Array(c.length); let a = 0;
    for (let i = 0; i < c.length; i++) {
      const tr = i ? Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c)) : c[i].h - c[i].l;
      a = i < n ? (a * i + tr) / (i + 1) : (a * (n - 1) + tr) / n;
      out[i] = a;
    }
    return out;
  }
  function rsi(cl, n = 14) {
    const out = new Array(cl.length).fill(50); let g = 0, l = 0;
    for (let i = 1; i < cl.length; i++) {
      const d = cl[i] - cl[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
      if (i <= n) { g += up / n; l += dn / n; } else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; }
      if (i >= n) out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
    return out;
  }

  // ---------- Swing noktaları ----------
  function pivots(c, L = 3, R = 3) {
    const highs = [], lows = [];
    for (let i = L; i < c.length - R; i++) {
      let isH = true, isL = true;
      for (let j = i - L; j <= i + R; j++) {
        if (j === i) continue;
        if (c[j].h >= c[i].h && (j > i || c[j].h > c[i].h)) isH = false;
        if (c[j].l <= c[i].l && (j > i || c[j].l < c[i].l)) isL = false;
        if (!isH && !isL) break;
      }
      if (isH) highs.push({ i, price: c[i].h });
      if (isL) lows.push({ i, price: c[i].l });
    }
    // HH/LH, HL/LL etiketleri
    for (let k = 0; k < highs.length; k++) highs[k].label = k ? (highs[k].price > highs[k - 1].price ? 'HH' : 'LH') : 'H';
    for (let k = 0; k < lows.length; k++) lows[k].label = k ? (lows[k].price > lows[k - 1].price ? 'HL' : 'LL') : 'L';
    return { highs, lows, R };
  }

  // ---------- Piyasa yapısı: BOS / CHoCH ----------
  function structure(c, piv) {
    const R = piv.R, events = [];
    const hiAt = new Map(), loAt = new Map();
    piv.highs.forEach(p => hiAt.set(p.i + R, p));
    piv.lows.forEach(p => loAt.set(p.i + R, p));
    let trend = 0, hiQ = null, loQ = null;
    for (let i = 0; i < c.length; i++) {
      if (hiAt.has(i)) hiQ = hiAt.get(i);
      if (loAt.has(i)) loQ = loAt.get(i);
      if (hiQ && c[i].c > hiQ.price) {
        events.push({ i, dir: 1, type: trend === -1 ? 'CHoCH' : 'BOS', level: hiQ.price, from: hiQ.i });
        trend = 1; hiQ = null;
      }
      if (loQ && c[i].c < loQ.price) {
        events.push({ i, dir: -1, type: trend === 1 ? 'CHoCH' : 'BOS', level: loQ.price, from: loQ.i });
        trend = -1; loQ = null;
      }
    }
    return { trend, events };
  }

  // Sonek (suffix) dizileri: O(n) dolum / kırılım kontrolü
  function suffix(c) {
    const n = c.length, minL = new Array(n + 1), maxH = new Array(n + 1), minC = new Array(n + 1), maxC = new Array(n + 1);
    minL[n] = Infinity; maxH[n] = -Infinity; minC[n] = Infinity; maxC[n] = -Infinity;
    for (let i = n - 1; i >= 0; i--) {
      minL[i] = Math.min(minL[i + 1], c[i].l); maxH[i] = Math.max(maxH[i + 1], c[i].h);
      minC[i] = Math.min(minC[i + 1], c[i].c); maxC[i] = Math.max(maxC[i + 1], c[i].c);
    }
    return { minL, maxH, minC, maxC };
  }

  // ---------- FVG (Fair Value Gap / dengesizlik) ----------
  function fvgs(c, A, sfx, V) {
    const out = [];
    for (let i = 2; i < c.length; i++) {
      const a = A[i] || 0;
      if (c[i].h === c[i].l || c[i - 1].h === c[i - 1].l || c[i - 2].h === c[i - 2].l) continue;   // tek fiyatlı mum: gerçek boşluk değil
      if (V && V[i] && c[i - 1].v < 0.2 * V[i]) continue;                                         // hacimsiz itiş: güvenilmez
      if (c[i].l > c[i - 2].h && c[i].l - c[i - 2].h > 0.15 * a) {
        const bot = c[i - 2].h, top = c[i].l;
        if (sfx.minL[i + 1] > bot) out.push({ dir: 1, top: Math.min(top, sfx.minL[i + 1]), bot, i });
      }
      if (c[i].h < c[i - 2].l && c[i - 2].l - c[i].h > 0.15 * a) {
        const top = c[i - 2].l, bot = c[i].h;
        if (sfx.maxH[i + 1] < top) out.push({ dir: -1, top, bot: Math.max(bot, sfx.maxH[i + 1]), i });
      }
    }
    return out.slice(-12);
  }

  // ---------- Order Block ----------
  function orderBlocks(c, events, sfx) {
    const out = [];
    for (const ev of events.slice(-8)) {
      const start = Math.max(0, ev.from - 3);
      for (let j = ev.i - 1; j >= start; j--) {
        if (ev.dir === 1 && c[j].c < c[j].o) {
          if (sfx.minC[j + 1] >= c[j].l) out.push({ dir: 1, top: c[j].h, bot: c[j].l, i: j, ev: ev.type });
          break;
        }
        if (ev.dir === -1 && c[j].c > c[j].o) {
          if (sfx.maxC[j + 1] <= c[j].h) out.push({ dir: -1, top: c[j].h, bot: c[j].l, i: j, ev: ev.type });
          break;
        }
      }
    }
    return out;
  }

  // ---------- Likidite: alınmamış tepeler/dipler, eşit seviyeler, süpürmeler ----------
  function liquidity(c, piv, A, sfx) {
    const n = c.length, a = A[n - 1] || 0;
    const bsl = piv.highs.filter(p => sfx.maxH[p.i + 1] < p.price).map(p => ({ price: p.price, i: p.i }));   // alıcı tarafı (üstte stoplar)
    const ssl = piv.lows.filter(p => sfx.minL[p.i + 1] > p.price).map(p => ({ price: p.price, i: p.i }));   // satıcı tarafı (altta stoplar)
    const pools = [];
    const eq = (arr, dir) => {
      const r = arr.slice(-15);
      for (let x = 0; x < r.length; x++) for (let y = x + 1; y < r.length; y++)
        if (Math.abs(r[x].price - r[y].price) < 0.12 * a) pools.push({ dir, price: (r[x].price + r[y].price) / 2, i: r[x].i, j: r[y].i });
    };
    eq(bsl, 1); eq(ssl, -1);
    // Süpürme: seviyenin ötesine fitil, geri içerde kapanış
    const sweeps = [];
    for (let i = Math.max(0, n - 30); i < n; i++) {
      for (const p of piv.highs) {
        if (p.i + piv.R >= i || i - p.i > 80) continue;
        if (c[i].h > p.price && c[i].c < p.price && sfx.maxH[p.i + 1] <= c[i].h && maxBetween(c, p.i + 1, i - 1) < p.price) { sweeps.push({ dir: -1, i, level: p.price }); break; }
      }
      for (const p of piv.lows) {
        if (p.i + piv.R >= i || i - p.i > 80) continue;
        if (c[i].l < p.price && c[i].c > p.price && minBetween(c, p.i + 1, i - 1) > p.price) { sweeps.push({ dir: 1, i, level: p.price }); break; }
      }
    }
    return { bsl, ssl, pools, sweeps };
  }
  // Küçük swing'ler (1 mum sol/sağ), henüz kırılmamış olanlar: yakın stop ve ara hedef için
  function minorPivots(c, from) {
    const n = c.length, highs = [], lows = [];
    if (n < 3) return { highs, lows };
    let maxA = c[n - 1].h, minA = c[n - 1].l;
    for (let i = n - 2; i >= Math.max(1, from); i--) {
      if (c[i].h > c[i - 1].h && c[i].h >= c[i + 1].h && c[i].h > maxA) highs.push({ i, price: c[i].h });
      if (c[i].l < c[i - 1].l && c[i].l <= c[i + 1].l && c[i].l < minA) lows.push({ i, price: c[i].l });
      maxA = Math.max(maxA, c[i].h); minA = Math.min(minA, c[i].l);
    }
    return { highs, lows };
  }
  function maxBetween(c, a, b) { let m = -Infinity; for (let i = a; i <= b; i++) m = Math.max(m, c[i].h); return m; }
  function minBetween(c, a, b) { let m = Infinity; for (let i = a; i <= b; i++) m = Math.min(m, c[i].l); return m; }

  // ---------- Mum formasyonları ----------
  function patterns(c, A) {
    const n = c.length, out = [];
    if (n < 3) return out;
    for (const k of [n - 1, n - 2]) {
      const x = c[k], p = c[k - 1], q = c[k - 2], a = A[k] || 1e-9;
      if (!p || !q) continue;
      const body = Math.abs(x.c - x.o), rng = x.h - x.l || 1e-9;
      const up = x.h - Math.max(x.o, x.c), lo = Math.min(x.o, x.c) - x.l;
      const pb = Math.abs(p.c - p.o), qb = Math.abs(q.c - q.o);
      const ago = n - 1 - k;
      const add = (name, dir) => out.push({ name, dir, i: k, ago });
      if (p.c < p.o && x.c > x.o && x.c >= p.o && x.o <= p.c && body > pb) add('Yutan Boğa (Bullish Engulfing)', 1);
      if (p.c > p.o && x.c < x.o && x.c <= p.o && x.o >= p.c && body > pb) add('Yutan Ayı (Bearish Engulfing)', -1);
      if (lo >= 2 * body && up <= 0.35 * rng && rng > 0.6 * a) add('Çekiç / Pin Bar (alt fitil)', 1);
      if (up >= 2 * body && lo <= 0.35 * rng && rng > 0.6 * a) add('Kayan Yıldız / Pin Bar (üst fitil)', -1);
      if (body <= 0.1 * rng && rng > 0.4 * a) add('Doji (kararsızlık)', 0);
      if (x.h < p.h && x.l > p.l) add('Inside Bar (sıkışma)', 0);
      if (q.c < q.o && qb > 0.6 * a && pb < 0.35 * qb && x.c > x.o && x.c > (q.o + q.c) / 2) add('Sabah Yıldızı', 1);
      if (q.c > q.o && qb > 0.6 * a && pb < 0.35 * qb && x.c < x.o && x.c < (q.o + q.c) / 2) add('Akşam Yıldızı', -1);
      if (body >= 0.85 * rng && rng > 1.2 * a) add(x.c > x.o ? 'Güçlü Boğa Mumu (Marubozu)' : 'Güçlü Ayı Mumu (Marubozu)', x.c > x.o ? 1 : -1);
    }
    return out;
  }

  // ---------- Tek zaman dilimi analizi ----------
  function analyzeTF(c) {
    const n = c.length;
    const cl = c.map(x => x.c), vol = c.map(x => x.v);
    const A = atr(c), R = rsi(cl), E20 = ema(cl, 20), E50 = ema(cl, 50), E200 = ema(cl, 200), V20 = sma(vol, 20);
    const sfx = suffix(c);
    const piv = pivots(c);
    const st = structure(c, piv);
    const fv = fvgs(c, A, sfx, V20);
    const ob = orderBlocks(c, st.events, sfx);
    const liq = liquidity(c, piv, A, sfx);
    const pat = patterns(c, A);
    const last = c[n - 1];
    // Göreli hacim: son kapanmış mum / önceki 20 mumun medyanı (tek büyük mum ortalamayı bozmasın)
    const prevV = vol.slice(Math.max(0, n - 21), n - 1).slice().sort((a, b) => a - b);
    const medV = prevV.length ? prevV[Math.floor(prevV.length / 2)] : 0;
    const relVol = medV ? last.v / medV : 1;
    const v4 = vol.slice(-4).reduce((s, x) => s + x, 0), relVol4 = medV ? v4 / (4 * medV) : 1;   // son 4 mum
    const tail = c.slice(-48), flat = tail.filter(x => x.h === x.l || x.v === 0).length / tail.length;
    const qvs = tail.map(x => x.v * x.c).sort((a, b) => a - b);
    const qv = qvs.length ? qvs[Math.floor(qvs.length / 2)] : 0;        // mum başına medyan işlem hacmi (USD); birkaç büyük mum yanıltmasın
    // Uyumsuzluk (RSI)
    let div = 0;
    const H = piv.highs, Lw = piv.lows;
    if (H.length >= 2) { const a = H[H.length - 2], b = H[H.length - 1]; if (b.price > a.price && R[b.i] < R[a.i] - 3 && n - 1 - b.i < 40) div = -1; }
    if (Lw.length >= 2) { const a = Lw[Lw.length - 2], b = Lw[Lw.length - 1]; if (b.price < a.price && R[b.i] > R[a.i] + 3 && n - 1 - b.i < 40) div = div || 1; }
    const lastEv = st.events[st.events.length - 1] || null;
    let lastFlip = null;
    for (let k = st.events.length - 1; k >= 0; k--) if (st.events[k].type === 'CHoCH' || k === 0) { lastFlip = st.events[k]; break; }
    let legs = 0;
    if (lastFlip) for (const e of st.events) if (e.i >= lastFlip.i && e.dir === lastFlip.dir) legs++;
    return {
      n, c, atr: A[n - 1], rsi: R[n - 1], rsiArr: R, ema20: E20[n - 1], ema50: E50[n - 1], ema200: E200[n - 1],
      emaArr: { e20: E20, e50: E50 }, relVol, piv, trend: st.trend, events: st.events, lastEv, lastFlip, legs,
      fvg: fv, ob, liq, patterns: pat, div, close: last.c, flat, qv, relVol4, lastQv: last.v * last.c, bars: n
    };
  }

  // ---------- Faz: yeni yükseliş mi, bitmiş mi? ----------
  const PHASES = {
    yeni:  { key: 'yeni',  label: 'Yeni yükseliş', tone: 'good' },
    geri:  { key: 'geri',  label: 'Geri çekilme (alım bölgesi)', tone: 'good' },
    devam: { key: 'devam', label: 'Yükseliş sürüyor', tone: 'neutral' },
    olgun: { key: 'olgun', label: 'Yükseliş olgun / bitime yakın', tone: 'warn' },
    donus: { key: 'donus', label: 'Erken dönüş sinyali', tone: 'neutral' },
    dusus: { key: 'dusus', label: 'Düşüş trendi', tone: 'bad' },
    yatay: { key: 'yatay', label: 'Yatay / net yapı yok', tone: 'neutral' }
  };
  function phase(h1, m15) {
    const ext = h1.atr ? (h1.close - h1.ema50) / h1.atr : 0;
    const flipAgo = h1.lastFlip ? h1.n - 1 - h1.lastFlip.i : 999;
    const topSweep = h1.liq.sweeps.some(s => s.dir === -1 && h1.n - 1 - s.i <= 6);
    const m15Up = m15.lastEv && m15.lastEv.dir === 1 && m15.n - 1 - m15.lastEv.i <= 12;
    const m15BullSweep = m15.liq.sweeps.some(s => s.dir === 1 && m15.n - 1 - s.i <= 10);
    let ph;
    if (h1.trend === 1) {
      if (ext >= 4 || h1.rsi >= 76 || h1.legs >= 4 || (h1.div === -1 && h1.rsi > 62) || topSweep) ph = 'olgun';
      else {
        // son yükseliş bacağının %50 altı = indirim bölgesi
        const leg = lastUpLeg(h1);
        const disc = leg && h1.close < leg.lo + (leg.hi - leg.lo) * 0.5;
        if (disc) ph = 'geri';
        else if (flipAgo <= 30 && h1.legs <= 2 && ext < 3) ph = 'yeni';
        else ph = 'devam';
      }
    } else if (h1.trend === -1) {
      ph = (m15Up && (m15BullSweep || h1.div === 1)) ? 'donus' : 'dusus';
    } else ph = 'yatay';
    return Object.assign({ ext, flipAgo }, PHASES[ph]);
  }
  function lastUpLeg(a) {
    const ev = [...a.events].reverse().find(e => e.dir === 1);
    if (!ev) return null;
    let lo = Infinity; for (let i = Math.max(0, ev.from - 20); i <= ev.i; i++) lo = Math.min(lo, a.c[i].l);
    let hi = -Infinity; for (let i = ev.from; i < a.n; i++) hi = Math.max(hi, a.c[i].h);
    return { lo, hi };
  }

  // ---------- İşlem planı ----------
  let FX = 1;   // TL gösterimi için kur çarpanı (USDT fiyatı × USD/TRY)
  function fmtP(x) { if (!isFinite(x)) return '-'; x *= FX; const d = x >= 1000 ? 2 : x >= 1 ? 4 : x >= 0.01 ? 5 : 8; return x.toFixed(d); }

  function plan(m15, h1, opts = {}) {
    const price = m15.close, ph = phase(h1, m15), reasons = [];
    const minRR = opts.minRR ?? 1.5, allowShort = !!opts.allowShort;
    let dir = 0;
    if (opts.dir !== undefined) dir = opts.dir;                       // 4 aşamalı motor yönü 4s/1s'den belirler
    else if (h1.trend === 1 && ph.key !== 'olgun') dir = 1;
    else if (ph.key === 'donus') dir = 1;
    else if (allowShort && h1.trend === -1 && m15.trend === -1) dir = -1;
    const h4 = opts.h4 || null, extraT = opts.extraT || [];

    // Yapı açıklamaları
    const trTxt = t => t === 1 ? 'yükseliş (HH-HL)' : t === -1 ? 'düşüş (LH-LL)' : 'net değil';
    reasons.push({ t: `1s yapı: ${trTxt(h1.trend)}${h1.lastEv ? `, son ${h1.lastEv.type} ${h1.lastEv.dir === 1 ? 'yukarı' : 'aşağı'} ${h1.n - 1 - h1.lastEv.i} mum önce` : ''}.`, s: h1.trend });
    reasons.push({ t: `15dk yapı: ${trTxt(m15.trend)}${m15.lastEv ? `, son ${m15.lastEv.type} ${m15.lastEv.dir === 1 ? 'yukarı' : 'aşağı'} ${m15.n - 1 - m15.lastEv.i} mum önce` : ''}.`, s: m15.trend });
    reasons.push({ t: `Faz: ${ph.label}. Fiyat 1s EMA50'den ${ph.ext.toFixed(1)} ATR uzakta, RSI ${h1.rsi.toFixed(0)}, ${h1.legs} yapı bacağı.`, s: ph.tone === 'good' ? 1 : ph.tone === 'bad' || ph.tone === 'warn' ? -1 : 0 });

    const res = { symbolPrice: price, dir, phase: ph, reasons, status: 'KAÇIN', score: 0, entry: null, stop: null, targets: [], rr: 0, zone: null, trigger: null };
    if (!dir) {
      reasons.push({ t: ph.key === 'olgun' ? 'Yükseliş olgun: yeni alım için geç, kâr al / bekle.' : 'Yön net değil ya da düşüşte: işlem yok.', s: -1 });
      res.score = scoreOf(res, m15, h1);
      return res;
    }

    // Giriş bölgesi: fiyatın yakınındaki geçerli FVG / OB
    const zones = [];
    const near = 2 * h1.atr;
    for (const z of m15.fvg) if (z.dir === dir) zones.push({ ...z, kind: '15dk FVG' });
    for (const z of m15.ob) if (z.dir === dir) zones.push({ ...z, kind: '15dk Order Block' });
    for (const z of h1.fvg) if (z.dir === dir) zones.push({ ...z, kind: '1s FVG' });
    for (const z of h1.ob) if (z.dir === dir) zones.push({ ...z, kind: '1s Order Block' });
    const cand = zones.filter(z => dir === 1 ? (z.bot <= price && price - z.top <= near) : (z.top >= price && z.bot - price <= near));
    cand.sort((a, b) => dir === 1 ? b.top - a.top : a.bot - b.bot);
    let zone = cand[0] || null, inZone = false, entry;
    if (opts.forceZone) zone = opts.forceZone;
    if (zone) {
      inZone = dir === 1 ? price <= zone.top : price >= zone.bot;
      entry = inZone ? price : (dir === 1 ? zone.top : zone.bot);
    } else {
      const ev = m15.lastEv;
      if (ev && ev.dir === dir && m15.n - 1 - ev.i <= 10 && Math.abs(price - ev.level) <= m15.atr * 1.2) {
        entry = ev.level; zone = { kind: `15dk ${ev.type} seviyesi (retest)`, top: ev.level, bot: ev.level };
        inZone = dir === 1 ? price <= ev.level + 0.25 * m15.atr : price >= ev.level - 0.25 * m15.atr;
      } else entry = price;
    }
    if (opts.forceEntry != null) { entry = opts.forceEntry; inZone = !!opts.forceInZone; }
    // Tetik: 15dk'da yönde formasyon, CHoCH/BOS ya da likidite süpürmesi
    const trig = [];
    const pat = m15.patterns.find(p => p.dir === dir);
    if (pat) trig.push(pat.name);
    const sw = m15.liq.sweeps.filter(s => s.dir === dir && m15.n - 1 - s.i <= 6).pop();
    if (sw) trig.push(dir === 1 ? 'satıcı likiditesi süpürüldü' : 'alıcı likiditesi süpürüldü');
    if (m15.lastEv && m15.lastEv.dir === dir && m15.n - 1 - m15.lastEv.i <= 6) trig.push(`15dk ${m15.lastEv.type}`);
    res.trigger = trig.length ? trig.join(' + ') : null;

    // Stop: en yakın yapısal dibin (long) / tepenin (short) ötesi
    const a15 = m15.atr, buf = 0.15 * a15, d = dir;
    const mn15 = minorPivots(m15.c, m15.n - 40), mn1h = minorPivots(h1.c, h1.n - 40);
    const edge = zone ? (d === 1 ? Math.min(entry, zone.bot) : Math.max(entry, zone.top)) : entry;
    const lim = edge - d * 0.3 * a15;                       // stop bu seviyenin ötesinde olmalı
    // Önce teyitli swing dip/tepeler (3 mum sol/sağ). 1 mumluk küçük swing'ler gürültüdür; sadece yakında teyitli yoksa kullanılır.
    const okSide = p => d === 1 ? p <= lim : p >= lim;
    const near1h = p => Math.abs(entry - p) <= 1.5 * h1.atr;
    const confirmed = (d === 1 ? m15.liq.ssl : m15.liq.bsl).map(x => x.price).filter(p => okSide(p) && near1h(p));
    const supp = confirmed.length ? confirmed : (d === 1 ? mn15.lows : mn15.highs).map(x => x.price).filter(okSide);
    const recent = m15.c.slice(-8);
    let base = supp.length ? (d === 1 ? Math.max(...supp) : Math.min(...supp))
      : (d === 1 ? Math.min(entry - a15, ...recent.map(x => x.l)) : Math.max(entry + a15, ...recent.map(x => x.h)));
    if (sw) {                                                // süpürme fitili korunur (çok uzak değilse)
      const wick = d === 1 ? minBetween(m15.c, sw.i, m15.n - 1) : maxBetween(m15.c, sw.i, m15.n - 1);
      if (Math.abs(entry - wick) <= 1.5 * h1.atr) base = d === 1 ? Math.min(base, wick) : Math.max(base, wick);
    }
    let stop = base - d * buf;
    if (d * (entry - stop) < 0.6 * a15) stop = entry - d * 0.6 * a15;
    if (opts.forceStop != null && d * (entry - opts.forceStop) > 0) stop = opts.forceStop;
    const risk = Math.abs(entry - stop);
    const wide = risk > 1.5 * h1.atr;                        // yapısal stop çok uzak: uydurma stop koymayız, uyarırız

    // Hedefler: karşı taraftaki gerçek likidite (alınmamış tepe/dipler, eşit seviyeler, aralığın uç noktası)
    const winHi = Math.max(...h1.c.map(x => x.h)), winLo = Math.min(...h1.c.map(x => x.l));
    const rawT = d === 1
      ? [...m15.liq.bsl, ...h1.liq.bsl, ...m15.liq.pools.filter(p => p.dir === 1), ...h1.liq.pools.filter(p => p.dir === 1), ...mn15.highs, ...mn1h.highs, { price: winHi },
         ...(h4 ? [...h4.liq.bsl, ...h4.liq.pools.filter(p => p.dir === 1), { price: Math.max(...h4.c.map(x => x.h)) }] : []), ...extraT.filter(p => p > entry).map(p => ({ price: p }))]
      : [...m15.liq.ssl, ...h1.liq.ssl, ...m15.liq.pools.filter(p => p.dir === -1), ...h1.liq.pools.filter(p => p.dir === -1), ...mn15.lows, ...mn1h.lows, { price: winLo },
         ...(h4 ? [...h4.liq.ssl, ...h4.liq.pools.filter(p => p.dir === -1), { price: Math.min(...h4.c.map(x => x.l)) }] : []), ...extraT.filter(p => p < entry).map(p => ({ price: p }))];
    // Karşı bölgeler: girişin önündeki ters yönlü FVG / order block (fiyatı durdurabilir, kâr alma yeri)
    const opp = [];
    const oppSrc = [[h1.fvg, '1s FVG'], [h1.ob, '1s order block'], [m15.fvg, '15dk FVG'], [m15.ob, '15dk order block']];
    if (h4) oppSrc.unshift([h4.fvg, '4s FVG'], [h4.ob, '4s order block']);
    for (const [arr, tf] of oppSrc) {
      for (const z of arr) {
        if (z.dir !== -d) continue;
        const edge = d === 1 ? z.bot : z.top, far = d === 1 ? z.top : z.bot;
        if (d * (far - entry) <= 0) continue;                       // girişin arkasında
        if (d * (h1.close - far) > 0) continue;                     // fiyat 1s kapanışla bölgeyi zaten geçmiş: engel değil
        opp.push({ kind: (d === 1 ? 'ayı ' : 'boğa ') + tf, bot: z.bot, top: z.top, edge: d * (edge - entry) > 0 ? edge : entry, near: Math.max(0, d * (edge - entry)) });
      }
    }
    opp.sort((a, b) => a.near - b.near);
    const lv = rawT.map(x => x.price).concat(opp.map(o => o.edge)).filter(p => d * (p - entry) > 0.25 * risk).sort((a, b) => d * (a - b));
    const uniq = [];
    for (const p of lv) if (!uniq.length || Math.abs(p - uniq[uniq.length - 1]) >= 0.35 * risk) uniq.push(p);   // hedefler arası en az 0.35R (birbirine yapışık hedef olmaz)
    let inter = uniq.filter(p => d * (p - entry) < risk);              // 1R'den yakın ara dirençler
    const reach = Math.max(4 * risk, 4 * h1.atr);                    // 15dk/1s işlem için makul menzil: uzak seviyeler H2/H3 olmaz
    const tg = uniq.filter(p => d * (p - entry) >= risk).filter((p, k) => k === 0 || d * (p - entry) <= reach).slice(0, 3);
    if (!tg.length && inter.length) { tg.push(...inter.slice(-3)); inter = inter.slice(0, -3); }   // gerçek seviye varsa onu kullan (R/R düşük çıkar, karar onu yansıtır)
    const extrap = tg.length === 0;
    if (extrap) tg.push(entry + d * risk * 2, entry + d * risk * 3);  // gerçek seviye yoksa: tahmini, açıkça etiketlenir
    const rr = Math.abs(tg[0] - entry) / (risk || 1e-9);
    const rr2 = tg[1] != null ? Math.abs(tg[1] - entry) / (risk || 1e-9) : rr;
    const rrPlan = (rr + rr2) / 2;                                    // %50 H1 + %50 H2 çıkışının ortalama getirisi
    const thin = !opts.noVolume && m15.qv < 1500;
    const hot = d === 1 ? m15.rsi >= 75 : m15.rsi <= 25;
    // Engel: 1s/4s bölgeleri (ya da büyük 15dk bölgesi). Küçük 15dk bölgeleri trendde ezilir; kısmi kâr yeri sayılır, işlemi durdurmaz.
    const realOpp = opp.filter(o => (o.top - o.bot) >= 0.25 * h1.atr && (!/15dk/.test(o.kind) || (o.top - o.bot) >= 0.5 * h1.atr));
    const blocked = realOpp.length > 0 && realOpp[0].near < 0.6 * risk; // 0.8R içinde anlamlı karşı bölge: yol kapalı (0.8-1R arası kısmi kâr yeri)
    const sparse = m15.flat > 0.15;
    // 15dk'da karşı yönlü sinyal (son 3 mum): ters formasyon ya da karşı süpürme
    const cPat = m15.patterns.filter(p => p.dir === -d && p.ago <= 1).map(p => p.name.split(' (')[0]);
    const cSw = m15.liq.sweeps.some(x => x.dir === -d && m15.n - 1 - x.i <= 2);
    const counter = cPat.length || cSw;

    Object.assign(res, { levels: uniq.slice(), entry, stop, targets: tg, rr, zone, inZone, wideStop: wide, extrapolated: extrap, intermediate: inter, opposing: opp, blocked, blocker: blocked ? realOpp[0] : null, sparse, counter: !!counter, rr2, rrPlan, thin });
    if (zone) reasons.push({ t: `Giriş bölgesi: ${zone.kind} ${fmtP(zone.bot)} – ${fmtP(zone.top)}${inZone ? ' (fiyat bölgede)' : ''}.`, s: 1 });
    reasons.push({ t: res.trigger ? `Tetik: ${res.trigger}.` : '15dk tetik henüz yok: onay mumu bekle.', s: res.trigger ? 1 : 0 });
    reasons.push({ t: `Stop ${fmtP(stop)}: en yakın ${d === 1 ? 'yükselen dibin altı' : 'alçalan tepenin üstü'} (risk %${(risk / entry * 100).toFixed(2)}).`, s: wide ? -1 : 0 });
    if (wide) reasons.push({ t: `Yapısal stop çok uzak (1s ATR'nin ${(risk / h1.atr).toFixed(1)} katı). Pozisyonu küçültün ya da daha yakın bir bölge bekleyin.`, s: -1 });
    if (hot && !inZone) reasons.push({ t: `15dk RSI ${m15.rsi.toFixed(0)}: aşırı ${d === 1 ? 'alım' : 'satım'}. Fiyatı kovalamayın, bölgeye geri çekilmeyi bekleyin.`, s: -1 });
    if (m15.relVol >= 1.5) reasons.push({ t: `Hacim ortalamanın ${m15.relVol.toFixed(1)} katı: ilgi var.`, s: 1 });
    if (h1.div === -dir) reasons.push({ t: `1s RSI uyumsuzluğu karşı yönde: dikkat.`, s: -1 });
    if (h1.div === dir) reasons.push({ t: `1s RSI uyumsuzluğu yönü destekliyor.`, s: 1 });
    if (opp.length) reasons.push({ t: `Karşı bölge: ${opp.slice(0, 2).map(o => `${o.kind} ${fmtP(o.bot)} – ${fmtP(o.top)}`).join(', ')}${blocked ? ' çok yakın; önce bu bölgenin kırılmasını bekleyin' : ''}.`, s: -1 });
    if (sparse) reasons.push({ t: `Veri seyrek: son 48 mumun %${(m15.flat * 100).toFixed(0)}'i tek fiyatlı ya da hacimsiz. FVG ve formasyonlar güvenilmez; Binance grafiğinden teyit edin.`, s: -1 });
    if (thin && !sparse) reasons.push({ t: `Hacim düşük: 15dk mum başına medyan ${Math.round(m15.qv).toLocaleString('tr-TR')} $. Fitil ve FVG'ler yanıltıcı olabilir; büyük borsada teyit edin, pozisyonu küçük tutun.`, s: -1 });
    if (counter) reasons.push({ t: `15dk karşı sinyal: ${[...cPat, cSw ? (d === 1 ? 'tepe süpürmesi' : 'dip süpürmesi') : ''].filter(Boolean).join(', ')}. ${inZone ? 'Girişi erteleyin, yeni onay bekleyin.' : 'Fiyat giriş bölgesine geri çekilebilir.'}`, s: inZone ? -1 : 0 });
    if (inter.length) reasons.push({ t: `Ara direnç: ${inter.slice(0, 3).map(fmtP).join(', ')}. Buralarda tepki gelebilir.`, s: 0 });
    reasons.push({ t: extrap ? `Yakında likidite seviyesi yok: hedefler risk katı ile hesaplandı (tahmini).` : `Hedef 1: ${fmtP(tg[0])} (${rr.toFixed(2)}R)${tg.length > 1 ? `, Hedef 2: ${fmtP(tg[1])} (${rr2.toFixed(2)}R). %50-%50 çıkışla ortalama risk/ödül ${rrPlan.toFixed(2)}` : '. Üstte başka gerçek seviye yok, tek hedef'}.`, s: extrap ? 0 : (rrPlan >= minRR ? 1 : -1) });

    if (rrPlan < minRR * 0.8 || rr < 0.8) res.status = 'KAÇIN';
    else if ((inZone || res.trigger) && rrPlan >= minRR && !wide && !(hot && !inZone) && !blocked && !sparse && !(counter && inZone)) res.status = 'HAZIR';
    else res.status = 'BEKLE';
    if (dir === -1) res.futures = true;
    res.score = scoreOf(res, m15, h1);
    return res;
  }

  function scoreOf(r, m15, h1) {
    let s = 0; const d = r.dir || 1;
    if (h1.trend === d) s += 20;
    if (m15.trend === d) s += 10;
    if (m15.lastEv && m15.lastEv.dir === d && m15.n - 1 - m15.lastEv.i <= 12) s += 12;
    if (m15.liq.sweeps.some(x => x.dir === d && m15.n - 1 - x.i <= 8)) s += 12;
    if (r.inZone) s += 10;
    if (m15.patterns.some(p => p.dir === d)) s += 8;
    if (m15.relVol >= 1.5) s += 8;
    const rp = r.rrPlan ?? r.rr;
    if (rp >= 2) s += 10; else if (rp >= 1.5) s += 5;
    if (r.thin) s -= 8;
    if (r.phase.key === 'yeni' || r.phase.key === 'geri') s += 10;
    if (r.phase.key === 'olgun') s -= 25;
    if (h1.div === -d) s -= 10;
    if (r.wideStop) s -= 10;
    if (r.blocked) s -= 10;
    if (r.sparse) s -= 20;
    if (r.extrapolated) s -= 5;
    if (r.dir && (d === 1 ? m15.rsi >= 75 : m15.rsi <= 25) && !r.inZone) s -= 8;
    if (!r.dir) s = Math.min(s, 30);
    return Math.max(0, Math.min(100, s));
  }

  // 15dk mumlardan 1s mum üret (sadece tamamlanmışlar)
  function aggregate(c, mult) {
    const out = [];
    for (let i = 0; i + mult <= c.length; i += mult) {
      const g = c.slice(i, i + mult);
      out.push({ t: g[0].t, o: g[0].o, h: Math.max(...g.map(x => x.h)), l: Math.min(...g.map(x => x.l)), c: g[g.length - 1].c, v: g.reduce((s, x) => s + x.v, 0) });
    }
    return out;
  }

  function analyze(c15, c1h, opts) {
    const m15 = analyzeTF(c15.slice(-300)), h1 = analyzeTF(c1h.slice(-200));
    return { m15, h1, plan: plan(m15, h1, opts) };
  }

  // =====================================================================
  //  4 AŞAMALI KARAR MOTORU
  //  1) 4s BAĞLAM  : ana yön, 5 günlük işlem aralığı (indirim/pahalı), dış likidite, hedef (draw on liquidity)
  //  2) 1s YAPI    : 4s yönüyle uyum, 1s CHoCH/BOS, ilgi bölgesi (POI: OB/FVG), geri çekilme
  //  3) 15dk TETİK : likidite süpürmesi → yapı kırılımı (MSS) → güçlü itiş (displacement + hacim) → giriş bölgesi
  //  4) KARAR      : kalite filtreleri (veri, hacim, BTC, seans, karşı bölge) + risk/ödül → not ve karar
  // =====================================================================
  const DAY = 864e5;
  function dayLevels(c1h) {
    if (!c1h.length) return null;
    const today = Math.floor(c1h[c1h.length - 1].t / DAY);
    const prev = c1h.filter(x => Math.floor(x.t / DAY) === today - 1);
    if (!prev.length) return null;
    return { pdh: Math.max(...prev.map(x => x.h)), pdl: Math.min(...prev.map(x => x.l)) };
  }
  function dealingRange(h4) {
    const w = h4.c.slice(-30);                    // son 30 x 4s = 5 gün
    const hi = Math.max(...w.map(x => x.h)), lo = Math.min(...w.map(x => x.l));
    const pos = hi > lo ? (h4.close - lo) / (hi - lo) : 0.5;
    return { hi, lo, eq: (hi + lo) / 2, pos };
  }
  const ago = (a, i) => a.n - 1 - i;
  const evTxt = e => e ? `${e.type} ${e.dir === 1 ? 'yukarı' : 'aşağı'}` : '';

  function stage1(h4, h1, c1h) {
    const rng = dealingRange(h4), dl = dayLevels(c1h), items = [];
    const sweptSSL = h4.liq.sweeps.some(s => s.dir === 1 && ago(h4, s.i) <= 6) || h1.liq.sweeps.some(s => s.dir === 1 && ago(h1, s.i) <= 12);
    const sweptBSL = h4.liq.sweeps.some(s => s.dir === -1 && ago(h4, s.i) <= 6) || h1.liq.sweeps.some(s => s.dir === -1 && ago(h1, s.i) <= 12);
    // Çift dip / çift tepe: 1s'in son iki dibi (tepesi) birbirine çok yakın ve fiyat üstünde (altında)
    const tol = 0.25 * h4.atr, L1 = h1.piv.lows.slice(-2), H1 = h1.piv.highs.slice(-2);
    const dblBottom = L1.length === 2 && Math.abs(L1[0].price - L1[1].price) <= tol && h1.close > Math.max(L1[0].price, L1[1].price);
    const dblTop = H1.length === 2 && Math.abs(H1[0].price - H1[1].price) <= tol && h1.close < Math.min(H1[0].price, H1[1].price);
    const h1Up = h1.trend === 1 && h1.lastFlip && h1.lastFlip.dir === 1 && ago(h1, h1.lastFlip.i) <= 12;
    let bias = 0, counter = false, label;
    if (h4.trend === 1) { bias = 1; label = 'Yükseliş trendi'; }
    else if (h4.trend === -1) {
      if (rng.pos < 0.4 && (sweptSSL || dblBottom) && (h1.trend === 1 || h1Up)) { bias = 1; counter = true; label = `Düşüş trendinde dipte dönüş denemesi (${dblBottom ? 'çift dip' : 'dip süpürmesi'} + 1s CHoCH, karşı trend)`; }
      else { bias = -1; label = 'Düşüş trendi'; }
    } else { bias = rng.pos < 0.5 ? 1 : -1; label = 'Yatay piyasa'; counter = true; }
    if (bias === -1 && rng.pos > 0.6 && sweptBSL && h1.trend === -1 && h4.trend === 1) { counter = true; }
    const zoneOk = bias === 1 ? rng.pos <= 0.5 : rng.pos >= 0.5;
    items.push({ t: `4s yapı: ${label}${h4.lastEv ? `, son ${evTxt(h4.lastEv)} ${ago(h4, h4.lastEv.i)} mum önce` : ''}.`, s: counter ? 0 : 1 });
    items.push({ t: `5 günlük aralık ${fmtP(rng.lo)} – ${fmtP(rng.hi)}. Fiyat aralığın %${Math.round(rng.pos * 100)} seviyesinde: ${rng.pos <= 0.5 ? 'indirim (ucuz) bölgesi' : 'pahalı bölge'}.`, s: zoneOk ? 1 : -1 });
    if (dl) items.push({ t: `Dünün tepesi ${fmtP(dl.pdh)}, dünün dibi ${fmtP(dl.pdl)}${h1.close > dl.pdh ? ' (tepe aşıldı)' : h1.close < dl.pdl ? ' (dip kırıldı)' : ''}.`, s: 0 });
    if (bias === 1 && sweptSSL) items.push({ t: 'Altta satıcı likiditesi süpürüldü: dönüş için yakıt toplandı.', s: 1 });
    if (bias === 1 && dblBottom) items.push({ t: `1s çift dip: ${fmtP(L1[0].price)} / ${fmtP(L1[1].price)}. Bu dibin altı da likidite havuzu: kırılırsa dönüş biter.`, s: 1 });
    if (bias === -1 && dblTop) items.push({ t: `1s çift tepe: ${fmtP(H1[0].price)} / ${fmtP(H1[1].price)}.`, s: 1 });
    if (bias === -1 && sweptBSL) items.push({ t: 'Üstte alıcı likiditesi süpürüldü.', s: 1 });
    const price = h1.close;
    const ext = bias === 1
      ? [...h4.liq.bsl.map(x => x.price), ...h4.liq.pools.filter(p => p.dir === 1).map(p => p.price), rng.hi, dl ? dl.pdh : null].filter(p => p != null && p > price + 0.5 * h1.atr).sort((a, b) => a - b)
      : [...h4.liq.ssl.map(x => x.price), ...h4.liq.pools.filter(p => p.dir === -1).map(p => p.price), rng.lo, dl ? dl.pdl : null].filter(p => p != null && p < price - 0.5 * h1.atr).sort((a, b) => b - a);
    const dol = ext[0] ?? null;
    if (dol != null) items.push({ t: `Hedef likidite (fiyatın çekildiği yer): ${fmtP(dol)} (%${((dol / price - 1) * 100).toFixed(2)}).`, s: 0 });
    let score = (counter ? 8 : 15) + (zoneOk ? 10 : 0) + (dol != null ? 5 : 0);
    if (bias === 1 && rng.pos > 0.85) score -= 5;
    const verdict = `${bias === 1 ? 'Yön: YUKARI' : 'Yön: AŞAĞI'}${counter ? ' (zayıf / karşı trend)' : ''}`;
    return { name: '4 saat · Bağlam', verdict, tone: counter ? 'neutral' : 'good', bias, counter, rng, dl, dol, extLevels: ext, items, score: Math.max(0, score), max: 30, sweptSSL, sweptBSL };
  }

  function stage2(h1, h4, bias) {
    const items = [];
    const aligned = h1.trend === bias;
    const flip = h1.lastFlip && h1.lastFlip.dir === bias && ago(h1, h1.lastFlip.i) <= 12;
    items.push({ t: `1s yapı: ${h1.trend === 1 ? 'yükseliş (HH-HL)' : h1.trend === -1 ? 'düşüş (LH-LL)' : 'net değil'}${h1.lastEv ? `, son ${evTxt(h1.lastEv)} ${ago(h1, h1.lastEv.i)} mum önce` : ''}. ${aligned ? '4s yönüyle uyumlu.' : '4s yönüyle uyumsuz.'}`, s: aligned ? 1 : -1 });
    if (flip) items.push({ t: `1s'te ${bias === 1 ? 'yukarı' : 'aşağı'} CHoCH taze: yön değişimi onaylandı.`, s: 1 });
    const price = h1.close;
    const pois = [];
    for (const [arr, tf] of [[h1.ob, '1s order block'], [h1.fvg, '1s FVG'], [h4.ob, '4s order block'], [h4.fvg, '4s FVG']]) for (const z of arr) {
      if (z.dir !== bias) continue;
      const dist = bias === 1 ? price - z.top : z.bot - price;
      const inside = price >= z.bot && price <= z.top;
      if (inside || (dist >= 0 && dist <= 1.5 * h1.atr)) pois.push({ ...z, kind: tf, inside, dist: inside ? 0 : dist });
    }
    pois.sort((a, b) => a.dist - b.dist);
    const poi = pois[0] || null;
    if (poi) items.push({ t: `İlgi bölgesi (POI): ${poi.kind} ${fmtP(poi.bot)} – ${fmtP(poi.top)}${poi.inside ? ' (fiyat içinde)' : ''}.`, s: 1 });
    else items.push({ t: 'Yakında 1s/4s ilgi bölgesi yok.', s: 0 });
    // Geri çekilme: son itiş bacağının ne kadarı geri alındı
    let retr = null;
    const ev = [...h1.events].reverse().find(e => e.dir === bias);
    if (ev) {
      let lo = Infinity, hi = -Infinity;
      for (let i = Math.max(0, ev.from - 20); i < h1.n; i++) { lo = Math.min(lo, h1.c[i].l); hi = Math.max(hi, h1.c[i].h); }
      if (hi > lo) retr = bias === 1 ? (hi - price) / (hi - lo) : (price - lo) / (hi - lo);
      var legLo = lo, legHi = hi;
      if (retr != null) items.push({ t: `Son itiş bacağının %${Math.round(retr * 100)} kadarı geri alındı${retr >= 0.38 && retr <= 0.79 ? ' (ideal geri çekilme bölgesi)' : retr < 0.2 ? ' (fiyat tepede, geri çekilme yok)' : ''}.`, s: retr >= 0.38 && retr <= 0.79 ? 1 : retr < 0.2 ? -1 : 0 });
    }
    const sw = h1.liq.sweeps.filter(s => s.dir === bias && ago(h1, s.i) <= 12).pop();
    if (sw) items.push({ t: `1s'te ${bias === 1 ? 'dip' : 'tepe'} likiditesi süpürüldü (${fmtP(sw.level)}).`, s: 1 });
    const score = (aligned || flip ? 12 : 0) + (poi ? 8 : 0) + (retr != null && retr >= 0.38 && retr <= 0.79 ? 5 : retr != null && retr < 0.2 ? -3 : 0) + (sw ? 3 : 0);
    const verdict = aligned || flip ? (poi ? 'Uyumlu, ilgi bölgesi var' : 'Uyumlu') : 'Uyumsuz';
    return { name: '1 saat · Yapı', verdict, tone: aligned || flip ? 'good' : 'bad', aligned: aligned || flip, poi, pois, retr, legLo, legHi, items, score: Math.max(0, Math.min(25, score)), max: 25 };
  }

  function stage3(m15, bias, plan) {
    const items = [], n = m15.n;
    const sw = m15.liq.sweeps.filter(s => s.dir === bias && ago(m15, s.i) <= 16).pop();
    const since = sw ? sw.i : n - 20;
    const mss = [...m15.events].reverse().find(e => e.dir === bias && e.i >= since && ago(m15, e.i) <= 16);
    let disp = false, volX = 0;
    if (mss) {
      const b = m15.c[mss.i], body = Math.abs(b.c - b.o);
      const prevV = m15.c.slice(Math.max(0, mss.i - 20), mss.i).map(x => x.v), avg = prevV.reduce((s, x) => s + x, 0) / (prevV.length || 1);
      volX = avg ? b.v / avg : 0;
      // itiş: kırılım mumu ya da kırılımdan önceki 3 mumun toplam gövdesi güçlü
      let leg = 0; for (let k = Math.max(0, mss.i - 3); k <= mss.i; k++) leg += Math.abs(m15.c[k].c - m15.c[k].o);
      disp = body >= 0.9 * m15.atr || leg >= 2.2 * m15.atr || volX >= 1.5;
    }
    items.push({ t: sw ? `Likidite süpürmesi: ${bias === 1 ? 'dip' : 'tepe'} ${fmtP(sw.level)} ${ago(m15, sw.i)} mum önce alındı.` : 'Son 4 saatte 15dk likidite süpürmesi yok.', s: sw ? 1 : 0 });
    items.push({ t: mss ? `Yapı kırılımı (MSS): 15dk ${mss.type} ${bias === 1 ? 'yukarı' : 'aşağı'}, ${ago(m15, mss.i)} mum önce.` : '15dk yönde yapı kırılımı yok: tetik oluşmadı.', s: mss ? 1 : -1 });
    if (mss) items.push({ t: disp ? `Güçlü itiş (displacement) var${volX >= 1.2 ? `, kırılım mumu hacmi ortalamanın ${volX.toFixed(1)} katı` : ''}.` : 'Kırılım zayıf: itiş yok, hacim artmadı.', s: disp ? 1 : -1 });
    // Geri çekilmede hacim azalıyorsa sağlıklı
    const last3 = m15.c.slice(-3).reduce((s, x) => s + x.v, 0) / 3, prev20 = m15.c.slice(-23, -3).reduce((s, x) => s + x.v, 0) / 20;
    if (mss && ago(m15, mss.i) >= 3 && prev20) items.push({ t: last3 < prev20 ? 'Geri çekilmede hacim azalıyor: satıcı baskısı zayıf (sağlıklı).' : 'Geri çekilmede hacim yüksek: karşı taraf güçlü, dikkat.', s: last3 < prev20 ? 1 : -1 });
    const pat = m15.patterns.find(p => p.dir === bias);
    if (pat) items.push({ t: `Onay mumu: ${pat.name}.`, s: 1 });
    if (plan.zone) items.push({ t: `Giriş bölgesi: ${plan.zone.kind} ${fmtP(plan.zone.bot)} – ${fmtP(plan.zone.top)}${plan.inZone ? ' (fiyat bölgede)' : ' (limit emir)'}.`, s: 1 });
    const score = (sw ? 8 : 0) + (mss ? 10 : 0) + (disp ? 5 : 0) + (plan.zone ? 4 : 0) + (pat ? 3 : 0);
    const ready = !!mss && (plan.inZone || !!pat || ago(m15, mss.i) <= 4);
    const verdict = mss ? (disp ? (ready ? 'Tetik oluştu' : 'Tetik var, bölgeye dönüş bekleniyor') : 'Zayıf tetik') : 'Tetik yok';
    return { name: '15 dakika · Tetik', verdict, tone: mss && disp ? 'good' : mss ? 'neutral' : 'bad', sw, mss, disp, ready, items, score: Math.min(30, score), max: 30 };
  }

  function sessionInfo(t) {
    const d = new Date(t), h = d.getUTCHours() + d.getUTCMinutes() / 60, wd = d.getUTCDay();
    const weekend = wd === 0 || wd === 6;
    const london = h >= 7 && h < 10, ny = h >= 12.5 && h < 15.5;
    return { weekend, killzone: london ? 'Londra' : ny ? 'New York' : null, monday: wd === 1 };
  }

  // =====================================================================
  //  GİRİŞ MODELLERİ (her biri ayrı taranır, en güçlüsü seçilir)
  //  M1 Trend geri çekilme (Al Brooks H1/H2): 4s+1s aynı yönde, fiyat geri çekilmede, 15dk H2 / onay mumu
  //  M2 Kırılım + geri test: 1s seviye kapanışla kırıldı, fiyat seviyeye döndü ve tuttu
  //  M3 Likidite süpürmesi dönüşü (SFP): dip/tepe süpürüldü, 15dk yapı kırıldı, FVG/OB'den giriş
  //  M4 Aralık: yatay piyasada aralığın dibinde/tepesinde 15dk ret sinyali
  //  Puan (10 üzerinden): 4s/1s uyum 2, doğru bölge (ucuz/pahalı) 1, giriş bölgesi (OB/FVG/seviye) 1, likidite süpürmesi 1,
  //  hacim teyidi 1, seans 1, risk/ödül 1, yapı kırılımı 1, yakın FVG 1. Ceza: BTC ters, düşük hacim, seyrek veri, kovalama.
  // =====================================================================
  const MODELS = { trend: 'Trend geri çekilme (H2)', retest: 'Kırılım + geri test', sweep: 'Likidite süpürmesi dönüşü', range: 'Aralık dibi / tepesi' };

  function h2Count(m15, d) {
    const c = m15.c, n = c.length, w = Math.max(1, n - 14);
    let ext = w; for (let i = w; i < n; i++) if (d === 1 ? c[i].h >= c[ext].h : c[i].l <= c[ext].l) ext = i;   // geri çekilmenin başladığı uç
    let count = 0, last = -1, pulled = false, pbEx = d === 1 ? Infinity : -Infinity;
    for (let i = ext + 1; i < n; i++) {
      pbEx = d === 1 ? Math.min(pbEx, c[i].l) : Math.max(pbEx, c[i].h);
      const brk = d === 1 ? c[i].h > c[i - 1].h : c[i].l < c[i - 1].l;
      const pb = d === 1 ? c[i].h < c[i - 1].h : c[i].l > c[i - 1].l;
      if (pb) pulled = true;
      if (brk && (pulled || count === 0) && i > ext + 1) { count++; last = i; pulled = false; }
    }
    return { count, ago: last < 0 ? 99 : n - 1 - last, pbEx: isFinite(pbEx) ? pbEx : null, bars: n - 1 - ext };
  }
  function legRetr(h1, d) {
    const ev = [...h1.events].reverse().find(e => e.dir === d);
    if (!ev) return null;
    let lo = Infinity, hi = -Infinity;
    for (let i = Math.max(0, ev.from - 20); i < h1.n; i++) { lo = Math.min(lo, h1.c[i].l); hi = Math.max(hi, h1.c[i].h); }
    if (!(hi > lo)) return null;
    return { lo, hi, r: d === 1 ? (hi - h1.close) / (hi - lo) : (h1.close - lo) / (hi - lo) };
  }
  function findPois(h1, h4, d, price) {
    const out = [];
    for (const [arr, tf] of [[h1.ob, '1s order block'], [h1.fvg, '1s FVG'], [h4.ob, '4s order block'], [h4.fvg, '4s FVG']]) for (const z of arr) {
      if (z.dir !== d) continue;
      const inside = price >= z.bot && price <= z.top, dist = d === 1 ? price - z.top : z.bot - price;
      if (inside || (dist >= 0 && dist <= 1.5 * h1.atr)) out.push({ ...z, kind: tf, inside, dist: inside ? 0 : dist });
    }
    return out.sort((a, b) => a.dist - b.dist);
  }
  const volAt = (a, i) => { const v = a.c.slice(Math.max(0, i - 20), i).map(x => x.v); const m = v.reduce((s, x) => s + x, 0) / (v.length || 1); return m ? a.c[i].v / m : 0; };

  function buildCandidates(m15, h1, h4, s1, opts, d) {
    const price = m15.close, a15 = m15.atr, A1 = h1.atr, buf = 0.15 * a15, out = [];
    const extraT = [...(s1.dl ? [s1.dl.pdh, s1.dl.pdl] : []), s1.rng.hi, s1.rng.lo, s1.rng.eq];
    const mk = (model, type, o, why) => {
      if (o.forceStop != null) {                                        // stop en az 0.35 x 1s ATR (fitil payı)
        const e = o.forceEntry != null ? o.forceEntry : (o.forceZone ? (d === 1 ? o.forceZone.top : o.forceZone.bot) : price);
        if (d * (e - o.forceStop) < 0.35 * A1) o = { ...o, forceStop: e - d * 0.35 * A1 };
      }
      let p = plan(m15, h1, { ...opts, dir: d, h4, extraT, ...o });
      if (p.entry == null) return;
      if (Math.abs(p.entry - p.stop) > 1.5 * A1 && o.forceStop != null) {
        // Modelin stopu (ör. süpürme fitili) çok uzak: en yakın yapısal dibe/tepeye taşı
        const q = plan(m15, h1, { ...opts, dir: d, h4, extraT, ...o, forceStop: undefined });
        if (q.entry != null && Math.abs(q.entry - q.stop) <= 1.5 * A1) { p = q; why = [...why, `Model stopu çok uzaktı; stop en yakın yapısal ${d === 1 ? 'dibin altına' : 'tepenin üstüne'} alındı.`]; }
      }
      if (Math.abs(p.entry - p.stop) > 1.5 * A1) return;                 // stop 1.5 x 1s ATR'den uzak: kurulum geçersiz (hedefler de uçuk olur)
      if (type === 'LİMİT' && Math.abs(price - p.entry) > (opts.maxLimitAtr ?? 1.0) * A1) return;   // limit fiyattan çok uzak: dolma ihtimali düşük, fiyat hedefe kaçar
      out.push({ model, type, p, why, d });
    };
    const lastBar = m15.c[m15.n - 1], prevBar = m15.c[m15.n - 2];
    const barOk = d === 1 ? lastBar.c > lastBar.o && lastBar.l >= prevBar.l : lastBar.c < lastBar.o && lastBar.h <= prevBar.h;
    const pat = m15.patterns.find(p => p.dir === d && p.ago <= 1);
    // M1 Trend geri çekilme
    if (h1.trend === d && (h4.trend === d || s1.bias === d)) {
      const lr = legRetr(h1, d), h2 = h2Count(m15, d);
      const z15 = [...m15.fvg.map(z => ({ ...z, kind: '15dk FVG' })), ...m15.ob.map(z => ({ ...z, kind: '15dk order block' }))]
        .filter(z => z.dir === d && (d === 1 ? z.top <= price : z.bot >= price) && Math.abs(price - (d === 1 ? z.top : z.bot)) <= 1.5 * A1)
        .map(z => ({ ...z, dist: Math.abs(price - (d === 1 ? z.top : z.bot)) }));
      const pois = [...findPois(h1, h4, d, price), ...z15].sort((a, b) => a.dist - b.dist);
      if (lr && lr.r < 0.15) {
        // Fiyat itişin tepesinde: kovalamak yok, %38-62 geri çekilme içindeki bölgeye limit
        // Güçlü trendde (4s+1s aynı yön) sığ geri çekilme %23.6–50 yeterli; değilse %38–62
        const strong = h4.trend === d && h1.trend === d, fA = strong ? 0.236 : 0.382, fB = strong ? 0.5 : 0.618;
        const L = lr.hi - lr.lo, ft = d === 1 ? lr.hi - fA * L : lr.lo + fA * L, fb = d === 1 ? lr.hi - fB * L : lr.lo + fB * L;
        const deep = pois.find(z => d === 1 ? z.top <= ft + 0.2 * A1 && z.top >= fb : z.bot >= ft - 0.2 * A1 && z.bot <= fb);
        const zz = deep || { top: d === 1 ? ft : fb, bot: d === 1 ? fb : ft, kind: `Fibonacci %${Math.round(fA * 1000) / 10}–${Math.round(fB * 100)} geri çekilme` };
        mk('trend', 'LİMİT', { forceZone: zz }, [`Fiyat itişin tepesinde (geri çekilme %${Math.round(lr.r * 100)}); kovalamak yerine geri çekilme bekleniyor.`, `Limit: ${zz.kind} ${fmtP(zz.bot)} – ${fmtP(zz.top)}.`]);
      } else if (lr && lr.r <= 0.85) {
        const trig = (h2.count >= 2 && h2.ago <= 2) || (h2.count >= 1 && h2.ago <= 2 && lr.r < 0.5) || !!pat;
        if (trig && h2.pbEx != null) mk('trend', 'AL', { forceEntry: price, forceInZone: true, forceStop: h2.pbEx - d * buf, forceZone: { top: price, bot: price, kind: `15dk H${Math.max(1, h2.count)} giriş` } },
          [`4s ve 1s aynı yönde; fiyat son itişin %${Math.round(lr.r * 100)} kadarını geri aldı.`, `15dk'da ${pat ? pat.name.split(' (')[0] : `H${h2.count} (geri çekilme sonrası ${h2.count}. yön mumu)`} sinyali.`]);
        else if (pois[0]) mk('trend', 'LİMİT', { forceZone: pois[0] }, [`4s ve 1s aynı yönde; geri çekilme sürüyor (%${Math.round(lr.r * 100)}).`, `Limit: ${pois[0].kind} ${fmtP(pois[0].bot)} – ${fmtP(pois[0].top)}.`]);
      }
    }
    // M2 Kırılım + geri test
    const ev = [...h1.events].reverse().find(e => e.dir === d && h1.n - 1 - e.i <= 12);
    if (ev) {
      const lvl = ev.level, dist = d * (price - lvl);
      const recent = m15.c.slice(-4);
      const held = d === 1 ? Math.min(...recent.map(x => x.l)) >= lvl - 0.35 * A1 : Math.max(...recent.map(x => x.h)) <= lvl + 0.35 * A1;
      const decisive = d * (h1.c[ev.i].c - lvl) >= 0.1 * A1;
      if (decisive && dist >= -0.25 * A1 && dist <= 2 * A1 && held) {
        const st = lvl - d * Math.max(0.6 * A1, 0.6 * a15);
        const zone = { top: d === 1 ? lvl + 0.15 * A1 : lvl + 0.1 * A1, bot: d === 1 ? lvl - 0.1 * A1 : lvl - 0.15 * A1, kind: `kırılan 1s seviyesi ${fmtP(lvl)} (geri test)` };
        const near = Math.abs(dist) <= 0.35 * A1;
        if (near && (barOk || pat)) mk('retest', 'AL', { forceEntry: price, forceInZone: true, forceStop: st, forceZone: zone }, [`1s ${ev.type} ile ${fmtP(lvl)} kapanışla kırıldı (${h1.n - 1 - ev.i} mum önce).`, `Fiyat seviyeye geri döndü ve tuttu; 15dk ${pat ? pat.name.split(' (')[0] : 'yükselen dip + yön mumu'}.`]);
        else mk('retest', 'LİMİT', { forceZone: zone, forceStop: st }, [`1s ${ev.type} ile ${fmtP(lvl)} kapanışla kırıldı (${h1.n - 1 - ev.i} mum önce).`, `Seviyenin geri testine limit emir.`]);
      }
    }
    // M3 Likidite süpürmesi dönüşü
    const sw15 = m15.liq.sweeps.filter(s => s.dir === d && m15.n - 1 - s.i <= 24).pop();
    const sw1 = h1.liq.sweeps.filter(s => s.dir === d && h1.n - 1 - s.i <= 12).pop();
    let swI = null, wick = null, swLvl = null;
    if (sw15) { swI = sw15.i; swLvl = sw15.level; wick = d === 1 ? minBetween(m15.c, sw15.i, m15.n - 1) : maxBetween(m15.c, sw15.i, m15.n - 1); }
    else if (sw1) { const t = h1.c[sw1.i].t; swI = m15.c.findIndex(x => x.t >= t); if (swI < 0) swI = null; else { swLvl = sw1.level; wick = d === 1 ? minBetween(m15.c, swI, m15.n - 1) : maxBetween(m15.c, swI, m15.n - 1); } }
    const locOk = d === 1 ? s1.rng.pos <= 0.6 : s1.rng.pos >= 0.4;
    if (swI != null && locOk) {
      const mss = [...m15.events].reverse().find(e => e.dir === d && e.i > swI && m15.n - 1 - e.i <= 28);
      if (mss) {
        const zs = [...m15.fvg.map(z => ({ ...z, kind: '15dk FVG' })), ...m15.ob.map(z => ({ ...z, kind: '15dk order block' }))]
          .filter(z => z.dir === d && z.i >= swI).sort((a, b) => d === 1 ? b.top - a.top : a.bot - b.bot);
        const z = zs.find(z => d === 1 ? z.bot <= price : z.top >= price);
        const st = wick - d * buf;
        const inZ = z && price >= z.bot && price <= z.top;
        const fresh = m15.n - 1 - mss.i <= 3;
        const why = [`${fmtP(swLvl)} ${d === 1 ? 'dibindeki' : 'tepesindeki'} stoplar süpürüldü, fiyat geri döndü.`, `Ardından 15dk ${mss.type} ${d === 1 ? 'yukarı' : 'aşağı'} (${m15.n - 1 - mss.i} mum önce).`];
        if (inZ || (fresh && (barOk || pat))) mk('sweep', 'AL', { forceEntry: price, forceInZone: true, forceStop: st, forceZone: z || { top: price, bot: price, kind: 'kırılım sonrası giriş' } }, why);
        else if (z) mk('sweep', 'LİMİT', { forceZone: z, forceStop: st }, [...why, `Limit: ${z.kind} ${fmtP(z.bot)} – ${fmtP(z.top)}.`]);
      }
    }
    // M4 Aralık
    if (h4.trend === 0 || (Math.abs(h4.close - s1.rng.eq) / (s1.rng.hi - s1.rng.lo) < 0.5 && h1.trend === 0)) {
      const edge = d === 1 ? s1.rng.pos <= 0.25 : s1.rng.pos >= 0.75;
      const rej = pat || (sw15 && m15.n - 1 - sw15.i <= 6);
      if (edge && rej) mk('range', 'AL', { forceEntry: price, forceInZone: true, forceStop: (d === 1 ? Math.min(s1.rng.lo, ...m15.c.slice(-6).map(x => x.l)) : Math.max(s1.rng.hi, ...m15.c.slice(-6).map(x => x.h))) - d * buf, forceZone: { top: price, bot: price, kind: 'aralık kenarı' } },
        [`Yatay piyasa: fiyat 5 günlük aralığın ${d === 1 ? 'dibinde' : 'tepesinde'} (%${Math.round(s1.rng.pos * 100)}).`, `15dk ret sinyali (${pat ? pat.name.split(' (')[0] : 'süpürme'}).`]);
    }
    return out;
  }

  function scoreCandidate(c, m15, h1, h4, s1, opts, ses) {
    const d = c.d, p = c.p, items = [];
    let sc = 0;
    const add = (pts, t, s = 1) => { sc += pts; items.push({ t: `${pts > 0 ? '+' : ''}${pts} · ${t}`, s: pts > 0 ? 1 : pts < 0 ? -1 : s }); };
    const al = (h4.trend === d) + (h1.trend === d);
    if (al === 2) add(2, '4s ve 1s aynı yönde'); else if (al === 1) add(1, `${h4.trend === d ? '4s' : '1s'} aynı yönde`); else add(0, '4s ve 1s ters yönde', -1);
    if (d === 1 ? s1.rng.pos <= 0.5 : s1.rng.pos >= 0.5) add(1, `Doğru bölge: 5 günlük aralığın ${d === 1 ? 'ucuz' : 'pahalı'} tarafı`);
    if (p.zone && !/giriş$/.test(p.zone.kind)) add(1, `Giriş bölgesi: ${p.zone.kind}`);
    const swOk = m15.liq.sweeps.some(s => s.dir === d && m15.n - 1 - s.i <= 16) || h1.liq.sweeps.some(s => s.dir === d && h1.n - 1 - s.i <= 8);
    if (swOk) add(1, 'Likidite süpürmesi var');
    const evs = m15.events.filter(e => e.dir === d && m15.n - 1 - e.i <= 16);
    if (evs.length || h1.events.some(e => e.dir === d && h1.n - 1 - e.i <= 12)) add(1, 'Yönde yapı kırılımı (BOS/CHoCH)');
    if (opts.noVolume) {   // hacim verisi yok: yerine itiş (displacement) gövdesine bak
      const ids = evs.length ? evs.map(e => e.i) : [m15.n - 1, m15.n - 2, m15.n - 3];
      const bx = Math.max(...ids.map(i => { const b = m15.c[i]; return (b.c - b.o) * d / (m15.atr || 1); }));
      if (bx >= 0.6) add(1, `Güçlü itiş: kırılım mumu gövdesi ${bx.toFixed(1)}×ATR`);
    } else {
      const vx = evs.length ? Math.max(...evs.map(e => volAt(m15, e.i))) : volAt(m15, m15.n - 1);
      if (vx >= 1.2) add(1, `Hacim teyidi: kırılım mumu ortalamanın ${vx.toFixed(1)} katı`);
    }
    if (m15.fvg.some(z => z.dir === d && Math.abs((z.top + z.bot) / 2 - p.entry) <= 1.0 * h1.atr)) add(1, 'Girişe yakın doldurulmamış FVG');
    if (ses.killzone && !ses.weekend) add(1, `${ses.killzone} seansı`);
    const rrP = p.rrPlan ?? p.rr;
    if (rrP >= 2) add(1, `Risk/ödül ${rrP.toFixed(1)}R`); else if (rrP >= 1.5) add(0.5, `Risk/ödül ${rrP.toFixed(1)}R`);
    if (opts.btc && opts.symbol !== 'BTCUSDT' && opts.btc.bias !== d && opts.btc.h1 !== d) add(-1, `BTC ters yönde (${opts.btc.label})`);
    if (p.sparse) add(-2, 'Veri seyrek'); else if (p.thin) add(-1, 'Hacim düşük');
    const hot = d === 1 ? m15.rsi >= 75 : m15.rsi <= 25;
    if (hot && c.type === 'AL' && c.model !== 'sweep') add(-1, `15dk RSI ${m15.rsi.toFixed(0)}: kovalama riski`);
    if (ses.weekend) add(-0.5, 'Hafta sonu');
    const oppSw = m15.liq.sweeps.filter(x => x.dir === -d && m15.n - 1 - x.i <= 16).pop();
    if (oppSw && c.model !== 'sweep') add(-1, `${d === 1 ? 'Tepe' : 'Dip'} likiditesi ${fmtP(oppSw.level)} yakın zamanda süpürüldü: ${d === 1 ? 'yukarı' : 'aşağı'} yakıt azaldı`);
    if (d === 1 && p.phase && p.phase.key === 'olgun' && c.model !== 'sweep') add(-1.5, 'Yükseliş olgun: hareketin sonuna yakın, geç giriş riski');
    return { score: Math.max(0, Math.min(10, sc)), items, rrP };
  }

  function breakoutScenario(p, bias, m15, h1, s1, minRR = 1.5) {
    if (!(p.blocked && p.blocker)) return null;
    const b = p.blocker, a15 = m15.atr;
    const be = bias === 1 ? b.top : b.bot, mid = (b.top + b.bot) / 2;
    const bs = bias === 1 ? Math.min(mid, be - 0.6 * a15, be - 0.5 * h1.atr) - 0.15 * a15 : Math.max(mid, be + 0.6 * a15, be + 0.5 * h1.atr) + 0.15 * a15;
    const br = Math.abs(be - bs);
    const pool = [...(p.levels || []), ...(p.targets || []), ...(p.intermediate || []), ...(s1.extLevels || [])]
      .filter(x => bias === 1 ? x > be + 0.25 * br : x < be - 0.25 * br).sort((x, y) => bias * (x - y));
    const bt = []; for (const x of pool) if (!bt.length || Math.abs(x - bt[bt.length - 1]) >= 0.35 * br) bt.push(x);
    const reach = Math.max(4 * br, 4 * h1.atr);   // 15dk/1s işlem için makul menzil
    const bInter = bt.filter(x => Math.abs(x - be) < br), tg3 = bt.filter(x => Math.abs(x - be) >= br).filter((x, k) => k === 0 || Math.abs(x - be) <= reach).slice(0, 3);
    if (!tg3.length) return null;
    const r1 = Math.abs(tg3[0] - be) / br, r2 = tg3[1] != null ? Math.abs(tg3[1] - be) / br : r1;
    if ((r1 + r2) / 2 < minRR) return null;                              // kırılım sonrası yer yok: senaryo önerilmez
    return { cond: `1s mum ${fmtP(be)} ${bias === 1 ? 'üstünde' : 'altında'} kapanırsa`, entry: be, stop: bs, targets: tg3, rr: r1, rrPlan: (r1 + r2) / 2, inter: bInter };
  }

  function decide(m15, h1, h4, c1h, opts = {}) {
    const minRR = opts.minRR ?? 1.5, allowShort = !!opts.allowShort;
    const s1 = stage1(h4, h1, c1h);
    const bias = s1.bias;
    const ses = sessionInfo(m15.c[m15.n - 1].t);
    // Tüm modeller, izin verilen yönlerde
    const dirs = allowShort ? [1, -1] : [1];
    let cands = [];
    for (const d of dirs) cands.push(...buildCandidates(m15, h1, h4, s1, opts, d));
    cands = cands.map(c => { const r = { ...c, ...scoreCandidate(c, m15, h1, h4, s1, opts, ses) }; if (h4.trend === -c.d) r.score = Math.min(r.score, 7.5); return r; })   // 4s trendine karşı: en fazla A
      .filter(c => c.rrP >= minRR * 0.8 && c.p.rr >= 0.8 && !c.p.sparse);
    cands.sort((a, b) => (b.score - a.score) || (b.rrP - a.rrP));
    let best = cands[0] || null;
    let decision, status, p, d0 = bias;
    if (best) {
      p = best.p;
      const sc = best.score;
      if (p.blocked) { decision = 'İZLE'; status = 'BEKLE'; }
      else if (best.type === 'AL' && sc >= 5.5 && best.rrP >= minRR) { decision = 'AL'; status = 'HAZIR'; }
      else if (best.type === 'AL' && sc >= 4.5 && best.rrP >= minRR) { decision = 'LİMİT BEKLE'; status = 'BEKLE'; }   // tetik var ama puan sınırda: bölgeye limit
      else if (best.type === 'LİMİT' && sc >= 5.5 && best.rrP >= minRR) { decision = 'LİMİT EMİR'; status = 'HAZIR'; }  // güçlü kurulum: limit emir şimdi girilebilir
      else if (best.type === 'LİMİT' && sc >= 4.5 && best.rrP >= minRR) { decision = 'LİMİT BEKLE'; status = 'BEKLE'; }
      else { decision = 'İZLE'; status = 'BEKLE'; }
      if (decision === 'LİMİT BEKLE' && best.type === 'AL') {
        // AL adayı limit'e indirildi: giriş, bölgenin kenarı olsun
        const z = p.zone && p.zone.top !== p.zone.bot ? p.zone : null;
        if (z) { const q = plan(m15, h1, { ...opts, dir: best.d, h4, forceZone: z, forceStop: p.stop }); if (q.entry != null && (q.rrPlan ?? q.rr) >= minRR && Math.abs(m15.close - q.entry) <= (opts.maxLimitAtr ?? 1.0) * h1.atr) p = q; }
      }
    } else {
      // Hiçbir model kurulmadı: yönü gösteren bilgi amaçlı plan
      d0 = bias === -1 && !allowShort ? 1 : (bias || 1);
      p = plan(m15, h1, { ...opts, dir: d0, h4, extraT: [s1.rng.hi, s1.rng.lo, s1.rng.eq] });
      decision = bias === -1 && !allowShort ? 'UZAK DUR' : 'İZLE';
      status = decision === 'UZAK DUR' ? 'KAÇIN' : 'BEKLE';
    }
    const d = best ? best.d : d0;            // anlatım ve kırılım senaryosu planın yönüyle aynı olmalı
    const s2 = stage2(h1, h4, d), s3 = stage3(m15, d, p);
    // Uzamış hareket bilgisi (anlatım için)
    let extended = null;
    const lr = legRetr(h1, d);
    if (lr && lr.r < 0.2 && (d === 1 ? (m15.rsi >= 75 || h1.rsi >= 70) : (m15.rsi <= 25 || h1.rsi <= 30))) {
      const L = lr.hi - lr.lo;
      extended = { fz: d === 1 ? { top: lr.hi - 0.382 * L, bot: lr.hi - 0.618 * L } : { top: lr.lo + 0.618 * L, bot: lr.lo + 0.382 * L }, move: L / lr.lo * 100 };
    }
    if (p.blocked && decision !== 'UZAK DUR') p.breakout = breakoutScenario(p, d, m15, h1, s1, minRR);
    const total = best ? Math.round(best.score * 10) : 0;
    const grade = total >= 80 ? 'A+' : total >= 70 ? 'A' : total >= 60 ? 'B' : total >= 50 ? 'C' : 'D';
    const items = [];
    if (best) {
      items.push({ t: `Seçilen model: ${MODELS[best.model]} (${best.type === 'AL' ? 'tetik oluştu' : 'limit kurulumu'}).`, s: 1 });
      best.why.forEach(t => items.push({ t, s: 0 }));
      items.push(...best.items);
      const others = cands.slice(1, 4).map(c => `${MODELS[c.model]}${c.d === -1 ? ' (short)' : ''}: ${Math.round(c.score * 10)}/100`);
      if (others.length) items.push({ t: `Diğer modeller: ${others.join(', ')}.`, s: 0 });
    } else items.push({ t: `Hiçbir giriş modeli kurulmadı (trend geri çekilme, kırılım+geri test, süpürme dönüşü, aralık). ${bias === -1 && !allowShort ? '4s yön aşağı ve short kapalı.' : 'Yapı oluşmasını bekleyin.'}`, s: -1 });
    if (p.blocked && p.blocker) items.push({ t: `Girişin önünde karşı bölge: ${p.blocker.kind} ${fmtP(p.blocker.bot)} – ${fmtP(p.blocker.top)}. Önce bu bölgenin kırılması gerekiyor.`, s: -1 });
    if (s1.counter && best && best.d === bias) items.push({ t: 'Karşı trend işlem: pozisyonu yarıya indirin.', s: -1 });
    const rrP = p.rrPlan ?? p.rr ?? 0;
    p.model = best ? best.model : null; p.modelName = best ? MODELS[best.model] : null;
    p.summary = narrate({ p, s1, s2, s3, decision, grade, total, bias: d, tradeDir: best ? best.d : (bias === -1 && !allowShort ? 0 : bias), extended, opts, rrP, best });
    const s4 = { name: 'Karar', verdict: `${decision}${best ? ` · Not ${grade} (${total}/100)` : ''}`, tone: status === 'HAZIR' ? 'good' : status === 'BEKLE' ? 'warn' : 'bad', items, score: total, max: 100 };
    Object.assign(p, { ctx: { h4: h4.trend, h1: h1.trend, counter: !!s1.counter, pos: s1.rng.pos, rsi1: h1.rsi, ema1: h1.close > h1.ema50 ? 1 : -1, ema4: h4.close > h4.ema50 ? 1 : -1 }, stages: [s1, s2, s3, s4], decision, grade: best ? grade : '–', setupScore: total, status, score: total, bias, mtf: true, futures: best ? best.d === -1 : false, dir: best ? best.d : 0, candidates: cands.length });
    return p;
  }

  // Kararı düz Türkçe özetler: kısa cevap, ne yapmalı (senaryolar), plan nerede bozulur
  function narrate(x) {
    const { p, s1, s2, s3, decision, bias, tradeDir, extended, opts, rrP } = x;
    const up = bias === 1, dirW = up ? 'alım' : 'satış (short)';
    let headline;
    const pts = [], scen = [];
    const mdl = x.best ? MODELS[x.best.model] : null;
    if (decision === 'AL') headline = `${up ? 'ALIM' : 'SATIŞ (short)'} şartları oluştu · ${mdl}. Giriş ${fmtP(p.entry)}, stop ${fmtP(p.stop)}.`;
    else if (decision === 'LİMİT EMİR') headline = `${mdl}: ${fmtP(p.entry)} seviyesine limit ${dirW} emri şimdi girilebilir. Fiyat gelmezse işlem yok; kovalamayın.`;
    else if (decision === 'LİMİT BEKLE') headline = `${mdl}: fiyat ${fmtP(p.entry)} seviyesine gelirse limit ${dirW}. Kovalamayın.`;
    else if (decision === 'UZAK DUR') headline = !tradeDir ? `Ana yön aşağı: spot alım için uygun değil.` : `Risk/ödül yetersiz: bu kurulum işlem için değmez.`;
    else if (p.blocked && p.blocker) headline = `Şu an ${dirW} yok. Fiyatın hemen ${up ? 'üstünde' : 'altında'} ${p.blocker.kind} var; önce o bölge kırılmalı.`;
    else if (extended) headline = `Şu an ${dirW} yok. Fiyat itişin tepesinde; geri çekilme bekleyin.`;
    else {
      const miss = [];
      if (!s2.aligned) miss.push('1s yapı 4s yönüyle uyumsuz');
      if (!s3.mss) miss.push('15dk tetik (yapı kırılımı) yok');
      else if (!s3.disp) miss.push('15dk kırılım zayıf');
      if (rrP < (opts.minRR ?? 1.5)) miss.push('risk/ödül düşük');
      headline = `Kurulum tamamlanmadı${miss.length ? ': ' + miss.join(', ') : ''}. İzlemeye devam.`;
    }
    if (x.best && x.best.why) x.best.why.forEach(t => pts.push(t));
    // Neden (en önemli 3-4 madde)
    pts.push(`${up ? 'Yön yukarı' : 'Yön aşağı'}${s1.counter ? ' ama karşı trend (ana trend tersi)' : ''}. Fiyat 5 günlük aralığın %${Math.round(s1.rng.pos * 100)} seviyesinde (${s1.rng.pos <= 0.5 ? 'ucuz' : 'pahalı'} bölge).`);
    if (s2.aligned) pts.push(`1s yapı yönü onaylıyor${s2.retr != null ? `; son itişin %${Math.round(s2.retr * 100)} kadarı geri alındı` : ''}.`);
    if (s3.mss) pts.push(`15dk'da ${s3.disp ? 'güçlü' : 'zayıf'} yapı kırılımı var.`);
    if (opts.btc && opts.symbol !== 'BTCUSDT') pts.push(opts.btc.bias === bias ? 'BTC aynı yönde.' : opts.btc.h1 === bias ? 'BTC sadece kısmen destekliyor (4s ters).' : 'BTC ters yönde.');
    // Senaryolar
    const pct = (a, b) => `${((b / a - 1) * 100).toFixed(1)}%`;
    if (p.breakout) {
      const b = p.breakout;
      scen.push({ t: 'Senaryo A · Kırılım (tercih edilen)', steps: [`${b.cond}`, `Fiyat ${fmtP(b.entry)} seviyesine geri test yaptığında gir.`, `Stop ${fmtP(b.stop)} (${pct(b.entry, b.stop)}).`, `Hedefler: ${b.targets.map(fmtP).join(' → ')}. Ortalama risk/ödül ${b.rrPlan.toFixed(1)}R.${b.inter && b.inter.length ? ` Ara direnç ${b.inter.map(fmtP).join(', ')}: kısmi kâr yeri.` : ''}`] });
      const poi = s2.poi;
      scen.push({ t: 'Senaryo B · Kırılım olmazsa', steps: [`Fiyat ${fmtP(p.blocker.bot)} – ${fmtP(p.blocker.top)} bölgesinden dönerse alma.`, poi ? `${poi.kind} ${fmtP(poi.bot)} – ${fmtP(poi.top)} bölgesine geri çekilme ve 15dk onay mumu bekle.` : `Daha aşağıdaki destek bölgesine geri çekilme ve 15dk onay mumu bekle.`] });
    } else if (p.entry != null && tradeDir && decision !== 'UZAK DUR') {
      scen.push({ t: decision === 'AL' ? 'Plan' : 'Senaryo A · Geri çekilme', steps: [p.inZone ? `Fiyat giriş bölgesinde (${p.zone ? p.zone.kind : ''}).` : `${fmtP(p.entry)} bölgesine ${/LİMİT/.test(decision) ? 'limit emir' : 'geri çekilme bekle'}${decision === 'İZLE' ? ', 15dk onay mumu (yutan mum / pin bar) gelince gir' : ''}.`, `Stop ${fmtP(p.stop)} (${pct(p.entry, p.stop)}).`, `Hedefler: ${p.targets.map(fmtP).join(' → ')}${p.extrapolated ? ' (tahmini)' : ''}. Ortalama risk/ödül ${rrP.toFixed(1)}R.`] });
    }
    // Plan nerede bozulur
    const inv = [];
    // Bozulma seviyesi giriş ile stop arasında olmalı; değilse stop seviyesi kullanılır
    const pz = s2.poi ? (up ? s2.poi.bot : s2.poi.top) : null;
    const between = pz != null && p.entry != null && p.stop != null && (up ? pz < p.entry && pz > p.stop : pz > p.entry && pz < p.stop);
    if (between) inv.push(`1s kapanış ${fmtP(pz)} ${up ? 'altına inerse' : 'üstüne çıkarsa'} ${up ? 'yükseliş' : 'düşüş'} zayıflar; ${fmtP(p.stop)} stop.`);
    else if (p.stop != null) inv.push(`${fmtP(p.stop)} (stop) ${up ? 'altına inerse' : 'üstüne çıkarsa'} kurulum iptal.`);
    const rl = up ? s1.rng.lo : s1.rng.hi;
    if (p.entry == null || p.stop == null || Math.abs(rl - p.entry) <= 4 * Math.abs(p.entry - p.stop)) inv.push(`${fmtP(rl)} ${up ? 'kırılırsa' : 'aşılırsa'} ${s1.counter ? 'dönüş biter' : 'yapı bozulur'}.`);   // çok uzak seviye bu işlem için anlamsız
    const notes = [];
    if (p.wideStop && p.entry != null && Math.abs(p.stop / p.entry - 1) > 0.02) notes.push(`Stop yapısal olarak çok uzak (%${Math.abs((p.stop / p.entry - 1) * 100).toFixed(1)}): ya pozisyonu çok küçültün ya da bu kurulumu atlayın.`);
    if (s1.counter && tradeDir) notes.push('Karşı trend: pozisyonu yarıya indirin.');
    if (p.sparse || p.thin) notes.push('Hacim düşük: büyük borsada teyit edin.');
    return { headline, points: pts, scenarios: scen, invalidation: inv, notes };
  }

  function analyzeMTF(c15, c1h, c4h, opts) {
    if (!c4h || c4h.length < 20) {                 // 4s verisi yoksa 1s mumlardan üret (4 saatlik sınıra hizalı)
      let st = 0; while (st < c1h.length && c1h[st].t % 14400000 !== 0) st++;
      c4h = aggregate(c1h.slice(st), 4);
    }
    const m15 = analyzeTF(c15.slice(-300)), h1 = analyzeTF(c1h.slice(-200)), h4 = analyzeTF(c4h.slice(-200));
    return { m15, h1, h4, plan: decide(m15, h1, h4, c1h.slice(-200), opts || {}) };
  }

  // ================= TREND KIRILIMI (gerçek Binance verisinde test edilen ana model) =================
  // Kural: 1s kapanış, önceki 480 adet 1s mumun (20 gün) en yükseğinin üstünde + BTC günlük kapanış 50 günlük ortalamanın üstünde
  // → bir sonraki mumda AL. Stop: giriş − 4 x ATR(1s). Çıkış: iz süren stop = girişten beri en yüksek − 12 x ATR(1s). Sabit hedef yok.
  // 18 coin, 2024-01 → 2026-04 (geliştirme) ve 2026-05 → 2026-09 (test), %0.1 komisyon + %0.03 kayma ile pozitif.
  const TREND = { N: 480, atrStop: 4, trail: 12, btcN: 50, nearAtr: 1.0, maxChaseAtr: 1.5 };
  // BTC günlük rejimi: gün kapanınca bilinir. d1: [{t,o,h,l,c}] artan sıralı (t = gün başlangıcı UTC)
  function btcRegimeMap(d1, n = TREND.btcN) {
    const m = new Map();
    for (let i = 0; i < d1.length; i++) {
      if (i < n - 1) continue;
      let s = 0; for (let q = i - n + 1; q <= i; q++) s += d1[q].c;
      m.set(Math.floor(d1[i].t / 864e5) * 864e5 + 864e5, d1[i].c > s / n ? 1 : -1);
    }
    return m;
  }
  function regimeAt(m, tClose) {                     // tClose: 1s mumun kapanış zamanı
    if (!m) return 1;
    const day = Math.floor(tClose / 864e5) * 864e5;
    if (m.has(day)) return m.get(day);
    let best = null; for (const [k, v] of m) if (k <= day && (best == null || k > best[0])) best = [k, v];
    return best ? best[1] : 0;
  }
  // c1h: kapanmış 1s mumlar (artan). opts: { btcD1, d1 (seviye yaklaşımı için), fee, slip, N, atrStop, trail }
  // Giriş koruması (engines.js GUARD ile aynı eşikler; 303 TRY + 18 coin testlerinde kötü çıkan girişler)
  function trendGuard(c, i, riskPct) {
    if (riskPct >= 6) return `stop çok uzak (%${riskPct.toFixed(1)})`;
    if (i >= 24 && c[i].c / c[i - 24].c - 1 >= 0.10) return `son 24 saatte %${((c[i].c / c[i - 24].c - 1) * 100).toFixed(0)} yükseldi: geç kalındı, geri çekilme bekle`;
    if (i >= 168 && c[i].c / c[i - 168].c - 1 >= 0.40) return `son 7 günde %${((c[i].c / c[i - 168].c - 1) * 100).toFixed(0)} yükseldi: geç kalındı`;
    return null;
  }
  function trend(c1h, opts = {}) {
    const o = Object.assign({}, TREND, opts), n = c1h.length, A = atr(c1h), fee = (o.fee ?? 0) / 100, slip = (o.slip ?? 0) / 100;
    const reg = o.btcD1 && o.btcD1.length >= 30 ? btcRegimeMap(o.btcD1, Math.min(o.btcN, o.btcD1.length)) : null;   // 50 günden az veri varsa (ör. Crypto.com) eldeki kadar
    const trades = []; let pos = null;
    // Kayan en yüksek (önceki N mum) — O(n) monoton kuyruk
    const hh = new Array(n).fill(null); { const dq = []; for (let i = 0; i < n; i++) { while (dq.length && dq[0] < i - o.N) dq.shift(); if (i >= o.N) hh[i] = c1h[dq[0]].h; while (dq.length && c1h[dq[dq.length - 1]].h <= c1h[i].h) dq.pop(); dq.push(i); } }
    for (let i = 1; i < n; i++) {
      const b = c1h[i];
      if (pos) {
        if (b.l <= pos.stop) {
          const px = Math.min(pos.stop, b.o) * (1 - slip), R = ((px - pos.e) - (pos.e + px) * fee) / pos.r;
          trades.push({ ...pos, exitT: b.t, exitPx: px, R, open: false, reason: pos.stop > pos.e ? 'İz süren stop (kârda)' : pos.stop > pos.stop0 ? 'İz süren stop' : 'Stop' }); pos = null;
        } else {
          pos.best = Math.max(pos.best, b.h);
          const ts = pos.best - o.trail * A[i]; if (ts > pos.stop) pos.stop = ts;
        }
      }
      if (!pos && i < n - 1 && hh[i] != null && b.c > hh[i] && regimeAt(reg, b.t + 36e5) === 1) {
        const e = c1h[i + 1].o * (1 + slip), stop = b.c - o.atrStop * A[i];
        if (e > stop && !(o.guard !== false && trendGuard(c1h, i, (b.c - stop) / b.c * 100))) pos = { t: c1h[i + 1].t, sigT: b.t, level: hh[i], e, stop, stop0: stop, r: e - stop, best: e, atr: A[i] };
      }
    }
    const last = c1h[n - 1], a = A[n - 1];
    if (pos) { const R = ((last.c - pos.e) - (pos.e + last.c) * fee) / pos.r; trades.push({ ...pos, exitT: null, exitPx: last.c, R, open: true }); }
    // Güncel karar. hh[n-1]: son mum HARİÇ önceki N mumun en yükseği (kırılım seviyesi)
    let brk = hh[n - 1], prevC = n > 1 ? c1h[n - 2].c : null, approx = false;
    if (brk == null && o.d1 && o.d1.length >= 20) {
      // Yeterli 1s geçmişi yok (ör. Crypto.com 50 mum): son 20 tamamlanmış günün + bugünün (son mum hariç) en yükseği
      const dayStart = Math.floor(last.t / 864e5) * 864e5, prev = o.d1.filter(x => x.t < dayStart).slice(-20), today = c1h.filter(x => x.t >= dayStart && x.t < last.t);
      if (prev.length >= 20) { brk = Math.max(...prev.map(x => x.h), ...today.map(x => x.h)); approx = true; }
    }
    const level = brk != null ? Math.max(brk, last.h) : null;      // bir sonraki mum için kırılım seviyesi
    const regNow = regimeAt(reg, last.t + 36e5);
    let openT = trades.find(t => t.open) || null;
    if (!openT && approx && o.d1.length >= 25) {
      // 1s geçmişi yokken açık pozisyon tahmini: kural günlük mumlarla taklit edilir (1s ATR ≈ günlük ATR x 0.17)
      const d1 = o.d1, Ad = atr(d1), dayStart = Math.floor(last.t / 864e5) * 864e5; let p = null;
      for (let j = 20; j < d1.length && d1[j].t < dayStart; j++) {
        const a1 = Ad[j - 1] * 0.17;
        if (p) { if (d1[j].l <= p.stop) { p = null; } else { p.best = Math.max(p.best, d1[j].h); p.stop = Math.max(p.stop, p.best - o.trail * a1); } continue; }
        let hi = -Infinity; for (let q = j - 20; q < j; q++) hi = Math.max(hi, d1[q].h);
        if (d1[j].h > hi && regimeAt(reg, d1[j].t) === 1) { const e = Math.max(hi, d1[j].o); p = { e, stop: e - o.atrStop * a1, best: Math.max(e, d1[j].c), sigT: d1[j].t, approx: true }; p.stop0 = p.stop; p.stop = Math.max(p.stop, p.best - o.trail * a1); }
      }
      if (p) for (const b of c1h.filter(x => x.t >= dayStart)) { if (b.l <= p.stop) { p = null; break; } p.best = Math.max(p.best, b.h); p.stop = Math.max(p.stop, p.best - o.trail * a); }
      if (p) { p.r = p.e - p.stop0; p.R = (last.c - p.e) / p.r; p.open = true; p.exitPx = last.c; openT = p; }
    }
    let decision, why;
    const above = brk != null && last.c > brk, fresh = above && (!approx || prevC == null || prevC <= brk);
    if (openT) { decision = 'POZİSYONDA'; why = openT.approx ? `Sinyal yaklaşık ${new Date(openT.sigT).toISOString().slice(5, 10)} tarihinde (günlük veriden tahmin); iz süren stop ≈ ${fmtP(openT.stop)}.` : `Alım sinyali ${new Date(openT.sigT + 36e5).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} (TR saati) geldi. Stop şu an ${fmtP(openT.stop)}.`; }
    else if (reg && regNow !== 1) { decision = 'UZAK DUR'; why = 'BTC günlük kapanışı 50 günlük ortalamanın altında: piyasa rejimi zayıf, yeni alım yok.'; }
    else if (fresh && o.guard !== false && trendGuard(c1h, n - 1, o.atrStop * a / last.c * 100)) { decision = 'BEKLE'; why = `Kırılım var ama alım yok: ${trendGuard(c1h, n - 1, o.atrStop * a / last.c * 100)}.`; }
    else if (fresh) { decision = 'AL'; why = `1s kapanış 20 günlük zirveyi (${fmtP(brk)}) kırdı.`; }
    else if (above) { decision = 'KIRILIM YAKIN'; why = approx ? 'Fiyat 20 günlük zirvenin üstünde; önceki sinyal Binance geçmişiyle kontrol edilmeli.' : `Kırılım ${fmtP(brk)} üstünde ama fiyat ${((last.c - brk) / a).toFixed(1)} ATR uzaklaştı: kovalamayın, yeni zirve kapanışı bekleyin.`; }
    else if (level != null && level - last.c <= o.nearAtr * a) { decision = 'KIRILIM YAKIN'; why = `Fiyat 20 günlük zirveye %${((level / last.c - 1) * 100).toFixed(2)} uzakta. 1s kapanış ${fmtP(level)} üstünde olursa AL.`; }
    else { decision = 'BEKLE'; why = level != null ? `20 günlük zirve ${fmtP(level)} (fiyattan %${((level / last.c - 1) * 100).toFixed(1)} yukarıda).` : 'Yeterli geçmiş yok.'; }
    const entry = decision === 'AL' ? last.c : level;
    const stop = entry != null ? entry - o.atrStop * a : null;
    const closed = trades.filter(t => !t.open), sumR = closed.reduce((s, t) => s + t.R, 0);
    return { decision, why, level, entry, stop, trailAtr: o.trail, atr: a, riskPct: entry ? (entry - stop) / entry * 100 : null, btc: reg ? regNow : null,
      open: openT, trades, stats: { n: closed.length, win: closed.filter(t => t.R > 0).length, sumR, avgR: closed.length ? sumR / closed.length : 0 }, params: o, hasHistory: hh[n - 1] != null, approx };
  }

  root.PA = { setFx: v => { FX = v > 0 ? v : 1; }, getFx: () => FX, trend, TREND, btcRegimeMap, _dbg: { buildCandidates, scoreCandidate, stage1, legRetr, h2Count, sessionInfo }, ema, sma, atr, rsi, pivots, structure, analyzeTF, phase, plan, analyze, analyzeMTF, decide, dayLevels, aggregate, fmtP, PHASES };
})(typeof window !== 'undefined' ? window : globalThis);
