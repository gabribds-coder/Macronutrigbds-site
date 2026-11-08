/* MacroNutri GBDS — app de macros com ciclo de proteína isocalórico,
   água e fibra dinâmicas, e acompanhamento de peso/composição corporal.
   Tudo fica salvo no próprio aparelho (localStorage). */
"use strict";

// ---------- Utilidades ----------
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const r0 = (n) => Math.round(n);
const r1 = (n) => Math.round(n * 10) / 10;
const iso = (d) => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 10); };
const parseISO = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseISO(s); d.setDate(d.getDate() + n); return iso(d); };
const diffDays = (a, b) => Math.round((parseISO(b) - parseISO(a)) / 86400000);
const norm = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const fmtDate = (s) => parseISO(s).toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit" });
const TODAY = iso(new Date());

// ---------- Estado ----------
const KEY = "macronutri-gbds-v1";
const DEFAULT = {
  profile: { sex: "m", age: 30, height: 175, weight: 80, bf: "", activity: 1.55, goalPct: -15, refWeight: "atual", goalWeight: "", trainMin: 60 },
  cycle: {
    start: TODAY, daysPerPhase: 2, fatMinGkg: 0.5, carbMin: 50,
    // Cada fase define proteína e gordura (g/kg); o carboidrato completa as calorias.
    phases: [
      { name: "P Alta · C Baixo", prot: 2.6, fat: 1.0 },
      { name: "Moderado", prot: 2.2, fat: 0.8 },
      { name: "P Base · C Alto", prot: 1.8, fat: 0.6 }
    ]
  },
  useAdaptive: true, manualKcal: "",
  logs: {}, weights: {}, customFoods: []
};
let S = load();
let curDate = TODAY;
let tab = "hoje";

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULT);
    const s = JSON.parse(raw);
    if (s.cycle?.phases) { // migração da versão anterior (gordura única para todas as fases)
      const old = ["Proteína Alta", "Proteína Moderada", "Proteína Base"];
      if (s.cycle.phases.length === 3 && s.cycle.phases.every((p, i) => p.name === old[i] && p.fat == null)) s.cycle.phases = structuredClone(DEFAULT.cycle.phases);
      s.cycle.phases.forEach((p) => { if (p.fat == null) p.fat = Number(s.cycle.fatGkg) || 0.8; });
      delete s.cycle.fatGkg;
    }
    return { ...structuredClone(DEFAULT), ...s, profile: { ...DEFAULT.profile, ...s.profile }, cycle: { ...DEFAULT.cycle, ...s.cycle } };
  } catch { return structuredClone(DEFAULT); }
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { alert("Não foi possível salvar: " + e.message); } }
const dayLog = (d) => (S.logs[d] ||= { foods: [], water: 0, bristol: null, trained: false });
const allFoods = () => [...S.customFoods, ...FOODS];

// ---------- Peso: tendência (média móvel exponencial) ----------
function weightSeries() {
  const dates = Object.keys(S.weights).filter((d) => S.weights[d].kg).sort();
  if (!dates.length) return [];
  const out = []; let trend = null;
  for (let d = dates[0]; d <= dates[dates.length - 1]; d = addDays(d, 1)) {
    const w = S.weights[d]?.kg ? Number(S.weights[d].kg) : null;
    if (w != null) trend = trend == null ? w : trend + 0.1 * (w - trend);
    out.push({ date: d, kg: w, trend });
  }
  return out;
}
function currentWeight() {
  const ser = weightSeries();
  return ser.length ? ser[ser.length - 1].trend : Number(S.profile.weight);
}
function navyBF(sex, h, waist, neck, hip) {
  if (!h || !waist || !neck) return null;
  if (sex === "m") { if (waist - neck <= 0) return null; return 495 / (1.0324 - 0.19077 * Math.log10(waist - neck) + 0.15456 * Math.log10(h)) - 450; }
  if (!hip || waist + hip - neck <= 0) return null;
  return 495 / (1.29579 - 0.35004 * Math.log10(waist + hip - neck) + 0.221 * Math.log10(h)) - 450;
}
function bfFor(entry) {
  if (!entry) return null;
  if (entry.bf) return Number(entry.bf);
  const v = navyBF(S.profile.sex, Number(S.profile.height), Number(entry.waist), Number(entry.neck), Number(entry.hip));
  return v ? r1(v) : null;
}
function latestBF() {
  const ds = Object.keys(S.weights).sort().reverse();
  for (const d of ds) { const b = bfFor(S.weights[d]); if (b) return b; }
  return S.profile.bf ? Number(S.profile.bf) : null;
}

// ---------- Gasto energético ----------
function bmr() {
  const p = S.profile, w = currentWeight(), bf = latestBF();
  if (bf) return 370 + 21.6 * w * (1 - bf / 100); // Katch-McArdle (usa massa magra)
  return 10 * w + 6.25 * Number(p.height) - 5 * Number(p.age) + (p.sex === "m" ? 5 : -161); // Mifflin-St Jeor
}
const formulaTDEE = () => bmr() * Number(S.profile.activity);
const dayKcal = (d) => (S.logs[d]?.foods || []).reduce((a, f) => a + f.kcal, 0);

