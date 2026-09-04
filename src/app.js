const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const storeKey = 'tube-autopilot-jobs';
const defaultJobs = [];
let authState = { connected: false, configured: false, channel: null, accounts: [], defaultAccountId: null, user: null };

function jobs(){try{return JSON.parse(localStorage.getItem(storeKey))||defaultJobs}catch{return defaultJobs}}
function saveJobs(v){localStorage.setItem(storeKey,JSON.stringify(v));renderJobs()}
function go(id){$$('.view').forEach(v=>v.classList.toggle('active',v.id===id));$$('.nav-item').forEach(n=>n.classList.toggle('active',n.dataset.view===id));$('.sidebar').classList.remove('open');window.scrollTo({top:0,behavior:'smooth'});history.replaceState(null,'','#'+id)}
$$('[data-view]').forEach(b=>b.onclick=()=>go(b.dataset.view));
$$('[data-go]').forEach(b=>b.onclick=()=>go(b.dataset.go));
$('#menuBtn').onclick=()=>$('.sidebar').classList.toggle('open');

$('#videoFile').onchange=e=>{
  const f=e.target.files[0];
  $('#fileName').textContent=f ? `${f.name} • ${(f.size/1024/1024).toFixed(1)} MB` : 'Nenhum arquivo selecionado';
};

function toast(t, ms=3000){const el=$('#toast');el.textContent=t;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),ms)}
function escapeHtml(v=''){return String(v).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}

function showLogin(){document.body.classList.add('logged-out');$('#login').classList.remove('hidden')}
function showApp(){document.body.classList.remove('logged-out');$('#login').classList.add('hidden');if($('#user-email'))$('#user-email').textContent=authState.user?.email||''}
async function initAuth(){
  try{
    const r=await fetch('/api/auth/session',{headers:{'Accept':'application/json'}});
    if(r.status===401){authState.user=null;showLogin();return}
    const d=await r.json();
    if(!d.user){authState.user=null;showLogin();return}
    authState.user=d.user;
    showApp();
    await loadApp();
  }catch(e){authState.user=null;showLogin()}
}
async function loadApp(){
  renderJobs();
  loadAuthStatus();
  loadDashboardStats();
  refreshDashboard();
  loadGeneratorCategories();
  loadCommentSettings();
  if(location.hash==='#library')loadChannelStock();
  if(location.hash==='#shorts'){loadChannelShorts();setShortSource('stock')}
  if(location.hash==='#metadata')loadMetadataPage();
  if(location.hash==='#channel')loadChannelPage();
  if(location.hash==='#schedules')loadSchedulesPage();
  if(location.hash.startsWith('#tiktok-')){loadTikTokAuth();loadTikTokVideos()}
  await initPlatformHub();
}
let loginMode='login';
function setLoginTab(mode){loginMode=mode;$('#loginSubmit').textContent=mode==='login'?'Entrar':'Criar conta';$$('.login-tab').forEach(t=>t.classList.toggle('active',t.dataset.loginTab===mode))}
$$('.login-tab').forEach(t=>t.onclick=()=>setLoginTab(t.dataset.loginTab));
$('#loginForm').onsubmit=async e=>{
  e.preventDefault();
  const errorBox=$('#login-error');errorBox.textContent='';
  const email=$('#loginEmail').value.trim();
  const password=$('#loginPassword').value;
  if(!email||!password){errorBox.textContent='Preencha e-mail e senha.';return}
  const btn=$('#loginSubmit');btn.disabled=true;btn.textContent=loginMode==='login'?'Entrando...':'Criando conta...';
  try{
    const r=await fetch(loginMode==='login'?'/api/auth/login':'/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});
    const d=await r.json();
    if(!r.ok)throw new Error(d.error||'Não foi possível concluir a operação.');
    $('#loginForm').reset();
    $('#login-error').textContent='';
    await initAuth();
  }catch(err){
    errorBox.textContent=err.message||'Não foi possível concluir a operação.';
  }finally{btn.disabled=false;btn.textContent=loginMode==='login'?'Entrar':'Criar conta'}
};
$('#logoutBtn').onclick=async()=>{
  try{await fetch('/api/auth/logout',{method:'POST'})}catch{}
  authState={connected:false,configured:false,channel:null,accounts:[],defaultAccountId:null,user:null};
  stockState.items=[];stockState.selected=new Set();stockState.accounts=[];stockState.scheduleIds=[];stockState.preview=null;
  shortsState.items=[];shortsState.selected=new Set();shortsState.accounts=[];shortsState.stockItems=[];shortsState.stockSelected=new Set();shortsState.shortHashes=new Set();
  ttState.items=[];ttState.selected=new Set();
  if(localStorage.getItem(storeKey))localStorage.removeItem(storeKey);
  $('#loginForm').reset();$('#login-error').textContent='';
  showLogin();
};

$('#generateBtn').onclick=async()=>{
  const btn=$('#generateBtn');btn.disabled=true;btn.textContent='✦ Gerando...';$('#aiStatus').textContent='Processando';
  try{
    const r=await fetch('/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({topic:$('#topic').value,keywords:$('#keywords').value,tone:$('#tone').value})});
    const d=await r.json(); if(!r.ok) throw new Error(d.error||'Erro');
    $('#resultTitle').value=d.title;$('#resultDescription').value=d.description;$('#resultTags').value=d.tags;$('#scheduleTitle').value=d.title;$('#aiStatus').textContent='Pronto';toast('Conteúdo gerado com sucesso');
  }catch(e){$('#aiStatus').textContent='Erro';toast(e.message||'Não foi possível gerar agora')}
  finally{btn.disabled=false;btn.textContent='✦ Gerar título, descrição e tags'}
};

function seekVideo(video,time){return new Promise((resolve,reject)=>{video.addEventListener('seeked',resolve,{once:true});video.addEventListener('error',reject,{once:true});video.currentTime=Math.min(time,Math.max(0,video.duration-.05))})}
async function extractVideoFrames(file,count=5){
  const video=document.createElement('video');video.muted=true;video.preload='metadata';video.src=URL.createObjectURL(file);
  try{
    await new Promise((resolve,reject)=>{video.onloadedmetadata=resolve;video.onerror=()=>reject(new Error('Nao foi possivel ler este formato de video'))});
    const canvas=document.createElement('canvas');const scale=Math.min(1,640/video.videoWidth);canvas.width=Math.max(1,Math.round(video.videoWidth*scale));canvas.height=Math.max(1,Math.round(video.videoHeight*scale));const ctx=canvas.getContext('2d');const frames=[];
    for(let i=0;i<count;i++){await seekVideo(video,video.duration*((i+.5)/count));ctx.drawImage(video,0,0,canvas.width,canvas.height);frames.push(canvas.toDataURL('image/jpeg',.72))}
    return frames;
  }finally{URL.revokeObjectURL(video.src)}
}
function renderTitleSuggestions(titles=[]){
  const box=$('#titleSuggestions');box.classList.toggle('hidden',!titles.length);
  box.innerHTML=titles.length?`<small>Escolha um dos titulos gerados para este video:</small>${titles.map((title,i)=>`<button type="button" class="title-option ${i===0?'active':''}" data-title="${escapeHtml(title)}">${escapeHtml(title)}</button>`).join('')}`:'';
  box.querySelectorAll('.title-option').forEach(btn=>btn.onclick=()=>{box.querySelectorAll('.title-option').forEach(v=>v.classList.remove('active'));btn.classList.add('active');$('#resultTitle').value=btn.dataset.title;$('#scheduleTitle').value=btn.dataset.title});
}
let generatorCategories=[];
let generatorYoutubeCategoryId='20';
function applyGeneratorCategory(){
  const config=generatorCategories.find(v=>v.id===$('#generatorCategory').value);if(!config)return;
  $('#resultDescription').value=config.description||'';$('#resultTags').value=(config.tags||[]).join(', ');generatorYoutubeCategoryId=config.youtubeCategoryId;$('#generatorYoutubeCategory').textContent=config.youtubeCategoryName||'Jogos';
  if(!config.description||!config.tags?.length){console.error('[metadata] BUG: descrição ou tags vazias para',config.id);toast('Erro: metadados da categoria estão vazios',7000)}
}
async function loadGeneratorCategories(){
  try{generatorCategories=await stockApi('/api/inventory/categories');const current=$('#generatorCategory').value;$('#generatorCategory').innerHTML=generatorCategories.map(v=>`<option value="${escapeHtml(v.id)}">${escapeHtml(v.emoji)} ${escapeHtml(v.name)}</option>`).join('');if(generatorCategories.some(v=>v.id===current))$('#generatorCategory').value=current;applyGeneratorCategory()}
  catch(error){toast(`Falha ao carregar categorias: ${error.message}`,7000)}
}
async function generateFromVideo(){
  const file=$('#videoFile').files[0];if(!file){toast('Selecione um video primeiro');return}
  const btn=$('#generateBtn');btn.disabled=true;btn.textContent='Gerando titulos automaticos...';$('#aiStatus').textContent='Processando';
  try{
    const r=await fetch('/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({categoryId:$('#generatorCategory').value,topic:$('#topic').value,keywords:$('#keywords').value,tone:$('#tone').value,fileName:file.name})});
    const d=await r.json();if(!r.ok)throw new Error(d.error||'Erro');
    if(!d.description||!Array.isArray(d.tags)||d.tags.length!==14)throw new Error('BUG: descrição fixa ou tags da categoria não foram carregadas');
    renderTitleSuggestions(d.titles);$('#resultTitle').value=d.title;$('#resultDescription').value=d.description;$('#resultTags').value=d.tags.join(', ');generatorYoutubeCategoryId=d.youtubeCategoryId;$('#generatorYoutubeCategory').textContent=d.youtubeCategoryName||'Jogos';$('#scheduleTitle').value=d.title;$('#aiStatus').textContent='Pronto';toast('Título gerado e metadados da categoria aplicados');
  }catch(e){$('#aiStatus').textContent='Erro';toast(e.message||'Nao foi possivel gerar agora',6000)}
  finally{btn.disabled=false;btn.textContent='Gerar título e aplicar metadados'}
}
$('#generateBtn').onclick=generateFromVideo;
$('#videoFile').addEventListener('change',()=>{if($('#videoFile').files[0])generateFromVideo()});
$('#generatorCategory').addEventListener('change',applyGeneratorCategory);

async function loadAuthStatus(){
  try{
    const r=await fetch('/api/auth/status');
    authState=await r.json();
    const connected=Boolean(authState.connected);
    const defaultAccount=authState.accounts?.find(account=>account.accountId===authState.defaultAccountId)||authState.accounts?.find(account=>account.connected)||null;
    if(sessionStorage.getItem('tube-autopilot-platform')!=='tiktok'){
      $('#topChannelText').textContent=connected ? `${authState.connectedCount} canal(is) · ${defaultAccount?.channelTitle||'YouTube'}` : 'YouTube desconectado';
      $('#topStatusDot').classList.toggle('offline',!connected);
    }
    $('#youtubeSettingText').textContent=connected ? `${authState.connectedCount} canal(is) conectado(s). Padrão: ${defaultAccount?.channelTitle||'não definido'}.` : 'Conecte sua conta com OAuth 2.0 para enviar e agendar vídeos.';
    $('#connectYoutubeBtn').classList.remove('hidden');
    $('#disconnectYoutubeBtn').classList.add('hidden');
    $('#youtubeConfigHint').textContent=!authState.configured ? 'Faltam YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET e YOUTUBE_REDIRECT_URI no arquivo .env.' : '';
    if(defaultAccount?.channelThumbnail){$('#topAvatar').style.backgroundImage=`url("${defaultAccount.channelThumbnail}")`;$('#topAvatar').textContent='';$('#topAvatar').classList.add('has-image')}
    renderYoutubeAccountSelectors();
  }catch(e){console.error(e)}
}

function accountLabel(account){return `${account.channelTitle||account.channelId}${account.isDefault?' (padrão)':''}`}
function renderYoutubeAccountSelectors(){
  const connected=(authState.accounts||[]).filter(account=>account.connected);
  $$('.youtube-account-select').forEach(select=>{
    const previous=select.value;
    const allowAll=select.id==='schedulesAccount';
    select.innerHTML=(allowAll?'<option value="">Todos os canais</option>':'')+connected.map(account=>`<option value="${escapeHtml(account.accountId)}">${escapeHtml(accountLabel(account))}</option>`).join('');
    select.value=connected.some(account=>account.accountId===previous)||allowAll&&previous===''?previous:(authState.defaultAccountId||connected[0]?.accountId||'');
  });
}

$('#disconnectYoutubeBtn').onclick=()=>go('channel');

function updateUploadProgress(pct,text){$('#uploadProgress').style.width=`${pct}%`;$('#uploadProgressText').textContent=text}

$('#scheduleBtn').onclick=()=>{
  const file=$('#videoFile').files[0];
  const title=$('#scheduleTitle').value.trim() || $('#resultTitle').value.trim();
  const date=$('#scheduleDate').value;
  const time=$('#scheduleTime').value;
  const accountId=$('#scheduleAccount').value||$('#generatorAccount').value;
  if(!accountId){toast('Selecione ou conecte um canal do YouTube');go('channel');return}
  if(!file){toast('Selecione o vídeo na tela Gerar conteúdo');go('generator');return}
  if(!title||!date||!time){toast('Preencha título, data e hora');return}

  const fd=new FormData();
  fd.append('video',file);
  fd.append('accountId',accountId);
  fd.append('title',title);
  fd.append('description',$('#resultDescription').value);
  fd.append('tags',$('#resultTags').value);
  fd.append('youtubeCategoryId',generatorYoutubeCategoryId);
  fd.append('categoryId',$('#generatorCategory').value);
  fd.append('date',date);fd.append('time',time);fd.append('visibility',$('#visibility').value);fd.append('notify',$('#notify').checked?'true':'false');

  const btn=$('#scheduleBtn');btn.disabled=true;btn.textContent='Enviando para o YouTube...';updateUploadProgress(5,'Preparando upload...');
  const xhr=new XMLHttpRequest();
  xhr.open('POST','/api/youtube/upload');
  xhr.upload.onprogress=e=>{if(e.lengthComputable){const pct=Math.max(5,Math.round((e.loaded/e.total)*90));updateUploadProgress(pct,`Enviando... ${pct}%`)}};
  xhr.onload=()=>{
    let d={}; try{d=JSON.parse(xhr.responseText||'{}')}catch{}
    btn.disabled=false;btn.textContent='⬆ Enviar / agendar no YouTube';
    if(xhr.status>=200&&xhr.status<300){
      updateUploadProgress(100,d.scheduled?'Agendado no YouTube ✓':'Enviado ao YouTube ✓');
      const item={id:d.id,title,date,time,visibility:$('#visibility').value,url:d.url,status:d.scheduled?'Agendado':'Enviado'};
      const all=jobs();all.push(item);saveJobs(all);toast(d.scheduled?'Vídeo enviado e agendado no YouTube!':'Vídeo enviado para o YouTube!',5000);
    }else{updateUploadProgress(0,'Falha no envio');toast(d.error||'Falha ao enviar para o YouTube',6000)}
  };
  xhr.onerror=()=>{btn.disabled=false;btn.textContent='⬆ Enviar / agendar no YouTube';updateUploadProgress(0,'Erro de conexão');toast('Erro de conexão durante o upload')};
  xhr.send(fd);
};

function fmtDate(d){if(!d)return '';return new Date(d+'T12:00:00').toLocaleDateString('pt-BR',{day:'2-digit',month:'short'})}
function renderJobs(){
  const all=jobs().sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time));
  $('#queueCount').textContent=`${all.length} vídeos`;
  $('#queue').innerHTML=all.map((j,i)=>`<div class="queue-item"><div class="thumb">▶</div><div><strong>${escapeHtml(j.title)}</strong><small>${fmtDate(j.date)} • ${j.time} • ${escapeHtml(j.visibility)}${j.status?' • '+escapeHtml(j.status):''}</small>${j.url?`<a href="${j.url}" target="_blank" rel="noopener">Abrir no YouTube ↗</a>`:''}</div><button class="text-btn" onclick="removeJob(${i})">Remover da lista</button></div>`).join('')||'<div class="empty"><p>Nenhum vídeo enviado por este navegador ainda.</p></div>';
  $('#upcomingList').innerHTML=all.slice(0,3).map(j=>`<div class="video-row"><div class="thumb">▶</div><div><strong>${escapeHtml(j.title)}</strong><small>${escapeHtml(j.status||j.visibility)}</small></div><time>${fmtDate(j.date)} · ${j.time}</time></div>`).join('')||'<div class="empty"><p>Nenhuma publicação na fila.</p></div>';
}
window.removeJob=i=>{const all=jobs().sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time));all.splice(i,1);saveJobs(all);toast('Item removido da lista local')};

