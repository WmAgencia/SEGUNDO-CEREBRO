const $=id=>document.getElementById(id);
const API=(window.HQ_API_URL??'').replace(/\/$/,'');
const state={data:null,agentsById:{}};
const CELL=40;

const STATUS_PT={AVAILABLE:'Disponível',ACTIVE:'Ativo',IDLE:'Parado',WORKING:'Trabalhando',RUNNING:'Executando',PLANNING:'Planejando',PAUSED:'Pausado',WAITING:'Em espera',BLOCKED:'Bloqueado',FAILED:'Com erro',COMPLETED:'Concluído',HANDOFF:'Transferindo'};
function statusPt(s){return STATUS_PT[String(s||'').toUpperCase()]??String(s||'').toLowerCase()}
function stClass(s){const k=String(s||'').toUpperCase();if(['WORKING','RUNNING','PLANNING'].includes(k))return'st-working';if(['BLOCKED','FAILED'].includes(k))return'st-blocked';if(['AVAILABLE','ACTIVE'].includes(k))return'st-available';if(s==='COMPLETED')return'st-completed';if(['PAUSED','WAITING','HANDOFF'].includes(k))return'st-paused';return'st-idle'}
function esc(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function toast(msg){const t=$('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),3000)}

/* ── RENDER FLOOR ── */
const AGENT_COLORS={manager:'#5cb894','marketing-agent':'#e0a458','designer-agent':'#b39ddb','social-media-agent':'#6ba3c9','traffic-agent':'#f0b27a','prospector-agent':'#82c99a','research-agent':'#c9b8db','sales-agent-01':'#e6a8a8','sales-agent-02':'#d4979a','sales-agent-03':'#c98a8d','sales-agent-04':'#bd7d80','engineering-agent':'#9db8d2','maintenance-agent':'#a0a8a0'};

function renderFloor(data){
  const f=$('floor');
  f.style.width=data.office.bounds.w+'px';
  f.style.height=data.office.bounds.h+'px';
  let h='';
  for(const dept of data.office.departments){
    const a=dept.area;
    h+=`<div class="dept-area" style="left:${a.x*CELL}px;top:${a.y*CELL}px;width:${a.w*CELL}px;height:${a.h*CELL}px"><div class="dept-plate">${esc(dept.label)}</div></div>`;
    for(const[aid,pos]of Object.entries(dept.desks)){
      h+=`<div class="desk-chair" style="left:${pos.x-12}px;top:${pos.y+18}px"></div>`;
      h+=`<div class="desk-item" style="left:${pos.x-28}px;top:${pos.y-16}px"><div class="desk-monitor" data-mon="${esc(aid)}"></div></div>`;
    }
  }
  for(const ag of data.agents){
    const id=String(ag.id);const pos=ag.position;if(!pos)continue;
    state.agentsById[id]=ag;
    const color=AGENT_COLORS[id]||'#999';
    const cls=stClass(ag.status);
    h+=`<div class="agent ${cls}" id="agent-${esc(id)}" style="left:${pos.x}px;top:${pos.y-44}px" data-agent="${esc(id)}" title="${esc(ag.name)} — ${esc(statusPt(ag.status))}"><span class="nametag">${esc(ag.name)}</span><div class="head"></div><div class="body" style="background:${color}"></div><div class="sdot"></div></div>`;
  }
  f.innerHTML=h;
  // Turn on monitors for working agents
  for(const ag of data.agents){
    if(stClass(ag.status)==='st-working'){const mon=f.querySelector(`[data-mon="${CSS.escape(String(ag.id))}"]`);if(mon)mon.classList.add('on')}
  }
  f.querySelectorAll('.agent').forEach(el=>el.addEventListener('click',()=>openProfile(el.dataset.agent)));
}

/* ── MOVEMENT ── */
function animateMove(d){
  const aid=d.agentId,tid=d.to;if(!aid||!tid)return;
  const target=state.agentsById[tid];if(!target?.position)return;
  const el=document.getElementById(`agent-${CSS.escape(aid)}`);if(!el)return;
  el.classList.add('moving');
  const ol=el.style.left,ot=el.style.top;
  el.style.left=target.position.x+'px';el.style.top=(target.position.y-44)+'px';
  setTimeout(()=>{el.style.left=ol;el.style.top=ot;setTimeout(()=>el.classList.remove('moving'),1300)},1800);
}

/* ── RENDER DATA ── */
function render(data){
  state.data=data;renderFloor(data);
  $('metrics').children[0].querySelector('b').textContent=data.goals.filter(g=>g.status==='ACTIVE').length;
  $('metrics').children[1].querySelector('b').textContent=data.tasks.filter(t=>!['COMPLETED','CANCELLED','FAILED'].includes(String(t.status).toUpperCase())).length;
  $('metrics').children[2].querySelector('b').textContent=data.agents.filter(a=>['WORKING','RUNNING','PLANNING'].includes(String(a.status).toUpperCase())).length;
  $('metrics').children[3].querySelector('b').textContent=data.approvals.length;
  $('task-count').textContent=`${data.tasks.length} no total`;
  const cols={'A fazer':['PENDING','READY'],'Em andamento':['ASSIGNED','RUNNING','WAITING'],'Bloqueadas':['BLOCKED','FAILED'],'Concluídas':['COMPLETED']};
  $('board').innerHTML=Object.entries(cols).map(([label,st])=>{
    const items=data.tasks.filter(t=>st.includes(String(t.status).toUpperCase())).slice(0,4);
    return `<div class="board-col"><h4>${label} (${items.length})</h4>${items.map(t=>`<div class="b-card"><b>${esc(t.title)}</b><small>${esc(t.assigned_agent||'sem agente')} · ${esc(statusPt(t.status))}</small></div>`).join('')||'<div class="b-card muted">vazio</div>'}</div>`}).join('');
  $('events').innerHTML=data.events.slice(0,10).map(e=>`<div class="ev-row"><b>${esc(e.event_type)}</b><span>${esc(e.subject||'sistema')}</span></div>`).join('')||'<p class="muted">Aguardando eventos…</p>';
}

async function refresh(){
  try{
    const r=await fetch(`${API}/api/hq/state`);if(!r.ok)throw new Error();
    render(await r.json());
    $('conn-status').textContent='ONLINE';$('conn-status').className='online';$('pulse').style.background='var(--accent)';
  }catch{$('conn-status').textContent='OFFLINE';$('conn-status').className='offline';$('pulse').style.background='var(--red)'}
}

/* ── AGENT PROFILE ── */
async function openProfile(aid){
  $('profile-panel').classList.add('open');$('profile-content').innerHTML='<p class="muted">Carregando…</p>';
  try{
    const p=await(await fetch(`${API}/api/hq/agent/${encodeURIComponent(aid)}`)).json();
    if(!p?.agent){$('profile-content').innerHTML='<p class="muted">Agente não encontrado.</p>';return}
    let domains=[];try{domains=JSON.parse(p.agent.domains??'[]')}catch{}
    const deptName=p.department||domains.join(', ')||'—';
    $('profile-content').innerHTML=`
      <div class="profile-section"><h4>${esc(p.agent.name)}</h4>
      <p class="muted">${esc(deptName)}</p>
      <p style="margin-top:6px;font-size:14px">${esc(statusPt(p.agent.status))}</p></div>
      <div class="profile-section"><h4>Tarefas</h4>${(p.tasks??[]).map(t=>`<div class="p-item"><b>${esc(t.title)}</b><small>${esc(statusPt(t.status))}${t.completed_at?' · '+t.completed_at.slice(0,16):''}</small></div>`).join('')||'<p class="muted">Nenhuma.</p>'}</div>
      <div class="profile-section"><h4>Handoffs</h4>${(p.handoffs??[]).map(h=>`<div class="p-item">${esc(h.from_agent)} → ${esc(h.to_agent)}<small>${esc(h.summary.slice(0,60))}</small></div>`).join('')||'<p class="muted">Nenhum.</p>'}</div>
      <div class="profile-section"><h4>Runs</h4>${(p.runs??[]).map(r=>`<div class="p-item">${esc(r.id.slice(0,22))}<small>${esc(r.state)} · etapa ${r.current_step} · tentativas ${r.retry_count}</small></div>`).join('')||'<p class="muted">Nenhum.</p>'}</div>`;
  }catch{$('profile-content').innerHTML='<p class="muted">Erro ao carregar.</p>'}
}
$('profile-close').addEventListener('click',()=>$('profile-panel').classList.remove('open'));

/* ── COMMAND CENTER ── */
$('btn-command').addEventListener('click',()=>$('cmd-overlay').classList.add('open'));
document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>b.closest('.overlay').classList.remove('open')));
$('cmd-overlay').addEventListener('click',e=>{if(e.target===e.currentTarget)e.currentTarget.classList.remove('open')});

$('btn-send').addEventListener('click',async()=>{
  const text=$('command-input').value;if(!text.trim())return;
  $('command-result').textContent='Orquestrador processando…';
  try{
    const r=await(await fetch(`${API}/api/hq/command`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})})).json();
    $('command-result').textContent=r.message;
    if(r.ok){$('command-input').value='';toast('✓ Comando executado');await refresh();setTimeout(()=>$('cmd-overlay').classList.remove('open'),2000)}
  }catch{$('command-result').textContent='Backend indisponível.'}
});
$('command-input').addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter')$('btn-send').click()});

