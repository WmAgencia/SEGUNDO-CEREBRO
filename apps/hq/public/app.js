const $=id=>document.getElementById(id);
const API=(window.HQ_API_URL??'').replace(/\/$/,'');
const state={data:null,agentsById:{},cam:{x:0,y:0,zoom:1},dragging:false,lastX:0,lastY:0};
const CELL=40;
const PT={AVAILABLE:'Disponível',ACTIVE:'Ativo',IDLE:'Ocioso',WORKING:'Trabalhando',RUNNING:'Executando',PLANNING:'Planejando',PAUSED:'Em pausa',WAITING:'Aguardando',BLOCKED:'Bloqueado',FAILED:'Com erro',COMPLETED:'Concluído',HANDOFF:'Transferindo',AWAITING_APPROVAL:'Aguardando aprovação',OFFLINE:'Offline'};
function stPt(s){return PT[String(s||'').toUpperCase()]??String(s||'').toLowerCase()}
function stCls(s){const k=String(s||'').toUpperCase();if(['WORKING','RUNNING','PLANNING'].includes(k))return'st-working';if(['BLOCKED','FAILED'].includes(k))return'st-blocked';if(['AVAILABLE','ACTIVE'].includes(k))return'st-available';if(k==='COMPLETED')return'st-completed';if(['PAUSED','WAITING','HANDOFF'].includes(k))return'st-paused';return'st-idle'}
function esc(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function toast(m){const t=$('toast');t.textContent=m;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2500)}

/* ── CAMERA ── */
const vp=$('viewport'),cam=$('camera');
function applyCam(){cam.style.transform=`translate(${state.cam.x}px,${state.cam.y}px) scale(${state.cam.zoom})`}
vp.addEventListener('mousedown',e=>{if(e.target.closest('.agent'))return;state.dragging=true;state.lastX=e.clientX;state.lastY=e.clientY;vp.classList.add('dragging')});
window.addEventListener('mousemove',e=>{if(!state.dragging)return;state.cam.x+=e.clientX-state.lastX;state.cam.y+=e.clientY-state.lastY;state.lastX=e.clientX;state.lastY=e.clientY;applyCam()});
window.addEventListener('mouseup',()=>{state.dragging=false;vp.classList.remove('dragging')});
vp.addEventListener('wheel',e=>{e.preventDefault();const oz=state.cam.zoom;const nz=Math.max(.3,Math.min(3,oz*(e.deltaY>0?.92:1.08)));const r=vp.getBoundingClientRect();const mx=e.clientX-r.left,my=e.clientY-r.top;state.cam.x=mx-(mx-state.cam.x)*nz/oz;state.cam.y=my-(my-state.cam.y)*nz/oz;state.cam.zoom=nz;applyCam()},{passive:false});
$('zoom-in').addEventListener('click',()=>{state.cam.zoom=Math.min(3,state.cam.zoom*1.25);applyCam()});
$('zoom-out').addEventListener('click',()=>{state.cam.zoom=Math.max(.3,state.cam.zoom*.82);applyCam()});
$('zoom-fit').addEventListener('click',()=>{const f=$('floor');if(!f?.offsetWidth)return;state.cam.zoom=Math.min(vp.clientWidth/f.offsetWidth,vp.clientHeight/f.offsetHeight)*.92;state.cam.x=(vp.clientWidth-f.offsetWidth*state.cam.zoom)/2;state.cam.y=(vp.clientHeight-f.offsetHeight*state.cam.zoom)/2;applyCam()});