const today=new Date();today.setDate(today.getDate()+1);$('#scheduleDate').value=today.toISOString().slice(0,10);
const qs=new URLSearchParams(location.search);const authMsg=qs.get('auth');
if(authMsg==='success')toast('Google/YouTube conectado com sucesso!',5000);
if(authMsg==='missing-config')toast('Configure as credenciais do Google no arquivo .env',6000);
if(authMsg==='denied')toast('Você cancelou a autorização do Google',5000);
if(authMsg==='error')toast('Falha ao concluir o login com Google',6000);
if(authMsg==='channel-claimed'){toast('Este canal já está conectado a outra conta',6000);go('settings')}
if(authMsg==='require-login')toast('Faça login antes de conectar um canal do YouTube',6000);
const ttMsg=qs.get('tiktok');if(ttMsg==='success')toast('TikTok conectado com sucesso!',5000);if(ttMsg==='missing-config')toast('Configure as credenciais do TikTok no arquivo .env',7000);if(ttMsg==='denied')toast('Você cancelou a autorização do TikTok',5000);if(ttMsg==='error')toast('Falha ao concluir o login com TikTok',7000);
if(location.hash && document.querySelector(location.hash))go(location.hash.slice(1));

const stockState={items:[],selected:new Set(),scheduleIds:[],preview:null,accounts:[],accountId:'__unassigned__',status:'AVAILABLE'};
const stockStatus={AVAILABLE:'Disponível',SCHEDULED:'Agendado',UPLOADING:'Enviando',PUBLISHED:'Publicado',ERROR:'Erro'};
async function stockApi(url,options={}){const response=await fetch(url,options);let data={};try{data=await response.json()}catch{}if(!response.ok)throw new Error(data.error||`Falha na operação (${response.status})`);return data}
async function loadStockCategories(){
  try{const current=$('#stockCategory').value;const categories=await stockApi('/api/inventory/categories');$('#stockCategory').innerHTML=categories.map(v=>`<option value="${escapeHtml(v.id)}">${escapeHtml(v.emoji)} ${escapeHtml(v.name)}</option>`).join('');if(categories.some(v=>v.id===current))$('#stockCategory').value=current;await loadStock()}
  catch(error){toast(error.message,6000)}
}
async function loadStockChannels(){
  try{
    stockState.accounts=(await stockApi('/api/auth/accounts')).filter(account=>account.connected);
    if(!stockState.accounts.some(account=>account.accountId===stockState.accountId)) stockState.accountId=stockState.accounts.find(account=>account.isDefault)?.accountId||stockState.accounts[0]?.accountId||'__unassigned__';
    const tabs=$('#stockChannelTabs');
    tabs.innerHTML=stockState.accounts.map(account=>`<button class="stock-channel-tab ${stockState.accountId===account.accountId?'active':''}" data-stock-account="${escapeHtml(account.accountId)}">${escapeHtml(accountLabel(account))}</button>`).join('')+`<button class="stock-channel-tab ${stockState.accountId==='__unassigned__'?'active':''}" data-stock-account="__unassigned__">Sem canal</button>`;
    $('#stockAssignAccount').innerHTML=stockState.accounts.map(account=>`<option value="${escapeHtml(account.accountId)}">${escapeHtml(accountLabel(account))}</option>`).join('');
    tabs.querySelectorAll('[data-stock-account]').forEach(button=>button.onclick=()=>{stockState.accountId=button.dataset.stockAccount;stockState.selected.clear();tabs.querySelectorAll('.stock-channel-tab').forEach(tab=>tab.classList.toggle('active',tab===button));loadStock()});
  }catch(error){toast(error.message,6000)}
}
async function loadStock(){
  if(!$('#stockList'))return;
  try{
    const category=encodeURIComponent($('#stockCategory').value),account=encodeURIComponent(stockState.accountId);
    const [items,stats]=await Promise.all([
      stockApi(`/api/inventory?contentType=LONG&categoryId=${category}&accountId=${account}&status=${encodeURIComponent(stockState.status)}`),
      stockApi(`/api/inventory/stats?contentType=LONG&categoryId=${category}&accountId=${account}`)
    ]);
    stockState.items=items;
    $('#stockAvailable').textContent=stats.available;$('#stockScheduled').textContent=stats.scheduled;$('#stockPublished').textContent=stats.published;$('#stockErrors').textContent=stats.errors;
    stockState.selected=new Set([...stockState.selected].filter(id=>stockState.items.some(v=>v.id===id)));
    if(!['AVAILABLE','ERROR'].includes(stockState.status))stockState.selected.clear();
    renderStock();
  }
  catch(error){$('#stockList').innerHTML=`<div class="empty"><p>${escapeHtml(error.message)}</p></div>`;toast(error.message,6000)}
}
function selectedStockItems(){return stockState.items.filter(v=>stockState.selected.has(v.id))}
function renderStock(){
  const selected=selectedStockItems();$('#stockSelectedCount').textContent=selected.length;$('#stockBulkBar').classList.toggle('hidden',!selected.length);$('#stockSelectAll').checked=stockState.items.length>0&&selected.length===stockState.items.length;
  $('#stockList').innerHTML=stockState.items.map(item=>`<article class="stock-item ${item.status==='ERROR'?'has-error':''}">
    <input class="stock-check" type="checkbox" data-id="${item.id}" ${stockState.selected.has(item.id)?'checked':''}>
    <div class="stock-thumb">▶</div><div class="stock-info"><small>${escapeHtml(item.originalFilename)} · ${item.contentType==='SHORT'?'SHORT':'LONG'}</small><input class="stock-title-input" data-id="${item.id}" value="${escapeHtml(item.title)}" maxlength="100" ${!['AVAILABLE','ERROR'].includes(item.status)?'disabled':''}><div class="stock-meta"><span>Descrição configurada ✓</span><span>${item.tags.length} tags ✓</span><span>Categoria: ${escapeHtml(item.youtubeCategoryName)}</span><span class="status status-${item.status.toLowerCase()}">${stockStatus[item.status]||item.status}</span>${item.error?`<span class="stock-error">${escapeHtml(item.error)}</span>`:''}</div></div>
    <div class="stock-actions"><button data-action="save" data-id="${item.id}" class="text-btn">Editar</button><button data-action="regenerate" data-id="${item.id}" class="text-btn">Outro título</button><button data-action="send" data-id="${item.id}" class="text-btn" ${item.youtubeVideoId||item.status==='UPLOADING'?'disabled':''}>Enviar agora</button><button data-action="schedule" data-id="${item.id}" class="text-btn" ${item.youtubeVideoId||item.status==='UPLOADING'?'disabled':''}>Agendar</button><button data-action="delete" data-id="${item.id}" class="text-btn danger-text">Excluir</button></div></article>`).join('')||`<div class="empty"><div>▣</div><h3>Estoque vazio</h3><p>${stockState.status==='AVAILABLE'?'Selecione uma categoria e adicione seus vídeos acima.':`Nada por aqui em “${stockStatus[stockState.status]}”.`}</p></div>`;
  $$('.stock-check').forEach(el=>el.onchange=()=>{el.checked?stockState.selected.add(el.dataset.id):stockState.selected.delete(el.dataset.id);renderStock()});
  $$('.stock-actions button').forEach(btn=>btn.onclick=()=>stockAction(btn.dataset.action,btn.dataset.id));
}
async function stockAction(action,id){
  try{
    if(action==='save'){const input=$(`.stock-title-input[data-id="${id}"]`);await stockApi(`/api/inventory/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:input.value})});toast('Título salvo')}
    if(action==='regenerate'){await stockApi(`/api/inventory/${id}/regenerate`,{method:'POST'});toast('Novo título gerado')}
    if(action==='delete'){const item=stockState.items.find(v=>v.id===id);if(item?.status==='SCHEDULED'){toast('Cancele o agendamento antes de excluir.');return}if(item?.status==='UPLOADING'){toast('Este vídeo está sendo enviado e não pode ser excluído agora.');return}if(!confirm('Excluir este vídeo do estoque e do disco?'))return;await stockApi(`/api/inventory/${id}`,{method:'DELETE'});stockState.selected.delete(id);toast('Vídeo excluído')}
    if(action==='send'){if(!confirm('Enviar este vídeo agora como público para o YouTube?'))return;toast('Enviando vídeo. Não feche esta página.',5000);await stockApi(`/api/inventory/${id}/upload`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});toast('Vídeo publicado no YouTube!',6000)}
    if(action==='schedule')openAutoSchedule([id]);
    await loadStock();
  }catch(error){toast(error.message,7000);await loadStock()}
}
function updateStockSummary(files){const list=[...(files||[])];const total=list.reduce((sum,v)=>sum+v.size,0);$('#stockFileSummary').textContent=list.length?`${list.length} vídeo(s) • ${(total/1024/1024).toFixed(1)} MB`:'Nenhum vídeo selecionado. Arraste os vídeos para a área acima ou clique para escolher.';if($('#stockUploadProgress'))$('#stockUploadProgress').style.width='0%'}
const isVideoFile=f=>f.type.startsWith('video/')||/\.(mp4|mov|webm|mkv|avi)$/i.test(f.name);
function wireDropZone(zoneSelector,inputSelector,onFiles){
  const zone=$(zoneSelector);if(!zone)return;let depth=0;
  ['dragenter','dragover'].forEach(type=>zone.addEventListener(type,e=>{e.preventDefault();depth++;zone.classList.add('drag-over')},{passive:false}));
  zone.addEventListener('dragleave',()=>{depth=Math.max(0,depth-1);if(!depth)zone.classList.remove('drag-over')});
  zone.addEventListener('drop',e=>{e.preventDefault();depth=0;zone.classList.remove('drag-over');const files=[...(e.dataTransfer?.files||[])].filter(isVideoFile);if(!files.length){toast('Nenhum arquivo de vídeo válido (MP4, MOV, WEBM, MKV ou AVI).');return}const dt=new DataTransfer();files.forEach(f=>dt.items.add(f));const input=$(inputSelector);input.files=dt.files;onFiles(files)});
}
window.addEventListener('dragover',e=>e.preventDefault(),{passive:false});
window.addEventListener('drop',e=>e.preventDefault(),{passive:false});
$('#stockFiles').onchange=()=>updateStockSummary($('#stockFiles').files);
wireDropZone('#stockDropZone','#stockFiles',files=>{updateStockSummary(files);toast(files.length>1?`${files.length} vídeo(s) adicionados${files.length>100?'. Serão enviados em lotes de até 100':''}. Clique em “Adicionar ao estoque”.`:'Vídeo adicionado. Clique em “Adicionar ao estoque”.',6000)});
wireDropZone('.upload-box','#videoFile',files=>{const f=files[0];if(f)$('#fileName').textContent=`${f.name} • ${(f.size/1024/1024).toFixed(1)} MB`});
$('#addStockBtn').onclick=async()=>{
  const files=[...$('#stockFiles').files];if(!files.length){toast('Selecione pelo menos um vídeo');return}
  const btn=$('#addStockBtn');btn.disabled=true;btn.textContent='Adicionando...';
  const base=new FormData();base.append('category',$('#stockCategory').value);base.append('contentType','LONG');if(stockState.accountId!=='__unassigned__')base.append('accountId',stockState.accountId);
  const batches=[];for(let i=0;i<files.length;i+=100)batches.push(files.slice(i,i+100));
  let added=0,failed=0,firstError='';
  for(const batch of batches){
    const fd=new FormData();for(const entry of base)fd.append(entry[0],entry[1]);batch.forEach(file=>fd.append('videos',file));
    await new Promise(resolve=>{const xhr=new XMLHttpRequest();xhr.open('POST','/api/inventory');xhr.upload.onprogress=e=>{if(e.lengthComputable&&$('#stockUploadProgress'))$('#stockUploadProgress').style.width=`${Math.round(e.loaded/e.total*100)}%`};xhr.onload=()=>{let data={};try{data=JSON.parse(xhr.responseText)}catch{}if(xhr.status>=200&&xhr.status<300)added+=(data.added??data.length??0);else{failed++;if(!firstError)firstError=data.error||`Falha ao adicionar vídeos (lote de ${batch.length})`}resolve()};xhr.onerror=()=>{failed++;if(!firstError)firstError='Erro de conexão durante o envio';resolve()};xhr.send(fd);});
  }
  btn.disabled=false;btn.textContent='Adicionar ao estoque';if($('#stockUploadProgress'))$('#stockUploadProgress').style.width='0%';
  if(failed){toast(firstError,8000)}else{toast(`${added} vídeo(s) adicionados com metadados${batches.length>1?` (${batches.length} lotes de até 100)`:''}`,6000);$('#stockFiles').value='';$('#stockFileSummary').textContent='Nenhum vídeo selecionado. Arraste os vídeos para a área acima ou clique para escolher.';await loadStock()}
};
$('#refreshStockBtn').onclick=loadStock;$('#stockCategory').onchange=loadStock;
$$('[data-stock-status]').forEach(b=>b.onclick=()=>{stockState.status=b.dataset.stockStatus;$$('[data-stock-status]').forEach(x=>x.classList.toggle('active',x===b));loadStock()});
$('#stockSelectAll').onchange=e=>{stockState.selected=e.target.checked?new Set(stockState.items.map(v=>v.id)):new Set();renderStock()};
$('#bulkRegenerateBtn').onclick=async()=>{try{await stockApi('/api/inventory/actions/regenerate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:[...stockState.selected]})});toast('Novos títulos únicos gerados');await loadStock()}catch(error){toast(error.message,7000)}};
$('#bulkDeleteBtn').onclick=async()=>{const ids=[...stockState.selected];if(!confirm(`Excluir ${ids.length} vídeo(s) do estoque e do disco?`))return;try{await stockApi('/api/inventory/actions/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids})});stockState.selected.clear();toast('Vídeos excluídos');await loadStock()}catch(error){toast(error.message,7000)}};
$('#stockAssignBtn').onclick=async()=>{const ids=[...stockState.selected],accountId=$('#stockAssignAccount').value;if(!ids.length||!accountId)return;try{const data=await stockApi('/api/inventory/actions/assign-account',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids,accountId})});stockState.selected.clear();toast(`${data.updated} vídeo(s) movido(s) para o canal`);await loadStock()}catch(error){toast(error.message,7000)}};
async function runBulkUpload(ids,schedule=null){
  if(!authState.connected){toast('Conecte seu Google/YouTube primeiro',7000);go('settings');return}const body={ids,...(schedule||{})};toast(`Iniciando envio de ${ids.length} vídeo(s). Não feche a página.`,6000);
  try{const result=await stockApi('/api/inventory/actions/upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const errors=result.results.filter(v=>!v.ok);toast(errors.length?`${result.results.length-errors.length} enviados; ${errors.length} com erro`:`${result.results.length} vídeo(s) processados com sucesso`,8000);stockState.selected.clear();$('#autoSchedulePanel').classList.add('hidden');await loadStock()}
  catch(error){toast(error.message,8000);await loadStock()}
}
function sendableStockIds(){return stockState.items.filter(v=>stockState.selected.has(v.id)&&!v.youtubeVideoId&&['AVAILABLE','ERROR'].includes(v.status)).map(v=>v.id)}
$('#bulkSendBtn').onclick=()=>{
  const ids=sendableStockIds();
  if(!ids.length){toast(stockState.selected.size?'Os vídeos selecionados já foram publicados/agendados. Abra a aba “Disponíveis”.':'Selecione vídeos disponíveis para enviar.',6000);return}
  if(ids.length!==stockState.selected.size)toast(`${stockState.selected.size-ids.length} vídeo(s) ignorado(s) por já estarem publicados/agendados.`,6000);
  if(confirm(`Enviar ${ids.length} vídeo(s) agora como públicos?`))runBulkUpload(ids)
};
$('#bulkScheduleBtn').onclick=()=>{
  const ids=sendableStockIds();
  if(!ids.length){toast(stockState.selected.size?'Os vídeos selecionados já foram publicados/agendados. Abra a aba “Disponíveis”.':'Selecione vídeos disponíveis para agendar.',6000);return}
  if(ids.length!==stockState.selected.size)toast(`${stockState.selected.size-ids.length} vídeo(s) ignorado(s) por já estarem publicados/agendados.`,6000);
  openAutoSchedule(ids)
};
function openAutoSchedule(ids){stockState.scheduleIds=ids;stockState.preview=null;$('#autoQuantity').textContent=ids.length;const tomorrow=new Date(Date.now()+86400000);$('#autoDate').value=tomorrow.toISOString().slice(0,10);$('#schedulePreview').innerHTML='';$('#longScheduleConfirmBox').classList.add('hidden');$('#autoSchedulePanel').classList.remove('hidden');loadLongScheduleCapacity();$('#autoSchedulePanel').scrollIntoView({behavior:'smooth'})}
$('#closeAutoSchedule').onclick=()=>$('#autoSchedulePanel').classList.add('hidden');
async function loadLongScheduleCapacity(){try{const params=new URLSearchParams();if($('#autoDate')?.value)params.set('startDate',$('#autoDate').value);params.set('accountId',stockState.accountId);const data=await stockApi(`/api/inventory/long-schedule/capacity?${params}`);$('#longScheduleCapacity').innerHTML=data.days.map(day=>`<span>${new Date(day.date+'T12:00:00').toLocaleDateString('pt-BR',{weekday:'short',day:'2-digit',month:'2-digit'})}: <strong>${day.available} vagas</strong></span>`).join('')}catch(error){console.warn('long capacity:',error.message)}}
$('#autoDate').onchange=()=>{stockState.preview=null;$('#schedulePreview').innerHTML='';$('#longScheduleConfirmBox').classList.add('hidden');loadLongScheduleCapacity()};
$('#previewScheduleBtn').onclick=async()=>{const startDate=$('#autoDate').value;if(!startDate){toast('Informe a data inicial');return}const btn=$('#previewScheduleBtn');btn.disabled=true;btn.textContent='Calculando horários...';try{const data=await stockApi('/api/inventory/long-schedule/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({videoIds:stockState.scheduleIds,startDate})});stockState.preview=data.items;const grouped={};data.items.forEach(item=>(grouped[item.scheduledDate]||=[]).push(item));$('#schedulePreview').innerHTML=Object.entries(grouped).map(([day,rows])=>`<div class="short-preview-day"><header><strong>${new Date(day+'T12:00:00').toLocaleDateString('pt-BR',{weekday:'long',day:'2-digit',month:'long'})}</strong><span>${rows.length}/${data.maxPerDay}</span></header>${rows.map(item=>`<div><b>${escapeHtml(item.scheduledSlot)}</b><span>${escapeHtml(item.title)}</span></div>`).join('')}</div>`).join('');$('#longScheduleConfirmBox').classList.remove('hidden');toast('Prévia pronta. Confira os horários.',4000)}catch(error){toast(error.message,8000)}finally{btn.disabled=false;btn.textContent='Gerar prévia dos horários'}};
$('#confirmScheduleBtn').onclick=async()=>{if(!stockState.preview?.length){toast('Gere a prévia primeiro');return}if(!authState.connected){toast('Conecte seu Google/YouTube primeiro',7000);go('settings');return}const btn=$('#confirmScheduleBtn');btn.disabled=true;btn.textContent='Agendando...';try{const data=await stockApi('/api/inventory/long-schedule/confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({videoIds:stockState.scheduleIds,startDate:$('#autoDate').value})});const ok=data.items.filter(item=>item.ok).length,failed=data.items.length-ok;toast(failed?`${ok} agendado(s); ${failed} com erro`:`✅ ${ok} vídeo(s) agendado(s) no YouTube!`,8000);stockState.selected.clear();stockState.preview=null;$('#autoSchedulePanel').classList.add('hidden');await loadStock();refreshDashboard()}catch(error){toast(error.message,9000)}finally{btn.disabled=false;btn.textContent='Confirmar agendamento'}};

// Inicialização da Biblioteca de vídeos longos
async function loadChannelStock(){await loadStockChannels();await loadStockCategories()}
$$('[data-view="library"],[data-go="library"]').forEach(btn=>btn.addEventListener('click',loadChannelStock));
if(location.hash==='#library')loadChannelStock();
let commentChannelsState = {};
async function loadCommentSettings(){const box=$('#commentChannelsList');if(!box)return;try{const s=await stockApi('/api/inventory/comments/settings');commentChannelsState=s.channels||{};renderCommentChannels();}catch(e){box.innerHTML=`<small class="error-text">Falha ao carregar: ${escapeHtml(e.message)}</small>`}}
function renderCommentChannels(){const box=$('#commentChannelsList');if(!box)return;const accounts=authState.accounts?.filter(a=>a.connected)||[];if(!accounts.length){box.innerHTML='<small>Nenhum canal conectado. Use “Gerenciar canais” para conectar.</small>';return}box.innerHTML=accounts.map(account=>{const name=account.channelTitle||account.channelId||account.accountId;const cfg=commentChannelsState[name]||{};return `<div class="comment-channel-row"><label class="check"><input class="cc-enabled" type="checkbox" ${cfg.enabled!==false?'checked':''} data-channel="${escapeHtml(name)}"><strong>${escapeHtml(name)}</strong></label><textarea class="cc-text" rows="2" placeholder="Texto do comentário (deixe vazio para desativar)" data-channel="${escapeHtml(name)}">${escapeHtml(cfg.text||'')}</textarea></div>`}).join('')}
async function saveCommentSettings(){const btn=$('#saveCommentSettings');if(!btn)return;const status=$('#commentSettingsStatus');const channels={};document.querySelectorAll('.cc-enabled').forEach(cb=>{const name=cb.dataset.channel;const text=(document.querySelector(`.cc-text[data-channel="${CSS.escape(name)}"]`)||{}).value||'';channels[name]={enabled:Boolean(cb.checked)&&Boolean(String(text).trim()),text:String(text).trim()}});btn.disabled=true;try{await stockApi('/api/inventory/comments/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({channels})});commentChannelsState=channels;status.textContent='Salvo no servidor';toast('Comentário automático por canal salvo')}catch(e){status.textContent=e.message;toast(e.message,6000)}finally{btn.disabled=false}}
if($('#saveCommentSettings')){$('#saveCommentSettings').onclick=saveCommentSettings;$$('[data-view="settings"],button[data-go="settings"]').forEach(el=>el.addEventListener('click',()=>setTimeout(loadCommentSettings,50)));}
// --- Shorts: fluxo integrado ao painel original -------------------------------
const shortsState = {
  category: '',
  status: 'AVAILABLE',
  mode: 'instant',
  items: [],
  selected: new Set(),
  preview: null,
  scheduling: false,
  accountId: '__unassigned__',
  accounts: [],
  source: 'stock',
  stockItems: [],
  stockSelected: new Set(),
  shortHashes: new Set()
};

async function loadShortChannels(){
  try{
    shortsState.accounts=(await stockApi('/api/auth/accounts')).filter(account=>account.connected);
    if(!shortsState.accounts.some(account=>account.accountId===shortsState.accountId)) shortsState.accountId=shortsState.accounts.find(account=>account.isDefault)?.accountId||shortsState.accounts[0]?.accountId||'__unassigned__';
    const tabs=$('#shortChannelTabs');
    tabs.innerHTML=shortsState.accounts.map(account=>`<button class="stock-channel-tab ${shortsState.accountId===account.accountId?'active':''}" data-short-account="${escapeHtml(account.accountId)}">${escapeHtml(accountLabel(account))}</button>`).join('')+`<button class="stock-channel-tab ${shortsState.accountId==='__unassigned__'?'active':''}" data-short-account="__unassigned__">Sem canal</button>`;
    $('#shortAssignAccount').innerHTML=shortsState.accounts.map(account=>`<option value="${escapeHtml(account.accountId)}">${escapeHtml(accountLabel(account))}</option>`).join('');
    tabs.querySelectorAll('[data-short-account]').forEach(button=>button.onclick=()=>{shortsState.accountId=button.dataset.shortAccount;shortsState.selected.clear();shortsState.stockSelected.clear();tabs.querySelectorAll('.stock-channel-tab').forEach(tab=>tab.classList.toggle('active',tab===button));loadShortsView();loadShortStock();loadShortsCapacity()});
  }catch(error){toast(error.message,6000)}
}

async function openShortLibraryPicker(){
  const picker = $('#shortLibraryPicker');
  if(!picker) return;
  picker.classList.remove('hidden');
  $('#shortLibraryChannels').innerHTML = '<small>Carregando canais...</small>';
  $('#shortLibraryVideos').innerHTML = '<small>Carregando Biblioteca...</small>';
  try{
    const [accounts,videos] = await Promise.all([stockApi('/api/auth/accounts'),stockApi('/api/inventory?contentType=LONG')]);
    const connected = accounts.filter(account=>account.connected && account.status==='CONNECTED');
    $('#shortLibraryChannels').innerHTML = connected.map(account=>`<label><input class="short-library-channel" type="checkbox" value="${escapeHtml(account.accountId)}"><span>${escapeHtml(accountLabel(account))}</span></label>`).join('') || '<small>Nenhum canal conectado. Use “Conectar outro canal”.</small>';
    $('#shortLibraryVideos').innerHTML = videos.filter(video=>video.fileExists && video.status!=='DELETED').map(video=>`<label><input class="short-library-video" type="checkbox" value="${escapeHtml(video.id)}"><span>${escapeHtml(video.title||video.originalFilename)}</span><small>${escapeHtml(video.originalFilename||'')}</small></label>`).join('') || '<small>Nenhum arquivo disponível na Biblioteca.</small>';
  }catch(error){ toast(error.message,7000); }
}
if($('#openShortLibrary')) $('#openShortLibrary').onclick=openShortLibraryPicker;
if($('#closeShortLibrary')) $('#closeShortLibrary').onclick=()=>$('#shortLibraryPicker').classList.add('hidden');
if($('#confirmShortLibrary')) $('#confirmShortLibrary').onclick=async()=>{
  const sourceIds = $$('.short-library-video:checked').map(input=>input.value);
  const accountIds = $$('.short-library-channel:checked').map(input=>input.value);
  if(!sourceIds.length){ toast('Selecione pelo menos um vídeo da Biblioteca'); return; }
  if(!accountIds.length){ toast('Selecione pelo menos um canal do YouTube'); return; }
  const btn = $('#confirmShortLibrary'); btn.disabled=true; btn.textContent='Adicionando...';
  try{
    const data = await stockApi('/api/shorts/reuse-as-shorts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sourceIds,accountIds})});
    const extra = data.skipped ? ` ${data.skipped} combinação(ões) já existiam.` : '';
    toast(`${data.created.length} Short(s) adicionados.${extra}`,7000);
    $('#shortLibraryPicker').classList.add('hidden');
    shortsState.status='AVAILABLE';
    $$('[data-short-status]').forEach(x=>x.classList.toggle('active',x.dataset.shortStatus==='AVAILABLE'));
    await loadShortsView();
  }catch(error){ toast(error.message,8000); }
  finally{ btn.disabled=false; btn.textContent='Adicionar aos Shorts selecionados'; }
};

function setShortSource(source){
  shortsState.source=source==='local'?'local':'stock';
  $('#shortSourceStock')?.classList.toggle('active',shortsState.source==='stock');
  $('#shortSourceLocal')?.classList.toggle('active',shortsState.source==='local');
  $('#shortStockPanel')?.classList.toggle('hidden',shortsState.source!=='stock');
  const localHidden=shortsState.source!=='local';
  $('#shortsDropzone')?.classList.toggle('hidden',localHidden);
  $('#shortsDropzone')?.nextElementSibling?.classList.toggle('hidden',localHidden);
  $('#shortsUploadProgress')?.parentElement?.classList.toggle('hidden',localHidden);
  if(shortsState.source==='stock') loadShortStock();
}
function filteredShortStock(){
  const term=($('#shortStockSearch')?.value||'').trim().toLowerCase();
  let rows=shortsState.stockItems.filter(item=>(!shortsState.category||item.category===shortsState.category)&&(!term||`${item.title||''} ${item.originalFilename||''}`.toLowerCase().includes(term)));
  const sort=$('#shortStockSort')?.value||'old';
  rows.sort((a,b)=>sort==='title'?String(a.title||'').localeCompare(String(b.title||''),'pt-BR'):sort==='recent'?new Date(b.createdAt)-new Date(a.createdAt):new Date(a.createdAt)-new Date(b.createdAt));
  return rows;
}
function updateShortStockAction(){
  const eligible=filteredShortStock().filter(item=>!shortsState.shortHashes.has(item.fileHash));
  const selected=[...shortsState.stockSelected].filter(id=>eligible.some(item=>item.id===id));
  const requested=Math.max(1,Math.min(Number($('#shortStockQuantity')?.value||10),Math.max(1,eligible.length)));
  if($('#shortStockQuantity')) $('#shortStockQuantity').value=requested;
  if($('#shortStockEligible')) $('#shortStockEligible').textContent=eligible.length;
  if($('#shortStockCount')) $('#shortStockCount').textContent=eligible.length;
  if($('#shortStockSelectedText')) $('#shortStockSelectedText').textContent=selected.length?`${selected.length} vídeo(s) selecionado(s)`:'Nenhum vídeo marcado';
  const count=selected.length||Math.min(requested,eligible.length); const button=$('#addShortsFromStock');
  if(button){button.textContent=count?`Adicionar ${count} vídeo(s) aos Shorts`:'Nenhum vídeo elegível';button.disabled=count===0;}
}
function renderShortStock(){
  const rows=filteredShortStock(); const box=$('#shortStockList'); if(!box)return;
  box.innerHTML=rows.length?rows.map(item=>{
    const added=shortsState.shortHashes.has(item.fileHash);
    return `<label class="shorts-stock-row ${added?'is-added':''}"><input class="short-stock-check" type="checkbox" value="${escapeHtml(item.id)}" ${shortsState.stockSelected.has(item.id)?'checked':''} ${added?'disabled':''}><span class="shorts-stock-thumb">▶</span><span class="shorts-stock-info"><strong>${escapeHtml(item.title||'Sem título')}</strong><small>${escapeHtml(item.originalFilename||'')}</small><small>${escapeHtml(item.youtubeCategoryName||item.category||'')}</small></span><span class="shorts-stock-status ${added?'added':''}">${added?'✅ Já adicionado aos Shorts':'Disponível para Shorts'}</span></label>`;
  }).join(''):`<div class="empty"><p>📦 Nenhum vídeo disponível na Biblioteca.</p><small>Adicione vídeos na Biblioteca primeiro ou use Arquivos locais.</small></div>`;
  $$('.short-stock-check').forEach(input=>input.onchange=()=>{input.checked?shortsState.stockSelected.add(input.value):shortsState.stockSelected.delete(input.value);updateShortStockAction()});
  updateShortStockAction();
}
async function loadShortStock(){
  if(!$('#shortStockList'))return;
  try{
    const [longs,shorts,categories]=await Promise.all([stockApi('/api/inventory?contentType=LONG&status=AVAILABLE'),stockApi(`/api/inventory?contentType=SHORT&accountId=${encodeURIComponent(shortsState.accountId)}`),stockApi('/api/inventory/categories')]);
    shortsState.stockItems=longs.filter(item=>item.fileExists); shortsState.shortHashes=new Set(shorts.map(item=>item.fileHash).filter(Boolean));
    shortsState.stockSelected=new Set([...shortsState.stockSelected].filter(id=>longs.some(item=>item.id===id)));
    $('#shortStockCategories').innerHTML=`<button class="secondary ${!shortsState.category?'active':''}" data-stock-category="">Todos</button>`+categories.map(c=>`<button class="secondary ${shortsState.category===c.id?'active':''}" data-stock-category="${escapeHtml(c.id)}">${escapeHtml(c.emoji)} ${escapeHtml(c.name)}</button>`).join('');
    $$('[data-stock-category]').forEach(button=>button.onclick=()=>{shortsState.category=button.dataset.stockCategory;shortsState.stockSelected.clear();loadShortsCategories();renderShortStock()});
    renderShortStock();
  }catch(error){$('#shortStockList').innerHTML=`<div class="empty"><p>${escapeHtml(error.message)}</p></div>`;}
}
async function addShortsFromStock(){
  const eligible=filteredShortStock().filter(item=>!shortsState.shortHashes.has(item.fileHash));
  const manual=eligible.filter(item=>shortsState.stockSelected.has(item.id));
  const quantity=Math.max(1,Number($('#shortStockQuantity')?.value||10)); const chosen=manual.length?manual:eligible.slice(0,quantity);
  if(!chosen.length){toast('Nenhum vídeo elegível para adicionar');return;}
  const button=$('#addShortsFromStock');button.disabled=true;button.textContent='Criando Shorts...';
  try{
    if(shortsState.accountId==='__unassigned__'){toast('Escolha um canal antes de adicionar os Shorts',7000);return;}
    const data=await stockApi('/api/shorts/from-library',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({videoIds:chosen.map(item=>item.id),categoryId:shortsState.category,accountId:shortsState.accountId})});
    toast(`✅ ${data.added} vídeo(s) da Biblioteca adicionado(s) aos Shorts.`,7000);shortsState.stockSelected.clear();
    shortsState.status='AVAILABLE';$$('[data-short-status]').forEach(x=>x.classList.toggle('active',x.dataset.shortStatus==='AVAILABLE'));
    await Promise.all([loadShortStock(),loadShortsView()]);refreshDashboard();
  }catch(error){toast(error.message,8000);}finally{updateShortStockAction();}
}

function shortVisibleIds(){
  return shortsState.items
    .filter(v => ['AVAILABLE','ERROR'].includes(shortsState.status) && ['AVAILABLE','ERROR'].includes(v.status))
    .map(v => v.id);
}
function shortsHaveAssignedChannels(ids){
  return ids.length > 0 && ids.every(id=>shortsState.items.find(item=>item.id===id)?.accountId);
}
function updateShortSelectionUi(){
  const selectedCount = shortsState.selected.size;
  const count = $('#shortSelectedCount');
  const bar = $('#shortsBulkBar');
  const selectAll = $('#shortSelectAll');
  if(count) count.textContent = selectedCount;
  if(bar) bar.classList.toggle('hidden', !['AVAILABLE','ERROR'].includes(shortsState.status));
  const visible = shortVisibleIds();
  if(selectAll){
    selectAll.checked = visible.length > 0 && visible.every(id => shortsState.selected.has(id));
    selectAll.indeterminate = visible.some(id => shortsState.selected.has(id)) && !selectAll.checked;
  }
  $$('#shortsList input.short-check').forEach(input => input.checked = shortsState.selected.has(input.dataset.id));
  ['shortAssignBtn','shortRegenerateSelected','shortPostSelected','shortScheduleSelected','shortDeleteSelected','shortClearSelected'].forEach(id=>{
    const button=$('#'+id); if(button) button.disabled=selectedCount===0;
  });
}
function setShortMode(mode){
  shortsState.mode = mode === 'schedule' ? 'schedule' : 'instant';
  $('#shortModeInstant')?.classList.toggle('active', shortsState.mode === 'instant');
  $('#shortModeSchedule')?.classList.toggle('active', shortsState.mode === 'schedule');
  if($('#shortModeLabel')) $('#shortModeLabel').textContent = shortsState.mode === 'schedule' ? 'Agendamento automático' : 'Envio imediato';
  if($('#shortModeHelp')) $('#shortModeHelp').textContent = shortsState.mode === 'schedule'
    ? 'Selecione os Shorts e o sistema distribuirá até 10 por dia nos próximos horários livres.'
    : 'Selecione os Shorts disponíveis e clique em “Postar agora”.';
  if(shortsState.mode === 'schedule' && shortsState.selected.size) openShortSchedulePanel();
}
function sortShortItems(items){
  const mode = $('#shortsSort')?.value || 'recent';
  return [...items].sort((a,b)=>{
    if(mode === 'title') return String(a.title||'').localeCompare(String(b.title||''),'pt-BR');
    const av = new Date(a.createdAt || a.scheduledAt || 0).getTime();
    const bv = new Date(b.createdAt || b.scheduledAt || 0).getTime();
    return mode === 'old' ? av-bv : bv-av;
  });
}
function shortStatusLabel(v){
  return stockStatus[v.status] || v.status || '';
}
function shortCard(v){
  const canSelect = ['AVAILABLE','ERROR'].includes(shortsState.status) && ['AVAILABLE','ERROR'].includes(v.status);
  return `<article class="stock-item shorts-video-card ${v.status==='ERROR'?'has-error':''}">
    ${canSelect?`<input class="short-check" type="checkbox" data-id="${v.id}" ${shortsState.selected.has(v.id)?'checked':''}>`:'<span></span>'}
    <div class="stock-thumb">▶</div>
    <div class="stock-info">
      <small>${escapeHtml(v.originalFilename||'Vídeo')} · ${escapeHtml(v.youtubeCategoryName||v.category||'Short')}</small>
      <strong>${escapeHtml(v.title||'Sem título')}</strong>
      <div class="stock-meta">
        <span>${(v.tags||[]).length} tags ✓</span>
        ${v.accountId?`<span>Canal: ${escapeHtml(v.accountName||v.accountId)}</span>`:''}
        ${v.scheduledAt?`<span>${new Date(v.scheduledAt).toLocaleString('pt-BR')}</span>`:''}
        <span class="status status-${String(v.status||'').toLowerCase()}">${escapeHtml(shortStatusLabel(v))}</span>
        ${v.error?`<span class="stock-error">${escapeHtml(v.error)}</span>`:''}
      </div>
    </div>
    <div class="stock-actions">
      ${v.status==='ERROR'?`<button class="text-btn short-retry" data-id="${v.id}">Tentar novamente</button>`:''}
      ${v.youtubeVideoId?`<a class="text-btn button-link" href="https://youtube.com/shorts/${encodeURIComponent(v.youtubeVideoId)}" target="_blank" rel="noopener noreferrer">Ver no YouTube</a>`:''}
    </div>
  </article>`;
}
function renderScheduledShorts(items){
  const groups = {};
  items.forEach(v=>{
    const day = (v.scheduledDate || v.scheduledAt || '').slice(0,10) || 'Sem data';
    (groups[day] ||= []).push(v);
  });
  const html = Object.entries(groups).sort(([a],[b])=>a.localeCompare(b)).map(([day,rows])=>`
    <section class="shorts-scheduled-day">
      <header><strong>${new Date(day+'T12:00:00').toLocaleDateString('pt-BR',{weekday:'short',day:'2-digit',month:'short'})}</strong><span>${rows.length}/10 Shorts</span></header>
      ${rows.sort((a,b)=>String(a.scheduledAt).localeCompare(String(b.scheduledAt))).map(v=>`
        <div class="shorts-scheduled-row">
          <time>${escapeHtml(v.scheduledSlot || new Date(v.scheduledAt).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}))}</time>
          <div><strong>${escapeHtml(v.title)}</strong><small>${escapeHtml(v.originalFilename||'')} · ${escapeHtml(v.youtubeCategoryName||v.category||'')}</small></div>
          <span class="status status-scheduled">Agendado</span>
          ${v.youtubeVideoId?`<a class="text-btn button-link" href="https://studio.youtube.com/video/${encodeURIComponent(v.youtubeVideoId)}/edit" target="_blank" rel="noopener noreferrer">YouTube Studio</a>`:''}
        </div>`).join('')}
    </section>`).join('');
  return html || '<div class="empty"><p>Nenhum Short agendado.</p></div>';
}
async function loadShortsCategories(){
  if(!$('#shortCategoryButtons')) return;
  try{
    const cats = await stockApi('/api/inventory/categories');
    const box = $('#shortCategoryButtons');
    box.innerHTML = `<button class="secondary ${!shortsState.category?'active':''}" data-short-category="">Todos</button>` +
      cats.map(c=>`<button class="secondary ${shortsState.category===c.id?'active':''}" data-short-category="${escapeHtml(c.id)}">${escapeHtml(c.emoji)} ${escapeHtml(c.name)}</button>`).join('');
    box.querySelectorAll('[data-short-category]').forEach(b=>b.onclick=()=>{
      shortsState.category = b.dataset.shortCategory;
      shortsState.selected.clear();
      loadShortsCategories();
      loadShortsView();
      loadShortsCapacity();
      loadShortStock();
    });
  }catch(error){ toast(error.message,6000); }
}
async function loadShortsCapacity(){
  try{
    const date = $('#shortScheduleDate')?.value || '';
    const params=new URLSearchParams({accountId:shortsState.accountId});if(date)params.set('startDate',date);
    const data = await stockApi(`/api/shorts/schedule/capacity?${params}`);
    const compact = data.days.map(day=>`<span>${new Date(day.date+'T12:00:00').toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'})}: <strong>${day.available} vagas</strong></span>`).join('');
    if($('#shortsCapacity')) $('#shortsCapacity').innerHTML = compact;
    if($('#shortsCapacitySide')) $('#shortsCapacitySide').innerHTML = data.days.map(day=>`
      <div><span>${new Date(day.date+'T12:00:00').toLocaleDateString('pt-BR',{weekday:'short',day:'2-digit',month:'2-digit'})}</span>
      <strong>${day.occupied}/${data.maxPerDay}</strong><small>${day.available} livres</small></div>`).join('');
  }catch(error){ console.warn('shorts capacity:',error.message); }
}
async function loadShortsView(){
  if(!$('#shortsList')) return;
  try{
    const q = new URLSearchParams({contentType:'SHORT',status:shortsState.status,accountId:shortsState.accountId});
    if(shortsState.category) q.set('categoryId',shortsState.category);
    let items = await stockApi(`/api/inventory?${q}`);
    const term = ($('#shortsSearch')?.value || '').trim().toLowerCase();
    if(term) items = items.filter(v=>`${v.title||''} ${v.originalFilename||''}`.toLowerCase().includes(term));
    items = sortShortItems(items);
    shortsState.items = items;

    const stats = await stockApi(`/api/inventory/stats?contentType=SHORT&accountId=${encodeURIComponent(shortsState.accountId)}${shortsState.category?`&categoryId=${encodeURIComponent(shortsState.category)}`:''}`);
    $('#shortsAvailable').textContent = stats.available;
    $('#shortsScheduled').textContent = stats.scheduled;
    $('#shortsPublished').textContent = stats.published;
    $('#shortsErrors').textContent = stats.errors;

    const idsNow = new Set(items.map(v=>v.id));
    if(['AVAILABLE','ERROR'].includes(shortsState.status)) shortsState.selected = new Set([...shortsState.selected].filter(id=>idsNow.has(id)));
    else shortsState.selected.clear();

    $('#shortsList').innerHTML = shortsState.status === 'SCHEDULED'
      ? renderScheduledShorts(items)
      : (items.map(shortCard).join('') || `<div class="empty"><p>Nenhum Short em “${escapeHtml(shortStatusLabel({status:shortsState.status}))}”.</p></div>`);

    $$('#shortsList .short-check').forEach(input=>input.onchange=()=>{
      input.checked ? shortsState.selected.add(input.dataset.id) : shortsState.selected.delete(input.dataset.id);
      updateShortSelectionUi();
    });
    $$('#shortsList .short-retry').forEach(btn=>btn.onclick=async()=>{
      if(!shortsHaveAssignedChannels([btn.dataset.id])){ toast('Mova este Short para um canal antes de tentar novamente',7000); return; }
      const tomorrow = new Date(Date.now()+86400000).toISOString().slice(0,10);
      const startDate = $('#shortScheduleDate')?.value || tomorrow;
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Procurando vaga...';
      try{
        const data = await stockApi('/api/shorts/schedule/confirm',{
          method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({videoIds:[btn.dataset.id],startDate})
        });
        const result = data.items?.[0];
        if(!result?.ok) throw new Error(result?.error || 'Não foi possível reagendar este Short.');
        const scheduledAt = new Date(result.item.scheduledAt).toLocaleString('pt-BR');
        toast(`Short reagendado para ${scheduledAt}!`,7000);
        await loadShortsView(); refreshDashboard();
      }catch(error){
        btn.disabled = false;
        btn.textContent = originalText;
        toast(error.message,7000);
      }
    });
    updateShortSelectionUi();
    await loadShortsCapacity();
  }catch(error){
    $('#shortsList').innerHTML = `<div class="empty"><p>${escapeHtml(error.message)}</p></div>`;
  }
}
function openShortSchedulePanel(){
  if(!shortsState.selected.size){ toast('Selecione pelo menos um Short'); return; }
  const panel = $('#shortSchedulePanel');
  if(!panel) return;
  const tomorrow = new Date(Date.now()+86400000);
  if(!$('#shortScheduleDate').value) $('#shortScheduleDate').value = tomorrow.toISOString().slice(0,10);
  $('#shortScheduleCount').textContent = shortsState.selected.size;
  $('#shortSchedulePreview').innerHTML = '';
  $('#shortScheduleConfirmBox').classList.add('hidden');
  shortsState.preview = null;
  panel.classList.remove('hidden');
  loadShortsCapacity();
  panel.scrollIntoView({behavior:'smooth',block:'start'});
}
async function previewShortSchedule(){
  const ids = [...shortsState.selected];
  if(!ids.length){ toast('Selecione pelo menos um Short'); return; }
  const startDate = $('#shortScheduleDate').value;
  if(!startDate){ toast('Escolha a data inicial'); return; }
  const btn = $('#shortPreviewSchedule');
  btn.disabled = true; btn.textContent = 'Calculando horários...';
  try{
    const data = await stockApi('/api/shorts/schedule/preview',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({videoIds:ids,startDate})
    });
    shortsState.preview = data.items;
    const grouped = {};
    data.items.forEach(item=>(grouped[item.scheduledDate] ||= []).push(item));
    $('#shortSchedulePreview').innerHTML = Object.entries(grouped).map(([day,rows])=>`
      <div class="short-preview-day">
        <header><strong>${new Date(day+'T12:00:00').toLocaleDateString('pt-BR',{weekday:'long',day:'2-digit',month:'long'})}</strong><span>${rows.length}/${data.maxPerDay}</span></header>
        ${rows.map((item,index)=>`<div><b>${escapeHtml(item.scheduledSlot)}</b><span>${escapeHtml(item.title)}</span></div>`).join('')}
      </div>`).join('');
    $('#shortScheduleConfirmBox').classList.remove('hidden');
    toast('Prévia pronta. Confira os horários.',4000);
  }catch(error){ toast(error.message,8000); }
  finally{ btn.disabled=false; btn.textContent='Gerar prévia dos horários'; }
}
async function confirmShortSchedule(){
  if(shortsState.scheduling) return;
  if(!shortsState.preview?.length){ toast('Gere a prévia primeiro'); return; }
  const ids = [...shortsState.selected];
  if(!shortsHaveAssignedChannels(ids)){ toast('Mova os Shorts selecionados para um canal antes de agendar',7000); return; }
  const btn = $('#shortConfirmSchedule');
  shortsState.scheduling = true; btn.disabled = true; btn.textContent = `Agendando 0/${ids.length}...`;
  try{
    const data = await stockApi('/api/shorts/schedule/confirm',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({videoIds:ids,startDate:$('#shortScheduleDate').value})
    });
    const ok = data.items.filter(v=>v.ok).length;
    const failed = data.items.length-ok;
    if(failed) toast(`${ok} Short(s) agendados; ${failed} com erro.`,8000);
    else toast(`✅ ${ok} Short(s) agendados no YouTube!`,8000);
    shortsState.selected.clear(); shortsState.preview=null;
    $('#shortSchedulePanel').classList.add('hidden');
    shortsState.status = 'SCHEDULED';
    $$('[data-short-status]').forEach(x=>x.classList.toggle('active',x.dataset.shortStatus==='SCHEDULED'));
    await loadShortsView(); refreshDashboard();
  }catch(error){ toast(error.message,9000); }
  finally{ shortsState.scheduling=false; btn.disabled=false; btn.textContent='Confirmar agendamento'; }
}
async function postSelectedShorts(){
  const ids = [...shortsState.selected];
  if(!ids.length){ toast('Selecione pelo menos um Short'); return; }
  if(!shortsHaveAssignedChannels(ids)){ toast('Mova os Shorts selecionados para um canal antes de publicar',7000); return; }
  const btn = $('#shortPostSelected'); btn.disabled=true; btn.textContent='Enviando...';
  try{
    const result = await stockApi('/api/shorts/actions/upload',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids})
    });
    const ok=result.results.filter(v=>v.ok).length, failed=result.results.length-ok;
    toast(failed?`${ok} enviados; ${failed} com erro`:`✅ ${ok} Short(s) publicados!`,8000);
    shortsState.selected.clear(); await loadShortsView(); refreshDashboard();
  }catch(error){ toast(error.message,8000); }
  finally{ btn.disabled=false; btn.textContent='⚡ Postar agora'; }
}
async function regenerateSelectedShorts(){
  const ids=[...shortsState.selected]; if(!ids.length)return;
  const btn=$('#shortRegenerateSelected');btn.disabled=true;btn.textContent='Gerando...';
  try{
    await stockApi('/api/shorts/actions/regenerate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids})});
    toast('Novos títulos gerados'); await loadShortsView();
  }catch(error){toast(error.message,7000)}
  finally{btn.disabled=false;btn.textContent='✦ Novos títulos'}
}
async function deleteSelectedShorts(){
  const ids=[...shortsState.selected];
  if(!ids.length){ toast('Selecione pelo menos um Short'); return; }
  if(!confirm(`Excluir ${ids.length} Short(s) selecionado(s)? Os arquivos compartilhados com a Biblioteca serão preservados.`)) return;
  const btn=$('#shortDeleteSelected'); btn.disabled=true; btn.textContent='Excluindo...';
  try{
    const data=await stockApi('/api/shorts/actions/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids})});
    shortsState.selected.clear();
    toast(`${data.deleted||ids.length} Short(s) excluído(s)`,6000);
    await loadShortsView(); refreshDashboard();
  }catch(error){ toast(error.message,8000); }
  finally{ btn.textContent='🗑 Excluir selecionados'; updateShortSelectionUi(); }
}
function uploadShortFiles(){
  const input=$('#shortsFiles'), files=[...(input?.files||[])];
  if(!files.length){toast('Selecione pelo menos um vídeo');return}
  if(shortsState.accountId==='__unassigned__'){toast('Escolha um canal antes de adicionar os Shorts',7000);return}
  const category = shortsState.category || 'brainrot';
  const fd=new FormData();fd.append('category',category);fd.append('accountId',shortsState.accountId);files.forEach(f=>fd.append('videos',f));
  const btn=$('#addShortsBtn');btn.disabled=true;btn.textContent='Adicionando...';
  const xhr=new XMLHttpRequest();xhr.open('POST','/api/shorts');
  xhr.upload.onprogress=e=>{if(e.lengthComputable&&$('#shortsUploadProgress'))$('#shortsUploadProgress').style.width=`${Math.round(e.loaded/e.total*100)}%`};
  xhr.onload=async()=>{
    btn.disabled=false;btn.textContent='Adicionar arquivos aos Shorts';
    let data={};try{data=JSON.parse(xhr.responseText)}catch{}
    if(xhr.status>=200&&xhr.status<300){
      const added=Number(data.added??data.length??data.videos?.length??0),skipped=Number(data.skipped||0);toast(`✅ ${added} Short(s) adicionados${skipped?`; ${skipped} duplicado(s) ignorado(s)`:''}`,5000);input.value='';$('#shortsFileSummary').textContent='Nenhum vídeo selecionado.';$('#shortsUploadProgress').style.width='0%';shortsState.status='AVAILABLE';await Promise.all([loadShortsView(),loadShortStock()]);refreshDashboard();
    }else toast(data.error||data.message||'Falha ao adicionar Shorts',7000);
  };
  xhr.onerror=()=>{btn.disabled=false;btn.textContent='Adicionar arquivos aos Shorts';toast('Erro de conexão durante o upload',7000)};
  xhr.send(fd);
}

$('#shortModeInstant')?.addEventListener('click',()=>setShortMode('instant'));
$('#shortModeSchedule')?.addEventListener('click',()=>setShortMode('schedule'));
$('#shortSourceStock')?.addEventListener('click',()=>setShortSource('stock'));
$('#shortSourceLocal')?.addEventListener('click',()=>setShortSource('local'));
$('#shortStockSearch')?.addEventListener('input',renderShortStock);
$('#shortStockSort')?.addEventListener('change',renderShortStock);
$('#shortStockQuantity')?.addEventListener('input',updateShortStockAction);
$('#shortStockMinus')?.addEventListener('click',()=>{const input=$('#shortStockQuantity');input.value=Math.max(1,Number(input.value||1)-1);updateShortStockAction()});
$('#shortStockPlus')?.addEventListener('click',()=>{const input=$('#shortStockQuantity');input.value=Number(input.value||0)+1;updateShortStockAction()});
$('#addShortsFromStock')?.addEventListener('click',addShortsFromStock);
$$('[data-short-status]').forEach(b=>b.onclick=()=>{
  shortsState.status=b.dataset.shortStatus;
  $$('[data-short-status]').forEach(x=>x.classList.toggle('active',x===b));
  loadShortsView();
});
$('#shortSelectAll')?.addEventListener('change',e=>{
  shortVisibleIds().forEach(id=>e.target.checked?shortsState.selected.add(id):shortsState.selected.delete(id));
  updateShortSelectionUi();
});
$('#shortClearSelected')?.addEventListener('click',()=>{shortsState.selected.clear();updateShortSelectionUi()});
$('#shortRegenerateSelected')?.addEventListener('click',regenerateSelectedShorts);
$('#shortDeleteSelected')?.addEventListener('click',deleteSelectedShorts);
$('#shortAssignBtn')?.addEventListener('click',async()=>{const ids=[...shortsState.selected],accountId=$('#shortAssignAccount').value;if(!ids.length||!accountId)return;try{const data=await stockApi('/api/shorts/actions/assign-account',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids,accountId})});shortsState.selected.clear();toast(`${data.updated} Short(s) movido(s) para o canal`);await Promise.all([loadShortsView(),loadShortStock()])}catch(error){toast(error.message,8000)}});
$('#shortPostSelected')?.addEventListener('click',postSelectedShorts);
$('#shortScheduleSelected')?.addEventListener('click',openShortSchedulePanel);
$('#shortPreviewSchedule')?.addEventListener('click',previewShortSchedule);
$('#shortConfirmSchedule')?.addEventListener('click',confirmShortSchedule);
$('#shortCloseSchedule')?.addEventListener('click',()=>$('#shortSchedulePanel')?.classList.add('hidden'));
$('#shortScheduleDate')?.addEventListener('change',()=>{shortsState.preview=null;$('#shortSchedulePreview').innerHTML='';$('#shortScheduleConfirmBox').classList.add('hidden');loadShortsCapacity()});
$('#shortsRefresh')?.addEventListener('click',()=>{loadShortsView();loadShortsCapacity();loadShortStock()});
$('#shortsSearch')?.addEventListener('input',loadShortsView);
$('#shortsSort')?.addEventListener('change',loadShortsView);
$('#shortsFiles')?.addEventListener('change',e=>{$('#shortsFileSummary').textContent=e.target.files.length?`${e.target.files.length} vídeo(s) selecionado(s)`:'Nenhum vídeo selecionado.'});
$('#addShortsBtn')?.addEventListener('click',uploadShortFiles);

