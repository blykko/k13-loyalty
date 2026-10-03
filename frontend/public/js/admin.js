'use strict';
let allUsers = [], allChallenges = [], allItems = [], allCodes = [], currentPage = 'overview';

const PLATFORMS = { discord: 'Discord', twitch: 'Twitch', twitter: 'Twitter/X', tiktok: 'TikTok', instagram: 'Instagram', epic: 'Epic Games' };
const CH_TYPES = {
  redirect:  '🔗 Lien + timer',
  screen:    '📸 Screenshot',
  watchtime: '📺 Visionnage Twitch (auto)',
  messages:  '💬 Messages Discord (auto)',
  vocal:     '🎙️ Vocal Discord (auto)',
  invite:    '🎟️ Invitations Discord (auto)',
  join:      '🚪 Rejoindre le Discord',
  follow:    '✅ Follow Twitch (API)',
  tw_like:    '❤️ X : liker un tweet',
  tw_retweet: '🔁 X : retweeter un tweet',
  tw_reply:   '💬 X : commenter un tweet',
  tw_follow:  '➕ X : s\'abonner au compte',
};
const CATEGORIES = { permanent: '♾️ Permanent', daily: '🔄 Quotidien', weekly: '📅 Hebdo', monthly: '📆 Mensuel', contest: '🏆 Concours' };
const CAT_REPEAT = { daily: 86400, weekly: 604800, monthly: 2592000 };
const SHOP_TYPES = { promo_code: '🎟️ Code promo', discord_role: '🏅 Rôle Discord', product: '📦 Produit' };

// ── Auth ───────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  syncDarkBtn();
  const me = await api('GET', '/auth/me');
  if (me.ok && me.isAdmin) enterApp();
});
el('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const res = await api('POST', '/auth/admin/login', { password: el('admin-pwd').value });
  if (!res.ok) { el('admin-err').textContent = res.message; return; }
  enterApp();
});
function enterApp() {
  hide('admin-auth'); show('admin-app');
  adminPage(location.hash.slice(1) || 'overview', false);
  refreshBadges();
  setInterval(refreshBadges, 60000);
}
el('btn-logout').addEventListener('click', () => api('POST', '/auth/logout').then(() => location.reload()));
el('btn-dark').addEventListener('click', () => {
  const d = document.documentElement.classList.toggle('dark');
  try { localStorage.setItem('k13-dark', d ? '1' : '0'); } catch {}
  syncDarkBtn();
});
function syncDarkBtn() { el('btn-dark').textContent = document.documentElement.classList.contains('dark') ? '☀️' : '🌙'; }

// ── Navigation ─────────────────────────────────────────────────────────────────
const LOADERS = { overview: loadOverview, pending: loadPending, users: loadUsers, challenges: loadChallenges, shop: loadShop, codes: loadCodes, ranking: loadRanking, settings: () => {} };
function adminPage(id, push = true) {
  if (!LOADERS[id]) id = 'overview';
  currentPage = id;
  document.querySelectorAll('.apage').forEach(p => p.classList.toggle('active', p.id === 'page-' + id));
  document.querySelectorAll('.nav-link').forEach(b => b.classList.toggle('active', b.dataset.page === id));
  if (push) history.replaceState({}, '', '#' + id);
  LOADERS[id]();
}
document.addEventListener('click', e => {
  const p = e.target.closest('[data-page]');
  if (p) adminPage(p.dataset.page);
});

async function refreshBadges() {
  const s = await api('GET', '/api/admin/stats');
  if (s.status === 403) return location.reload();
  if (!s.ok) return;
  setBadge('pending-badge', s.pendingVerifs);
  setBadge('orders-badge', s.pendingOrders);
}
function setBadge(id, n) { el(id).textContent = n; el(id).classList.toggle('hidden', !n); }

