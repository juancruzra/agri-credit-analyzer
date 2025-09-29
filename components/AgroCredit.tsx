"use client";
import React, { useState } from "react";

/**
 * Agro Credit Optimizer — Demo (Next.js + TS)
 * - Constantes fijas: N=100k, GRID_STEPS=21, RHO_SOY=-0.05, RHO_CORN=-0.05
 * - Zonas: Núcleo, NEA
 * - Precios globales: Soja 320±15, Maíz 172.5±8.5 (USD/t)
 * - Base de crédito = Capital de trabajo (inputs+labores+arrendamiento*)
 * - Muestra: Insumos, Cap. Trabajo, Costo Total; Insights narrados, rango recomendado
 * - Semáforo por nivel de crédito: Verde (≥85%), Amarillo (≥75%), Rojo (<60%)
 */

const N = 100_000;
const GRID_STEPS = 21;
const RHO_SOY = -0.05;
const RHO_CORN = -0.05;
const TARGET_PROB = 0.85 as const;
const YELLOW_PROB = 0.75;
const RED_PROB = 0.60;

const ZONAL = [
  { zone: "Núcleo", crop: "soy",  yield_mean_qq: 40.0, yield_sd_qq: 5.0,  cost_total_mean: 1027.6, cost_total_sd: 120.0, cost_inputs_mean: 234.3, cost_inputs_sd: 50.0,  cost_labors_mean: 53.9,  cost_labors_sd: 15.0, cost_rent_mean: 520.1, cost_rent_sd: 70.0 },
  { zone: "Núcleo", crop: "corn", yield_mean_qq: 100.0, yield_sd_qq: 6.0,  cost_total_mean: 1491.0, cost_total_sd: 150.0, cost_inputs_mean: 470.9, cost_inputs_sd: 94.0,  cost_labors_mean: 53.9,  cost_labors_sd: 15.0, cost_rent_mean: 520.1, cost_rent_sd: 70.0 },
  { zone: "NEA",    crop: "soy",  yield_mean_qq: 26.0, yield_sd_qq: 3.0,  cost_total_mean:  584.8, cost_total_sd:  58.0, cost_inputs_mean: 277.1, cost_inputs_sd: 30.0,  cost_labors_mean: 85.1,  cost_labors_sd: 10.0, cost_rent_mean: 133.7, cost_rent_sd: 30.0 },
  { zone: "NEA",    crop: "corn", yield_mean_qq: 59.0, yield_sd_qq: 2.5,  cost_total_mean: 1071.3, cost_total_sd: 100.0, cost_inputs_mean: 442.1, cost_inputs_sd: 44.0,  cost_labors_mean: 76.1,  cost_labors_sd:  9.0, cost_rent_mean: 133.7, cost_rent_sd: 30.0 },
] as const;

