'use strict';
let allUsers=[],pendingCode=null;

window.addEventListener('DOMContentLoaded',async()=>{
  const me=await api('GET','/auth/me');
  if(me.ok&&me.isAdmin){show('admin-app');hide('admin-auth');loadOverview();}
});

async function adminLogin(){
  const pwd=el('admin-pwd').value;
  const res=await api('POST','/auth/admin/login',{password:pwd});
  if(!res.ok){el('admin-err').textContent=res.message;return;}
  show('admin-app');hide('admin-auth');loadOverview();
}

function adminPage(id){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
  el('admin-page-'+id).classList.add('active');
  const pages=['overview','stats','users','codes','challenges','shop','ranking','pending'];
  document.querySelectorAll('.nav-btn')[pages.indexOf(id)]?.classList.add('active');
  ({overview:loadOverview,users:loadUsers,codes:loadCodes,challenges:loadChallenges,shop:loadShop,pending:loadPending,ranking:loadRanking})[id]?.();
}

// ── Overview ───────────────────────────────────────────────────────────────────
async function loadOverview(){
  const[stats,users]=await Promise.all([api('GET','/api/admin/stats'),api('GET','/api/admin/users')]);
  if(stats.ok){
    el('a-members').textContent=stats.totalUsers;
    el('a-codes').textContent=stats.totalCodes;
    el('a-used').textContent=stats.usedCodes;
    el('a-pending').textContent=stats.pendingVerifs;
    el('pending-badge').textContent=stats.pendingVerifs;
  }
  if(users.ok){
    el('overview-tbl').innerHTML=users.users.slice(0,20).map(u=>`<tr>
      <td><strong>${esc(u.username)}</strong><br><small style="color:var(--t2)">${esc(u.discord_username||'')}</small></td>
      <td style="font-weight:700;color:var(--blue)">${u.points}</td>
      <td><span class="pill ${u.rank||'bronze'}">${cap(u.rank||'bronze')}</span></td>
      <td>${u.discord_username?`<span style="color:var(--discord)">✓</span>`:'–'}</td>
      <td>${u.twitch_login?`<span style="color:var(--twitch)">@${esc(u.twitch_login)}</span>`:'–'}</td>
      <td>${u.twitter_login?`<span style="color:var(--twitter)">@${esc(u.twitter_login)}</span>`:'–'}</td>
      <td>${u.tiktok_username?`<span style="color:#111">@${esc(u.tiktok_username)}</span>`:'–'}</td>
      <td>${u.discord_messages||0}</td>
      <td>${fmtTime(u.discord_vocal||0)}</td>
      <td>${fmtTime(u.twitch_watch_seconds||0)}</td>
      <td>${u.challenges_done||0}/${u.challenges_total||0}</td>
      <td><button class="btn-sm" onclick="loadUserDetail(${u.id})">Détail</button></td>
    </tr>`).join('')||'<tr><td colspan="12" class="empty-td">Aucun membre.</td></tr>';
  }
}

// ── Users ──────────────────────────────────────────────────────────────────────
async function loadUsers(){
  const res=await api('GET','/api/admin/users');
  if(!res.ok) return;
  allUsers=res.users; renderUsers(allUsers);
}
function renderUsers(users){
  el('users-tbl').innerHTML=users.map(u=>`<tr>
    <td><strong>${esc(u.username)}</strong></td>
    <td style="font-weight:700;color:var(--blue)">${u.points}</td>
    <td><span class="pill ${u.rank||'bronze'}">${cap(u.rank)}</span></td>
    <td style="font-size:12px">${[u.discord_username?'💬':'',u.twitch_login?'🟣':'',u.twitter_login?'𝕏':'',u.tiktok_username?'🎵':''].filter(Boolean).join(' ')}</td>
    <td>${u.challenges_done||0}/${u.challenges_total||0}</td>
    <td>${fmtTime(u.twitch_watch_seconds||0)}</td>
    <td>${u.discord_messages||0}</td>
    <td>${fmtTime(u.discord_vocal||0)}</td>
    <td>
      <button class="btn-sm" onclick="loadUserDetail(${u.id})">Détail</button>
      <button class="btn-sm danger" onclick="adjustPoints(${u.id},'${esc(u.username)}')">±Pts</button>
      <button class="btn-sm danger" onclick="resetUserChallenges(${u.id},'${esc(u.username)}')">Reset</button>
    </td>
  </tr>`).join('')||'<tr><td colspan="9" class="empty-td">Aucun membre.</td></tr>';
}
function filterUsers(){ const q=el('user-search').value.toLowerCase(); renderUsers(allUsers.filter(u=>(u.username||'').toLowerCase().includes(q)||(u.discord_username||'').toLowerCase().includes(q))); }

