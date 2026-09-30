'use strict';
const STATE = { user: null, challenges: [], codes: [], orders: [], shopItems: [], progression: {}, activity: {}, seConfigured: false, live: null };
let currentFilter = 'all';
let hideDone = false;
let redirectToken = null, redirectTimer = null, pendingScreenChallengeId = null, modalConfirm = null;
let watchSessionId = null, watchInterval = null, watchStartedAt = 0;

const RANKS = { bronze: '🥉 Bronze', silver: '🥈 Silver', gold: '🥇 Gold' };
const PLATFORMS = {
  discord:   { name: 'Discord',     icon: '💬' },
  twitch:    { name: 'Twitch',      icon: '🟣' },
  twitter:   { name: 'Twitter / X', icon: '𝕏' },
  tiktok:    { name: 'TikTok',      icon: '🎵' },
  instagram: { name: 'Instagram',   icon: '📸' },
  epic:      { name: 'Epic Games',  icon: '🎮' },
};
const CATS = [
  { id: 'all',       label: 'Tous' },
  { id: 'daily',     label: '🔄 Quotidiens' },
  { id: 'weekly',    label: '📅 Hebdo' },
  { id: 'monthly',   label: '📆 Mensuels' },
  { id: 'permanent', label: '♾️ Permanents' },
  { id: 'contest',   label: '🏆 Concours' },
];
const ERRORS = {
  twitch_invalid_client: 'Twitch : "invalid client". Vérifie le Client Secret et la Redirect URI de l\'app Twitch.',
  twitch_denied: 'Connexion Twitch annulée.',
  twitch_link_failed: 'Erreur lors de la liaison Twitch.',
  twitch_state_mismatch: 'Session expirée pendant la liaison Twitch, réessaie.',
  twitch_already_linked: 'Ce compte Twitch est déjà lié à un autre membre.',
  discord_auth_failed: 'Connexion Discord annulée.',
  discord_login_failed: 'Erreur de connexion Discord, réessaie.',
  discord_state_mismatch: 'Session expirée pendant la connexion, réessaie.',
  session_save_failed: 'Impossible d\'ouvrir la session, réessaie.',
};

// ── Démarrage ──────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  syncDarkBtn();
  const params = new URLSearchParams(location.search);
  if (params.get('error')) toast(ERRORS[params.get('error')] || params.get('error').replace(/_/g, ' '), 'error');
  if (params.get('linked')) toast(`✅ Compte ${params.get('linked') === 'twitch' ? 'Twitch' : params.get('linked')} lié avec succès !`, 'success');
  if (location.search) history.replaceState({}, '', location.pathname + location.hash);

  const me = await api('GET', '/auth/me');
  hide('boot');
  if (me.ok && me.user) {
    show('app');
    showPage(location.hash.slice(1) || 'dashboard', false);
    await loadAll();
    loadLive();
    setInterval(loadLive, 120000);
  } else {
    show('auth-page');
  }
});

async function loadAll() {
  const [stats, shopRes] = await Promise.all([api('GET', '/api/user/stats'), api('GET', '/api/user/shop')]);
  if (stats.status === 401) return location.reload();
  if (stats.ok) {
    Object.assign(STATE, {
      user: stats.user, challenges: stats.challenges, codes: stats.codes, orders: stats.orders,
      progression: stats.progression, activity: stats.activity || {}, seConfigured: !!stats.seConfigured,
    });
  } else toast(stats.message || 'Erreur de chargement.', 'error');
  if (shopRes.ok) STATE.shopItems = shopRes.items;
  if (STATE.user) renderAll();
}

async function loadLive() {
  const res = await api('GET', '/api/user/live');
  if (!res.ok) return;
  STATE.live = res;
  renderLive();
}

