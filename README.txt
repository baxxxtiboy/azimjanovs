MUSIQA TOPIB BERUVCHI TELEGRAM BOT (Node.js)
============================================

1) Telegramda @BotFather ga /newbot yozing va token oling.

2) ".env.example" faylining nomini ".env" ga o'zgartiring,
   ichidagi yozuvni o'z tokeningiz bilan almashtiring:
   BOT_TOKEN=123456:ABC...

3) Terminalda (VS Code) shu papkada:
   npm install
   npm start

4) Botga qo'shiq nomini yozing, masalan: Ed Sheeran Perfect

Eslatmalar:
- Node.js 18 yoki yuqori versiya kerak (node -v bilan tekshiring).
- npm install vaqtida yt-dlp avtomatik yuklanadi (internet kerak).
  Windows'da qo'shimcha narsa kerak emas. Linux/Mac'da python3 kerak.
- ffmpeg o'rnatilgan bo'lsa MP3, bo'lmasa M4A yuboriladi.
- Bot ishlamay qolsa yt-dlp ni yangilang: npm rebuild youtube-dl-exec
  (yoki: npm install youtube-dl-exec@latest)
- Kompyuter o'chsa bot ham o'chadi (doimiy ishlashi uchun serverga qo'yiladi).
