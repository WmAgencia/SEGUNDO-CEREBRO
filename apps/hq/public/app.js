const $ = (id) => document.getElementById(id);
const state = { data: null, agentsById: {} };
const CELL = 40;

function esc(v) { return String(v ?? '').replace(/[&<>'"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }

function agentStateClass(status) {
  const s = String(status || '').toUpperCase();
  if (['WORKING','RUNNING','PLANNING'].includes(s)) return 'state-working';
  if (['BLOCKED','FAILED','ERROR'].includes(s)) return 'state-blocked';
  if (['AVAILABLE','ACTIVE'].includes(s)) return 'state-available';
  if (['PAUSED','WAITING','HANDOFF'].includes(s)) return 'state-paused';
  if (s === 'COMPLETED') return 'state-completed';
  return 'state-idle';
}

function renderFloor(data) {
  const floor = $('floor');
  floor.style.width = data.office.bounds.w + 'px';
  floor.style.height = data.office.bounds.h + 'px';

  let html = '';
  for (const dept of data.office.departments) {
    const a = dept.area;
    html += `<div class="dept-area" style="left:${a.x*CELL}px;top:${a.y*CELL}px;width:${a.w*CELL}px;height:${a.h*CELL}px"><div class="dept-plate">${esc(dept.label)}</div></div>`;
    for (const [agentId, pos] of Object.entries(dept.desks)) {
      html += `<div class="desk-item" style="left:${pos.x-26}px;top:${pos.y-15}px" data-agent="${esc(agentId)}"><div class="desk-monitor"></div></div>`;
    }
  }

  for (const agent of data.agents) {
    const id = String(agent.id); const pos = agent.position;
    if (!pos) continue;
    state.agentsById[id] = agent;
    const cls = agentStateClass(agent.status);
    const color = { manager:'#86c7b1','marketing-agent':'#d8a968','designer-agent':'#c39bd3','social-media-agent':'#7fb3d5','traffic-agent':'#f0b27a','prospector-agent':'#82c99a','commercial-agent':'#e6a8a8','engineering-agent':'#9db8d2','research-agent':'#c9b8db','maintenance-agent':'#a8a8a8' }[id] || '#999';
    html += `<div class="agent ${cls}" id="agent-${esc(id)}" style="left:${pos.x}px;top:${pos.y-38}px" data-agent="${esc(id)}" title="${esc(agent.name)}">
      <span class="name-tag">${esc(String(agent.name).split(' ')[0])}</span>
      <div class="body" style="background:${color}"></div><div class="head"></div><div class="state-dot"></div></div>`;
  }
  floor.innerHTML = html;
  floor.querySelectorAll('.agent').forEach((el) => el.addEventListener('click', () => openProfile(el.dataset.agent)));
}

function animateMovement(eventData) {
  const agentId = eventData.agentId; if (!agentId) return;
  const targetId = eventData.to; if (!targetId) return;
  const targetAgent = state.agentsById[targetId]; if (!targetAgent?.position) return;
  const el = document.getElementById(`agent-${CSS.escape(agentId)}`); if (!el) return;
  el.classList.add('moving');
  const origLeft = el.style.left, origTop = el.style.top;
  el.style.left = targetAgent.position.x + 'px'; el.style.top = (targetAgent.position.y - 38) + 'px';
  setTimeout(() => { el.style.left = origLeft; el.style.top = origTop; setTimeout(() => el.classList.remove('moving'), 900); }, 1600);
}

function render(data) {
  state.data = data;
  renderFloor(data);
  const active = data.goals.filter((g) => g.status === 'ACTIVE').length;
  const running = data.agents.filter((a) => ['WORKING','RUNNING','PLANNING'].includes(String(a.status).toUpperCase())).length;
  const open = data.tasks.filter((t) => !['COMPLETED','CANCELLED','FAILED'].includes(String(t.status).toUpperCase())).length;
  [$('metrics').children[0],$('metrics').children[1],$('metrics').children[2],$('metrics').children[3]].forEach((node, i) => node.querySelector('strong').textContent = [active,running,open,data.approvals.length][i]);
  $('updated').textContent = `Atualizado ${new Date(data.generatedAt).toLocaleTimeString('pt-BR')}`;
  $('task-count').textContent = `${data.tasks.length} TOTAL`;
  const columns = { TODO:['PENDING','READY'], DOING:['ASSIGNED','RUNNING','WAITING'], BLOCKED:['BLOCKED','FAILED'], DONE:['COMPLETED'] };
  $('board').innerHTML = Object.entries(columns).map(([label, statuses]) => {
    const items = data.tasks.filter((t) => statuses.includes(String(t.status).toUpperCase())).slice(0, 4);
    return `<div class="board-col"><h4>${label} (${items.length})</h4>${items.map((t) => `<div class="board-card"><b>${esc(t.title)}</b><span>${esc(t.assigned_agent || 'unassigned')} · ${esc(String(t.status).toLowerCase())}</span></div>`).join('') || '<div class="board-card" style="color:#5a6560">vazio</div>'}</div>`;
  }).join('');
  $('events').innerHTML = data.events.slice(0,10).map((e) => `<div class="event-row"><b>${esc(e.event_type)}</b><span>${esc(e.subject || 'system')}</span></div>`).join('') || '<div class="goal-meta">Aguardando sinais.</div>';
}

async function refresh() {
  try {
    const r = await fetch('/api/hq/state'); if (!r.ok) throw new Error();
    render(await r.json());
    $('connection').textContent = 'LIVE'; document.querySelector('.pulse').style.background = 'var(--teal)';
  } catch { $('connection').textContent = 'OFFLINE'; document.querySelector('.pulse').style.background = 'var(--red)'; }
}

async function openProfile(agentId) {
  $('profile-panel').classList.add('open'); $('profile-content').innerHTML = '<p class="goal-meta">Carregando...</p>';
  try {
    const p = await (await fetch(`/api/hq/agent/${encodeURIComponent(agentId)}`)).json();
    const a = p.agent ?? {}; let domains = [];
    try { domains = JSON.parse(a.domains ?? '[]'); } catch {}
    $('profile-content').innerHTML = `
      <div class="profile-section"><h4>AGENT PROFILE</h4><p style="margin:0;font-size:18px;font-weight:600">${esc(a.name)}</p>
      <small>${esc(p.department || domains.join(', ') || '—')} · ${esc(String(a.status).toLowerCase())}</small></div>
      <div class="profile-section"><h4>TASKS</h4>${(p.tasks??[]).map((t)=>`<div class="profile-item"><b>${esc(t.title)}</b><small>${esc(t.status)}${t.completed_at?' · '+esc(t.completed_at.slice(0,16)):''}</small></div>`).join('')||'<div class="goal-meta">Nenhuma.</div>'}</div>
      <div class="profile-section"><h4>HANDOFFS</h4>${(p.handoffs??[]).map((h)=>`<div class="profile-item">${esc(h.from_agent)} → ${esc(h.to_agent)}<small>${esc(h.summary.slice(0,60))}</small></div>`).join('')||'<div class="goal-meta">Nenhum.</div>'}</div>
      <div class="profile-section"><h4>RUNS</h4>${(p.runs??[]).map((r)=>`<div class="profile-item">${esc(r.id.slice(0,20))}<small>${esc(r.state)} · step ${esc(r.current_step)}</small></div>`).join('')||'<div class="goal-meta">Nenhum.</div>'}</div>`;
  } catch { $('profile-content').innerHTML = '<p class="goal-meta">Erro ao carregar perfil.</p>'; }
}
$('profile-close').addEventListener('click', () => $('profile-panel').classList.remove('open'));

$('execute').addEventListener('click', async () => {
  const text = $('command').value; if (!text.trim()) return;
  $('command-result').textContent = 'Manager processando...';
  try {
    const result = await (await fetch('/api/hq/command', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({text}) })).json();
    $('command-result').textContent = result.message;
    if (result.ok) { $('command').value = ''; await refresh(); }
  } catch { $('command-result').textContent = 'Control plane indisponível.'; }
});
$('command').addEventListener('keydown', (e) => { if ((e.ctrlKey||e.metaKey)&&e.key==='Enter') $('execute').click(); });

let recorder; let chunks=[]; let recordingStarted;
$('voice').addEventListener('click', async () => {
  if (recorder?.state==='recording'){recorder.stop();return}
  if (!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){$('command-result').textContent='Áudio indisponível neste navegador.';return}
  try {
    const stream=await navigator.mediaDevices.getUserMedia({audio:true}); chunks=[]; recordingStarted=Date.now();
    recorder=new MediaRecorder(stream); recorder.ondataavailable=(e)=>chunks.push(e.data);
    recorder.onstop=async()=>{ stream.getTracks().forEach((t)=>t.stop()); $('voice').querySelector('span').textContent='ÁUDIO';
      const blob=new Blob(chunks,{type:recorder.mimeType||'audio/webm'}); const bytes=new Uint8Array(await blob.arrayBuffer());
      let bin=''; bytes.forEach((b)=>bin+=String.fromCharCode(b));
      const result=await(await fetch('/api/hq/transcribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({audio:btoa(bin),mimeType:blob.type,durationMs:Date.now()-recordingStarted})})).json();
      if(result.status!=='TRANSCRIBED'){$('command-result').textContent=result.status;return}
      $('command').value=result.text; $('command-result').textContent='Transcrição recebida. Revise e execute.'};
    recorder.start(); $('voice').querySelector('span').textContent='PARAR'; $('command-result').textContent='Gravando...';
  } catch { $('command-result').textContent='Microfone recusado.'; }
});

if (window.EventSource) {
  const es = new EventSource('/api/hq/events');
  es.onmessage = (msg) => { try { const ev = JSON.parse(msg.data); if (ev.type==='AGENT_MOVE'||ev.type==='HANDOFF_CREATED') animateMovement(ev.payload||{}); } catch {} refresh(); };
  es.onerror = () => { $('connection').textContent='RECONNECTING'; };
}

setInterval(()=>{const c=$('clock');if(c)c.textContent=new Date().toLocaleTimeString('pt-BR')},1000);
setInterval(refresh,30000); refresh();