async function loadUserDetail(id){
  const res=await api('GET',`/api/admin/users/${id}`);
  if(!res.ok) return;
  const u=res.user;
  show('user-detail');
  el('detail-title').textContent=`${u.discord_username||u.username} — Détail complet`;
  el('detail-chips').innerHTML=[
    chip('Points',u.points),chip('Rang',cap(u.rank||'bronze')),
    chip('Discord',u.discord_username?'@'+u.discord_username:'–'),
    chip('Twitch',u.twitch_login?'@'+u.twitch_login:'–'),
    chip('Twitter',u.twitter_login?'@'+u.twitter_login:'–'),
    chip('TikTok',u.tiktok_username?'@'+u.tiktok_username:'–'),
    chip('Epic',u.epic_username||'–'),
    chip('Inscrit',fmtDate(u.created_at)),
    chip('Vu le',fmtDate(u.last_seen)),
  ].join('');
  el('detail-actions').innerHTML=`
    <button class="btn-sm" onclick="adjustPoints(${u.id},'${esc(u.discord_username||u.username)}')">± Ajuster les points</button>
  `;
  el('detail-challenges').innerHTML=res.challenges.map(c=>{
    const s=c.status;
    const pill=!s?'<span class="pill used">Non fait</span>':s.verified===1?'<span class="pill active">✓ Validé</span>':'<span class="pill pending">⏳ En attente</span>';
    const actions=`
      <button class="btn-sm" onclick="adminValidateCh(${u.id},${c.id},'${esc(c.name)}')">✓</button>
      <button class="btn-sm danger" onclick="adminRemoveCh(${u.id},${c.id},'${esc(c.name)}')">✗</button>`;
    return `<tr><td>${esc(c.name)}</td><td><span class="plat-chip ${c.platform}">${cap(c.platform)}</span></td><td style="font-weight:600;color:var(--blue)">+${c.points} pts</td><td>${pill}</td><td>${actions}</td></tr>`;
  }).join('');
  el('detail-section').scrollIntoView({behavior:'smooth'});
}

async function adjustPoints(userId,username){
  const input=prompt(`Ajuster les points de ${username} :\n+50 pour ajouter, -50 pour retirer`);
  if(!input) return;
  const delta=parseInt(input);
  if(isNaN(delta)) return;
  const res=await api('POST',`/api/admin/users/${userId}/points`,{delta});
  toast(res.message,res.ok?'success':'error');
  if(res.ok){loadUsers();if(el('user-detail').style.display!=='none')loadUserDetail(userId);}
}

async function adminValidateCh(userId,challengeId,name){
  const res=await api('POST',`/api/admin/users/${userId}/challenge/${challengeId}/validate`);
  toast(res.message,res.ok?'success':'error');
  if(res.ok) loadUserDetail(userId);
}
async function adminRemoveCh(userId,challengeId,name){
  if(!confirm(`Retirer la validation de "${name}" pour cet utilisateur ?`)) return;
  const res=await api('DELETE',`/api/admin/users/${userId}/challenge/${challengeId}`);
  toast(res.message,res.ok?'success':'error');
  if(res.ok) loadUserDetail(userId);
}