/* ── RENDER ── */
const COLORS={manager:'#54b892','marketing-agent':'#dfa45a','designer-agent':'#af97d8','social-media-agent':'#689fc7','traffic-agent':'#f0b27a','prospector-agent':'#82c99a','research-agent':'#c9b8db','sales-agent-01':'#e6a8a8','sales-agent-02':'#d4979a','sales-agent-03':'#c98a8d','sales-agent-04':'#bd7d80','engineering-agent':'#9db8d2','maintenance-agent':'#a0a8a0'};
const HAIR={manager:'#3a8a6a','marketing-agent':'#b87a3a','designer-agent':'#8a6ab8','social-media-agent':'#4a7aa8','traffic-agent':'#c08a4a','prospector-agent':'#5a9a72','research-agent':'#9a7ab8','sales-agent-01':'#b86a6a','sales-agent-02':'#a85a5d','sales-agent-03':'#984d50','sales-agent-04':'#884043','engineering-agent':'#6a8aa8','maintenance-agent':'#7a827a'};

function renderDecor(decor){return decor.map(d=>{
  const x=d.x,y=d.y;
  switch(d.type){
    case'plant':return`<div class="decor plant" style="left:${x-8}px;top:${y-12}px"></div>`;
    case'bookshelf':return`<div class="decor bookshelf" style="left:${x-14}px;top:${y-18}px"><span></span></div>`;
    case'whiteboard':return`<div class="decor whiteboard" style="left:${x-24}px;top:${y-15}px"></div>`;
    case'server-rack':return`<div class="decor server-rack" style="left:${x-11}px;top:${y-20}px"></div>`;
    case'sofa':return`<div class="decor sofa" style="left:${x-32}px;top:${y-12}px"></div>`;
    case'coffee-table':return`<div class="decor coffee-table" style="left:${x-16}px;top:${y-9}px"></div>`;
    case'meeting-table':{let h=`<div class="decor meeting-table" style="left:${x-60}px;top:${y-24}px"></div>`;for(let i=0;i<6;i++){const cx=x-45+i*18;h+=`<div class="meeting-chair" style="position:absolute;left:${cx}px;top:${y-38}px"></div>`;h+=`<div class="meeting-chair" style="position:absolute;left:${cx}px;top:${y+22}px"></div>`}return h}
    default:return''}}).join('')}

function renderFloor(data){
  const f=$('floor');
  f.style.width=data.office.bounds.w+'px';f.style.height=data.office.bounds.h+'px';
  let h='';
  for(const dept of data.office.departments){
    const a=dept.area;
    const doorCls=dept.door?`door-${dept.door.side}`:'';
    const doorVar=dept.door?`--door-x:${dept.door.offset*100}%;--door-y:${dept.door.offset*100}%;`:'';
    h+=`<div class="room ${doorCls}" style="left:${a.x*CELL}px;top:${a.y*CELL}px;width:${a.w*CELL}px;height:${a.h*CELL}px;background:${dept.floorColor};${doorVar}"><div class="room-label">${esc(dept.label)}</div></div>`;
    h+=renderDecor(dept.decor||[]);
    for(const[aid,pos]of Object.entries(dept.desks)){
      h+=`<div class="desk-chair" style="left:${pos.x-12}px;top:${pos.y+16}px"></div>`;
      h+=`<div class="desk-item" style="left:${pos.x-30}px;top:${pos.y-18}px"><div class="desk-monitor" data-mon="${esc(aid)}"></div><div class="desk-keyboard"></div></div>`;
    }
  }
  for(const ag of data.agents){
    const id=String(ag.id),pos=ag.position;if(!pos)continue;
    state.agentsById[id]=ag;
    const color=COLORS[id]||'#999',hair=HAIR[id]||color;
    const opState=ag.operationalState||ag.status;
    const cls=stCls(opState);
    h+=`<div class="agent ${cls}" id="agent-${esc(id)}" style="left:${pos.x}px;top:${pos.y-50}px" data-agent="${esc(id)}" title="${esc(ag.name)} — ${esc(stPt(opState))}${ag.operationalReason?' ('+esc(ag.operationalReason)+')':''}"><span class="nametag">${esc(ag.name)}</span><div class="hair" style="background:${hair}"></div><div class="head"></div><div class="body" style="background:${color}"></div><div class="sdot"></div></div>`;
  }
  f.innerHTML=h;
  // Owner character in meeting room
  const meetingRoom=data.office.departments.find(d=>d.id==='meeting');
  if(meetingRoom){
    const mx=(meetingRoom.area.x+meetingRoom.area.w/2)*CELL-40;
    const my=(meetingRoom.area.y+meetingRoom.area.h/2)*CELL;
    f.insertAdjacentHTML('beforeend',`<div class="agent st-available" id="agent-owner" style="left:${mx}px;top:${my-50}px" title="Wesley (Owner)"><span class="nametag">Wesley</span><div class="hair" style="background:#3a5a3a"></div><div class="head"></div><div class="body" style="background:#4a8a5a"></div><div class="sdot" style="background:var(--accent)"></div></div>`);
  }
  // Turn on monitors for working agents
  for(const ag of data.agents){
    const opState=ag.operationalState||ag.status;
    if(stCls(opState)==='st-working'){const m=f.querySelector(`[data-mon="${CSS.escape(String(ag.id))}"]`);if(m)m.classList.add('on')}
  }
  f.querySelectorAll('.agent').forEach(el=>el.addEventListener('click',()=>{if(el.dataset.agent!=='owner')openProfile(el.dataset.agent)}));
}

