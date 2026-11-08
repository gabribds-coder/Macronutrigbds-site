/* Fotos de evolução: armazenadas só no aparelho (IndexedDB), comprimidas.
   Organizadas por "Antes" (até o início do ciclo) e Semana 1, 2, 3...
   Depende de funções globais de app.js (chamadas apenas em tempo de execução). */
"use strict";

const POSES = [["frente", "Frente"], ["lado", "Lado"], ["costas", "Costas"]];
const weekLabel = (w) => (w === 0 ? "Antes" : "Semana " + w);

// ---------- Banco local de fotos ----------
const photoDB = (() => {
  let dbp;
  const open = () => (dbp ||= new Promise((ok, no) => {
    const r = indexedDB.open("macronutri-fotos", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("photos", { keyPath: "id" });
    r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
  }));
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((ok, no) => {
      const t = db.transaction("photos", mode), req = fn(t.objectStore("photos"));
      t.oncomplete = () => ok(req?.result); t.onerror = () => no(t.error); t.onabort = () => no(t.error);
    });
  };
  return {
    all: () => tx("readonly", (s) => s.getAll()),
    put: (p) => tx("readwrite", (s) => s.put(p)),
    del: (id) => tx("readwrite", (s) => s.delete(id)),
    clear: () => tx("readwrite", (s) => s.clear())
  };
})();

let PHOTOS = []; // {id, week, date, pose, blob, url}
let photosReady = false;
const fotoUI = { rot: 0, big: false, pose: "frente", a: null, b: null, cmp: 50, banner: null, bannerUrl: null, sel: null, upWeek: null };

async function loadPhotos() {
  try {
    PHOTOS.forEach((p) => URL.revokeObjectURL(p.url));
    const rows = await photoDB.all();
    PHOTOS = rows.map((p) => ({ ...p, url: URL.createObjectURL(p.blob) })).sort((x, y) => x.week - y.week || x.date.localeCompare(y.date));
  } catch (e) { console.warn("fotos indisponíveis", e); PHOTOS = []; }
  photosReady = true;
}

// Semana do ciclo para uma data: até o dia de início = "Antes" (0); depois, semana 1, 2...
function weekOf(date) {
  const d = diffDays(S.cycle.start, date);
  return d <= 0 ? 0 : Math.ceil(d / 7);
}
const weeksWithPhotos = () => [...new Set(PHOTOS.map((p) => p.week))].sort((a, b) => a - b);
const photoFor = (week, pose) => PHOTOS.filter((p) => p.week === week && p.pose === pose).slice(-1)[0];
const anyPhotoFor = (week) => photoFor(week, "frente") || PHOTOS.find((p) => p.week === week);

// Peso (tendência) e composição perto de uma data
function bodyAt(date) {
  const ser = weightSeries();
  let kg = null;
  if (ser.length) {
    const exact = ser.find((x) => x.date === date);
    if (exact) kg = exact.trend;
    else if (date > ser[ser.length - 1].date && diffDays(ser[ser.length - 1].date, date) <= 7) kg = ser[ser.length - 1].trend;
    else if (date < ser[0].date && diffDays(date, ser[0].date) <= 7) kg = ser[0].trend;
  }
  let bf = null, best = 8;
  for (const d of Object.keys(S.weights)) {
    const dd = Math.abs(diffDays(d, date)), b = bfFor(S.weights[d]);
    if (b && dd < best) { best = dd; bf = b; }
  }
  return { kg, bf, lean: kg && bf ? kg * (1 - bf / 100) : null, fat: kg && bf ? (kg * bf) / 100 : null };
}

// Redimensiona e comprime (máx. 1080 px, JPEG 0,82) — respeita a orientação da câmera
function compressImage(file) {
  return new Promise((ok, no) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      const max = 1080, k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob((b) => (b ? ok(b) : no(new Error("falha ao comprimir"))), "image/jpeg", 0.82);
    };
    img.onerror = () => { URL.revokeObjectURL(url); no(new Error("imagem inválida")); };
    img.src = url;
  });
}