// ── Codes ──────────────────────────────────────────────────────────────────────
async function loadCodes(){
  const res=await api('GET','/api/admin/codes');
  if(!res.ok) return;
  el('codes-tbl').innerHTML=res.codes.map(c=>{
    const exp=new Date(c.expires_at),status=c.used?'used':exp<new Date()?'expired':'active';
    return `<tr>
      <td style="font-family:monospace;font-weight:600">${esc(c.code)}</td>
      <td>${esc(c.username)}</td><td style="font-weight:700;color:var(--blue)">-${c.discount}%</td>
      <td style="font-size:11px">${fmtDate(c.created_at)}</td>
      <td style="font-size:11px">${fmtDate(c.expires_at)}</td>
      <td><span class="pill ${status}">${status==='used'?'Utilisé':status==='expired'?'Expiré':'Actif'}</span></td>
    </tr>`;
  }).join('')||'<tr><td colspan="6" class="empty-td">Aucun code.</td></tr>';
}
async function verifyCode(){
  const code=el('verify-input').value.trim().toUpperCase();
  const res=await api('GET',`/api/admin/codes/verify/${encodeURIComponent(code)}`);
  const box=el('verify-result'),mark=el('mark-used');
  box.style.display='block'; box.className='verify-result '+(res.valid?'valid':'invalid');
  if(res.valid){ box.innerHTML=`✓ Valide — <strong>${esc(res.code.username)}</strong> · -${res.code.discount}% · Expire ${fmtDate(res.code.expires_at)}`; pendingCode=code; show('mark-used'); }
  else{ box.textContent='✗ '+res.message; pendingCode=null; hide('mark-used'); }
}
async function markUsed(){
  if(!pendingCode) return;
  const res=await api('POST',`/api/admin/codes/${encodeURIComponent(pendingCode)}/use`);
  toast(res.ok?'Code marqué utilisé.':res.message,res.ok?'success':'error');
  el('verify-result').style.display='none'; hide('mark-used'); pendingCode=null; loadCodes();
}

// ── Challenges ─────────────────────────────────────────────────────────────────
async function loadChallenges(){
  const res=await api('GET','/api/admin/challenges');
  if(!res.ok) return;
  // Filter by platform if selected
  const filterPlat=el('ch-filter-plat')?.value||'all';
  const filteredChs=filterPlat==='all'?res.challenges:res.challenges.filter(c=>c.platform===filterPlat);
  el('challenges-tbl').innerHTML=filteredChs.map(c=>`<tr>
    <td><span class="plat-chip ${c.platform}">${cap(c.platform)}</span></td>
    <td><strong>${esc(c.name)}</strong><br><small style="color:var(--t2)">${c.type}${c.required_value?' · seuil:'+c.required_value:''}</small></td>
    <td style="font-weight:700;color:var(--blue)">${c.points}</td>
    <td style="font-size:12px">${catLabel(c.category)}</td>
    <td style="font-size:12px;color:var(--t2)">${c.repeat_seconds?fmtTime(c.repeat_seconds):'–'}</td>
    <td><span class="pill ${c.active?'active':'used'}">${c.active?'Actif':'Inactif'}</span></td>
    <td>
      <button class="btn-sm" onclick="editChallenge(${c.id})">✏️ Éditer</button>
      <button class="btn-sm danger" onclick="toggleCh(${c.id},${c.active?0:1})">${c.active?'Désact.':'Activer'}</button>
      <button class="btn-sm" style="border-color:var(--amber);color:var(--amber)" onclick="resetAllUsersChallenge(${c.id},'${esc(c.name)}')">↺ Reset tous</button>
    </td>
  </tr>`).join('')||'<tr><td colspan="7" class="empty-td">Aucun challenge.</td></tr>';
}

function toggleTypeFields(){
  const t=el('nc-type').value;
  el('nc-value-group').classList.toggle('hidden',!['watchtime','messages','vocal'].includes(t));
  el('nc-redirect-group').classList.toggle('hidden',t!=='redirect');
}