function animateMove(d){
  const aid=d.agentId,tid=d.to;if(!aid||!tid)return;
  const target=state.agentsById[tid];if(!target?.position)return;
  const el=document.getElementById(`agent-${CSS.escape(aid)}`);if(!el)return;
  el.classList.add('moving');
  const ol=el.style.left,ot=el.style.top;
  el.style.left=target.position.x+'px';el.style.top=(target.position.y-50)+'px';
  setTimeout(()=>{el.style.left=ol;el.style.top=ot;setTimeout(()=>el.classList.remove('moving'),1100)},1600);
}

function render(data){
  state.data=data;renderFloor(data);
  $('metrics').children[0].querySelector('b').textContent=data.goals.filter(g=>g.status==='ACTIVE').length;
  $('metrics').children[1].querySelector('b').textContent=data.tasks.filter(t=>!['COMPLETED','CANCELLED','FAILED'].includes(String(t.status).toUpperCase())).length;
  $('metrics').children[2].querySelector('b').textContent=data.agents.filter(a=>['WORKING','RUNNING','PLANNING'].includes(String(a.status).toUpperCase())).length;
  $('metrics').children[3].querySelector('b').textContent=data.approvals.length;
  const cols={'A fazer':['PENDING','READY'],'Em andamento':['ASSIGNED','RUNNING','WAITING'],'Bloqueadas':['BLOCKED','FAILED'],'Concluídas':['COMPLETED']};
  $('board').innerHTML=Object.entries(cols).map(([l,st])=>{const items=data.tasks.filter(t=>st.includes(String(t.status).toUpperCase())).slice(0,4);return`<div class="b-col"><h5>${l}</h5>${items.map(t=>`<div class="b-card"><b>${esc(t.title)}</b><small>${esc(t.assigned_agent||'—')}</small></div>`).join('')}</div>`}).join('');
  $('events').innerHTML=data.events.slice(0,12).map(e=>`<div class="ev-row"><b>${esc(e.event_type)}</b><span>${esc(e.subject||'sistema')}</span></div>`).join('');
}

async function refresh(){
  try{const r=await fetch(`${API}/api/hq/state`);if(!r.ok)throw new Error();render(await r.json());$('conn-status').textContent='ONLINE';$('conn-status').className='online';$('pulse').style.background='var(--accent)'}
  catch{$('conn-status').textContent='OFFLINE';$('conn-status').className='offline';$('pulse').style.background='var(--red)'}
}

