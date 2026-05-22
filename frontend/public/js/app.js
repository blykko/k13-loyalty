'use strict';
let STATE={user:null,challenges:[],codes:[],orders:[],shopItems:[],progression:{},activity:{}};
let currentFilter='all';
let redirectToken=null,redirectDelay=0,redirectTimer=null,pendingScreenChallengeId=null;
let watchSessionId=null,watchInterval=null,liveActive=false;


// ── Dark mode ─────────────────────────────────────────────────────────────────
function toggleDark(){
  const isDark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('k13-dark', isDark ? '1' : '0');
  el('btn-dark').textContent = isDark ? '☀️' : '🌙';
}
function initDark(){
  if(localStorage.getItem('k13-dark')==='1'){
    document.documentElement.classList.add('dark');
    const btn=el('btn-dark'); if(btn) btn.textContent='☀️';
  }
}

window.addEventListener('DOMContentLoaded',async()=>{
  initDark();
  const params=new URLSearchParams(location.search);
  const errMsgs={
    twitch_invalid_client:'Twitch : "invalid client". Vérifie le Client Secret dans ton .env (il doit faire 30 caractères, pas 50).',
    twitch_denied:'Connexion Twitch annulée.',
    twitch_link_failed:'Erreur liaison Twitch.',
    discord_login_failed:'Erreur Discord.',
  };
  if(params.get('error')) toast(errMsgs[params.get('error')]||params.get('error').replace(/_/g,' '),'error');
  if(params.get('linked')){
    const names={twitch:'Twitch 🟣',discord:'Discord 💬'};
    toast(`✅ Compte ${names[params.get('linked')]||params.get('linked')} lié avec succès !`,'success');
  }
  history.replaceState({},'','/');
  const me=await api('GET','/auth/me');
  if(me.ok&&me.user){ show('app'); hide('auth-page'); loadAll(); }
  else{ show('auth-page'); hide('app'); }
});

async function verifyTwitchFollow(){
  toast('Vérification du follow Twitch…');
  const res=await api('POST','/api/user/challenge/twitch-follow/verify');
  if(res.ok){ toast(res.message,'success'); await loadAll(); }
  else if(res.needsLink){ toast(res.message,'error'); window.location.href='/auth/twitch'; }
  else{
    // Pas encore follow → ouvre la page Twitch
    toast('Tu ne suis pas encore K13. La page Twitch souvre...','error');
    window.open('https://twitch.tv/k13esport','_blank','noopener');
    await loadAll();
  }
}

async function loadAll(){
  const[stats,shopRes]=await Promise.all([api('GET','/api/user/stats'),api('GET','/api/user/shop')]);
  if(stats.ok){ STATE.user=stats.user; STATE.challenges=stats.challenges; STATE.codes=stats.codes; STATE.orders=stats.orders; STATE.progression=stats.progression; STATE.activity=stats.activity||{}; renderAll(); }
  if(shopRes.ok){ STATE.shopItems=shopRes.items; renderShop(); }
}