async function addPhoto(file, pose) {
  const week = Number(fotoUI.upWeek ?? weekOf(curDate));
  const blob = await compressImage(file);
  const old = PHOTOS.filter((p) => p.week === week && p.pose === pose); // uma foto por pose por semana (substitui)
  for (const o of old) await photoDB.del(o.id);
  await photoDB.put({ id: "f" + Date.now() + Math.random().toString(36).slice(2, 6), week, date: curDate, pose, blob });
  try { await navigator.storage?.persist?.(); } catch {}
  await loadPhotos();
  fotoUI.a = fotoUI.b = fotoUI.sel = null; // volta ao padrão: Antes × mais recente
}

// ---------- Componentes ----------
function statDiff(label, a, b, unit, goodDown) {
  if (a == null || b == null) return "";
  const d = b - a, good = goodDown ? d <= 0 : d >= 0;
  return `<div class="stat"><b style="color:${Math.abs(d) < 0.05 ? "inherit" : good ? "var(--fib)" : "var(--prot)"}">${d > 0 ? "+" : ""}${r1(d)} ${unit}</b><span>${label}: ${r1(a)} → ${r1(b)}</span></div>`;
}
function compareStats(wa, wb) {
  const pa = anyPhotoFor(wa), pb = anyPhotoFor(wb);
  if (!pa || !pb) return "";
  const A = bodyAt(pa.date), B = bodyAt(pb.date);
  const html = statDiff("peso", A.kg, B.kg, "kg", true) + statDiff("% gordura", A.bf, B.bf, "%", true) +
    statDiff("massa magra", A.lean, B.lean, "kg", false) + statDiff("massa gorda", A.fat, B.fat, "kg", true);
  return html ? `<div class="grid2" style="margin-top:10px">${html}</div>` : `<p class="muted">Registre peso e % de gordura em Corpo para ver os números da evolução.</p>`;
}

// Banner da tela Hoje
function homeBanner() {
  if (!photosReady) return "";
  const ws = weeksWithPhotos();
  if (!ws.length) {
    return `<section class="card evo-cta"><h2>Foto do ANTES</h2>
      <p class="muted">Registre suas fotos (frente, lado e costas) antes de iniciar o ciclo. Toda semana, uma nova — o app monta o comparativo da sua evolução.</p>
      <button class="btn" data-tab="fotos">Tirar foto do antes</button></section>`;
  }
  const due = !PHOTOS.some((p) => p.week === weekOf(curDate));
  return `<section class="card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">Sua evolução</h2><button class="btn sm sec" data-tab="fotos" style="flex:0 0 auto">Ver fotos</button></div>
    ${miniBanner("frente")}
    ${due ? `<div class="tip ok" style="margin-bottom:0">Ainda não há foto da <b>${weekLabel(weekOf(curDate))}</b>. <button class="linkbtn" data-tab="fotos">Registrar agora</button></div>` : ""}</section>`;
}