async function openProfile(aid){
  $('profile-panel').classList.add('open');$('profile-content').innerHTML='<p class="muted">Carregando…</p>';
  try{
    const p=await(await fetch(`${API}/api/hq/agent/${encodeURIComponent(aid)}`)).json();
    if(!p?.agent){$('profile-content').innerHTML='<p class="muted">Não encontrado.</p>';return}
    let dm=[];try{dm=JSON.parse(p.agent.domains??'[]')}catch{}
    $('profile-content').innerHTML=`
      <div class="p-sec"><h4>${esc(p.agent.name)}</h4><p class="muted">${esc(p.department||dm.join(', ')||'—')}</p><p style="margin-top:4px;font-size:13px">${esc(stPt(p.agent.status))}</p></div>
      <div class="p-sec"><h4>Tarefas</h4>${(p.tasks??[]).map(t=>`<div class="p-item"><b>${esc(t.title)}</b><small>${esc(stPt(t.status))}</small></div>`).join('')||'<p class="muted">Nenhuma.</p>'}</div>
      <div class="p-sec"><h4>Handoffs</h4>${(p.handoffs??[]).map(h=>`<div class="p-item">${esc(h.from_agent)} → ${esc(h.to_agent)}<small>${esc(h.summary.slice(0,50))}</small></div>`).join('')||'<p class="muted">Nenhum.</p>'}</div>
      <div class="p-sec"><h4>Runs</h4>${(p.runs??[]).map(r=>`<div class="p-item">${esc(r.id.slice(0,22))}<small>${esc(r.state)}</small></div>`).join('')||'<p class="muted">Nenhum.</p>'}</div>`;
  }catch{$('profile-content').innerHTML='<p class="muted">Erro.</p>'}
}
$('profile-close').addEventListener('click',()=>$('profile-panel').classList.remove('open'));

/* ── MODES ── */
let currentMode='plane';
document.querySelectorAll('.mode-btn').forEach(btn=>btn.addEventListener('click',()=>{
  const mode=btn.dataset.mode;
  document.querySelectorAll('.mode-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  currentMode=mode;$('mode-badge').textContent=mode.charAt(0).toUpperCase()+mode.slice(1);
  // Send mode switch to backend
  fetch(`${API}/api/hq/command`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:mode})}).then(r=>r.json()).then(r=>{addMsg(r.message,'mgr')}).catch(()=>{});
}));
$('command-input').addEventListener('keydown',e=>{
  if(e.key==='Tab'){e.preventDefault();
    const modes=['plane','brain','build'];const idx=modes.indexOf(currentMode);
    const next=modes[(idx+1)%modes.length];
    document.querySelector(`[data-mode="${next}"]`)?.click();
    return}
  if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('btn-send').click()}
});

/* ── MANAGER MEETING MOVEMENT ── */
let managerOriginalPos=null;
function managerToMeeting(open){
  const mgrEl=document.getElementById('agent-manager');
  if(!mgrEl)return;
  const floor=$('floor');if(!floor)return;
  const meetingRoom=state.data?.office?.departments?.find(d=>d.id==='meeting');
  if(!meetingRoom)return;
  if(open){
    if(!managerOriginalPos)managerOriginalPos={left:mgrEl.style.left,top:mgrEl.style.top};
    const mx=(meetingRoom.area.x+meetingRoom.area.w/2)*CELL+40;
    const my=(meetingRoom.area.y+meetingRoom.area.h/2)*CELL;
    mgrEl.classList.add('moving');
    mgrEl.style.left=mx+'px';mgrEl.style.top=(my-50)+'px';
    setTimeout(()=>mgrEl.classList.remove('moving'),1200);
  }else if(managerOriginalPos){
    mgrEl.classList.add('moving');
    mgrEl.style.left=managerOriginalPos.left;mgrEl.style.top=managerOriginalPos.top;
    setTimeout(()=>{mgrEl.classList.remove('moving');managerOriginalPos=null},1200);
  }
}

