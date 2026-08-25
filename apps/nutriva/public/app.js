/* ── Nutriva App ── */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
let toastTimer;
function toast(msg) { const t = $("toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2800); }
async function api(path, opts) {
  const r = await fetch("/api" + path, { headers: { "Content-Type": "application/json" }, ...opts });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "HTTP " + r.status);
  return r.json();
}
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/* ── navegação ── */
document.querySelectorAll("#nav .nav-item").forEach((btn) => btn.addEventListener("click", () => {
  document.querySelectorAll("#nav .nav-item").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.dataset.view === btn.dataset.page));
}));
document.querySelectorAll("[data-goto]").forEach((el) => el.addEventListener("click", () => $(`nav [data-page="${el.dataset.goto}"]`).click()));

/* ── dashboard ── */
async function loadDashboard() {
  const d = await api("/dashboard");
  $("stats").innerHTML = [["Pacientes", d.patients], ["Planos", d.plans], ["Alimentos", d.foods], ["Tenants", d.tenants]]
    .map(([l, v]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join("");
  $("recent-patients").innerHTML = d.recentPatients.length
    ? `<table class="table"><tbody>${d.recentPatients.map((p) =>
        `<tr><td><b>${esc(p.name)}</b></td><td class="muted-sm">${esc(p.phone || "—")}</td><td>${p.weight_kg ? p.weight_kg + " kg" : "—"}</td><td><span class="pill">${esc(p.goal || "sem objetivo")}</span></td></tr>`).join("")}</tbody></table>`
    : `<div class="empty">Sem pacientes ainda 🌱</div>`;
}

/* ── pacientes ── */
async function loadPatients() {
  const list = await api("/patients");
  const tb = $("patients-table").querySelector("tbody");
  $("patients-empty").style.display = list.length ? "none" : "block";
  tb.innerHTML = list.map((p) => `<tr><td><b>${esc(p.name)}</b></td><td>${esc(p.phone || "—")}</td><td>${p.weight_kg ? p.weight_kg + " kg" : "—"}</td><td>${esc(p.goal || "—")}</td><td><span class="pill">ativo</span></td></tr>`).join("");
}
$("btn-new-patient").addEventListener("click", () => $("patient-overlay").classList.add("open"));
$("np-cancel").addEventListener("click", () => $("patient-overlay").classList.remove("open"));
$("np-save").addEventListener("click", async () => {
  const name = $("np-name").value.trim();
  if (!name) return toast("Nome é obrigatório");
  await api("/patients", { method: "POST", body: JSON.stringify({
    name, phone: $("np-phone").value, birth_date: $("np-birth").value,
    gender: $("np-gender").value, height_cm: $("np-height").value, weight_kg: $("np-weight").value, goal: $("np-goal").value,
  })});
  $("patient-overlay").classList.remove("open");
  ["np-name","np-phone","np-height","np-weight"].forEach((id) => ($(id).value = ""));
  toast("✅ Paciente salvo");
  loadPatients(); loadDashboard(); loadPatientSelect();
});

/* ── autocomplete de alimentos ── */
function attachFoodSearch(inputEl, acEl, onPick) {
  let deb;
  inputEl.addEventListener("input", () => {
    clearTimeout(deb);
    const q = inputEl.value.trim();
    if (q.length < 2) { acEl.style.display = "none"; return; }
    deb = setTimeout(async () => {
      const foods = await api(`/foods/search?q=${encodeURIComponent(q)}`);
      acEl.innerHTML = foods.map((f, idx) =>
        `<div data-idx="${idx}">${esc(f.name)}<small>${round2(f.kcal)} kcal/${f.unit === "unidade" ? "un" : f.reference_weight + f.unit}</small></div>`).join("")
        || `<div class="muted-sm">nada encontrado</div>`;
      acEl.style.display = "block";
      acEl.querySelectorAll("[data-idx]").forEach((row) => row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        onPick(foods[+row.dataset.idx]);
        acEl.style.display = "none";
      }));
    }, 180);
  });
  inputEl.addEventListener("blur", () => setTimeout(() => (acEl.style.display = "none"), 150));
}

function itemKcal(item) {
  if (!item.foodId) return null;
  const factor = item.unit === "unidade" ? (item.quantity || 0) : (item.quantity || 0) / (item.ref || 100);
  return round2((item.kcalPerRef || 0) * factor);
}