// Banner rotativo compacto: uma semana por vez, troca sozinho a cada 3,5 s
function miniBanner(pose) {
  const ws = weeksWithPhotos(); if (!ws.length) return "";
  const first = anyPhotoFor(ws[0]), A = bodyAt(first.date), n = ws.length, cur = fotoUI.rot % n;
  const slides = ws.map((w, i) => {
    const p = photoFor(w, pose) || anyPhotoFor(w), B = bodyAt(p.date);
    const info = [fmtDate(p.date), B.kg ? r1(B.kg) + " kg" : "", B.bf ? r1(B.bf) + "% gord." : ""].filter(Boolean).join(" · ");
    const d = i > 0 && A.kg && B.kg ? B.kg - A.kg : null;
    return `<div class="mb-slide ${i === cur ? "on" : ""}"><img src="${p.url}" alt="${weekLabel(w)}"><div class="mb-info"><b>${weekLabel(w)}</b><span class="muted">${info}</span>${d != null ? `<span class="mb-delta" style="color:${d <= 0 ? "var(--fib)" : "var(--fat)"}">${d > 0 ? "+" : ""}${r1(d)} kg desde ${weekLabel(ws[0]) === "Antes" ? "o Antes" : weekLabel(ws[0])}</span>` : ""}</div></div>`;
  }).join("");
  return `<div class="mini-ban" data-ftexpand="1" role="button" tabindex="0" aria-label="Evolução: toque para ampliar">${slides}
    ${n > 1 ? `<div class="mb-dots">${ws.map((_, i) => `<i class="${i === cur ? "on" : ""}"></i>`).join("")}</div>` : ""}<span class="mb-hint">toque para ampliar</span></div>`;
}
setInterval(() => {
  if (document.hidden) return;
  const bans = document.querySelectorAll(".mini-ban"); if (!bans.length) return;
  fotoUI.rot++;
  bans.forEach((b) => {
    const sl = b.querySelectorAll(".mb-slide"); if (sl.length < 2) return;
    const i = fotoUI.rot % sl.length;
    sl.forEach((x, k) => x.classList.toggle("on", k === i));
    b.querySelectorAll(".mb-dots i").forEach((x, k) => x.classList.toggle("on", k === i));
  });
}, 3500);