/* ── SIDEBAR ── */
$('btn-command').addEventListener('click',()=>{
  const isOpen=$('cmd-sidebar').classList.toggle('open');
  managerToMeeting(isOpen);
  if(isOpen)$('command-input').focus();
});
$('cmd-close').addEventListener('click',()=>{$('cmd-sidebar').classList.remove('open');managerToMeeting(false)});
$('panel-toggle').addEventListener('click',()=>$('bottom-panels').classList.toggle('collapsed'));

function addMsg(text,who){const b=$('chat-body');const d=document.createElement('div');d.className=`msg ${who==='user'?'user':'mgr'}`;if(who!=='user'){d.innerHTML='<small>Gerente</small>'+esc(text)}else d.textContent=text;b.appendChild(d);b.scrollTop=b.scrollHeight}

$('btn-send').addEventListener('click',async()=>{
  const text=$('command-input').value;if(!text.trim())return;
  addMsg(text,'user');$('command-input').value='';$('command-result').textContent='';
  try{const r=await(await fetch(`${API}/api/hq/command`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})})).json();
    addMsg(r.message,'mgr');
    if(r.contextCards){r.contextCards.forEach(c=>addMsg(`${c.label}: ${c.value}`,'mgr'))}
    if(r.ok&&!r.requiresConfirmation){toast('✓');await refresh()}
  }catch{addMsg('Backend indisponível.','mgr')}
});
$('command-input').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('btn-send').click()}});
$('btn-pause').addEventListener('click',async()=>{try{addMsg('pare tudo','user');const r=await(await fetch(`${API}/api/hq/command`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'pare tudo'})})).json();addMsg(r.message,'mgr');await refresh()}catch{toast('Erro.')}});
$('btn-resume').addEventListener('click',async()=>{try{addMsg('continue','user');const r=await(await fetch(`${API}/api/hq/command`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'continue'})})).json();addMsg(r.message,'mgr');await refresh()}catch{toast('Erro.')}});

/* ── VOICE ── */
let recorder,chunks=[],recStart;
$('btn-voice').addEventListener('click',async()=>{
  if(recorder?.state==='recording'){recorder.stop();return}
  if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){$('command-result').textContent='Áudio não suportado.';return}
  try{
    const stream=await navigator.mediaDevices.getUserMedia({audio:true});chunks=[];recStart=Date.now();
    recorder=new MediaRecorder(stream);recorder.ondataavailable=e=>chunks.push(e.data);
    recorder.onstop=async()=>{stream.getTracks().forEach(t=>t.stop());$('btn-voice').textContent='🎙️ Falar';$('command-result').textContent='Transcrevendo…';
      const blob=new Blob(chunks,{type:recorder.mimeType||'audio/webm'});const bytes=new Uint8Array(await blob.arrayBuffer());let bin='';bytes.forEach(b=>bin+=String.fromCharCode(b));
      const r=await(await fetch(`${API}/api/hq/transcribe`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({audio:btoa(bin),mimeType:blob.type,durationMs:Date.now()-recStart})})).json();
      if(r.status!=='TRANSCRIBED'){$('command-result').textContent=r.status;return}
      $('command-input').value=r.text;$('command-result').textContent='Revise e envie.'};
    recorder.start();$('btn-voice').textContent='⏹ Parar';$('command-result').textContent='Gravando…';
  }catch{$('command-result').textContent='Microfone recusado.'}
});

/* ── SSE ── */
if(window.EventSource){
  const es=new EventSource(`${API}/api/hq/events`);
  es.onmessage=msg=>{try{const ev=JSON.parse(msg.data);if(ev.type==='AGENT_MOVE'||ev.type==='HANDOFF_CREATED')animateMove(ev.payload||{})}catch{}refresh()};
  es.onerror=()=>{$('conn-status').textContent='RECONECTANDO'};
}
setTimeout(()=>$('zoom-fit').click(),300);
setInterval(refresh,30000);refresh();