const PRICES = {
  soy:  { price_mean: 320,   price_sd: 15 },
  corn: { price_mean: 172.5, price_sd: 8.5 },
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
function fmtMoney(x: number){ return Math.round(x).toLocaleString(); }
function pct(n: number){ return `${Math.round(n*100)}%`; }

type TableRow = { pct:number; credit_usd:number; prob_repay:number };
type Segment = { idxMin:number; idxMax:number; pctMin:number; pctMax:number; amtMin:number; amtMax:number };

function contiguousSegments(rows: TableRow[], predicate: (p:number)=>boolean, wcBase:number): Segment[] {
  const segs: Segment[] = [];
  let start = -1;
  for (let i=0; i<rows.length; i++){
    const ok = predicate(rows[i].prob_repay);
    if (ok && start === -1) start = i;
    if ((!ok || i === rows.length-1) && start !== -1){
      const end = ok && i === rows.length-1 ? i : i-1;
      const pctMin = rows[start].pct, pctMax = rows[end].pct;
      segs.push({
        idxMin:start, idxMax:end,
        pctMin, pctMax,
        amtMin: wcBase * pctMin,
        amtMax: wcBase * pctMax
      });
      start = -1;
    }
  }
  return segs;
}

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

    const { z1: zSoyY, z2: zSoyP } = corrNormals(N, RHO_SOY);
    const { z1: zCornY, z2: zCornP } = corrNormals(N, RHO_CORN);

    // SOJA
    const soyYieldQq = new Float64Array(N), soyPrice = new Float64Array(N);
    const soyCostInputs = new Float64Array(N), soyCostLabors = new Float64Array(N), soyCostRent = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      soyYieldQq[i]    = sampleNormal(zs.yield_mean_qq, zs.yield_sd_qq, zSoyY[i]);
      soyPrice[i]      = sampleNormal(ps.price_mean, ps.price_sd, zSoyP[i]);
      soyCostInputs[i] = sampleNormal(zs.cost_inputs_mean, zs.cost_inputs_sd, randn());
      soyCostLabors[i] = sampleNormal(zs.cost_labors_mean, zs.cost_labors_sd, randn());
      soyCostRent[i]   = hasRent ? sampleNormal(zs.cost_rent_mean, zs.cost_rent_sd, randn()) : 0;
    }
    const soyYieldTon = Array.from(soyYieldQq, v => v / 10);
    const soyRevenuePerHa = new Float64Array(N); for (let i = 0; i < N; i++) soyRevenuePerHa[i] = soyYieldTon[i] * soyPrice[i];

    // MAÍZ
    const cornYieldQq = new Float64Array(N), cornPrice = new Float64Array(N);
    const cornCostInputs = new Float64Array(N), cornCostLabors = new Float64Array(N), cornCostRent = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      cornYieldQq[i]    = sampleNormal(zc.yield_mean_qq, zc.yield_sd_qq, zCornY[i]);
      cornPrice[i]      = sampleNormal(pc.price_mean, pc.price_sd, zCornP[i]);
      cornCostInputs[i] = sampleNormal(zc.cost_inputs_mean, zc.cost_inputs_sd, randn());
      cornCostLabors[i] = sampleNormal(zc.cost_labors_mean, zc.cost_labors_sd, randn());
      cornCostRent[i]   = hasRent ? sampleNormal(zc.cost_rent_mean, zc.cost_rent_sd, randn()) : 0;
    }
    const cornYieldTon = Array.from(cornYieldQq, v => v / 10);
    const cornRevenuePerHa = new Float64Array(N); for (let i = 0; i < N; i++) cornRevenuePerHa[i] = cornYieldTon[i] * cornPrice[i];

    // Costos por ha (CT: inputs+labores+(rent?))
    const soyCostPerHa = new Float64Array(N), cornCostPerHa = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      soyCostPerHa[i]  = soyCostInputs[i]  + soyCostLabors[i]  + soyCostRent[i];
      cornCostPerHa[i] = cornCostInputs[i] + cornCostLabors[i] + cornCostRent[i];
    }

    // Márgenes por ha
    const soyMarginPerHa = new Float64Array(N), cornMarginPerHa = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      soyMarginPerHa[i]  = soyRevenuePerHa[i]  - soyCostPerHa[i];
      cornMarginPerHa[i] = cornRevenuePerHa[i] - cornCostPerHa[i];
    }

    // Totales por simulación
    const totalMargin = new Float64Array(N);
    for (let i = 0; i < N; i++) totalMargin[i] = soyMarginPerHa[i]*haSoy + cornMarginPerHa[i]*haCorn;

    // Necesidades (determinísticas por medias)
    const needInputsUSD = haSoy*zs.cost_inputs_mean + haCorn*zc.cost_inputs_mean;
    const wcSoy  = zs.cost_inputs_mean + zs.cost_labors_mean + (hasRent? zs.cost_rent_mean : 0);
    const wcCorn = zc.cost_inputs_mean + zc.cost_labors_mean + (hasRent? zc.cost_rent_mean : 0);
    const needWorkingCapUSD = haSoy*wcSoy + haCorn*wcCorn; // BASE de crédito
    const costTotalUSD = haSoy*zs.cost_total_mean + haCorn*zc.cost_total_mean;

    // Grilla de crédito (0..100% de capital de trabajo)
    const creditGridPct: number[] = [], creditGridAmt: number[] = [], repayProb: number[] = [];
    for (let s = 0; s < GRID_STEPS; s++) {
      const pct = s/(GRID_STEPS-1);
      const creditAmt = needWorkingCapUSD * pct;
      let repay = 0; for (let i = 0; i < N; i++) if (totalMargin[i] >= creditAmt) repay++;
      creditGridPct.push(pct); creditGridAmt.push(creditAmt); repayProb.push(repay/N);
    }

    // Rango recomendado (tramo continuo con prob ≥ objetivo)
    let bestStart=-1,bestEnd=-1,curStart=-1;
    for(let i=0;i<repayProb.length;i++){
      if(repayProb[i]>=TARGET_PROB){ if(curStart===-1) curStart=i; }
      else if(curStart!==-1){ if(bestStart===-1 || (i-1-curStart)>(bestEnd-bestStart)){ bestStart=curStart; bestEnd=i-1; } curStart=-1; }
    }
    if(curStart!==-1){ if(bestStart===-1 || (repayProb.length-1-curStart)>(bestEnd-bestStart)){ bestStart=curStart; bestEnd=repayProb.length-1; } }
    let maxIdx=-1; for(let i=0;i<repayProb.length;i++) if(repayProb[i] >= TARGET_PROB) maxIdx=i;

    const recommendation = (bestStart===-1)? null : {
      pctMin: creditGridPct[bestStart], pctMax: creditGridPct[bestEnd],
      amtMin: creditGridAmt[bestStart], amtMax: creditGridAmt[bestEnd],
      maxCreditPct: maxIdx>=0? creditGridPct[maxIdx] : null,
      maxCreditAmt: maxIdx>=0? creditGridAmt[maxIdx] : null,
    };

    // Semáforo por segmentos de crédito
    const rows: TableRow[] = creditGridAmt.map((amt,i)=>({pct:creditGridPct[i], credit_usd:amt, prob_repay:repayProb[i]}));
    const greenSegs  = contiguousSegments(rows, p => p >= TARGET_PROB,        needWorkingCapUSD);
    const yellowSegs = contiguousSegments(rows, p => p >= YELLOW_PROB && p < TARGET_PROB, needWorkingCapUSD);
    const redSegs    = contiguousSegments(rows, p => p < RED_PROB,            needWorkingCapUSD);

    // Insights (escenarios)
    const sorted = Array.from(totalMargin).sort((a,b)=>a-b);
    const q=(p:number)=> sorted[Math.min(sorted.length-1, Math.max(0, Math.floor(p*(sorted.length-1))))];
    const bad=q(0.05), typical=q(0.5), good=q(0.95);
    const prob_pos = sorted.filter(v=>v>0).length/sorted.length;

    setOut({
      zone, haSoy, haCorn, hasRent,
      needInputsUSD, needWorkingCapUSD, costTotalUSD,
      recommendation,
      semaforo: { greenSegs, yellowSegs, redSegs },
      insights: { bad, typical, good, prob_pos },
    });
    setIsRunning(false);
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl md:text-3xl font-semibold">Agro Credit Optimizer — Demo</h1>
        <div className="text-xs text-slate-500">Powered by Sembrala</div>
      </header>

      <section className="grid lg:grid-cols-3 gap-4">
        <div className="p-5 bg-white rounded-2xl shadow-sm border">
          <h2 className="font-medium mb-3">Zona y plan de siembra</h2>
          <div className="space-y-3 text-sm">
            <label className="block">Zona
              <select className="mt-1 w-full border rounded-xl px-3 py-2" value={zone} onChange={e=>setZone(e.target.value as Zone)}>
                <option>Núcleo</option>
                <option>NEA</option>
              </select>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">Soja (ha)
                <input type="text" inputMode="numeric" pattern="[0-9]*" value={haSoyStr} onChange={e=>setHaSoyStr(e.target.value.replace(/[^0-9]/g, ""))} className="mt-1 w-full border rounded-xl px-3 py-2" placeholder="0"/>
              </label>
              <label className="block">Maíz (ha)
                <input type="text" inputMode="numeric" pattern="[0-9]*" value={haCornStr} onChange={e=>setHaCornStr(e.target.value.replace(/[^0-9]/g, ""))} className="mt-1 w-full border rounded-xl px-3 py-2" placeholder="0"/>
              </label>
            </div>
            <label className="inline-flex items-center gap-2 mt-1">
              <input type="checkbox" checked={hasRent} onChange={e=>setHasRent(e.target.checked)} />
              <span>Arrendamiento (SI/NO)</span>
            </label>
            <button onClick={run} disabled={isRunning} className="mt-3 w-full px-4 py-2 rounded-2xl bg-slate-900 text-white hover:opacity-90 disabled:opacity-50">{isRunning? "Corriendo…" : "Correr simulación"}</button>
          </div>
        </div>

        <div className="p-5 bg-gradient-to-br from-sky-50 to-emerald-50 rounded-2xl border shadow-sm">
          <h2 className="font-medium mb-3">Necesidades y costos</h2>
          {out ? (
            <div className="grid gap-3 text-sm">
              <InfoRow label="Insumos (USD)">$ {fmtMoney(out.needInputsUSD)}</InfoRow>
              <InfoRow label="Capital de trabajo (USD)">$ {fmtMoney(out.needWorkingCapUSD)}</InfoRow>
              <InfoRow label="Costo total (USD)">$ {fmtMoney(out.costTotalUSD)}</InfoRow>
              <InfoRow label="Escenarios en positivo">{(out.insights.prob_pos*100).toFixed(1)}%</InfoRow>
            </div>
          ) : (
            <div className="text-xs text-slate-600">Corre la simulación para ver resultados…</div>
          )}
        </div>

        <div className="p-5 bg-white rounded-2xl shadow-sm border">
          <h2 className="font-medium mb-3">Cómo podría ir la campaña</h2>
          {out ? (
            <div className="space-y-2 text-sm">
              <p><b>Año complicado:</b> ~<b>$ {fmtMoney(out.insights.bad)}</b>.</p>
              <p><b>Año típico:</b> ~<b>$ {fmtMoney(out.insights.typical)}</b>.</p>
              <p><b>Año muy bueno:</b> hasta ~<b>$ {fmtMoney(out.insights.good)}</b>.</p>
            </div>
          ) : (
            <div className="text-xs text-slate-600">Acá verás resultados claros (sin p5/p50/p95).</div>
          )}
        </div>
      </section>

      {out && (
        <section className="grid lg:grid-cols-2 gap-4 mt-4">
          <div className="p-5 bg-white rounded-2xl shadow-sm border">
            <h3 className="font-medium mb-2">Rango óptimo de crédito</h3>
            {out.recommendation ? (
              <div className="text-sm space-y-1">
                <p>Prob. objetivo ≥ <b>{Math.round(TARGET_PROB*100)}%</b></p>
                <p>Rango recomendado: <b>{pct(out.recommendation.pctMin)} – {pct(out.recommendation.pctMax)}</b> de capital de trabajo</p>
                <p>Equivalente a: <b>$ {fmtMoney(out.recommendation.amtMin)} – $ {fmtMoney(out.recommendation.amtMax)}</b></p>
                {out.recommendation.maxCreditAmt !== null && (
                  <p className="text-base"><b>Crédito máximo que cumple objetivo: $ {fmtMoney(out.recommendation.maxCreditAmt)}</b></p>
                )}
              </div>
            ) : (
              <p className="text-sm">Ningún nivel de crédito cumple el objetivo actual.</p>
            )}
          </div>

          <div className="p-5 bg-white rounded-2xl shadow-sm border">
            <h3 className="font-medium mb-3">Semáforo por nivel de crédito</h3>

            {/* Verde ≥85% */}
            <TrafficBlock
              title="Verde (≥85% de prob. repago)"
              colorClass="bg-emerald-500/15 text-emerald-800 border-emerald-200"
              segments={out.semaforo.greenSegs}
            />

            {/* Amarillo ≥75% y <85% */}
            <TrafficBlock
              title="Amarillo (≥75% y <85%)"
              colorClass="bg-amber-500/15 text-amber-800 border-amber-200"
              segments={out.semaforo.yellowSegs}
            />

            {/* Rojo <60% */}
            <TrafficBlock
              title="Rojo (<60%)"
              colorClass="bg-rose-500/15 text-rose-800 border-rose-200"
              segments={out.semaforo.redSegs}
            />
          </div>
        </section>
      )}
    </div>
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }){
  return (
    <div className="flex items-center justify-between bg-white/60 rounded-xl px-3 py-2 border shadow-sm">
      <span className="text-slate-500 text-xs">{label}</span>
      <span className="font-semibold">{children}</span>
    </div>
  );
}

function TrafficBlock({
  title, colorClass, segments
}: {
  title: string;
  colorClass: string;
  segments: Segment[];
}){
  return (
    <div className={`mt-3 rounded-xl border p-3 ${colorClass}`}>
      <div className="text-sm font-medium mb-2">{title}</div>
      {segments.length ? (
        <div className="flex flex-wrap gap-2">
          {segments.map((s, i) => (
            <span key={i} className="inline-flex items-center gap-1 rounded-full bg-white/50 px-3 py-1 text-xs border">
              {pct(s.pctMin)}–{pct(s.pctMax)} · $ {fmtMoney(s.amtMin)}–$ {fmtMoney(s.amtMax)}
            </span>
          ))}
        </div>
      ) : (
        <div className="text-xs opacity-70">Sin niveles en este rango.</div>
      )}
    </div>
  );
}