function viewFotos() {
  if (!photosReady) return `<section class="card"><p class="muted">Carregando fotos…</p></section>`;
  const ws = weeksWithPhotos(), cw = weekOf(curDate);
  const maxW = Math.max(cw, ...ws, 0) + 1;
  const upWeek = fotoUI.upWeek ?? cw;
  const opts = (sel) => ws.map((w) => `<option value="${w}" ${w === sel ? "selected" : ""}>${weekLabel(w)}</option>`).join("");
  const a = fotoUI.a ?? ws[0], b = fotoUI.b ?? ws[ws.length - 1];
  const pa = photoFor(a, fotoUI.pose), pb = photoFor(b, fotoUI.pose);

  let compare;
  if (ws.length < 2) compare = `<p class="muted">Adicione fotos de pelo menos duas semanas (ex.: Antes e Semana 1) para comparar.</p>${ws.length ? `<div class="evo-single"><img src="${anyPhotoFor(ws[0]).url}" alt="${weekLabel(ws[0])}"><span class="tag">${weekLabel(ws[0])}</span></div>` : ""}`;
  else if (!pa || !pb) compare = `<p class="muted">Falta a foto de "${POSES.find((p) => p[0] === fotoUI.pose)[1]}" em ${!pa ? weekLabel(a) : weekLabel(b)}.</p>`;
  else compare = `
    <div class="ba" style="--pos:${fotoUI.cmp}%">
      <img src="${pb.url}" alt="${weekLabel(b)}">
      <div class="ba-top"><img src="${pa.url}" alt="${weekLabel(a)}"></div>
      <div class="ba-bar"></div>
      <span class="tag l">${weekLabel(a)}</span><span class="tag r">${weekLabel(b)}</span>
      <input type="range" min="0" max="100" value="${fotoUI.cmp}" id="ftCmp" aria-label="Comparar antes e depois">
    </div>
    <p class="muted" style="text-align:center;margin:6px 0 0">Arraste para comparar</p>${compareStats(a, b)}`;

  const timeline = ws.length ? ws.slice().reverse().map((w) => {
    const ps = PHOTOS.filter((p) => p.week === w), d = ps[0].date, B = bodyAt(d);
    return `<div class="tl-week"><div class="row" style="justify-content:space-between"><b style="flex:0 0 auto">${weekLabel(w)}</b><span class="muted" style="text-align:right">${fmtDate(d)}${B.kg ? ` · ${r1(B.kg)} kg` : ""}${B.bf ? ` · ${r1(B.bf)}%` : ""}</span></div>
      <div class="tl-grid">${POSES.map(([k, l]) => { const p = photoFor(w, k); return p ? `<button class="tl-ph" data-ftview="${p.id}"><img src="${p.url}" alt="${weekLabel(w)} ${l}" loading="lazy"><span>${l}</span></button>` : `<div class="tl-ph empty"><span>${l}</span></div>`; }).join("")}</div></div>`;
  }).join("") : `<p class="muted">Nenhuma foto ainda.</p>`;

  const sel = bannerSel();

  return `
  <section class="card" id="ftCmpCard">
    <div class="row" style="justify-content:space-between"><h2 style="margin:0">Comparativo da evolução</h2>${fotoUI.big && ws.length ? `<button class="btn sm sec" id="ftShrink" style="flex:0 0 auto">Reduzir</button>` : ""}</div>
    <div class="seg" style="margin-top:10px">${POSES.map(([k, l]) => `<button data-ftpose="${k}" class="${fotoUI.pose === k ? "on" : ""}">${l}</button>`).join("")}</div>
    ${!fotoUI.big && ws.length ? miniBanner(fotoUI.pose) : `
    ${ws.length >= 2 ? `<div class="grid2" style="margin-bottom:10px"><div><label>De</label><select id="ftA">${opts(a)}</select></div><div><label>Para</label><select id="ftB">${opts(b)}</select></div></div>` : ""}
    ${compare}`}
  </section>

  <section class="card">
    <h2>Adicionar fotos</h2>
    <label>Semana</label>
    <select id="ftWeek">${Array.from({ length: maxW + 1 }, (_, w) => `<option value="${w}" ${w === upWeek ? "selected" : ""}>${weekLabel(w)}${w === cw ? " (atual)" : ""}</option>`).join("")}</select>
    <p class="muted">Data: ${fmtDate(curDate)}. "Antes" = fotos até o início do ciclo (${fmtDate(S.cycle.start)}). Uma foto por posição em cada semana — enviar de novo substitui.</p>
    <div class="grid3">${POSES.map(([k, l]) => `<label class="btn sec up-btn">${l}${photoFor(upWeek, k) ? " ✓" : ""}<input type="file" accept="image/*" data-ftfile="${k}" hidden></label>`).join("")}</div>
    <div class="tip ok">Dicas para comparar bem: mesmo lugar e luz, mesma distância e altura da câmera, de manhã em jejum, mesma roupa, postura relaxada. Use o timer da câmera.</div>
  </section>

  ${ws.length ? `<section class="card">
    <h2>Banner para compartilhar</h2>
    <p class="muted">Escolha as semanas (até 4) e gere uma imagem lado a lado.</p>
    <div class="chips">${ws.map((w) => `<label class="chip"><input type="checkbox" data-ftsel="${w}" ${sel.includes(w) ? "checked" : ""}> ${weekLabel(w)}</label>`).join("")}</div>
    <div class="row" style="margin-top:10px"><button class="btn" id="ftMake">Gerar banner (${POSES.find((p) => p[0] === fotoUI.pose)[1]})</button></div>
    ${fotoUI.bannerUrl ? `<img class="banner-prev" src="${fotoUI.bannerUrl}" alt="Banner de evolução (toque para ampliar)" title="Toque para ampliar">
      <div class="row"><button class="btn" id="ftShare">Compartilhar</button><button class="btn sec" id="ftSave">Baixar</button></div>` : ""}
  </section>` : ""}

  <section class="card"><h2>Linha do tempo</h2>${timeline}
    <p class="muted">As fotos ficam salvas somente neste aparelho. Use Perfil → Exportar dados para fazer backup (inclui as fotos).</p></section>`;
}