const shortsDropzone=$('#shortsDropzone');
if(shortsDropzone){
  ['dragenter','dragover'].forEach(type=>shortsDropzone.addEventListener(type,e=>{e.preventDefault();shortsDropzone.classList.add('drag-active')}));
  ['dragleave','drop'].forEach(type=>shortsDropzone.addEventListener(type,e=>{e.preventDefault();shortsDropzone.classList.remove('drag-active')}));
  shortsDropzone.addEventListener('drop',e=>{
    if($('#shortsFiles')){ $('#shortsFiles').files=e.dataTransfer.files; $('#shortsFileSummary').textContent=`${e.dataTransfer.files.length} vídeo(s) selecionado(s)`; }
  });
}
async function loadChannelShorts(){await loadShortChannels();loadShortsCategories();loadShortsView();loadShortsCapacity();setShortSource(shortsState.source)}
$$('[data-view="shorts"],[data-go="shorts"]').forEach(b=>b.addEventListener('click',loadChannelShorts));

async function loadMetadataPage(){const box=$('#metadataCategory');if(!box)return;try{const cats=await stockApi('/api/inventory/categories');box.innerHTML=cats.map(c=>`<option value="${escapeHtml(c.id)}">${escapeHtml(c.emoji)} ${escapeHtml(c.name)}</option>`).join('');const fill=()=>{const c=cats.find(v=>v.id===box.value)||cats[0];if(!c)return;$('#metadataDescription').value=c.description||'';$('#metadataTags').value=(c.tags||[]).join(', ');$('#metadataYoutubeCategory').value=`${c.youtubeCategoryName||''} (${c.youtubeCategoryId||''})`;if($('#metadataCommentEnabled'))$('#metadataCommentEnabled').checked=c.autoComment?.enabled!==false;if($('#metadataCommentText'))$('#metadataCommentText').value=c.autoComment?.text||''};box.onchange=fill;fill()}catch(e){toast(e.message,5000)}}
async function loadChannelPage(){
  const box=$('#channelDetails');if(!box)return;
  try{
    const accounts=await stockApi('/api/auth/accounts');
    box.innerHTML=accounts.map(account=>`<article class="channel-account-card ${account.isDefault?'is-default':''}">
      ${account.channelThumbnail?`<img src="${escapeHtml(account.channelThumbnail)}" alt="">`:'<span class="channel-account-avatar">YT</span>'}
      <div class="channel-account-info"><strong>${escapeHtml(account.channelTitle||account.channelId)}</strong><small>${escapeHtml(account.channelId)} · Cliente de API ${account.credentialSet||1}</small><span class="channel-status ${escapeHtml(String(account.status||'').toLowerCase())}">${account.connected?'Conectado':'Reconexão necessária'}${account.isDefault?' · Canal padrão':''}</span></div>
      <div class="channel-account-actions">${account.isDefault?'':`<button class="secondary" data-channel-default="${escapeHtml(account.accountId)}">Definir como padrão</button>`}<a class="secondary button-link" data-keep-client="1" href="/api/auth/google?returnTo=/%23channel&amp;accountId=${encodeURIComponent(account.accountId)}&amp;client=${account.credentialSet||1}">Reconectar</a><button class="danger" data-channel-delete="${escapeHtml(account.accountId)}" data-channel-title="${escapeHtml(account.channelTitle||account.channelId)}">Desconectar</button></div>
    </article>`).join('')||'<div class="empty"><p>Nenhum canal conectado. Clique em “Adicionar canal”.</p></div>';
    box.querySelectorAll('[data-channel-default]').forEach(button=>button.onclick=async()=>{try{await stockApi(`/api/auth/accounts/${button.dataset.channelDefault}/default`,{method:'POST'});toast('Canal padrão atualizado');await loadAuthStatus();await loadChannelPage()}catch(error){toast(error.message,7000)}});
    box.querySelectorAll('[data-channel-delete]').forEach(button=>button.onclick=async()=>{if(!confirm(`Desconectar ${button.dataset.channelTitle}? Os agendamentos deste canal ficarão como AUTH_REQUIRED.`))return;try{await stockApi(`/api/auth/accounts/${button.dataset.channelDelete}`,{method:'DELETE'});toast('Canal desconectado');await loadAuthStatus();await loadChannelPage()}catch(error){toast(error.message,7000)}});
  }catch(e){box.innerHTML='<p>Não foi possível carregar os canais.</p>'}
}
$$('[data-view="metadata"]').forEach(b=>b.addEventListener('click',loadMetadataPage));$$('[data-view="channel"]').forEach(b=>b.addEventListener('click',loadChannelPage));
function applyYoutubeClientLinks(){
  const select=$('#youtubeClientSelect');
  const client=select?select.value:'1';
  document.querySelectorAll('a[href*="/api/auth/google"]').forEach(link=>{
    if(link.dataset.keepClient)return;
    try{const url=new URL(link.href);url.searchParams.set('client',client);link.href=url.toString();}catch{}
  });
}
$('#youtubeClientSelect')?.addEventListener('change',applyYoutubeClientLinks);
applyYoutubeClientLinks();
async function loadDashboardStats(){try{const l=await stockApi('/api/inventory/stats?contentType=LONG');if(document.querySelector('#dashLongAvailable'))document.querySelector('#dashLongAvailable').textContent=l.available;if(document.querySelector('#dashScheduled'))document.querySelector('#dashScheduled').textContent=l.scheduled;if(document.querySelector('#dashErrors'))document.querySelector('#dashErrors').textContent=l.errors}catch(e){console.warn('dashboard stats',e.message)}}