function fmtSecs(s){
  if(!s||s===0) return '0 min';
  const h=Math.floor(s/3600), m=Math.floor((s%3600)/60);
  if(h===0) return m+' min';
  if(s===72000||s===18000) return h+'h'; // 20h et 5h gardés en heures
  if(m===0) return h+'h';
  return h+'h '+m+'min';
}
function renderAll(){
  const u=STATE.user,pts=u.points;
  // Avatar
  const avatarUrl=u.discord_id&&u.discord_avatar?`https://cdn.discordapp.com/avatars/${u.discord_id}/${u.discord_avatar}.png?size=128`:null;
  const letter=(u.discord_username||u.username||'?').charAt(0).toUpperCase();
  setAvatar('hero-avatar-wrap',avatarUrl,letter);
  setAvatar('nav-avatar',avatarUrl,letter);
  // Hero
  el('hero-name').textContent=u.discord_username||u.username;
  const rl={bronze:'🥉 Bronze',silver:'🥈 Silver',gold:'🥇 Gold'};
  el('hero-rank').textContent=rl[u.rank]||u.rank;
  el('hero-pts').textContent=pts.toLocaleString('fr-FR');
  el('nav-pts').textContent=pts.toLocaleString('fr-FR')+' pts';
  // Progression
  const p=STATE.progression;
  el('prog-pct').textContent=p.pct+'%';
  el('prog-bar').style.width=p.pct+'%';
  el('prog-sub').textContent=`${p.done} / ${p.total} challenges complétés`;
  // Stats
  el('s-pts').textContent=pts.toLocaleString('fr-FR');
  el('s-done').textContent=p.done;
  el('s-watch').textContent=fmtSecs(STATE.activity.watchSec||0);
  el('s-msg').textContent=(STATE.activity.discMsgs||0).toLocaleString('fr-FR');
  renderAccounts();
  renderDashDaily();
  renderChallengesPage();
  renderShop();
  renderOrders();
}

function setAvatar(id,url,letter){
  const e=el(id); if(!e) return;
  let span=e.querySelector('span'),img=e.querySelector('img');
  if(url){
    if(!img){img=document.createElement('img');img.alt='';e.appendChild(img);}
    img.src=url; img.style.display='block';
    if(span) span.style.display='none';
  } else {
    if(img) img.style.display='none';
    if(!span){span=document.createElement('span');e.appendChild(span);}
    span.textContent=letter; span.style.display='';
  }
}

function renderAccounts(){
  const u=STATE.user;
  el('accounts-row').innerHTML=[
    accChip('💬','Discord',u.discord_username,'/auth/discord',true),
    accChip('🟣','Twitch',u.twitch_login,'/auth/twitch'),
    epicChip(u.epic_username),
  ].join('');
  // Affiche le tracker sur la page challenges si Twitch lié
  const liveBar = el('live-bar');
  if (liveBar) {
    if (u.twitch_id) liveBar.classList.remove('hidden');
    else liveBar.classList.add('hidden');
  }
  // Live bar : visible seulement si Twitch lié ET pas de StreamElements (fallback)
  // Avec SE configuré, le tracking est automatique, pas besoin du bouton

}

function epicChip(username){
  if(username) return `<div class="acc-chip linked">🎮 ${esc(username)}</div>`;
  // Chip cliquable qui ouvre un mini formulaire inline
  return `<div class="acc-chip unlinked" onclick="openEpicForm()" style="cursor:pointer">🎮 Lier Epic Games</div>
    <div id="epic-inline" class="epic-inline hidden">
      <input class="epic-input" id="epic-username" placeholder="Pseudo Epic Games" />
      <input class="epic-input" id="epic-code" placeholder="Code créateur (optionnel)" />
      <button class="btn-epic-save" onclick="saveEpic()">Enregistrer</button>
      <button class="btn-epic-cancel" onclick="hide('epic-inline')">Annuler</button>
    </div>`;
}

function openEpicForm(){
  const existing=document.getElementById('epic-inline');
  if(existing) existing.classList.toggle('hidden');
}

function accChip(icon,name,handle,href,required=false){
  if(handle) return `<div class="acc-chip linked">${icon} @${esc(handle)}</div>`;
  return `<a href="${href}"><div class="acc-chip unlinked ${required?'required':''}">${icon} Lier ${name}${required?' (requis)':''}</div></a>`;
}

function renderDashDaily(){
  const daily=STATE.challenges.filter(c=>c.category==='daily'||c.repeat_seconds===86400);
  const undone=daily.filter(c=>!c.completed);
  el('daily-count').textContent=undone.length||'';
  el('dash-daily').innerHTML=(undone.length?undone:daily).slice(0,5).map(chItem).join('')||'<p class="empty-msg">Aucun challenge quotidien actif.</p>';
}

