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
  twitter_already_linked: 'Ce compte X est déjà lié à un autre membre.',
  twitter_denied: 'Liaison X annulée.',
  twitter_link_failed: 'Erreur lors de la liaison X, réessaie.',
  twitter_state_mismatch: 'Session expirée pendant la liaison X, réessaie.',
  twitter_not_configured: 'La liaison X n\'est pas encore configurée sur le site.',
  twitch_already_linked: 'Ce compte Twitch est déjà lié à un autre membre.',
  discord_not_configured: 'Connexion Discord indisponible : configuration serveur manquante. Préviens un admin.',
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
  if (params.get('linked')) toast(`✅ Compte ${{ twitch: 'Twitch', twitter: 'X' }[params.get('linked')] || params.get('linked')} lié avec succès !`, 'success');
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
      twitterConfigured: !!stats.twitterConfigured,
      daily: stats.daily, gift: stats.gift, onboarding: stats.onboarding, month: stats.month, gamesDisabled: !!stats.gamesDisabled,
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
    const prevMin = { silver: 0, gold: 10000 }[nr.id] ?? 0;
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
  renderDaily();
  renderGift();
  renderOnboarding();
  el('games-pts').textContent = fmtNum(u.points) + ' pts';
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
    u.twitter_username ? chip('𝕏', '@' + u.twitter_username, true)
      : STATE.twitterConfigured ? chip('𝕏', 'Lier X (Twitter)', false, 'data-action="link-twitter"') : '',
    u.epic_username ? chip('🎮', u.epic_username, true) : chip('🎮', 'Lier Epic Games', false, 'data-action="epic-open"'),
  ].join('');
  el('notify-dm').checked = !!u.notify_dm;
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
  const typeTag = { redirect: '🔗 Lien', screen: '📸 Screen', watchtime: '📺 Auto', messages: '🤖 Auto', vocal: '🤖 Auto', invite: '🤖 Auto', join: '✓ Vérif. auto', follow: '✓ Vérif. auto',
    tw_like: '❤️ Like', tw_retweet: '🔁 Retweet', tw_reply: '💬 Commentaire', tw_follow: '➕ Abonnement' }[c.type];
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
  else if (c.pending) btn = `<span class="btn-ch pending" title="En attente de validation par l'équipe">⏳ En attente</span>`;
  else if (c.type.startsWith('tw_')) btn = `<div class="ch-btns">${c.redirect_url ? `<a class="btn-ch ghost" href="${esc(c.redirect_url)}" target="_blank" rel="noopener">Ouvrir ↗</a>` : ''}<button class="btn-ch do" data-action="verify" ${data}>Vérifier</button></div>`;
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
  const emojis = { promo_code: '🎟️', discord_role: '🏅', product: '📦', streak_shield: '🧊' };
  el('shop-grid').innerHTML = STATE.shopItems.map(item => {
    const can = pts >= item.cost_points;
    const soldOut = item.stock === 0;
    const pct = Math.min(100, Math.round(pts / item.cost_points * 100));
    return `<div class="shop-card ${can && !soldOut ? 'can' : ''}">
      <div class="shop-emoji">${esc(item.emoji || emojis[item.type] || '🎁')}</div>
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
  if (nav) { if (nav.tagName === 'A') e.preventDefault(); showPage(nav.dataset.page); return; }
  const tab = e.target.closest('.cat-tab');
  if (tab) { currentFilter = tab.dataset.cat; renderTabs(); renderChallengesPage(); return; }
  const a = e.target.closest('[data-action]');
  if (!a || a.disabled) return;
  if (a.tagName === 'A' && a.getAttribute('href') === '#') e.preventDefault();
  const c = a.dataset.slug ? STATE.challenges.find(x => x.slug === a.dataset.slug) : null;
  switch (a.dataset.action) {
    case 'verify':      return withBusy(a, () => verifyChallenge(c));
    case 'redirect':    return withBusy(a, () => startRedirect(c));
    case 'buy':         return buyItem(STATE.shopItems.find(i => i.id === +a.dataset.id));
    case 'copy':        return copyCode(a.dataset.code, a);
    case 'gift':        return openGift(+a.dataset.choice);
    case 'copy-ref':    return copyCode(el('ref-link').value, a);
    case 'bet-chip':    return setBet(a.dataset.game, a.dataset.value);
    case 'coin':        return withBusy(a, () => playCoin(a.dataset.choice));
    case 'roulette':    return withBusy(a, () => playRoulette(a.dataset.type, a.dataset.type === 'numero' ? el('roulette-number').value : a.dataset.value));
    case 'bj-start':    return withBusy(a, () => bjStart());
    case 'bj':          return withBusy(a, () => bjMove(a.dataset.move));
    case 'delete-account': return deleteAccount();
    case 'link-twitch': location.href = '/auth/twitch'; return;
    case 'link-twitter': location.href = '/auth/twitter'; return;
    case 'epic-open':   show('epic-form'); el('epic-username').focus(); return;
    case 'epic-cancel': hide('epic-form'); return;
  }
});
el('notify-dm').addEventListener('change', async e => {
  const res = await api('POST', '/api/user/settings', { notify_dm: e.target.checked });
  toast(res.ok ? (e.target.checked ? '🔔 Tu recevras les nouveaux défis en MP Discord.' : '🔕 MP Discord désactivés.') : res.message, res.ok ? 'success' : 'error');
  if (res.ok) STATE.user.notify_dm = e.target.checked; else e.target.checked = !e.target.checked;
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
  if (res.needsLink === 'twitter') {
    toast(res.message, 'error');
    return confirmModal('𝕏', 'Lier ton compte X', 'Ce défi vérifie ton activité sur X : relie ton compte (lecture seule, aucun post en ton nom).', 'Lier X', () => { location.href = '/auth/twitter'; });
  }
  if (res.pending) { toast(res.message, 'pending'); return loadAll(); }
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

// ── Bonus quotidien & premiers pas ─────────────────────────────────────────────
function renderDaily() {
  const d = STATE.daily; if (!d) return;
  el('daily-title').textContent = `Série de ${d.streak} jour${d.streak > 1 ? 's' : ''}${d.shields ? ` · 🧊 ${d.shields}` : ''}`;
  el('daily-flame').classList.toggle('cold', !d.streak);
  el('daily-sub').textContent = d.claimed
    ? `✅ Récupéré ! Reviens dans ${fmtUntil(d.resetsAt)} pour +${d.nextReward} pts.`
    : `+${d.nextReward} pts à récupérer aujourd'hui${d.shieldsNeeded ? ` — 🧊 ${d.shieldsNeeded} protection${d.shieldsNeeded > 1 ? 's' : ''} va sauver ta série` : d.streak ? ' — ne casse pas ta série !' : ''}`
      + (d.nextMilestone ? ` · Palier ${d.nextMilestone.day} jours : +${d.nextMilestone.bonus} pts` : '');
  // 7 pastilles : jours déjà faits dans la semaine de série en cours
  const pos = d.streak % 7 || (d.streak ? 7 : 0);
  el('daily-week').innerHTML = Array.from({ length: 7 }, (_, i) => `<span class="dw ${i < pos ? 'on' : ''} ${i === 6 ? 'gift' : ''}">${i === 6 ? '🎁' : i + 1}</span>`).join('');
  const btn = el('btn-daily');
  btn.disabled = d.claimed;
  btn.textContent = d.claimed ? '✓ Fait' : `🎁 +${d.nextReward} pts`;
  btn.classList.toggle('pulse', !d.claimed);
}
el('btn-daily').addEventListener('click', async () => {
  const btn = el('btn-daily'); btn.disabled = true;
  const r = await api('POST', '/api/user/daily');
  toast(r.message, r.ok ? 'success' : 'info');
  if (r.ok && (r.bonus || r.streak === 1)) confetti();
  showNewBadges(r.badges);
  await loadAll();
});

// ── Cadeau du jour ─────────────────────────────────────────────────────────────
let giftOpening = false;
function renderGift() {
  const g = STATE.gift; if (!g || giftOpening) return;
  el('gift-card').classList.toggle('opened', !g.available);
  el('gift-sub').textContent = g.available ? `Choisis 1 cadeau parmi 3 · jusqu'à ${fmtNum(g.max)} pts 💎` : `Déjà ouvert · prochain dans ${fmtUntil(g.resetsAt)}`;
  if (!g.available && !el('gift-boxes').dataset.revealed) {
    document.querySelectorAll('.gift-box').forEach(b => { b.disabled = true; b.textContent = '🎁'; });
  }
}
async function openGift(choice) {
  if (giftOpening) return;
  giftOpening = true;
  const boxes = [...document.querySelectorAll('.gift-box')];
  boxes.forEach(b => { b.disabled = true; });
  boxes[choice].classList.add('shake');
  const [r] = await Promise.all([api('POST', '/api/user/gift', { choice }), sleep(1100)]);
  boxes[choice].classList.remove('shake');
  if (!r.ok) { giftOpening = false; toast(r.message, 'info'); return loadAll(); }
  const icon = v => v >= 10000 ? '💎' : v >= 2500 ? '🏆' : v >= 1000 ? '⭐' : '🎁';
  boxes.forEach((b, n) => {
    b.innerHTML = `<span class="gb-ico">${icon(r.values[n])}</span><span class="gb-val">${fmtNum(r.values[n])}</span>`;
    b.classList.add(n === r.choice ? 'picked' : 'missed');
  });
  el('gift-boxes').dataset.revealed = '1';
  toast(r.message, 'success');
  if (r.won >= 2500) confetti();
  updateBalance(r.balance);
  giftOpening = false;
  STATE.gift = { ...STATE.gift, available: false };
  el('gift-sub').textContent = 'À demain pour un nouveau cadeau !';
}

function renderOnboarding() {
  const o = STATE.onboarding; if (!o) return;
  let dismissed = false; try { dismissed = localStorage.getItem('k13-onboard-done') === '1'; } catch {}
  el('onboard-card').classList.toggle('hidden', dismissed || o.done === o.total);
  el('onboard-count').textContent = `${o.done}/${o.total}`;
  const go = { daily: '', twitch: 'data-action="link-twitch"', challenge: 'data-page="challenges"', referral: 'data-page="profile"' };
  el('onboard-list').innerHTML = o.steps.map(s => `<li class="${s.done ? 'done' : ''}">${s.done ? '✅' : '⬜'} ${s.done ? esc(s.label) : `<a href="#" ${go[s.id]}>${esc(s.label)}</a>`}</li>`).join('');
  if (o.done === o.total) try { localStorage.setItem('k13-onboard-done', '1'); } catch {}
}

function showNewBadges(list) {
  for (const b of list || []) setTimeout(() => toast(`🏅 Nouveau badge : ${b.icon} ${b.name} !`, 'success'), 1200);
}

// ── Profil ─────────────────────────────────────────────────────────────────────
async function loadProfile() {
  const r = await api('GET', '/api/user/profile');
  if (!r.ok) return;
  const ref = r.referral;
  el('ref-link').value = ref.link;
  el('ref-desc').innerHTML = `Partage ton lien : quand un ami s'inscrit et valide son premier défi, tu gagnes <strong>+${fmtNum(ref.referrerReward)} pts</strong> et lui <strong>+${fmtNum(ref.refereeReward)} pts</strong>.`;
  el('ref-count').innerHTML = `${ref.count} filleul${ref.count > 1 ? 's' : ''} · ${ref.rewarded} actif${ref.rewarded > 1 ? 's' : ''}
    <div class="ref-steps">${ref.milestones.map(m => `<span class="ref-step ${ref.rewarded >= m.count ? 'on' : ''}">${ref.rewarded >= m.count ? '✅' : '🎯'} ${m.count} actifs : +${fmtNum(m.bonus)}</span>`).join('')}</div>`;
  el('rank-pos').innerHTML = `
    <div><span class="rp-num">${r.points ? '#' + r.points.position : '–'}</span><span class="rp-lbl">Solde actuel${r.points ? ` · ${fmtNum(r.points.points)} pts` : ''}</span></div>
    <div><span class="rp-num">${r.month ? '#' + r.month.position : '–'}</span><span class="rp-lbl">Ce mois${r.month ? ` · ${fmtNum(r.month.points)} pts` : ''}</span></div>
    <div><span class="rp-num">${r.all ? '#' + r.all.position : '–'}</span><span class="rp-lbl">Depuis toujours${r.all ? ` · ${fmtNum(r.all.points)} pts` : ''}</span></div>`;
  const have = r.badges.filter(b => b.unlocked).length;
  el('badge-count').textContent = `${have}/${r.badges.length}`;
  el('badges-grid').innerHTML = r.badges.map(b => `<div class="badge ${b.unlocked ? 'on' : ''}" title="${esc(b.desc)}">
    <div class="badge-ico">${b.unlocked ? b.icon : '🔒'}</div><div class="badge-name">${esc(b.name)}</div><div class="badge-desc">${esc(b.desc)}</div></div>`).join('');
  const reasonIco = { gift: '🎁', challenge: '🎯', daily: '🔥', referral: '🤝', welcome: '👋', shop: '🛒', game: '🎲', admin: '🛠️', revoke: '↩️' };
  el('history-body').innerHTML = r.history.map(h => `<tr>
    <td>${reasonIco[h.reason] || '•'} ${esc(h.label || h.reason)}</td>
    <td class="${h.delta > 0 ? 'pos' : 'neg'}" style="text-align:right;font-weight:700">${h.delta > 0 ? '+' : ''}${fmtNum(h.delta)}</td>
    <td class="muted" style="text-align:right">${new Date(h.created_at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}</td></tr>`).join('')
    || '<tr><td class="empty-td">Aucun mouvement pour l\'instant.</td></tr>';
  el('games-off').checked = STATE.gamesDisabled;
}
el('games-off').addEventListener('change', async e => {
  const r = await api('POST', '/api/user/settings', { games_disabled: e.target.checked });
  toast(r.ok ? (e.target.checked ? '🚫 Jeux désactivés pour ton compte.' : '🎲 Jeux réactivés.') : r.message, r.ok ? 'success' : 'error');
  if (r.ok) STATE.gamesDisabled = e.target.checked; else e.target.checked = !e.target.checked;
});
function deleteAccount() {
  confirmModal('🗑️', 'Supprimer ton compte ?', 'Tous tes points, défis, codes promo et ton historique seront définitivement effacés. Cette action est irréversible.', 'Continuer', async () => {
    const typed = prompt('Tape SUPPRIMER pour confirmer la suppression définitive :');
    if (typed !== 'SUPPRIMER') return toast('Suppression annulée.');
    const r = await api('POST', '/api/user/delete', { confirm: 'SUPPRIMER' });
    if (r.ok) { alert('Ton compte a été supprimé.'); location.replace('/'); } else toast(r.message, 'error');
  });
}

// ── Jeux ───────────────────────────────────────────────────────────────────────
let GAMES = { limits: null };
const CHIPS = [100, 500, 1000, 5000];
function renderBetRows() {
  document.querySelectorAll('.bet-row').forEach(row => {
    const g = row.dataset.game;
    if (row.dataset.ready) return;
    row.dataset.ready = '1';
    row.innerHTML = `<label class="bet-lbl">Mise</label><input class="input bet-input" type="number" id="bet-${g}" min="1" step="10" value="${getBetPref(g)}"/>
      ${CHIPS.map(v => `<button class="chip" data-action="bet-chip" data-game="${g}" data-value="${v}">${v}</button>`).join('')}
      <button class="chip" data-action="bet-chip" data-game="${g}" data-value="half">½</button>
      <button class="chip" data-action="bet-chip" data-game="${g}" data-value="double">×2</button>
      <button class="chip allin" data-action="bet-chip" data-game="${g}" data-value="all">🔥 Tapis</button>`;
    el(`bet-${g}`).addEventListener('change', e => { try { localStorage.setItem('k13-bet-' + g, e.target.value); } catch {} });
  });
}
function getBetPref(g) { try { return +localStorage.getItem('k13-bet-' + g) || 500; } catch { return 500; } }
function setBet(g, v) {
  const cur = betOf(g);
  v = v === 'all' ? (STATE.user?.points || 0) : v === 'half' ? Math.max(1, Math.floor(cur / 2)) : v === 'double' ? cur * 2 : v;
  el(`bet-${g}`).value = v; try { localStorage.setItem('k13-bet-' + g, v); } catch {} }
const betOf = g => parseInt(el(`bet-${g}`).value, 10) || 0;

async function loadGames() {
  renderBetRows();
  buildWheel();
  const r = await api('GET', '/api/user/games');
  if (!r.ok) return;
  GAMES.limits = r.limits;
  updateBalance(r.balance);
  renderGamesInfo();
  if (r.blackjack) renderBJ(r.blackjack); else renderBJ(null);
}
function renderGamesInfo() {
  const l = GAMES.limits; if (!l) return;
  el('games-info').innerHTML = STATE.gamesDisabled
    ? '🚫 Les jeux sont désactivés sur ton compte. <a href="#" data-page="profile">Les réactiver</a>'
    : (l.maxBet ? `Mise de ${l.minBet} à ${fmtNum(l.maxBet)} pts` : 'Mise libre : joue autant que tu veux, avec ce que tu veux 🎲') + (l.left === null ? '' : ` · <strong>${l.left}</strong> partie${l.left > 1 ? 's' : ''} restante${l.left > 1 ? 's' : ''} aujourd'hui`);
}
function updateBalance(points) {
  if (!STATE.user || points === undefined) return;
  STATE.user.points = points;
  ['nav-pts', 'games-pts', 'shop-pts'].forEach(id => { el(id).textContent = fmtNum(points) + ' pts'; });
  el('hero-pts').textContent = fmtNum(points);
}
function afterGame(r, resultId) {
  if (r.limits) { GAMES.limits = r.limits; renderGamesInfo(); }
  if (r.balance !== undefined) updateBalance(r.balance);
  const box = el(resultId);
  const playing = r.game === 'blackjack' && !r.done;
  box.className = 'game-result ' + (r.ok === false ? 'err' : playing || r.outcome === 'push' ? '' : r.win ? 'win' : 'lose');
  box.textContent = r.message;
  if (r.win && (r.payout >= r.bet * 3 || r.outcome === 'blackjack')) confetti();
  if (r.badge) showNewBadges([{ icon: r.badge === 'jackpot' ? '🎰' : '🃏', name: r.badge === 'jackpot' ? 'Jackpot' : 'Blackjack !' }]);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function playCoin(choice) {
  const coin = el('coin');
  coin.classList.remove('flip'); void coin.offsetWidth; coin.classList.add('flip');
  const [r] = await Promise.all([api('POST', '/api/user/games/coinflip', { bet: betOf('coin'), choice }), sleep(900)]);
  if (r.ok) coin.querySelector('.coin-face').textContent = r.result === 'pile' ? 'P' : 'F';
  coin.classList.remove('flip');
  afterGame(r, 'coin-result');
}

const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const numColor = n => n === 0 ? 'green' : RED.has(n) ? 'red' : 'black';
// Roulette européenne dessinée en SVG (ordre réel des cases). La roue tourne dans un sens,
// la bille dans l'autre, puis la bille descend et s'arrête dans la case tirée par le serveur.
const WHEEL_ORDER = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
const RW = { wheel: 0, ball: 0, spinning: false, last: [] };
const SEG = 360 / 37;
const polar = (r, deg) => { const a = deg * Math.PI / 180; return [r * Math.sin(a), -r * Math.cos(a)]; };
function ringPath(r1, r2, a0, a1) {
  const [x1, y1] = polar(r2, a0), [x2, y2] = polar(r2, a1), [x3, y3] = polar(r1, a1), [x4, y4] = polar(r1, a0);
  return `M${x1.toFixed(2)},${y1.toFixed(2)} A${r2},${r2} 0 0 1 ${x2.toFixed(2)},${y2.toFixed(2)} L${x3.toFixed(2)},${y3.toFixed(2)} A${r1},${r1} 0 0 0 ${x4.toFixed(2)},${y4.toFixed(2)}Z`;
}
function buildWheel() {
  const svg = el('wheel');
  if (!svg || svg.dataset.built) return;
  const fill = { red: '#C81E1E', black: '#151B26', green: '#0E8A5F' };
  let segs = '';
  WHEEL_ORDER.forEach((n, k) => {
    const a0 = (k - .5) * SEG, a1 = (k + .5) * SEG, c = fill[numColor(n)];
    segs += `<path d="${ringPath(104, 124, a0, a1)}" fill="${c}" stroke="#D4A84B" stroke-width=".8"/>`
      + `<path d="${ringPath(84, 104, a0, a1)}" fill="${c}" opacity=".78" stroke="#D4A84B" stroke-width="1.2"/>`
      + `<text transform="rotate(${(k * SEG).toFixed(2)}) translate(0,-114)" text-anchor="middle" dominant-baseline="central" font-size="10.5" font-weight="700" fill="#fff" font-family="Sora,sans-serif">${n}</text>`;
  });
  const spokes = [0, 90, 180, 270].map(d => `<rect x="-3" y="-62" width="6" height="56" rx="3" fill="url(#rw-gold)" transform="rotate(${d})"/>`).join('');
  svg.innerHTML = `<defs>
      <radialGradient id="rw-wood" r=".5"><stop offset=".86" stop-color="#3A2314"/><stop offset=".93" stop-color="#7A4A26"/><stop offset="1" stop-color="#2A170C"/></radialGradient>
      <radialGradient id="rw-cone" r=".5"><stop offset="0" stop-color="#C79A45"/><stop offset=".6" stop-color="#8A5A24"/><stop offset="1" stop-color="#4A2C14"/></radialGradient>
      <linearGradient id="rw-gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FDE68A"/><stop offset="1" stop-color="#B7791F"/></linearGradient>
      <radialGradient id="rw-ballg" cx=".35" cy=".35" r=".7"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#C9CED6"/></radialGradient>
    </defs>
    <circle r="148" fill="url(#rw-wood)"/>
    <circle r="142" fill="none" stroke="#B98A3E" stroke-width="2"/>
    <circle r="126" fill="#24170E"/>
    <g id="rw-rot">${segs}
      <circle r="84" fill="url(#rw-cone)"/>
      ${spokes}<circle r="12" fill="url(#rw-gold)"/><circle r="5" fill="#7C4A12"/>
    </g>
    <circle id="rw-ball" r="6" fill="url(#rw-ballg)" cx="0" cy="-134" style="filter:drop-shadow(0 1px 1px rgba(0,0,0,.6))"/>`;
  svg.dataset.built = '1';
  setWheel(RW.wheel, RW.ball, 134);
}
function setWheel(w, b, r) {
  el('rw-rot').setAttribute('transform', `rotate(${w.toFixed(3)})`);
  const [x, y] = polar(r, b);
  const ball = el('rw-ball'); ball.setAttribute('cx', x.toFixed(2)); ball.setAttribute('cy', y.toFixed(2));
}
const smooth = x => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };
function spinTo(n) {
  return new Promise(resolve => {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const D = reduce ? 1200 : 5600, k = WHEEL_ORDER.indexOf(n);
    const W0 = RW.wheel % 360, Wf = W0 + 720 + Math.random() * 360;
    // Angle final de la bille = case k de la roue à l'arrêt, après au moins 4 tours en sens inverse
    const target = Wf + k * SEG, base = RW.ball % 360 - 1440;
    const Bf = base - (((base - target) % 360) + 360) % 360;
    const M = Math.round((target - Bf) / 360);
    const B0 = RW.ball % 360;
    const t0 = performance.now();
    const frame = now => {
      const p = Math.min(1, (now - t0) / D);
      const W = W0 + (Wf - W0) * (1 - Math.pow(1 - p, 3));
      const free = B0 + (Bf - B0) * (1 - Math.pow(1 - p, 2.4));
      const inPocket = W + k * SEG - 360 * M;
      const s = smooth((p - .7) / .3);
      const B = free + (inPocket - free) * s;
      // La bille quitte la piste, rebondit sur les losanges puis tombe dans la case
      const drop = smooth((p - .55) / .25);
      const bounce = p > .62 && p < .9 ? Math.abs(Math.sin((p - .62) * 34)) * 7 * (1 - (p - .62) / .28) : 0;
      setWheel(W, B, 134 - 40 * drop + bounce);
      if (p < 1) requestAnimationFrame(frame);
      else { RW.wheel = Wf; RW.ball = Bf; resolve(); }
    };
    requestAnimationFrame(frame);
  });
}
function showRouletteNumber(n) {
  const c = el('rw-center');
  c.className = 'rw-center show ' + numColor(n); c.textContent = n;
  RW.last = [n, ...RW.last].slice(0, 8);
  el('rw-last').innerHTML = RW.last.map(x => `<span class="rw-chip ${numColor(x)}">${x}</span>`).join('');
}
async function playRoulette(type, value) {
  if (RW.spinning) return;
  buildWheel();
  const r = await api('POST', '/api/user/games/roulette', { bet: betOf('roulette'), type, value });
  if (!r.ok) return afterGame(r, 'roulette-result');
  RW.spinning = true;
  el('rw-center').className = 'rw-center';
  el('roulette-result').className = 'game-result'; el('roulette-result').textContent = '🎡 Les jeux sont faits, rien ne va plus…';
  try { await spinTo(r.number); } finally { RW.spinning = false; }
  showRouletteNumber(r.number);
  afterGame(r, 'roulette-result');
}

function cardHTML(c, i = 0) {
  if (c === '🂠') return `<div class="pcard back" style="animation-delay:${i * 80}ms"></div>`;
  const suit = c.slice(-1), rank = c.slice(0, -1), red = suit === '♥' || suit === '♦';
  return `<div class="pcard ${red ? 'red' : ''}" style="animation-delay:${i * 80}ms"><span>${rank}</span><span class="suit">${suit}</span></div>`;
}
function renderBJ(g) {
  el('bj-dealer').innerHTML = g ? g.dealer.map(cardHTML).join('') : '';
  el('bj-dealer-val').textContent = g ? `(${g.dealerValue}${g.done ? '' : '+?'})` : '';
  const hands = g?.hands || [{ cards: [], value: null }], multi = hands.length > 1;
  const TAG = { win: '✅', blackjack: '✅', push: '🤝', lose: '❌', bust: '💥' };
  el('bj-hands').classList.toggle('multi', multi);
  el('bj-hands').innerHTML = hands.map((h, n) => `<div class="bj-hand ${multi && g && !g.done && n === g.active ? 'active' : ''}">
    <div class="bj-label">${multi ? `Main ${n + 1}` : 'Toi'} ${h.value !== null ? `(${h.value})` : ''}${multi ? ` · ${fmtNum(h.bet)} pts` : ''}${h.doubled ? ' · doublée' : ''} ${h.outcome ? TAG[h.outcome] : ''}</div>
    <div class="bj-cards">${h.cards.map(cardHTML).join('')}</div></div>`).join('');
  const playing = g && !g.done;
  el('bj-actions').classList.toggle('hidden', !playing);
  el('bj-start-row').classList.toggle('hidden', !!playing);
  el('bj-bet').classList.toggle('hidden', !!playing);
  if (playing) { el('bj-double').disabled = !g.canDouble; el('bj-split').disabled = !g.canSplit; }
}
async function bjStart() {
  const r = await api('POST', '/api/user/games/blackjack/start', { bet: betOf('bj') });
  if (r.ok) renderBJ(r);
  afterGame(r, 'bj-result');
}
async function bjMove(move) {
  const r = await api('POST', `/api/user/games/blackjack/${move}`);
  if (r.ok) renderBJ(r);
  afterGame(r, 'bj-result');
}

function confetti() {
  const colors = ['#F59E0B', '#2563EB', '#10B981', '#EF4444', '#A855F7'];
  for (let i = 0; i < 70; i++) {
    const c = document.createElement('i');
    c.className = 'confetti';
    c.style.cssText = `left:${Math.random() * 100}vw;background:${colors[i % colors.length]};animation-delay:${Math.random() * .5}s`;
    document.body.appendChild(c);
    setTimeout(() => c.remove(), 3500);
  }
}

// ── Navigation ─────────────────────────────────────────────────────────────────
function showPage(id, push = true) {
  if (!el('page-' + id)) id = 'dashboard';
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + id));
  document.querySelectorAll('.nav-link[data-page]').forEach(b => b.classList.toggle('active', b.dataset.page === id));
  if (id === 'games') loadGames();
  if (id === 'profile') loadProfile();
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
