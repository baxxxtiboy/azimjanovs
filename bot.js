'use strict';

/**
 * Musiqa topib beruvchi Telegram bot (Node.js + Telegraf + yt-dlp)
 *
 * Ishlashi:
 * 1) Foydalanuvchi qo'shiq nomini (yoki ijrochi + qo'shiq) yozadi
 * 2) Bot natijalarni tugmalar bilan chiqaradi
 * 3) Tugma bosilsa, qo'shiq audio fayl ko'rinishida yuboriladi
 *    (YouTube havolasini yuborsa ham ishlaydi)
 */

require('dotenv').config();

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Telegraf } = require('telegraf');
const youtubedl = require('youtube-dl-exec');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('BOT_TOKEN topilmadi. .env faylga BOT_TOKEN=... deb yozing.');
  process.exit(1);
}

// ---------------- Sozlamalar ----------------
const MAX_RESULTS = 8;                    // nechta natija ko'rsatilsin
const MAX_DURATION = 15 * 60;             // eng uzun qo'shiq (soniyada) - 15 daqiqa
const MAX_FILE_SIZE = 49 * 1024 * 1024;   // Telegram bot limiti ~50 MB
const MAX_PARALLEL_DOWNLOADS = 3;         // bir vaqtda nechta yuklash

// ffmpeg bo'lsa MP3, bo'lmasa M4A yuboriladi
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

const YT_LINK_RE =
  /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|shorts\/|embed\/))([A-Za-z0-9_-]{11})/;

const fileIdCache = new Map(); // bir marta yuborilgan qo'shiqni qayta yuklamaslik uchun
let botUsername = '';

class MusicError extends Error {}

// Bir vaqtda ko'p yuklashni cheklash uchun oddiy semafor
class Semaphore {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.queue = [];
  }
  async acquire() {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
  }
  release() {
    const next = this.queue.shift();
    if (next) next(); // joy navbatdagi so'rovga o'tadi
    else this.active--;
  }
}
const slots = new Semaphore(MAX_PARALLEL_DOWNLOADS);

// ---------------- Yordamchi funksiyalar ----------------
const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function formatDuration(totalSeconds) {
  if (!totalSeconds) return '--:--';
  const t = Math.floor(totalSeconds);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0');
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function safeFilename(name) {
  const cleaned = String(name).replace(/[\\/:*?"<>|]+/g, '').trim();
  return cleaned.slice(0, 60) || 'music';
}

// ---------------- yt-dlp ----------------
async function searchMusic(query) {
  const info = await youtubedl(`ytsearch${MAX_RESULTS}:${query}`, {
    dumpSingleJson: true,
    flatPlaylist: true,
    noWarnings: true,
  });
  return (info.entries || [])
    .filter((e) => e && e.id)
    .map((e) => ({
      id: e.id,
      title: e.title || "Noma'lum",
      duration: e.duration,
    }));
}

async function downloadMusic(videoId, outDir) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  const info = await youtubedl(url, {
    dumpSingleJson: true,
    noPlaylist: true,
    noWarnings: true,
  });
  if (info.is_live) {
    throw new MusicError("Jonli efirni yuklab bo'lmaydi.");
  }
  if ((info.duration || 0) > MAX_DURATION) {
    throw new MusicError(
      `Bu video juda uzun (maksimum ${MAX_DURATION / 60} daqiqa). Boshqasini tanlang.`
    );
  }

  const flags = {
    output: path.join(outDir, '%(id)s.%(ext)s'),
    noPlaylist: true,
    noWarnings: true,
    ...(HAS_FFMPEG
      ? {
          format: 'bestaudio/best',
          extractAudio: true,
          audioFormat: 'mp3',
          audioQuality: '192K',
        }
      : { format: 'bestaudio[ext=m4a]/bestaudio/best' }),
  };
  await youtubedl(url, flags);

  const fileName = fs
    .readdirSync(outDir)
    .find((f) => f.startsWith(`${videoId}.`) && !f.endsWith('.part') && !f.endsWith('.ytdl'));
  if (!fileName) throw new MusicError("Faylni yuklab bo'lmadi.");

  const filePath = path.join(outDir, fileName);
  if (fs.statSync(filePath).size > MAX_FILE_SIZE) {
    throw new MusicError('Fayl Telegram limitidan (50 MB) katta. Boshqa variantni tanlang.');
  }

  return {
    filePath,
    title: info.track || info.title || "Noma'lum",
    performer: info.artist || info.uploader || '',
    duration: Math.floor(info.duration || 0),
  };
}

// ---------------- Yuborish ----------------
async function sendMusic(telegram, chatId, videoId) {
  const caption = `🎧 @${botUsername}`;

  const cached = fileIdCache.get(videoId);
  if (cached) {
    await telegram.sendAudio(chatId, cached, { caption });
    return;
  }

  const status = await telegram.sendMessage(chatId, '⏳ Yuklab olinmoqda, biroz kuting...');
  let tmpDir;
  await slots.acquire();
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'musicbot-'));
    const data = await downloadMusic(videoId, tmpDir);

    await telegram.sendChatAction(chatId, 'upload_voice').catch(() => {});
    const sent = await telegram.sendAudio(
      chatId,
      {
        source: data.filePath,
        filename: `${safeFilename(data.title)}${path.extname(data.filePath)}`,
      },
      {
        title: data.title.slice(0, 64),
        performer: data.performer.slice(0, 64) || undefined,
        duration: data.duration || undefined,
        caption,
      }
    );
    if (sent && sent.audio) fileIdCache.set(videoId, sent.audio.file_id);
  } catch (err) {
    if (err instanceof MusicError) {
      await telegram.sendMessage(chatId, `⚠️ ${err.message}`).catch(() => {});
    } else {
      console.error('Yuklashda xatolik:', videoId, err.stderr || err.message || err);
      await telegram
        .sendMessage(
          chatId,
          "❌ Yuklab bo'lmadi. Boshqa variantni tanlang yoki birozdan keyin qayta urinib ko'ring."
        )
        .catch(() => {});
    }
  } finally {
    slots.release();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    telegram.deleteMessage(chatId, status.message_id).catch(() => {});
  }
}