function renderChallengesPage(){
  const filtered=currentFilter==='all'?STATE.challenges
    :STATE.challenges.filter(c=>{
      if(currentFilter==='daily') return c.category==='daily'||c.repeat_seconds===86400;
      if(currentFilter==='weekly') return c.category==='weekly'||c.repeat_seconds===604800;
      return c.category===currentFilter;
    });
  const platforms=[...new Set(filtered.map(c=>c.platform))];
  const pNames={discord:'Discord',twitch:'Twitch',twitter:'Twitter / X',tiktok:'TikTok',instagram:'Instagram',epic:'Epic Games'};
  el('challenges-sections').innerHTML=platforms.map(plat=>{
    const chs=filtered.filter(c=>c.platform===plat);
    return chs.length?`<div class="ch-section"><div class="ch-section-hd"><span class="plat-chip ${plat}">${pNames[plat]||plat}</span></div><div class="ch-list">${chs.map(chItem).join('')}</div></div>`:'';
  }).join('')||'<p class="empty-msg">Aucun challenge ici.</p>';
}

function chItem(c){
  const icons={discord:'💬',twitch:'🟣',twitter:'𝕏',tiktok:'🎵',instagram:'📸',epic:'🎮'};
  const repeatLbl=c.repeat_seconds?`<span class="ch-repeat">${repeatText(c.repeat_seconds)}</span>`:''
  const seLbl=c.type==='watchtime'?`<span class="ch-type-lbl" title="Synchronisé avec StreamElements toutes les 5-10 min">📡 Auto SE</span>`:'';;
  const typeLbl=c.type==='redirect'?'<span class="ch-type-lbl">🔗 Timer</span>':c.type==='screen'?'<span class="ch-type-lbl">📸 Screen</span>':c.type==='watchtime'?'<span class="ch-type-lbl">📺 Auto</span>':c.type==='messages'||c.type==='vocal'?'<span class="ch-type-lbl">🤖 Auto</span>':'';
  let prog='';
  if(c.progress&&c.progress.required>0){
    const pct=Math.min(100,Math.round(c.progress.current/c.progress.required*100));
    const cur=c.type==='watchtime'||c.type==='vocal'?fmtSecs(c.progress.current):c.progress.current;
    const req=c.type==='watchtime'||c.type==='vocal'?fmtSecs(c.progress.required):c.progress.required;
    prog=`<div class="ch-prog-bg"><div class="ch-prog-fill" style="width:${pct}%"></div></div><div class="ch-prog-text">${cur} / ${req}</div>`;
  }
  let btn;
  if(c.completed){
    btn=`<button class="btn-ch done">✓ Validé</button>`;
  } else if(c.pending&&c.screenshotPath){
    btn=`<button class="btn-ch pending">⏳ En attente admin</button>`;
  } else if(c.pending&&c.type==='screen'){
    // Screen envoyé mais pas encore validé admin → permettre renvoi
    btn=`<button class="btn-ch do secondary" onclick="openScreenModal(${c.id},'${esc(c.name)}')">📸 Renvoyer screen</button>`;
  } else if(c.pending){
    btn=`<button class="btn-ch pending">⏳ En cours…</button>`;
  } else if(c.type==='redirect'&&c.redirect_url){
    btn=`<button class="btn-ch do" onclick="startRedirect('${c.slug}','${esc(c.redirect_url)}',${c.redirect_delay||20},'${esc(c.name)}',${c.id})">Visiter →</button>`;
  } else if(c.type==='screen'){
    btn=`<button class="btn-ch do" onclick="verifyChallenge('${c.slug}')">📸 Envoyer screen</button>`;
  } else if(c.slug==='twitch-follow'){
    btn=`<button class="btn-ch do" onclick="verifyChallenge('${c.slug}')">✓ Vérifier</button>`;
  } else {
    btn=`<button class="btn-ch do" onclick="verifyChallenge('${c.slug}')">Valider</button>`;
  }

  return `<div class="ch-item ${c.completed?'done':c.pending?'pending':''}">
    <div class="ch-icon ${c.platform}">${icons[c.platform]||'⭐'}</div>
    <div class="ch-body">
      <div class="ch-name">${esc(c.name)}</div>
      <div class="ch-desc">${esc(c.description)}${c.type==='watchtime'?' <span style="color:var(--t3);font-size:11px">(actualisation auto toutes les 5-10 min)</span>':''}</div>
      <div class="ch-meta"><span class="ch-pts">+${c.points} pts</span>${repeatLbl}${typeLbl}${seLbl||''}</div>
      ${prog?'<div class="ch-progress">'+prog+'</div>':''}
    </div>
    <div class="ch-action">${btn}</div>
  </div>`;
}

