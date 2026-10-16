/* Ayaz PA — uygulama: Binance verisi, tarayıcı, grafik, günlük plan, backtest arayüzü */
(function () {
  'use strict';
  const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
  const esc = s => String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const fp = PA.fmtP;
  const store = {
    get(k, d) { try { const v = localStorage.getItem('apa_' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('apa_' + k, JSON.stringify(v)); } catch {} }
  };

  // ---------------- Veri katmanı ----------------
  // claude.ai bağlantısında (artifact) Crypto.com bağlayıcısı, kurulu uygulamada Binance kullanılır.
  const ART = !!(window.claude && typeof window.claude.use === 'function');
  let mcp = null;
  const mcpReady = ART ? window.claude.use('mcp').then(m => (mcp = m)).catch(() => null) : Promise.resolve(null);
  const CDC = 'Crypto.com', STEP = { '15m': 900000, '1h': 3600000, '4h': 14400000, '1D': 86400000 };
  const toCdc = s => s.replace(/(USDT|TRY)$/, '_$1');
  function mcpMsg(e) {
    switch (e && e.code) {
      case 'server_not_connected': case 'selection_required': return "Crypto.com bağlayıcısı ekli değil. claude.ai Ayarlar → Bağlayıcılar'dan ekleyin";
      case 'needs_reauth': return "Crypto.com bağlayıcısını yeniden bağlayın (claude.ai Ayarlar → Bağlayıcılar)";
      case 'not_in_manifest': case 'approval_required': case 'not_granted': case 'capability_disabled': return 'Bu sayfaya Crypto.com verisi için izin verilmedi. Sayfayı yenileyip izin verin';
      case 'blocked_by_policy': return 'Kuruluş politikası Crypto.com verisini engelliyor';
      case 'cancelled': return 'Crypto.com 45 saniyede yanıt vermedi, tekrar deneyin';
      case 'server_unavailable': return 'Crypto.com şu an yanıt vermiyor, biraz sonra tekrar deneyin';
      default: return (e && e.message) || 'Veri alınamadı';
    }
  }
  async function cdc(tool, input, retried) { return mcpCall(CDC, tool, input, retried); }
  async function mcpCall(server, tool, input, retried) {
    await mcpReady;
    if (!mcp) { setConn(false, 'canlı veri izni yok'); throw new Error('Canlı veri için sayfayı claude.ai içinde açın'); }
    try {
      const opt = { cache: false };
      if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opt.signal = AbortSignal.timeout(60000);
      const r = await mcp.callTool(server, tool, input, opt); if (server === CDC) setConn(true);
      let p = r && r.payload !== undefined ? r.payload : r;
      if (typeof p === 'string') { try { p = JSON.parse(p); } catch {} }
      return p;
    }
    catch (e) {
      if (e && e.retryable && !retried) { await sleep(e.retryAfterMs || 1200 + Math.random() * 800); return mcpCall(server, tool, input, true); }
      if (server === CDC) setConn(false, e && e.code);
      throw new Error(mcpMsg(e).replace(/Crypto\.com/g, server));
    }
  }
  const MIN15 = ART ? 40 : 120, MIN1H = ART ? 40 : 100;

  // ---- Twelve Data: Binance fiyatı (uzun geçmiş, hacimsiz) ve BIST (hacimli). Plan sınırı: dakikada 8, günde 800 sorgu ----
  const TD = 'Twelve Data';
  let tdState = 'unknown';                      // unknown | ok | off
  const tdCalls = [];
  let tdPrio = 0;                                // ekranda açılan grafik, taramanın önüne geçer
  async function tdThrottle(onWait, prio) {
    if (prio) tdPrio++;
    try {
      for (;;) {
        const now = Date.now();
        while (tdCalls.length && now - tdCalls[0] > 61000) tdCalls.shift();
        if (tdCalls.length < 8 && (prio || !tdPrio)) { tdCalls.push(now); return; }
        const w = tdCalls.length < 8 ? 500 : 61500 - (now - tdCalls[0]);
        if (onWait && tdCalls.length >= 8) onWait(Math.ceil(w / 1000));
        await sleep(Math.min(w, 1000));
      }
    } finally { if (prio) tdPrio--; }
  }
  const tdCache = new Map();
  function aggregateByTime(c, ms) {
    const out = []; let cur = null;
    for (const x of c) {
      const b = Math.floor(x.t / ms) * ms;
      if (!cur || cur.t !== b) { if (cur) out.push(cur); cur = { t: b, o: x.o, h: x.h, l: x.l, c: x.c, v: x.v, ct: b + ms - 1 }; }
      else { cur.h = Math.max(cur.h, x.h); cur.l = Math.min(cur.l, x.l); cur.c = x.c; cur.v += x.v; }
    }
    if (cur) out.push(cur);
    return out;
  }
  // Twelve Data yanıtı düz metin ya da {result}/{content:[{text}]} içinde gelebilir
  function tdText(p) {
    if (typeof p === 'string') return p;
    if (!p) return '';
    if (typeof p.result === 'string') return p.result;
    if (typeof p.text === 'string') return p.text;
    const c = p.content || (p.result && p.result.content);
    if (Array.isArray(c)) return c.map(x => (x && x.text) || '').join('\n');
    return '';
  }
  const TD_STEP = { '15min': 900000, '1h': 3600000, '1day': 86400000 };
  async function tdSeries(symbol, exchange, size, tzMin, onWait, retried, prio, interval = '15min') {
    const key = symbol + '@' + exchange + '@' + interval, hit = tdCache.get(key);
    if (size >= 100 && hit && hit.size >= size && Date.now() - hit.at < 180000) return hit.c.map(x => ({ ...x }));   // 3 dk önbellek: kotayı korur
    await tdThrottle(onWait, prio);
    const p = await mcpCall(TD, 'get_time_series', { symbol, exchange, interval, outputsize: size });
    const txt = tdText(p);
    if (!txt || /^\s*Error/i.test(txt)) {
      if (!retried && /minute|dakika|rate/i.test(txt)) { await sleep(62000); return tdSeries(symbol, exchange, size, tzMin, onWait, true, prio, interval); }
      throw new Error((txt || 'Twelve Data boş yanıt').replace(/^Error:\s*/, '').slice(0, 160));
    }
    const lines = txt.trim().split('\n'), head = lines[0].split(';');
    const iv = head.indexOf('volume');
    const out = [];
    for (let k = 1; k < lines.length; k++) {
      const f = lines[k].split(';'); if (f.length < 5) continue;
      const ds = f[0].length === 10 ? f[0] + 'T00:00:00' : f[0].replace(' ', 'T');
      const t = Date.parse(ds + 'Z') - (interval === '1day' ? 0 : tzMin * 60000);
      out.push({ t, o: +f[1], h: +f[2], l: +f[3], c: +f[4], v: iv > 0 ? +f[iv] : NaN, ct: t + (TD_STEP[interval] || 900000) - 1 });
    }
    tdState = 'ok';
    out.sort((x, y) => x.t - y.t);
    if (size >= 100) tdCache.set(key, { at: Date.now(), size, c: out.map(x => ({ ...x })) });
    return out;
  }
  // Kripto: Binance fiyatı Twelve Data'dan, hacim Crypto.com'dan (zaman damgasıyla eşleştirilir)
  async function cryptoTD(sym, size, onWait, prio) {
    const base = sym.replace(/USDT$/, '');
    const [c15, vol] = await Promise.all([tdSeries(`${base}/USD`, 'Binance', size, 0, onWait, false, prio), klines(sym, '15m').catch(() => [])]);
    const vm = new Map(vol.map(x => [x.t, x.v]));
    const vs = vol.map(x => x.v).filter(v => v > 0).sort((p, q) => p - q), med = vs.length ? vs[Math.floor(vs.length / 2)] : 1;
    let matched = 0;
    for (const x of c15) { if (vm.has(x.t)) { x.v = vm.get(x.t); matched++; } else x.v = med; }
    return { c15, matched };
  }
  const BIST30 = ['THYAO','GARAN','AKBNK','ISCTR','YKBNK','ASELS','BIMAS','KCHOL','SAHOL','EREGL','TUPRS','FROTO','TOASO','SISE','TCELL','TTKOM','PGSUS','KOZAL','SASA','HEKTS','ARCLK','PETKM','EKGYO','ENKAI','ALARK','GUBRF','KRDMD','MGROS','VESTL','ASTOR'];
  async function bistTD(sym, size, onWait, prio) {
    const c15 = await tdSeries(sym, 'BIST', size, 180, onWait, false, prio);
    for (const x of c15) if (!(x.v >= 0)) x.v = 0;
    return c15;
  }
  const isBist = sym => BIST30.includes(sym) || !/USDT$/.test(sym);

  const BASES = ['https://data-api.binance.vision', 'https://api.binance.com', 'https://api1.binance.com', 'https://api3.binance.com'];
  let baseIdx = 0;
  async function bget(path) {
    let lastErr;
    for (let k = 0; k < BASES.length; k++) {
      const b = BASES[(baseIdx + k) % BASES.length];
      try {
        const r = await fetch(b + path, { cache: 'no-store' });
        if (r.status === 429 || r.status === 418) { await sleep(3000); throw new Error('Binance hız sınırı'); }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        baseIdx = (baseIdx + k) % BASES.length; setConn(true);
        return await r.json();
      } catch (e) { lastErr = e; }
    }
    setConn(false, lastErr && lastErr.message);
    throw lastErr || new Error('Binance bağlantısı kurulamadı');
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const mapK = k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], ct: k[6] });
  async function klines(sym, tf, limit) {
    if (ART) {
      const p = await cdc('get_candlestick', { instrument_name: toCdc(sym), timeframe: tf });
      const d = (p && p.data) || [];
      return d.map(x => { const t = Date.parse(x.timestamp); return { t, o: +x.open, h: +x.high, l: +x.low, c: +x.close, v: +x.volume, ct: t + STEP[tf] - 1 }; }).sort((x, y) => x.t - y.t);
    }
    const raw = await bget(`/api/v3/klines?symbol=${sym}&interval=${tf === '1D' ? '1d' : tf}&limit=${limit}`);
    return raw.map(mapK);
  }
  const closed = arr => arr.filter(x => x.ct < Date.now());
  async function klinesRange(sym, tf, bars, onp) {
    let out = [], end = Date.now();
    while (out.length < bars) {
      const raw = await bget(`/api/v3/klines?symbol=${sym}&interval=${tf}&limit=1000&endTime=${end}`);
      if (!raw.length) break;
      out = raw.map(mapK).concat(out);
      end = raw[0][0] - 1;
      if (onp) onp(Math.min(1, out.length / bars));
      if (raw.length < 1000) break;
    }
    return closed(out.slice(-bars));
  }
  const STABLE = /^(U|USDC|FDUSD|TUSD|BUSD|DAI|USDP|EUR|AEUR|USD1|USDE|XUSD|BFUSD|EURI|PAXG|GBP|TRY|USDT|PYUSD|RLUSD|USDG|USDS|USDQ|USDD|USDF|USDX|FRAX|LUSD|GUSD|EURC|EURT|EURR|XAUT|USTC|UST|SUSD|CUSD|USDB|USD0|DEUSD|SRUSD|BUIDL|USYC)$/;
  async function universe(quote, max) {
    if (ART) {
      const p = await cdc('get_tickers', {});
      return ((p && p.data) || []).filter(t => /^[A-Z0-9]+_?USDT$/.test(t.instrument_name || '') && +t.volume_value > 0)
        .map(t => { const base = t.instrument_name.replace('_', '').slice(0, -4); return { sym: base + 'USDT', base, last: +t.last, chg: +t.change * 100, qv: +t.volume_value }; })
        .filter(t => !STABLE.test(t.base) && !/(UP|DOWN|BULL|BEAR)$/.test(t.base))
        .filter(t => t.qv >= (S.minVol || 0)).sort((x, y) => y.qv - x.qv).slice(0, max);
    }
    const [all, ei] = await Promise.all([bget('/api/v3/ticker/24hr'), bget('/api/v3/exchangeInfo?permissions=SPOT').catch(() => null)]);
    // Sadece işlem gören pariteler: Binance'ta kaldırılmış/askıya alınmış (BREAK) pariteler eski fiyatla sahte sinyal verir
    const live = ei && ei.symbols ? new Set(ei.symbols.filter(x => x.status === 'TRADING').map(x => x.symbol)) : null;
    return all.filter(t => t.symbol.endsWith(quote) && +t.quoteVolume > 0 && +t.count > 0 && (live ? live.has(t.symbol) : true) && (!t.closeTime || +t.closeTime > Date.now() - 2 * 864e5))
      .map(t => ({ sym: t.symbol, base: t.symbol.slice(0, -quote.length), last: +t.lastPrice, chg: +t.priceChangePercent, qv: +t.quoteVolume }))
      .filter(t => !STABLE.test(t.base) && !/(UP|DOWN|BULL|BEAR)$/.test(t.base) && t.qv >= (S.minVol || 0))
      .sort((a, b) => b.qv - a.qv).slice(0, max);
  }

  function setConn(ok, msg) {
    $('#connDot').className = 'dot ' + (ok ? 'on' : 'err');
    $('#connTxt').textContent = ok ? (ART ? 'Crypto.com + Twelve Data' : 'Binance bağlı') : ('Bağlantı yok' + (msg ? ` (${msg})` : ''));
  }

  // ---------------- Sekmeler ----------------
  function showTab(id) {
    $$('nav.tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === id));
    $$('main > section').forEach(s => s.hidden = s.id !== 'tab-' + id);
    store.set('tab', id);
    if (id === 'daily') renderDaily();
  }
  $$('nav.tabs button').forEach(b => b.onclick = () => showTab(b.dataset.tab));

  // ---------------- Ayarlar ----------------
  const S = Object.assign({ rr: 1.5, auto: 0, theme: '', short: false, notify: false, market: ART ? 'USDT' : 'TRY', universe: 9999, minVol: 0 }, store.get('settings', {}));
  if (!store.get('v2scan', false)) { S.universe = 9999; S.minVol = 0; store.set('v2scan', true); }   // yeni sürüm: tüm pariteler, hacim filtresi yok
  function applySettings() {
    $('#setRR').value = S.rr; $('#setAuto').value = S.auto; $('#setTheme').value = S.theme;
    $('#setShort').checked = S.short; $('#setNotify').checked = S.notify;
    $('#market').value = S.market; $('#universe').value = S.universe;
    if (![...$('#minVol').options].some(o => +o.value === S.minVol)) S.minVol = 0;
    $('#minVol').value = S.minVol;
    if (S.theme) document.documentElement.dataset.theme = S.theme; else delete document.documentElement.dataset.theme;
  }
  function saveSettings() {
    S.rr = +$('#setRR').value || 1.5; S.auto = +$('#setAuto').value; S.theme = $('#setTheme').value;
    S.short = $('#setShort').checked; S.market = $('#market').value; S.universe = +$('#universe').value; S.minVol = +$('#minVol').value;
    store.set('settings', S); applySettings(); scheduleAuto();
  }
  ['#setRR', '#setAuto', '#setTheme', '#setShort', '#market', '#universe', '#minVol'].forEach(s => $(s).addEventListener('change', saveSettings));
  $('#setNotify').addEventListener('change', async e => {
    if (e.target.checked && 'Notification' in window) {
      try { const p = await Notification.requestPermission(); S.notify = p === 'granted'; } catch { S.notify = false; }
      if (!S.notify) toast('Bildirim izni verilmedi.');
    } else S.notify = false;
    e.target.checked = S.notify; store.set('settings', S);
  });

  // ---------------- Tarama ----------------
  let results = store.get('results', []), lastScan = store.get('lastScan', 0), scanning = false, phaseFilter = 'all';
  const statusTone = { 'HAZIR': 'good', 'BEKLE': 'warn', 'KAÇIN': 'bad' };

  async function ensureAccess() {
    if (!ART) return true;
    $('#scanInfo').textContent = 'Crypto.com bağlantısı kontrol ediliyor…';
    const m = await mcpReady;
    if (!m) { showFix('Canlı veri bu görünümde açılamadı. Sayfayı claude.ai uygulamasında ya da claude.ai sitesinde açın.'); return false; }
    let perm = null; try { perm = await window.claude.use('permissions'); } catch {}
    if (!perm) return true;
    const name = 'mcp:' + (S.market === 'BIST' ? TD : CDC);
    let st = await perm.state(name).catch(() => 'unavailable');
    if (st === 'prompt') {
      $('#scanInfo').textContent = 'Crypto.com verisi için izin isteniyor. Açılan pencerede İzin ver\'e basın.';
      const r = await perm.request([name]).catch(() => ({}));
      st = r[name] || st;
    }
    if (st === 'denied') { showFix('Crypto.com verisine izin verilmedi. İzni açmak için aşağıdaki düğmeye basın.', perm); return false; }
    return true;
  }
  function showFix(msg, perm) {
    $('#scanInfo').innerHTML = esc(msg) + (perm ? ' <button class="btn ghost" id="permBtn" type="button" style="padding:4px 10px;margin-left:6px">İzinleri aç</button>' : '');
    const b = $('#permBtn'); if (b) b.onclick = () => perm.manage().then(() => toast('İzni açtıysanız taramayı yeniden başlatın.')).catch(() => toast('Sayfanın üstündeki menüden İzinler bölümünü açın.'));
  }
  let btcCtx = null;
  const fmtUsd = v => v >= 1e6 ? (v / 1e6).toLocaleString('tr-TR', { maximumFractionDigits: 1 }) + ' milyon $' : v >= 1e3 ? Math.round(v / 1e3) + ' bin $' : Math.round(v) + ' $';
  async function readBtc() {
    try {
      const [a, b, c] = await Promise.all([klines('BTCUSDT', '15m', 320), klines('BTCUSDT', '1h', 220), klines('BTCUSDT', '4h', 200)]);
      const an = PA.analyzeMTF(closed(a), closed(b), closed(c), { minRR: S.rr });
      const bias = an.plan.bias, h1 = an.h1.trend;
      return { bias, h1, label: `BTC 4s ${bias === 1 ? 'yukarı' : 'aşağı'}, 1s ${h1 === 1 ? 'yukarı' : h1 === -1 ? 'aşağı' : 'yatay'}` };
    } catch { return null; }
  }
  // ---------------- Trend Kırılımı (ana model) ----------------
  const T_STATUS = { 'AL': 'HAZIR', 'POZİSYONDA': 'AÇIK', 'KIRILIM YAKIN': 'BEKLE', 'BEKLE': 'BEKLE', 'UZAK DUR': 'KAÇIN' };
  const T_RANK = { 'AL': 400, 'POZİSYONDA': 300, 'KIRILIM YAKIN': 200, 'BEKLE': 100, 'UZAK DUR': 0 };
  const tdBase = sym => sym.replace(/USDT$/, '') + '/USD';
  const doneDays = d => d.filter(x => x.t + 864e5 <= Date.now());
  let btcD1Cache = null;
  async function getBtcD1() {
    if (btcD1Cache && Date.now() - btcD1Cache.at < 30 * 60e3) return btcD1Cache.d;
    let d = null;
    if (ART && tdState !== 'off') { try { d = await tdSeries('BTC/USD', 'Binance', 400, 0, null, false, true, '1day'); } catch {} }
    if (!d || d.length < 60) d = await klines('BTCUSDT', '1D', 400);
    d = doneDays(d); btcD1Cache = { at: Date.now(), d }; return d;
  }
  // Tam 1s geçmişi (seviye + geçmiş sinyaller + açık pozisyon için)
  async function trendHist(sym, size, onWait, prio) {
    if (ART) {
      if (isBist(sym)) return closed(await tdSeries(sym, 'BIST', size, 180, onWait, false, prio, '1h'));
      return closed(await tdSeries(tdBase(sym), 'Binance', size, 0, onWait, false, prio, '1h'));
    }
    return klinesRange(sym, '1h', size);
  }
  const trendOpts = (sym, btcD1, d1) => isBist(sym) ? { N: 180, d1 } : { btcD1, d1 };   // BIST: 20 işlem günü ≈ 180 saatlik mum, BTC rejimi yok
  function trendRow(u, tr, last, exact) {
    const dist = tr.level ? (tr.level / last - 1) * 100 : null;
    const openR = tr.open ? tr.open.R : null;
    return { sym: u.sym, base: u.base, quote: u.quote || S.market, market: u.market || (isBist(u.sym) ? 'BIST' : 'USDT'), last, chg: u.chg, qv: u.qv,
      decision: tr.decision, status: T_STATUS[tr.decision], why: tr.why, level: tr.level, entry: tr.decision === 'POZİSYONDA' ? tr.open.e : tr.entry, stop: tr.decision === 'POZİSYONDA' ? tr.open.stop : tr.stop,
      riskPct: tr.riskPct, dist, openR, btc: tr.btc, hist: tr.stats, td: !!exact, model: 'trend',
      quality: tr.quality || null, brk: tr.brk ?? null, atr: tr.atr || null, trailD: tr.atr ? tr.atr * PA.TREND.trail : null, sigT: tr.open ? tr.open.sigT : null, stop0: tr.open ? tr.open.stop0 : tr.stop,
      score: T_RANK[tr.decision] + (tr.decision === 'POZİSYONDA' ? Math.min(99, (openR || 0) * 10) : dist != null ? Math.max(0, 99 - dist * 10) : 0),
      phaseLabel: tr.why };
  }
  // BTC rejim fonksiyonu (motorlar için): t (mum kapanışı) → ±1
  function regFn(d1) {
    if (!d1 || d1.length < 30) return null;
    const m = PA.btcRegimeMap(d1, Math.min(PA.TREND.btcN, d1.length)), keys = [...m.keys()].sort((a, b) => a - b);
    return t => { const day = Math.floor(t / 864e5) * 864e5; if (m.has(day)) return m.get(day); let v = 0; for (const k of keys) { if (k <= day) v = m.get(k); else break; } return v; };
  }
  // Motor kurulumları + trend modeli → tek satır
  const MIN_RISK = 1.0;   // stop mesafesi %1'den küçükse (stablecoin / ölü parite) maliyet işlemi yer: işlem yok
  function buildRow(u, tr, eng, last, exact) {
    if (tr.atr && last && tr.atr / last * 100 * PA.TREND.atrStop < MIN_RISK) {
      const row = trendRow(u, tr, last, exact);
      Object.assign(row, { decision: 'UZAK DUR', status: 'KAÇIN', why: `Fiyat neredeyse hareketsiz (stop mesafesi %${(tr.atr / last * 100 * PA.TREND.atrStop).toFixed(2)}): stablecoin ya da ölü parite, işlem yok.`, entry: null, stop: null, score: 0, motor: null, src: 'trend' });
      return row;
    }
    const row = trendRow(u, tr, last, exact);
    const sigs = eng ? eng.signals : [];
    const L = sigs.find(x => x.side === 1), Sh = sigs.find(x => x.side === -1 && S.short);
    const openM = eng && eng.open ? eng.open.filter(t => t.side === 1 || S.short) : [];
    row.motor = null;
    if (L || Sh) {
      const g = L || Sh;
      row.quality = g.quality || null;
      row.motor = { side: g.side, setups: g.setups.map(x => ({ id: x.id, name: x.name, eng: x.eng })), entry: g.entry, stop: g.stop, riskPct: g.riskPct, trailPct: g.trailPct, strength: g.strength };
      row.decision = g.side === 1 ? 'AL' : 'SAT (short)'; row.status = 'HAZIR'; row.model = 'trend';
      row.entry = g.entry; row.stop = g.stop; row.stop0 = g.stop; row.riskPct = g.riskPct; row.trailD = g.trailPct / 100 * g.entry; row.sigT = g.t;
      row.why = (g.side === 1 ? 'Motor kurulumu: ' : 'Short kurulumu: ') + g.setups.map(x => x.name).join(' + ');
      row.score = 500 + g.strength * 10 + (g.side === 1 ? 5 : 0);
      row.src = 'motor';
    } else if (openM.length && row.decision !== 'POZİSYONDA' && row.decision !== 'AL') {
      const o = openM[openM.length - 1];
      row.decision = 'POZİSYONDA'; row.status = 'AÇIK'; row.entry = o.e; row.stop = o.stop; row.stop0 = o.stop0; row.openR = o.R; row.sigT = o.sigT; row.trailD = tr.atr ? ENG.EXIT.kt * tr.atr : null;
      row.why = `Motor kurulumu (${o.setups.join(', ')}) ${new Date(o.sigT + 36e5).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} sinyali; stop ${fp(o.stop)}.`;
      row.score = 300 + Math.min(99, (o.R || 0) * 10); row.src = 'motor';
    } else {
      row.src = 'trend';
      const bl = eng && eng.blocked ? eng.blocked.find(x => x.side === 1) : null;
      if (bl && row.decision !== 'POZİSYONDA' && row.decision !== 'AL') { row.decision = 'BEKLE'; row.status = 'BEKLE'; row.why = `Motor kurulumu (${bl.setups.map(x => x.name).join(' + ')}) çıktı ama alım yok: ${bl.reason}.`; row.score = Math.max(row.score || 0, 60); }
    }
    if (row.decision === 'AL' && row.src === 'trend') row.why = 'Trend kırılımı: ' + row.why;
    return row;
  }
  function rowOf(u, an, last, td) {
    const p = an.plan;
    return { sym: u.sym, base: u.base, quote: S.market, last, chg: u.chg, qv: u.qv, status: p.status, score: p.score, dir: p.dir,
      decision: p.decision, grade: p.grade, stageV: p.stages.map(s => s.verdict),
      phase: p.phase.key, phaseLabel: p.phase.label, tone: p.phase.tone, entry: p.entry, stop: p.stop, targets: p.targets, rr: p.rrPlan ?? p.rr,
      trigger: p.trigger, sparse: !!p.sparse, zone: p.zone ? p.zone.kind : null, inZone: !!p.inZone, futures: !!p.futures, relVol: an.m15.relVol, td: !!td };
  }
  // Tarama Crypto.com'un kısa geçmişiyle (yaklaşık seviye) yapılır; öne çıkanlar Binance 1s geçmişiyle (Twelve Data, 1000 mum) kesinleştirilir
  async function verifyTop(out, btcD1) {
    if (!ART || tdState === 'off') return 0;
    const pick = out.filter(r => r.decision !== 'UZAK DUR' || r.motor).sort((x, y) => y.score - x.score).slice(0, 10);
    let n = 0;
    for (const r of pick) {
      $('#scanInfo').textContent = `Öne çıkan ${pick.length} coin Binance 1s geçmişiyle kesinleştiriliyor (${n + 1}/${pick.length})…`;
      try {
        const h = await trendHist(r.sym, 1000, w => $('#scanInfo').textContent = `Doğrulama: Twelve Data dakika sınırı, ${w} sn bekleniyor…`);
        if (h.length < PA.TREND.N + 2) continue;
        const tr = PA.trend(h, trendOpts(r.sym, btcD1));
        const eng = ENG.scanNow(h, { btcReg: regFn(btcD1), btc7: ENG.btc7Fn(btcD1), longOnly: !S.short, history: true, from: h[Math.max(0, h.length - 24 * 30)].t });
        const k = out.indexOf(r); if (k >= 0) out[k] = buildRow(r, tr, eng, h[h.length - 1].c, true);
        n++;
      } catch (e) { if (/izin|bağlayıcı|connector/i.test(e.message)) { tdState = 'off'; break; } }
    }
    return n;
  }
  async function scan() {
    if (scanning) return;
    scanning = true; $('#scanBtn').disabled = true; $('#scanBtn').textContent = 'Taranıyor…';
    $('#prog').style.width = '3%';
    let ok = false;
    try { ok = await ensureAccess(); } catch (e) { $('#scanInfo').textContent = 'Bağlantı kurulamadı: ' + e.message; }
    if (!ok) { scanning = false; $('#scanBtn').disabled = false; $('#scanBtn').textContent = 'Taramayı başlat'; $('#prog').style.width = '0'; return; }
    $('#scanInfo').textContent = S.market === 'BIST' ? 'BIST hisseleri okunuyor…' : 'Coin listesi alınıyor…';
    const prev = new Set(results.filter(r => r.decision === 'AL' || r.decision === 'SAT (short)').map(r => r.sym));
    if (S.market === 'BIST') { try { await scanBist(prev); } finally { scanning = false; $('#scanBtn').disabled = false; $('#scanBtn').textContent = 'Taramayı yenile'; setTimeout(() => $('#prog').style.width = '0', 600); } return; }
    try {
      if (ART && S.market === 'TRY') {
        $('#scanInfo').textContent = 'USD/TRY kuru okunuyor…';
        let fx = 0;
        try { const t = tdText(await mcpCall(TD, 'get_time_series', { symbol: 'USD/TRY', interval: '1h', outputsize: 1 })); const ln = t.trim().split('\n').filter(l => /^\d/.test(l))[0]; fx = ln ? +ln.split(';')[4] : 0; } catch {}
        if (!(fx > 1)) fx = store.get('fx', 0);
        if (!(fx > 1)) throw new Error('USD/TRY kuru alınamadı (Twelve Data)');
        store.set('fx', fx); PA.setFx(fx);
      } else PA.setFx(1);
      const uni = await universe(S.market, S.universe);
      if (!uni.length) throw new Error('Coin listesi boş geldi');
      $('#scanInfo').textContent = `${uni.length} parite bulundu${S.minVol ? ` (günlük hacim ${fmtUsd(S.minVol)} üstü)` : ''}. Önce BTC rejimi okunuyor…`;
      const btcD1 = await getBtcD1(), btcReg = regFn(btcD1), btc7 = ENG.btc7Fn(btcD1);
      fillSymList(uni.map(u => u.sym));
      const out = []; let done = 0, fails = 0;
      const q = uni.slice();
      const worker = async () => {
        while (q.length) {
          const u = q.shift();
          try {
            const [b, d, f, dAge] = await Promise.all([klines(u.sym, '1h', 1000), ART ? klines(u.sym, '1D', 60) : Promise.resolve(null), ART ? klines(u.sym, '4h', 60) : Promise.resolve(null), ART ? Promise.resolve(null) : klines(u.sym, '1D', 400).catch(() => null)]);
            const c1h = closed(b); if (c1h.length < 30) { done++; continue; }
            const d1 = d ? doneDays(d) : null;
            const tr = PA.trend(c1h, trendOpts(u.sym, btcD1, d1));
            const eng = ENG.scanNow(c1h, { btcReg, btc7, c4: f ? closed(f) : null, d1, longOnly: !S.short, history: !ART });
            const row = buildRow(u, tr, eng, b[b.length - 1].c, !ART);
            if (dAge) { row.ageDays = dAge.length; if (row.ageDays < 365 && (row.decision === 'AL' || row.decision === 'SAT (short)')) { Object.assign(row, { decision: 'BEKLE', status: 'BEKLE', why: `Yeni coin (${row.ageDays} günlük): yeni listelenen coinlerde robot testte zarar etti, alım yok.`, score: 50, motor: null }); } }
            out.push(row);
          } catch { fails++; }
          done++;
          $('#prog').style.width = (done / uni.length * 100) + '%';
          $('#scanInfo').textContent = `${done}/${uni.length} grafik okundu${fails ? ` · ${fails} hata` : ''}`;
        }
      };
      await Promise.all(Array.from({ length: ART ? 3 : 6 }, worker));
      const nv = await verifyTop(out, btcD1);
      out.sort((x, y) => y.score - x.score);
      results = out; lastScan = Date.now();
      store.set('results', results); store.set('lastScan', lastScan);
      const reg = PA.btcRegimeMap(btcD1, Math.min(PA.TREND.btcN, btcD1.length)), lastReg = [...reg.values()].pop();
      $('#scanInfo').textContent = `${out.length} coin · ${out.filter(r => r.decision === 'AL').length} AL · ${out.filter(r => r.decision === 'POZİSYONDA').length} pozisyonda · ${out.filter(r => r.decision === 'KIRILIM YAKIN').length} kırılıma yakın · BTC rejimi ${lastReg === 1 ? 'olumlu' : 'zayıf (yeni alım yok)'}${ART && S.market === 'TRY' ? ` · fiyatlar TL (1 $ = ${PA.getFx().toFixed(2)} ₺)` : ''}${nv ? ` · ${nv} coin Binance 1s geçmişiyle kesinleşti` : ''}`;
      updateSigLog(out, lastScan);
      renderList();
      announce(out.filter(r => (r.decision === 'AL' || r.decision === 'SAT (short)') && !prev.has(r.sym)));
    } catch (e) {
      $('#scanInfo').textContent = 'Tarama yapılamadı: ' + e.message + '. İnternet bağlantınızı kontrol edip tekrar deneyin.';
    } finally {
      scanning = false; $('#scanBtn').disabled = false; $('#scanBtn').textContent = 'Taramayı yenile';
      setTimeout(() => $('#prog').style.width = '0', 600);
    }
  }
  $('#scanBtn').onclick = scan;
  const fmtTL = v => v >= 1e9 ? (v / 1e9).toLocaleString('tr-TR', { maximumFractionDigits: 1 }) + ' milyar ₺' : v >= 1e6 ? (v / 1e6).toLocaleString('tr-TR', { maximumFractionDigits: 1 }) + ' milyon ₺' : Math.round(v / 1e3) + ' bin ₺';
  function dayStats(c15) {
    // Günlük değişim ve günlük hacim (TR takvim günü)
    const day = t => new Date(t + 3 * 3600000).toISOString().slice(0, 10);
    const last = c15[c15.length - 1], dl = day(last.t);
    const today = c15.filter(x => day(x.t) === dl), prev = c15.filter(x => day(x.t) < dl);
    const pc = prev.length ? prev[prev.length - 1].c : today[0].o;
    return { chg: (last.c / pc - 1) * 100, qv: today.reduce((s, x) => s + x.v * x.c, 0) };
  }
  async function scanBist(prev) {
    const list = BIST30.slice(0, Math.min(S.universe, 30));
    const out = []; let done = 0, fails = 0, lastErr = '';
    for (const sym of list) {
      try {
        const h = await trendHist(sym, 1000, w => $('#scanInfo').textContent = `${done}/${list.length} hisse okundu · Twelve Data dakika sınırı: ${w} sn bekleniyor…`);
        if (h.length < 200) throw new Error('yetersiz veri');
        const ds = dayStats(h);
        const tr = PA.trend(h, trendOpts(sym));
        out.push(trendRow({ sym, base: sym, quote: 'BIST', market: 'BIST', chg: ds.chg, qv: ds.qv }, tr, h[h.length - 1].c, true));
      } catch (e) { fails++; lastErr = e.message; }
      done++;
      $('#prog').style.width = (done / list.length * 100) + '%';
      $('#scanInfo').textContent = `${done}/${list.length} hisse okundu${fails ? ` · ${fails} hata (${lastErr})` : ''}`;
      results = out.slice().sort((x, y) => y.score - x.score); renderList();   // sonuçlar geldikçe göster
    }
    out.sort((x, y) => y.score - x.score);
    results = out; lastScan = Date.now();
    store.set('results', results); store.set('lastScan', lastScan);
    let usage = '';
    try { const u = await mcpCall(TD, 'get_api_usage', {}); const t = tdText(u); const m = /;(\d+);(\d+)/.exec(t || ''); if (m) usage = ` · Twelve Data kota: ${m[1]}/${m[2]}`; } catch {}
    updateSigLog(out, lastScan);
    $('#scanInfo').textContent = `${out.length} hisse · ${out.filter(r => r.decision === 'AL').length} AL · ${out.filter(r => r.decision === 'POZİSYONDA').length} pozisyonda · ${out.filter(r => r.decision === 'KIRILIM YAKIN').length} kırılıma yakın${usage}`;
    renderList();
  }

  const PH_ORDER = ['all', 'AL', 'SAT (short)', 'POZİSYONDA', 'KIRILIM YAKIN', 'BEKLE', 'UZAK DUR'];
  const PH_LABEL = { all: 'Tümü', AL: 'AL (yeni sinyal)', 'SAT (short)': 'Short', 'POZİSYONDA': 'Pozisyonda', 'KIRILIM YAKIN': 'Kırılıma yakın', BEKLE: 'Bekle', 'UZAK DUR': 'Uzak dur' };
  const statusOf = r => r.model === 'trend' ? r.decision : (r.status === 'HAZIR' ? 'AL' : 'BEKLE');
  function renderChips() {
    const cnt = k => k === 'all' ? results.length : results.filter(r => statusOf(r) === k).length;
    $('#phaseChips').innerHTML = PH_ORDER.map(k => `<button class="chip" data-k="${k}" aria-pressed="${phaseFilter === k}">${PH_LABEL[k]}<span class="c">${cnt(k)}</span></button>`).join('');
    $$('#phaseChips .chip').forEach(b => b.onclick = () => { phaseFilter = b.dataset.k; renderList(); });
  }
  const T_TONE = { 'AL': 'good', 'SAT (short)': 'warn', 'POZİSYONDA': 'good', 'KIRILIM YAKIN': 'warn', 'BEKLE': 'neutral', 'UZAK DUR': 'bad' };
  // ANA COİNLER: piyasa değeri büyük, en az 1 yıllık geçmişi ve derin tahtası olan coinler. Backtest (303 TRY paritesi, gerçek spread,
  // 5 pozisyon / %1 risk portföy simülasyonu, 2025-10 → 2026-10): tüm paritelerde −%49…−%89; ana coinlerde sinyal başına +0.17R (PF 1.22),
  // portföy sonucu kurallara duyarlı (−%4…+%60). Trend modeli ana coinlerde +%18, en büyük düşüş %9.
  // 18 büyük coinde 2020-2026 testi de aynı yönde. Liste piyasa değerine göre seçildi, backtest sonucuna göre değil.
  const MAJORS = new Set(['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'ADA', 'DOGE', 'AVAX', 'LINK', 'DOT', 'LTC', 'TRX', 'NEAR', 'SUI', 'APT', 'ARB', 'OP', 'BCH', 'ATOM', 'FIL', 'UNI', 'AAVE', 'INJ', 'TIA', 'SEI', 'HBAR', 'ETC', 'PEPE', 'SHIB', 'WLD']);
  const isMajor = r => MAJORS.has(r.base) || isBist(r.sym || '');
  // SAT merdiveni: iz süren stopun basit hali. "Fiyat P'ye çıkarsa stopu S'ye çek." D = iz süren mesafe (fiyat birimi)
  function ladder(e, stop, D, last, short) {
    if (!(D > 0) || !(e > 0)) return [];
    const out = [], sg = short ? -1 : 1, base = short ? Math.min(last || e, e) : Math.max(last || e, e);
    for (let k = 0; k < 60 && out.length < 4; k++) {
      const P = e + sg * D * (1 + 0.5 * k), st = P - sg * D;
      if (sg * (P - base) <= base * 0.002 || sg * (st - stop) <= 0) continue;
      out.push({ P, st, lock: sg * (st / e - 1) * 100 });
    }
    return out;
  }
  const lockTxt = x => Math.abs(x.lock) < 0.5 ? 'Başabaş, zarar yok' : (x.lock > 0 ? '+%' : '−%') + Math.abs(x.lock).toFixed(0) + (x.lock > 0 ? ' kâr' : ' zarar');
  function ladderTable(L, short) {
    if (!L.length) return '';
    return `<div class="tblwrap" style="margin-top:6px"><table><thead><tr><th class="l">Fiyat buraya ${short ? 'inerse' : 'çıkarsa'}</th><th>Stopu buraya çek</th><th class="l">Stop olursa sonuç</th></tr></thead><tbody>${L.map(x => `<tr><td class="l up">${fp(x.P)}</td><td>${fp(x.st)}</td><td class="l ${x.lock >= 0 ? 'up' : 'dn'}">${lockTxt(x)}</td></tr>`).join('')}</tbody></table></div>`;
  }
  // AL bölgesi: sinyal fiyatının biraz altı – biraz üstü. Üstüne kaçtıysa kovalanmaz.
  function buyZone(e, atr, short) {
    const a = atr || e * 0.01;
    return short ? [e - 0.5 * a, e + 0.3 * a] : [e - 0.3 * a, e + 0.5 * a];
  }
  const ladderText = (L, short) => L.map(x => `${fp(x.P)} ${short ? 'inerse' : 'olursa'} stop ${fp(x.st)} (${lockTxt(x)})`).join(' · ');
  // ŞİMDİ AL: yeni sinyaller + riski makul olan devam eden trendler. Sabit hedef yok: SAT merdiveni (iz süren stop).
  function buyNow() {
    const out = [];
    for (const r of results) {
      if (r.last == null || r.stop == null) continue;
      const short = r.decision === 'SAT (short)';
      if (ART && !r.td) continue;   // kısa (50 mum) veriyle bulunan sinyal Binance 1s geçmişiyle doğrulanmadan önerilmez
      if (r.decision === 'AL' || short) {
        const e = r.last, R = Math.abs(e - r.stop); if (!R) continue;
        // Trend kırılımında alım bölgesi: kırılan 20 günlük zirve ile +0.5 ATR arası (geri test). Fiyat yukarı kaçtıysa limit emir.
        let zone = buyZone(e, r.atr, short), limit = false;
        if (r.src !== 'motor' && r.brk && r.atr && !short) { zone = [r.brk, Math.max(r.brk + 0.5 * r.atr, Math.min(e, r.brk + 0.5 * r.atr))]; limit = e > zone[1]; }
        const q = r.quality ? r.quality.q : 0;
        out.push({ r, q, kind: r.src === 'motor' ? 'Yeni sinyal · motor kurulumu' : (limit ? 'Yeni sinyal · trend kırılımı · fiyat kaçtı: bölgeye limit emir koy (48 saat)' : 'Yeni sinyal · trend kırılımı'), short, e, zone, stop: r.stop, risk: R / e * 100, L: ladder(e, r.stop, r.trailD, e, short), rank: 2000 + q * 1000 + r.score });
      }
      // Not: "robot zaten içeride" (geç giriş) önerisi kaldırıldı. 18 coin 2020-2026 testinde geç giriş +0.18R, taze sinyal +0.83R; TRY maliyetiyle ~0.
    }
    return out.sort((a, b) => b.rank - a.rank);
  }
  function renderBuyNow() {
    const box = $('#buyNow'); if (!box) return;
    if (!results.length) { box.innerHTML = alarmBar(); bindAlarm(); return; }
    const ALL0 = buyNow(), ALL = ALL0.filter(x => isMajor(x.r) && x.q >= 1), OTH = ALL0.filter(x => (!isMajor(x.r) || x.q < 1) && x.rank >= 2000), L = ALL.filter(x => x.rank >= 2000), LO = ALL.filter(x => x.rank < 2000);
    const card = x => `<div class="bn" data-sym="${esc(x.r.sym)}" style="cursor:pointer;border:1px solid var(--line);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:6px">
        <div><b style="font-size:1.05rem">${esc(x.r.base)}</b> <span class="pill ${x.short ? 'warn' : 'good'}">${x.short ? 'SHORT' : 'AL'}</span> <span class="pill ${x.q >= 2 ? 'good' : x.q === 1 ? 'neutral' : 'bad'}" title="Kırılım kalitesi: hacim ≥3x ve sıkışma sonrası kırılım">${x.q >= 2 ? 'A kalite' : x.q === 1 ? 'B kalite' : 'C kalite'}</span><br><span class="mute" style="font-size:.75rem">${esc(x.kind)}</span></div>
        <div class="num" style="font-size:.88rem"><span class="mute">AL bölgesi</span> <b>${fp(x.zone[0])} – ${fp(x.zone[1])}</b></div>
        <div class="num" style="font-size:.88rem"><span class="mute">STOP</span> <b class="dn">${fp(x.stop)}</b> <small class="mute">(${x.short ? '+' : '−'}%${x.risk.toFixed(1)})</small></div>
        <div style="font-size:.8rem"><span class="mute">SAT merdiveni (fiyat → yeni stop)</span><br>${x.L.length ? x.L.slice(0, 3).map(y => `<span class="num">${fp(y.P)} → <b>${fp(y.st)}</b></span> <span class="${y.lock >= -0.5 ? 'up' : 'dn'}">${lockTxt(y)}</span>`).join('<br>') : '<span class="mute">—</span>'}</div>
      </div>`;
    const grid = arr => `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px">${arr.map(card).join('')}</div>`;
    box.innerHTML = alarmBar() + `<div class="card" style="border-color:var(--good)">
      <div><h3 style="margin:0">Şimdi alınabilecekler · ana coinler <span class="pill ${L.length ? 'good' : 'neutral'}">${L.length}</span></h3>
      <div class="mute" style="font-size:.82rem">Kalite: A = kırılım mumunda hacim 20 günlük ortalamanın 3 katı + öncesinde sıkışma (testte en iyi), B = ikisinden biri. 1) AL bölgesinden al (fiyat bölgenin üstüne kaçtıysa kovalama). 2) STOP'u hemen koy. 3) SAT merdiveni: fiyat yazan seviyeye çıktıkça stopu yukarı çek; fiyat stopa inince sat. Sabit hedef yok: trend ne kadar giderse o kadar kazanırsın. İşlemlerin çoğu küçük zararla stop olur, para birkaç büyük kazanandan gelir.</div></div>
      ${L.length ? grid(L.slice(0, 20)) : '<p class="mute" style="margin:0">Şu an alım şartı tutan parite yok. Sinyaller saat başı mum kapanışında oluşur; alarmı açarsan robot her saat tarar ve haber verir.</p>'}
      ${OTH.length ? `<details style="margin-top:4px"><summary class="mute">Diğer sinyaller · önerilmez (${OTH.length})</summary><p class="note" style="font-size:.8rem;margin:6px 0;border-color:var(--warn)">Ya ana coin listesinde değil ya da C kalite kırılım (hacim teyidi ve sıkışma yok; TRY ana coinlerde −0.14R). Gerçek spread ve sınırlı pozisyonla yapılan portföy testinde (303 TRY paritesi, son 13 ay) tüm paritelerde işlem yapmak −%49 ile −%89 arası zarar ettirdi. Ana coinlerde sinyal başına sonuç artıda (+0.17R), ama portföy sonucu kurallara çok duyarlı (−%4 ile +%60 arası).</p>${grid(OTH.slice(0, 20))}</details>` : ''}
      ${LO.length ? `<details style="margin-top:4px"><summary class="mute">Devam eden trendler · geç giriş, isteğe bağlı (${LO.length})</summary><p class="mute" style="font-size:.8rem;margin:6px 0">Sinyal daha önce geldi, trend sürüyor. Yeni sinyaller kadar iyi değil; sadece yeni sinyal yoksa ve stop %2–8 arasındaysa düşünülür.</p>${grid(LO.slice(0, 20))}</details>` : ''}
    </div>` + historyCard();
    $$('#buyNow .bn, #buyNow .hrow').forEach(b => b.onclick = () => openDetail(b.dataset.sym));
    bindAlarm();
  }

  // ---------------- Sinyal defteri (son 30 gün) ----------------
  // Her taramada çıkan AL sinyalleri kaydedilir; sonraki taramalarda güncel fiyat ve iz süren stopla durumları izlenir.
  let sigLog = store.get('sigLog', []);
  function updateSigLog(rows, now) {
    const H = 36e5, keep = now - 35 * 864e5;
    sigLog = sigLog.filter(x => x.t >= keep);
    for (const r of rows) {
      const isNew = r.decision === 'AL' || r.decision === 'SAT (short)';
      if (!isNew && r.decision !== 'POZİSYONDA') continue;
      if (r.entry == null || r.stop == null) continue;
      const t = r.sigT ? r.sigT + H : (isNew ? Math.floor(now / H) * H : null);
      if (!t || t < now - 30 * 864e5) continue;
      const side = r.decision === 'SAT (short)' ? -1 : 1, e = isNew ? r.last : r.entry;
      if (sigLog.some(x => x.sym === r.sym && x.side === side && (Math.abs(x.t - t) <= 2 * H || (x.open && Math.abs(x.e / e - 1) < 0.01)))) continue;
      sigLog.push({ sym: r.sym, base: r.base, side, t, e, stop0: r.stop0 ?? r.stop, stop: r.stop, D: r.trailD || null, best: side === 1 ? Math.max(e, r.last) : Math.min(e, r.last), last: r.last, open: true, src: r.src || 'trend', seen: now });
    }
    for (const x of sigLog) {
      if (!x.open) continue;
      const r = rows.find(y => y.sym === x.sym); if (!r || r.last == null) continue;
      const px = r.last, sg = x.side;
      x.last = px; x.seen = now;
      x.best = sg === 1 ? Math.max(x.best, px) : Math.min(x.best, px);
      let st = x.D ? (sg === 1 ? Math.max(x.stop0, x.best - x.D) : Math.min(x.stop0, x.best + x.D)) : x.stop;
      const same = (r.decision === 'POZİSYONDA' || r.decision === 'AL' || r.decision === 'SAT (short)') && r.entry && Math.abs(r.entry / x.e - 1) < 0.01;
      if (same && r.stop != null) st = sg === 1 ? Math.max(st, r.stop) : Math.min(st, r.stop);
      x.stop = st;
      if (sg * (px - st) <= 0) { x.open = false; x.exit = st; x.exitT = now; }
    }
    store.set('sigLog', sigLog);
  }
  function historyCard() {
    const now = Date.now(), live = new Set(results.map(r => r.sym)), L = sigLog.filter(x => x.t >= now - 30 * 864e5 && (!live.size || live.has(x.sym))).sort((a, b) => b.t - a.t);
    if (!L.length) return '';
    const res = x => { const px = x.open ? x.last : x.exit; return x.side * (px / x.e - 1) * 100; };
    const closed = L.filter(x => !x.open), wins = L.filter(x => res(x) > 0).length;
    const avg = L.reduce((s, x) => s + res(x), 0) / L.length;
    return `<div class="card" style="margin-top:14px">
      <div><h3 style="margin:0">Son 30 günün sinyalleri <span class="pill neutral">${L.length}</span></h3>
      <div class="mute" style="font-size:.82rem">Robotun verdiği AL sinyalleri ve şu anki durumları. Kârda ${wins}/${L.length} · ortalama ${avg >= 0 ? '+' : '−'}%${Math.abs(avg).toFixed(1)} · ${closed.length} tanesi stop oldu. Durum her taramada güncellenir (çıkış fiyatı yaklaşık).</div></div>
      <div class="tblwrap"><table><thead><tr><th class="l">Coin</th><th class="l">Sinyal</th><th>Giriş</th><th class="hide-s">Stop / çıkış</th><th class="hide-s">Şimdi</th><th>Sonuç</th><th class="l">Durum</th></tr></thead><tbody>
      ${L.slice(0, 40).map(x => { const v = res(x); return `<tr class="hrow" data-sym="${esc(x.sym)}" style="cursor:pointer"><td class="t l"><b>${esc(x.base)}</b>${x.side === -1 ? ' <span class="pill warn">SHORT</span>' : ''}</td><td class="l">${dt(x.t)}</td><td>${fp(x.e)}</td><td class="dn hide-s">${fp(x.open ? x.stop : x.exit)}</td><td class="hide-s">${fp(x.open ? x.last : x.exit)}</td><td class="${v >= 0 ? 'up' : 'dn'}"><b>${v >= 0 ? '+' : '−'}%${Math.abs(v).toFixed(1)}</b></td><td class="t l">${x.open ? '<span class="pill good">Açık</span>' : '<span class="pill bad">Stop oldu</span>'}</td></tr>`; }).join('')}
      </tbody></table></div></div>`;
  }

  // ---------------- Yeni sinyal alarmı ----------------
  function alarmBar() {
    const on = S.auto > 0;
    return `<div class="card" style="margin-bottom:14px;flex-direction:row;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
      <div><b>Yeni sinyal alarmı: ${on ? '<span class="up">AÇIK</span>' : '<span class="mute">KAPALI</span>'}</b><div class="mute" style="font-size:.8rem">${on ? `Robot ${S.auto === 15 ? 'her 15 dakikada' : 'her saat başı'} tarar; yeni AL çıkınca ses${S.notify ? ' ve bildirim' : ''} ile haber verir. Uygulama açık kalmalı (telefonda ekran kilitlenirse tarama durur).` : 'Açarsan robot her saat başı otomatik tarar ve yeni AL sinyalinde haber verir.'}</div></div>
      <button class="btn ${on ? 'ghost' : ''}" id="alarmBtn" type="button" style="width:auto">${on ? 'Alarmı kapat' : 'Alarmı aç'}</button></div>`;
  }
  function bindAlarm() {
    const b = $('#alarmBtn'); if (!b) return;
    b.onclick = async () => {
      if (S.auto > 0) { S.auto = 0; }
      else {
        S.auto = 60; beep();
        if ('Notification' in window && Notification.permission !== 'denied') { try { S.notify = (await Notification.requestPermission()) === 'granted'; } catch { S.notify = false; } }
        toast('Alarm açık: robot her saat başı tarayacak.');
      }
      store.set('settings', S); applySettings(); scheduleAuto(); renderBuyNow();
    };
  }
  let audioCtx;
  function beep() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.25, 0.5].forEach(d => { const o = audioCtx.createOscillator(), g = audioCtx.createGain(); o.frequency.value = 880; g.gain.setValueAtTime(0.2, audioCtx.currentTime + d); g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + d + 0.2); o.connect(g); g.connect(audioCtx.destination); o.start(audioCtx.currentTime + d); o.stop(audioCtx.currentTime + d + 0.21); });
    } catch {}
  }
  let titleBlink;
  function announce(fresh) {
    if (!fresh.length) return;
    const body = fresh.slice(0, 5).map(r => `${r.base} ${r.decision === 'SAT (short)' ? 'SHORT' : 'AL'} ${fp(r.last)} · Stop ${fp(r.stop)}`).join('\n');
    if (S.auto > 0) beep();
    toast('Yeni sinyal: ' + fresh.slice(0, 3).map(r => r.base).join(', '));
    if (S.notify && 'Notification' in window && Notification.permission === 'granted') {
      (async () => { try { const reg = await navigator.serviceWorker?.getRegistration(); reg ? reg.showNotification('Ayaz PA · yeni AL sinyali', { body, icon: 'icon-192.png' }) : new Notification('Ayaz PA · yeni AL sinyali', { body }); } catch {} })();
    }
    clearInterval(titleBlink); const t0 = document.title; let k = 0;
    titleBlink = setInterval(() => { document.title = k++ % 2 ? t0 : '🔔 Yeni AL sinyali'; if (k > 20 || !document.hidden && k > 6) { clearInterval(titleBlink); document.title = t0; } }, 1000);
  }
  function renderList() {
    renderBuyNow();
    if (!PH_ORDER.includes(phaseFilter)) phaseFilter = 'all';
    renderChips();
    $('#scanTime').textContent = lastScan ? 'Son tarama ' + new Date(lastScan).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) : '';
    const rows = results.filter(r => phaseFilter === 'all' || statusOf(r) === phaseFilter);
    if (!rows.length) { $('#list').innerHTML = `<div class="empty">${results.length ? 'Bu filtrede sembol yok.' : 'Taramayı başlatın. İlk tarama 100 coin için yaklaşık 30 saniye sürer.'}</div>`; return; }
    $('#list').innerHTML = rows.map(r => {
      const dec = r.decision || r.status;
      const op = dec === 'POZİSYONDA' && r.entry ? (r.last / r.entry - 1) * 100 : null;
      const right = op != null ? `<b class="${op >= 0 ? 'up' : 'dn'}">${op >= 0 ? '+' : '−'}%${Math.abs(op).toFixed(1)}</b><span class="mute" style="font-size:.75rem">${op >= 0 ? 'kârda' : 'zararda'}</span>`
        : r.dist != null ? `<b>${r.dist <= 0 ? 'kırıldı' : '%' + r.dist.toFixed(1)}</b><span class="mute" style="font-size:.75rem">zirveye uzak</span>` : '<b>—</b>';
      return `<button class="row" data-sym="${esc(r.sym)}">
        <div><div class="sym">${esc(r.base)}<small>/${esc(r.quote)}</small></div>
          <div class="sub"><span class="num" data-px="${esc(r.sym)}">${fp(r.last)}</span><span class="num ${r.chg >= 0 ? 'up' : 'dn'}" data-chg="${esc(r.sym)}">${r.chg >= 0 ? '+' : ''}${(r.chg || 0).toFixed(2)}%</span><span>Hacim ${r.market === 'BIST' || (!ART && r.quote === 'TRY') ? fmtTL(r.qv || 0) : fmtUsd(r.qv || 0)}</span></div></div>
        <div style="display:flex;flex-direction:column;gap:4px;min-width:0">
          <span><span class="pill ${T_TONE[dec] || statusTone[r.status] || 'neutral'}">${esc(dec)}</span>${r.td ? ' <span class="pill neutral" title="Binance 1 saatlik geçmişiyle kesinleşti">Binance ✓</span>' : ''}</span>
          <span class="sub" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.why || r.phaseLabel || '')}</span></div>
        <div class="hide-m sub">${r.entry != null ? `<span>${dec === 'POZİSYONDA' ? 'Giriş' : 'Tetik'} <span class="num">${fp(r.entry)}</span></span><span>Stop <span class="num">${fp(r.stop)}</span></span>` : '—'}</div>
        <div class="hide-m sub">${r.riskPct != null && dec !== 'POZİSYONDA' ? `Risk %${r.riskPct.toFixed(1)}` : ''}</div>
        <div class="score" style="display:flex;flex-direction:column;align-items:flex-end">${right}</div>
      </button>`;
    }).join('');
    $$('#list .row').forEach(b => b.onclick = () => openDetail(b.dataset.sym));
  }

  // Canlı fiyatlar (tüm semboller, tek WebSocket)
  let tickWS;
  function liveTickers() {
    if (ART) {
      setInterval(async () => {
        if (document.hidden || scanning || !results.length) return;
        try {
          const p = await cdc('get_tickers', {});
          for (const t of (p && p.data) || []) {
            if (!/^[A-Z0-9]+_?USDT$/.test(t.instrument_name || '')) continue;
            const s = t.instrument_name.replace('_', ''), el = document.querySelector(`[data-px="${s}"]`);
            if (el) { el.textContent = fp(+t.last); const ch = +t.change * 100, ce = document.querySelector(`[data-chg="${s}"]`); if (ce) { ce.textContent = (ch >= 0 ? '+' : '') + ch.toFixed(2) + '%'; ce.className = 'num ' + (ch >= 0 ? 'up' : 'dn'); } }
          }
        } catch {}
      }, 60000);
      return;
    }
    try {
      tickWS = new WebSocket('wss://stream.binance.com:9443/ws/!miniTicker@arr');
      tickWS.onmessage = ev => {
        const arr = JSON.parse(ev.data);
        for (const t of arr) {
          const el = document.querySelector(`[data-px="${t.s}"]`);
          if (el) {
            el.textContent = fp(+t.c);
            const ch = (+t.c / +t.o - 1) * 100, ce = document.querySelector(`[data-chg="${t.s}"]`);
            if (ce) { ce.textContent = (ch >= 0 ? '+' : '') + ch.toFixed(2) + '%'; ce.className = 'num ' + (ch >= 0 ? 'up' : 'dn'); }
          }
          if (detail && detail.sym === t.s) updateDetailPrice(+t.c, (+t.c / +t.o - 1) * 100);
        }
      };
      tickWS.onopen = () => setConn(true);
      tickWS.onclose = () => setTimeout(liveTickers, 5000);
    } catch {}
  }

  // Otomatik tarama
  let autoTimer;
  function scheduleAuto() {
    clearTimeout(autoTimer);
    if (!S.auto) return;
    const step = S.auto * 60000, now = Date.now(), next = Math.ceil(now / step) * step + 8000;
    autoTimer = setTimeout(async () => { await scan(); scheduleAuto(); }, next - now);
  }

  // ---------------- Detay & grafik ----------------
  let detail = null, kws = null;
  async function openDetail(sym) {
    const r = results.find(x => x.sym === sym) || { sym, base: sym.replace(/(USDT|TRY)$/, ''), quote: isBist(sym) ? 'BIST' : 'USDT', market: isBist(sym) ? 'BIST' : 'USDT' };
    detail = { sym, r, tf: '15m', c15: null, c1h: null, c4h: null, src: 'cdc' };
    $('#sheet').hidden = false; document.body.style.overflow = 'hidden';
    $('#dSym').innerHTML = `${esc(r.base)}<small>/${esc(r.quote)}</small>`;
    $('#dSub').textContent = 'Grafik okunuyor…'; $('#dPlan').innerHTML = '';
    $$('#tfSeg button').forEach(b => b.setAttribute('aria-pressed', b.dataset.tf === '15m'));
    loadTrend(sym).then(x => { if (detail && detail.sym === sym) { detail.tr = x; recompute(); } }).catch(e => { if (detail && detail.sym === sym) { detail.trErr = e.message; recompute(); } });
    try {
      if (ART && r.market === 'BIST') {
        $('#dSub').textContent = 'Twelve Data\'dan BIST verisi okunuyor…';
        const c15 = await bistTD(sym, 1200, w => $('#dSub').textContent = `Twelve Data dakika sınırı: ${w} sn bekleniyor…`, true);
        if (!detail || detail.sym !== sym) return;
        const cc = closed(c15);
        Object.assign(detail, { c15, c1h: aggregateByTime(c15, 3600000), c4h: aggregateByTime(c15, 14400000), src: 'td-bist' });
        detail.r.chg = dayStats(cc).chg;
        recompute(); openKlineWS(sym); return;
      }
      if (!btcCtx && sym !== 'BTCUSDT') btcCtx = await readBtc();
      if (ART && tdState !== 'off') {
        try {
          $('#dSub').textContent = 'Binance fiyatı (Twelve Data) okunuyor…';
          const { c15, matched } = await cryptoTD(sym, 2000, w => $('#dSub').textContent = `Twelve Data dakika sınırı: ${w} sn bekleniyor…`, true);
          if (c15.length < 300) throw new Error('kısa veri');
          if (!detail || detail.sym !== sym) return;
          Object.assign(detail, { c15, c1h: aggregateByTime(c15, 3600000), c4h: aggregateByTime(c15, 14400000), src: 'td', matched });
          recompute(); openKlineWS(sym); return;
        } catch (e) { detail.tdErr = /symbol|figi|invalid/i.test(e.message) ? 'bu coin Twelve Data\'da yok' : e.message; }
      }
      const [a, b, c] = await Promise.all([klines(sym, '15m', 320), klines(sym, '1h', 220), klines(sym, '4h', 200)]);
      if (a.length < 30 || b.length < 30 || c.length < 30) throw new Error('Bu sembol için yeterli mum yok');
      if (!detail || detail.sym !== sym) return;
      detail.c15 = a; detail.c1h = b; detail.c4h = c; detail.src = 'cdc';
      recompute(); openKlineWS(sym);
    } catch (e) { $('#dSub').textContent = 'Veri alınamadı: ' + e.message; }
  }
  async function loadTrend(sym) {
    const btcD1 = isBist(sym) ? null : await getBtcD1().catch(() => null);
    try {
      const h = await trendHist(sym, 1000, w => { if ($('#trWait')) $('#trWait').textContent = `Twelve Data dakika sınırı: ${w} sn bekleniyor…`; }, true);
      const need = isBist(sym) ? 200 : PA.TREND.N + 2;
      if (h.length >= need) return { tr: PA.trend(h, trendOpts(sym, btcD1)), eng: ENG.scanNow(h, { btcReg: isBist(sym) ? null : regFn(btcD1), btc7: isBist(sym) ? null : ENG.btc7Fn(btcD1), filter: isBist(sym) ? false : undefined, longOnly: !S.short, history: true }), exact: true, bars: h.length };
    } catch {}
    const [b, dd, f] = await Promise.all([klines(sym, '1h', 1000), klines(sym, '1D', 60), ART ? klines(sym, '4h', 60) : Promise.resolve(null)]);
    const h = closed(b), d1 = doneDays(dd);
    return { tr: PA.trend(h, trendOpts(sym, btcD1, d1)), eng: ENG.scanNow(h, { btcReg: regFn(btcD1), btc7: ENG.btc7Fn(btcD1), c4: f ? closed(f) : null, d1, longOnly: !S.short, history: h.length > 200 }), exact: h.length >= PA.TREND.N + 2, bars: h.length };
  }
  const deadCoin = d => d.tr && d.tr.tr && d.tr.tr.atr && d.tr.tr.riskPct != null && d.tr.tr.riskPct < MIN_RISK;
  function motorCard(d) {
    if (!d.tr || !d.tr.eng) return '';
    if (deadCoin(d)) return `<div class="summary"><div class="stage-h"><h3>Robot kararı</h3><span class="pill bad">UZAK DUR</span></div><p class="headline">Bu paritenin fiyatı neredeyse hiç hareket etmiyor (stop mesafesi %${d.tr.tr.riskPct.toFixed(2)}). Stablecoin ya da ölü parite: komisyon kârı yer, robot işlem önermez.</p></div>`;
    const E = d.tr.eng, lv = (k, v, cls = '') => `<div class="lv"><span class="lbl">${k}</span><span class="v ${cls}">${v}</span></div>`;
    const sig = E.signals.find(x => x.side === 1) || E.signals.find(x => x.side === -1);
    const engList = (r, title) => r ? `<div><b style="font-size:.85rem">${title}</b><ul class="reasons" style="margin-top:4px">${ENG.engineState(r).map(x => `<li class="${x.on ? 'p' : ''}" style="${x.on ? '' : 'opacity:.55'}">${x.on ? '✓' : '·'} ${esc(x.name)}</li>`).join('')}</ul></div>` : '';
    const hist = (E.history || []).slice(-6).reverse();
    const pc = (a, b) => ((a / b - 1) * 100).toFixed(2) + '%';
    return `<div class="summary">
      <div class="stage-h"><h3>Motor kurulumları</h3><span class="pill ${sig ? 'good' : E.blocked && E.blocked.length ? 'warn' : 'neutral'}">${sig ? (sig.side === 1 ? 'AL' : 'SAT (short)') : E.blocked && E.blocked.length ? 'BEKLE' : 'Kurulum yok'}</span></div>
      ${sig ? `<p class="headline">${sig.setups.map(x => esc(x.name)).join(' + ')}</p>
        <p class="mute" style="margin:0;font-size:.85rem">Çalışan motorlar: ${sig.setups.flatMap(x => x.eng).filter((v, i, a) => a.indexOf(v) === i).map(k => esc(ENG.EN[k])).join(' · ')}</p>
        <div class="levels">${lv('Giriş (şimdi)', fp(sig.entry))}${lv('STOP', fp(sig.stop) + ` <small class="mute">${sig.side === 1 ? '−' : '+'}${sig.riskPct.toFixed(2)}%</small>`, 'dn')}${lv('AL bölgesi', (z => fp(z[0]) + ' – ' + fp(z[1]))(buyZone(sig.entry, sig.trailPct / 100 * sig.entry / ENG.EXIT.kt, sig.side === -1)))}</div>
        <div><b style="font-size:.9rem">SAT merdiveni</b> <span class="mute" style="font-size:.8rem">· sabit hedef yok; fiyat ${sig.side === 1 ? 'yükseldikçe' : 'düştükçe'} stopu çek, stopa gelince sat</span>${ladderTable(ladder(sig.entry, sig.stop, sig.trailPct / 100 * sig.entry, sig.entry, sig.side === -1), sig.side === -1)}</div>`
        : (E.blocked && E.blocked.length ? `<p class="headline">${E.blocked[0].setups.map(x => esc(x.name)).join(' + ')}</p><p class="note" style="margin:0;border-color:var(--warn)"><b>Alım yok:</b> ${esc(E.blocked[0].reason)}. Testlerde bu durumdaki sinyaller ortalamada zarar ettirdi.</p>` : '<p class="mute" style="margin:0">Son kapanan 1s mumda hiçbir kurulumun bütün motorları aynı anda çalışmadı.</p>')}
      <details><summary class="mute">Motorların şu anki durumu</summary><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin-top:8px">${engList(E.rowsL, 'Yükseliş (long) tarafı')}${S.short ? engList(E.rowsS, 'Düşüş (short) tarafı') : ''}</div></details>
      ${hist.length ? `<details><summary class="mute">Bu coindeki son motor sinyalleri</summary><div class="tblwrap" style="margin-top:8px"><table><thead><tr><th class="l">Sinyal</th><th class="l">Kurulum</th><th>Giriş</th><th>Çıkış / şimdi</th><th>%</th><th>R</th></tr></thead><tbody>${hist.map(t => `<tr><td class="l">${dt(t.sigT + 36e5)}</td><td class="t l">${t.side === 1 ? '' : 'Short · '}${esc(t.setups.join(', '))}</td><td>${fp(t.e)}</td><td>${fp(t.exitPx)}</td><td class="${t.R >= 0 ? 'up' : 'dn'}">${t.side === 1 ? pc(t.exitPx, t.e) : pc(t.e, t.exitPx)}</td><td class="${t.R >= 0 ? 'up' : 'dn'}">${t.R.toFixed(2)}${t.open ? ' (açık)' : ''}</td></tr>`).join('')}</tbody></table></div></details>` : ''}
    </div>`;
  }
  function trendCard(d) {
    if (deadCoin(d)) return '';
    if (!d.tr) return `<div class="summary"><div class="stage-h"><h3>Robot kararı · Trend Kırılımı</h3></div><p class="mute" id="trWait" style="margin:0">${d.trErr ? 'Trend verisi alınamadı: ' + esc(d.trErr) : 'Binance 1 saatlik geçmişi okunuyor…'}</p></div>`;
    const { tr, exact } = d.tr, lv = (k, v, cls = '') => `<div class="lv"><span class="lbl">${k}</span><span class="v ${cls}">${v}</span></div>`;
    const pc = (a, b) => ((a / b - 1) * 100).toFixed(2) + '%';
    const last = d.c15 ? d.c15[d.c15.length - 1].c : (tr.open ? tr.open.exitPx : tr.entry);
    let levels = '';
    if (tr.decision === 'AL') levels = lv('Giriş (şimdi)', fp(tr.entry)) + lv('AL bölgesi', (z => fp(z[0]) + ' – ' + fp(z[1]))(buyZone(tr.entry, tr.atr))) + lv('STOP', fp(tr.stop) + ` <small class="mute">−${tr.riskPct.toFixed(2)}%</small>`, 'dn');
    else if (tr.decision === 'POZİSYONDA') { const o = tr.open; levels = lv('Giriş', fp(o.e)) + lv('Şu anki STOP', fp(o.stop) + ` <small class="mute">${pc(o.stop, last)}</small>`, 'dn') + lv('Açık kâr/zarar', `${pc(last, o.e)} · ${o.R >= 0 ? '+' : ''}${o.R.toFixed(2)}R`, o.R >= 0 ? 'up' : 'dn') + (() => { const lr = (last - o.stop) / last * 100, r0 = (o.e - o.stop0) / o.e * 100; return lr > Math.max(8, 1.5 * r0) ? lv('Yeni giriş', `Önerilmez: sinyal kaçtı (stop %${lr.toFixed(1)} uzakta). Yeni sinyal bekle.`, 'dn') : lv('Yeni giriş', 'Önerilmez: geç giriş testte zayıf (taze sinyal +0.83R, geç giriş +0.18R). Yeni sinyal bekle.', 'dn'); })(); }
    else if (tr.level != null) levels = lv('Tetik', `1s kapanış ${fp(tr.level)} üstünde`) + lv('Tetiklenirse stop', fp(tr.stop) + ` <small class="mute">−${tr.riskPct.toFixed(2)}%</small>`, 'dn') + lv('Zirveye uzaklık', pc(tr.level, last));
    let lad = tr.decision === 'AL' ? ladder(tr.entry, tr.stop, tr.trailAtr * tr.atr, tr.entry) : tr.decision === 'POZİSYONDA' && tr.open ? ladder(tr.open.e, tr.open.stop, tr.trailAtr * tr.atr, last) : [];
    const hist = tr.trades.slice(-6).reverse();
    const histHtml = hist.length ? `<div class="tblwrap"><table><thead><tr><th class="l">Sinyal</th><th>Giriş</th><th>Çıkış / şimdi</th><th>%</th><th>R</th><th class="l">Durum</th></tr></thead><tbody>${hist.map(t => `<tr><td class="l">${dt(t.sigT + 36e5)}</td><td>${fp(t.e)}</td><td>${fp(t.exitPx)}</td><td class="${t.R >= 0 ? 'up' : 'dn'}">${pc(t.exitPx, t.e)}</td><td class="${t.R >= 0 ? 'up' : 'dn'}">${t.R.toFixed(2)}</td><td class="t l">${t.open ? 'Açık' : esc(t.reason)}</td></tr>`).join('')}</tbody></table></div>` : `<p class="mute" style="margin:0">${exact ? 'Son ' + Math.round(d.tr.bars / 24) + ' günde sinyal yok.' : 'Geçmiş sinyaller için Binance 1s geçmişi gerekli.'}</p>`;
    return `<div class="summary">
      <div class="stage-h"><h3>Robot kararı · Trend Kırılımı</h3><span class="pill ${T_TONE[tr.decision]}">${esc(tr.decision)}</span>${exact ? '<span class="pill neutral">Binance 1s ✓</span>' : '<span class="pill neutral">tahmini</span>'}</div>
      <p class="headline">${esc(tr.why)}</p>
      ${levels ? `<div class="levels">${levels}</div>` : ''}
      ${lad.length ? `<div><b style="font-size:.9rem">SAT merdiveni</b> <span class="mute" style="font-size:.8rem">· sabit hedef yok; fiyat yükseldikçe stopu çek, stopa gelince sat</span>${ladderTable(lad)}</div>` : ''}
      ${tr.btc != null ? `<p class="mute" style="margin:0;font-size:.85rem">BTC rejimi: ${tr.btc === 1 ? 'olumlu (günlük kapanış 50 günlük ortalamanın üstünde)' : 'zayıf: yeni alım yapılmaz'}.</p>` : (isBist(d.sym) ? '<p class="mute" style="margin:0;font-size:.85rem">BIST: model kripto verisinde test edildi, hisselerde doğrulanmadı.</p>' : '')}
      <details><summary class="mute">Son sinyaller (${exact ? 'Binance 1s geçmişi' : 'veri yok'})</summary><div style="margin-top:8px">${histHtml}</div></details>
      <p class="note" style="margin:0">Kural: 1s kapanış 20 günlük zirvenin üstünde + BTC rejimi olumlu → AL. Stop giriş − 4 ATR; çıkış SAT merdiveni (iz süren stop: en yüksek − 12 ATR). 18 coinde 2024–Eyl 2026 gerçek Binance verisinde test edildi: kazanma ~%30, ortalama +0.5R/işlem; kayıp serileri uzun olabilir (17'ye kadar). Aynı anda en fazla 5 pozisyon, işlem başı %0.5–1 risk önerilir.</p>
    </div>`;
  }
  function recompute() {
    const d = detail; if (!d) return;
    if (!d.c15) { if (d.tr || d.trErr) $('#dPlan').innerHTML = motorCard(d) + trendCard(d); return; }
    const bist = d.src === 'td-bist';
    const an = PA.analyzeMTF(closed(d.c15), closed(d.c1h), closed(d.c4h), { minRR: S.rr, allowShort: bist ? false : S.short, btc: bist ? null : btcCtx, symbol: d.sym, noVolume: d.src === 'td' });
    d.an = an;
    const last = d.c15[d.c15.length - 1].c;
    updateDetailPrice(last, d.r.chg);
    const p = an.plan;
    const ms = d.tr && d.tr.eng && !deadCoin(d) ? (d.tr.eng.signals.find(x => x.side === 1) || d.tr.eng.signals.find(x => x.side === -1)) : null;
    $('#dSub').innerHTML = !d.tr ? '<span class="mute">Karar okunuyor…</span>' : deadCoin(d) ? '<span class="pill bad">UZAK DUR</span><span class="mute">hareketsiz parite</span>' : ms ? `<span class="pill good">${ms.side === 1 ? 'AL' : 'SAT (short)'}</span><span class="mute">Motor kurulumu</span>` : `<span class="pill ${T_TONE[d.tr.tr.decision]}">${esc(d.tr.tr.decision)}</span><span class="mute">Trend Kırılımı</span>`;
    const stageHtml = p.stages.map((s, k) => `<div class="stage">
        <div class="stage-h"><span class="stage-n">${k + 1}</span><h3>${esc(s.name)}</h3><span class="pill ${s.tone}">${esc(s.verdict)}</span>${s.max < 100 ? `<span class="num mute stage-s">${s.score}/${s.max}</span>` : ''}</div>
        <ul class="reasons">${s.items.map(x => `<li class="${x.s > 0 ? 'p' : x.s < 0 ? 'n' : ''}">${esc(x.t)}</li>`).join('')}</ul></div>`).join('');
    const lv = (k, v, cls = '') => `<div class="lv"><span class="lbl">${k}</span><span class="v ${cls}">${v}</span></div>`;
    const pct = x => p.entry ? ` <small class="mute">${((x / p.entry - 1) * 100).toFixed(2)}%</small>` : '';
    const sm = p.summary;
    const sumHtml = sm ? `<div class="summary">
        <div class="stage-h"><h3>Robotun yorumu</h3><span class="pill ${statusTone[p.status]}">${esc(p.decision)}</span><span class="pill neutral">Not ${esc(p.grade)}</span></div>
        <p class="headline">${esc(sm.headline)}</p>
        <ul class="reasons">${sm.points.map(t => `<li>${esc(t)}</li>`).join('')}</ul>
        ${sm.scenarios.map(sc => `<div class="scen"><b>${esc(sc.t)}</b><ol>${sc.steps.map(t => `<li>${esc(t)}</li>`).join('')}</ol></div>`).join('')}
        <div class="scen"><b>Plan nerede bozulur?</b><ul class="reasons">${sm.invalidation.map(t => `<li class="n">${esc(t)}</li>`).join('')}</ul></div>
        ${sm.notes.length ? `<p class="note" style="margin:0">${sm.notes.map(esc).join(' ')}</p>` : ''}
      </div>` : '';
    $('#dPlan').innerHTML = `
      ${motorCard(d)}
      ${trendCard(d)}
      <details class="stages-wrap pa-wrap"><summary><b>Price action analizi</b> <span class="mute">(bilgi amaçlı · gerçek veri testinde kârlı çıkmadı, karar vermez)</span></summary><div style="display:flex;flex-direction:column;gap:14px;margin-top:12px">
      ${sumHtml}
      <details class="stages-wrap"><summary class="mute">4 aşamalı analiz (ayrıntı)</summary><div class="stages" style="margin-top:10px">${stageHtml}</div></details>
      <h3>PA seviyeleri</h3>
      ${p.blocked && p.blocker ? `<p class="note" style="margin:0;border-color:var(--warn)"><b>Şu an işlem yok.</b> Önünde ${esc(p.blocker.kind)} ${fp(p.blocker.bot)} – ${fp(p.blocker.top)} var. Aşağıdaki seviyeler bölge kırılmadan kullanılmamalı.</p>` : ''}
      ${p.blocked && p.blocker && !p.breakout && p.decision !== 'UZAK DUR' ? `<p class="note" style="margin:0">Kırılım senaryosu yok: bölge kırılsa bile ${p.dir === -1 ? 'altında' : 'üstünde'} yeterli yer kalmıyor (risk/ödül ${S.rr} altı). Fiyatın bölgeden dönüp yeni bir kurulum vermesini bekleyin.</p>` : ''}
      ${p.breakout ? `<div class="stage" style="background:var(--panel)"><div class="stage-h"><h3>Kırılım senaryosu</h3><span class="pill neutral">${esc(p.breakout.cond)}</span></div><div class="levels">
        ${lv('Giriş (geri test)', fp(p.breakout.entry))}${lv('Stop', fp(p.breakout.stop) + ` <small class="mute">${((p.breakout.stop / p.breakout.entry - 1) * 100).toFixed(2)}%</small>`, 'dn')}
        ${p.breakout.targets.map((t, k) => lv('Hedef ' + (k + 1), fp(t) + ` <small class="mute">${((t / p.breakout.entry - 1) * 100).toFixed(2)}%</small>`, 'up')).join('')}
        ${lv('Ort. risk / ödül', p.breakout.rrPlan.toFixed(2))}</div>${p.breakout.inter && p.breakout.inter.length ? `<p class="mute" style="margin:0;font-size:.85rem">Ara direnç (1R'den yakın, kısmi kâr yeri): ${p.breakout.inter.map(fp).join(', ')}</p>` : ''}</div>` : ''}
      ${p.entry != null && p.blocked && !p.wideStop ? '<h3 class="mute" style="font-size:.95rem">Mevcut seviyeler (bölge kırılmadan geçersiz)</h3>' : ''}
      ${p.entry != null && !p.blocked && !p.wideStop && !/^(AL|LİMİT)/.test(p.decision || '') ? `<h3 class="mute" style="font-size:.95rem">İzleme seviyeleri (işlem değil${(p.rrPlan ?? p.rr) < S.rr ? `: risk/ödül ${(p.rrPlan ?? p.rr).toFixed(2)}, en az ${S.rr} gerekli` : ': kurulum puanı yetersiz'})</h3>` : ''}
      ${p.entry != null && p.wideStop && p.status !== 'HAZIR' ? `<p class="mute" style="margin:0">Mevcut yapıda mantıklı stop yok (en yakın yapısal seviye 1s ATR'nin 1,5 katından uzak); seviye verilmiyor.</p>` : p.entry != null ? `<div class="levels"${p.blocked || !/^(AL|LİMİT)/.test(p.decision || '') ? ' style="opacity:.55"' : ''}>
        ${lv(!/^(AL|LİMİT)/.test(p.decision || '') ? 'Giriş seviyesi' : p.inZone ? 'Giriş (şimdi)' : 'Giriş (limit)', fp(p.entry))}
        ${lv('Stop', fp(p.stop) + pct(p.stop), 'dn')}
        ${p.targets.map((t, k) => lv('Hedef ' + (k + 1) + (p.extrapolated ? ' (tahmini)' : ''), fp(t) + pct(t), 'up')).join('')}
        ${lv('Risk / ödül (H1)', p.rr.toFixed(2))}${p.targets.length > 1 ? lv('Ort. risk / ödül (%50-%50)', (p.rrPlan ?? p.rr).toFixed(2)) : ''}
      </div>` : '<p class="mute" style="margin:0">Bu sembolde şu an plan yok.</p>'}
      <details><summary class="mute">Plan ayrıntıları</summary><ul class="reasons" style="margin-top:8px">${p.reasons.map(x => `<li class="${x.s > 0 ? 'p' : x.s < 0 ? 'n' : ''}">${esc(x.t)}</li>`).join('')}</ul></details>
      <div class="kv">
        <div><span class="mute">15dk RSI</span><span class="num">${an.m15.rsi.toFixed(1)}</span></div>
        <div><span class="mute">1s RSI</span><span class="num">${an.h1.rsi.toFixed(1)}</span></div>
        <div><span class="mute">4s RSI</span><span class="num">${an.h4.rsi.toFixed(1)}</span></div>
        <div><span class="mute">Son 15dk hacim / medyan</span><span class="num">${an.m15.relVol.toFixed(2)}x</span></div>
        <div><span class="mute">Son 1 saat hacim / medyan</span><span class="num">${an.m15.relVol4.toFixed(2)}x</span></div>
        <div><span class="mute">15dk mum hacmi (medyan${d.src === 'td' ? ', Crypto.com' : ''})</span><span class="num">${d.src === 'td-bist' ? fmtTL(an.m15.qv) : fmtUsd(an.m15.qv)}</span></div>
        ${d.r && d.r.qv ? `<div><span class="mute">${d.src === 'td-bist' ? 'Günlük hacim' : d.src === 'td' ? '24 saat hacim (Crypto.com)' : '24 saat hacim'}</span><span class="num">${d.src === 'td-bist' ? fmtTL(d.r.qv) : fmtUsd(d.r.qv)}</span></div>` : ''}
        <div><span class="mute">1s ATR</span><span class="num">${fp(an.h1.atr)}</span></div>
        <div><span class="mute">Formasyon</span><span>${esc([...new Set(an.m15.patterns.map(x => x.name.split(' (')[0]))].join(', ') || '—')}</span></div>
        <div><span class="mute">Süpürme (15dk)</span><span>${an.m15.liq.sweeps.length ? an.m15.liq.sweeps.slice(-1).map(s => (s.dir === 1 ? 'dip ' : 'tepe ') + fp(s.level)).join('') : '—'}</span></div>
      </div></div></details>
      <p class="note" style="margin:0">Veri: ${d.src === 'td-bist' ? `Borsa İstanbul (Twelve Data) · fiyat ve hacim · 15dk/1s/4s için ${an.m15.bars}/${an.h1.bars}/${an.h4.bars} mum.` : d.src === 'td' ? `Binance fiyatı (Twelve Data) · 15dk/1s/4s için ${an.m15.bars}/${an.h1.bars}/${an.h4.bars} mum; RSI/EMA tam geçmişle hesaplandı. Hacim Crypto.com'dan (son ${d.matched} mum eşleşti), Binance hacminin küçük bir kısmıdır; göreli kullanılır.` : ART ? `Crypto.com · 15dk/1s/4s için son ${an.m15.bars}/${an.h1.bars}/${an.h4.bars} mum. Göstergeler kısa geçmişle hesaplandı.${d.tdErr ? ` (Twelve Data alınamadı: ${esc(d.tdErr)})` : ''}` : `Binance · 15dk/1s/4s için son ${an.m15.bars}/${an.h1.bars}/${an.h4.bars} mum.`}</p>
      <button class="btn ghost" id="toBt" type="button">Bu sembolde backtest yap</button>`;
    $('#toBt').onclick = () => { $('#btSym').value = d.sym; closeDetail(); showTab('bt'); };
    drawChart();
  }
  function updateDetailPrice(px, chg) {
    $('#dPrice').textContent = fp(px);
    if (chg != null) { $('#dChg').textContent = (chg >= 0 ? '+' : '') + chg.toFixed(2) + ((detail && detail.src === 'td-bist') ? '% (gün)' : '% (24s)'); $('#dChg').className = 'num ' + (chg >= 0 ? 'up' : 'dn'); }
  }
  let poll = null;
  function openKlineWS(sym) {
    if (ART && detail && detail.src !== 'cdc') {
      clearInterval(poll);
      $('#liveDot').className = 'dot on'; $('#liveTxt').textContent = '2 dk\'da bir yenilenir';
      const merge = (arr, add) => { const m = new Map(arr.map(x => [x.t, x])); for (const x of add) m.set(x.t, { ...(m.get(x.t) || {}), ...x }); return [...m.values()].sort((p, q) => p.t - q.t); };
      poll = setInterval(async () => {
        if (!detail || detail.sym !== sym || document.hidden) return;
        try {
          let add;
          if (detail.src === 'td-bist') add = await bistTD(sym, 8);
          else { add = (await cryptoTD(sym, 8)).c15; }
          if (!detail || detail.sym !== sym) return;
          const c15 = merge(detail.c15, add);
          Object.assign(detail, { c15, c1h: aggregateByTime(c15, 3600000), c4h: aggregateByTime(c15, 14400000) });
          recompute();
        } catch { $('#liveDot').className = 'dot err'; $('#liveTxt').textContent = 'yenilenemedi'; }
      }, 120000);
      return;
    }
    if (ART) {
      clearInterval(poll);
      $('#liveDot').className = 'dot on'; $('#liveTxt').textContent = '30 sn\'de bir yenilenir';
      poll = setInterval(async () => {
        if (!detail || detail.sym !== sym || document.hidden) return;
        try { const [a, b, c] = await Promise.all([klines(sym, '15m'), klines(sym, '1h'), klines(sym, '4h')]); if (detail && detail.sym === sym) { detail.c15 = a; detail.c1h = b; detail.c4h = c; recompute(); } }
        catch { $('#liveDot').className = 'dot err'; $('#liveTxt').textContent = 'yenilenemedi'; }
      }, 30000);
      return;
    }
    if (kws) try { kws.close(); } catch {}
    const s = sym.toLowerCase();
    kws = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${s}@kline_15m/${s}@kline_1h/${s}@kline_4h`);
    kws.onopen = () => { $('#liveDot').className = 'dot on'; $('#liveTxt').textContent = 'canlı'; };
    kws.onclose = () => { $('#liveDot').className = 'dot'; $('#liveTxt').textContent = 'canlı akış kapalı'; };
    let pending = false;
    kws.onmessage = ev => {
      if (!detail || detail.sym !== sym) return;
      const k = JSON.parse(ev.data).data.k;
      const bar = { t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v, ct: k.T };
      const arr = k.i === '15m' ? detail.c15 : k.i === '1h' ? detail.c1h : detail.c4h;
      if (arr[arr.length - 1].t === bar.t) arr[arr.length - 1] = bar; else { arr.push(bar); arr.shift(); }
      if (k.i === '15m') updateDetailPrice(bar.c);
      if (!pending) { pending = true; requestAnimationFrame(() => { pending = false; k.x ? recompute() : drawChart(); }); }
    };
  }
  function closeDetail() {
    $('#sheet').hidden = true; document.body.style.overflow = '';
    if (kws) try { kws.close(); } catch {}
    clearInterval(poll);
    detail = null;
  }
  $('#closeSheet').onclick = closeDetail;
  $('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeDetail(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && detail) closeDetail(); });
  $$('#tfSeg button').forEach(b => b.onclick = () => {
    if (!detail) return; detail.tf = b.dataset.tf;
    $$('#tfSeg button').forEach(x => x.setAttribute('aria-pressed', x === b)); drawChart();
  });
  window.addEventListener('resize', () => { if (detail) drawChart(); if (lastBT) drawEquity(); });

  const cssv = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  function setupCanvas(cv) {
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    cv.width = w * dpr; cv.height = h * dpr;
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }
  function drawChart() {
    const d = detail; if (!d || !d.an) return;
    const tfA = d.tf === '15m' ? d.an.m15 : d.tf === '1h' ? d.an.h1 : d.an.h4;
    const raw = d.tf === '15m' ? d.c15 : d.tf === '1h' ? d.c1h : d.c4h;
    const p = d.an.plan;
    const { ctx, w, h } = setupCanvas($('#chart'));
    const C = { fg: cssv('--fg'), mute: cssv('--mute'), line: cssv('--line'), good: cssv('--good'), bad: cssv('--bad'), acc: cssv('--accent'), info: cssv('--info'), gbg: cssv('--good-bg'), bbg: cssv('--bad-bg') };
    const show = Math.min(tfA.n, Math.max(40, Math.min(110, Math.floor((w - 70) / 7))));
    const off = tfA.n - show; // analizdeki indeks -> ekrandaki indeks
    const bars = tfA.c.slice(-show);
    const live = raw[raw.length - 1];
    const all = live.t > bars[bars.length - 1].t ? bars.concat([live]) : bars;
    const padR = 64, padT = 10, volH = 44, chartH = h - padT - volH - 14;
    let hi = Math.max(...all.map(b => b.h)), lo = Math.min(...all.map(b => b.l));
    const T = d.tr ? d.tr.tr : null;
    const tl = T ? (T.decision === 'POZİSYONDA' ? [[T.open.e, 'acc', 'GİR'], [T.open.stop, 'bad', 'STOP']] : T.level != null ? [[T.decision === 'AL' ? T.entry : T.level, 'acc', T.decision === 'AL' ? 'GİR' : 'TETİK'], [T.stop, 'bad', 'STOP']] : []) : [];
    for (const [v] of tl) if (Math.abs(v - all[all.length - 1].c) < (hi - lo) * 1.5) { hi = Math.max(hi, v); lo = Math.min(lo, v); }
    const padP = (hi - lo) * 0.06; hi += padP; lo -= padP;
    const cw = (w - padR) / all.length;
    const X = i => (i - off) * cw + cw / 2, Y = v => padT + (hi - v) / (hi - lo) * chartH;
    ctx.clearRect(0, 0, w, h);
    ctx.font = '10px ' + cssv('--f-mono'); ctx.textBaseline = 'middle';
    // ızgara
    ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.fillStyle = C.mute;
    for (let k = 0; k <= 5; k++) { const v = lo + (hi - lo) * k / 5, y = Y(v); ctx.globalAlpha = .6; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w - padR, y); ctx.stroke(); ctx.globalAlpha = 1; ctx.fillText(fp(v), w - padR + 4, y); }
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, w - padR, padT + chartH); ctx.clip();
    // bölgeler
    const box = (z, endX) => { const x0 = Math.max(0, X(z.i) - cw / 2); ctx.fillStyle = z.dir === 1 ? C.gbg : C.bbg; ctx.fillRect(x0, Y(z.top), endX - x0, Math.max(1, Y(z.bot) - Y(z.top))); ctx.strokeStyle = z.dir === 1 ? C.good : C.bad; ctx.globalAlpha = .5; ctx.strokeRect(x0, Y(z.top), endX - x0, Math.max(1, Y(z.bot) - Y(z.top))); ctx.globalAlpha = 1; };
    tfA.fvg.forEach(z => box(z, w - padR));
    tfA.ob.forEach(z => box(z, w - padR));
    // likidite seviyeleri (fiyata yakın olanlar)
    ctx.setLineDash([2, 3]); ctx.strokeStyle = C.info;
    [...tfA.liq.bsl, ...tfA.liq.ssl].filter(l => l.price < hi && l.price > lo && l.i >= off).forEach(l => { ctx.beginPath(); ctx.moveTo(X(l.i), Y(l.price)); ctx.lineTo(w - padR, Y(l.price)); ctx.stroke(); });
    ctx.setLineDash([]);
    ctx.restore(); ctx.save(); ctx.beginPath(); ctx.rect(0, 0, w - padR, h); ctx.clip();
    // hacim
    const vmax = Math.max(...all.map(b => b.v));
    all.forEach((b, k) => { const x = X(off + k), vh = b.v / vmax * volH; ctx.fillStyle = b.c >= b.o ? C.good : C.bad; ctx.globalAlpha = .35; ctx.fillRect(x - cw * .35, h - 4 - vh, cw * .7, vh); ctx.globalAlpha = 1; });
    // EMA50
    ctx.strokeStyle = C.acc; ctx.globalAlpha = .45; ctx.lineWidth = 1.2; ctx.beginPath();
    tfA.emaArr.e50.slice(-show).forEach((v, k) => { const x = X(off + k), y = Y(v); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke(); ctx.globalAlpha = 1; ctx.lineWidth = 1;
    // mumlar
    all.forEach((b, k) => {
      const x = X(off + k), up = b.c >= b.o; ctx.strokeStyle = ctx.fillStyle = up ? C.good : C.bad;
      ctx.beginPath(); ctx.moveTo(x, Y(b.h)); ctx.lineTo(x, Y(b.l)); ctx.stroke();
      const y1 = Y(Math.max(b.o, b.c)), y2 = Y(Math.min(b.o, b.c)); ctx.fillRect(x - Math.max(1, cw * .32), y1, Math.max(2, cw * .64), Math.max(1, y2 - y1));
      if (k === all.length - 1 && all.length > bars.length) { ctx.globalAlpha = .4; ctx.strokeRect(x - cw * .45, Y(b.h) - 2, cw * .9, Y(b.l) - Y(b.h) + 4); ctx.globalAlpha = 1; }
    });
    // BOS / CHoCH
    ctx.font = '600 9px ' + cssv('--f-body');
    tfA.events.filter(e => e.i >= off).forEach(e => {
      ctx.strokeStyle = ctx.fillStyle = e.dir === 1 ? C.good : C.bad; ctx.setLineDash(e.type === 'CHoCH' ? [4, 3] : []);
      const x0 = X(Math.max(e.from, off)), x1 = X(e.i), y = Y(e.level);
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke(); ctx.setLineDash([]);
      ctx.textAlign = 'center'; ctx.fillText(e.type, (x0 + x1) / 2, y + (e.dir === 1 ? -7 : 7));
    });
    // swing etiketleri
    ctx.fillStyle = C.mute; ctx.font = '9px ' + cssv('--f-body');
    tfA.piv.highs.filter(q => q.i >= off).forEach(q => ctx.fillText(q.label, X(q.i), Y(q.price) - 7));
    tfA.piv.lows.filter(q => q.i >= off).forEach(q => ctx.fillText(q.label, X(q.i), Y(q.price) + 8));
    // süpürmeler
    tfA.liq.sweeps.filter(s => s.i >= off).forEach(s => { ctx.fillStyle = C.info; const x = X(s.i), y = Y(s.dir === 1 ? tfA.c[s.i].l : tfA.c[s.i].h) + (s.dir === 1 ? 10 : -10); ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - 4, y + (s.dir === 1 ? 6 : -6)); ctx.lineTo(x + 4, y + (s.dir === 1 ? 6 : -6)); ctx.fill(); });
    ctx.restore();
    // plan çizgileri
    ctx.textAlign = 'left';
    const pline = (v, col, label) => { if (v == null || v > hi || v < lo) return; const y = Y(v); ctx.strokeStyle = col; ctx.setLineDash([6, 4]); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w - padR, y); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = col; ctx.fillRect(w - padR, y - 8, padR, 16); ctx.fillStyle = cssv('--bg'); ctx.font = '600 9px ' + cssv('--f-mono'); ctx.fillText(label, w - padR + 3, y); };
    for (const [v, c, lab] of tl) pline(v, C[c], lab);
    // son fiyat
    const lp = all[all.length - 1].c; ctx.fillStyle = C.fg; ctx.fillRect(w - padR, Y(lp) - 8, padR, 16); ctx.fillStyle = cssv('--bg'); ctx.font = '600 10px ' + cssv('--f-mono'); ctx.fillText(fp(lp), w - padR + 3, Y(lp));
  }

  // ---------------- Günlük plan ----------------
  function renderDaily() {
    if (!results.length) { $('#dailyGrid').innerHTML = ''; $('#dailyNote').textContent = 'Plan son taramadan üretilir. Önce Tarayıcı sekmesinde tarama yapın.'; return; }
    const d = new Date(lastScan);
    $('#dailyTitle').textContent = 'Günlük plan · ' + d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', weekday: 'long' });
    const reg = results.find(r => r.btc != null);
    $('#dailyNote').textContent = `${new Date(lastScan).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })} taraması · ${results.length} sembol` + (reg ? ` · BTC rejimi ${reg.btc === 1 ? 'olumlu' : 'zayıf: yeni alım yok, açık pozisyonları iz süren stopla yönet'}` : '') + '. Aynı anda en fazla 5 pozisyon, işlem başı %0.5–1 risk.';
    const item = r => `<li><button class="row" style="padding:0;display:block;border:0" data-sym="${esc(r.sym)}"><b class="sym" style="font-size:1rem">${esc(r.base)}</b> <span class="pill ${T_TONE[r.decision] || 'neutral'}">${esc(r.decision || r.status)}</span>${r.td ? ' <span class="mute">Binance ✓</span>' : ''}<br>
      ${r.entry != null ? `<span class="num">${r.decision === 'KIRILIM YAKIN' || r.decision === 'BEKLE' ? 'Tetik (1s kapanış >)' : 'Giriş'} ${fp(r.entry)} · Stop ${fp(r.stop)}${r.decision === 'POZİSYONDA' && r.openR != null ? ` · ${r.openR >= 0 ? '+' : ''}${r.openR.toFixed(1)}R` : ''}</span><br>` : ''}
      <span class="mute">${esc(r.why || '')}</span></button></li>`;
    const sec = (title, desc, arr) => `<div class="card"><div><h3>${title}</h3><div class="mute" style="font-size:.82rem">${desc}</div></div>${arr.length ? `<ol>${arr.map(item).join('')}</ol>` : '<div class="mute">Şu an yok.</div>'}</div>`;
    const by = f => results.filter(f).sort((a, b) => b.score - a.score).slice(0, 10);
    $('#dailyGrid').innerHTML =
      sec('AL · motor kurulumları', 'Test edilmiş motor kombinasyonlarından biri son 1s mumda tamamlandı. Stop 3 ATR, iz süren stop 8 ATR. Önce birden çok kurulumu olanlar.', by(r => r.decision === 'AL' && r.src === 'motor')) +
      sec('AL · trend kırılımı', '1s kapanış 20 günlük zirveyi kırdı, BTC rejimi olumlu. Stop 4 ATR, iz süren stop 12 ATR.', by(r => r.decision === 'AL' && r.src !== 'motor')) +
      (S.short ? sec('Short (vadeli)', 'Test edilmiş short kurulumları (NY seansı ağırlıklı).', by(r => r.decision === 'SAT (short)')) : '') +
      sec('Kırılıma yakın · alarm kur', 'Fiyat 20 günlük zirveye 1 ATR içinde. 1s kapanış tetik seviyesinin üstünde olursa AL.', by(r => r.decision === 'KIRILIM YAKIN')) +
      sec('Pozisyonda · iz süren stop', 'Sinyal daha önce geldi, trend sürüyor. Stopu her saat güncel iz süren seviyeye taşı; yeni giriş için geç olabilir.', by(r => r.decision === 'POZİSYONDA')) +
      sec('Uzak dur', 'BTC rejimi zayıf ya da zirveden çok uzak.', by(r => r.decision === 'UZAK DUR').slice(0, 5));
    $$('#dailyGrid .row').forEach(b => b.onclick = () => openDetail(b.dataset.sym));
  }
  $('#copyPlan').onclick = async () => {
    if (!results.length) return toast('Önce tarama yapın.');
    const L = ['AYAZ PA GÜNLÜK PLAN · Trend Kırılımı · ' + new Date(lastScan).toLocaleString('tr-TR'), ''];
    const add = (t, arr) => { L.push(t); arr.forEach(r => L.push(`- ${r.base}: ${r.decision}` + (r.entry != null ? ` | ${r.decision === 'KIRILIM YAKIN' ? 'Tetik' : 'Giriş'} ${fp(r.entry)} Stop ${fp(r.stop)}` : '') + (r.openR != null && r.decision === 'POZİSYONDA' ? ` | ${r.openR.toFixed(1)}R` : '') + (r.decision === 'AL' || r.decision === 'POZİSYONDA' ? (L => L.length ? ' | SAT merdiveni: ' + ladderText(L) : '')(ladder(r.decision === 'AL' ? r.last : r.entry, r.stop, r.trailD, r.last).slice(0, 3)) : ''))); if (!arr.length) L.push('- yok'); L.push(''); };
    add('AL', results.filter(r => r.decision === 'AL').slice(0, 10));
    if (S.short) add('SHORT', results.filter(r => r.decision === 'SAT (short)').slice(0, 10));
    add('KIRILIMA YAKIN', results.filter(r => r.decision === 'KIRILIM YAKIN').slice(0, 10));
    add('POZİSYONDA', results.filter(r => r.decision === 'POZİSYONDA').slice(0, 10));
    L.push('Çıkış: sabit hedef yok. Fiyat merdivendeki seviyeye çıkınca stopu yazan yere çek; fiyat stopa inince sat. Yatırım tavsiyesi değildir.');
    const txt = L.join('\n');
    try { await navigator.clipboard.writeText(txt); toast('Plan panoya kopyalandı.'); }
    catch { toast('Kopyalanamadı. Tarayıcınız panoya izin vermiyor.'); }
  };

  // ---------------- Backtest ----------------
  let lastBT = null, btTab = 'ov';
  function btOpts() {
    return {
      capital: +$('#btCap').value, riskPct: +$('#btRisk').value, commission: +$('#btFee').value, slippage: +$('#btSlip').value,
      minScore: +$('#btScore').value, minRR: +$('#btRR').value, exitMode: $('#btExit').value, maxBars: +$('#btMax').value,
      useLimit: $('#btLimit').checked, allowShort: $('#btShort').checked, phases: $$('.btPh').filter(x => x.checked).map(x => x.value), noVolume: ART
    };
  }
  const isTrendBT = () => $('#btStrat').value !== 'pa', btStrat = () => $('#btStrat').value;
  function syncBtForm() {
    const tr = isTrendBT();
    $$('#btForm .pa-only').forEach(x => x.style.display = tr ? 'none' : '');
    if (tr) $('#btShort').closest('.pa-only').style.display = btStrat() === 'motor' ? '' : 'none';
    const cur = +$('#btDays').value;
    const opts = tr ? (ART ? [60, 90, 180] : [90, 180, 365, 730]) : (ART ? [20, 30, 45] : [30, 60, 90, 180, 365]);
    const def = tr ? (ART ? 180 : 365) : (ART ? 30 : 90);
    $('#btDays').innerHTML = opts.map(v => `<option value="${v}"${v === (opts.includes(cur) ? cur : def) ? ' selected' : ''}>${v} gün</option>`).join('');
    $('#btBatch').textContent = `Toplu test (ilk ${ART ? 10 : 20} coin)`;
  }
  $('#btStrat').addEventListener('change', syncBtForm);
  async function loadTrendHist(sym, days) {
    const size = Math.min(ART ? 5000 : 20000, days * 24 + PA.TREND.N + 30);
    const wait = w => $('#btStatus').textContent = `Twelve Data dakika sınırı: ${w} sn bekleniyor…`;
    if (ART) return closed(await tdSeries(isBist(sym) ? sym : tdBase(sym), isBist(sym) ? 'BIST' : 'Binance', size, isBist(sym) ? 180 : 0, wait, false, false, '1h'));
    return klinesRange(sym, '1h', size);
  }
  async function runMotorBT(sym, days) {
    const c = await loadTrendHist(sym, days);
    const btc = isBist(sym) ? null : await getBtcD1();
    const o = btOpts();
    const r = BT.runMotor(c, { btcReg: btc ? regFn(btc) : null, btc7: btc ? ENG.btc7Fn(btc) : null, filter: isBist(sym) ? false : undefined, longOnly: isBist(sym) || !o.allowShort }, { capital: o.capital, riskPct: o.riskPct, commission: o.commission, slippage: o.slippage });
    r.c = c; return r;
  }
  async function runTrendBT(sym, days) {
    const c = await loadTrendHist(sym, days);
    const btc = isBist(sym) ? null : await getBtcD1();
    const o = btOpts();
    const r = BT.runTrend(c, btc, { capital: o.capital, riskPct: o.riskPct, commission: o.commission, slippage: o.slippage });
    r.c = c; return r;
  }
  async function loadHist(sym, days, onp) {
    if (ART) {
      const wait = w => $('#btStatus').textContent = `Twelve Data dakika sınırı: ${w} sn bekleniyor…`;
      if (isBist(sym)) return closed(await bistTD(sym, 5000, wait));
      const c = await tdSeries(sym.replace(/USDT$/, '') + '/USD', 'Binance', Math.min(5000, days * 96 + 900), 0, wait);
      for (const x of c) x.v = 1;                  // Twelve Data kripto hacmi vermiyor: hacim nötr
      if (onp) onp(1);
      return closed(c);
    }
    return klinesRange(sym, '15m', days * 96 + 900, onp);
  }
  $('#btForm').addEventListener('submit', async e => {
    e.preventDefault();
    const sym = $('#btSym').value.trim().toUpperCase(), days = +$('#btDays').value;
    if (!/^[A-Z0-9]{4,20}$/.test(sym)) return toast('Sembolü BTCUSDT (kripto) ya da THYAO (BIST) biçiminde yazın.');
    setBtBusy(true);
    try {
      $('#btStatus').textContent = `${sym} geçmiş verisi indiriliyor…`;
      if (isTrendBT()) {
        const r = btStrat() === 'motor' ? await runMotorBT(sym, days) : await runTrendBT(sym, days); r.sym = sym; lastBT = r;
        $('#btStatus').textContent = `${sym} · ${btStrat() === 'motor' ? 'Motor kurulumları' : 'Trend Kırılımı'} · ${Math.round((r.to - r.from) / 864e5)} gün test (${r.c.length} adet 1s mum, ilk ${btStrat() === 'motor' ? 200 : PA.TREND.N} mum ısınma)${ART ? ' · Binance fiyatı (Twelve Data)' : ''}. Tek coinde işlem sayısı az olur; toplu testi de çalıştırın.`;
        renderBT(); return;
      }
      const c = await loadHist(sym, days, f => $('#btProg').style.width = (f * 40) + '%');
      $('#btStatus').textContent = `${c.length} mum üzerinde strateji çalışıyor…`;
      const r = await BT.run(c, { ...btOpts(), noVolume: ART && !isBist(sym), allowShort: isBist(sym) ? false : btOpts().allowShort }, f => $('#btProg').style.width = (40 + f * 60) + '%');
      r.sym = sym; r.c = c; lastBT = r;
      $('#btStatus').textContent = `${sym} · ${Math.round(c.length / 96)} gün · ${(r.ms / 1000).toFixed(1)} sn${ART ? ' · Binance/BIST fiyatı (Twelve Data)' : ''}`;
      renderBT();
    } catch (err) { $('#btStatus').textContent = 'Test yapılamadı: ' + err.message; }
    finally { setBtBusy(false); }
  });
  $('#btBatch').onclick = async () => {
    setBtBusy(true);
    const days = +$('#btDays').value, opts = btOpts();
    try {
      const N = ART ? 10 : 20;
      const uni = results.length ? results.slice().sort((a, b) => b.qv - a.qv).slice(0, N).map(r => r.sym) : (await universe('USDT', N)).map(u => u.sym);
      const rows = [];
      for (let k = 0; k < uni.length; k++) {
        $('#btStatus').textContent = `${k + 1}/${uni.length} · ${uni[k]}`;
        try {
          const r = btStrat() === 'motor' ? await runMotorBT(uni[k], days) : isTrendBT() ? await runTrendBT(uni[k], days) : await BT.run(await loadHist(uni[k], days), { ...opts, noVolume: ART && !isBist(uni[k]), allowShort: isBist(uni[k]) ? false : opts.allowShort });
          rows.push({ sym: uni[k], ...r.stats });
        } catch (err) { rows.push({ sym: uni[k], err: err.message }); }
        $('#btProg').style.width = ((k + 1) / uni.length * 100) + '%';
      }
      renderBatch(rows, days);
      $('#btStatus').textContent = `Toplu test bitti · ${days} gün`;
    } catch (err) { $('#btStatus').textContent = 'Toplu test yapılamadı: ' + err.message; }
    finally { setBtBusy(false); }
  };
  function setBtBusy(b) { $('#btRun').disabled = b; $('#btBatch').disabled = b; if (!b) setTimeout(() => $('#btProg').style.width = '0', 800); }
  const money = (v, cur) => (v >= 0 ? '' : '−') + Math.abs(v).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (cur ? ' ' + cur : '');
  const pctS = v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2) + '%';
  const dt = t => new Date(t).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

  function renderBT() {
    const r = lastBT, s = r.stats, cur = r.sym.endsWith('TRY') || isBist(r.sym) ? 'TRY' : 'USDT';
    const m = (k, v, sub, cls = '') => `<div class="metric"><span class="lbl">${k}</span><span class="v ${cls}">${v}</span>${sub ? `<span class="s">${sub}</span>` : ''}</div>`;
    $('#btOut').innerHTML = `
      <div class="metrics">
        ${m('Net kâr', money(s.net), pctS(s.netPct), s.net >= 0 ? 'up' : 'dn')}
        ${m('Toplam işlem', s.total, `${s.longs} long · ${s.shorts} short`)}
        ${m('Kazanma oranı', s.winRate.toFixed(1) + '%', `${s.wins} / ${s.total}`)}
        ${m('Profit factor', isFinite(s.pf) ? s.pf.toFixed(2) : '∞', 'brüt kâr / brüt zarar', s.pf >= 1 ? 'up' : 'dn')}
        ${m('Maks. düşüş', money(-s.mdd), pctS(-s.mddPct), 'dn')}
        ${m('Ort. işlem', money(s.avg), `${s.avgR.toFixed(2)} R`)}
        ${m('Sharpe', s.sharpe.toFixed(2), 'Sortino ' + s.sortino.toFixed(2))}
        ${m('Al ve tut', pctS(s.buyHold), 'aynı dönem')}
      </div>
      <div class="subtabs" role="tablist">
        <button data-st="ov" aria-selected="${btTab === 'ov'}">Genel bakış</button>
        <button data-st="perf" aria-selected="${btTab === 'perf'}">Performans özeti</button>
        <button data-st="list" aria-selected="${btTab === 'list'}">İşlem listesi</button>
      </div>
      <div id="btPane"></div>`;
    $$('#btOut .subtabs button').forEach(b => b.onclick = () => { btTab = b.dataset.st; renderBT(); });
    const pane = $('#btPane');
    if (btTab === 'ov') {
      pane.innerHTML = `<canvas class="chart" id="eqChart" style="height:300px"></canvas>
        <div class="legend"><span><i style="background:var(--accent)"></i>Sermaye</span><span><i style="background:var(--mute)"></i>Al ve tut</span><span><i style="background:var(--bad-bg);border:1px solid var(--bad)"></i>Düşüş (drawdown)</span><span><i style="background:var(--good)"></i>Kazanan işlem</span><span><i style="background:var(--bad)"></i>Kaybeden işlem</span></div>
        <p class="note">${dt(r.from)} – ${dt(r.to)} · Başlangıç ${money(r.opts.capital, cur)} → Bitiş ${money(s.endEquity, cur)}. Geçmiş sonuçlar gelecekteki getiriyi garanti etmez; az işlemli testler (30'dan az) güvenilir değildir.</p>`;
      drawEquity();
    } else if (btTab === 'perf') {
      const row = (k, v) => `<tr><td class="t l">${k}</td><td>${v}</td></tr>`;
      pane.innerHTML = `<div class="tblwrap"><table><tbody>
        ${row('Net kâr', money(s.net, cur) + ' (' + pctS(s.netPct) + ')')}${row('Brüt kâr', money(s.gp, cur))}${row('Brüt zarar', money(-s.gl, cur))}
        ${row('Profit factor', isFinite(s.pf) ? s.pf.toFixed(3) : '∞')}${row('Maks. düşüş', money(-s.mdd, cur) + ' (' + pctS(-s.mddPct) + ')')}${row('Toparlanma faktörü', s.recovery.toFixed(2))}
        ${row('Toplam kapanan işlem', s.total)}${row('Kazanan / kaybeden', s.wins + ' / ' + s.losses)}${row('Kazanma oranı', s.winRate.toFixed(2) + '%')}
        ${row('Ort. işlem', money(s.avg, cur))}${row('Ort. kazanan', money(s.avgWin, cur))}${row('Ort. kaybeden', money(-s.avgLoss, cur))}
        ${row('Kazanç / kayıp oranı', s.ratio.toFixed(2))}${row('En büyük kazanç', money(s.largestWin, cur))}${row('En büyük kayıp', money(s.largestLoss, cur))}
        ${row('Ort. R', s.avgR.toFixed(2))}${row('Ard arda en çok kazanç', s.maxCW)}${row('Ard arda en çok kayıp', s.maxCL)}
        ${row('Ort. işlem süresi', (s.avgBars / 4).toFixed(1) + ' saat')}${row('Sharpe (yıllık)', s.sharpe.toFixed(2))}${row('Sortino (yıllık)', s.sortino.toFixed(2))}
        ${row('Al ve tut getirisi', pctS(s.buyHold))}${row('Komisyon / kayma', r.opts.commission + '% / ' + r.opts.slippage + '%')}
      </tbody></table></div>`;
    } else {
      pane.innerHTML = `<div class="tblwrap" style="max-height:520px;overflow:auto"><table>
        <thead><tr><th>#</th><th class="l">Yön</th><th class="l">Giriş</th><th class="l">Çıkış</th><th>Giriş fiyatı</th><th>Çıkış fiyatı</th><th>Kâr/zarar</th><th>%</th><th>R</th><th>Süre</th><th class="l">Kurulum</th><th class="l">Çıkış nedeni</th></tr></thead>
        <tbody>${r.trades.slice().reverse().map(t => `<tr><td>${t.n}</td><td class="t l ${t.dir === 1 ? 'up' : 'dn'}">${t.dir === 1 ? 'Long' : 'Short'}</td><td class="l">${dt(t.entryT)}</td><td class="l">${dt(t.exitT)}</td>
          <td>${fp(t.entryPx)}</td><td>${fp(t.exitPx)}</td><td class="${t.pnl >= 0 ? 'up' : 'dn'}">${money(t.pnl)}</td><td class="${t.pnl >= 0 ? 'up' : 'dn'}">${pctS(t.pnlPct)}</td><td>${t.rMult.toFixed(2)}</td><td>${(t.bars / 4).toFixed(1)}s</td>
          <td class="t l">${esc(t.setup)}${t.model === 'trend' ? '' : ' · ' + esc(PA.PHASES[t.phase] ? PA.PHASES[t.phase].label : t.phase)}</td><td class="t l">${esc(t.reason)}</td></tr>`).join('') || `<tr><td colspan="12" class="t l">${r.strategy === 'trend' ? 'Bu dönemde sinyal oluşmadı (BTC rejimi zayıf ya da 20 günlük zirve kırılmadı). Daha uzun dönem ya da toplu test deneyin.' : 'Bu ayarlarla işlem açılmadı. Min. puanı düşürmeyi deneyin.'}</td></tr>`}</tbody></table></div>`;
    }
  }
  function drawEquity() {
    const cv = $('#eqChart'); if (!cv || !lastBT) return;
    const { ctx, w, h } = setupCanvas(cv), r = lastBT, curve = r.curve;
    const C = { acc: cssv('--accent'), mute: cssv('--mute'), line: cssv('--line'), bad: cssv('--bad'), good: cssv('--good'), bbg: cssv('--bad-bg') };
    const step = Math.max(1, Math.floor(curve.length / 800)), pts = curve.filter((_, k) => k % step === 0);
    const cs = new Map(r.c.map(b => [b.t, b.c])), p0 = cs.get(curve[0].t) || r.c[0].c;
    const bh = pts.map(p => r.opts.capital * (cs.get(p.t) || p0) / p0);
    const ddH = 60, padR = 70, top = 10, eqH = h - ddH - top - 16;
    const vals = pts.map(p => p.eq).concat(bh);
    let hi = Math.max(...vals), lo = Math.min(...vals); const pad = (hi - lo) * .08 || 1; hi += pad; lo -= pad;
    const X = k => k / (pts.length - 1) * (w - padR), Y = v => top + (hi - v) / (hi - lo) * eqH;
    ctx.clearRect(0, 0, w, h); ctx.font = '10px ' + cssv('--f-mono'); ctx.textBaseline = 'middle'; ctx.fillStyle = C.mute; ctx.strokeStyle = C.line;
    for (let k = 0; k <= 4; k++) { const v = lo + (hi - lo) * k / 4; ctx.beginPath(); ctx.moveTo(0, Y(v)); ctx.lineTo(w - padR, Y(v)); ctx.stroke(); ctx.fillText(v.toFixed(0), w - padR + 4, Y(v)); }
    // başlangıç sermayesi
    ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(0, Y(r.opts.capital)); ctx.lineTo(w - padR, Y(r.opts.capital)); ctx.stroke(); ctx.setLineDash([]);
    // al-tut
    ctx.strokeStyle = C.mute; ctx.globalAlpha = .7; ctx.beginPath(); bh.forEach((v, k) => k ? ctx.lineTo(X(k), Y(v)) : ctx.moveTo(X(k), Y(v))); ctx.stroke(); ctx.globalAlpha = 1;
    // sermaye eğrisi + alan
    ctx.beginPath(); pts.forEach((p, k) => k ? ctx.lineTo(X(k), Y(p.eq)) : ctx.moveTo(X(k), Y(p.eq)));
    ctx.strokeStyle = C.acc; ctx.lineWidth = 1.8; ctx.stroke(); ctx.lineWidth = 1;
    ctx.lineTo(X(pts.length - 1), Y(lo)); ctx.lineTo(0, Y(lo)); ctx.closePath(); ctx.globalAlpha = .1; ctx.fillStyle = C.acc; ctx.fill(); ctx.globalAlpha = 1;
    // işlem noktaları
    const tIdx = t => Math.min(pts.length - 1, Math.round(curve.findIndex(p => p.t >= t) / step));
    r.trades.forEach(t => { const k = tIdx(t.exitT); if (k < 0) return; ctx.fillStyle = t.pnl >= 0 ? C.good : C.bad; ctx.beginPath(); ctx.arc(X(k), Y(pts[k].eq), 2.5, 0, 7); ctx.fill(); });
    // drawdown
    let peak = -Infinity; const dd = pts.map(p => { peak = Math.max(peak, p.eq); return (p.eq - peak) / peak * 100; });
    const mdd = Math.min(-0.01, ...dd), y0 = h - ddH;
    ctx.fillStyle = C.bbg; ctx.strokeStyle = C.bad; ctx.beginPath(); ctx.moveTo(0, y0);
    dd.forEach((v, k) => ctx.lineTo(X(k), y0 + v / mdd * (ddH - 6))); ctx.lineTo(w - padR, y0); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = C.mute; ctx.fillText('DD ' + mdd.toFixed(1) + '%', w - padR + 4, y0 + ddH - 10);
    // tarih ekseni
    ctx.textAlign = 'center';
    [0, .5, 1].forEach(f => { const k = Math.round(f * (pts.length - 1)); ctx.fillText(new Date(pts[k].t).toLocaleDateString('tr-TR', { day: '2-digit', month: 'short' }), Math.min(w - padR - 30, Math.max(30, X(k))), y0 - 8); });
    ctx.textAlign = 'left';
  }
  function renderBatch(rows, days) {
    lastBT = null;
    const ok = rows.filter(r => !r.err).sort((a, b) => b.netPct - a.netPct);
    const tot = ok.reduce((s, r) => s + r.total, 0), wins = ok.reduce((s, r) => s + r.wins, 0);
    const gp = ok.reduce((s, r) => s + r.gp, 0), gl = ok.reduce((s, r) => s + r.gl, 0);
    $('#btOut').innerHTML = `
      <div class="metrics">
        <div class="metric"><span class="lbl">Test edilen</span><span class="v">${ok.length}</span><span class="s">${days} gün</span></div>
        <div class="metric"><span class="lbl">Kârlı sembol</span><span class="v">${ok.filter(r => r.net > 0).length}</span><span class="s">/ ${ok.length}</span></div>
        <div class="metric"><span class="lbl">Toplam işlem</span><span class="v">${tot}</span></div>
        <div class="metric"><span class="lbl">Genel kazanma</span><span class="v">${tot ? (wins / tot * 100).toFixed(1) : 0}%</span></div>
        <div class="metric"><span class="lbl">Genel profit factor</span><span class="v ${gp >= gl ? 'up' : 'dn'}">${gl ? (gp / gl).toFixed(2) : '∞'}</span></div>
        <div class="metric"><span class="lbl">Ort. net getiri</span><span class="v">${ok.length ? pctS(ok.reduce((s, r) => s + r.netPct, 0) / ok.length) : '-'}</span></div>
      </div>
      <div class="tblwrap"><table><thead><tr><th class="l">Sembol</th><th>Net %</th><th>İşlem</th><th>Kazanma</th><th>PF</th><th>Maks. DD</th><th>Ort. R</th><th>Al-tut</th></tr></thead><tbody>
      ${ok.map(r => `<tr><td class="t l"><b>${esc(r.sym)}</b></td><td class="${r.net >= 0 ? 'up' : 'dn'}">${pctS(r.netPct)}</td><td>${r.total}</td><td>${r.winRate.toFixed(0)}%</td><td>${isFinite(r.pf) ? r.pf.toFixed(2) : '∞'}</td><td class="dn">${pctS(-r.mddPct)}</td><td>${r.avgR.toFixed(2)}</td><td>${pctS(r.buyHold)}</td></tr>`).join('')}
      ${rows.filter(r => r.err).map(r => `<tr><td class="t l">${esc(r.sym)}</td><td class="t l" colspan="7">${esc(r.err)}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="note">Sembole dokunup tek tek test etmek için adını yukarıdaki kutuya yazın.</p>`;
  }

  function fillSymList(syms) { $('#symList').innerHTML = syms.map(s => `<option value="${esc(s)}"></option>`).join(''); }
  let toastT;
  function toast(msg) {
    let t = document.querySelector('.toast'); if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 2600);
  }

  window.addEventListener('error', e => { const el = $('#scanInfo'); if (el) el.textContent = 'Uygulama hatası: ' + (e.message || 'bilinmiyor'); });
  window.addEventListener('unhandledrejection', e => { const el = $('#scanInfo'); if (el && scanning) el.textContent = 'Hata: ' + ((e.reason && e.reason.message) || e.reason); });

  // ---------------- Başlat ----------------
  if (ART) {

    if (S.market !== 'BIST') S.market = 'USDT';
    if (store.get('mkt', null)) S.market = store.get('mkt', 'USDT');
    if (S.market === 'TRY') PA.setFx(store.get('fx', 1));
    $('#market').innerHTML = '<option value="USDT">Kripto · USDT pariteleri</option><option value="BIST">BIST 30 hisseleri (Twelve Data)</option><option value="TRY">Kripto · TL fiyatıyla (TRY)</option>';
    $('#market').addEventListener('change', () => { store.set('mkt', $('#market').value); PA.setFx($('#market').value === 'TRY' ? store.get('fx', 1) : 1); results = []; renderList(); $('#scanInfo').textContent = $('#market').value === 'BIST' ? 'BIST 30 taranır. Twelve Data dakikada 8 sorguya izin verdiği için 30 hisse yaklaşık 4 dakika sürer.' : ($('#market').value === 'TRY' ? 'TL modu: coinler USDT paritesinden taranır, bütün fiyatlar güncel USD/TRY kuruyla TL\'ye çevrilir. ' : '') + 'Kripto taraması Crypto.com verisiyle (günlük + 1s) yapılır; öne çıkan coinler Binance 1s geçmişiyle (Twelve Data) kesinleştirilir.'; });
    if (![...$('#universe').options].some(o => +o.value === S.universe)) S.universe = 9999;
    $('#setNotify').closest('label').hidden = true;
    { const bn = document.createElement('a'); bn.href = 'https://raw.githack.com/mrayaz35-jpg/Kod/ayaz-pa-app/index.html'; bn.target = '_blank'; bn.rel = 'noopener';
      bn.style.cssText = 'display:block;margin:0 0 14px;padding:14px 16px;border-radius:12px;background:var(--good);color:#fff;font-weight:700;text-decoration:none;text-align:center;font-size:1.05rem';
      bn.innerHTML = 'Tüm Binance TRY paritelerini (350+) taramak için buraya dokun ›<div style="font-weight:400;font-size:.8rem;opacity:.9;margin-top:4px">Bu sayfa Binance\'a bağlanamadığı için yalnızca ~116 coin tarar. Açılan sayfada uyarı çıkarsa "Open the page"e bas.</div>';
      $('#buyNow').before(bn); }
    $('#srcNote').textContent = 'Veri: Crypto.com Exchange canlı piyasa verisi (claude.ai bağlayıcınız üzerinden). Her grafikte son 50 mum okunur. Kurulu sürüm Binance\'tan 300 mum okur.';
    $('#btOut').innerHTML = '<p class="note">Bu bağlantıda backtest Binance fiyatıyla (Twelve Data) yapılır. Trend Kırılımı 1 saatlik mumlarla 180 güne kadar test edilir (5000 mum, ilk 480 mum ısınma). Tek coinde işlem az olur; Toplu test 10 coini birlikte ölçer. BIST hisselerini de test edebilirsiniz (ör. THYAO).</p>';
    if (false) $('#btOut').innerHTML = '<div class="card"><h3>Backtest kurulu sürümde çalışır</h3><p style="margin:0">Backtest uzun geçmiş veri ister: 90 günlük test 8.640 adet 15dk mum demek. Bu bağlantıdaki veri kaynağı her grafikte yalnızca son 50 mumu veriyor, bu yüzden burada güvenilir bir test yapılamaz.</p><p class="mute" style="margin:0">Kurulu sürüm (ayaz-pa.zip) Binance\'tan 365 güne kadar veri indirip TradingView Strategy Tester gibi tam test yapar: net kâr, kazanma oranı, profit factor, max drawdown, Sharpe, sermaye eğrisi, işlem listesi ve 20 coinde toplu test.</p></div>';
  }
  syncBtForm();
  applySettings();
  if (results.length && results[0].model !== 'trend') { results = []; store.set('results', []); }   // eski (PA) tarama sonuçları
  showTab(store.get('tab', 'scan'));
  renderList();
  if (results.length) { $('#scanBtn').textContent = 'Taramayı yenile'; fillSymList(results.map(r => r.sym)); }
  if (!ART) bget('/api/v3/ping').catch(() => {});
  liveTickers();
  scheduleAuto();
  if (!ART && 'serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