// ── Rendu ──────────────────────────────────────────────────────────────────────
function renderAll() {
  const u = STATE.user;
  const avatarUrl = u.discord_id && u.discord_avatar ? `https://cdn.discordapp.com/avatars/${u.discord_id}/${u.discord_avatar}.png?size=128` : null;
  const letter = (u.discord_username || u.username || '?').charAt(0).toUpperCase();
  setAvatar('hero-avatar', avatarUrl, letter);
  setAvatar('nav-avatar', avatarUrl, letter);

  el('hero-name').textContent = u.discord_username || u.username;
  el('hero-rank').textContent = RANKS[u.rank] || u.rank;
  el('hero-pts').textContent = fmtNum(u.points);
  el('nav-pts').textContent = fmtNum(u.points) + ' pts';
  el('shop-pts').textContent = fmtNum(u.points) + ' pts';

  // Progression vers le rang suivant (basée sur les points cumulés)
  const nr = u.nextRank;
  if (nr) {
    const prevMin = { silver: 0, gold: 1000 }[nr.id] ?? 0;
    const pct = Math.max(0, Math.min(100, Math.round((u.lifetime_points - prevMin) / (nr.min - prevMin) * 100)));
    el('hero-next-lbl').textContent = `Prochain rang : ${RANKS[nr.id]}`;
    el('hero-next-val').textContent = `encore ${fmtNum(nr.remaining)} pts`;
    el('hero-next-bar').style.width = pct + '%';
  } else {
    el('hero-next-lbl').textContent = 'Rang maximum atteint 🎉';
    el('hero-next-val').textContent = '';
    el('hero-next-bar').style.width = '100%';
  }

  const p = STATE.progression;
  el('s-done').textContent = `${p.done}/${p.total}`;
  el('s-life').textContent = fmtNum(u.lifetime_points);
  el('s-watch').textContent = fmtSecs(STATE.activity.watchSec || 0);
  el('s-msg').textContent = fmtNum(STATE.activity.discMsgs || 0);

  const todo = STATE.challenges.filter(c => !c.completed && !c.screenshotPending).length;
  el('nav-badge').textContent = todo;
  el('nav-badge').classList.toggle('hidden', !todo);

  renderAccounts();
  renderDashDaily();
  renderTabs();
  renderChallengesPage();
  renderShop();
  renderCodes();
  renderOrders();
  renderLive();
}

function setAvatar(id, url, letter) {
  const e = el(id); if (!e) return;
  e.innerHTML = url ? `<img src="${esc(url)}" alt="" onerror="this.remove()"/><span>${esc(letter)}</span>` : `<span>${esc(letter)}</span>`;
}

function renderAccounts() {
  const u = STATE.user;
  const chip = (icon, label, linked, attrs = '') => linked
    ? `<div class="acc-chip linked">${icon} ${esc(label)} <span class="acc-ok">✓</span></div>`
    : `<button class="acc-chip unlinked" ${attrs}>${icon} ${esc(label)}</button>`;
  el('accounts-row').innerHTML = [
    chip('💬', u.discord_username ? '@' + u.discord_username : 'Discord', !!u.discord_id),
    u.twitch_login ? chip('🟣', '@' + u.twitch_login, true) : chip('🟣', 'Lier Twitch', false, 'data-action="link-twitch"'),
    u.epic_username ? chip('🎮', u.epic_username, true) : chip('🎮', 'Lier Epic Games', false, 'data-action="epic-open"'),
  ].join('');
}

function renderLive() {
  const live = STATE.live;
  const bar = el('live-bar');
  if (!live || !live.live) {
    bar.classList.add('hidden');
    if (watchSessionId) stopTracker(true);
    return;
  }
  bar.classList.remove('hidden');
  el('live-link').href = `https://twitch.tv/${encodeURIComponent(live.channel)}`;
  const canTrack = !live.seConfigured && STATE.user?.twitch_id;
  el('btn-live').classList.toggle('hidden', !canTrack);
  el('live-text').textContent = live.seConfigured
    ? (STATE.user?.twitch_id ? '— ton visionnage est compté automatiquement.' : '— lie ton Twitch pour que ton visionnage compte.')
    : (STATE.user?.twitch_id ? '— lance le suivi pendant que tu regardes.' : '— lie ton Twitch pour gagner des points.');
}

function renderDashDaily() {
  const daily = STATE.challenges.filter(c => c.repeat_seconds === 86400);
  const undone = daily.filter(c => !c.completed);
  el('daily-count').textContent = undone.length;
  el('daily-count').classList.toggle('hidden', !undone.length);
  el('daily-reset').textContent = daily[0]?.resetsAt ? `· nouveaux défis dans ${fmtUntil(daily[0].resetsAt)}` : '';
  el('dash-daily').innerHTML = daily.length
    ? [...undone, ...daily.filter(c => c.completed)].slice(0, 6).map(chItem).join('')
    : '<p class="empty-msg">Aucun défi quotidien actif.</p>';
}