function repeatText(s){
  if(s===86400)  return '🔄 Quotidien';
  if(s===604800) return '📅 Hebdo';
  if(s===2592000)return '📆 Mensuel';
  const h=Math.floor(s/3600), m=Math.floor((s%3600)/60);
  if(h===0) return `🔄 ${m} min`;
  if(m===0) return `🔄 ${h}h`;
  return `🔄 ${h}h ${m}min`;
}

function renderShop(){
  const pts=STATE.user?.points||0;
  el('shop-grid').innerHTML=STATE.shopItems.map(item=>{
    const can=pts>=item.cost_points;
    const emojis={promo_code:'🎟️',discord_role:'🏅',product:'📦'};
    return `<div class="shop-card">
      <div class="shop-emoji">${emojis[item.type]||'🎁'}</div>
      <div class="shop-name">${esc(item.name)}</div>
      <div class="shop-desc">${esc(item.description)}</div>
      <div class="shop-price">${item.cost_points.toLocaleString('fr-FR')} pts</div>
      <button class="btn-buy" ${can?'':'disabled'} onclick="buyItem(${item.id},'${esc(item.name)}')">${can?'Acheter':'Insuffisant'}</button>
    </div>`;
  }).join('')||'<p class="empty-msg">Aucun article.</p>';
}

function renderOrders(){
  const tbody=el('orders-body');if(!tbody)return;
  tbody.innerHTML=STATE.orders.map(o=>`<tr>
    <td>${esc(o.item_name)}</td>
    <td style="font-family:monospace;font-size:12px;color:var(--blue)">${o.result?esc(o.result):'–'}</td>
    <td style="font-size:12px;color:var(--t2)">${fmtDate(o.created_at)}</td>
  </tr>`).join('')||'<tr><td colspan="3" class="empty-td">Aucun achat.</td></tr>';
}

// ── Actions ────────────────────────────────────────────────────────────────────
async function verifyChallenge(slug){
  toast('Vérification…');
  const res=await api('POST',`/api/user/challenge/${slug}/verify`);
  if(res.redirect&&res.url){ startRedirect(slug,res.url,res.delay||20,res.challengeName||'',res.challengeId); return; }
  if(res.screen||res.needsScreen){ openScreenModal(res.challengeId,res.challengeName||''); return; }
  if(res.ok) toast(res.message,'success');
  else if(res.pending) toast(res.message,'pending');
  else {
    toast(res.message,'error');
    // Si follow Twitch non détecté → ouvre la chaîne
    if(res.openUrl) window.open(res.openUrl,'_blank','noopener');
  }
  await loadAll();
}

// Démarrer un challenge screen (avec lien optionnel)
function startScreen(challengeId,name,url){
  if(url){ window.open(url,'_blank','noopener'); }
  openScreenModal(challengeId,name);
}

// ── Redirect + Timer modal ─────────────────────────────────────────────────────
async function startRedirect(slug,url,delay,name,challengeId){
  const res=await api('POST',`/api/user/challenge/${slug}/verify`);
  if(res.ok===false&&!res.redirect&&!res.pending){ toast(res.message,'error'); return; }
  redirectToken=res.token||null;
  redirectDelay=delay||20;
  pendingScreenChallengeId=challengeId||res.challengeId;

  window.open(url,'_blank','noopener');
  showTimerModal(name,delay);
}