// TDEE adaptativo: compara o que você comeu com a variação real da tendência de peso (últimos 21 dias)
function adaptiveTDEE() {
  const ser = weightSeries(); if (ser.length < 14) return null;
  const end = ser[ser.length - 1].date, start = addDays(end, -20);
  const win = ser.filter((x) => x.date >= start);
  const weighIns = win.filter((x) => x.kg != null).length;
  const logged = []; for (let d = start; d <= end; d = addDays(d, 1)) if ((S.logs[d]?.foods || []).length) logged.push(dayKcal(d));
  if (weighIns < 8 || logged.length < 10) return null;
  const days = diffDays(win[0].date, end) || 1;
  const delta = win[win.length - 1].trend - win[0].trend;
  const avg = logged.reduce((a, b) => a + b, 0) / logged.length;
  return { tdee: avg - (delta * 7700) / days, avgIntake: avg, deltaKg: delta, days, weighIns, logged: logged.length };
}

function kcalTarget() {
  if (S.manualKcal) return { kcal: Number(S.manualKcal), src: "manual" };
  const ad = S.useAdaptive ? adaptiveTDEE() : null;
  const tdee = ad ? ad.tdee : formulaTDEE();
  return { kcal: Math.round((tdee * (1 + Number(S.profile.goalPct) / 100)) / 10) * 10, src: ad ? "adaptativo" : "fórmula", tdee };
}

// ---------- Ciclo de proteína (isocalórico) ----------
function phaseIndex(d) {
  const c = S.cycle, n = c.phases.length, len = Math.max(1, Number(c.daysPerPhase));
  const k = Math.floor(diffDays(c.start, d) / len);
  return ((k % n) + n) % n;
}
function refWeight() {
  const p = S.profile;
  return p.refWeight === "meta" && Number(p.goalWeight) ? Number(p.goalWeight) : currentWeight();
}
// Ajuste intestinal com base na escala de Bristol dos últimos 3 dias registrados
function gutStatus(d) {
  const vals = [];
  for (let i = 0; i < 3; i++) { const b = S.logs[addDays(d, -i)]?.bristol; if (b) vals.push(b); }
  if (!vals.length) return { state: "sem", fib: 0, water: 0 };
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  if (avg <= 2.5) return { state: "preso", fib: 5, water: 500, avg };
  if (avg >= 5.5) return { state: "solto", fib: -5, water: 500, avg };
  return { state: "ok", fib: 0, water: 0, avg };
}
function targets(d) {
  const c = S.cycle, w = refWeight(), bw = currentWeight();
  const { kcal, src } = kcalTarget();
  const ph = c.phases[phaseIndex(d)];
  const P = ph.prot * w;
  let F = Number(ph.fat ?? 0.8) * w;
  let C = (kcal - 4 * P - 9 * F) / 4;
  const notes = [];
  if (C < Number(c.carbMin)) { // tira de gordura até o piso para preservar um mínimo de carbo
    const need = (Number(c.carbMin) - C) * 4;
    const newF = Math.max(Number(c.fatMinGkg) * w, F - need / 9);
    C += ((F - newF) * 9) / 4; F = newF;
    notes.push("Gordura reduzida para manter carboidrato mínimo.");
  }
  if (C < 0) { C = 0; notes.push("Calorias insuficientes para essa proteína + gordura mínima. Revise o plano."); }
  const gut = gutStatus(d);
  const trained = S.logs[d]?.trained;
  // Água: 35 ml/kg + 7 ml por g de proteína acima de 1,6 g/kg (excreção de ureia) + treino + ajuste intestinal
  const water = 35 * bw + Math.max(0, P - 1.6 * bw) * 7 + (trained ? (Number(S.profile.trainMin) / 60) * 500 : 0) + gut.water;
  // Fibra: 14 g/1000 kcal (IOM), mínimo 25 g (mulher) / 30 g (homem), teto 50 g
  const fibBase = Math.max(S.profile.sex === "m" ? 30 : 25, (14 * kcal) / 1000);
  const fib = Math.min(50, Math.max(20, fibBase + gut.fib));
  return { kcal, src, phase: ph, idx: phaseIndex(d), P: r0(P), C: r0(C), F: r0(F), water: Math.round(water / 50) * 50, fib: r0(fib), gut, notes, trained };
}
function phaseMacros(ph) {
  const w = refWeight(), { kcal } = kcalTarget();
  const P = ph.prot * w, F = ph.fat * w, C = Math.max(0, (kcal - 4 * P - 9 * F) / 4);
  return { kcal, P: r0(P), F: r0(F), C: r0(C), Ckg: r1(C / w) };
}
const phCarbHtml = (m) => `<b style="font-size:15px;display:inline;color:${m.C < Number(S.cycle.carbMin) ? "var(--prot)" : "inherit"}">${m.C} g</b> <span>${m.Ckg} g/kg</span>`;
const phSumHtml = (m) => `${m.kcal} kcal → P ${m.P} g · C ${m.C} g · G ${m.F} g`;
function consumed(d) {
  return (S.logs[d]?.foods || []).reduce((a, f) => ({ kcal: a.kcal + f.kcal, p: a.p + f.p, c: a.c + f.c, f: a.f + f.f, fib: a.fib + f.fib }), { kcal: 0, p: 0, c: 0, f: 0, fib: 0 });
}
function daysUntilChange(d) {
  const len = Math.max(1, Number(S.cycle.daysPerPhase));
  const pos = ((diffDays(S.cycle.start, d) % len) + len) % len;
  return len - pos;
}