// ── Tableau de bord ────────────────────────────────────────────────────────────
async function loadOverview() {
  const [s, d] = await Promise.all([api('GET', '/api/admin/stats'), api('GET', '/api/admin/stats/detailed')]);
  if (s.ok) {
    el('k-members').textContent = fmtNum(s.totalUsers);
    el('k-codes').textContent = `${s.usedCodes} / ${s.totalCodes}`;
    el('k-pending').textContent = s.pendingVerifs;
    el('k-pending-card').classList.toggle('hidden', !s.pendingVerifs);
    el('k-orders').textContent = s.pendingOrders;
    el('k-orders-card').classList.toggle('hidden', !s.pendingOrders);
    setBadge('pending-badge', s.pendingVerifs);
    setBadge('orders-badge', s.pendingOrders);
  }
  if (!d.ok) return;
  el('k-active').textContent = fmtNum(d.activeUsers7d);
  el('k-done').textContent = fmtNum(d.totalCompleted);
  el('k-pts').textContent = fmtNum(d.totalPoints);
  el('k-conv').textContent = d.convRate + '%';
  el('k-daily').textContent = fmtNum(d.dailyToday);
  el('k-games').textContent = `${d.games.players} · ${d.games.house >= 0 ? '+' : ''}${fmtNum(d.games.house)} pts`;
  const st = (ok, label) => `<span class="status ${ok ? 'ok' : 'ko'}">${ok ? '✓' : '✗'} ${label}</span>`;
  el('integration-status').innerHTML = st(d.botConfigured, 'Bot Discord') + st(d.adminChannelConfigured, 'Salon admin Discord (validations)')
    + st(d.twitterConfigured, 'Liaison X') + st(d.seConfigured, 'StreamElements (visionnage auto)') + st(d.stripeConfigured, 'Stripe (codes promo)');

  const colors = { gold: '#EAB308', silver: '#94A3B8', bronze: '#CD7C32' };
  const total = d.rankDist.reduce((a, r) => a + r.c, 0) || 1;
  el('rank-chart').innerHTML = d.rankDist.map(r => `
    <div style="margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px"><span>${rankLabel(r.rank)}</span><strong>${r.c}</strong></div>
      <div class="bar"><div style="background:${colors[r.rank] || '#6B7280'};width:${Math.round(r.c / total * 100)}%"></div></div>
    </div>`).join('') || '<p class="empty-msg">Aucun membre.</p>';
  el('top-challenges-tbl').innerHTML = d.topChallenges.map(c => `<tr>
    <td>${platChip(c.platform)} ${esc(c.name)}</td><td style="text-align:right;font-weight:700;color:var(--blue)">${c.completions}</td></tr>`).join('')
    || '<tr><td class="empty-td">–</td></tr>';
  el('discord-activity-tbl').innerHTML = d.discordActivity.map(a => `<tr>
    <td><strong>${esc(a.discord_username || a.username)}</strong></td><td>${fmtNum(a.msgs7d)}</td><td>${fmtTime(a.vocal7d)}</td>
    <td class="muted">${esc(a.last_activity || '–')}</td></tr>`).join('') || '<tr><td colspan="4" class="empty-td">Aucune activité.</td></tr>';
  el('new-users-tbl').innerHTML = d.newUsers.map(u => `<tr>
    <td><strong>${esc(u.discord_username || u.username)}</strong></td>
    <td style="color:var(--twitch)">${u.twitch_login ? '@' + esc(u.twitch_login) : '–'}</td>
    <td style="font-weight:600;color:var(--blue)">${fmtNum(u.points)}</td><td class="muted">${fmtDate(u.created_at)}</td></tr>`).join('')
    || '<tr><td colspan="4" class="empty-td">Aucun nouveau membre.</td></tr>';
}

// ── Validations ────────────────────────────────────────────────────────────────
async function loadPending() {
  const res = await api('GET', '/api/admin/pending');
  if (!res.ok) return;
  setBadge('pending-badge', res.pending.length);
  el('pending-tbl').innerHTML = res.pending.map(p => `<tr>
    <td><strong>${esc(p.discord_username || p.username)}</strong></td>
    <td>${platChip(p.platform)} ${esc(p.challenge_name)}<br><small style="color:var(--blue);font-weight:600">+${p.points} pts</small></td>
    <td>${p.screenshot_path ? `<img class="thumb clickable" src="${esc(p.screenshot_path)}" data-zoom="${esc(p.screenshot_path)}" alt="screenshot"/>` : '<span class="muted">Pas de screen</span>'}</td>
    <td class="muted">${fmtDateTime(p.completed_at)}</td>
    <td><div class="actions">
      <button class="btn-sm" data-approve="${p.id}">✓ Valider</button>
      <button class="btn-sm" data-reject="${p.id}" style="color:var(--red)">✗ Rejeter</button>
    </div></td>
  </tr>`).join('') || '<tr><td colspan="5" class="empty-td">Aucune validation en attente ✓</td></tr>';
}
el('pending-tbl').addEventListener('click', async e => {
  const z = e.target.closest('[data-zoom]');
  if (z) return openModal(`<div class="amodal-head"><div class="amodal-title">Screenshot</div>${closeBtn()}</div><img src="${esc(z.dataset.zoom)}" style="max-width:100%;border-radius:8px" alt=""/>`, true);
  const a = e.target.closest('[data-approve]'), r = e.target.closest('[data-reject]');
  if (a) { a.disabled = true; const res = await api('POST', `/api/admin/pending/${a.dataset.approve}/approve`); toast(res.message, res.ok ? 'success' : 'error'); loadPending(); }
  if (r && await confirmDialog('Rejeter cette demande ?', 'Le screenshot sera supprimé et le membre pourra en renvoyer un.', 'Rejeter')) {
    const res = await api('POST', `/api/admin/pending/${r.dataset.reject}/reject`); toast(res.message, res.ok ? 'success' : 'error'); loadPending();
  }
});

// ── Membres ────────────────────────────────────────────────────────────────────
async function loadUsers() {
  const res = await api('GET', '/api/admin/users');
  if (!res.ok) return;
  allUsers = res.users;
  el('users-lead').textContent = `${allUsers.length} membre${allUsers.length > 1 ? 's' : ''} inscrits. Clique sur une ligne pour voir le détail.`;
  renderUsers();
}
function renderUsers() {
  const q = el('user-search').value.trim().toLowerCase();
  const list = q ? allUsers.filter(u => [u.username, u.discord_username, u.twitch_login, u.epic_username].some(v => (v || '').toLowerCase().includes(q))) : allUsers;
  el('users-tbl').innerHTML = list.map(u => `<tr class="clickable" data-user="${u.id}">
    <td><strong>${esc(u.discord_username || u.username)}</strong>${u.discord_username && u.discord_username !== u.username ? `<br><small class="muted">${esc(u.username)}</small>` : ''}</td>
    <td><strong style="color:var(--blue)">${fmtNum(u.points)}</strong><br><small class="muted">${fmtNum(u.lifetime_points)} cumulés</small></td>
    <td><span class="pill ${esc(u.rank)}">${rankLabel(u.rank)}</span></td>
    <td>${[u.discord_id ? '💬' : '', u.twitch_login ? '🟣' : '', u.twitter_username ? '𝕏' : '', u.epic_username ? '🎮' : ''].join(' ')}</td>
    <td>${u.challenges_done}</td>
    <td>${fmtTime(u.twitch_watch_seconds)}</td>
    <td>${fmtNum(u.discord_messages)}</td>
    <td>${fmtTime(u.discord_vocal)}</td>
    <td class="muted">${fmtDate(u.last_seen)}</td>
  </tr>`).join('') || '<tr><td colspan="9" class="empty-td">Aucun membre.</td></tr>';
}
el('user-search').addEventListener('input', renderUsers);
el('users-tbl').addEventListener('click', e => { const r = e.target.closest('[data-user]'); if (r) openUser(+r.dataset.user); });