function showTimerModal(name,delay){
  el('modal-icon').textContent='🔗';
  el('modal-title').textContent=name;
  el('modal-desc').textContent='Le lien s\'est ouvert. Abonne-toi puis patiente…';
  el('modal-screen-section').classList.add('hidden');
  el('btn-modal-validate').classList.add('hidden');
  show('modal-overlay'); show('modal-timer-wrap');

  let remaining=delay;
  const circ=213;
  el('timer-num').textContent=remaining;
  el('timer-arc').style.strokeDashoffset=0;
  el('timer-arc').style.stroke='var(--blue)';

  redirectTimer=setInterval(()=>{
    remaining--;
    el('timer-num').textContent=remaining;
    el('timer-arc').style.strokeDashoffset=circ-circ*(delay-remaining)/delay;
    if(remaining<=0){
      clearInterval(redirectTimer);
      el('timer-num').textContent='✓';
      el('timer-arc').style.stroke='var(--green)';
      // Valide le timer puis demande screen
      if(redirectToken){ validateRedirectAndShowScreen(); }
      else { showScreenInModal(); }
    }
  },1000);
}

async function validateRedirectAndShowScreen(){
  const res=await api('POST','/api/user/challenge/redirect/validate',{token:redirectToken});
  redirectToken=null;
  // Timer validé = points attribués directement, pas de screen
  toast(res.message, res.ok?'success':'error');
  closeModal();
  await loadAll();
}

function showScreenInModal(){
  hide('modal-timer-wrap');
  el('modal-title').textContent='Envoie ton screenshot';
  el('modal-desc').textContent='Pour valider définitivement, envoie un screenshot prouvant ton abonnement.';
  el('modal-screen-section').classList.remove('hidden');
  el('modal-screen-ch-id').value=pendingScreenChallengeId||'';
}
// Note: showScreenInModal gardé pour usage futur mais non appelé après timer

function openScreenModal(challengeId,name){
  pendingScreenChallengeId=challengeId;
  hide('modal-timer-wrap');
  el('modal-icon').textContent='📸';
  el('modal-title').textContent='Screenshot requis';
  el('modal-desc').textContent=`Envoie un screenshot prouvant que tu as complété "${name}".`;
  el('modal-screen-section').classList.remove('hidden');
  el('modal-screen-ch-id').value=challengeId;
  el('btn-modal-validate').classList.add('hidden');
  show('modal-overlay');
}

async function uploadScreenshot(){
  const input=el('modal-screen-input');
  const challengeId=el('modal-screen-ch-id').value;
  if(!input.files||!input.files[0]) { toast('Sélectionne un fichier image.','error'); return; }
  if(!challengeId) { toast('Erreur: challenge introuvable.','error'); return; }
  const fd=new FormData();
  fd.append('screenshot',input.files[0]);
  el('btn-upload-screen').disabled=true;
  el('btn-upload-screen').textContent='Envoi…';
  try{
    const res=await fetch(`/api/user/challenge/${challengeId}/screenshot`,{method:'POST',body:fd,credentials:'same-origin'});
    const data=await res.json();
    closeModal();
    toast(data.message||'Screenshot envoyé !',data.ok?'success':'pending');
    await loadAll();
  }catch{ toast('Erreur réseau.','error'); }
  el('btn-upload-screen').disabled=false;
  el('btn-upload-screen').textContent='Envoyer le screenshot';
}

function closeModal(){
  clearInterval(redirectTimer);
  hide('modal-overlay');
  el('modal-screen-input').value='';
  el('modal-screen-section').classList.add('hidden');
  if(el('timer-arc')){ el('timer-arc').style.stroke='var(--blue)'; el('timer-arc').style.strokeDashoffset=0; }
}

