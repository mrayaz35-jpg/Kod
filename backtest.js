/* Ayaz PA — Backtest motoru (TradingView Strategy Tester mantığı)
 * - Her 15dk mumun KAPANIŞINDA sadece o ana kadarki veriyle karar verir (geleceği görmez).
 * - Piyasa emri bir sonraki mumun açılışında dolar; limit emir fiyat gelirse dolar.
 * - Aynı mumda hem stop hem hedef değerse STOP sayılır (kötümser varsayım).
 * - Komisyon her iki yönde, kayma (slippage) aleyhte uygulanır.
 */
(function (root) {
  'use strict';
  const PA = root.PA;

  const DEFAULTS = {
    capital: 1000, riskPct: 1, maxNotionalPct: 100, commission: 0.1, slippage: 0.03,
    minScore: 50, minRR: 1.5, allowShort: false, useLimit: true, pendingBars: 8,
    exitMode: 'split', maxBars: 192, minStopPct: 0.4, phases: ['yeni', 'geri', 'devam', 'donus'], warmup: 820
  };

  function buildTF(c15, ms, mult) {
    let start = 0; while (start < c15.length && (c15[start].t % ms) !== 0) start++;
    return { arr: PA.aggregate(c15.slice(start), mult), start };
  }

  async function run(c15, userOpts = {}, onProgress) {
    const o = Object.assign({}, DEFAULTS, userOpts);
    const B1 = buildTF(c15, 3600000, 4), B4 = buildTF(c15, 14400000, 16);
    const h1 = B1.arr, start = B1.start, h4 = B4.arr, start4 = B4.start;
    const n = c15.length;
    let equity = o.capital, pos = null, pend = null;
    const trades = [], curve = [], fee = o.commission / 100, slip = o.slippage / 100;
    const warm = Math.max(o.warmup, start + 4 * 120, start4 + 16 * 40);
    if (n < warm + 50) throw new Error(`Yetersiz veri: en az ${warm + 50} adet 15dk mum gerekli (${n} var).`);

    const closePart = (bar, px, frac, reason) => {
      const q = pos.qtyOpen * frac;
      const exitPx = px * (1 - pos.dir * slip);
      const gross = (exitPx - pos.entryPx) * q * pos.dir;
      const cost = exitPx * q * fee;
      equity += gross - cost;
      pos.realized += gross - cost;
      pos.exitVal += exitPx * q; pos.exitQty += q;
      pos.qtyOpen -= q;
      pos.reasons.push(reason);
      if (pos.qtyOpen <= pos.qty * 1e-9) finish(bar);
    };
    const finish = (bar) => {
      const exitAvg = pos.exitVal / pos.exitQty;
      const pnl = pos.realized - pos.entryFee;
      trades.push({
        n: trades.length + 1, dir: pos.dir, entryT: c15[pos.entryI].t, exitT: c15[bar].t, entryPx: pos.entryPx, exitPx: exitAvg,
        qty: pos.qty, pnl, pnlPct: pnl / pos.equityAtEntry * 100, rMult: pnl / pos.riskCash, bars: bar - pos.entryI + 1,
        reason: pos.reasons.join(' → '), runup: pos.runup, drawdown: pos.dd, phase: pos.phase, score: pos.score, setup: pos.setup, model: pos.model, riskPct: pos.riskPct, ctx: pos.ctx, rrP: pos.rrP
      });
      pos = null;
    };
    const open = (bar, px, p, setup) => {
      const entryPx = px * (1 + p.dir * slip);
      const riskPer = Math.abs(entryPx - p.stop);
      if (riskPer / entryPx * 100 < o.minStopPct) return false;
      if (riskPer <= 0 || (p.dir === 1 ? p.stop >= entryPx : p.stop <= entryPx)) return false;
      const riskCash = equity * o.riskPct / 100;
      let qty = riskCash / riskPer;
      qty = Math.min(qty, equity * o.maxNotionalPct / 100 / entryPx);
      if (qty <= 0) return false;
      const entryFee = entryPx * qty * fee;
      equity -= 0; // ücret işlem kapanınca PnL'e yansıtılır
      pos = { dir: p.dir, entryI: bar, entryPx, qty, qtyOpen: qty, stop: p.stop, targets: p.targets.slice(), t1Hit: false, realized: 0, entryFee,
        exitVal: 0, exitQty: 0, reasons: [], runup: 0, dd: 0, riskCash: riskPer * qty, equityAtEntry: equity, phase: p.phase.key, score: p.score, setup, model: p.model || null, riskPct: riskPer / entryPx * 100, ctx: p.ctx || null, rrP: p.rrPlan ?? p.rr };
      equity -= entryFee; pos.realized -= 0;
      return true;
    };

    const t0 = performance.now ? performance.now() : Date.now();
    for (let i = warm; i < n; i++) {
      const b = c15[i];
      // 1) Bekleyen limit emir
      if (pend && !pos) {
        if (i > pend.exp) pend = null;
        else if (pend.dir === 1 ? b.l <= pend.entry : b.h >= pend.entry) {
          const px = pend.dir === 1 ? Math.min(pend.entry, b.o) : Math.max(pend.entry, b.o);
          if (open(i, px, pend.plan, `Limit · not ${pend.plan.grade}`)) pos.limitBar = true;
          pend = null;
        }
      }
      // 2) Açık pozisyon yönetimi (bu mumun OHLC'si)
      if (pos) {
        const d = pos.dir, hiFav = d === 1 ? b.h : b.l, loAdv = d === 1 ? b.l : b.h;
        pos.runup = Math.max(pos.runup, (hiFav - pos.entryPx) * d * pos.qty);
        pos.dd = Math.min(pos.dd, (loAdv - pos.entryPx) * d * pos.qty);
        const stopHit = d === 1 ? b.l <= pos.stop : b.h >= pos.stop;
        if (stopHit) {
          const px = d === 1 ? Math.min(pos.stop, b.o) : Math.max(pos.stop, b.o);
          closePart(i, px, 1, pos.t1Hit ? 'Başabaş stop' : 'Stop');
        } else if (!(pos.limitBar && pos.entryI === i)) {
          const t1 = pos.targets[0], t2 = pos.targets[1];
          const hit = (t) => t != null && (d === 1 ? b.h >= t : b.l <= t);
          if (!pos.t1Hit && hit(t1)) {
            if (o.exitMode === 't1') closePart(i, t1, 1, 'Hedef 1');
            else if (o.exitMode === 'split' && t2 == null) closePart(i, t1, 1, 'Hedef 1 (tek hedef)');
            else if (o.exitMode === 'split') { pos.t1Hit = true; closePart(i, t1, 0.5, 'H1 %50'); if (pos) pos.stop = pos.entryPx; }
            else if (t2 == null) closePart(i, t1, 1, 'Hedef 1 (tek hedef)');
            else pos.t1Hit = true;
          }
          if (pos && (o.exitMode !== 't1') && hit(t2)) closePart(i, t2, 1, 'Hedef 2');
          if (pos && i - pos.entryI >= o.maxBars) closePart(i, b.c, 1, 'Süre doldu');
        }
      }
      // 3) Bar kapanışında karar
      if (!pos && !pend && i < n - 1) {
        const k1h = Math.floor((i - start + 1) / 4), k4 = Math.floor((i - start4 + 1) / 16);
        if (k1h >= 120 && k4 >= 40) {
          const m15 = PA.analyzeTF(c15.slice(Math.max(0, i - 299), i + 1));
          const c1 = h1.slice(Math.max(0, k1h - 200), k1h);
          const hh = PA.analyzeTF(c1), h4a = PA.analyzeTF(h4.slice(Math.max(0, k4 - 200), k4));
          const p = PA.decide(m15, hh, h4a, c1, { minRR: o.minRR, allowShort: o.allowShort, noVolume: o.noVolume });
          const okPhase = p.dir === -1 || o.phases.includes(p.phase.key);
          if (p.dir && okPhase && p.score >= o.minScore && (p.dir === 1 || o.allowShort)) {
            if (p.decision === 'AL') open(i + 1, c15[i + 1].o, p, `AL · not ${p.grade}`);
            else if (/LİMİT/.test(p.decision) && o.useLimit && (p.dir === 1 ? p.entry < b.c : p.entry > b.c))
              pend = { dir: p.dir, entry: p.entry, plan: p, exp: i + o.pendingBars };
          }
        }
      }
      const unreal = pos ? (b.c - pos.entryPx) * pos.dir * pos.qtyOpen : 0;
      curve.push({ t: b.t, eq: equity + unreal });
      if (onProgress && (i - warm) % 250 === 0) { onProgress((i - warm) / (n - warm)); await new Promise(r => setTimeout(r, 0)); }
    }
    if (pos) { closePart(n - 1, c15[n - 1].c, 1, 'Test sonu'); curve[curve.length - 1].eq = equity; }
    const ms = (performance.now ? performance.now() : Date.now()) - t0;
    return { trades, curve, stats: stats(trades, curve, o, c15[warm].c, c15[n - 1].c), opts: o, ms, from: c15[warm].t, to: c15[n - 1].t };
  }

  function stats(tr, curve, o, firstPx, lastPx, perDay = 96) {
    const wins = tr.filter(t => t.pnl > 0), losses = tr.filter(t => t.pnl <= 0);
    const gp = wins.reduce((s, t) => s + t.pnl, 0), gl = -losses.reduce((s, t) => s + t.pnl, 0);
    const net = gp - gl;
    let peak = o.capital, mdd = 0, mddPct = 0;
    for (const p of curve) { peak = Math.max(peak, p.eq); const d = peak - p.eq; if (d > mdd) { mdd = d; mddPct = d / peak * 100; } }
    let cl = 0, maxCL = 0, cw = 0, maxCW = 0;
    for (const t of tr) { if (t.pnl > 0) { cw++; cl = 0; } else { cl++; cw = 0; } maxCL = Math.max(maxCL, cl); maxCW = Math.max(maxCW, cw); }
    // Günlük getiriler (96 x 15dk)
    const daily = []; for (let i = perDay; i < curve.length; i += perDay) daily.push(curve[i].eq / curve[i - perDay].eq - 1);
    const mean = daily.reduce((s, x) => s + x, 0) / (daily.length || 1);
    const sd = Math.sqrt(daily.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, daily.length - 1));
    const dsd = Math.sqrt(daily.filter(x => x < 0).reduce((s, x) => s + x * x, 0) / Math.max(1, daily.length - 1));
    const end = curve.length ? curve[curve.length - 1].eq : o.capital;
    return {
      net, netPct: net / o.capital * 100, gp, gl, pf: gl ? gp / gl : (gp ? Infinity : 0), total: tr.length,
      winRate: tr.length ? wins.length / tr.length * 100 : 0, wins: wins.length, losses: losses.length,
      avg: tr.length ? net / tr.length : 0, avgWin: wins.length ? gp / wins.length : 0, avgLoss: losses.length ? gl / losses.length : 0,
      ratio: losses.length && wins.length ? (gp / wins.length) / (gl / losses.length) : 0,
      largestWin: wins.length ? Math.max(...wins.map(t => t.pnl)) : 0, largestLoss: losses.length ? Math.min(...losses.map(t => t.pnl)) : 0,
      avgR: tr.length ? tr.reduce((s, t) => s + t.rMult, 0) / tr.length : 0,
      mdd, mddPct, maxCL, maxCW, avgBars: tr.length ? tr.reduce((s, t) => s + t.bars, 0) / tr.length : 0,
      sharpe: sd ? mean / sd * Math.sqrt(365) : 0, sortino: dsd ? mean / dsd * Math.sqrt(365) : 0,
      buyHold: (lastPx / firstPx - 1) * 100, endEquity: end, recovery: mdd ? net / mdd : 0,
      longs: tr.filter(t => t.dir === 1).length, shorts: tr.filter(t => t.dir === -1).length
    };
  }

  // Trend Kırılımı backtest'i: 1s mumlar + BTC günlük (rejim). Kurallar PA.trend ile birebir aynı.
  function runTrend(c1h, btcD1, userOpts = {}) {
    const o = Object.assign({ capital: 1000, riskPct: 1, commission: 0.1, slippage: 0.03, maxNotionalPct: 100 }, userOpts);
    const t0 = performance.now ? performance.now() : Date.now();
    const N = PA.TREND.N;
    if (c1h.length < N + 50) throw new Error(`Yetersiz veri: en az ${N + 50} adet 1 saatlik mum gerekli (${c1h.length} var).`);
    const tr = PA.trend(c1h, { btcD1, fee: o.commission, slip: o.slippage });
    const startI = N + 1, startT = c1h[startI].t;
    const list = tr.trades.filter(t => t.sigT >= c1h[startI - 1].t).sort((a, b) => a.t - b.t);
    let equity = o.capital, k = 0, cur = null;
    const trades = [], curve = [];
    for (let i = startI; i < c1h.length; i++) {
      const b = c1h[i];
      if (!cur && k < list.length && list[k].t === b.t) {
        const t = list[k++], riskCash = equity * o.riskPct / 100;
        let qty = riskCash / t.r; qty = Math.min(qty, equity * o.maxNotionalPct / 100 / t.e);
        cur = { t, qty, riskCash: qty * t.r, eq0: equity };
      }
      if (cur && cur.t.exitT === b.t) {
        const pnl = cur.t.R * cur.riskCash; equity += pnl;
        trades.push({ n: trades.length + 1, dir: 1, entryT: cur.t.t, exitT: b.t, entryPx: cur.t.e, exitPx: cur.t.exitPx, qty: cur.qty, pnl, pnlPct: pnl / cur.eq0 * 100,
          rMult: cur.t.R, bars: (b.t - cur.t.t) / 36e5 * 4, reason: cur.t.reason, runup: 0, drawdown: 0, phase: 'trend', score: null, setup: 'Trend kırılımı', model: 'trend' });
        cur = null;
        if (k < list.length && list[k].t === b.t) i--;           // aynı mumda yeni giriş
        continue;
      }
      const unreal = cur ? (b.c - cur.t.e) * cur.qty : 0;
      curve.push({ t: b.t, eq: equity + unreal });
    }
    if (cur) {   // test sonu: açık pozisyon son fiyattan kapatılır
      const last = c1h[c1h.length - 1], px = last.c * (1 - o.slippage / 100);
      const R = ((px - cur.t.e) - (cur.t.e + px) * o.commission / 100) / cur.t.r, pnl = R * cur.riskCash; equity += pnl;
      trades.push({ n: trades.length + 1, dir: 1, entryT: cur.t.t, exitT: last.t, entryPx: cur.t.e, exitPx: px, qty: cur.qty, pnl, pnlPct: pnl / cur.eq0 * 100, rMult: R,
        bars: (last.t - cur.t.t) / 36e5 * 4, reason: 'Test sonu (pozisyon açık)', runup: 0, drawdown: 0, phase: 'trend', score: null, setup: 'Trend kırılımı', model: 'trend' });
      if (curve.length) curve[curve.length - 1].eq = equity;
    }
    const ms = (performance.now ? performance.now() : Date.now()) - t0;
    return { trades, curve, stats: stats(trades, curve, o, c1h[startI].c, c1h[c1h.length - 1].c, 24), opts: o, ms, from: startT, to: c1h[c1h.length - 1].t, strategy: 'trend' };
  }

  // Motor kurulumları backtest'i (ENG.simulate ile birebir aynı kurallar). Aynı anda tek pozisyon (long ve short ayrı izlenir, sermaye ortak).
  function runMotor(c1h, engOpts = {}, userOpts = {}) {
    const o = Object.assign({ capital: 1000, riskPct: 1, commission: 0.1, slippage: 0.03, maxNotionalPct: 100 }, userOpts);
    const t0 = performance.now ? performance.now() : Date.now();
    const W = 200;
    if (c1h.length < W + 100) throw new Error(`Yetersiz veri: en az ${W + 100} adet 1 saatlik mum gerekli (${c1h.length} var).`);
    const from = c1h[W].t;
    const list = root.ENG.simulate(c1h, { ...engOpts, fee: o.commission, slip: o.slippage, from });
    let equity = o.capital; const trades = [], curve = [], open = [];
    const byEntry = new Map(); list.forEach(t => { const k = t.t; if (!byEntry.has(k)) byEntry.set(k, []); byEntry.get(k).push(t); });
    for (let i = W; i < c1h.length; i++) {
      const b = c1h[i];
      for (const t of byEntry.get(b.t) || []) { const riskCash = equity * o.riskPct / 100, r = Math.abs(t.e - t.stop0); let qty = riskCash / r; qty = Math.min(qty, equity * o.maxNotionalPct / 100 / t.e); open.push({ t, qty, riskCash: qty * r, eq0: equity }); }
      for (let k = open.length - 1; k >= 0; k--) {
        const p = open[k];
        if (p.t.exitT === b.t || (p.t.open && i === c1h.length - 1)) {
          const pnl = p.t.R * p.riskCash; equity += pnl;
          trades.push({ n: trades.length + 1, dir: p.t.side, entryT: p.t.t, exitT: b.t, entryPx: p.t.e, exitPx: p.t.exitPx, qty: p.qty, pnl, pnlPct: pnl / p.eq0 * 100, rMult: p.t.R,
            bars: (b.t - p.t.t) / 36e5 * 4, reason: p.t.open ? 'Test sonu (pozisyon açık)' : p.t.reason, runup: 0, drawdown: 0, phase: 'motor', score: null, setup: p.t.setups.join(', '), model: 'trend' });
          open.splice(k, 1);
        }
      }
      const unreal = open.reduce((s, p) => s + (p.t.side === 1 ? b.c - p.t.e : p.t.e - b.c) * p.qty, 0);
      curve.push({ t: b.t, eq: equity + unreal });
    }
    const ms = (performance.now ? performance.now() : Date.now()) - t0;
    return { trades, curve, stats: stats(trades, curve, o, c1h[W].c, c1h[c1h.length - 1].c, 24), opts: o, ms, from, to: c1h[c1h.length - 1].t, strategy: 'motor' };
  }

  root.BT = { run, runTrend, runMotor, DEFAULTS, stats };
})(typeof window !== 'undefined' ? window : globalThis);
