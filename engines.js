/* Ayaz PA — Ayrı motorlar (tek geçişte, geleceği görmeden). Her 1s mum kapanışında her motor kendi sinyalini üretir.
 * Motorlar: Yapı (BOS/CHoCH, 1s+4s), Order Block, FVG, Likidite (süpürme, oda), Mum formasyonu, Hacim, Fibonacci geri çekilme,
 * Momentum/trend (EMA, RSI, 20 gün zirvesi), Zaman (seans), Piyasa rejimi (BTC).
 * features(c1h, opts) → her mum için özellik satırı (long bakış açısıyla). Short için fiyat serisi ters çevrilip aynı motorlar çalıştırılır.
 */
(function (root) {
  'use strict';
  const L = 3, R = 3;                                   // pivot: solda/sağda 3 mum (sağdaki 3 mum kapanınca teyit olur)

  function invert(c) { return c.map(x => ({ t: x.t, o: 1 / x.o, h: 1 / x.l, l: 1 / x.h, c: 1 / x.c, v: x.v })); }
  function agg(c, ms) {
    const o = []; let cur = null;
    for (const x of c) { const b = Math.floor(x.t / ms) * ms; if (!cur || cur.t !== b) { if (cur) o.push(cur); cur = { t: b, o: x.o, h: x.h, l: x.l, c: x.c, v: x.v, n: 1 }; } else { cur.h = Math.max(cur.h, x.h); cur.l = Math.min(cur.l, x.l); cur.c = x.c; cur.v += x.v; cur.n++; } }
    if (cur) o.push(cur); return o;
  }

  // Tek zaman dilimi yapı motoru: pivotlar, kırılımlar, OB, FVG, süpürmeler (artımlı)
  function structEngine(c) {
    const n = c.length, A = new Array(n), out = new Array(n);
    let a = 0;
    const ph = [], pl = [];                             // teyitli pivotlar {i,p,broken}
    let lastDir = 0, lastBreakI = -999, prevDir = 0, chochI = -999;
    const obs = [], fvgs = [];                          // aktif boğa OB / FVG (long bakış)
    let lastSweepI = -999, sweepLvl = null;
    for (let i = 0; i < n; i++) {
      const x = c[i];
      const tr = i ? Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c)) : x.h - x.l;
      a = i < 14 ? (a * i + tr) / (i + 1) : (a * 13 + tr) / 14; A[i] = a;
      // pivot teyidi (i-R)
      const k = i - R;
      if (k >= L) {
        let H = true, Lo = true;
        for (let q = 1; q <= L; q++) { if (c[k - q].h >= c[k].h) H = false; if (c[k - q].l <= c[k].l) Lo = false; }
        for (let q = 1; q <= R; q++) { if (c[k + q].h > c[k].h) H = false; if (c[k + q].l < c[k].l) Lo = false; }
        if (H) ph.push({ i: k, p: c[k].h, broken: false }); if (Lo) pl.push({ i: k, p: c[k].l, broken: false });
      }
      // kırılım (kapanışla): son kırılmamış tepe/dip
      const hp = ph.length ? ph[ph.length - 1] : null, lp = pl.length ? pl[pl.length - 1] : null;
      let bosUp = false, bosDn = false;
      if (hp && !hp.broken && x.c > hp.p) {
        hp.broken = true; bosUp = true; prevDir = lastDir; lastDir = 1; lastBreakI = i; if (prevDir === -1) chochI = i;
        // OB: kırılan tepeden bu muma kadar en düşük dibi yapan mum
        let m = hp.i + 1, best = m; for (let q = hp.i + 1; q < i; q++) if (c[q].l <= c[best].l) best = q;
        if (best < i) obs.push({ i: best, top: c[best].h, bot: c[best].l, born: i, touched: false });
        if (obs.length > 6) obs.shift();
      }
      if (lp && !lp.broken && x.c < lp.p) { lp.broken = true; bosDn = true; prevDir = lastDir; lastDir = -1; lastBreakI = i; }
      // FVG (boğa): low[i] > high[i-2], orta mum yükseliş
      if (i >= 2 && x.l > c[i - 2].h && c[i - 1].c > c[i - 1].o) { fvgs.push({ i, top: x.l, bot: c[i - 2].h, size: (x.l - c[i - 2].h) / (a || 1), touched: false }); if (fvgs.length > 8) fvgs.shift(); }
      // OB / FVG temas ve geçersizlik
      let inOB = 0, obAge = 0, inFVG = 0, fvgSize = 0;
      for (let q = obs.length - 1; q >= 0; q--) {
        const z = obs[q];
        if (z.born === i) continue;
        if (x.c < z.bot) { obs.splice(q, 1); continue; }               // kapanışla altına indi: geçersiz
        if (x.l <= z.top && x.c >= z.bot && !z.touched) { inOB = 1; obAge = i - z.born; z.touched = true; }
      }
      for (let q = fvgs.length - 1; q >= 0; q--) {
        const z = fvgs[q];
        if (z.i === i) continue;
        if (x.c < z.bot) { fvgs.splice(q, 1); continue; }
        if (x.l <= z.top && x.c >= z.bot && !z.touched) { inFVG = 1; fvgSize = Math.max(fvgSize, z.size); z.touched = true; }
      }
      // Likidite süpürmesi (SFP): son teyitli dibin altına fitil, kapanış üstünde
      if (lp && i - lp.i <= 72 && x.l < lp.p && x.c > lp.p) { lastSweepI = i; sweepLvl = lp.p; }
      // Oda: üstteki en yakın kırılmamış tepe (BSL) uzaklığı
      let room = 99; for (let q = ph.length - 1; q >= Math.max(0, ph.length - 12); q--) if (!ph[q].broken && ph[q].p > x.c) room = Math.min(room, (ph[q].p - x.c) / (a || 1));
      // Trend yapısı: son iki tepe ve dip
      let hhhl = 0;
      if (ph.length >= 2 && pl.length >= 2) {
        const h1 = ph[ph.length - 1].p, h0 = ph[ph.length - 2].p, l1 = pl[pl.length - 1].p, l0 = pl[pl.length - 2].p;
        hhhl = h1 > h0 && l1 > l0 ? 1 : h1 < h0 && l1 < l0 ? -1 : 0;
      }
      // Fibonacci: son yükseliş bacağı (son teyitli dipten bu yana en yüksek) içinde geri çekilme oranı
      let retr = null;
      if (lp) { let hi = -Infinity; for (let q = lp.i; q <= i; q++) hi = Math.max(hi, c[q].h); const leg = hi - lp.p; if (leg > 0.5 * a) retr = (hi - x.c) / leg; }
      out[i] = { atr: a, dir: lastDir, breakAge: i - lastBreakI, bosUp, bosDn, choch: i - chochI, inOB, obAge, inFVG, fvgSize, sweepAge: i - lastSweepI, room, hhhl, retr,
        lastPH: hp ? hp.p : null, lastPL: lp ? lp.p : null };
    }
    return { A, out };
  }

  const ema = (a, n) => { const k = 2 / (n + 1), o = new Array(a.length); let e = a[0]; for (let i = 0; i < a.length; i++) { e = i ? a[i] * k + e * (1 - k) : a[0]; o[i] = e; } return o; };
  function rsi(cl, n = 14) { const o = new Array(cl.length).fill(50); let g = 0, l = 0; for (let i = 1; i < cl.length; i++) { const d = cl[i] - cl[i - 1]; const up = Math.max(d, 0), dn = Math.max(-d, 0); if (i <= n) { g += up / n; l += dn / n; } else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; } o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } return o; }

  // Ana özellik çıkarıcı. c1h: kapanmış 1s mumlar. opts.btcReg: Map(gün → ±1), opts.btc4: fn(t)→±1 (BTC 4s yön)
  function features(c1h, opts = {}) {
    const n = c1h.length, cl = c1h.map(x => x.c);
    const S1 = structEngine(c1h), E20 = ema(cl, 20), E50 = ema(cl, 50), E200 = ema(cl, 200), RS = rsi(cl);
    const c4 = opts.c4 || agg(c1h, 4 * 36e5), S4 = structEngine(c4), E4 = ema(c4.map(x => x.c), 50);
    const vS = new Array(n); { let s = 0; for (let i = 0; i < n; i++) { s += c1h[i].v; if (i >= 20) s -= c1h[i - 20].v; vS[i] = s / Math.min(i + 1, 20); } }
    // 20 günlük (480 mum) en yüksek: monoton kuyruk
    const hh = new Array(n).fill(null); { const dq = []; for (let i = 0; i < n; i++) { while (dq.length && dq[0] < i - 480) dq.shift(); if (i >= 480) hh[i] = c1h[dq[0]].h; while (dq.length && c1h[dq[dq.length - 1]].h <= c1h[i].h) dq.pop(); dq.push(i); } }
    if (opts.hhFn) for (let i = 0; i < n; i++) if (hh[i] == null) hh[i] = opts.hhFn(i);   // kısa geçmişte: günlük mumlardan yaklaşık 20 gün zirvesi
    const rows = new Array(n); let j4 = -1, lastBrk = -9999;
    for (let i = 0; i < n; i++) {
      const x = c1h[i], s = S1.out[i], a = s.atr || 1e-12, tClose = x.t + 36e5;
      while (j4 + 1 < c4.length && c4[j4 + 1].t + 4 * 36e5 <= tClose) j4++;   // yalnız tamamlanmış 4s mum
      const s4 = j4 >= 0 ? S4.out[j4] : null;
      const p = i ? c1h[i - 1] : x, body = Math.abs(x.c - x.o), rng = x.h - x.l || 1e-12;
      const lw = Math.min(x.o, x.c) - x.l, uw = x.h - Math.max(x.o, x.c);
      const engulf = x.c > x.o && p.c < p.o && x.c >= p.o && x.o <= p.c ? 1 : 0;
      const hammer = lw >= 2 * body && lw >= 0.55 * rng && uw <= 0.25 * rng ? 1 : 0;
      const ibBreak = i >= 2 && p.h <= c1h[i - 2].h && p.l >= c1h[i - 2].l && x.c > p.h ? 1 : 0;
      const bigBull = x.c > x.o && body >= 1.2 * a ? 1 : 0;
      if (hh[i] != null && x.c > hh[i]) lastBrk = i;
      const d = new Date(x.t);
      rows[i] = {
        t: x.t, c: x.c, atr: a, atrPct: a / x.c * 100,
        // Yapı
        dir1: s.dir, breakAge1: Math.min(s.breakAge, 99), bosUp: s.bosUp ? 1 : 0, choch1: s.choch <= 12 ? 1 : 0, hhhl1: s.hhhl,
        dir4: s4 ? s4.dir : 0, hhhl4: s4 ? s4.hhhl : 0, choch4: s4 && s4.choch <= 6 ? 1 : 0,
        // Order block / FVG
        inOB: s.inOB, obAge: s.obAge, inFVG: s.inFVG, fvgSize: s.fvgSize, inOB4: s4 ? s4.inOB : 0, inFVG4: s4 ? s4.inFVG : 0,
        // Likidite
        sweep1: s.sweepAge <= 3 ? 1 : 0, sweep4: s4 && s4.sweepAge <= 2 ? 1 : 0, room: Math.min(s.room, 20),
        // Mum
        engulf, hammer, ibBreak, bigBull,
        // Hacim
        rv: vS[i - 1] ? x.v / vS[i - 1] : 1, rv3: i >= 3 && vS[i - 3] ? (x.v + c1h[i - 1].v + c1h[i - 2].v) / 3 / vS[i - 3] : 1,
        // Fibonacci
        retr: s.retr, ote: s.retr != null && s.retr >= 0.618 && s.retr <= 0.79 ? 1 : 0, disc: s.retr != null && s.retr >= 0.5 ? 1 : 0,
        // Momentum / trend
        ema50: x.c > E50[i] ? 1 : 0, ema200: x.c > E200[i] ? 1 : 0, ema50_200: E50[i] > E200[i] ? 1 : 0, ema4: j4 >= 0 && c4[j4].c > E4[j4] ? 1 : 0,
        dE20: (x.c - E20[i]) / a, rsi: RS[i], ret24: i >= 24 ? (x.c / c1h[i - 24].c - 1) * 100 / (a / x.c * 100) : 0,
        d20: hh[i] != null ? (hh[i] - x.c) / a : null, brk20: hh[i] != null && x.c > hh[i] ? 1 : 0, sinceBrk: Math.min(i - lastBrk, 999),
        // Zaman
        hour: d.getUTCHours(), dow: d.getUTCDay(), lon: d.getUTCHours() >= 7 && d.getUTCHours() < 10 ? 1 : 0, ny: d.getUTCHours() >= 12 && d.getUTCHours() < 16 ? 1 : 0,
        // Rejim
        btc: opts.btcReg ? (opts.btcReg(tClose) || 0) : 0
      };
    }
    return rows;
  }

  // Etiket: i kapanışında karar, i+1 açılışında giriş. Stop = giriş − ks·ATR, hedef = giriş + kt·ATR, en fazla H mum. Aynı mumda ikisi → stop.
  function label(c1h, rows, i, ks, kt, H, cost) {
    if (i + 1 >= c1h.length) return null;
    const e = c1h[i + 1].o, a = rows[i].atr, st = e - ks * a, tp = e + kt * a, r = e - st;
    for (let q = i + 1; q < Math.min(c1h.length, i + 1 + H); q++) {
      const b = c1h[q];
      if (b.l <= st) return (Math.min(st, b.o) - e - cost * e) / r;
      if (b.h >= tp) return (tp - e - cost * e) / r;
    }
    const q = Math.min(c1h.length - 1, i + H);
    return (c1h[q].c - e - cost * e) / r;
  }

  // İz süren çıkışlı etiket: ilk stop ks·ATR, iz = en yüksek − kt·ATR, en fazla H mum
  // inv=true: seri ters çevrilmiş (short). R gerçek fiyatlarla hesaplanır: (giriş − çıkış) / (stop − giriş)
  function labelTrail(c1h, rows, i, ks, kt, H, cost, inv) {
    if (i + 1 >= c1h.length) return null;
    const e = c1h[i + 1].o, a = rows[i].atr; let st = e - ks * a, best = e; const st0 = st;
    const res = x => inv ? ((1 / e - 1 / x) - cost / e) / (1 / st0 - 1 / e) : (x - e - cost * e) / (e - st0);
    for (let q = i + 1; q < Math.min(c1h.length, i + 1 + H); q++) {
      const b = c1h[q];
      if (b.l <= st) return res(Math.min(st, b.o));
      best = Math.max(best, b.h); st = Math.max(st, best - kt * rows[q].atr);
    }
    return res(c1h[Math.min(c1h.length - 1, i + H)].c);
  }
  // ================= KURULUMLAR (motor kombinasyonları) =================
  // 18 coin, 2024-01 → 2026-04 gerçek Binance verisinde seçildi (eğitim + doğrulama dönemlerinin ikisinde de pozitif),
  // 2026-05 → 2026-09 test döneminde (hiç görmediği veri) ölçüldü. Çıkış: ilk stop 3 ATR, iz süren stop en iyi fiyat − 8 ATR (1s).
  const E = {   // motor koşulları (long bakış; short için ters seri)
    vol2: r => r.rv > 2, vol15: r => r.rv3 > 1.5, bos: r => r.bosUp === 1, choch: r => r.choch1 === 1, engulf: r => r.engulf === 1, big: r => r.bigBull === 1,
    btc: r => r.btc === 1, rsi70: r => r.rsi > 70, rsi60: r => r.rsi > 60, near20: r => r.d20 != null && r.d20 < 1, sb24: r => r.sinceBrk <= 24 && r.brk20 === 0,
    asia: r => r.hour < 7, lon: r => r.lon === 1, ny: r => r.ny === 1, hhhl4: r => r.hhhl4 === 1, ote: r => r.ote === 1, dir1: r => r.dir1 === 1, sweep: r => r.sweep1 === 1
  };
  const EN = {   // motor adları (kullanıcıya)
    vol2: 'Hacim: son mum ortalamanın 2 katı', vol15: 'Hacim: son 3 mum ortalamanın 1.5 katı', bos: 'Yapı: 1s BOS', choch: 'Yapı: 1s CHoCH (son 12 mum)', engulf: 'Mum: yutan formasyon',
    big: 'Mum: güçlü gövde (≥1.2 ATR)', btc: 'Rejim: BTC aynı yönde', rsi70: 'Momentum: RSI aşırı bölgede', rsi60: 'Momentum: RSI güçlü', near20: 'Momentum: 20 gün zirvesine/dibine 1 ATR içinde',
    sb24: 'Momentum: 20 gün kırılımı son 24 saatte, şimdi geri test', asia: 'Zaman: Asya seansı', lon: 'Zaman: Londra açılışı', ny: 'Zaman: New York seansı',
    hhhl4: 'Yapı: 4s trend aynı yönde (HH/HL)', ote: 'Fibonacci: OTE (0.618–0.79) geri çekilme', dir1: 'Yapı: 1s yön aynı', sweep: 'Likidite: tepe/dip süpürmesi'
  };
  const SETUPS = [
    { id: 'L1', side: 1, name: 'Hacimli yapı kırılımı', eng: ['vol2', 'bos', 'engulf'] },
    { id: 'L2', side: 1, name: 'Güçlü mumla karakter değişimi', eng: ['big', 'btc', 'choch'] },
    { id: 'L3', side: 1, name: 'Kırılım sonrası Asya devamı', eng: ['rsi70', 'sb24', 'asia'], off: true },   // 303 TRY paritesi + 18 coin testinde eksi: kapalı
    { id: 'L4', side: 1, name: 'Zirvede momentum mumu', eng: ['near20', 'rsi70', 'big'], off: true },
    { id: 'L5', side: 1, name: 'Rejimle momentum', eng: ['rsi70', 'big', 'btc'] },
    { id: 'L6', side: 1, name: 'Hacimli geri test', eng: ['rsi60', 'vol2', 'sb24'], off: true },
    { id: 'S1', side: -1, name: 'NY seansında hacimli dip kırılımı', eng: ['near20', 'vol2', 'ny'] },
    { id: 'S2', side: -1, name: 'Düşen 4s yapıda NY dip testi', eng: ['near20', 'hhhl4', 'ny'] },
    { id: 'S3', side: -1, name: 'NY aşırı satışta güçlü satış mumu', eng: ['rsi70', 'big', 'ny'] },
    { id: 'S4', side: -1, name: 'NY momentum satışı', eng: ['rsi60', 'big', 'ny'] },
    { id: 'S5', side: -1, name: 'NY hacimli aşırı satış devamı', eng: ['rsi70', 'vol2', 'ny'] }
  ];
  const EXIT = { ks: 3, kt: 8, maxH: 480 };
  // Varsayılan filtre: long kurulumlar yalnız BTC rejimi olumluyken (testte en sağlam sonuç bu)
  const DEFAULT_FILTER = (r, side) => side === 1 ? r.btc === 1 : true;
  const filt = opts => opts.filter === false ? null : (opts.filter || DEFAULT_FILTER);
  const matchSetups = (r, side) => r ? SETUPS.filter(s => !s.off && s.side === side && s.eng.every(k => E[k](r))) : [];
  // GİRİŞ KORUMASI (geç kalınmış / riskli girişleri ele): 303 Binance TRY paritesi (2025-09 → 2026-10) ve 18 büyük coin (2020 → 2026)
  // testlerinin İKİSİNDE de bu durumlardaki sinyaller ortalamadan belirgin kötü çıktı.
  const GUARD = { maxRisk: 6, max24: 0.10, max168: 0.40, maxBtc7: 0.10 };
  function guard(c, i, riskPct, btc7) {
    if (riskPct < 1) return `stop çok yakın (%${riskPct.toFixed(2)}): hareketsiz/stabil parite, maliyet kârı yer`;
    if (riskPct >= GUARD.maxRisk) return `stop çok uzak (%${riskPct.toFixed(1)}); risk/ödül bozuk`;
    if (i >= 24 && c[i].c / c[i - 24].c - 1 >= GUARD.max24) return `son 24 saatte %${((c[i].c / c[i - 24].c - 1) * 100).toFixed(0)} yükseldi: geç kalındı, geri çekilme bekle`;
    if (i >= 168 && c[i].c / c[i - 168].c - 1 >= GUARD.max168) return `son 7 günde %${((c[i].c / c[i - 168].c - 1) * 100).toFixed(0)} yükseldi: geç kalındı`;
    if (btc7 != null && btc7 >= GUARD.maxBtc7) return `BTC son 7 günde %${(btc7 * 100).toFixed(0)} yükseldi: piyasa aşırı ısınmış`;
    return null;
  }
  // BTC günlük mumlarından 7 günlük getiri fonksiyonu (önceki tamamlanmış güne göre; geleceği görmez)
  function btc7Fn(d1) {
    if (!d1 || d1.length < 10) return null;
    const m = new Map(d1.map(x => [Math.floor(x.t / 864e5) * 864e5, x.c]));
    return t => { const d = Math.floor(t / 864e5) * 864e5 - 864e5, a = m.get(d), b = m.get(d - 7 * 864e5); return a && b ? a / b - 1 : null; };
  }
  // Bir mumdaki tüm motorların durumu (ekranda göstermek için)
  const engineState = r => r ? Object.keys(E).map(k => ({ k, name: EN[k], on: !!E[k](r) })) : [];

  // c1h: kapanmış 1s mumlar (artan). opts: btcReg(t)→±1, c4 (4s mumlar), d1 (günlük mumlar, kısa geçmiş için), fee, slip
  function prepSides(c1h, opts = {}) {
    const mk = (side) => {
      const c = side === 1 ? c1h : invert(c1h);
      const c4 = opts.c4 ? (side === 1 ? opts.c4 : invert(opts.c4)) : null;
      let hhFn = null;
      if (opts.d1 && opts.d1.length >= 20) {
        const d1 = side === 1 ? opts.d1 : invert(opts.d1);
        hhFn = i => { const t = c[i].t, ds = Math.floor(t / 864e5) * 864e5, prev = d1.filter(x => x.t < ds).slice(-20); if (prev.length < 20) return null;
          let h = Math.max(...prev.map(x => x.h)); for (let q = i - 1; q >= 0 && c[q].t >= ds; q--) h = Math.max(h, c[q].h); return h; };
      }
      const reg = opts.btcReg ? (side === 1 ? opts.btcReg : t => -opts.btcReg(t)) : null;
      return { c, rows: features(c, { btcReg: reg, c4, hhFn }) };
    };
    return { L: mk(1), S: mk(-1) };
  }
  // Geçmiş simülasyonu: her yönde aynı anda tek pozisyon, i kapanışında sinyal → i+1 açılışında giriş
  function simulate(c1h, opts = {}) {
    const P = opts.prep || prepSides(c1h, opts), fee = (opts.fee ?? 0.1) / 100, slip = (opts.slip ?? 0.03) / 100, trades = [];
    for (const side of [1, -1]) {
      if (side === -1 && opts.longOnly) continue;
      const { c, rows } = side === 1 ? P.L : P.S; let pos = null;
      for (let i = 1; i < c.length; i++) {
        const b = c[i];
        if (pos) {
          if (b.l <= pos.st) {
            const px = Math.min(pos.st, b.o) * (1 - slip); let R = (px - pos.e - (pos.e + px) * fee) / pos.r; if (pos.half != null) R = pos.half + R * 0.5;
            trades.push(fin(pos, side, b.t, px, R, false, pos.st > pos.e ? 'İz süren stop (kârda)' : pos.st > pos.st0 ? 'İz süren stop' : 'Stop')); pos = null;
          } else if (opts.tp1 && !pos.half && b.h >= pos.e + opts.tp1 * pos.r) {
            // %50 kâr al (hedef 1), kalan iz süren stopla devam; R'ye yarısı eklenir
            const px = (pos.e + opts.tp1 * pos.r) * (1 - slip); pos.half = (px - pos.e - (pos.e + px) * fee) / pos.r * 0.5; pos.st = Math.max(pos.st, pos.e);
            pos.best = Math.max(pos.best, b.h);
          } else { pos.best = Math.max(pos.best, b.h); pos.st = Math.max(pos.st, pos.best - EXIT.kt * rows[i].atr); if (i - pos.i >= EXIT.maxH) { const px = b.c * (1 - slip); trades.push(fin(pos, side, b.t, px, (px - pos.e - (pos.e + px) * fee) / pos.r, false, 'Süre doldu')); pos = null; } }
        }
        if (!pos && i < c.length - 1 && (opts.from == null || b.t >= opts.from)) {
          const m = matchSetups(rows[i], side);
          if (m.length && (!filt(opts) || filt(opts)(rows[i], side)) && !(side === 1 && opts.guard !== false && guard(c, i, EXIT.ks * rows[i].atr / c[i].c * 100, opts.btc7 ? opts.btc7(b.t) : null))) { const e = c[i + 1].o * (1 + slip), st = e - EXIT.ks * rows[i].atr; pos = { i: i + 1, t: c[i + 1].t, sigT: b.t, e, st, st0: st, r: e - st, best: e, setups: m.map(s => s.id) }; }
        }
      }
      if (pos) { const last = c[c.length - 1]; trades.push(fin(pos, side, null, last.c, (last.c - pos.e - (pos.e + last.c) * fee) / pos.r, true, 'Açık')); }
    }
    return trades.sort((a, b) => a.t - b.t);
    function fin(p, side, exitT, px, R, open, reason) {
      const real = v => side === 1 ? v : 1 / v;              // ters seriden gerçek fiyata
      if (side === -1) { const eR = 1 / p.e, xR = 1 / px, sR = 1 / p.st0; R = (eR - xR - (eR + xR) * fee) / (sR - eR); }   // short R gerçek fiyatlarla
      return { side, t: p.t, sigT: p.sigT, exitT, e: real(p.e), exitPx: real(px), stop: real(p.st), stop0: real(p.st0), R, open, reason, setups: p.setups, n: p.setups.length };
    }
  }
  // Son kapanmış mumda sinyal + açık pozisyon durumu
  function scanNow(c1h, opts = {}) {
    const P = prepSides(c1h, opts), n = c1h.length, out = [], blocked = [];
    for (const side of [1, -1]) {
      if (side === -1 && opts.longOnly) continue;
      const { c, rows } = side === 1 ? P.L : P.S, r = rows[n - 1];
      const m = matchSetups(r, side), F = filt(opts);
      if (m.length && (!F || F(r, side))) {
        const a = r.atr, ci = c[n - 1].c, stI = ci - EXIT.ks * a, e = c1h[n - 1].c;
        const g = side === 1 && opts.guard !== false ? guard(c, n - 1, EXIT.ks * a / ci * 100, opts.btc7 ? opts.btc7(c[n - 1].t) : null) : null;
        if (g) { blocked.push({ side, setups: m, reason: g }); continue; }
        out.push({ side, quality: side === 1 && root.PA && root.PA.quality ? root.PA.quality(c1h, n - 1) : null, setups: m, engines: engineState(r), entry: e, stop: side === 1 ? stI : 1 / stI, riskPct: EXIT.ks * a / ci * 100, trailPct: EXIT.kt * a / ci * 100, strength: m.length, t: c1h[n - 1].t });
      }
    }
    const hist = opts.history ? simulate(c1h, { ...opts, prep: P }) : null;
    return { signals: out, blocked, history: hist, open: hist ? hist.filter(t => t.open) : [], rowsL: P.L.rows[n - 1], rowsS: P.S.rows[n - 1] };
  }

  root.ENG = { GUARD, guard, btc7Fn, DEFAULT_FILTER, SETUPS, E, EN, EXIT, matchSetups, engineState, prepSides, simulate, scanNow, features, label, labelTrail, invert, agg, structEngine };
})(typeof window !== 'undefined' ? window : globalThis);