function matchesCat(c, cat) {
  if (cat === 'all') return true;
  if (cat === 'daily') return c.repeat_seconds === 86400;
  if (cat === 'weekly') return c.repeat_seconds === 604800;
  if (cat === 'monthly') return c.repeat_seconds === 2592000;
  if (cat === 'permanent') return !c.repeat_seconds && c.category !== 'contest';
  return c.category === cat;
}

function renderTabs() {
  el('cat-tabs').innerHTML = CATS.map(cat => {
    const list = STATE.challenges.filter(c => matchesCat(c, cat.id));
    if (!list.length && cat.id !== 'all') return '';
    const left = list.filter(c => !c.completed).length;
    return `<button class="cat-tab ${cat.id === currentFilter ? 'active' : ''}" data-cat="${cat.id}">${cat.label}<span class="cat-count">${left}</span></button>`;
  }).join('');
}

function renderChallengesPage() {
  const filtered = STATE.challenges.filter(c => matchesCat(c, currentFilter) && !(hideDone && c.completed));
  const platforms = [...new Set(filtered.map(c => c.platform))];
  el('challenges-sections').innerHTML = platforms.map(plat => {
    const chs = filtered.filter(c => c.platform === plat)
      .sort((a, b) => (a.completed - b.completed) || (b.points - a.points));
    const done = chs.filter(c => c.completed).length;
    return `<section class="ch-section">
      <div class="ch-section-hd"><span class="plat-chip ${esc(plat)}">${esc(PLATFORMS[plat]?.name || plat)}</span><span class="ch-section-count">${done}/${chs.length}</span></div>
      <div class="ch-list">${chs.map(chItem).join('')}</div>
    </section>`;
  }).join('') || `<p class="empty-msg">${hideDone ? 'Tous les défis de cette catégorie sont terminés 🎉' : 'Aucun défi ici.'}</p>`;
}

function chItem(c) {
  const isTime = c.type === 'watchtime' || c.type === 'vocal';
  const meta = [`<span class="ch-pts">+${c.points} pts</span>`];
  if (c.repeat_seconds) meta.push(`<span class="ch-tag">${repeatText(c.repeat_seconds)}</span>`);
  const typeTag = { redirect: '🔗 Lien', screen: '📸 Screen', watchtime: '📺 Auto', messages: '🤖 Auto', vocal: '🤖 Auto', invite: '🤖 Auto', join: '✓ Vérif. auto', follow: '✓ Vérif. auto' }[c.type];
  if (typeTag) meta.push(`<span class="ch-tag">${typeTag}</span>`);

  let prog = '';
  if (c.progress && c.progress.required > 0 && !c.completed) {
    const pct = Math.min(100, Math.round(c.progress.current / c.progress.required * 100));
    const cur = isTime ? fmtSecs(c.progress.current) : fmtNum(c.progress.current);
    const req = isTime ? fmtSecs(c.progress.required) : fmtNum(c.progress.required);
    prog = `<div class="ch-progress"><div class="ch-prog-bg"><div class="ch-prog-fill" style="width:${pct}%"></div></div><div class="ch-prog-text">${cur} / ${req}</div></div>`;
  }

  const data = `data-slug="${esc(c.slug)}" data-id="${c.id}"`;
  let btn;
  if (c.completed) btn = `<span class="btn-ch done">✓ Validé</span>`;
  else if (c.screenshotPending) btn = `<button class="btn-ch pending" data-action="verify" ${data} title="Renvoyer un screen">⏳ En attente</button>`;
  else if (c.type === 'redirect') btn = `<button class="btn-ch do" data-action="redirect" ${data}>Visiter →</button>`;
  else if (c.type === 'screen') btn = `<button class="btn-ch do" data-action="verify" ${data}>📸 Envoyer</button>`;
  else if (c.progress && c.progress.current < c.progress.required) btn = `<button class="btn-ch ghost" data-action="verify" ${data}>Actualiser</button>`;
  else btn = `<button class="btn-ch do" data-action="verify" ${data}>Valider</button>`;

  return `<div class="ch-item ${c.completed ? 'done' : c.screenshotPending ? 'pending' : ''}">
    <div class="ch-icon ${esc(c.platform)}">${PLATFORMS[c.platform]?.icon || '⭐'}</div>
    <div class="ch-body">
      <div class="ch-name">${esc(c.name)}</div>
      ${c.description ? `<div class="ch-desc">${esc(c.description)}</div>` : ''}
      <div class="ch-meta">${meta.join('')}</div>
      ${prog}
    </div>
    <div class="ch-action">${btn}</div>
  </div>`;
}