$('btn-pause').addEventListener('click',async()=>{
  try{const r=await(await fetch(`${API}/api/hq/command`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'pare tudo'})})).json();toast(r.message);await refresh()}catch{toast('Erro ao pausar.')}
});
$('btn-resume').addEventListener('click',async()=>{
  try{const r=await(await fetch(`${API}/api/hq/command`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'continue'})})).json();toast(r.message);await refresh()}catch{toast('Erro ao retomar.')}
});

/* ── VOICE ── */
let recorder,chunks=[],recStart;
$('btn-voice').addEventListener('click',async()=>{
  if(recorder?.state==='recording'){recorder.stop();return}
  if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){$('command-result').textContent='Áudio não suportado neste navegador.';return}
  try{
    const stream=await navigator.mediaDevices.getUserMedia({audio:true});chunks=[];recStart=Date.now();
    recorder=new MediaRecorder(stream);recorder.ondataavailable=e=>chunks.push(e.data);
    recorder.onstop=async()=>{
      stream.getTracks().forEach(t=>t.stop());$('btn-voice').textContent='🎙️ Falar';
      $('command-result').textContent='Transcrevendo…';
      const blob=new Blob(chunks,{type:recorder.mimeType||'audio/webm'});
      const bytes=new Uint8Array(await blob.arrayBuffer());let bin='';bytes.forEach(b=>bin+=String.fromCharCode(b));
      const result=await(await fetch(`${API}/api/hq/transcribe`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({audio:btoa(bin),mimeType:blob.type,durationMs:Date.now()-recStart})})).json();
      if(result.status!=='TRANSCRIBED'){$('command-result').textContent=result.status;return}
      $('command-input').value=result.text;$('command-result').textContent='Transcrição pronta. Revise e envie.';
    };
    recorder.start();$('btn-voice').textContent='⏹ Parar';$('command-result').textContent='Gravando…';
  }catch{$('command-result').textContent='Microfone recusado.'}
});

/* ── SSE + INIT ── */
if(window.EventSource){
  const es=new EventSource(`${API}/api/hq/events`);
  es.onmessage=msg=>{try{const ev=JSON.parse(msg.data);if(ev.type==='AGENT_MOVE'||ev.type==='HANDOFF_CREATED')animateMove(ev.payload||{})}catch{}refresh()};
  es.onerror=()=>{$('conn-status').textContent='RECONECTANDO'};
}
setInterval(()=>{const c=document.querySelector('.clock');if(c)c.textContent=new Date().toLocaleTimeString('pt-BR')},1000);
setInterval(refresh,30000);refresh();