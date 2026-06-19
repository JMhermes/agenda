const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const app = express();
const PORT = process.env.PORT || 8082;

// ── Config ─────────────────────────────────
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '8869186406';
const TAREAS_FILE = path.join(__dirname, 'data', 'tareas.json');
const MSG_MAP_FILE = path.join(__dirname, 'data', 'msg_map.json');

// Asegurar que exista el directorio data/
try { fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true }); } catch(e) {}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Health check para monitoreo
app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

function sendTelegram(text, buttons) {
  if (!TELEGRAM_BOT_TOKEN) return;
  const payload = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' };
  if (buttons) payload.reply_markup = { inline_keyboard: buttons };
  const data = JSON.stringify(payload);
  const options = {
    hostname: 'api.telegram.org',
    path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
  };
  const req = https.request(options);
  req.on('error', (e) => console.error('Telegram error:', e.message));
  req.write(data);
  req.end();
}

function getHoraRD() {
  const now = new Date();
  const rd = new Date(now.getTime() - 4 * 60 * 60 * 1000);
  return {
    hora: String(rd.getHours()).padStart(2, '0') + ':' + String(rd.getMinutes()).padStart(2, '0'),
    fecha: rd.toISOString().slice(0, 10)
  };
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function loadTareas() {
  try { return JSON.parse(fs.readFileSync(TAREAS_FILE, 'utf8')); } catch(e) { return []; }
}

function saveTareas(tasks) {
  fs.writeFileSync(TAREAS_FILE, JSON.stringify(tasks, null, 2));
}

app.post('/api/sync', (req, res) => {
  try {
    const agendas = req.body;
    const { hora: horaActual, fecha: hoy } = getHoraRD();
    const notificaciones = [];
    let nextId = 1;

    (agendas || []).forEach(agenda => {
      (agenda.tareas || []).forEach(t => {
        if (!t.hecho && t.hora) {
          notificaciones.push({
            id: nextId++, nombre: t.texto,
            descripcion: `Agenda: ${agenda.nombre}`,
            hora: t.hora, fecha: hoy,
            notificada: false, activa: true,
            repetir: t.repetir === true
          });
        }
      });
    });

    let existentes = loadTareas();
    const existentesMap = new Map();
    existentes.forEach(e => existentesMap.set(`${e.hora}_${e.nombre}`, e));

    const resultado = [];
    const seen = new Set();

    notificaciones.forEach(n => {
      const key = `${n.hora}_${n.nombre}`;
      const old = existentesMap.get(key);
      if (old && old.notificada) {
        n.notificada = true;
        n.notificado_en = old.notificado_en;
      }
      resultado.push(n);
      seen.add(key);
    });

    existentes.forEach(e => {
      const key = `${e.hora}_${e.nombre}`;
      if (!seen.has(key) && e.notificada) {
        resultado.push(e);
        seen.add(key);
      }
    });

    // Notificar si es la hora exacta
    const completadas = [];
    notificaciones.forEach(n => {
      const old = existentesMap.get(`${n.hora}_${n.nombre}`);
      if (old && old.hecho_desde_telegram) {
        completadas.push(n.nombre);
      }
      if (!n.notificada && n.hora === horaActual && n.fecha === hoy) {
        sendTelegram(
          `⏰ Recordatorio: Es hora de ${n.nombre}. Detalles: ${n.descripcion}\n\nResponde con 👍 para marcar como hecha`,
          [[{ text: '✅ Hecho', callback_data: `done_${n.nombre.substring(0,30)}` }]]
        );
        n.notificada = true;
        n.notificado_en = new Date().toISOString();
        console.log('⚡ Notificación instantánea:', n.nombre);
      }
    });

    // Resetear tareas repetitivas
    const todas = loadTareas();
    let changed = false;
    todas.forEach(t => {
      if (t.repetir && t.fecha !== hoy) {
        t.notificada = false;
        t.fecha = hoy;
        t.hecho_desde_telegram = false;
        delete t.notificado_en;
        changed = true;
      }
    });
    if (changed) {
      saveTareas(todas);
      resultado.length = 0;
      todas.forEach(t => resultado.push(t));
    }

    saveTareas(resultado);

    // Escanear hecho_desde_telegram
    const todas2 = loadTareas();
    todas2.forEach(t => {
      if (t.hecho_desde_telegram && !completadas.includes(t.nombre)) {
        completadas.push(t.nombre);
      }
    });

    res.json({ ok: true, count: notificaciones.length, completadas });
  } catch (e) {
    console.error('Error en /api/sync:', e);
    res.status(500).json({ error: e.message });
  }
});

// Marcar tarea como hecha desde Telegram
app.get('/api/hecho/:taskName', (req, res) => {
  try {
    const taskName = decodeURIComponent(req.params.taskName);
    let tasks = loadTareas();
    let encontrada = false;
    tasks.forEach(t => {
      if (t.nombre.toLowerCase() === taskName.toLowerCase() && !t.notificada) {
        t.notificada = true;
        t.notificado_en = new Date().toISOString();
        t.hecho_desde_telegram = true;
        encontrada = true;
      }
    });
    if (encontrada) {
      saveTareas(tasks);
      res.send(`<html><body style="background:#0a0a0a;color:#22c55e;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;text-align:center"><div><h1>✅ Hecho</h1><p style="color:#888">${taskName}</p><p><small>Vuelve a Telegram</small></p></div></body></html>`);
    } else {
      res.send(`<html><body style="background:#0a0a0a;color:#ef4444;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;text-align:center"><div><h1>⚠️ Ya estaba</h1><p style="color:#888">${taskName}</p><p><small>Vuelve a Telegram</small></p></div></body></html>`);
    }
  } catch(e) {
    res.status(500).send('Error');
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('═══════════════════════════════════════');
  console.log('  AGENDA DIARIA - Puerto ' + PORT);
  console.log('═══════════════════════════════════════');
  console.log(`  Web: http://localhost:${PORT}`);
  console.log('═══════════════════════════════════════');

  // ── Detectar 👍 y callback queries en Telegram ──
  let pollOffset = 0;

  setInterval(() => {
    if (!TELEGRAM_BOT_TOKEN) return;

    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${pollOffset}&timeout=1&allowed_updates=["message","callback_query"]`;
    https.get(url, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (!data.ok) return;
          let maxO = pollOffset;
          for (const upd of data.result || []) {
            maxO = Math.max(maxO, upd.update_id + 1);
            const msg = upd.message || {};
            const cq = upd.callback_query || {};
            const text = (msg.text || cq.data || '').trim();

            // Callback ✅ Hecho
            if (cq.data && cq.data.startsWith('done_')) {
              const taskName = cq.data.substring(5);
              let tasks = loadTareas();
              let marked = false;
              for (const t of tasks) {
                if (t.activa && t.nombre === taskName) {
                  t.notificada = true;
                  t.hecho_desde_telegram = true;
                  t.notificado_en = new Date().toISOString();
                  marked = true;
                  break;
                }
              }
              if (marked) {
                saveTareas(tasks);
                const answerUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery?callback_query_id=${cq.id}&text=✅+Hecho!`;
                https.get(answerUrl, () => {}).on('error', () => {});
                sendTelegram(`✅ Tarea marcada como hecha: ${taskName}`);
                console.log('✅ Callback:', taskName);
              }
              continue;
            }

            // 👍 Marcar tarea como hecha
            if (text.includes('👍')) {
              let tasks = loadTareas();
              let marked = false;
              let idx = -1;
              // Buscar la tarea no notificada más cercana (por orden de hora)
              for (let i = 0; i < tasks.length; i++) {
                const t = tasks[i];
                if (t.activa && !t.notificada) {
                  marked = t.nombre;
                  tasks[i].notificada = true;
                  tasks[i].hecho_desde_telegram = true;
                  tasks[i].notificado_en = new Date().toISOString();
                  break;
                }
              }
              if (marked) {
                saveTareas(tasks);
                sendTelegram(`✅ Tarea marcada como hecha: ${marked}`);
                console.log('👍 Hecho:', marked);
              }
            }
          }
          if (maxO > pollOffset) pollOffset = maxO;
        } catch(e) {}
      });
    }).on('error', () => {});
  }, 5000);
});