function repeatText(s) {
  if (s === 86400) return '🔄 Quotidien';
  if (s === 604800) return '📅 Hebdo';
  if (s === 2592000) return '📆 Mensuel';
  if (s % 86400 === 0) return `🔄 Tous les ${s / 86400} j`;
  return `🔄 ${fmtSecs(s)}`;
}

function renderShop() {
  const pts = STATE.user?.points || 0;
  const emojis = { promo_code: '🎟️', discord_role: '🏅', product: '📦' };
  el('shop-grid').innerHTML = STATE.shopItems.map(item => {
    const can = pts >= item.cost_points;
    const soldOut = item.stock === 0;
    const pct = Math.min(100, Math.round(pts / item.cost_points * 100));
    return `<div class="shop-card ${can && !soldOut ? 'can' : ''}">
      <div class="shop-emoji">${emojis[item.type] || '🎁'}</div>
      <div class="shop-name">${esc(item.name)}</div>
      <div class="shop-desc">${esc(item.description)}</div>
      <div class="shop-price">${fmtNum(item.cost_points)} pts</div>
      ${item.stock > 0 ? `<div class="shop-stock">Plus que ${item.stock} en stock</div>` : ''}
      ${!can && !soldOut ? `<div class="shop-missing"><div class="ch-prog-bg"><div class="ch-prog-fill" style="width:${pct}%"></div></div>Il te manque ${fmtNum(item.cost_points - pts)} pts</div>` : ''}
      <button class="btn-buy" data-action="buy" data-id="${item.id}" ${can && !soldOut ? '' : 'disabled'}>${soldOut ? 'Épuisé' : can ? 'Échanger' : 'Points insuffisants'}</button>
    </div>`;
  }).join('') || '<p class="empty-msg">Aucun article pour le moment.</p>';
}

function renderCodes() {
  el('codes-list').innerHTML = STATE.codes.map(c => {
    const status = c.used ? ['used', 'Utilisé'] : c.expired ? ['expired', 'Expiré'] : ['active', `Valable jusqu'au ${fmtDate(c.expires_at)}`];
    return `<div class="code-row ${status[0]}">
      <div><div class="code-val">${esc(c.code)}</div><div class="code-meta">-${c.discount}% · <span class="pill ${status[0]}">${status[1]}</span></div></div>
      ${status[0] === 'active' ? `<button class="btn-sm" data-action="copy" data-code="${esc(c.code)}">Copier</button>` : ''}
    </div>`;
  }).join('') || '<p class="empty-msg">Aucun code pour l\'instant — échange tes points ci-dessus.</p>';
}

function renderOrders() {
  el('orders-body').innerHTML = STATE.orders.map(o => `<tr>
    <td>${esc(o.item_name)}</td>
    <td class="mono">${o.result ? esc(o.result) : '–'}</td>
    <td class="muted">${fmtDate(o.created_at)}</td>
  </tr>`).join('') || '<tr><td colspan="3" class="empty-td">Aucun achat.</td></tr>';
}