// ---------- Componentes ----------
function bar(label, val, goal, color, unit = "g") {
  const pct = goal > 0 ? (val / goal) * 100 : 0;
  return `<div class="bar"><div class="lbl"><span>${label}</span><span><b>${r0(val)}</b> / ${r0(goal)} ${unit}</span></div>
    <div class="track"><div class="fill ${pct > 105 ? "over" : ""}" style="width:${Math.min(100, pct)}%;background:${color}"></div></div></div>`;
}
function lineChart(series, opts = {}) {
  const pts = series.flatMap((s) => s.data.filter((p) => p.y != null));
  if (pts.length < 2) return `<p class="muted">Registre pelo menos 2 dias para ver o gráfico.</p>`;
  const W = 400, H = 220, pad = 40;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs) || x0 + 1;
  let y0 = Math.min(...ys), y1 = Math.max(...ys); const m = (y1 - y0) * 0.1 || 1; y0 -= m; y1 += m;
  const X = (x) => pad + ((x - x0) / (x1 - x0 || 1)) * (W - pad - 8), Y = (y) => H - 20 - ((y - y0) / (y1 - y0)) * (H - 30);
  let g = "";
  for (let i = 0; i <= 3; i++) { const v = y0 + ((y1 - y0) * i) / 3; g += `<line x1="${pad}" x2="${W - 8}" y1="${Y(v)}" y2="${Y(v)}" stroke="currentColor" opacity=".12"/><text x="2" y="${Y(v) + 4}" font-size="13" fill="currentColor" opacity=".6">${r1(v)}</text>`; }
  for (const s of series) {
    const d = s.data.filter((p) => p.y != null);
    if (s.dots) g += d.map((p) => `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="2.5" fill="${s.color}" opacity=".55"/>`).join("");
    else g += `<polyline fill="none" stroke="${s.color}" stroke-width="2.5" stroke-linejoin="round" points="${d.map((p) => `${X(p.x)},${Y(p.y)}`).join(" ")}"/>`;
  }
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label || "gráfico")}" style="color:var(--text)">${g}</svg>`;
}

// ---------- Telas ----------
function viewHoje() {
  const t = targets(curDate), c = consumed(curDate), L = dayLog(curDate);
  const left = Math.max(0, t.kcal - c.kcal);
  const dleft = daysUntilChange(curDate);
  const next = S.cycle.phases[(t.idx + 1) % S.cycle.phases.length];
  const gutMsg = {
    sem: `<div class="tip ok">Registre como foi o intestino hoje (escala de Bristol) para o app ajustar fibra e água.</div>`,
    ok: `<div class="tip ok">Intestino regulado (média ${r1(t.gut.avg)}). Mantenha fibra e água.</div>`,
    preso: `<div class="tip warn"><b>Intestino preso</b> (média ${r1(t.gut.avg)}): meta de fibra +5 g e água +500 ml. Priorize fibra solúvel com bastante água: aveia, chia/linhaça hidratadas, psyllium, kiwi, ameixa seca, mamão, feijão. Aumente a fibra aos poucos.</div>`,
    solto: `<div class="tip warn"><b>Intestino solto</b> (média ${r1(t.gut.avg)}): fibra −5 g (corte principalmente casca/folhas cruas/farelos), mantenha fibra solúvel (aveia, banana, batata) e reponha água +500 ml. Se persistir mais de 2 dias ou tiver sangue/febre, procure um médico.</div>`
  }[t.gut.state];
  return `
  <section class="card">
    <div class="row" style="justify-content:space-between"><span class="phase" style="flex:0 0 auto">${esc(t.phase.name)}</span>
      <span class="muted" style="text-align:right">muda em ${dleft} dia(s) → ${esc(next.name)}</span></div>
    <div class="grid2" style="margin-top:12px">
      <div><div class="muted">Restam</div><div class="big">${r0(left)} kcal</div><div class="muted">meta ${t.kcal} kcal (${t.src})</div></div>
      <div><div class="muted">Consumido</div><div class="big">${r0(c.kcal)}</div><div class="muted">kcal</div></div>
    </div>
    ${bar("Proteína", c.p, t.P, "var(--prot)")}
    ${bar("Carboidrato", c.c, t.C, "var(--carb)")}
    ${bar("Gordura", c.f, t.F, "var(--fat)")}
    ${bar("Fibra", c.fib, t.fib, "var(--fib)")}
    ${t.notes.map((n) => `<div class="tip warn">${esc(n)}</div>`).join("")}
  </section>

  <section class="card">
    <h2>Água — meta ${(t.water / 1000).toFixed(2)} L</h2>
    ${bar("Bebido", L.water, t.water, "var(--water)", "ml")}
    <div class="row">
      <button class="btn sm" data-water="250">+250 ml</button><button class="btn sm" data-water="500">+500 ml</button>
      <button class="btn sm" data-water="750">+750 ml</button><button class="btn sm sec" data-water="-250">−250</button>
    </div>
    <label style="display:flex;gap:8px;align-items:center;margin-top:10px;color:var(--text)"><input type="checkbox" id="trained" style="width:auto" ${L.trained ? "checked" : ""}> Treinei hoje (+${r0((S.profile.trainMin / 60) * 500)} ml)</label>
    <p class="muted">A meta de água sobe nos dias de proteína alta (mais ureia para eliminar), em dias de treino e quando o intestino está desregulado.</p>
  </section>

  <section class="card">
    <h2>Intestino hoje (escala de Bristol)</h2>
    <div class="bristol">${[1, 2, 3, 4, 5, 6, 7].map((n) => `<button data-bristol="${n}" class="${L.bristol === n ? "on" : ""}">${n}</button>`).join("")}</div>
    <p class="muted">1–2 = preso/ressecado · 3–4 = ideal · 5 = mole · 6–7 = diarreia</p>
    ${gutMsg}
  </section>

  <section class="card"><button class="btn" style="width:100%" data-go="diario">+ Adicionar alimento</button></section>`;
}

