"use client";
import React, { useState } from "react";

/**
 * Agro Credit Optimizer — Demo (Next.js + TS)
 * Cambios:
 * - Rinde con asimetría: sdDown (cola bajista) y sdUp (cola alcista) usando el mismo z para conservar correlación.
 * - Shock bajista: con prob p reduce el rinde por un factor (o a cero). Ajustable por cultivo.
 * - Repago por waterfall (primero Rest, luego crédito); tope de crédito = INSUMOS.
 * - Semáforo (verde/amarillo/rojo) y “Crédito máximo que cumple objetivo”.
 */

const N = 100_000;
const GRID_STEPS = 21;
const RHO_SOY = -0.05;
const RHO_CORN = -0.05;
const TARGET_PROB = 0.85 as const;
const RED_PROB = 0.60;
const RATE = 0.06; // tasa efectiva de la campaña (6%) — oculta en el front

// ---- Parámetros de asimetría y shock (AJUSTABLES) ----
// sdDown > sdUp para "cargar" más volatilidad hacia abajo
const YIELD_SD_SOY_DOWN = 12;  // qq/ha
const YIELD_SD_SOY_UP   = 4;   // qq/ha
const YIELD_SD_CORN_DOWN = 19; // qq/ha
const YIELD_SD_CORN_UP   = 5;  // qq/ha

// Shock bajista: probabilidad y severidad por cultivo
const SOY_SHOCK_PROB   = 0.04; // 4% campañas con shock
const SOY_SHOCK_FACTOR = 0.45; // rinde *= 0.55 (55% queda)
const CORN_SHOCK_PROB   = 0.03;
const CORN_SHOCK_FACTOR = 0.45;

// Si querés pérdidas totales en algunos shocks, podés modelarlo combinando:
// p_totalLoss y/o un mix de factores. Mantengo simple con un único factor.
function applyDownsideShock(base: number, p: number, factor: number) {
  if (Math.random() < p) return Math.max(0, base * factor);
  return base;
}

const ZONAL = [
  { zone: "Núcleo", crop: "soy",  yield_mean_qq: 40.0, yield_sd_qq: 5.0,  cost_total_mean: 1027.6, cost_total_sd: 120.0, cost_inputs_mean: 234.3, cost_inputs_sd: 50.0,  cost_labors_mean: 53.9,  cost_labors_sd: 15.0, cost_rent_mean: 520.1, cost_rent_sd: 70.0 },
  { zone: "Núcleo", crop: "corn", yield_mean_qq: 100.0, yield_sd_qq: 6.0,  cost_total_mean: 1491.0, cost_total_sd: 150.0, cost_inputs_mean: 470.9, cost_inputs_sd: 94.0,  cost_labors_mean: 53.9,  cost_labors_sd: 15.0, cost_rent_mean: 520.1, cost_rent_sd: 70.0 },
  { zone: "NEA",    crop: "soy",  yield_mean_qq: 26.0, yield_sd_qq: 3.0,  cost_total_mean:  584.8, cost_total_sd:  58.0, cost_inputs_mean: 277.1, cost_inputs_sd: 30.0,  cost_labors_mean: 85.1,  cost_labors_sd: 10.0, cost_rent_mean: 133.7, cost_rent_sd: 30.0 },
  { zone: "NEA",    crop: "corn", yield_mean_qq: 59.0, yield_sd_qq: 3.5,  cost_total_mean: 1071.3, cost_total_sd: 100.0, cost_inputs_mean: 442.1, cost_inputs_sd: 44.0,  cost_labors_mean: 76.1,  cost_labors_sd:  9.0, cost_rent_mean: 133.7, cost_rent_sd: 30.0 },
] as const;

const PRICES = {
  soy:  { price_mean: 320,   price_sd: 20 },
  corn: { price_mean: 172.5, price_sd: 13 },
} as const;

type Zone = "Núcleo" | "NEA";
type Crop = "soy" | "corn";
type Row = (typeof ZONAL)[number];

function getRow(zone: Zone, crop: Crop): Row {
  const r = ZONAL.find(r => r.zone === zone && r.crop === crop);
  if (!r) throw new Error("Fila zonal no encontrada");
  return r;
}