async function openUser(id) {
  const res = await api('GET', `/api/admin/users/${id}`);
  if (!res.ok) return toast(res.message || 'Erreur', 'error');
  const u = res.user;
  const chip = (l, v) => `<div class="chip"><div class="chip-lbl">${l}</div><div class="chip-val" title="${esc(v)}">${esc(v || '–')}</div></div>`;
  openModal(`
    <div class="amodal-head"><div class="amodal-title">${esc(u.discord_username || u.username)}</div>${closeBtn()}</div>
    <div class="chips">
      ${chip('Points disponibles', fmtNum(u.points))}${chip('Points cumulés', fmtNum(u.lifetime_points))}${chip('Rang', rankLabel(u.rank))}
      ${chip('Discord', u.discord_username ? '@' + u.discord_username : '')}${chip('Twitch', u.twitch_login ? '@' + u.twitch_login : '')}${chip('X', u.twitter_username ? '@' + u.twitter_username : '')}${chip('MP Discord', u.notify_dm ? 'Activés' : 'Désactivés')}
      ${chip('Epic', u.epic_username)}${chip('Code créateur', u.epic_creator_code)}${chip('Inscrit le', fmtDate(u.created_at))}${chip('Vu le', fmtDate(u.last_seen))}
    </div>
    <form class="toolbar" id="pts-form">
      <input class="fi" type="number" id="pts-delta" placeholder="+50 ou -50" required style="max-width:160px"/>
      <button class="btn-primary sm" type="submit">Ajuster les points</button>
      <span style="flex:1"></span>
      <button class="btn-sm" type="button" id="u-reset">↺ Réinitialiser ses défis…</button>
    </form>
    <div class="section-title" style="margin-top:6px">Défis (période en cours)</div>
    <div style="overflow-x:auto"><table class="tbl">
      <thead><tr><th>Défi</th><th>Points</th><th>Statut</th><th>Total</th><th></th></tr></thead>
      <tbody>${res.challenges.map(c => {
        const s = c.status;
        const pill = !s ? '<span class="pill used">Non fait</span>' : s.verified === 1 ? '<span class="pill active">✓ Validé</span>' : '<span class="pill pending">⏳ En attente</span>';
        return `<tr><td>${platChip(c.platform)} ${esc(c.name)}${c.repeat_seconds ? ` <small class="muted">${periodLabel(c)}</small>` : ''}</td>
          <td style="color:var(--blue);font-weight:600">+${c.points}</td><td>${pill}</td><td class="muted">${c.times}×</td>
          <td><div class="actions">
            ${s?.verified === 1 ? '' : `<button class="btn-sm" data-ch-validate="${c.id}">✓ Valider</button>`}
            ${s ? `<button class="btn-sm" data-ch-remove="${c.id}" style="color:var(--red)">✗ Retirer</button>` : ''}
          </div></td></tr>`;
      }).join('')}</tbody>
    </table></div>
    ${res.codes.length ? `<div class="section-title">Codes promo</div><div style="overflow-x:auto"><table class="tbl"><tbody>${res.codes.map(c => `<tr><td class="mono">${esc(c.code)}</td><td>-${c.discount}%</td><td>${codeStatus(c)}</td><td class="muted">${fmtDate(c.created_at)}</td></tr>`).join('')}</tbody></table></div>` : ''}
    ${res.orders.length ? `<div class="section-title">Achats</div><div style="overflow-x:auto"><table class="tbl"><tbody>${res.orders.map(o => `<tr><td>${esc(o.item_name)}</td><td class="mono">${esc(o.result || '–')}</td><td class="muted">${fmtDate(o.created_at)}</td></tr>`).join('')}</tbody></table></div>` : ''}
  `, true);

  el('pts-form').addEventListener('submit', async e => {
    e.preventDefault();
    const delta = parseInt(el('pts-delta').value, 10);
    if (!delta) return toast('Entre un nombre non nul.', 'error');
    const r = await api('POST', `/api/admin/users/${u.id}/points`, { delta });
    toast(r.message, r.ok ? 'success' : 'error');
    if (r.ok) { openUser(u.id); loadUsers(); }
  });
  el('u-reset').addEventListener('click', async () => {
    const choice = await choiceDialog(`Réinitialiser les défis de ${u.discord_username || u.username} ?`,
      'Supprime ses validations et remet à zéro ses compteurs (messages, vocal, visionnage, invitations).',
      [['keep', 'Garder ses points'], ['zero', 'Remettre aussi ses points à 0']]);
    if (!choice) return;
    const r = await api('POST', `/api/admin/users/${u.id}/reset`, { resetPoints: choice === 'zero' });
    toast(r.message, r.ok ? 'success' : 'error');
    if (r.ok) { openUser(u.id); loadUsers(); }
  });
  el('amodal-box').addEventListener('click', async e => {
    const v = e.target.closest('[data-ch-validate]'), rm = e.target.closest('[data-ch-remove]');
    if (!v && !rm) return;
    const r = v
      ? await api('POST', `/api/admin/users/${u.id}/challenge/${v.dataset.chValidate}/validate`)
      : await api('DELETE', `/api/admin/users/${u.id}/challenge/${rm.dataset.chRemove}`);
    toast(r.message, r.ok ? 'success' : 'error');
    if (r.ok) { openUser(u.id); if (currentPage === 'users') loadUsers(); }
  });
}