let pick = null;
function viewDiario() {
  const L = dayLog(curDate), t = targets(curDate), c = consumed(curDate);
  const meals = ["Café da manhã", "Almoço", "Lanche", "Jantar", "Ceia"];
  const byMeal = meals.map((m) => {
    const items = L.foods.map((f, i) => ({ ...f, i })).filter((f) => f.meal === m);
    if (!items.length) return "";
    return `<h3>${m} · ${r0(items.reduce((a, f) => a + f.kcal, 0))} kcal</h3><ul class="list">${items.map((f) => `
      <li><div><div>${esc(f.name)} <span class="muted">${f.g} g</span></div>
      <div class="muted">${r0(f.kcal)} kcal · P ${r1(f.p)} · C ${r1(f.c)} · G ${r1(f.f)} · Fib ${r1(f.fib)}</div></div>
      <button class="x" data-del="${f.i}" aria-label="Remover">×</button></li>`).join("")}</ul>`;
  }).join("");
  return `
  <section class="card">
    <h2>Adicionar alimento</h2>
    <p class="muted">Liberdade total: escolha qualquer alimento. O app mostra quanto ainda cabe no seu dia.</p>
    <input id="q" placeholder="Buscar (ex: frango, arroz, banana)" autocomplete="off">
    <div class="results" id="res"></div>
    <div id="pickBox"></div>
  </section>
  <section class="card">
    <h2>Restante do dia</h2>
    <div class="grid3">
      <div class="stat"><b>${r0(t.kcal - c.kcal)}</b><span>kcal</span></div>
      <div class="stat"><b style="color:var(--prot)">${r0(t.P - c.p)} g</b><span>proteína</span></div>
      <div class="stat"><b style="color:var(--carb)">${r0(t.C - c.c)} g</b><span>carboidrato</span></div>
      <div class="stat"><b style="color:var(--fat)">${r0(t.F - c.f)} g</b><span>gordura</span></div>
      <div class="stat"><b style="color:var(--fib)">${r0(t.fib - c.fib)} g</b><span>fibra</span></div>
      <div class="stat"><b>${esc(t.phase.name.replace("Proteína ", ""))}</b><span>fase</span></div>
    </div>
  </section>
  <section class="card"><h2>Refeições de ${fmtDate(curDate)}</h2>${byMeal || `<p class="muted">Nada registrado ainda.</p>`}
    ${L.foods.length ? `<div class="row" style="margin-top:10px"><button class="btn sm sec" id="copyPrev">Copiar refeições de ontem</button></div>` : `<div class="row" style="margin-top:10px"><button class="btn sm sec" id="copyPrev">Copiar refeições de ontem</button></div>`}
  </section>
  <section class="card">
    <h2>Cadastrar alimento personalizado</h2>
    <p class="muted">Use o rótulo do produto. Valores por 100 g.</p>
    <label>Nome</label><input id="cfName">
    <div class="grid3">
      <div><label>kcal</label><input id="cfK" type="number" step="any"></div>
      <div><label>Proteína</label><input id="cfP" type="number" step="any"></div>
      <div><label>Carbo</label><input id="cfC" type="number" step="any"></div>
      <div><label>Gordura</label><input id="cfF" type="number" step="any"></div>
      <div><label>Fibra</label><input id="cfFib" type="number" step="any"></div>
    </div>
    <div class="row" style="margin-top:10px"><button class="btn" id="cfSave">Salvar alimento</button></div>
    ${S.customFoods.length ? `<h3>Seus alimentos</h3><ul class="list">${S.customFoods.map((f) => `<li><span>${esc(f.name)} <span class="muted">${f.kcal} kcal/100 g</span></span><button class="x" data-delcf="${f.id}">×</button></li>`).join("")}</ul>` : ""}
  </section>`;
}
function renderResults(q) {
  const box = $("#res"); if (!box) return;
  const nq = norm(q.trim());
  const list = allFoods().filter((f) => !nq || norm(f.name).includes(nq)).slice(0, 40);
  box.innerHTML = list.map((f) => `<div data-pick="${f.id}"><b>${esc(f.name)}</b><br><span class="muted">${f.kcal} kcal · P ${f.p} · C ${f.c} · G ${f.f} · Fib ${f.fib} (100 g)</span></div>`).join("") || `<div class="muted">Nada encontrado. Cadastre abaixo como alimento personalizado.</div>`;
}
function renderPick() {
  const box = $("#pickBox"); if (!box) return;
  if (!pick) { box.innerHTML = ""; return; }
  const f = allFoods().find((x) => x.id === pick.id); if (!f) return;
  const g = Number(pick.g) || 0, k = g / 100;
  const hour = new Date().getHours();
  const defMeal = pick.meal || (hour < 10 ? "Café da manhã" : hour < 15 ? "Almoço" : hour < 18 ? "Lanche" : hour < 22 ? "Jantar" : "Ceia");
  box.innerHTML = `<h3>${esc(f.name)}</h3>
    <div class="grid2"><div><label>Quantidade (g ou ml)</label><input id="pg" type="number" inputmode="decimal" value="${g}"></div>
    <div><label>Refeição</label><select id="pm">${["Café da manhã", "Almoço", "Lanche", "Jantar", "Ceia"].map((m) => `<option ${m === defMeal ? "selected" : ""}>${m}</option>`).join("")}</select></div></div>
    <p><b>${r0(f.kcal * k)} kcal</b> · P ${r1(f.p * k)} g · C ${r1(f.c * k)} g · G ${r1(f.f * k)} g · Fib ${r1(f.fib * k)} g</p>
    <button class="btn" id="addFood" style="width:100%">Adicionar</button>`;
}