// ── Actions (délégation d'événements : pas de JS inline, noms avec apostrophes OK) ──
document.addEventListener('click', e => {
  const nav = e.target.closest('[data-page]');
  if (nav) { showPage(nav.dataset.page); return; }
  const tab = e.target.closest('.cat-tab');
  if (tab) { currentFilter = tab.dataset.cat; renderTabs(); renderChallengesPage(); return; }
  const a = e.target.closest('[data-action]');
  if (!a || a.disabled) return;
  const c = a.dataset.slug ? STATE.challenges.find(x => x.slug === a.dataset.slug) : null;
  switch (a.dataset.action) {
    case 'verify':      return withBusy(a, () => verifyChallenge(c));
    case 'redirect':    return withBusy(a, () => startRedirect(c));
    case 'buy':         return buyItem(STATE.shopItems.find(i => i.id === +a.dataset.id));
    case 'copy':        return copyCode(a.dataset.code, a);
    case 'link-twitch': location.href = '/auth/twitch'; return;
    case 'epic-open':   show('epic-form'); el('epic-username').focus(); return;
    case 'epic-cancel': hide('epic-form'); return;
  }
});
el('hide-done').addEventListener('change', e => { hideDone = e.target.checked; renderChallengesPage(); });
el('btn-dark').addEventListener('click', toggleDark);
el('btn-logout').addEventListener('click', logout);
el('btn-live').addEventListener('click', () => watchSessionId ? stopTracker() : startTracker());
el('btn-modal-close').addEventListener('click', closeModal);
el('modal-overlay').addEventListener('click', e => { if (e.target.id === 'modal-overlay') closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !el('modal-overlay').classList.contains('hidden')) closeModal(); });
el('epic-form').addEventListener('submit', saveEpic);
el('modal-screen-section').addEventListener('submit', uploadScreenshot);
el('modal-screen-input').addEventListener('change', e => previewScreen(e.target.files[0]));
el('btn-modal-confirm').addEventListener('click', () => { const fn = modalConfirm; closeModal(); fn?.(); });
const drop = el('screen-drop');
['dragover', 'dragenter'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('drag'); }));
['dragleave', 'drop'].forEach(t => drop.addEventListener(t, () => drop.classList.remove('drag')));
drop.addEventListener('drop', e => {
  e.preventDefault();
  const f = e.dataTransfer.files[0]; if (!f) return;
  const dt = new DataTransfer(); dt.items.add(f); el('modal-screen-input').files = dt.files;
  previewScreen(f);
});
window.addEventListener('hashchange', () => showPage(location.hash.slice(1) || 'dashboard', false));

async function withBusy(btn, fn) {
  const txt = btn.textContent;
  btn.disabled = true; btn.textContent = '…';
  try { await fn(); } finally { btn.disabled = false; btn.textContent = txt; }
}

async function verifyChallenge(c) {
  if (!c) return;
  const res = await api('POST', `/api/user/challenge/${encodeURIComponent(c.slug)}/verify`);
  if (res.redirect) return runRedirect(c, res);
  if (res.needsScreen) {
    if (res.openUrl && !c.screenshotPending) openTab(res.openUrl);
    return openScreenModal(res.challengeId, res.challengeName || c.name, res.requireAdmin);
  }
  if (res.needsLink === 'twitch') {
    toast(res.message, 'error');
    return confirmModal('🟣', 'Lier ton compte Twitch', 'Ce défi nécessite ton compte Twitch.', 'Lier Twitch', () => { location.href = '/auth/twitch'; });
  }
  toast(res.message, res.ok ? 'success' : 'error');
  if (res.openUrl) openTab(res.openUrl);
  if (res.ok || res.progress) await loadAll();
}

// ── Lien + timer ──────────────────────────────────────────────────────────────
async function startRedirect(c) {
  // La fenêtre est ouverte AVANT l'appel réseau, sinon les bloqueurs de pop-up l'interceptent
  // (sans 'noopener' dans les options : window.open renverrait alors null)
  const win = c.redirect_url ? openTab(c.redirect_url) : null;
  const res = await api('POST', `/api/user/challenge/${encodeURIComponent(c.slug)}/verify`);
  if (!res.redirect) {
    try { win?.close(); } catch {}
    toast(res.message, res.ok ? 'success' : 'error');
    if (res.ok) loadAll();
    return;
  }
  runRedirect(c, res, !!win);
}

function runRedirect(c, res, alreadyOpened = false) {
  if (!alreadyOpened) openTab(res.url);
  redirectToken = res.token;
  const delay = res.delay || 20;
  openModal('🔗', res.challengeName || c.name, 'Le lien s\'est ouvert dans un nouvel onglet. Abonne-toi, puis patiente…');
  show('modal-timer-wrap');
  const arc = el('timer-arc'), circ = 213.6;
  let remaining = delay;
  el('timer-num').textContent = remaining;
  arc.style.strokeDashoffset = 0; arc.style.stroke = 'var(--blue)';
  clearInterval(redirectTimer);
  redirectTimer = setInterval(async () => {
    remaining--;
    el('timer-num').textContent = Math.max(remaining, 0);
    arc.style.strokeDashoffset = circ * (delay - remaining) / delay;
    if (remaining > 0) return;
    clearInterval(redirectTimer);
    el('timer-num').textContent = '✓';
    arc.style.stroke = 'var(--green)';
    const r = await api('POST', '/api/user/challenge/redirect/validate', { token: redirectToken });
    redirectToken = null;
    toast(r.message, r.ok ? 'success' : 'error');
    closeModal();
    loadAll();
  }, 1000);
}

