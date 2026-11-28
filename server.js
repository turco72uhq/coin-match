// Bot Coin Match : se connecte à un live TikTok avec un pseudo
// et envoie les cadeaux / viewers à la page http://localhost:3000
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { TikTokLiveConnection, WebcastEvent, ControlEvent } from 'tiktok-live-connector';

const PORT = Number(process.env.PORT) || 3000;
// En ligne : ADMIN_KEY = mot de passe pour les boutons, TIKTOK_USER = pseudo à suivre automatiquement
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const AUTO_USER = process.env.TIKTOK_USER || '';
const dir = path.dirname(fileURLToPath(import.meta.url));

// ---------- petit serveur web pour la page ----------
const server = http.createServer((req, res) => {
  const file = path.join(dir, 'public', 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(500); return res.end('Page introuvable'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
const send = (obj) => {
  const txt = JSON.stringify(obj);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(txt); });
};

let live = null;
let pseudo = '';
let status = { connected: false, text: 'Pas connecté' };
const setStatus = (connected, text) => { status = { connected, text, pseudo }; send({ type: 'status', ...status }); console.log('[bot]', text); };

// Prix de secours des cadeaux les plus courants (si TikTok n'envoie pas le prix)
const KNOWN = { 5655: { name: 'Rose', diamond_count: 1 }, 5269: { name: 'TikTok', diamond_count: 1 } };

const userInfo = (u = {}) => ({
  uid: u.uniqueId || u.displayId || u.userId || u.idStr || 'inconnu',
  name: u.nickname || u.uniqueId || u.displayId || 'Anonyme',
  avatar: u.profilePictureUrl
    || u.profilePicture?.url?.[0] || u.profilePicture?.urls?.[0]
    || u.avatarThumb?.url?.[0] || u.avatarThumb?.urlList?.[0] || ''
});

async function connectTo(name) {
  name = String(name || '').trim().replace(/^@/, '');
  if (!name) return setStatus(false, 'Mets ton pseudo TikTok');
  await disconnect();
  pseudo = name;
  setStatus(false, `Connexion au live de @${name}…`);

  const conn = new TikTokLiveConnection(name, { enableExtendedGiftInfo: false });
  live = conn;

  // Liste des cadeaux du live (nom, prix, image), chargée après la connexion
  let catalog = new Map();
  conn.on(WebcastEvent.GIFT, (d) => {
    const g = d.giftDetails || {};
    const ext = d.extendedGiftInfo || catalog.get(Number(d.giftId)) || KNOWN[d.giftId] || {};
    if (!g.diamondCount && !ext.diamond_count && !ext.diamondCount) console.log('[bot] cadeau sans prix, id', d.giftId);
    send({
      type: 'gift',
      ...userInfo(d.user),
      giftId: d.giftId,
      giftName: g.giftName || ext.name || 'Cadeau',
      giftImg: g.giftImage?.url?.[0] || g.giftImage?.urlList?.[0] || ext.image?.url_list?.[0] || '',
      diamond: Number(g.diamondCount || ext.diamond_count || ext.diamondCount || 0),
      count: Math.max(1, Number(d.repeatCount || 1)),
      streakable: (g.giftType || ext.type || 1) === 1, // type inconnu = traité comme un combo (pas de double comptage)
      end: !!d.repeatEnd,
      groupId: String(d.groupId ?? '')
    });
  });

  conn.on(WebcastEvent.ROOM_USER, (d) => send({ type: 'viewers', count: Number(d.viewerCount ?? d.total ?? 0) }));
  conn.on(WebcastEvent.MEMBER, (d) => send({ type: 'join', ...userInfo(d.user) }));
  conn.on(WebcastEvent.STREAM_END, () => setStatus(false, 'Le live est terminé'));
  conn.on(ControlEvent.DISCONNECTED, () => { if (live === conn) { live = null; setStatus(false, 'Déconnecté du live, reconnexion…'); } });

  try {
    await conn.connect();
    if (live === conn) setStatus(true, `Connecté au live de @${name}`);
    try {
      const list = await conn.fetchAvailableGifts();
      const arr = Array.isArray(list) ? list : (list?.gifts || list?.data?.gifts || []);
      catalog = new Map(arr.map(x => [Number(x.id), x]));
      console.log('[bot] liste des cadeaux chargée :', catalog.size);
    } catch (e) { console.log('[bot] liste des cadeaux indisponible :', String(e?.message || e).slice(0, 120)); }
  } catch (e) {
    const msg = String(e?.message || e);
    if (/offline|not.*live|UserOffline/i.test(msg) || e?.constructor?.name === 'UserOfflineError')
      setStatus(false, `@${name} n'est pas en live. Lance ton live puis reconnecte.`);
    else if (/Room ID/i.test(msg))
      setStatus(false, `Live de @${name} introuvable : vérifie le pseudo et que tu es bien en live.`);
    else setStatus(false, 'Connexion impossible : ' + msg.slice(0, 140));
    if (live === conn) live = null;
  }
}

async function disconnect() {
  if (live) { const c = live; live = null; try { await c.disconnect(); } catch {} }
}

// Faux cadeaux pour tester (envoyés à toutes les pages)
const TEST = [{giftName:'Rose',diamond:1,streakable:true},{giftName:'Donut',diamond:30,streakable:true},{giftName:'Galaxy',diamond:1000},{giftName:'Lion',diamond:29999},{giftName:'Perfume',diamond:20,streakable:true}];
const FANS = ['Test User','Test User 2','Test User 3','RobloxPro','TuTi'];
function fakeGift() {
  const t = TEST[Math.random()*TEST.length|0], n = FANS[Math.random()*FANS.length|0];
  const base = { type:'gift', ...t, uid:n, name:n, avatar:'', giftId:t.giftName, groupId:String(Date.now()), giftImg:'' };
  if (!t.streakable) return send({ ...base, count:1, end:true });
  const max = 1 + (Math.random()*8|0); let i = 1;
  const iv = setInterval(() => { send({ ...base, count:i, end:i===max }); if (++i > max) clearInterval(iv); }, 200);
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'status', ...status }));
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (ADMIN_KEY && m.key !== ADMIN_KEY) {
      if (m.type !== 'ping') ws.send(JSON.stringify({ type: 'status', ...status, text: 'Mauvaise clé : ajoute ?cle=TA_CLE à l\'adresse' }));
      return;
    }
    if (m.type === 'connect') { paused = false; wanted = String(m.username || '').trim().replace(/^@/, ''); connectTo(m.username); }
    if (m.type === 'disconnect') { paused = true; disconnect().then(() => setStatus(false, 'Déconnecté')); }
    // Boutons de la page de contrôle -> envoyés à toutes les pages (dont l'overlay du live)
    if (m.type === 'cmd' && ['start', 'stop', 'reset'].includes(m.cmd))
      send({ type: 'cmd', cmd: m.cmd, dur: Number(m.dur) || 120, snipe: Number(m.snipe) || 0 });
    if (m.type === 'cmd' && m.cmd === 'test') fakeGift();
  });
});

// Reconnexion automatique : au dernier pseudo utilisé (sinon TIKTOK_USER), toutes les 20 s si déconnecté
let wanted = AUTO_USER;
let busy = false;
let paused = false; // vrai si tu as cliqué « Déconnecter »
const retry = async () => {
  const target = wanted || AUTO_USER;
  if (paused || !target || busy || status.connected || (live && live.isConnecting)) return;
  busy = true; try { await connectTo(target); } finally { busy = false; }
};
setTimeout(retry, 2000); setInterval(retry, 20000);

server.listen(PORT, () => {
  console.log('');
  console.log('  Coin Match est lancé !');
  console.log(`  Ouvre http://localhost:${PORT} dans Chrome`);
  console.log('  Laisse cette fenêtre ouverte pendant ton live.');
  console.log('');
});