function viewCorpo() {
  const ser = weightSeries(), e = S.weights[curDate] || {};
  const x0 = ser.length ? parseISO(ser[0].date).getTime() : 0;
  const pts = ser.map((p) => ({ x: (parseISO(p.date).getTime() - x0) / 86400000, kg: p.kg, trend: p.trend, date: p.date }));
  const comp = Object.keys(S.weights).sort().map((d) => { const b = bfFor(S.weights[d]); const kg = Number(S.weights[d].kg); return b && kg ? { x: (parseISO(d).getTime() - x0) / 86400000, lean: kg * (1 - b / 100), fat: (kg * b) / 100, bf: b, d } : null; }).filter(Boolean);
  let rate = "";
  if (ser.length >= 8) {
    const a = ser[ser.length - 1].trend, b = ser[Math.max(0, ser.length - 8)].trend;
    const wk = a - b, pct = (wk / a) * 100;
    rate = `<div class="stat"><b>${wk >= 0 ? "+" : ""}${r1(wk)} kg</b><span>tendência últimos 7 dias (${r1(pct)}%/sem)</span></div>`;
  }
  let compStats = "";
  if (comp.length) {
    const L = comp[comp.length - 1], F = comp[0];
    compStats = `<div class="grid3" style="margin-top:8px">
      <div class="stat"><b>${r1(L.bf)}%</b><span>gordura corporal</span></div>
      <div class="stat"><b style="color:var(--brand)">${r1(L.lean)} kg</b><span>massa magra (${L.lean - F.lean >= 0 ? "+" : ""}${r1(L.lean - F.lean)})</span></div>
      <div class="stat"><b style="color:var(--fat)">${r1(L.fat)} kg</b><span>massa gorda (${L.fat - F.fat >= 0 ? "+" : ""}${r1(L.fat - F.fat)})</span></div></div>`;
  }
  const ad = adaptiveTDEE();
  return `
  <section class="card">
    <h2>Registro de ${fmtDate(curDate)}</h2>
    <p class="muted">Pese-se todo dia ao acordar, após ir ao banheiro, antes de comer/beber. As medidas podem ser semanais.</p>
    <div class="grid2"><div><label>Peso (kg)</label><input id="wKg" type="number" step="0.05" inputmode="decimal" value="${e.kg ?? ""}"></div>
    <div><label>% gordura (bioimpedância/dobras)</label><input id="wBf" type="number" step="0.1" inputmode="decimal" value="${e.bf ?? ""}"></div></div>
    <h3>Ou calcule a % de gordura pelas medidas (Marinha dos EUA)</h3>
    <div class="grid3"><div><label>Cintura (cm, no umbigo)</label><input id="wWaist" type="number" step="0.1" value="${e.waist ?? ""}"></div>
    <div><label>Pescoço (cm)</label><input id="wNeck" type="number" step="0.1" value="${e.neck ?? ""}"></div>
    ${S.profile.sex === "f" ? `<div><label>Quadril (cm)</label><input id="wHip" type="number" step="0.1" value="${e.hip ?? ""}"></div>` : ""}</div>
    <div class="row" style="margin-top:10px"><button class="btn" id="wSave">Salvar</button>${e.kg ? `<button class="btn sec" id="wDel">Apagar dia</button>` : ""}</div>
  </section>
  <section class="card">
    <h2>Peso</h2>
    ${lineChart([{ data: pts.map((p) => ({ x: p.x, y: p.kg })), color: "var(--muted)", dots: true }, { data: pts.map((p) => ({ x: p.x, y: p.trend })), color: "var(--brand)" }], { label: "Peso e tendência" })}
    <div class="legend"><span><i style="background:var(--muted)"></i>pesagem diária</span><span><i style="background:var(--brand)"></i>tendência (ignora retenção de água do dia a dia)</span></div>
    <div class="grid2" style="margin-top:8px">${ser.length ? `<div class="stat"><b>${r1(ser[ser.length - 1].trend)} kg</b><span>peso de tendência</span></div>` : ""}${rate}</div>
  </section>
  <section class="card">
    <h2>Composição corporal</h2>
    ${comp.length >= 2 ? lineChart([{ data: comp.map((p) => ({ x: p.x, y: p.lean })), color: "var(--brand)" }], { label: "Massa magra" }) + `<div class="legend"><span><i style="background:var(--brand)"></i>massa magra (kg)</span></div>` + lineChart([{ data: comp.map((p) => ({ x: p.x, y: p.fat })), color: "var(--fat)" }], { label: "Massa gorda" }) + `<div class="legend"><span><i style="background:var(--fat)"></i>massa gorda (kg)</span></div>` : `<p class="muted">Registre % de gordura ou medidas (1x por semana, mesmas condições) para acompanhar massa magra × gordura.</p>`}
    ${compStats}
  </section>
  <section class="card">
    <h2>Gasto calórico adaptativo</h2>
    ${ad ? `<p>Seu gasto real estimado é <b>${r0(ad.tdee)} kcal/dia</b> (média ingerida ${r0(ad.avgIntake)} kcal, tendência ${ad.deltaKg >= 0 ? "+" : ""}${r1(ad.deltaKg)} kg em ${ad.days} dias). A fórmula estimava ${r0(formulaTDEE())} kcal.</p>`
      : `<p class="muted">Após ~2–3 semanas registrando peso (8+ dias) e alimentação (10+ dias), o app calcula seu gasto REAL comparando o que você comeu com a mudança do seu peso — e ajusta suas calorias automaticamente. Até lá usa a fórmula: ${r0(formulaTDEE())} kcal/dia.</p>`}
  </section>`;
}