// ── Screenshot ─────────────────────────────────────────────────────────────────
function openScreenModal(challengeId, name, requireAdmin) {
  pendingScreenChallengeId = challengeId;
  openModal('📸', 'Envoie ton screenshot',
    `Envoie une capture prouvant que tu as complété « ${name} ».` + (requireAdmin ? ' Elle sera vérifiée par l\'équipe K13 sous 24h.' : ''));
  show('modal-screen-section');
}

function previewScreen(file) {
  if (!file) return;
  el('screen-label-text').textContent = '✓ ' + file.name;
  const img = el('screen-preview');
  img.src = URL.createObjectURL(file);
  img.classList.remove('hidden');
}

async function uploadScreenshot(e) {
  e.preventDefault();
  const file = el('modal-screen-input').files[0];
  if (!file) return toast('Sélectionne une image.', 'error');
  if (file.size > 8 * 1024 * 1024) return toast('Image trop lourde (8 Mo max).', 'error');
  const btn = el('btn-upload-screen');
  const fd = new FormData(); fd.append('screenshot', file);
  btn.disabled = true; btn.textContent = 'Envoi…';
  try {
    const res = await fetch(`/api/user/challenge/${pendingScreenChallengeId}/screenshot`, { method: 'POST', body: fd, credentials: 'same-origin' });
    const data = await res.json().catch(() => ({ ok: false, message: 'Erreur serveur.' }));
    toast(data.message || 'Screenshot envoyé !', data.ok ? (data.pending ? 'pending' : 'success') : 'error');
    if (data.ok) { closeModal(); loadAll(); }
  } catch { toast('Erreur réseau.', 'error'); }
  btn.disabled = false; btn.textContent = 'Envoyer le screenshot';
}

// ── Modale générique ───────────────────────────────────────────────────────────
function openModal(icon, title, desc) {
  el('modal-icon').textContent = icon;
  el('modal-title').textContent = title;
  el('modal-desc').textContent = desc;
  ['modal-timer-wrap', 'modal-screen-section', 'btn-modal-confirm', 'screen-preview'].forEach(hide);
  el('modal-screen-input').value = '';
  el('screen-label-text').textContent = '📂 Choisir ou glisser une image';
  el('btn-modal-close').textContent = 'Fermer';
  show('modal-overlay');
}
function confirmModal(icon, title, desc, label, fn) {
  openModal(icon, title, desc);
  modalConfirm = fn;
  el('btn-modal-confirm').textContent = label;
  show('btn-modal-confirm');
  el('btn-modal-close').textContent = 'Annuler';
  el('btn-modal-confirm').focus();
}
function closeModal() {
  clearInterval(redirectTimer);
  modalConfirm = null;
  hide('modal-overlay');
}

// ── Epic Games ─────────────────────────────────────────────────────────────────
async function saveEpic(e) {
  e.preventDefault();
  const res = await api('POST', '/api/user/epic', { epic_username: el('epic-username').value.trim(), epic_creator_code: el('epic-code').value.trim() });
  toast(res.message, res.ok ? 'success' : 'error');
  if (res.ok) { hide('epic-form'); loadAll(); }
}

// ── Boutique ───────────────────────────────────────────────────────────────────
function buyItem(item) {
  if (!item) return;
  const after = STATE.user.points - item.cost_points;
  confirmModal('🛒', `Échanger « ${item.name} » ?`,
    `${fmtNum(item.cost_points)} pts seront débités. Il te restera ${fmtNum(after)} pts. Ton rang n'est pas affecté.`,
    'Confirmer l\'échange', async () => {
      const res = await api('POST', `/api/user/shop/buy/${item.id}`);
      if (!res.ok) return toast(res.message, 'error');
      await loadAll();
      if (res.type === 'promo_code' && res.result) {
        confirmModal('🎟️', 'Ton code promo', `${res.result} — valable 30 jours, utilisable une fois.`, 'Copier le code', () => copyCode(res.result));
      } else toast(`✅ ${res.item}${res.result ? ' — ' + res.result : ''}`, 'success');
    });
}

async function copyCode(code, btn) {
  try { await navigator.clipboard.writeText(code); toast('Code copié ✓', 'success'); if (btn) btn.textContent = 'Copié ✓'; }
  catch { toast(code, 'info'); }
}