/* ── construtor de planos ── */
const planMeals = [];
function renderMeals() {
  $("meals").innerHTML = planMeals.map((meal, mi) => `
    <div class="meal-block">
      <div class="meal-head"><input value="${esc(meal.name)}" data-mi="${mi}" class="meal-name" placeholder="Café da manhã"><button class="remove-x" data-del-meal="${mi}">✕</button></div>
      ${meal.items.map((it, ii) => `
        <div class="meal-item">
          <input class="item-search" data-mi="${mi}" data-ii="${ii}" placeholder="Buscar alimento…" autocomplete="off" value="${esc(it.name || "")}">
          <div class="autocomplete"></div>
          <input type="number" class="w90 item-qty" data-mi="${mi}" data-ii="${ii}" placeholder="Qtd" min="0" value="${it.quantity ?? ""}">
          <span class="unit-label">${esc(it.unit || "")}</span>
          <span class="kcal-tag">${it.foodId && it.quantity ? (itemKcal(it) + " kcal") : ""}</span>
          <button class="remove-x" data-del-item="${mi}:${ii}">✕</button>
        </div>`).join("")}
      <button class="btn ghost sm" data-add-item="${mi}">+ Alimento</button>
      <span class="kcal-tag" style="float:right;margin-top:10px"><b>${round2(meal.items.reduce((a, i) => a + (itemKcal(i) || 0), 0))} kcal</b></span>
      <div style="clear:both"></div>
    </div>`).join("");

  wireMealEvents(); updateDailyTotal();
}
function updateDailyTotal() {
  const total = round2(planMeals.reduce((acc, m) => acc + m.items.reduce((a, i) => a + (itemKcal(i) || 0), 0), 0));
  $("daily-total").textContent = total > 0 ? `${total} kcal no dia` : "";
}
function wireMealEvents() {
  document.querySelectorAll(".meal-name").forEach((inp) => inp.addEventListener("change", () => { planMeals[+inp.dataset.mi].name = inp.value; }));
  document.querySelectorAll("[data-del-meal]").forEach((b) => b.addEventListener("click", () => { planMeals.splice(+b.dataset.delMeal, 1); renderMeals(); }));
  document.querySelectorAll("[data-del-item]").forEach((b) => b.addEventListener("click", () => { const [mi, ii] = b.dataset.delItem.split(":").map(Number); planMeals[mi].items.splice(ii, 1); renderMeals(); }));
  document.querySelectorAll("[data-add-item]").forEach((b) => b.addEventListener("click", () => { planMeals[+b.dataset.addItem].items.push({}); renderMeals(); }));
  document.querySelectorAll("#meals .meal-item").forEach((row) => {
    const searchEl = row.querySelector(".item-search");
    if (!searchEl) return;
    const mi = +searchEl.dataset.mi, ii = +searchEl.dataset.ii;
    attachFoodSearch(searchEl, row.querySelector(".autocomplete"), (f) => {
      Object.assign(planMeals[mi].items[ii], {
        foodId: f.id, name: f.name, unit: f.unit, ref: f.reference_weight,
        kcalPerRef: f.kcal, quantity: planMeals[mi].items[ii].quantity || (f.unit === "unidade" ? 1 : f.reference_weight),
      });
      renderMeals();
    });
    const qtyEl = row.querySelector(".item-qty");
    qtyEl.addEventListener("change", () => { planMeals[mi].items[ii].quantity = Number(qtyEl.value); renderMeals(); });
  });
}

async function loadPatientSelect() {
  const [list, saved] = await Promise.all([api("/patients"), api("/plans")]);
  $("plan-patient").innerHTML = `<option value="">Selecione…</option>` + list.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  $("saved-plans").innerHTML = saved.length
    ? saved.map((p) => `<div class="saved-plan-row"><span><b>${esc(p.name)}</b> <span class="muted-sm">· ${esc(p.patient_name ?? "")}</span></span><button class="btn ghost sm" onclick="openSavedPlan(${p.id})">Abrir</button></div>`).join("")
    : `<div class="empty">Nenhum plano salvo ainda.</div>`;
}

$("btn-add-meal").addEventListener("click", () => { planMeals.push({ name: "", items: [{}, {}] }); renderMeals(); });
$("btn-save-plan").addEventListener("click", async () => {
  const patient_id = Number($("plan-patient").value);
  if (!patient_id) return toast("Escolha um paciente");
  const meals = planMeals.filter((m) => m.items.some((i) => i.foodId && i.quantity))
    .map((m) => ({ name: m.name || "Refeição", items: m.items.filter((i) => i.foodId && i.quantity).map((i) => ({ foodId: i.foodId, quantity: i.quantity })) }));
  if (!meals.length) return toast("Adicione alimentos ao plano");
  const res = await api("/plans/full", { method: "POST", body: JSON.stringify({ patient_id, name: $("plan-name").value || "Plano alimentar", meals }) });
  toast(`✅ Plano #${res.planId} salvo · ${res.daily.kcal} kcal/dia`);
  loadPatientSelect();
});
window.openSavedPlan = async (id) => {
  try {
    const full = await api(`/plans/${id}/full`);
    const calc = await api("/plans/calculate", { method: "POST", body: JSON.stringify({ meals: full.meals.map((m) => ({ name: m.name, items: m.items.map((i) => ({ foodId: i.food_id, quantity: i.quantity })) })) }) });
    toast(`📋 ${full.plan.name} (${full.plan.patient_name}): ${calc.daily.kcal} kcal/dia · P${calc.daily.protein}g C${calc.daily.carbs}g G${calc.daily.fat}g`);
  } catch (e) { toast("Erro: " + e.message); }
};