function randn() {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function corrNormals(n: number, rho: number) {
  const z1 = new Float64Array(n), z2 = new Float64Array(n);
  for (let i = 0; i < n; i++) { const a = randn(), b = randn(); z1[i] = a; z2[i] = rho * a + Math.sqrt(1 - rho * rho) * b; }
  return { z1, z2 };
}
function sampleNormal(mean: number, sd: number, z: number) {
  const x = mean + sd * z; return x < 0 ? 0 : x;
}
// NORMAL ASIMÉTRICA (two-piece): usa el MISMO z que ya viene correlacionado
function sampleAsymNormal(mean: number, sdDown: number, sdUp: number, z: number) {
  const sd = z < 0 ? sdDown : sdUp;
  const x = mean + sd * z;
  return x < 0 ? 0 : x;
}

function fmtMoney(x: number){ return Math.round(x).toLocaleString(); }
function pct(n: number){ return `${Math.round(n*100)}%`; }

export default function AgroCredit(){
  const [zone, setZone] = useState<Zone>("Núcleo");
  const [hasRent, setHasRent] = useState<boolean>(true);
  const [haSoyStr, setHaSoyStr] = useState<string>("200");
  const [haCornStr, setHaCornStr] = useState<string>("150");
  const haSoy = Math.max(0, Number(haSoyStr || 0));
  const haCorn = Math.max(0, Number(haCornStr || 0));

  const [isRunning, setIsRunning] = useState(false);
  const [out, setOut] = useState<any|null>(null);

  function run(){
    setIsRunning(true);

    const zs = getRow(zone, "soy");
    const zc = getRow(zone, "corn");
    const ps = PRICES.soy, pc = PRICES.corn;

    // Correlaciones rinde-precio por cultivo
    const { z1: zSoyY, z2: zSoyP } = corrNormals(N, RHO_SOY);
    const { z1: zCornY, z2: zCornP } = corrNormals(N, RHO_CORN);

    // SOJA (por ha)
    const soyYieldQq = new Float64Array(N), soyPrice = new Float64Array(N);
    const soyCostInputs = new Float64Array(N), soyCostLabors = new Float64Array(N), soyCostRent = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      // Asimetría + shock bajista (usa zSoyY para mantener correlación con precio)
      let yqq = sampleAsymNormal(zs.yield_mean_qq, YIELD_SD_SOY_DOWN, YIELD_SD_SOY_UP, zSoyY[i]);
      yqq = applyDownsideShock(yqq, SOY_SHOCK_PROB, SOY_SHOCK_FACTOR);
      soyYieldQq[i]    = yqq;

      soyPrice[i]      = sampleNormal(ps.price_mean, ps.price_sd, zSoyP[i]);
      soyCostInputs[i] = sampleNormal(zs.cost_inputs_mean, zs.cost_inputs_sd, randn());
      soyCostLabors[i] = sampleNormal(zs.cost_labors_mean, zs.cost_labors_sd, randn());
      soyCostRent[i]   = hasRent ? sampleNormal(zs.cost_rent_mean, zs.cost_rent_sd, randn()) : 0;
    }
    const soyYieldTon = Array.from(soyYieldQq, v => v / 10);
    const soyRevenuePerHa = new Float64Array(N); for (let i = 0; i < N; i++) soyRevenuePerHa[i] = soyYieldTon[i] * soyPrice[i];

    // MAÍZ (por ha)
    const cornYieldQq = new Float64Array(N), cornPrice = new Float64Array(N);
    const cornCostInputs = new Float64Array(N), cornCostLabors = new Float64Array(N), cornCostRent = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      let yqq = sampleAsymNormal(zc.yield_mean_qq, YIELD_SD_CORN_DOWN, YIELD_SD_CORN_UP, zCornY[i]);
      yqq = applyDownsideShock(yqq, CORN_SHOCK_PROB, CORN_SHOCK_FACTOR);
      cornYieldQq[i]    = yqq;

      cornPrice[i]      = sampleNormal(pc.price_mean, pc.price_sd, zCornP[i]);
      cornCostInputs[i] = sampleNormal(zc.cost_inputs_mean, zc.cost_inputs_sd, randn());
      cornCostLabors[i] = sampleNormal(zc.cost_labors_mean, zc.cost_labors_sd, randn());
      cornCostRent[i]   = hasRent ? sampleNormal(zc.cost_rent_mean, zc.cost_rent_sd, randn()) : 0;
    }
    const cornYieldTon = Array.from(cornYieldQq, v => v / 10);
    const cornRevenuePerHa = new Float64Array(N); for (let i = 0; i < N; i++) cornRevenuePerHa[i] = cornYieldTon[i] * cornPrice[i];

    // COSTOS por ha
    const soyCostRestPerHa = new Float64Array(N); // labores + arrendamiento
    const cornCostRestPerHa = new Float64Array(N);
    const soyCostTotalPerHa = new Float64Array(N);
    const cornCostTotalPerHa = new Float64Array(N);
    for (let i=0;i<N;i++){
      soyCostRestPerHa[i]  = soyCostLabors[i]  + soyCostRent[i];
      cornCostRestPerHa[i] = cornCostLabors[i] + cornCostRent[i];
      soyCostTotalPerHa[i] = soyCostInputs[i]  + soyCostRestPerHa[i];
      cornCostTotalPerHa[i]= cornCostInputs[i] + cornCostRestPerHa[i];
    }

    // TOTALES por simulación
    const totalRevenue = new Float64Array(N);
    const totalInputs  = new Float64Array(N);
    const totalRest    = new Float64Array(N);
    const totalCosts   = new Float64Array(N);
    const totalMargin  = new Float64Array(N); // para p5/p50/p95 (insights)
    for (let i=0;i<N;i++){
      const R = soyRevenuePerHa[i]*haSoy + cornRevenuePerHa[i]*haCorn;
      const INP = soyCostInputs[i]*haSoy + cornCostInputs[i]*haCorn;
      const REST = soyCostRestPerHa[i]*haSoy + cornCostRestPerHa[i]*haCorn;
      const C = INP + REST;
      totalRevenue[i]=R; totalInputs[i]=INP; totalRest[i]=REST; totalCosts[i