// ── Challenges ─────────────────────────────────────────────────────────────────
async function loadChallenges() {
  const res = await api('GET', '/api/admin/challenges');
  if (!res.ok) return;
  allChallenges = res.challenges;
  renderChallenges();
}
function renderChallenges() {
  const plat = el('ch-filter-plat').value, showInactive = el('ch-show-inactive').checked;
  const list = allChallenges.filter(c => (plat === 'all' || c.platform === plat) && (showInactive || c.active));
  el('challenges-tbl').innerHTML = list.map(c => `<tr style="${c.active ? '' : 'opacity:.55'}">
    <td>${platChip(c.platform)}</td>
    <td><strong>${esc(c.name)}</strong><br><small class="muted">${CH_TYPES[c.type] || esc(c.type)}${c.required_value ? ' · seuil ' + thresholdLabel(c) : ''}</small></td>
    <td style="font-weight:700;color:var(--blue)">${c.points}</td>
    <td style="font-size:12px">${periodLabel(c)}</td>
    <td>${c.completions}</td>
    <td><span class="pill ${c.active ? 'active' : 'used'}">${c.active ? 'Actif' : 'Inactif'}</span></td>
    <td><div class="actions">
      <button class="btn-sm" data-ch-edit="${c.id}">✏️</button>
      <button class="btn-sm" data-ch-toggle="${c.id}">${c.active ? 'Désactiver' : 'Activer'}</button>
      <button class="btn-sm" data-ch-reset="${c.id}" title="Retirer les validations de la période en cours pour tous">↺</button>
      ${c.active ? '' : `<button class="btn-sm" data-ch-delete="${c.id}" style="color:var(--red)" title="Supprimer définitivement">🗑️</button>`}
    </div></td>
  </tr>`).join('') || '<tr><td colspan="7" class="empty-td">Aucun challenge.</td></tr>';
}
el('ch-filter-plat').addEventListener('change', renderChallenges);
el('ch-show-inactive').addEventListener('change', renderChallenges);
el('btn-new-ch').addEventListener('click', () => challengeForm(null));
el('challenges-tbl').addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  const c = allChallenges.find(x => x.id === +(b.dataset.chEdit || b.dataset.chToggle || b.dataset.chReset || b.dataset.chDelete));
  if (!c) return;
  if (b.dataset.chEdit) return challengeForm(c);
  if (b.dataset.chToggle) {
    const r = await api('PATCH', `/api/admin/challenges/${c.id}`, { active: c.active ? 0 : 1 });
    toast(r.message, r.ok ? 'success' : 'error'); return loadChallenges();
  }
  if (b.dataset.chReset && await confirmDialog(`Réinitialiser « ${c.name} » pour tous ?`, 'Les validations sont supprimées et les points de la période en cours retirés aux membres concernés.', 'Réinitialiser')) {
    const r = await api('POST', `/api/admin/challenges/${c.id}/reset`); toast(r.message, r.ok ? 'success' : 'error'); return loadChallenges();
  }
  if (b.dataset.chDelete && await confirmDialog(`Supprimer « ${c.name} » définitivement ?`, 'L\'historique des validations de ce défi sera effacé (les points déjà gagnés restent acquis).', 'Supprimer')) {
    const r = await api('DELETE', `/api/admin/challenges/${c.id}?hard=1`); toast(r.message, r.ok ? 'success' : 'error'); return loadChallenges();
  }
});