function viewCiclo() {
  const c = S.cycle;
  const rows = [];
  for (let i = -1; i < 14; i++) {
    const d = addDays(curDate, i), t = targets(d);
    rows.push(`<tr class="${d === curDate ? "today-row" : ""}"><td>${fmtDate(d)}</td><td style="text-align:left">${esc(t.phase.name.replace("Proteína ", ""))}</td><td>${t.kcal}</td><td>${t.P}</td><td>${t.C}</td><td>${t.F}</td><td>${(t.water / 1000).toFixed(1)}</td><td>${t.fib}</td></tr>`);
  }
  return `
  <section class="card">
    <h2>Próximos 14 dias</h2>
    <p class="muted">Calorias iguais todos os dias; o que muda é a distribuição. Cada fase define proteína e gordura; o carboidrato completa as calorias do dia.</p>
    <div class="scroll"><table><thead><tr><th>Dia</th><th style="text-align:left">Fase</th><th>kcal</th><th>P</th><th>C</th><th>G</th><th>Água L</th><th>Fibra</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>
  </section>
  <section class="card">
    <h2>Configurar ciclo</h2>
    <div class="grid2">
      <div><label>Dias em cada fase</label><select id="cyLen">${[1, 2, 3, 4, 7].map((n) => `<option value="${n}" ${Number(c.daysPerPhase) === n ? "selected" : ""}>${n} dia(s)</option>`).join("")}</select></div>
      <div><label>Início do ciclo</label><input id="cyStart" type="date" value="${c.start}"></div>
      <div><label>Gordura mínima (g/kg)</label><input id="cyFatMin" type="number" step="0.05" value="${c.fatMinGkg}"></div>
      <div><label>Carboidrato mínimo (g)</label><input id="cyCarbMin" type="number" step="5" value="${c.carbMin}"></div>
    </div>
    <h3>Fases</h3>
    ${c.phases.map((p, i) => { const m = phaseMacros(p); return `<div class="phase-ed">
      <div class="row"><input data-phname="${i}" value="${esc(p.name)}" aria-label="Nome da fase">${c.phases.length > 2 ? `<button class="btn sm sec" data-phdel="${i}" aria-label="Remover fase">×</button>` : ""}</div>
      <div class="grid3">
        <div><label style="color:var(--prot)">Proteína g/kg</label><input data-phprot="${i}" type="number" step="0.1" min="1.2" max="3.5" value="${p.prot}"></div>
        <div><label style="color:var(--fat)">Gordura g/kg</label><input data-phfat="${i}" type="number" step="0.05" min="0.3" max="2" value="${p.fat}"></div>
        <div><label style="color:var(--carb)">Carbo (resto)</label><div class="stat" style="padding:9px 10px" data-phc="${i}">${phCarbHtml(m)}</div></div>
      </div>
      <div class="muted" data-phsum="${i}">${phSumHtml(m)}</div></div>`; }).join("")}
    <div class="row" style="margin-top:8px"><button class="btn sm sec" id="phAdd">+ Fase</button><button class="btn" id="cySave">Salvar ciclo</button></div>
    <div class="tip ok">Recomendado: proteína ≥ 1,6 g/kg em TODAS as fases (média 2,0–2,4 g/kg em déficit) e gordura ≥ 0,5 g/kg (saúde hormonal). Faça os dias de carbo alto coincidirem com os treinos mais pesados (pernas/costas) e os de carbo baixo com descanso ou treinos leves — ajuste o "Início do ciclo" para alinhar.</div>
  </section>`;
}