async function createChallenge(){
  let extra={};
  try{extra=JSON.parse(el('nc-extra').value||'{}');}catch{}
  const body={
    platform:el('nc-platform').value, slug:el('nc-slug').value.trim(),
    name:el('nc-name').value.trim(), description:el('nc-desc').value.trim(),
    points:parseInt(el('nc-pts').value)||0, type:el('nc-type').value,
    required_value:parseInt(el('nc-value').value)||0,
    repeat_seconds:parseInt(el('nc-repeat').value)||0,
    redirect_url:el('nc-redirect-url').value.trim()||null,
    redirect_delay:parseInt(el('nc-redirect-delay').value)||15,
    category:el('nc-category').value, extra,
  };
  if(!body.slug||!body.name||!body.points){toast('Remplis tous les champs requis.','error');return;}
  const res=await api('POST','/api/admin/challenges',body);
  toast(res.ok?'✅ Challenge créé !':res.message,res.ok?'success':'error');
  if(res.ok) loadChallenges();
}

async function editChallenge(id){
  const res=await api('GET','/api/admin/challenges');
  const ch=res.challenges?.find(c=>c.id===id);
  if(!ch) return;

  // Crée un modal d'édition inline
  const existing=document.getElementById('edit-ch-modal');
  if(existing) existing.remove();

  const modal=document.createElement('div');
  modal.id='edit-ch-modal';
  modal.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:200;backdrop-filter:blur(2px)';
  modal.innerHTML=`
    <div style="background:#fff;border-radius:16px;padding:28px;width:480px;max-width:95vw;max-height:90vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.15)">
      <div style="font-size:17px;font-weight:700;margin-bottom:18px">✏️ Modifier "${esc(ch.name)}"</div>
      <div class="form-group"><label class="form-lbl">Nom</label><input class="form-input" id="e-name" value="${esc(ch.name)}"/></div>
      <div class="form-group"><label class="form-lbl">Description</label><input class="form-input" id="e-desc" value="${esc(ch.description)}"/></div>
      <div class="form-group"><label class="form-lbl">Points</label><input class="form-input" id="e-pts" type="number" value="${ch.points}"/></div>
      <div class="form-group"><label class="form-lbl">Type</label>
        <select class="form-input" id="e-type">
          <option value="redirect" ${ch.type==='redirect'?'selected':''}>🔗 Lien + timer</option>
          <option value="screen"   ${ch.type==='screen'?'selected':''}>📸 Screenshot</option>
          <option value="watchtime"${ch.type==='watchtime'?'selected':''}>📺 Watch time</option>
          <option value="messages" ${ch.type==='messages'?'selected':''}>💬 Messages Discord</option>
          <option value="vocal"    ${ch.type==='vocal'?'selected':''}>🎙️ Vocal Discord</option>
          <option value="join"     ${ch.type==='join'?'selected':''}>🚪 Rejoindre Discord</option>
          <option value="follow"   ${ch.type==='follow'?'selected':''}>✅ Follow (API auto)</option>
        </select>
      </div>
      <div class="form-group"><label class="form-lbl">Catégorie</label>
        <select class="form-input" id="e-cat">
          <option value="permanent"${ch.category==='permanent'?'selected':''}>♾️ Permanent</option>
          <option value="daily"    ${ch.category==='daily'?'selected':''}>🔄 Quotidien</option>
          <option value="weekly"   ${ch.category==='weekly'?'selected':''}>📅 Hebdo</option>
          <option value="monthly"  ${ch.category==='monthly'?'selected':''}>📆 Mensuel</option>
          <option value="contest"  ${ch.category==='contest'?'selected':''}>🏆 Concours</option>
        </select>
      </div>
      <div class="form-group"><label class="form-lbl">Valeur seuil (pour watchtime/messages/vocal)</label><input class="form-input" id="e-val" type="number" value="${ch.required_value||0}"/></div>
      <div class="form-group"><label class="form-lbl">Répétition en secondes (0 = jamais)</label><input class="form-input" id="e-repeat" type="number" value="${ch.repeat_seconds||0}"/></div>
      <div class="form-group"><label class="form-lbl">URL de redirection</label><input class="form-input" id="e-url" value="${esc(ch.redirect_url||'')}"/></div>
      <div class="form-group"><label class="form-lbl">Délai timer (secondes)</label><input class="form-input" id="e-delay" type="number" value="${ch.redirect_delay||20}"/></div>
      <div class="form-group"><label class="form-lbl">Actif</label>
        <select class="form-input" id="e-active">
          <option value="1" ${ch.active?'selected':''}>Oui</option>
          <option value="0" ${!ch.active?'selected':''}>Non</option>
        </select>
      </div>
      <div style="display:flex;gap:8px;margin-top:6px">
        <button class="form-btn" onclick="saveEditChallenge(${id})" style="flex:1">Enregistrer</button>
        <button class="form-btn" onclick="document.getElementById('edit-ch-modal').remove()" style="background:var(--t2)">Annuler</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

async function saveEditChallenge(id){
  const body={
    name:           el('e-name').value.trim(),
    description:    el('e-desc').value.trim(),
    points:         parseInt(el('e-pts').value)||0,
    type:           el('e-type').value,
    category:       el('e-cat').value,
    required_value: parseInt(el('e-val').value)||0,
    repeat_seconds: parseInt(el('e-repeat').value)||0,
    redirect_url:   el('e-url').value.trim()||null,
    redirect_delay: parseInt(el('e-delay').value)||20,
    active:         parseInt(el('e-active').value),
  };
  const res=await api('PATCH',`/api/admin/challenges/${id}`,body);
  toast(res.ok?'✅ Challenge mis à jour !':res.message,res.ok?'success':'error');
  document.getElementById('edit-ch-modal')?.remove();
  if(res.ok) loadChallenges();
}

async function toggleCh(id,active){ await api('PATCH',`/api/admin/challenges/${id}`,{active}); loadChallenges(); }
async function deleteChallengeHard(id,name){
  if(!confirm(`Supprimer définitivement "${name}" ? Les données des utilisateurs seront aussi supprimées.`)) return;
  const res=await api('DELETE',`/api/admin/challenges/${id}?hard=1`);
  toast(res.ok?'Supprimé.':res.message,res.ok?'success':'error');
  if(res.ok) loadChallenges();
}

// ── Shop ───────────────────────────────────────────────────────────────────────
async function loadShop(){
  const[items,orders]=await Promise.all([api('GET','/api/admin/shop'),api('GET','/api/admin/orders')]);
  if(items.ok) el('shop-tbl').innerHTML=items.items.map(i=>`<tr>
    <td>${esc(i.name)}</td><td>${i.type}</td>
    <td style="font-weight:700;color:var(--blue)">${i.cost_points} pts</td>
    <td>${i.stock===-1?'∞':i.stock}</td>
    <td><span class="pill ${i.active?'active':'used'}">${i.active?'Actif':'Inactif'}</span></td>
    <td>
      <button class="btn-sm danger" onclick="toggleShop(${i.id},${i.active?0:1})">${i.active?'Désact.':'Activer'}</button>
      <button class="btn-sm danger" onclick="deleteShopHard(${i.id},'${esc(i.name)}')">🗑️</button>
    </td>
  </tr>`).join('')||'<tr><td colspan="6" class="empty-td">Aucun article.</td></tr>';
  if(orders.ok) el('orders-tbl').innerHTML=orders.orders.map(o=>`<tr>
    <td>${esc(o.username)}</td><td>${esc(o.item_name)}</td>
    <td style="font-family:monospace;font-size:12px">${o.result||'–'}</td>
    <td style="font-size:11px">${fmtDate(o.created_at)}</td>
    <td><span class="pill active">${o.status}</span></td>
  </tr>`).join('')||'<tr><td colspan="5" class="empty-td">Aucune commande.</td></tr>';
}
function updateShopTypeFields(){
  const t=el('si-type').value;
  el('si-role-group').style.display=t==='discord_role'?'':'none';
  el('si-promo-group').style.display=t==='promo_code'?'':'none';
  el('si-extra-group').style.display=t==='product'?'':'none';
}

async function addShopItem(){
  const type=el('si-type').value;
  let extra={};
  if(type==='discord_role'){
    const roleId=el('si-role-id').value.trim();
    if(!roleId){toast('ID du rôle Discord requis.','error');return;}
    extra={role_id:roleId};
  } else if(type==='promo_code'){
    const discount=parseInt(el('si-discount').value)||5;
    const tier=el('si-tier').value.trim()||'bronze';
    extra={discount,tier};
  } else {
    try{extra=JSON.parse(el('si-extra').value||'{}');}catch{toast('JSON invalide','error');return;}
  }
  const body={name:el('si-name').value.trim(),description:el('si-desc').value.trim(),type,cost_points:parseInt(el('si-pts').value)||0,stock:parseInt(el('si-stock').value)||-1,extra};
  const res=await api('POST','/api/admin/shop',body);
  toast(res.ok?'✅ Article ajouté !':res.message,res.ok?'success':'error');
  if(res.ok) loadShop();
}
async function toggleShop(id,active){ await api('PATCH',`/api/admin/shop/${id}`,{active}); loadShop(); }
async function deleteShopHard(id,name){
  if(!confirm(`Supprimer définitivement "${name}" ? Cette action est irréversible.`)) return;
  const res=await api('DELETE',`/api/admin/shop/${id}?hard=1`);
  toast(res.ok?'Supprimé.':res.message,res.ok?'success':'error');
  if(res.ok) loadShop();
}

// ── Pending ────────────────────────────────────────────────────────────────────
async function loadPending(){
  const res=await api('GET','/api/admin/pending');
  if(!res.ok) return;
  el('pending-badge').textContent=res.pending.length;
  el('pending-tbl').innerHTML=res.pending.map(p=>{
    const hasScreen=!!p.screenshot_path;
    const screenHtml=hasScreen
      ?`<a href="${esc(p.screenshot_path)}" target="_blank"><img src="${esc(p.screenshot_path)}" style="width:60px;height:40px;object-fit:cover;border-radius:4px;cursor:pointer;border:1px solid var(--border)" alt="screen"/></a>`
      :'<span style="color:var(--t3);font-size:11px">Pas de screen</span>';
    return `<tr>
      <td><strong>${esc(p.username)}</strong><br><small style="color:var(--t2)">${esc(p.discord_username||'')}</small></td>
      <td>${esc(p.challenge_name)}<br><span style="font-size:11px;color:var(--blue)">+${p.points} pts</span></td>
      <td><span class="plat-chip ${p.platform}">${cap(p.platform)}</span></td>
      <td>${screenHtml}</td>
      <td style="font-size:11px;color:var(--t2)">${fmtDate(p.completed_at)}</td>
      <td>
        <button class="btn-sm" onclick="approve(${p.id})">✓ Valider</button>
        <button class="btn-sm danger" onclick="reject(${p.id})">✗ Rejeter</button>
      </td>
    </tr>`;
  }).join('')||'<tr><td colspan="6" class="empty-td">Aucune validation en attente ✓</td></tr>';
}
async function approve(id){ const r=await api('POST',`/api/admin/pending/${id}/approve`); toast(r.message,r.ok?'success':'error'); loadPending(); }
async function reject(id){ const r=await api('POST',`/api/admin/pending/${id}/reject`); toast(r.message,r.ok?'success':'error'); loadPending(); }

// ── Reset challenges ───────────────────────────────────────────────────────────
async function resetUserChallenge(userId,challengeId,chName,username){
  if(!confirm(`Réinitialiser "${chName}" pour ${username} ?\nCela supprime la progression et retire les points.`)) return;
  const r=await api('POST',`/api/admin/users/${userId}/challenge/${challengeId}/reset`);
  toast(r.message,r.ok?'success':'error');
  if(r.ok) loadUserDetail(userId);
}

async function resetAllUserChallenges(userId,username){
  if(!confirm(`⚠️ Remettre TOUS les défis de ${username} à zéro ?\nPoints remis à 0, toutes progressions effacées.`)) return;
  const r=await api('POST',`/api/admin/users/${userId}/reset-all`);
  toast(r.message,r.ok?'success':'error');
  if(r.ok){ loadUsers(); loadUserDetail(userId); }
}

async function resetAllUsersChallenge(challengeId,chName){
  if(!confirm(`⚠️ Réinitialiser "${chName}" pour TOUS les membres ?\nPoints retirés, progressions effacées.`)) return;
  const r=await api('POST','/api/admin/reset-all-users',{challengeId});
  toast(r.message,r.ok?'success':'error');
  if(r.ok) loadChallenges();
}

async function resetEverything(){
  if(!prompt('Tape CONFIRMER pour remettre le programme à zéro pour TOUT le monde :')?.trim().toUpperCase()==='CONFIRMER') return;
  if(!confirm('⚠️ DERNIÈRE CONFIRMATION : remettre TOUS les points et défis à 0 ?')) return;
  const r=await api('POST','/api/admin/reset-all-users',{});
  toast(r.message,r.ok?'success':'error');
}



async function loadStats(){
  const res=await api('GET','/api/admin/stats/detailed');
  if(!res.ok) return;
  el('ds-pts-total').textContent=(res.totalPoints||0).toLocaleString('fr-FR');
  el('ds-active').textContent=res.activeUsers7d||0;
  el('ds-ch-total').textContent=res.totalCompleted||0;
  el('ds-conv').textContent=(res.convRate||0)+'%';

  // Rang chart (barres simples)
  const rankColors={gold:'#EAB308',silver:'#94A3B8',bronze:'#CD7C32'};
  const rankLabels={gold:'🥇 Gold',silver:'🥈 Silver',bronze:'🥉 Bronze'};
  const total=res.rankDist.reduce((a,r)=>a+r.c,0)||1;
  el('rank-chart').innerHTML=res.rankDist.map(r=>`
    <div style="margin-bottom:8px">
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px">
        <span>${rankLabels[r.rank]||r.rank}</span><span style="font-weight:600">${r.c}</span>
      </div>
      <div style="background:var(--border);border-radius:4px;height:8px">
        <div style="background:${rankColors[r.rank]||'#6B7280'};border-radius:4px;height:8px;width:${Math.round(r.c/total*100)}%;transition:width .4s"></div>
      </div>
    </div>`).join('');

  el('top-challenges-tbl').innerHTML=res.topChallenges.map(c=>`<tr>
    <td><span class="plat-chip ${c.platform}">${cap(c.platform)}</span> ${esc(c.name)}</td>
    <td style="font-weight:700;color:var(--blue)">${c.completions}</td>
  </tr>`).join('')||'<tr><td colspan="2" class="empty-td">–</td></tr>';

  el('discord-activity-tbl').innerHTML=res.discordActivity.map(d=>`<tr>
    <td><strong>${esc(d.discord_username||d.username)}</strong></td>
    <td>${d.msgs7d||0}</td>
    <td>${fmtTime(d.vocal7d||0)}</td>
    <td style="font-size:11px;color:var(--t2)">${d.last_activity||'–'}</td>
  </tr>`).join('')||'<tr><td colspan="4" class="empty-td">Aucune activité.</td></tr>';

  el('new-users-tbl').innerHTML=res.newUsers.map(u=>`<tr>
    <td><strong>${esc(u.username)}</strong></td>
    <td style="color:var(--discord)">${u.discord_username?'@'+esc(u.discord_username):'–'}</td>
    <td style="color:var(--twitch)">${u.twitch_login?'@'+esc(u.twitch_login):'–'}</td>
    <td style="font-weight:600;color:var(--blue)">${u.points}</td>
    <td style="font-size:11px;color:var(--t2)">${fmtDate(u.created_at)}</td>
  </tr>`).join('')||'<tr><td colspan="5" class="empty-td">Aucun nouveau membre.</td></tr>';

  // Intégrations status
  const intBox=document.getElementById('integration-status'); if(!intBox) return;
  if(intBox) intBox.innerHTML=`
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:16px">
      <div class="stat-card" style="flex:1;min-width:160px">
        <div class="stat-lbl">StreamElements (watchtime auto)</div>
        <div style="font-size:14px;font-weight:600;color:${res.seConfigured?'var(--green)':'var(--red)'}">${res.seConfigured?'✅ Connecté':'❌ Non configuré'}</div>
      </div>
      <div class="stat-card" style="flex:1;min-width:160px">
        <div class="stat-lbl">Stripe (codes promo)</div>
        <div style="font-size:14px;font-weight:600;color:${res.stripeConfigured?'var(--green)':'var(--red)'}">${res.stripeConfigured?'✅ Connecté':'❌ Non configuré (codes locaux)'}</div>
      </div>
    </div>`;
}


async function resetUserChallenges(userId, username){
  const withPts=confirm(`Réinitialiser TOUS les défis de ${username} ?\nOK = défis seulement\nAnnuler pour annuler`);
  if(withPts===null) return;
  const res=await api('POST',`/api/admin/users/${userId}/reset`,{resetPoints:false});
  toast(res.message,res.ok?'success':'error');
  if(res.ok) loadUsers();
}


async function resetInvites(userId, username){
  const msg = userId
    ? `Réinitialiser les invitations de ${username} ?`
    : 'Réinitialiser les invitations de TOUS les membres ?';
  if(!confirm(msg)) return;
  const res = await api('POST', '/api/admin/reset-invites', userId ? { userId } : {});
  toast(res.message, res.ok ? 'success' : 'error');
  if(res.ok && !userId) loadOverview();
}

async function resetAll(){
  const confirm1=prompt('⚠️ ATTENTION : Ceci réinitialisera les défis de TOUS les membres.\nTape CONFIRMER pour continuer :');
  if(confirm1!=='CONFIRMER'){ toast('Annulé.'); return; }
  const withPts=confirm('Remettre aussi les points à 0 ?');
  const res=await api('POST','/api/admin/reset-all',{confirmText:'CONFIRMER',resetPoints:withPts});
  toast(res.message,res.ok?'success':'error');
}

// ── Live Ranking ───────────────────────────────────────────────────────────────
async function loadRanking(){
  const res=await api('GET','/api/admin/live-ranking');
  if(!res.ok) return;
  el('ranking-tbl').innerHTML=res.ranking.map((r,i)=>`<tr>
    <td style="font-weight:700;color:var(--t2)">${i+1}</td>
    <td><strong>${esc(r.discord_username||r.username)}</strong></td>
    <td style="color:var(--twitch)">${r.twitch_login?'@'+esc(r.twitch_login):'–'}</td>
    <td style="font-weight:700;color:var(--blue)">${fmtTime(r.total_seconds)}</td>
    <td style="color:var(--t2)">${r.session_count} sessions</td>
    <td style="font-size:11px;color:var(--t2)">${fmtDate(r.last_session)}</td>
  </tr>`).join('')||'<tr><td colspan="6" class="empty-td">Aucune donnée de visionnage.</td></tr>';
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function catLabel(c){ return{daily:'🔄 Quotidien',weekly:'📅 Hebdo',monthly:'📆 Mensuel',permanent:'♾️ Permanent',contest:'🏆 Concours'}[c]||c||'–'; }
function chip(lbl,val){ return `<div class="detail-chip"><div class="chip-lbl">${lbl}</div><div class="chip-val">${esc(String(val||'–'))}</div></div>`; }
function cap(s){ return s?s.charAt(0).toUpperCase()+s.slice(1):''; }
function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtDate(d){ return d?new Date(d).toLocaleDateString('fr-FR'):'–'; }
function fmtTime(s){ if(!s) return '0h'; const h=Math.floor(s/3600),m=Math.floor((s%3600)/60); return h?`${h}h${m?m+'m':''}`:m?`${m}min`:'0h'; }
function el(id){ return document.getElementById(id); }
function show(id){ el(id)?.classList.remove('hidden'); }
function hide(id){ el(id)?.classList.add('hidden'); }
let toastT;
function toast(msg,type='info'){
  const t=el('toast'); t.textContent=msg; t.className='toast show '+(type||'info');
  clearTimeout(toastT); toastT=setTimeout(()=>t.classList.remove('show'),3500);
}
async function api(method,url,body){
  try{ const o={method,headers:{'Content-Type':'application/json'},credentials:'same-origin'}; if(body) o.body=JSON.stringify(body); return await(await fetch(url,o)).json(); }
  catch{ return{ok:false,message:'Erreur réseau.'}; }
}