$('#saveMetadata')?.addEventListener('click',async()=>{const id=$('#metadataCategory').value;try{const payload={description:$('#metadataDescription').value,tags:$('#metadataTags').value.split(',').map(v=>v.trim()).filter(Boolean),youtubeCategoryId:$('#metadataYoutubeCategory').value,longTitleTemplates:($('#metadataLongTemplates')?.value||'').split('\n').filter(Boolean),autoComment:{enabled:Boolean($('#metadataCommentEnabled')?.checked),text:($('#metadataCommentText')?.value||'').slice(0,10000)}};await stockApi(`/api/metadata/${id}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});toast('Metadados salvos com sucesso.')}catch(e){toast(e.message,6000)}});
async function refreshDashboard(){try{const d=await stockApi('/api/inventory/dashboard');const longStats=await stockApi('/api/inventory/stats?contentType=LONG');if(document.querySelector('#dashLongAvailable'))document.querySelector('#dashLongAvailable').textContent=longStats.available;if(document.querySelector('#dashScheduled'))document.querySelector('#dashScheduled').textContent=longStats.scheduled;if(document.querySelector('#dashErrors'))document.querySelector('#dashErrors').textContent=longStats.errors;const upcoming=document.querySelector('#upcomingList');const longUpcoming=(d.upcoming||[]).filter(v=>(v.contentType||'LONG')==='LONG');if(upcoming)upcoming.innerHTML=longUpcoming.map(v=>`<div class="video-row"><div class="thumb">▶</div><div><strong>${escapeHtml(v.title)}</strong><small>${escapeHtml(v.youtubeCategoryName||v.category)}</small></div><time>${new Date(v.scheduledAt).toLocaleString('pt-BR')}</time></div>`).join('')||'<div class="empty"><p>Nenhum agendamento de vídeo encontrado.</p></div>'}catch(e){console.warn('dashboard',e.message)}}
async function loadSchedulesPage(){const box=$('#scheduleList');if(!box)return;try{const accountId=$('#schedulesAccount')?.value||'';const items=(await stockApi('/api/inventory/schedules')).filter(v=>(v.contentType||'LONG')==='LONG'&&(!accountId||v.accountId===accountId));box.innerHTML=items.map(v=>`<div class="queue-item"><div class="thumb">▶</div><div><strong>${escapeHtml(v.title)}</strong><small>${escapeHtml(v.accountName||'Sem canal')} · ${escapeHtml(v.youtubeCategoryName||v.category)} · ${escapeHtml(v.error==='AUTH_REQUIRED'?'Autorização necessária':v.status)}</small></div><time>${v.scheduledAt?new Date(v.scheduledAt).toLocaleString('pt-BR'):''}</time></div>`).join('')||'<div class="empty"><p>Nenhum agendamento de vídeo encontrado.</p></div>'}catch(e){box.innerHTML=`<div class="empty"><p>${escapeHtml(e.message)}</p></div>`}}
$('#schedulesAccount')?.addEventListener('change',loadSchedulesPage);
$('[data-view="schedules"]')?.addEventListener('click',renderYoutubeAccountSelectors);
$('#generatorAccount')?.addEventListener('change',e=>{if($('#scheduleAccount'))$('#scheduleAccount').value=e.target.value});
$('#scheduleAccount')?.addEventListener('change',e=>{if($('#generatorAccount'))$('#generatorAccount').value=e.target.value});
$$('[data-view="schedules"]').forEach(b=>b.addEventListener('click',loadSchedulesPage));

// --- TikTok: estoque, publicação oficial e fila local ------------------------
const ttState={items:[],selected:new Set(),status:'AVAILABLE',creator:null,auth:null};
const ttApi=async(url,options={})=>{const r=await fetch(url,options);const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||d.message||`Erro ${r.status}`);return d};
const ttDelay=ms=>new Promise(r=>setTimeout(r,ms));
function ttStatusLabel(s){return({AVAILABLE:'Disponível',SCHEDULED:'Agendado',UPLOADING:'Enviando',SUBMITTED:'Enviado',PUBLISHED:'Publicado',ERROR:'Erro'})[s]||s}
function ttPrivacyLabel(v){return({PUBLIC_TO_EVERYONE:'Público',MUTUAL_FOLLOW_FRIENDS:'Amigos',FOLLOWER_OF_CREATOR:'Seguidores',SELF_ONLY:'Somente eu'})[v]||v}
async function loadTikTokAuth(){
  try{
    const d=await ttApi('/api/tiktok/status');ttState.auth=d;ttState.creator=d.creator||null;
    const badge=$('#tiktokPlatformStatus');if(badge){badge.textContent=d.connected?'Conectado':(d.configured?'Disponível':'Configurar');badge.className='platform-status '+(d.configured?'ready':'soon')}
    if(sessionStorage.getItem('tube-autopilot-platform')==='tiktok'){if($('#topStatusDot'))$('#topStatusDot').classList.toggle('offline',!d.connected);if($('#topChannelText'))$('#topChannelText').textContent=d.connected?(d.creator?.creator_nickname||d.creator?.creator_username||'TikTok conectado'):'TikTok desconectado'}
    const text=$('#ttSettingText');if(text)text.textContent=!d.configured?'Preencha as credenciais do TikTok no arquivo .env.':d.connected?'TikTok conectado e pronto para usar a Content Posting API.':'Credenciais encontradas. Agora conecte sua conta TikTok.';
    if($('#ttRedirectUri'))$('#ttRedirectUri').textContent=`Redirect URI: ${d.redirectUri||''}`;
    if($('#ttAccountDetails')){
      const c=d.creator;
      $('#ttAccountDetails').innerHTML=d.connected?`<div class="setting"><div class="avatar">♪</div><div><h3>${escapeHtml(c?.creator_nickname||c?.creator_username||'Conta TikTok')}</h3><p>@${escapeHtml(c?.creator_username||'conta conectada')}</p><span class="badge">Conectado</span>${c?.max_video_post_duration_sec?`<small>Máximo informado pela conta: ${Number(c.max_video_post_duration_sec)}s</small>`:''}</div></div>`:'<p>TikTok desconectado. Use o botão abaixo para conectar.</p>';
    }
    return d;
  }catch(e){console.warn('TikTok auth',e.message);return null}
}
async function loadTikTokStats(){
  try{const d=await ttApi('/api/tiktok/stats');for(const [id,k] of [['ttAvailable','available'],['ttScheduled','scheduled'],['ttSubmitted','submitted'],['ttErrors','errors'],['ttDashAvailable','available'],['ttDashScheduled','scheduled'],['ttDashSubmitted','submitted'],['ttDashErrors','errors']])if($('#'+id))$('#'+id).textContent=d[k]||0}catch(e){console.warn(e.message)}
}
function renderTikTokBulk(){const n=ttState.selected.size;$('#ttBulkBar')?.classList.toggle('hidden',!n);if($('#ttSelectedCount'))$('#ttSelectedCount').textContent=n;if($('#ttScheduleQty'))$('#ttScheduleQty').value=n}
function ttPrivacyOptions(current){const options=ttState.creator?.privacy_level_options?.length?ttState.creator.privacy_level_options:['SELF_ONLY'];return options.map(v=>`<option value="${escapeHtml(v)}" ${v===current?'selected':''}>${escapeHtml(ttPrivacyLabel(v))}</option>`).join('')}
function renderTikTokList(){
  const box=$('#ttList');if(!box)return;const items=ttState.items.filter(v=>v.status===ttState.status);
  box.innerHTML=items.length?items.map(v=>`<div class="stock-item tt-video-row" data-tt-id="${v.id}"><input class="tt-check" type="checkbox" ${ttState.selected.has(v.id)?'checked':''}><div class="thumb">♪</div><div class="tt-edit"><div class="tt-row-meta"><strong>${escapeHtml(v.originalName)}</strong><span class="tt-status ${escapeHtml(v.status)}">${escapeHtml(ttStatusLabel(v.status))}</span>${v.scheduledAt?`<small>${new Date(v.scheduledAt).toLocaleString('pt-BR')}</small>`:''}</div><input class="tt-title" value="${escapeHtml(v.title||'')}" placeholder="Título interno"><textarea class="tt-caption" rows="2" maxlength="2200" placeholder="Legenda, hashtags e menções">${escapeHtml(v.caption||'')}</textarea><div class="tt-options"><label>Privacidade <select class="tt-privacy">${ttPrivacyOptions(v.privacyLevel)}</select></label><label class="check"><input class="tt-comments" type="checkbox" ${v.disableComment?'':'checked'}><span>Comentários</span></label><label class="check"><input class="tt-duet" type="checkbox" ${v.disableDuet?'':'checked'}><span>Dueto</span></label><label class="check"><input class="tt-stitch" type="checkbox" ${v.disableStitch?'':'checked'}><span>Stitch</span></label>${v.error?`<small class="error-text">${escapeHtml(v.error)}</small>`:''}</div></div><div class="tt-video-actions"><button class="text-btn tt-save">Salvar</button>${v.status==='AVAILABLE'?'<button class="primary tt-publish">Publicar</button>':''}${v.status==='SCHEDULED'?'<button class="secondary tt-cancel">Cancelar</button>':''}${['SUBMITTED','PUBLISHED'].includes(v.status)?'<button class="secondary tt-status-check">Atualizar status</button>':''}<button class="text-btn danger-text tt-delete">Excluir</button></div></div>`).join(''):'<div class="empty"><p>Nenhum vídeo neste status.</p></div>';
  box.querySelectorAll('[data-tt-id]').forEach(row=>{
    const id=row.dataset.ttId;
    row.querySelector('.tt-check').onchange=e=>{e.target.checked?ttState.selected.add(id):ttState.selected.delete(id);renderTikTokBulk()};
    row.querySelector('.tt-save').onclick=()=>saveTikTokRow(row,id);
    row.querySelector('.tt-publish')?.addEventListener('click',()=>publishTikTokOne(id,row));
    row.querySelector('.tt-cancel')?.addEventListener('click',async()=>{try{await ttApi(`/api/tiktok/inventory/${id}/cancel`,{method:'POST'});toast('Agendamento cancelado');await loadTikTokVideos()}catch(e){toast(e.message,7000)}});
    row.querySelector('.tt-status-check')?.addEventListener('click',async()=>{try{await ttApi(`/api/tiktok/publish-status/${id}`,{method:'POST'});await loadTikTokVideos();toast('Status atualizado')}catch(e){toast(e.message,7000)}});
    row.querySelector('.tt-delete').onclick=async()=>{if(!confirm('Excluir este vídeo do estoque TikTok?'))return;try{await ttApi(`/api/tiktok/inventory/${id}`,{method:'DELETE'});ttState.selected.delete(id);await loadTikTokVideos()}catch(e){toast(e.message,7000)}};
  });renderTikTokBulk();
}
async function saveTikTokRow(row,id){
  const payload={title:row.querySelector('.tt-title').value,caption:row.querySelector('.tt-caption').value,privacyLevel:row.querySelector('.tt-privacy').value,disableComment:!row.querySelector('.tt-comments').checked,disableDuet:!row.querySelector('.tt-duet').checked,disableStitch:!row.querySelector('.tt-stitch').checked};
  try{await ttApi(`/api/tiktok/inventory/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});toast('Vídeo TikTok salvo')}catch(e){toast(e.message,7000)}
}
async function loadTikTokVideos(){
  try{ttState.items=await ttApi('/api/tiktok/inventory');const valid=new Set(ttState.items.map(v=>v.id));ttState.selected=new Set([...ttState.selected].filter(v=>valid.has(v)));renderTikTokList();await loadTikTokStats();renderTikTokUpcoming()}catch(e){if($('#ttList'))$('#ttList').innerHTML=`<div class="empty"><p>${escapeHtml(e.message)}</p></div>`}
}
function renderTikTokUpcoming(){const items=ttState.items.filter(v=>v.status==='SCHEDULED').sort((a,b)=>new Date(a.scheduledAt)-new Date(b.scheduledAt));const html=items.slice(0,8).map(v=>`<div class="queue-item"><div class="thumb">♪</div><div><strong>${escapeHtml(v.title)}</strong><small>${new Date(v.scheduledAt).toLocaleString('pt-BR')}</small></div><span class="tt-status SCHEDULED">Agendado</span></div>`).join('')||'<div class="empty"><p>Nenhum agendamento TikTok.</p></div>';if($('#ttUpcoming'))$('#ttUpcoming').innerHTML=html;if($('#ttScheduleList'))$('#ttScheduleList').innerHTML=html}
async function publishTikTokOne(id,row){
  const st=await loadTikTokAuth();if(!st?.connected){toast('Conecte sua conta TikTok primeiro',6000);go('tiktok-account');return}
  if(row)await saveTikTokRow(row,id);if(!confirm('Enviar este vídeo para sua conta TikTok agora?'))return;
  toast('Enviando vídeo para o TikTok. Aguarde...',6000);try{await ttApi(`/api/tiktok/inventory/${id}/publish`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});toast('Vídeo enviado ao TikTok!',7000);await loadTikTokVideos()}catch(e){toast(e.message,9000);await loadTikTokVideos()}
}
async function publishSelectedTikTok(){
  const ids=[...ttState.selected];if(!ids.length)return;const st=await loadTikTokAuth();if(!st?.connected){toast('Conecte sua conta TikTok primeiro',6000);go('tiktok-account');return}if(!confirm(`Enviar ${ids.length} vídeo(s) para o TikTok agora?`))return;
  let ok=0;for(let i=0;i<ids.length;i++){toast(`TikTok: enviando ${i+1}/${ids.length}...`,12000);try{await ttApi(`/api/tiktok/inventory/${ids[i]}/publish`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});ok++}catch(e){console.error(e)}if(i<ids.length-1)await ttDelay(11000)}ttState.selected.clear();toast(`${ok}/${ids.length} vídeo(s) enviados ao TikTok`,8000);await loadTikTokVideos()
}
async function uploadTikTokFiles(){const input=$('#ttFiles');const files=[...(input?.files||[])];if(!files.length){toast('Selecione vídeos para o TikTok');return}const fd=new FormData();files.forEach(f=>fd.append('videos',f));const btn=$('#ttAddBtn');btn.disabled=true;btn.textContent='Adicionando...';if($('#ttUploadProgress'))$('#ttUploadProgress').style.width='35%';try{const r=await fetch('/api/tiktok/inventory',{method:'POST',body:fd});const d=await r.json();if(!r.ok)throw new Error(d.error||'Falha no upload');if($('#ttUploadProgress'))$('#ttUploadProgress').style.width='100%';input.value='';$('#ttFileSummary').textContent='Nenhum vídeo selecionado.';toast(`${d.length} vídeo(s) adicionados ao TikTok`);await loadTikTokVideos()}catch(e){toast(e.message,8000)}finally{btn.disabled=false;btn.textContent='Adicionar ao estoque TikTok';setTimeout(()=>{if($('#ttUploadProgress'))$('#ttUploadProgress').style.width='0%'},900)}}
function openTikTokSchedule(){const ids=[...ttState.selected];if(!ids.length){toast('Selecione os vídeos que deseja agendar');return}$('#ttSchedulePanel').classList.remove('hidden');$('#ttScheduleQty').value=ids.length;if(!$('#ttScheduleDate').value)$('#ttScheduleDate').value=new Date().toISOString().slice(0,10);$('#ttSchedulePanel').scrollIntoView({behavior:'smooth',block:'center'})}
async function confirmTikTokSchedule(){const ids=[...ttState.selected];if(!ids.length)return;const date=$('#ttScheduleDate').value,time=$('#ttScheduleTime').value;if(!date||!time){toast('Informe data e hora');return}const start=new Date(`${date}T${time}:00`);if(start<=new Date()){toast('Escolha um horário futuro');return}try{const d=await ttApi('/api/tiktok/schedule',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids,startAt:start.toISOString(),intervalMinutes:Number($('#ttScheduleInterval').value||60)})});ttState.selected.clear();$('#ttSchedulePanel').classList.add('hidden');toast(`${d.length} vídeo(s) agendados para TikTok`,7000);await loadTikTokVideos()}catch(e){toast(e.message,8000)}}
$('#ttFiles')?.addEventListener('change',e=>{const fs=[...e.target.files];$('#ttFileSummary').textContent=fs.length?`${fs.length} vídeo(s) selecionados • ${(fs.reduce((n,f)=>n+f.size,0)/1024/1024).toFixed(1)} MB`:'Nenhum vídeo selecionado.'});
$('#ttAddBtn')?.addEventListener('click',uploadTikTokFiles);$('#ttRefresh')?.addEventListener('click',loadTikTokVideos);$('#ttPublishSelected')?.addEventListener('click',publishSelectedTikTok);$('#ttScheduleSelected')?.addEventListener('click',openTikTokSchedule);$('#ttCloseSchedule')?.addEventListener('click',()=>$('#ttSchedulePanel').classList.add('hidden'));$('#ttConfirmSchedule')?.addEventListener('click',confirmTikTokSchedule);$('#ttClearSelected')?.addEventListener('click',()=>{ttState.selected.clear();renderTikTokList()});$('#ttSelectAll')?.addEventListener('change',e=>{const visible=ttState.items.filter(v=>v.status===ttState.status);visible.forEach(v=>e.target.checked?ttState.selected.add(v.id):ttState.selected.delete(v.id));renderTikTokList()});
$$('[data-tt-status]').forEach(b=>b.addEventListener('click',()=>{$$('[data-tt-status]').forEach(x=>x.classList.toggle('active',x===b));ttState.status=b.dataset.ttStatus;ttState.selected.clear();renderTikTokList()}));
$('#ttDisconnect')?.addEventListener('click',async()=>{try{await ttApi('/api/tiktok/logout',{method:'POST'});toast('TikTok desconectado');await loadTikTokAuth()}catch(e){toast(e.message)}});
$$('[data-view^="tiktok-"]').forEach(b=>b.addEventListener('click',()=>{loadTikTokAuth();loadTikTokVideos()}));