/* ── substituições ── */
let subFood = null;
attachFoodSearch($("sub-food"), $("sub-food-ac"), (f) => { subFood = f; $("sub-food").value = f.name; $("sub-unit").textContent = f.unit; });
$("btn-sub").addEventListener("click", async () => {
  if (!subFood) return toast("Busque e selecione um alimento");
  const qty = Number($("sub-qty").value) || 100;
  const res = await api(`/substitutions?foodId=${subFood.id}&quantity=${qty}`);
  const medals = ["🥇", "🥈", "🥉"];
  $("sub-results").innerHTML = `
    <div class="card"><span class="muted-sm">Original:</span> <b>${esc(res.original?.name ?? "")}</b> — ${qty}${esc(res.original?.unit ?? "")}</div>
    ${res.list.map((c, i) => `
      <div class="sub-card">
        <div class="sub-rank">${medals[i] ?? i + 1}</div>
        <div style="flex:1"><b>${esc(c.name)}</b> — sugestão: <b>${c.suggestedQuantity}${esc(c.unit)}</b><br>
          <span class="muted-sm">${c.kcal} kcal · P ${c.protein}g · C ${c.carbs}g · G ${c.fat}g</span></div>
        <div><div class="sim-bar"><i style="width:${Math.round(c.similarity * 100)}%"></i></div><div class="muted-sm" style="font-size:11px;margin-top:3px">${Math.round(c.similarity * 100)}%</div></div>
      </div>`).join("") || `<div class="card empty">Sem alternativas na mesma categoria.</div>`}`;
});

/* ── receitas ── */
const recipeItems = [{}];
function renderRecipe() {
  $("recipe-items").innerHTML = recipeItems.map((it, ii) => `
    <div class="meal-item">
      <input class="r-search" data-ii="${ii}" placeholder="Ingrediente…" autocomplete="off" value="${esc(it.name || "")}">
      <div class="autocomplete"></div>
      <input type="number" class="w90 r-qty" data-ii="${ii}" placeholder="Qtd" min="0" value="${it.quantity ?? ""}">
      <span class="unit-label">${esc(it.unit || "")}</span>
      <button class="remove-x" data-del-item="${ii}">✕</button>
    </div>`).join("");
  document.querySelectorAll("#recipe-items .meal-item").forEach((row) => {
    const ii = +row.querySelector(".r-search").dataset.ii;
    attachFoodSearch(row.querySelector(".r-search"), row.querySelector(".autocomplete"), (f) => {
      recipeItems[ii] = { ...f, quantity: recipeItems[ii].quantity || (f.unit === "unidade" ? 1 : f.reference_weight) };
      renderRecipe();
    });
    row.querySelector(".r-qty").addEventListener("change", (e) => { recipeItems[ii].quantity = Number(e.target.value); updateRecipeTotals(); });
    row.querySelector(`[data-del-item="${ii}"]`).addEventListener("click", () => { recipeItems.splice(ii, 1); renderRecipe(); });
  });
  updateRecipeTotals();
}
function updateRecipeTotals() {
  let kcal = 0, protein = 0, carbs = 0, fat = 0;
  for (const it of recipeItems) {
    if (!it.foodId) continue;
    const factor = it.unit === "unidade" ? (it.quantity || 0) : (it.quantity || 0) / (it.ref || 100);
    kcal += it.kcal * factor; protein += it.protein * factor; carbs += it.carbs * factor; fat += it.fat * factor;
  }
  const portions = Math.max(1, Number($("recipe-portions").value) || 1);
  $("recipe-totals").innerHTML = kcal > 0
    ? `Total: <b>${round2(kcal)} kcal</b> · P ${round2(protein)}g C ${round2(carbs)}g G ${round2(fat)}g<br>Por porção (${portions}): <b>${round2(kcal / portions)} kcal</b>`
    : "Adicione ingredientes para ver os números.";
}
$("recipe-portions").addEventListener("change", updateRecipeTotals);

/* ── boot ── */
(async function boot() {
  try {
    await loadDashboard(); await loadPatients(); await loadPatientSelect(); renderRecipe();
    if (!planMeals.length) { planMeals.push({ name: "Café da manhã", items: [{}, {}] }); renderMeals(); }
    $("btn-add-ingredient").addEventListener("click", () => { recipeItems.push({}); renderRecipe(); });
  } catch (e) { toast("Erro ao carregar: " + e.message); }
})();