// ---------- Banner (colagem) ----------
// Semanas escolhidas; padrão = Antes, duas intermediárias e a mais recente
function bannerSel() {
  if (fotoUI.sel) return fotoUI.sel;
  const ws = weeksWithPhotos();
  return ws.length <= 4 ? ws : [...new Set([ws[0], ws[Math.floor(ws.length / 3)], ws[Math.floor((2 * ws.length) / 3)], ws[ws.length - 1]])];
}
async function makeBanner() {
  const weeks = bannerSel().slice().sort((a, b) => a - b).filter((w) => photoFor(w, fotoUI.pose));
  if (!weeks.length) { alert("Nenhuma das semanas escolhidas tem foto nessa posição."); return; }
  const load = (src) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });
  const imgs = await Promise.all(weeks.map((w) => load(photoFor(w, fotoUI.pose).url)));
  const cw = 540, ch = 720, pad = 16, head = 110, foot = 120;
  const c = document.createElement("canvas");
  c.width = pad + weeks.length * (cw + pad); c.height = head + ch + foot;
  const g = c.getContext("2d");
  g.fillStyle = "#0b1211"; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = "#14b8a6"; g.font = "bold 48px system-ui, sans-serif"; g.textBaseline = "middle";
  g.fillText("Minha evolução", pad + 8, head / 2);
  g.fillStyle = "#93a3a1"; g.font = "28px system-ui, sans-serif"; g.textAlign = "right";
  g.fillText("MacroNutri GBDS", c.width - pad - 8, head / 2); g.textAlign = "left";
  weeks.forEach((w, i) => {
    const x = pad + i * (cw + pad), y = head, im = imgs[i];
    const s = Math.max(cw / im.naturalWidth, ch / im.naturalHeight); // recorte tipo "cover"
    const sw = cw / s, sh = ch / s, sx = (im.naturalWidth - sw) / 2, sy = (im.naturalHeight - sh) / 2;
    g.save(); g.beginPath(); g.roundRect ? g.roundRect(x, y, cw, ch, 18) : g.rect(x, y, cw, ch); g.clip();
    g.drawImage(im, sx, sy, sw, sh, x, y, cw, ch); g.restore();
    const p = photoFor(w, fotoUI.pose), B = bodyAt(p.date);
    g.fillStyle = "#e6efee"; g.font = "bold 40px system-ui, sans-serif";
    g.fillText(weekLabel(w), x + 6, y + ch + 42);
    g.fillStyle = "#93a3a1"; g.font = "28px system-ui, sans-serif";
    g.fillText([parseISO(p.date).toLocaleDateString("pt-BR"), B.kg ? r1(B.kg) + " kg" : "", B.bf ? r1(B.bf) + "%" : ""].filter(Boolean).join(" · "), x + 6, y + ch + 88);
  });
  const blob = await new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.9));
  if (fotoUI.bannerUrl) URL.revokeObjectURL(fotoUI.bannerUrl);
  fotoUI.banner = blob; fotoUI.bannerUrl = URL.createObjectURL(blob);
  render();
}

// ---------- Visualizador ----------
function openViewer(id) {
  const p = PHOTOS.find((x) => x.id === id); if (!p) return;
  const ov = document.createElement("div");
  ov.className = "scan-ov"; ov.id = "ftViewer";
  ov.innerHTML = `<div class="scan-box"><img src="${p.url}" alt="" style="width:100%;border-radius:12px;max-height:65vh;object-fit:contain;background:#000">
    <p class="scan-msg">${weekLabel(p.week)} · ${POSES.find((x) => x[0] === p.pose)[1]} · ${fmtDate(p.date)}</p>
    <div class="row"><button class="btn danger" data-ftdel="${p.id}">Excluir</button><button class="btn sec" id="ftClose">Fechar</button></div></div>`;
  document.body.appendChild(ov);
}
const closeViewer = () => $("#ftViewer")?.remove();