function viewPerfil() {
  const p = S.profile, k = kcalTarget(), ad = adaptiveTDEE();
  const act = [[1.2, "Sedentário"], [1.375, "Leve (1–3 treinos/sem)"], [1.55, "Moderado (3–5 treinos/sem)"], [1.725, "Alto (6–7 treinos/sem)"], [1.9, "Muito alto (atleta/trabalho físico)"]];
  return `
  <section class="card">
    <h2>Seus dados</h2>
    <div class="grid2">
      <div><label>Sexo</label><select id="pSex"><option value="m" ${p.sex === "m" ? "selected" : ""}>Masculino</option><option value="f" ${p.sex === "f" ? "selected" : ""}>Feminino</option></select></div>
      <div><label>Idade</label><input id="pAge" type="number" value="${p.age}"></div>
      <div><label>Altura (cm)</label><input id="pH" type="number" value="${p.height}"></div>
      <div><label>Peso inicial (kg)</label><input id="pW" type="number" step="0.1" value="${p.weight}"></div>
      <div><label>% gordura (se souber)</label><input id="pBf" type="number" step="0.1" value="${p.bf}"></div>
      <div><label>Duração do treino (min)</label><input id="pTrain" type="number" value="${p.trainMin}"></div>
    </div>
    <label>Nível de atividade</label><select id="pAct">${act.map(([v, l]) => `<option value="${v}" ${Number(p.activity) === v ? "selected" : ""}>${l}</option>`).join("")}</select>
    <label>Objetivo: ${Number(p.goalPct) > 0 ? "+" : ""}<b id="gLbl">${p.goalPct}</b>% sobre o gasto</label>
    <input id="pGoal" type="range" min="-25" max="15" step="1" value="${p.goalPct}">
    <p class="muted">−20 a −25% = cutting agressivo · −10 a −15% = perda de gordura preservando massa · −5 a 0% = recomposição · +5 a +10% = ganho de massa limpo.</p>
    <div class="grid2">
      <div><label>Proteína calculada sobre</label><select id="pRef"><option value="atual" ${p.refWeight === "atual" ? "selected" : ""}>Peso atual</option><option value="meta" ${p.refWeight === "meta" ? "selected" : ""}>Peso meta</option></select></div>
      <div><label>Peso meta (kg)</label><input id="pGoalW" type="number" step="0.1" value="${p.goalWeight}"></div>
    </div>
    <p class="muted">Com % de gordura alto (homem &gt; 25%, mulher &gt; 32%), use o peso meta para não superestimar a proteína.</p>
    <label style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" id="pAdapt" style="width:auto" ${S.useAdaptive ? "checked" : ""}> Ajustar calorias pelo gasto adaptativo (quando houver dados)</label>
    <label>Calorias fixas manuais (opcional — deixe vazio para automático)</label><input id="pManual" type="number" value="${S.manualKcal}">
    <div class="row" style="margin-top:10px"><button class="btn" id="pSave">Salvar perfil</button></div>
  </section>
  <section class="card">
    <h2>Resumo</h2>
    <div class="grid3">
      <div class="stat"><b>${r0(bmr())}</b><span>metabolismo basal (${latestBF() ? "Katch-McArdle" : "Mifflin-St Jeor"})</span></div>
      <div class="stat"><b>${r0(ad ? ad.tdee : formulaTDEE())}</b><span>gasto diário (${ad ? "adaptativo" : "fórmula"})</span></div>
      <div class="stat"><b>${k.kcal}</b><span>meta diária (${k.src})</span></div>
    </div>
    ${k.kcal < bmr() ? `<div class="tip warn">Sua meta está abaixo do seu metabolismo basal. Isso aumenta a perda de massa magra — considere um déficit menor.</div>` : ""}
  </section>
  <section class="card">
    <h2>Backup</h2>
    <p class="muted">Os dados ficam só neste aparelho. Exporte com frequência.</p>
    <div class="row"><button class="btn sec" id="exp">Exportar dados</button><label class="btn sec" style="margin:0;text-align:center;color:var(--text)">Importar<input type="file" id="imp" accept="application/json" hidden></label></div>
    <div class="row" style="margin-top:8px"><button class="btn danger" id="reset">Apagar tudo</button></div>
  </section>
  <p class="muted" style="text-align:center">Ferramenta educacional. Não substitui nutricionista/médico — especialmente com doença renal, diabetes ou distúrbios intestinais.</p>`;
}

// ---------- Render & eventos ----------
function render() {
  $("#dateSel").value = curDate;
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  const v = { hoje: viewHoje, diario: viewDiario, corpo: viewCorpo, ciclo: viewCiclo, perfil: viewPerfil }[tab];
  $("#view").innerHTML = v();
  if (tab === "diario") { renderResults(""); renderPick(); }
}
const val = (id) => $("#" + id)?.value ?? "";

