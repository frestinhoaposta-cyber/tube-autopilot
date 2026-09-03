const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

module.exports = function createTikTokRouter(){
  const router = express.Router();
  const root = path.join(__dirname,'..');
  const dataDir = path.join(root,'data');
  const videoDir = path.join(dataDir,'tiktok-videos');
  const invPath = path.join(dataDir,'tiktok-inventory.json');
  const authPath = path.join(dataDir,'tiktok-auth.json');
  fs.mkdirSync(videoDir,{recursive:true});
  if(!fs.existsSync(invPath)) fs.writeFileSync(invPath,'[]');

  const upload = multer({
    dest: path.join(dataDir,'.tiktok-upload-tmp'),
    limits:{fileSize:4*1024*1024*1024},
    fileFilter:(_,f,cb)=>cb(null, Boolean(f.mimetype?.startsWith('video/') || /\.(mp4|mov|webm)$/i.test(f.originalname||'')))
  });
  fs.mkdirSync(path.join(dataDir,'.tiktok-upload-tmp'),{recursive:true});

  const readJson=(p,fallback)=>{try{return JSON.parse(fs.readFileSync(p,'utf8'))}catch{return fallback}};
  const writeJson=(p,v)=>fs.writeFileSync(p,JSON.stringify(v,null,2),'utf8');
  const list=()=>readJson(invPath,[]);
  const save=v=>writeJson(invPath,v);
  const cfg=()=>({
    clientKey:process.env.TIKTOK_CLIENT_KEY||'',
    clientSecret:process.env.TIKTOK_CLIENT_SECRET||'',
    redirectUri:process.env.TIKTOK_REDIRECT_URI||`http://localhost:${process.env.PORT||3000}/api/tiktok/auth/callback`
  });
  const configured=()=>Boolean(cfg().clientKey&&cfg().clientSecret&&cfg().redirectUri);
  const auth=()=>readJson(authPath,null);
  const saveAuth=v=>writeJson(authPath,v);

  async function formPost(url,params){
    const body=new URLSearchParams(params);
    const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});
    const d=await r.json().catch(()=>({}));
    if(!r.ok || d.error) throw new Error(d.error_description||d.error?.message||d.error||`TikTok HTTP ${r.status}`);
    return d;
  }
  async function refreshTokenIfNeeded(){
    let a=auth(); if(!a) throw new Error('TikTok não conectado.');
    if(!a.expires_at || Date.now() < a.expires_at-120000) return a;
    const c=cfg();
    const d=await formPost('https://open.tiktokapis.com/v2/oauth/token/',{client_key:c.clientKey,client_secret:c.clientSecret,grant_type:'refresh_token',refresh_token:a.refresh_token});
    a={...a,...d,expires_at:Date.now()+Number(d.expires_in||86400)*1000,updated_at:new Date().toISOString()}; saveAuth(a); return a;
  }
  async function apiPost(endpoint,body={}){
    const a=await refreshTokenIfNeeded();
    const r=await fetch(`https://open.tiktokapis.com${endpoint}`,{method:'POST',headers:{Authorization:`Bearer ${a.access_token}`,'Content-Type':'application/json; charset=UTF-8'},body:JSON.stringify(body)});
    const d=await r.json().catch(()=>({}));
    if(!r.ok || (d.error && d.error.code && d.error.code!=='ok')) throw new Error(d.error?.message||d.message||`TikTok HTTP ${r.status}`);
    return d;
  }
  async function creatorInfo(){return (await apiPost('/v2/post/publish/creator_info/query/',{})).data||{};}

  async function uploadToTikTok(item){
    const full=path.join(videoDir,item.storedName);
    if(!fs.existsSync(full)) throw new Error('Arquivo do vídeo não foi encontrado.');
    const stat=fs.statSync(full); const size=stat.size;
    const creator=await creatorInfo();
    const opts=creator.privacy_level_options||['SELF_ONLY'];
    let privacy=item.privacyLevel||'SELF_ONLY';
    if(!opts.includes(privacy)) privacy=opts.includes('SELF_ONLY')?'SELF_ONLY':opts[0];
    const maxDuration=Number(creator.max_video_post_duration_sec||0);
    const chunkSize=size<=64*1024*1024 ? size : 10*1024*1024;
    const totalChunks=Math.ceil(size/chunkSize);
    const init=await apiPost('/v2/post/publish/video/init/',{
      post_info:{
        title:String(item.caption||item.title||'').slice(0,2200),
        privacy_level:privacy,
        disable_duet:Boolean(item.disableDuet),
        disable_comment:Boolean(item.disableComment),
        disable_stitch:Boolean(item.disableStitch)
      },
      source_info:{source:'FILE_UPLOAD',video_size:size,chunk_size:chunkSize,total_chunk_count:totalChunks}
    });
    const uploadUrl=init.data?.upload_url; const publishId=init.data?.publish_id;
    if(!uploadUrl) throw new Error('TikTok não retornou URL de upload.');
    const fd=fs.openSync(full,'r');
    try{
      for(let i=0,start=0; start<size; i++,start+=chunkSize){
        const end=Math.min(size,start+chunkSize); const len=end-start;
        const buf=Buffer.allocUnsafe(len); fs.readSync(fd,buf,0,len,start);
        const r=await fetch(uploadUrl,{method:'PUT',headers:{'Content-Type':'video/mp4','Content-Length':String(len),'Content-Range':`bytes ${start}-${end-1}/${size}`},body:buf});
        if(!r.ok) throw new Error(`Falha ao transferir vídeo para o TikTok (${r.status}).`);
      }
    } finally {fs.closeSync(fd)}
    return {publishId,privacy,creator};
  }

  router.get('/status',async(req,res)=>{
    const a=auth(); let creator=null;
    if(a){try{creator=await creatorInfo()}catch{}}
    res.json({configured:configured(),connected:Boolean(a?.access_token),creator,redirectUri:cfg().redirectUri});
  });
  router.get('/auth', (req,res)=>{
    if(!configured()) return res.redirect('/?tiktok=missing-config#tiktok-settings');
    const state=crypto.randomBytes(24).toString('hex'); req.session.tiktokOauthState=state;
    const c=cfg(); const u=new URL('https://www.tiktok.com/v2/auth/authorize/');
    u.searchParams.set('client_key',c.clientKey);u.searchParams.set('scope','user.info.basic,video.publish');u.searchParams.set('response_type','code');u.searchParams.set('redirect_uri',c.redirectUri);u.searchParams.set('state',state);
    res.redirect(u.toString());
  });
  router.get('/auth/callback',async(req,res)=>{
    if(req.query.error) return res.redirect('/?tiktok=denied#tiktok-settings');
    if(!req.query.state || req.query.state!==req.session.tiktokOauthState) return res.status(400).send('Falha de segurança no login do TikTok (state inválido).');
    try{
      const c=cfg(); const d=await formPost('https://open.tiktokapis.com/v2/oauth/token/',{client_key:c.clientKey,client_secret:c.clientSecret,code:String(req.query.code||''),grant_type:'authorization_code',redirect_uri:c.redirectUri});
      saveAuth({...d,expires_at:Date.now()+Number(d.expires_in||86400)*1000,connected_at:new Date().toISOString()}); delete req.session.tiktokOauthState;
      res.redirect('/?tiktok=success#tiktok-settings');
    }catch(e){console.error('[tiktok oauth]',e);res.redirect('/?tiktok=error#tiktok-settings')}
  });
  router.post('/logout',(_,res)=>{try{fs.unlinkSync(authPath)}catch{} res.json({ok:true})});
  router.get('/creator',async(_,res)=>{try{res.json(await creatorInfo())}catch(e){res.status(400).json({error:e.message})}});

  router.get('/inventory',(req,res)=>{
    let items=list(); const status=String(req.query.status||'').toUpperCase(); if(status) items=items.filter(v=>v.status===status);
    items.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)); res.json(items);
  });
  router.get('/stats',(_,res)=>{const items=list(); const count=s=>items.filter(v=>v.status===s).length;res.json({available:count('AVAILABLE'),scheduled:count('SCHEDULED'),submitted:count('SUBMITTED'),errors:count('ERROR'),total:items.length})});
  router.post('/inventory',upload.array('videos',100),(req,res)=>{
    const files=req.files||[]; if(!files.length)return res.status(400).json({error:'Selecione ao menos um vídeo.'});
    const items=list(); const added=[];
    for(const f of files){const ext=path.extname(f.originalname)||'.mp4';const id=crypto.randomUUID();const stored=`${id}${ext.toLowerCase()}`;fs.renameSync(f.path,path.join(videoDir,stored));const row={id,originalName:f.originalname,storedName:stored,title:path.basename(f.originalname,ext),caption:path.basename(f.originalname,ext),size:f.size,status:'AVAILABLE',privacyLevel:'SELF_ONLY',createdAt:new Date().toISOString(),scheduledAt:null,publishId:null,error:null};items.push(row);added.push(row)}
    save(items);res.json(added);
  });
  router.patch('/inventory/:id',(req,res)=>{const items=list();const i=items.findIndex(v=>v.id===req.params.id);if(i<0)return res.status(404).json({error:'Vídeo não encontrado.'});for(const k of ['title','caption','privacyLevel','disableComment','disableDuet','disableStitch'])if(req.body[k]!==undefined)items[i][k]=req.body[k];save(items);res.json(items[i])});
  router.delete('/inventory/:id',(req,res)=>{const items=list();const i=items.findIndex(v=>v.id===req.params.id);if(i<0)return res.status(404).json({error:'Vídeo não encontrado.'});const [row]=items.splice(i,1);try{fs.unlinkSync(path.join(videoDir,row.storedName))}catch{}save(items);res.json({ok:true})});
  router.post('/inventory/:id/publish',async(req,res)=>{
    const items=list();const i=items.findIndex(v=>v.id===req.params.id);if(i<0)return res.status(404).json({error:'Vídeo não encontrado.'});
    try{items[i]={...items[i],...(req.body||{}),status:'UPLOADING',error:null};save(items);const out=await uploadToTikTok(items[i]);items[i]={...items[i],status:'SUBMITTED',publishId:out.publishId,privacyLevel:out.privacy,submittedAt:new Date().toISOString()};save(items);res.json(items[i])}
    catch(e){items[i].status='ERROR';items[i].error=e.message;save(items);res.status(400).json({error:e.message})}
  });
  router.post('/schedule',(req,res)=>{
    const ids=Array.isArray(req.body?.ids)?req.body.ids:[];const start=new Date(req.body?.startAt);const interval=Math.max(5,Number(req.body?.intervalMinutes||60));if(!ids.length||Number.isNaN(start.getTime()))return res.status(400).json({error:'Selecione vídeos e informe uma data válida.'});
    const items=list();const preview=[];ids.forEach((id,n)=>{const i=items.findIndex(v=>v.id===id);if(i<0)return;const at=new Date(start.getTime()+n*interval*60000);items[i].scheduledAt=at.toISOString();items[i].status='SCHEDULED';items[i].error=null;preview.push({id,title:items[i].title,scheduledAt:items[i].scheduledAt})});save(items);res.json(preview)
  });
  router.post('/inventory/:id/cancel',(req,res)=>{const items=list();const i=items.findIndex(v=>v.id===req.params.id);if(i<0)return res.status(404).json({error:'Vídeo não encontrado.'});items[i].status='AVAILABLE';items[i].scheduledAt=null;items[i].error=null;save(items);res.json(items[i])});
  router.post('/publish-status/:id',async(req,res)=>{const items=list();const i=items.findIndex(v=>v.id===req.params.id);if(i<0)return res.status(404).json({error:'Vídeo não encontrado.'});if(!items[i].publishId)return res.status(400).json({error:'Sem publish_id.'});try{const d=await apiPost('/v2/post/publish/status/fetch/',{publish_id:items[i].publishId});items[i].tiktokStatus=d.data||{};if(['PUBLISH_COMPLETE','SEND_TO_USER_INBOX'].includes(d.data?.status))items[i].status='PUBLISHED';else if(d.data?.status==='FAILED'){items[i].status='ERROR';items[i].error=d.data?.fail_reason||'Falha no TikTok';}save(items);res.json(items[i])}catch(e){res.status(400).json({error:e.message})}});

  let busy=false;
  async function tick(){if(busy)return;busy=true;try{const items=list();const due=items.filter(v=>v.status==='SCHEDULED'&&v.scheduledAt&&new Date(v.scheduledAt)<=new Date()).slice(0,1);for(const row of due){const i=items.findIndex(v=>v.id===row.id);try{items[i].status='UPLOADING';save(items);const out=await uploadToTikTok(items[i]);items[i].status='SUBMITTED';items[i].publishId=out.publishId;items[i].privacyLevel=out.privacy;items[i].submittedAt=new Date().toISOString();items[i].error=null}catch(e){items[i].status='ERROR';items[i].error=e.message}save(items)}}finally{busy=false}}
  setInterval(tick,30000).unref(); setTimeout(tick,3000).unref();
  return router;
};