// ---------- Backup ----------
const blobToDataURL = (b) => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(b); });
async function photosForExport() {
  return Promise.all(PHOTOS.map(async (p) => ({ id: p.id, week: p.week, date: p.date, pose: p.pose, data: await blobToDataURL(p.blob) })));
}
async function importPhotos(list) {
  if (!Array.isArray(list)) return;
  await photoDB.clear();
  for (const p of list) {
    if (!p?.data?.startsWith?.("data:image/")) continue;
    const blob = await (await fetch(p.data)).blob();
    await photoDB.put({ id: p.id, week: Number(p.week) || 0, date: p.date, pose: p.pose, blob });
  }
  await loadPhotos();
}

// ---------- Eventos ----------
document.addEventListener("click", async (ev) => {
  if (ev.target.classList?.contains("banner-prev")) { ev.target.classList.toggle("big"); return; }
  const t = ev.target.closest("button, [data-tab-go], [data-ftexpand]"); if (!t) return;
  const ds = t.dataset;
  if (ds.ftexpand) { fotoUI.big = true; tab = "fotos"; render(); $("#ftCmpCard")?.scrollIntoView({ block: "start" }); window.scrollBy(0, -70); return; }
  if (t.id === "ftShrink") { fotoUI.big = false; render(); return; }
  if (ds.tabGo) { tab = ds.tabGo; render(); window.scrollTo(0, 0); return; }
  if (ds.ftpose) { fotoUI.pose = ds.ftpose; render(); return; }
  if (ds.ftview) { openViewer(ds.ftview); return; }
  if (ds.ftdel) {
    if (!confirm("Excluir esta foto?")) return;
    await photoDB.del(ds.ftdel); closeViewer(); await loadPhotos(); fotoUI.a = fotoUI.b = fotoUI.sel = null; render(); return;
  }
  switch (t.id) {
    case "ftClose": closeViewer(); break;
    case "ftMake": t.disabled = true; t.textContent = "Gerando…"; try { await makeBanner(); } catch (e) { alert("Falha ao gerar banner: " + e.message); render(); } break;
    case "ftSave": { const a = document.createElement("a"); a.href = fotoUI.bannerUrl; a.download = `evolucao-${TODAY}.jpg`; a.click(); break; }
    case "ftShare": {
      const file = new File([fotoUI.banner], `evolucao-${TODAY}.jpg`, { type: "image/jpeg" });
      if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: "Minha evolução" }); } catch {} }
      else $("#ftSave")?.click();
      break;
    }
  }
});
document.addEventListener("input", (ev) => {
  if (ev.target.id === "ftCmp") { fotoUI.cmp = Number(ev.target.value); ev.target.closest(".ba").style.setProperty("--pos", fotoUI.cmp + "%"); }
});
document.addEventListener("change", async (ev) => {
  const el = ev.target, ds = el.dataset;
  if (el.id === "ftA") { fotoUI.a = Number(el.value); render(); }
  if (el.id === "ftB") { fotoUI.b = Number(el.value); render(); }
  if (el.id === "ftWeek") { fotoUI.upWeek = Number(el.value); render(); }
  if (ds.ftsel != null) {
    const w = Number(ds.ftsel); let s = new Set(bannerSel());
    el.checked ? s.add(w) : s.delete(w);
    if (s.size > 4) { el.checked = false; s.delete(w); alert("Escolha no máximo 4 semanas."); }
    fotoUI.sel = [...s];
  }
  if (ds.ftfile && el.files[0]) {
    const lbl = el.closest("label"); if (lbl) lbl.firstChild.textContent = "Salvando…";
    try { await addPhoto(el.files[0], ds.ftfile); } catch (e) { alert("Não foi possível salvar a foto: " + e.message); }
    render();
  }
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") closeViewer();
  if ((ev.key === "Enter" || ev.key === " ") && ev.target.dataset?.ftexpand) { ev.preventDefault(); ev.target.click(); }
});