document.addEventListener("click", (ev) => {
  const t = ev.target.closest("button, [data-pick]"); if (!t) return;
  const ds = t.dataset;
  if (ds.tab) { tab = ds.tab; pick = null; render(); window.scrollTo(0, 0); return; }
  if (ds.go) { tab = ds.go; render(); setTimeout(() => $("#q")?.focus(), 50); return; }
  if (ds.water) { const L = dayLog(curDate); L.water = Math.max(0, L.water + Number(ds.water)); save(); render(); return; }
  if (ds.bristol) { const L = dayLog(curDate); const n = Number(ds.bristol); L.bristol = L.bristol === n ? null : n; save(); render(); return; }
  if (ds.pick) { pick = { id: ds.pick, g: 100 }; renderPick(); document.querySelectorAll("[data-pick]").forEach((x) => x.classList.toggle("sel", x === t)); $("#pg")?.focus(); $("#pg")?.select(); return; }
  if (ds.del) { dayLog(curDate).foods.splice(Number(ds.del), 1); save(); render(); return; }
  if (ds.delcf) { if (confirm("Remover este alimento personalizado?")) { S.customFoods = S.customFoods.filter((f) => f.id !== ds.delcf); save(); render(); } return; }
  if (ds.phdel) { S.cycle.phases.splice(Number(ds.phdel), 1); save(); render(); return; }
  switch (t.id) {
    case "addFood": {
      const f = allFoods().find((x) => x.id === pick.id), g = Number(val("pg")); if (!f || !(g > 0)) return;
      const k = g / 100;
      dayLog(curDate).foods.push({ fid: f.id, name: f.name, g, meal: val("pm"), kcal: f.kcal * k, p: f.p * k, c: f.c * k, f: f.f * k, fib: f.fib * k });
      pick = null; save(); render(); break;
    }
    case "copyPrev": {
      const prev = S.logs[addDays(curDate, -1)]?.foods || [];
      if (!prev.length) { alert("Não há refeições registradas no dia anterior."); break; }
      dayLog(curDate).foods.push(...prev.map((f) => ({ ...f }))); save(); render(); break;
    }
    case "cfSave": {
      const name = val("cfName").trim(); if (!name) { alert("Informe o nome."); break; }
      S.customFoods.unshift({ id: "c" + Date.now(), name, kcal: Number(val("cfK")) || 0, p: Number(val("cfP")) || 0, c: Number(val("cfC")) || 0, f: Number(val("cfF")) || 0, fib: Number(val("cfFib")) || 0, cat: "Personalizado" });
      save(); render(); break;
    }
    case "wSave": {
      const e = { kg: val("wKg"), bf: val("wBf"), waist: val("wWaist"), neck: val("wNeck"), hip: val("wHip") };
      if (!e.kg) { alert("Informe o peso."); break; }
      S.weights[curDate] = e; save(); render(); break;
    }
    case "wDel": delete S.weights[curDate]; save(); render(); break;
    case "phAdd": S.cycle.phases.push({ name: "Nova fase", prot: 2.0, fat: 0.8 }); save(); render(); break;
    case "cySave": {
      const c = S.cycle;
      c.daysPerPhase = Number(val("cyLen")); c.start = val("cyStart") || TODAY;
      c.fatMinGkg = Number(val("cyFatMin")) || 0.5; c.carbMin = Number(val("cyCarbMin")) || 0;
      c.phases = c.phases.map((p, i) => ({ name: $(`[data-phname="${i}"]`).value || p.name, prot: Number($(`[data-phprot="${i}"]`).value) || p.prot, fat: Number($(`[data-phfat="${i}"]`).value) || p.fat }));
      const warn = [];
      if (c.phases.some((p) => p.prot < 1.6)) warn.push("alguma fase está abaixo de 1,6 g/kg de proteína");
      if (c.phases.some((p) => p.fat < 0.5)) warn.push("alguma fase está abaixo de 0,5 g/kg de gordura");
      if (warn.length) alert("Atenção: " + warn.join(" e ") + ".");
      save(); render(); break;
    }
    case "pSave": {
      Object.assign(S.profile, { sex: val("pSex"), age: Number(val("pAge")), height: Number(val("pH")), weight: Number(val("pW")), bf: val("pBf"), trainMin: Number(val("pTrain")) || 0, activity: Number(val("pAct")), goalPct: Number(val("pGoal")), refWeight: val("pRef"), goalWeight: val("pGoalW") });
      S.useAdaptive = $("#pAdapt").checked; S.manualKcal = val("pManual");
      save(); render(); alert("Perfil salvo."); break;
    }
    case "exp": {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([JSON.stringify(S, null, 2)], { type: "application/json" }));
      a.download = `macronutri-backup-${TODAY}.json`; a.click(); break;
    }
    case "reset": if (confirm("Apagar TODOS os dados deste aparelho?")) { S = structuredClone(DEFAULT); save(); render(); } break;
  }
});
document.addEventListener("input", (ev) => {
  const id = ev.target.id;
  if (id === "q") renderResults(ev.target.value);
  if (id === "pg" && pick) { pick.g = ev.target.value; pick.meal = val("pm"); const pos = ev.target.selectionStart; renderPick(); const n = $("#pg"); n.focus(); try { n.setSelectionRange(pos, pos); } catch {} }
  const phi = ev.target.dataset?.phprot ?? ev.target.dataset?.phfat;
  if (phi != null) { // prévia ao vivo do carboidrato da fase
    const m = phaseMacros({ prot: Number($(`[data-phprot="${phi}"]`).value) || 0, fat: Number($(`[data-phfat="${phi}"]`).value) || 0 });
    $(`[data-phc="${phi}"]`).innerHTML = phCarbHtml(m); $(`[data-phsum="${phi}"]`).textContent = phSumHtml(m);
  }
  if (id === "pGoal") $("#gLbl").textContent = ev.target.value;
});
document.addEventListener("change", (ev) => {
  const id = ev.target.id;
  if (id === "pm" && pick) pick.meal = ev.target.value;
  if (id === "trained") { dayLog(curDate).trained = ev.target.checked; save(); render(); }
  if (id === "dateSel") { curDate = ev.target.value || TODAY; pick = null; render(); }
  if (id === "imp") {
    const file = ev.target.files[0]; if (!file) return;
    file.text().then((txt) => { const d = JSON.parse(txt); if (!d.profile || !d.cycle) throw new Error("arquivo inválido"); localStorage.setItem(KEY, JSON.stringify(d)); S = load(); render(); alert("Dados importados."); })
      .catch((e) => alert("Falha ao importar: " + e.message));
  }
});
document.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && ev.target.id === "pg") $("#addFood")?.click(); });

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("sw.js").catch(() => {});
if (!localStorage.getItem(KEY)) tab = "perfil";
render();