// ── Suivi du live (uniquement si StreamElements n'est pas configuré) ──────────
async function startTracker() {
  const res = await api('POST', '/api/user/watchtime/start');
  if (!res.ok) return toast(res.message, 'error');
  watchSessionId = res.sessionId; watchStartedAt = Date.now();
  el('btn-live').textContent = '■ Arrêter';
  el('btn-live').classList.add('danger');
  watchInterval = setInterval(async () => {
    const r = await api('POST', '/api/user/watchtime/ping', { sessionId: watchSessionId });
    el('live-text').textContent = `— suivi actif : ${fmtSecs(Math.floor((Date.now() - watchStartedAt) / 1000))} cette session.`;
    if (r.ok && !r.live) { toast('Le live est terminé, suivi arrêté.', 'info'); stopTracker(); }
  }, 60000);
  el('live-text').textContent = '— suivi actif.';
  toast('✅ Suivi démarré ! Garde cette page ouverte.', 'success');
}
async function stopTracker(silent) {
  clearInterval(watchInterval);
  const id = watchSessionId; watchSessionId = null;
  if (id) await api('POST', '/api/user/watchtime/end', { sessionId: id });
  el('btn-live').textContent = '▶ Démarrer le suivi';
  el('btn-live').classList.remove('danger');
  if (!silent) toast('Session de visionnage enregistrée.', 'success');
  loadAll();
}
window.addEventListener('beforeunload', () => {
  if (watchSessionId) navigator.sendBeacon('/api/user/watchtime/end', new Blob([JSON.stringify({ sessionId: watchSessionId })], { type: 'application/json' }));
});

// ── Navigation ─────────────────────────────────────────────────────────────────
function showPage(id, push = true) {
  if (!el('page-' + id)) id = 'dashboard';
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + id));
  document.querySelectorAll('.nav-link[data-page]').forEach(b => b.classList.toggle('active', b.dataset.page === id));
  if (push && location.hash.slice(1) !== id) history.pushState({}, '', id === 'dashboard' ? location.pathname : '#' + id);
  window.scrollTo({ top: 0 });
}

// ── Dark mode ─────────────────────────────────────────────────────────────────
function toggleDark() {
  const isDark = document.documentElement.classList.toggle('dark');
  try { localStorage.setItem('k13-dark', isDark ? '1' : '0'); } catch {}
  syncDarkBtn();
}
function syncDarkBtn() { el('btn-dark').textContent = document.documentElement.classList.contains('dark') ? '☀️' : '🌙'; }

// ── Helpers ────────────────────────────────────────────────────────────────────
function el(id) { return document.getElementById(id); }
function openTab(url) { const w = window.open(url, '_blank'); if (w) w.opener = null; return w; }
function show(id) { el(id)?.classList.remove('hidden'); }
function hide(id) { el(id)?.classList.add('hidden'); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtNum(n) { return Number(n || 0).toLocaleString('fr-FR'); }
// Les dates SQLite sont en UTC sans suffixe
function parseDate(d) { return d ? new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(d) ? d : d.replace(' ', 'T') + 'Z') : null; }
function fmtDate(d) { const x = parseDate(d); return x ? x.toLocaleDateString('fr-FR') : '–'; }
function fmtSecs(s) {
  if (!s) return '0 min';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h === 0) return m + ' min';
  if (m === 0) return h + 'h';
  return h + 'h ' + m + 'min';
}
function fmtUntil(iso) {
  const s = Math.max(0, Math.floor((new Date(iso) - Date.now()) / 1000));
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return d ? `${d}j ${h}h` : h ? `${h}h ${m}min` : `${m} min`;
}
let toastT;
function toast(msg, type = 'info') {
  if (!msg) return;
  const t = el('toast'); t.textContent = msg; t.className = 'toast show ' + type;
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 4500);
}
async function api(method, url, body) {
  try {
    const o = { method, headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' };
    if (body) o.body = JSON.stringify(body);
    const res = await fetch(url, o);
    const data = await res.json().catch(() => ({ ok: false, message: 'Réponse invalide du serveur.' }));
    if (res.status === 401) data.status = 401;
    return data;
  } catch { return { ok: false, message: 'Erreur réseau.' }; }
}
function logout() { api('POST', '/auth/logout').then(() => location.replace('/')); }