// ---------------- Bot ----------------
const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
  const name = escapeHtml(ctx.from.first_name || "do'stim");
  return ctx.reply(
    `Salom, <b>${name}</b>! 👋\n\n` +
      'Men musiqa topib beraman 🎵\n' +
      "Qo'shiq nomini yoki ijrochi + qo'shiq nomini yozing, masalan:\n" +
      '<code>Shahzoda Yurak</code>\n' +
      '<code>Ed Sheeran Perfect</code>\n\n' +
      "YouTube havolasini yuborsangiz ham bo'ladi.",
    { parse_mode: 'HTML' }
  );
});

bot.help((ctx) =>
  ctx.reply(
    'ℹ️ <b>Qanday ishlatiladi?</b>\n' +
      "1. Qo'shiq nomini yozing\n" +
      '2. Natijalardan keraklisini tanlang\n' +
      "3. Bot qo'shiqni audio qilib yuboradi\n\n" +
      `Maksimal davomiylik: ${MAX_DURATION / 60} daqiqa.`,
    { parse_mode: 'HTML' }
  )
);

bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;

  // YouTube havolasi yuborilsa, to'g'ridan-to'g'ri yuklaymiz
  const link = text.match(YT_LINK_RE);
  if (link) {
    sendMusic(ctx.telegram, ctx.chat.id, link[1]).catch(console.error);
    return;
  }

  if (text.length < 2) {
    return ctx.reply("Iltimos, qo'shiq nomini to'liqroq yozing.");
  }

  const chatId = ctx.chat.id;
  const status = await ctx.reply('🔎 Qidiryapman...');
  const editStatus = (msg, extra = {}) =>
    ctx.telegram.editMessageText(chatId, status.message_id, undefined, msg, {
      parse_mode: 'HTML',
      ...extra,
    });

  let results;
  try {
    results = await searchMusic(text);
  } catch (err) {
    console.error('Qidiruvda xatolik:', text, err.stderr || err.message || err);
    return editStatus("❌ Qidirishda xatolik bo'ldi. Birozdan keyin qayta urinib ko'ring.");
  }

  if (!results.length) {
    return editStatus("😕 Hech narsa topilmadi. Boshqacha yozib ko'ring.");
  }

  const inline_keyboard = results.map((r) => [
    {
      text: `🎵 ${r.title.slice(0, 48)} • ${formatDuration(r.duration)}`,
      callback_data: `dl:${r.id}`,
    },
  ]);

  return editStatus(
    `🎶 <b>${escapeHtml(text)}</b> bo'yicha natijalar:\n\nKerakli qo'shiqni tanlang 👇`,
    { reply_markup: { inline_keyboard } }
  );
});

bot.action(/^dl:([A-Za-z0-9_-]{11})$/, async (ctx) => {
  await ctx.answerCbQuery('Yuklanmoqda…').catch(() => {});
  // Uzoq davom etadigan ishni kutmaymiz, bot boshqa foydalanuvchilarga ham javob bera olsin
  sendMusic(ctx.telegram, ctx.chat.id, ctx.match[1]).catch(console.error);
});

bot.catch((err) => console.error('Bot xatosi:', err));

// ---------------- Ishga tushirish ----------------
(async () => {
  const me = await bot.telegram.getMe();
  botUsername = me.username;

  bot.launch({ dropPendingUpdates: true }).catch((err) => {
    console.error('Bot to\'xtadi:', err);
    process.exit(1);
  });

  console.log(
    `Bot ishga tushdi: @${botUsername} | ffmpeg: ${HAS_FFMPEG ? 'bor (MP3)' : "yo'q (M4A)"}`
  );
})().catch((err) => {
  console.error('Ishga tushmadi (tokenni tekshiring):', err.message);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