// --- Hub multi-plataforma ----------------------------------------------------
const platformHub = {
  gate: document.querySelector('#platformGate'),
  active: 'youtube',
  open(){ this.gate?.classList.remove('is-hidden'); document.body.classList.add('body-platform-picker-open'); },
  close(){ this.gate?.classList.add('is-hidden'); document.body.classList.remove('body-platform-picker-open'); },
  select(platform){
    if(platform === 'instagram'){toast('Instagram será a próxima integração.',4500);return}
    this.active=platform;sessionStorage.setItem('tube-autopilot-platform',platform);
    const isTikTok=platform==='tiktok';
    $('#youtubeNav')?.classList.toggle('hidden',isTikTok);$('#tiktokNav')?.classList.toggle('hidden',!isTikTok);
    const name=$('#currentPlatformName'),icon=$('#currentPlatformIcon'),eyebrow=$('#platformEyebrow');
    if(name)name.textContent=isTikTok?'TikTok':'YouTube';if(icon)icon.textContent=isTikTok?'♪':'▶';if(eyebrow)eyebrow.textContent=isTikTok?'AUTOMAÇÃO PARA TIKTOK':'AUTOMAÇÃO PARA YOUTUBE';
    if($('#topChannelText'))$('#topChannelText').textContent=isTikTok?'TikTok':(authState.connected?authState.channel?.title||'YouTube conectado':'YouTube desconectado');if($('#topAvatar'))$('#topAvatar').textContent=isTikTok?'TT':'YT';
    this.close();
    if(isTikTok){go('tiktok-dashboard');loadTikTokAuth();loadTikTokVideos()}else{go('dashboard');loadAuthStatus();refreshDashboard()}
  }
};
document.querySelectorAll('[data-platform]').forEach(card=>card.addEventListener('click',()=>platformHub.select(card.dataset.platform)));
document.querySelector('#switchPlatformBtn')?.addEventListener('click',()=>platformHub.open());
async function initPlatformHub(){
  document.body.classList.add('body-platform-picker-open');
  try{const response=await fetch('/api/auth/status');const status=await response.json();const badge=$('#youtubePlatformStatus');if(badge){badge.textContent=status.connected?'Conectado':'Disponível';badge.classList.toggle('ready',true)}}catch{}
  await loadTikTokAuth();
  const remembered=sessionStorage.getItem('tube-autopilot-platform');
  if(remembered==='tiktok')platformHub.select('tiktok');else if(remembered==='youtube')platformHub.select('youtube');else platformHub.open();
}

initAuth();
