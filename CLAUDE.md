# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This repository contains TradingView Pine Script v6 trading tools written in Turkish. There are no local build, test, or lint commands — all scripts run exclusively inside TradingView's browser-based Pine Script editor. To use a script, copy its contents and paste it into the TradingView Pine Script editor (Pine Editor tab → New Script → paste → Save → Add to chart).

## Files

| File | Type | Purpose |
|---|---|---|
| `CPv6_FINAL_DipTepe_AlSat.pine` | `strategy()` | Dip/Tepe buy-sell strategy, version 6 (stable baseline) |
| `CPv7_DipTepe_AlSat.pine` | `strategy()` | Version 7 — extends v6 with ATR-based SL, trailing stop, signal scoring, timeout, and toggleable trend/EMA filters |
| `TCPv1_TrendContext.pine` | `indicator()` | Overlay-only analysis tool: SSL/BSL channels, Donchian, ADX/DMI, Stochastic, 25 candle patterns, breakout labels, no trade execution |

## Architecture

### Script structure (consistent across all files)

All scripts follow this top-to-bottom layout:
1. `INPUTS` — grouped parameter declarations (`input.int`, `input.float`, `input.bool`)
2. `GOSTERGELER` — indicator calculations (EMAs, RSI, MACD, ATR, BB, pivots, channel)
3. Candle pattern detection — bar variables aliased as `o0/c0/h0/l0`, `o1/c1/...`, `o2/c2/...`, `o3/c3/...`
4. Signal logic (strategy files only) — raw → armed → confirmed pipeline
5. `GRAFIK` — `plot()`, `plotshape()`, `bgcolor()`, `fill()`
6. `DASHBOARD` — single `table.new()` drawn only on `barstate.islast`
7. `ALARMLAR` — `alertcondition()` declarations

### Signal pipeline (CPv6 / CPv7 strategies)

Entries use a three-stage design to avoid repainting:
- **Stage 1 — raw signal**: `long_raw` / `short_raw` — all conditions true simultaneously (pattern + zone + RSI + MACD + volume)
- **Stage 2 — armed**: `la` / `sa` boolean vars — set when raw fires while flat; CPv7 adds a bar-counted timeout (`arm_timeout`) that cancels stale signals
- **Stage 3 — confirmed**: `long_ok` / `short_ok` — `la[1]` plus the *next* bar closes in the signal direction (green for long, red for short); this is the actual entry trigger

CPv7 adds a `long_score` / `short_score` (0–5 integer) that gates entry behind `min_score`, making signal selectivity adjustable without changing the filter logic.

### Exit logic (strategies)

Exits are tiered: TP1 closes 40 %, TP2 closes 35 %, TP3 closes 25 %. Two emergency closes override TPs:
- RSI extreme (`> rsi_ob` for longs, `< rsi_os` for shorts) combined with an opposing candle pattern
- Full trend reversal (`ema_bear and close < ema50` for longs; `ema_bull and close > ema50` for shorts)

CPv7 optionally replaces fixed TPs with a trailing stop (`use_trail`). When enabled, a single `strategy.exit("TRAIL_*")` call replaces the three TP exits; `trail_ticks` is computed from `trail_pct` and `syminfo.mintick` at entry.

### Indicator vs. strategy distinction

`TCPv1` is `indicator()` — it has no `strategy.entry/exit` calls and no PnL/equity tracking. It is designed to run alongside a strategy on the same chart to provide analytical context (SSL direction, ADX strength, breakout labels). Its dashboard (10 rows) shows oscillator state rather than trade statistics.

## Naming conventions

All identifiers and comments use Turkish. Key vocabulary:
- **Dip** = low / bottom, **Tepe** = top / peak
- **Al** = buy, **Sat** = sell
- **Boga** = bull, **Ayi** = bear
- **Destek** = support, **Direnc** = resistance
- **Mum** = candle, **Kanal** = channel, **Kirilim** = breakout

Candle pattern short codes (used in labels):
- Bullish: `Ck` (Hammer), `TCk` (Inverted Hammer), `BE`/`BY` (Engulfing), `MS`/`SbY` (Morning Star), `3A` (Three White Soldiers), `PL`/`DL` (Piercing), `BH` (Harami), `ID` (Tweezer Bottom)
- Bearish: `KY` (Shooting Star), `AA` (Hanging Man), `AE`/`AY` (Engulfing), `AS`/`AkY` (Evening Star), `3K` (Three Black Crows), `KO` (Dark Cloud), `AH` (Harami), `IT` (Tweezer Top)

## Key parameters and their defaults

| Parameter | Default | Notes |
|---|---|---|
| EMA stack | 9 / 21 / 50 / 200 | 200 is the primary trend filter |
| RSI | 14-period, OB=75, OS=25 | Long range 40–75, short range 25–60 |
| MACD | 12 / 26 / 9 | Signal: crossover **or** position relative to signal line |
| Pivot lookback | 5 bars | Lower = faster but noisier pivots |
| S/R zone | 1.0 % | Distance threshold for "near support/resistance" |
| Channel | LR(50) ± 2.0 × ATR(14) | Purple band; `at_ch_top/bot` flags exact boundary |
| BB | 20-period, 2σ | `bb_sq` fires when band width < 70 % of its 20-bar MA |
| SL / TP | 2.5 % / 3 % / 6 % / 10 % | TP split 40/35/25 % of position |
| Commission | 0.05 % per side | Slippage 2 ticks |

## CPv6 → CPv7 changes to be aware of

When porting logic between versions, note that v7:
- Renamed `hist_l` to `_` (unused MACD histogram, suppresses the warning)
- Adds `iham` / `hang` / `pier` / `bhar` / `dclk` / `ahar` label rendering that v6 omits
- Wraps SL calculation in `f_sl_long(ep)` / `f_sl_short(ep)` functions (supports ATR mode)
- The armed state uses `la_bars` / `sa_bars` counters; modifying timeout behavior requires updating the increment and reset logic in all four places