function challengeForm(c) {
  const v = c || { platform: 'discord', type: 'redirect', category: 'permanent', points: 50, required_value: 0, repeat_seconds: 0, redirect_delay: 20, active: 1 };
  const opts = (map, cur) => Object.entries(map).map(([k, l]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${l}</option>`).join('');
  openModal(`
    <div class="amodal-head"><div class="amodal-title">${c ? 'Modifier le challenge' : 'Nouveau challenge'}</div>${closeBtn()}</div>
    <form id="ch-form" class="grid-form">
      <div class="fg"><label class="fl">Plateforme</label><select class="fi" name="platform">${opts(PLATFORMS, v.platform)}</select></div>
      <div class="fg"><label class="fl">Type de validation</label><select class="fi" name="type">${opts(CH_TYPES, v.type)}</select></div>
      <div class="fg span2"><label class="fl">Nom</label><input class="fi" name="name" value="${esc(v.name || '')}" required maxlength="120"/></div>
      <div class="fg span2"><label class="fl">Description</label><input class="fi" name="description" value="${esc(v.description || '')}" maxlength="300"/></div>
      ${c ? '' : `<div class="fg span2"><label class="fl">Identifiant unique (slug)</label><input class="fi" name="slug" placeholder="ex: twitch-watch-2h" required pattern="[a-zA-Z0-9-]+"/><div class="fh">Lettres, chiffres et tirets.</div></div>`}
      <div class="fg"><label class="fl">Points</label><input class="fi" type="number" name="points" min="1" value="${v.points}" required/></div>
      <div class="fg"><label class="fl">Catégorie</label><select class="fi" name="category">${opts(CATEGORIES, v.category)}</select></div>
      <div class="fg" data-when="repeat"><label class="fl">Répétable tous les… (jours)</label><input class="fi" type="number" name="repeat_days" min="0" step="1" value="${v.repeat_seconds ? Math.round(v.repeat_seconds / 86400) : 0}"/><div class="fh">0 = une seule fois.</div></div>
      <div class="fg" data-when="threshold"><label class="fl" id="thr-label">Seuil</label><input class="fi" type="number" name="required_value" min="0" value="${thresholdInput(v)}"/></div>
      <div class="fg span2" data-when="url"><label class="fl" id="url-label">Lien à ouvrir</label><input class="fi" name="redirect_url" type="url" value="${esc(v.redirect_url || '')}" placeholder="https://…"/></div>
      <div class="fg" data-when="delay"><label class="fl">Durée du timer (secondes)</label><input class="fi" type="number" name="redirect_delay" min="5" value="${v.redirect_delay || 20}"/></div>
      ${c ? '' : `<label class="switch span2" style="margin:4px 0 8px"><input type="checkbox" name="notify" checked/><span>🔔 Prévenir les membres concernés en MP Discord</span></label>`}
      <div class="span2 toolbar" style="margin:6px 0 0;justify-content:flex-end">
        <button type="button" class="btn-ghost sm" data-close>Annuler</button>
        <button type="submit" class="btn-primary sm">${c ? 'Enregistrer' : 'Créer'}</button>
      </div>
    </form>`);
  const f = el('ch-form');
  const sync = () => {
    const t = f.type.value, cat = f.category.value;
    const show = (k, on) => f.querySelector(`[data-when="${k}"]`).classList.toggle('hidden', !on);
    show('threshold', ['watchtime', 'messages', 'vocal', 'invite'].includes(t));
    show('url', ['redirect', 'screen', 'follow'].includes(t) || t.startsWith('tw_'));
    el('url-label').textContent = t === 'tw_follow' ? 'Lien du profil X à suivre (https://x.com/compte)'
      : t.startsWith('tw_') ? 'Lien du tweet (https://x.com/compte/status/…)' : 'Lien à ouvrir';
    if (t.startsWith('tw_')) f.platform.value = 'twitter';
    show('delay', t === 'redirect');
    show('repeat', !CAT_REPEAT[cat]);
    el('thr-label').textContent = { watchtime: 'Temps de visionnage (minutes)', vocal: 'Temps en vocal (minutes)', messages: 'Nombre de messages', invite: 'Nombre d\'invitations' }[t] || 'Seuil';
    f.redirect_url.required = t === 'redirect' || ['tw_like', 'tw_retweet', 'tw_reply'].includes(t);
  };
  f.type.addEventListener('change', sync); f.category.addEventListener('change', sync); sync();
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const t = f.type.value, isTime = t === 'watchtime' || t === 'vocal';
    const body = {
      platform: f.platform.value, type: t, name: f.name.value.trim(), description: f.description.value.trim(),
      points: +f.points.value, category: f.category.value,
      repeat_seconds: CAT_REPEAT[f.category.value] || (+f.repeat_days.value || 0) * 86400,
      required_value: (+f.required_value.value || 0) * (isTime ? 60 : 1),
      redirect_url: f.redirect_url.value.trim() || null, redirect_delay: +f.redirect_delay.value || 20,
    };
    if (!c) { body.slug = f.slug.value.trim(); body.notify = f.notify.checked; }
    const r = c ? await api('PATCH', `/api/admin/challenges/${c.id}`, body) : await api('POST', '/api/admin/challenges', body);
    toast(r.message, r.ok ? 'success' : 'error');
    if (r.ok) { closeModal(); loadChallenges(); }
  });
}
function thresholdInput(c) { return c.type === 'watchtime' || c.type === 'vocal' ? Math.round((c.required_value || 0) / 60) : (c.required_value || 0); }
function thresholdLabel(c) { return c.type === 'watchtime' || c.type === 'vocal' ? fmtTime(c.required_value) : c.required_value; }
function periodLabel(c) {
  if (c.category === 'contest') return CATEGORIES.contest;
  if (!c.repeat_seconds) return CATEGORIES.permanent;
  if (c.repeat_seconds === 86400) return CATEGORIES.daily;
  if (c.repeat_seconds === 604800) return CATEGORIES.weekly;
  if (c.repeat_seconds === 2592000) return CATEGORIES.monthly;
  return `🔄 ${Math.round(c.repeat_seconds / 86400 * 10) / 10} j`;
}

// ── Boutique ───────────────────────────────────────────────────────────────────
async function loadShop() {
  const [items, orders] = await Promise.all([api('GET', '/api/admin/shop'), api('GET', '/api/admin/orders')]);
  if (items.ok) {
    allItems = items.items;
    el('shop-tbl').innerHTML = allItems.map(i => `<tr style="${i.active ? '' : 'opacity:.55'}">
      <td><strong>${esc(i.name)}</strong><br><small class="muted">${esc(i.description)}</small></td>
      <td style="font-size:12px">${SHOP_TYPES[i.type] || esc(i.type)}${itemWarning(i)}</td>
      <td style="font-weight:700;color:var(--blue)">${fmtNum(i.cost_points)}</td>
      <td>${i.stock === -1 ? '∞' : i.stock}</td><td>${i.sold}</td>
      <td><span class="pill ${i.active ? 'active' : 'used'}">${i.active ? 'Actif' : 'Inactif'}</span></td>
      <td><div class="actions">
        <button class="btn-sm" data-item-edit="${i.id}">✏️</button>
        <button class="btn-sm" data-item-toggle="${i.id}">${i.active ? 'Désactiver' : 'Activer'}</button>
        ${i.sold ? '' : `<button class="btn-sm" data-item-delete="${i.id}" style="color:var(--red)">🗑️</button>`}
      </div></td></tr>`).join('') || '<tr><td colspan="7" class="empty-td">Aucun article.</td></tr>';
  }
  if (orders.ok) {
    setBadge('orders-badge', orders.orders.filter(o => o.status === 'pending').length);
    el('orders-tbl').innerHTML = orders.orders.map(o => `<tr>
      <td>${esc(o.discord_username || o.username)}</td><td>${esc(o.item_name)}</td>
      <td class="mono">${esc(o.result || '–')}</td><td class="muted">${fmtDateTime(o.created_at)}</td>
      <td>${o.status === 'pending' ? `<button class="btn-sm" data-order-done="${o.id}">📦 Marquer traitée</button>` : '<span class="pill active">Traitée</span>'}</td>
    </tr>`).join('') || '<tr><td colspan="5" class="empty-td">Aucune commande.</td></tr>';
  }
}
function itemWarning(i) {
  if (i.type !== 'discord_role') return '';
  let extra = {}; try { extra = JSON.parse(i.extra || '{}'); } catch {}
  return extra.role_id || extra.role_env ? '' : '<br><small style="color:var(--red)">⚠️ ID de rôle manquant</small>';
}
el('btn-new-item').addEventListener('click', () => itemForm(null));
el('shop-tbl').addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  const i = allItems.find(x => x.id === +(b.dataset.itemEdit || b.dataset.itemToggle || b.dataset.itemDelete));
  if (!i) return;
  if (b.dataset.itemEdit) return itemForm(i);
  if (b.dataset.itemToggle) { const r = await api('PATCH', `/api/admin/shop/${i.id}`, { active: i.active ? 0 : 1 }); toast(r.message, r.ok ? 'success' : 'error'); return loadShop(); }
  if (b.dataset.itemDelete && await confirmDialog(`Supprimer « ${i.name} » ?`, 'Action irréversible.', 'Supprimer')) {
    const r = await api('DELETE', `/api/admin/shop/${i.id}?hard=1`); toast(r.message, r.ok ? 'success' : 'error'); loadShop();
  }
});
el('orders-tbl').addEventListener('click', async e => {
  const b = e.target.closest('[data-order-done]'); if (!b) return;
  const r = await api('POST', `/api/admin/orders/${b.dataset.orderDone}/complete`); toast(r.message, r.ok ? 'success' : 'error'); loadShop();
});

function itemForm(item) {
  let extra = {}; try { extra = JSON.parse(item?.extra || '{}'); } catch {}
  const v = item || { type: 'promo_code', cost_points: 500, stock: -1 };
  openModal(`
    <div class="amodal-head"><div class="amodal-title">${item ? 'Modifier l\'article' : 'Nouvel article'}</div>${closeBtn()}</div>
    <form id="item-form" class="grid-form">
      <div class="fg span2"><label class="fl">Nom</label><input class="fi" name="name" value="${esc(v.name || '')}" required maxlength="80"/></div>
      <div class="fg span2"><label class="fl">Description</label><input class="fi" name="description" value="${esc(v.description || '')}" maxlength="200"/></div>
      <div class="fg"><label class="fl">Type</label><select class="fi" name="type" ${item ? 'disabled' : ''}>${Object.entries(SHOP_TYPES).map(([k, l]) => `<option value="${k}" ${k === v.type ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="fg"><label class="fl">Coût (points)</label><input class="fi" type="number" name="cost_points" min="1" value="${v.cost_points}" required/></div>
      <div class="fg"><label class="fl">Stock</label><input class="fi" type="number" name="stock" min="-1" value="${v.stock}"/><div class="fh">-1 = illimité</div></div>
      <div class="fg" data-when="promo_code"><label class="fl">Réduction (%)</label><input class="fi" type="number" name="discount" min="1" max="100" value="${extra.discount || 10}"/><div class="fh">Stripe : un coupon STRIPE_COUPON_&lt;%&gt; doit exister.</div></div>
      <div class="fg" data-when="promo_code"><label class="fl">Palier (préfixe du code)</label><select class="fi" name="tier">${['bronze', 'silver', 'gold'].map(t => `<option ${t === (extra.tier || 'bronze') ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <div class="fg span2" data-when="discord_role"><label class="fl">ID du rôle Discord</label><input class="fi" name="role_id" value="${esc(extra.role_id || '')}" placeholder="1234567890123456789" pattern="\\d{15,21}"/><div class="fh">Le rôle du bot doit être au-dessus de ce rôle dans Discord.</div></div>
      <div class="span2 toolbar" style="margin:6px 0 0;justify-content:flex-end">
        <button type="button" class="btn-ghost sm" data-close>Annuler</button>
        <button type="submit" class="btn-primary sm">${item ? 'Enregistrer' : 'Ajouter'}</button>
      </div>
    </form>`);
  const f = el('item-form');
  const sync = () => f.querySelectorAll('[data-when]').forEach(n => n.classList.toggle('hidden', n.dataset.when !== f.type.value));
  f.type.addEventListener('change', sync); sync();
  f.role_id.required = false;
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const type = f.type.value;
    let ex = {};
    if (type === 'promo_code') ex = { discount: +f.discount.value || 5, tier: f.tier.value };
    if (type === 'discord_role') {
      if (!f.role_id.value.trim()) return toast('ID du rôle Discord requis.', 'error');
      ex = { role_id: f.role_id.value.trim() };
    }
    const body = { name: f.name.value.trim(), description: f.description.value.trim(), type, cost_points: +f.cost_points.value, stock: parseInt(f.stock.value, 10), extra: ex };
    if (Number.isNaN(body.stock)) body.stock = -1;
    const r = item ? await api('PATCH', `/api/admin/shop/${item.id}`, body) : await api('POST', '/api/admin/shop', body);
    toast(r.message, r.ok ? 'success' : 'error');
    if (r.ok) { closeModal(); loadShop(); }
  });
}

// ── Codes ──────────────────────────────────────────────────────────────────────
async function loadCodes() {
  const res = await api('GET', '/api/admin/codes');
  if (!res.ok) return;
  allCodes = res.codes;
  renderCodes();
}
function renderCodes() {
  const q = el('code-search').value.trim().toLowerCase();
  const list = q ? allCodes.filter(c => [c.code, c.username, c.discord_username].some(v => (v || '').toLowerCase().includes(q))) : allCodes;
  el('codes-tbl').innerHTML = list.map(c => `<tr>
    <td class="mono" style="font-weight:600">${esc(c.code)}</td><td>${esc(c.discord_username || c.username)}</td>
    <td style="font-weight:700;color:var(--blue)">-${c.discount}%</td>
    <td class="muted">${fmtDate(c.created_at)}</td><td class="muted">${fmtDate(c.expires_at)}</td><td>${codeStatus(c)}</td>
  </tr>`).join('') || '<tr><td colspan="6" class="empty-td">Aucun code.</td></tr>';
}
el('code-search').addEventListener('input', renderCodes);
el('verify-form').addEventListener('submit', async e => {
  e.preventDefault();
  const code = el('verify-input').value.trim().toUpperCase();
  const res = await api('GET', `/api/admin/codes/verify/${encodeURIComponent(code)}`);
  const box = el('verify-result');
  box.classList.remove('hidden');
  box.innerHTML = res.valid
    ? `<span class="pill active">✓ Valide</span> <strong>${esc(res.code.discord_username || res.code.username)}</strong> · -${res.code.discount}% · expire le ${fmtDate(res.code.expires_at)}
       <button class="btn-primary sm" type="button" id="btn-mark-used">Marquer utilisé</button>`
    : `<span class="pill expired">✗ ${esc(res.message)}</span>`;
  el('btn-mark-used')?.addEventListener('click', async () => {
    const r = await api('POST', `/api/admin/codes/${encodeURIComponent(code)}/use`);
    toast(r.message, r.ok ? 'success' : 'error');
    box.classList.add('hidden'); el('verify-input').value = ''; loadCodes();
  });
});

// ── Live ranking ───────────────────────────────────────────────────────────────
async function loadRanking() {
  const res = await api('GET', '/api/admin/live-ranking');
  if (!res.ok) return;
  el('ranking-tbl').innerHTML = res.ranking.map((r, i) => `<tr>
    <td style="font-weight:700;color:var(--t2)">${i < 3 ? ['🥇', '🥈', '🥉'][i] : i + 1}</td>
    <td><strong>${esc(r.discord_username || r.username)}</strong></td>
    <td style="color:var(--twitch)">${r.twitch_login ? '@' + esc(r.twitch_login) : '–'}</td>
    <td style="font-weight:700;color:var(--blue)">${fmtTime(r.total_seconds)}</td>
    <td>${fmtTime(r.week_seconds)}</td>
    <td class="muted">${fmtDate(r.last_session)}</td>
  </tr>`).join('') || '<tr><td colspan="6" class="empty-td">Aucune donnée de visionnage.</td></tr>';
}

// ── Paramètres ─────────────────────────────────────────────────────────────────
document.querySelectorAll('[data-diag]').forEach(b => b.addEventListener('click', async () => {
  el('diag-result').textContent = 'Test en cours…';
  const dm = b.dataset.diag === 'discord' ? el('diag-dm').value.trim() : '';
  const r = await api('GET', `/api/admin/diag/${b.dataset.diag}${dm ? '?dm=' + encodeURIComponent(dm) : ''}`);
  el('diag-result').textContent = r.message || JSON.stringify(r);
}));
el('pwd-form').addEventListener('submit', async e => {
  e.preventDefault();
  if (el('new-pwd').value !== el('new-pwd2').value) return toast('Les mots de passe ne correspondent pas.', 'error');
  const r = await api('POST', '/api/admin/change-password', { newPassword: el('new-pwd').value });
  toast(r.message, r.ok ? 'success' : 'error');
  if (r.ok) e.target.reset();
});
el('btn-reset-all').addEventListener('click', async () => {
  const choice = await choiceDialog('Réinitialiser TOUS les membres ?', 'Toutes les validations et tous les compteurs seront effacés. Action irréversible.',
    [['keep', 'Défis seulement'], ['zero', 'Défis + points à 0']], true);
  if (!choice) return;
  const typed = await promptDialog('Confirmation', 'Tape CONFIRMER pour continuer.');
  if (typed !== 'CONFIRMER') return toast('Annulé.');
  const r = await api('POST', '/api/admin/reset-all', { confirmText: 'CONFIRMER', resetPoints: choice === 'zero' });
  toast(r.message, r.ok ? 'success' : 'error');
});

// ── Modales ────────────────────────────────────────────────────────────────────
function openModal(html, wide = false) {
  const box = el('amodal-box');
  const fresh = box.cloneNode(false); // supprime les anciens écouteurs
  box.replaceWith(fresh);
  fresh.className = 'amodal-box' + (wide ? ' wide' : '');
  fresh.innerHTML = html;
  fresh.addEventListener('click', e => { if (e.target.closest('[data-close]')) closeModal(); });
  show('amodal');
  fresh.querySelector('input:not([type=hidden]),select')?.focus();
}
function closeModal() { hide('amodal'); _resolve?.(null); _resolve = null; }
el('amodal').addEventListener('mousedown', e => { if (e.target.id === 'amodal') closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !el('amodal').classList.contains('hidden')) closeModal(); });
const closeBtn = () => '<button class="icon-btn" data-close aria-label="Fermer">✕</button>';

let _resolve = null;
function choiceDialog(title, desc, choices, danger = false) {
  return new Promise(resolve => {
    openModal(`<div class="amodal-head"><div class="amodal-title">${esc(title)}</div>${closeBtn()}</div>
      <p class="muted" style="margin-bottom:16px">${esc(desc)}</p>
      <div class="toolbar" style="justify-content:flex-end;margin:0">
        <button class="btn-ghost sm" data-close>Annuler</button>
        ${choices.map(([k, l], i) => `<button class="${danger || i === choices.length - 1 ? 'btn-sm danger' : 'btn-primary sm'}" data-choice="${k}">${esc(l)}</button>`).join('')}
      </div>`);
    _resolve = resolve;
    el('amodal-box').addEventListener('click', e => {
      const c = e.target.closest('[data-choice]'); if (!c) return;
      _resolve = null; hide('amodal'); resolve(c.dataset.choice);
    });
  });
}
async function confirmDialog(title, desc, label) { return !!(await choiceDialog(title, desc, [['ok', label]])); }
function promptDialog(title, desc) {
  return new Promise(resolve => {
    openModal(`<div class="amodal-head"><div class="amodal-title">${esc(title)}</div>${closeBtn()}</div>
      <form id="prompt-form"><p class="muted" style="margin-bottom:10px">${esc(desc)}</p>
      <input class="fi" id="prompt-input" autocomplete="off" style="margin-bottom:14px"/>
      <div class="toolbar" style="justify-content:flex-end;margin:0"><button type="button" class="btn-ghost sm" data-close>Annuler</button><button class="btn-sm danger" type="submit">Valider</button></div></form>`);
    _resolve = resolve;
    el('prompt-form').addEventListener('submit', e => { e.preventDefault(); const v = el('prompt-input').value.trim(); _resolve = null; hide('amodal'); resolve(v); });
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function codeStatus(c) { return c.used ? '<span class="pill used">Utilisé</span>' : c.expired ? '<span class="pill expired">Expiré</span>' : '<span class="pill active">Actif</span>'; }
function rankLabel(r) { return { gold: '🥇 Gold', silver: '🥈 Silver', bronze: '🥉 Bronze' }[r] || esc(r || '–'); }
function platChip(p) { return `<span class="plat-chip ${esc(p)}">${esc(PLATFORMS[p] || p)}</span>`; }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtNum(n) { return Number(n || 0).toLocaleString('fr-FR'); }
function parseDate(d) { return d ? new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(d) ? d : d.replace(' ', 'T') + 'Z') : null; }
function fmtDate(d) { const x = parseDate(d); return x && x.getFullYear() > 2000 ? x.toLocaleDateString('fr-FR') : '–'; }
function fmtDateTime(d) { const x = parseDate(d); return x ? x.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '–'; }
function fmtTime(s) { if (!s) return '0 min'; const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}h${m ? String(m).padStart(2, '0') : ''}` : `${m} min`; }
function el(id) { return document.getElementById(id); }
function show(id) { el(id)?.classList.remove('hidden'); }
function hide(id) { el(id)?.classList.add('hidden'); }
let toastT;
function toast(msg, type = 'info') {
  if (!msg) return;
  const t = el('toast'); t.textContent = msg; t.className = 'toast show ' + type;
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3500);
}
async function api(method, url, body) {
  try {
    const o = { method, headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' };
    if (body) o.body = JSON.stringify(body);
    const res = await fetch(url, o);
    const data = await res.json().catch(() => ({ ok: false, message: 'Réponse invalide du serveur.' }));
    data.status = res.status;
    return data;
  } catch { return { ok: false, message: 'Erreur réseau.' }; }
}