// ── Epic Games form ────────────────────────────────────────────────────────────
async function saveEpic(){
  const uname=el('epic-username')?.value.trim(), code=el('epic-code')?.value.trim();
  if(!uname){ toast('Pseudo Epic requis.','error'); return; }
  const res=await api('POST','/api/user/epic',{epic_username:uname,epic_creator_code:code});
  toast(res.message,res.ok?'success':'error');
  if(res.ok){ hide('epic-inline'); await loadAll(); }
}

// ── Buy ────────────────────────────────────────────────────────────────────────
async function buyItem(itemId,name){
  if(!confirm(`Acheter "${name}" ?`)) return;
  const res=await api('POST',`/api/user/shop/buy/${itemId}`);
  toast(res.ok?`🛒 ${res.item}${res.result?' → '+res.result:''}`:res.message,res.ok?'success':'error');
  if(res.ok) await loadAll();
}

// ── Watch time ─────────────────────────────────────────────────────────────────
async function toggleLive(){
  const btn=el('btn-live');
  if(!liveActive){
    const res=await api('POST','/api/user/watchtime/start');
    if(!res.ok){ toast(res.message,'error'); return; }
    watchSessionId=res.sessionId; liveActive=true; watchElapsed=0;
    if(btn){ btn.textContent='■ Stop'; btn.style.background='var(--red)'; }
    const statusEl=el('live-status-text');
    if(statusEl) statusEl.textContent='K13 en live — tracker actif';
    watchInterval=setInterval(async()=>{
      watchElapsed+=60;
      await api('POST','/api/user/watchtime/ping',{sessionId:watchSessionId});
      const timerEl=el('live-timer-text');
      if(timerEl) timerEl.textContent=`+${Math.floor(watchElapsed/60)} min cette session`;
    },60000);
    toast('✅ Tracker démarré !','success');
  } else {
    clearInterval(watchInterval);
    await api('POST','/api/user/watchtime/end',{sessionId:watchSessionId});
    liveActive=false; watchElapsed=0;
    if(btn){ btn.textContent='▶ Démarrer'; btn.style.background=''; }
    const timerEl=el('live-timer-text'); if(timerEl) timerEl.textContent='';
    toast('Session enregistrée.','success'); await loadAll();
  }
}

// ── Nav ────────────────────────────────────────────────────────────────────────
function showPage(id){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-link').forEach(b=>b.classList.remove('active'));
  el('page-'+id)?.classList.add('active');
  document.querySelectorAll('.nav-link').forEach(b=>{ if(b.dataset.page===id) b.classList.add('active'); });
}
document.addEventListener('click',e=>{
  const nl=e.target.closest('.nav-link');
  if(nl&&nl.dataset.page) showPage(nl.dataset.page);
  const ct=e.target.closest('.cat-tab');
  if(ct){ currentFilter=ct.dataset.cat; document.querySelectorAll('.cat-tab').forEach(t=>t.classList.remove('active')); ct.classList.add('active'); renderChallengesPage(); }
});

// ── Helpers ────────────────────────────────────────────────────────────────────
function el(id){return document.getElementById(id)}
function show(id){el(id)?.classList.remove('hidden')}
function hide(id){el(id)?.classList.add('hidden')}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function fmtDate(d){return d?new Date(d).toLocaleDateString('fr-FR'):'–'}
let toastT;
function toast(msg,type='info'){
  const t=el('toast'); t.textContent=msg; t.className='toast show '+(type||'info');
  clearTimeout(toastT); toastT=setTimeout(()=>t.classList.remove('show'),4000);
}
async function api(method,url,body){
  try{ const o={method,headers:{'Content-Type':'application/json'},credentials:'same-origin'}; if(body) o.body=JSON.stringify(body); return await(await fetch(url,o)).json(); }
  catch{ return{ok:false,message:'Erreur réseau.'}; }
}
function logout(){ api('POST','/auth/logout').then(()=>location.reload()); }
