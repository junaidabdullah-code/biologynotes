'use strict';

/**
 * BiologyNotes — production single-file Node.js application.
 * Stack: Express · express-session · connect-mongo · Multer · Mongoose · dotenv · Helmet · Cloudinary
 * SEO: Per-page metadata · Open Graph · Twitter Cards · JSON-LD · sitemap.xml · robots.txt
 *
 * Run with: node server.js
 */

require('dotenv').config();

/* ------------------------------------------------------------------ *
 * DNS FIX
 * ------------------------------------------------------------------ */
const dns = require('dns');
try {
  dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);
  if (typeof dns.setDefaultResultOrder === 'function') dns.setDefaultResultOrder('ipv4first');
  console.log('[biologynotes] DNS resolvers set');
} catch (e) { console.warn('[biologynotes] DNS override failed:', e.message); }

const express = require('express');
const session = require('express-session');
const multer = require('multer');
const mongoose = require('mongoose');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cloudinary = require('cloudinary').v2;

/* ------------------------------------------------------------------ *
 * connect-mongo tolerant loader
 * ------------------------------------------------------------------ */
let MongoStore;
(function loadMongoStore() {
  const mod = require('connect-mongo');
  const candidate = mod && mod.default ? mod.default : mod;
  if (candidate && typeof candidate.create === 'function') { MongoStore = candidate; return; }
  if (typeof mod === 'function') {
    try {
      const v3 = mod(session);
      MongoStore = { create(opts) { return new v3(opts); } };
      console.warn('[biologynotes] Legacy connect-mongo v3 — shimmed.');
      return;
    } catch (e) {}
  }
  throw new Error('connect-mongo export shape not recognised. Run: npm i connect-mongo@5.1.0');
})();

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */
const PORT = parseInt(process.env.PORT, 10) || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'biologynotes-insecure-dev-secret-change-me';
const MONGO_URI = process.env.MONGO_URI;
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';

// Public site URL — used for canonical URLs, sitemap, OG tags.
// Set SITE_URL in .env to your real domain (no trailing slash).
const SITE_URL = (process.env.SITE_URL || 'http://localhost:' + PORT).replace(/\/+$/, '');

const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;

if (!MONGO_URI) { console.error('\n[FATAL] MONGO_URI missing.\n'); process.exit(1); }
if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
  console.error('\n[FATAL] Cloudinary env vars missing.\n');
  process.exit(1);
}

cloudinary.config({
  cloud_name: CLOUDINARY_CLOUD_NAME,
  api_key: CLOUDINARY_API_KEY,
  api_secret: CLOUDINARY_API_SECRET,
  secure: true
});

const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MAX_FILE_SIZE = 100 * 1024 * 1024;
const MAX_AVATAR_SIZE = 4 * 1024 * 1024;
const A4_THUMB_W = 620;
const A4_THUMB_H = 877;
const MAX_TAGS = 3;
const MAX_COMMENT_LEN = 1000;

/* ------------------------------------------------------------------ *
 * Favicon + meta
 * ------------------------------------------------------------------ */
const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
    '<rect width="64" height="64" fill="#18181b"/>' +
    '<g fill="none" stroke="#fafafa" stroke-width="4" stroke-linecap="round">' +
      '<path d="M22 12c0 10 20 30 20 40"/>' +
      '<path d="M42 12c0 10-20 30-20 40"/>' +
      '<path d="M24 22h16"/>' +
      '<path d="M22 32h20"/>' +
      '<path d="M24 42h16"/>' +
    '</g>' +
  '</svg>';

const FAVICON_DATA_URI = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(FAVICON_SVG);

const GOOGLE_VERIFICATION_META =
  '<meta name="google-site-verification" content="DWCXYjGiC1wcfs-PwgwpSYUoAASJLNUOMR3tQ7f9Nos" />';

/* ------------------------------------------------------------------ *
 * Schemas
 * ------------------------------------------------------------------ */
const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    username: { type: String, required: true, unique: true, trim: true, index: true },
    passwordHash: { type: String, required: true },
    avatarUrl: { type: String, default: '' },
    avatarPublicId: { type: String, default: '' },
    subscribers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    subscribedTo: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
  },
  { timestamps: true }
);

const ratingSchema = new mongoose.Schema(
  { user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, value: { type: Number, min: 1, max: 5, required: true }, createdAt: { type: Date, default: Date.now } },
  { _id: false }
);

const commentSchema = new mongoose.Schema(
  { user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, username: { type: String, required: true }, name: { type: String, required: true }, avatarUrl: { type: String, default: '' }, text: { type: String, required: true, maxlength: MAX_COMMENT_LEN }, createdAt: { type: Date, default: Date.now } }
);

const fileSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    ownerUsername: { type: String, required: true, index: true },
    kind: { type: String, enum: ['note', 'other'], default: 'note', index: true },
    chapterNo: { type: String, default: '', trim: true, maxlength: 20 },
    chapterName: { type: String, required: true, trim: true, maxlength: 200 },
    subject: { type: String, default: '', trim: true, maxlength: 120 },
    writer: { type: String, default: '', trim: true, maxlength: 120 },
    description: { type: String, default: '', maxlength: 2000 },
    tags: { type: [String], default: [] },
    visibility: { type: String, enum: ['public', 'private'], default: 'public', index: true },
    originalName: { type: String, required: true, maxlength: 300 },
    storedName: { type: String, required: true },
    fileUrl: { type: String, required: true },
    resourceType: { type: String, default: 'image' },
    thumbnailUrl: { type: String, default: '' },
    size: { type: Number, required: true, min: 0 },
    mimeType: { type: String, default: 'application/octet-stream' },
    downloads: { type: Number, default: 0 },
    views: { type: Number, default: 0 },
    ratings: [ratingSchema],
    comments: [commentSchema]
  },
  { timestamps: true }
);

fileSchema.index({ createdAt: -1 });
fileSchema.index({ downloads: -1 });
fileSchema.index({ chapterName: 'text', subject: 'text', writer: 'text', description: 'text', tags: 'text' });

const User = mongoose.model('User', userSchema);
const File = mongoose.model('File', fileSchema);

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */
function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeXml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, stored) {
  try {
    const parts = String(stored).split(':');
    if (parts.length !== 2) return false;
    const [salt, digest] = parts;
    const expected = Buffer.from(digest, 'hex');
    const actual = crypto.scryptSync(password, salt, 64);
    if (expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(expected, actual);
  } catch (err) { return false; }
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(ts) {
  try { return new Date(ts).toLocaleString('en-US', { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  catch (err) { return ''; }
}

function timeAgo(ts) {
  try {
    const diff = Date.now() - new Date(ts).getTime();
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return 'just now';
    const min = Math.floor(sec / 60); if (min < 60) return min + 'm ago';
    const hr = Math.floor(min / 60); if (hr < 24) return hr + 'h ago';
    const day = Math.floor(hr / 24); if (day < 30) return day + 'd ago';
    const mo = Math.floor(day / 30); if (mo < 12) return mo + 'mo ago';
    return Math.floor(mo / 12) + 'y ago';
  } catch (err) { return ''; }
}

function normalizeOriginalName(name) {
  try { return Buffer.from(String(name), 'latin1').toString('utf8'); }
  catch (err) { return String(name); }
}

function truncate(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + '…';
}

function fileKind(mime, name) {
  const m = String(mime || '').toLowerCase();
  const ext = path.extname(String(name || '')).toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'application/pdf' || ext === '.pdf') return 'pdf';
  if (m.startsWith('text/') || ['.txt', '.md', '.csv', '.json', '.js', '.ts', '.html', '.css', '.xml', '.yml', '.yaml'].includes(ext)) return 'text';
  return 'file';
}

function kindLabel(kind) {
  return { image: 'IMAGE', video: 'VIDEO', audio: 'AUDIO', pdf: 'PDF', text: 'TEXT' }[kind] || 'FILE';
}

function kindIconClass(kind) {
  return {
    image: 'fa-regular fa-image', video: 'fa-solid fa-video', audio: 'fa-solid fa-music',
    pdf: 'fa-regular fa-file-pdf', text: 'fa-regular fa-file-lines'
  }[kind] || 'fa-regular fa-file';
}

function averageRating(file) {
  if (!file.ratings || !file.ratings.length) return 0;
  let sum = 0; for (const r of file.ratings) sum += Number(r.value) || 0;
  return sum / file.ratings.length;
}

function userRating(file, userId) {
  if (!file.ratings || !file.ratings.length || !userId) return 0;
  const uid = String(userId);
  const found = file.ratings.find((r) => String(r.user) === uid);
  return found ? found.value : 0;
}

function isSubscribed(viewer, targetId) {
  if (!viewer || !Array.isArray(viewer.subscribedTo)) return false;
  const tid = String(targetId);
  return viewer.subscribedTo.some((id) => String(id) === tid);
}

function safeBackUrl(req) {
  let back = req.get('referer') || '/';
  if (back.startsWith('http')) {
    try { const u = new URL(back); back = u.pathname + (u.search || ''); }
    catch (err) { back = '/'; }
  }
  if (!back.startsWith('/')) back = '/';
  return back;
}

function renderStars(value, size) {
  const sz = size || 13;
  let html = '<span class="stars" style="font-size:' + sz + 'px">';
  for (let i = 1; i <= 5; i++) {
    html += value >= i - 0.5 ? '<i class="fa-solid fa-star"></i>' : '<i class="fa-regular fa-star"></i>';
  }
  html += '</span>';
  return html;
}

function isValidObjectId(id) { return mongoose.Types.ObjectId.isValid(id); }

function fileExtUpper(name) {
  const parts = String(name || '').split('.');
  if (parts.length < 2) return 'FILE';
  return (parts[parts.length - 1] || 'FILE').toUpperCase().slice(0, 5);
}

function stripExtension(name) { return String(name || '').replace(/\.[^.]+$/, '') || 'Untitled'; }

function renderAvatar(user, size) {
  const sz = size || 46;
  const cls = sz >= 40 ? 'avatar' : 'avatar-sm';
  const initial = ((user && (user.name || user.username)) || '?').trim().charAt(0).toUpperCase() || '?';
  if (user && user.avatarUrl) {
    return '<img class="' + cls + ' avatar-img" src="' + escapeHtml(user.avatarUrl) + '" alt="' + escapeHtml(user.name || user.username) + '" style="width:' + sz + 'px;height:' + sz + 'px;object-fit:cover;display:block">';
  }
  return '<div class="' + cls + '" style="width:' + sz + 'px;height:' + sz + 'px;font-size:' + Math.round(sz * 0.38) + 'px">' + escapeHtml(initial) + '</div>';
}

/* ------------------------------------------------------------------ *
 * Cloudinary helpers
 * ------------------------------------------------------------------ */
function uploadBufferToCloudinary(buffer, originalName, folder, resourceType) {
  return new Promise((resolve, reject) => {
    const opts = { folder: folder || 'biologynotes', resource_type: resourceType || 'auto', use_filename: true, unique_filename: true, filename_override: originalName };
    const stream = cloudinary.uploader.upload_stream(opts, (error, result) => error ? reject(error) : resolve(result));
    stream.end(buffer);
  });
}

function deleteFromCloudinary(publicId, resourceType) {
  return new Promise((resolve) => {
    if (!publicId) return resolve({ ok: false, error: 'no-public-id' });
    const type = ['image', 'video', 'raw'].includes(resourceType) ? resourceType : 'image';
    cloudinary.uploader.destroy(publicId, { resource_type: type, invalidate: true }, (err, result) => {
      if (err) { console.warn('[biologynotes] Cloudinary destroy error:', err.message); return resolve({ ok: false, error: err.message }); }
      resolve({ ok: true, result });
    });
  });
}

function buildA4ThumbnailUrl(record) {
  const kind = fileKind(record.mimeType, record.originalName);
  const pid = record.storedName;
  if (!pid) return '';
  try {
    if (kind === 'image') {
      return cloudinary.url(pid, { resource_type: 'image', secure: true, transformation: [{ width: A4_THUMB_W, height: A4_THUMB_H, crop: 'fill', gravity: 'auto' }, { quality: 'auto', fetch_format: 'auto' }] });
    }
    if (kind === 'pdf') {
      return cloudinary.url(pid, { resource_type: 'image', secure: true, format: 'jpg', page: 1, transformation: [{ width: A4_THUMB_W, height: A4_THUMB_H, crop: 'fill' }, { quality: 'auto' }] });
    }
    if (kind === 'video') {
      return cloudinary.url(pid, { resource_type: 'video', secure: true, format: 'jpg', transformation: [{ width: A4_THUMB_W, height: A4_THUMB_H, crop: 'fill', start_offset: '0' }, { quality: 'auto' }] });
    }
  } catch (err) { console.warn('[biologynotes] thumb error:', err.message); }
  return '';
}

function buildCloudinaryDownloadUrl(fileUrl, originalName, mimeType) {
  if (!fileUrl) return fileUrl;
  const kind = fileKind(mimeType, originalName);
  if (kind === 'file' || kind === 'text') return fileUrl;
  let baseName = String(originalName || 'download').replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_\- ]/g, '_').slice(0, 60) || 'download';
  return fileUrl.replace('/upload/', '/upload/fl_attachment:' + encodeURIComponent(baseName) + '/');
}

/* ------------------------------------------------------------------ *
 * SEO helpers
 * ------------------------------------------------------------------ */
function seoForHome(user, isGuest) {
  if (user) {
    return {
      title: user.name + ' · Dashboard · BiologyNotes',
      description: 'Your personal dashboard on BiologyNotes — manage your biology notes, chapters, and study files.',
      canonical: '/',
      ogType: 'website',
      noindex: true  // private dashboard — do not index
    };
  }
  return {
    title: 'BiologyNotes · Free Biology Notes, Chapters & Study Materials',
    description: 'BiologyNotes is a free platform to discover, download, and share biology notes, chapters, and study materials. Browse public notes from the community — no signup needed.',
    canonical: '/',
    ogType: 'website',
    noindex: false
  };
}

function seoForGallery() {
  return {
    title: 'Public Gallery · Biology Notes & Study Materials · BiologyNotes',
    description: 'Browse every public biology note, chapter, and study file shared across BiologyNotes. Search by subject, writer, or tag.',
    canonical: '/gallery',
    ogType: 'website',
    noindex: false
  };
}

function seoForFile(record, owner) {
  const kind = fileKind(record.mimeType, record.originalName);
  const isNote = record.kind === 'note';
  const parts = [];
  if (isNote && record.chapterName) parts.push('Chapter ' + (record.chapterNo || '') + ' — ' + record.chapterName);
  else parts.push(record.chapterName);
  if (record.subject) parts.push(record.subject);
  if (record.writer) parts.push('by ' + record.writer);
  const titleStr = parts.filter(Boolean).join(' · ');

  const descParts = [];
  if (record.description) descParts.push(truncate(record.description, 150));
  else {
    descParts.push((isNote ? 'Biology notes' : 'Study file') + (record.subject ? ' on ' + record.subject : ''));
    if (record.writer) descParts.push('by ' + record.writer);
    if (record.chapterNo) descParts.push('(Chapter ' + record.chapterNo + ')');
  }
  descParts.push('Download free on BiologyNotes.');

  return {
    title: titleStr + ' · BiologyNotes',
    description: truncate(descParts.join(' — '), 160),
    canonical: '/files/' + String(record._id),
    ogType: 'article',
    ogImage: record.thumbnailUrl || buildA4ThumbnailUrl(record) || '',
    noindex: record.visibility !== 'public'
  };
}

function seoForUser(profileUser, viewerIsSelf) {
  return {
    title: profileUser.name + ' (@' + profileUser.username + ') · BiologyNotes',
    description: 'View ' + profileUser.name + '\'s public biology notes, chapters, and study files on BiologyNotes. @' + profileUser.username,
    canonical: '/users/' + profileUser.username,
    ogType: 'profile',
    ogImage: profileUser.avatarUrl || '',
    noindex: false
  };
}

function buildSeoHead(seo, req) {
  const base = SITE_URL || (req.protocol + '://' + req.get('host'));
  const canonical = base + (seo.canonical || '/');
  const ogImage = seo.ogImage || (base + '/favicon.svg');

  let head = '';
  head += '<title>' + escapeHtml(seo.title || 'BiologyNotes') + '</title>\n';
  head += '<meta name="description" content="' + escapeHtml(seo.description || '') + '">\n';
  head += '<link rel="canonical" href="' + escapeHtml(canonical) + '">\n';
  head += '<meta name="robots" content="' + (seo.noindex ? 'noindex,nofollow' : 'index,follow,max-image-preview:large') + '">\n';
  head += '<meta name="googlebot" content="' + (seo.noindex ? 'noindex,nofollow' : 'index,follow') + '">\n';

  // Open Graph
  head += '<meta property="og:type" content="' + escapeHtml(seo.ogType || 'website') + '">\n';
  head += '<meta property="og:site_name" content="BiologyNotes">\n';
  head += '<meta property="og:title" content="' + escapeHtml(seo.title || '') + '">\n';
  head += '<meta property="og:description" content="' + escapeHtml(seo.description || '') + '">\n';
  head += '<meta property="og:url" content="' + escapeHtml(canonical) + '">\n';
  head += '<meta property="og:image" content="' + escapeHtml(ogImage) + '">\n';
  head += '<meta property="og:image:alt" content="' + escapeHtml(seo.title || 'BiologyNotes') + '">\n';

  // Twitter
  head += '<meta name="twitter:card" content="summary_large_image">\n';
  head += '<meta name="twitter:title" content="' + escapeHtml(seo.title || '') + '">\n';
  head += '<meta name="twitter:description" content="' + escapeHtml(seo.description || '') + '">\n';
  head += '<meta name="twitter:image" content="' + escapeHtml(ogImage) + '">\n';

  // Structured data
  head += '<script type="application/ld+json">' + JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'BiologyNotes',
    url: base,
    potentialAction: {
      '@type': 'SearchAction',
      target: base + '/gallery?q={search_term_string}',
      'query-input': 'required name=search_term_string'
    }
  }) + '</script>\n';

  return head;
}

/* ------------------------------------------------------------------ *
 * Styling
 * ------------------------------------------------------------------ */
const FONTS_LINK =
  '<link rel="preconnect" href="https://fonts.googleapis.com">' +
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
  '<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,500;0,600;0,700;0,800;1,500&family=Merriweather:ital,wght@0,300;0,400;0,700;1,400&family=Poppins:wght@300;400;500;600;700&display=swap" rel="stylesheet">';

const FA_LINK =
  '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css" integrity="sha512-DTOQO9RWCH3ppGqcWaEA1BIZOC6xxalwEsw9c2QQeAIftl+Vegovlnee1c9QX4TctnWMn13TZye+giMm8e2LwA==" crossorigin="anonymous" referrerpolicy="no-referrer">';

const CSS = `
*,*::before,*::after{box-sizing:border-box;border-radius:0}
html,body{margin:0;padding:0}
body{font-family:'Merriweather', Georgia, 'Times New Roman', serif;background:#fafafa;color:#18181b;font-size:15px;line-height:1.65;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
.ui,button,input,select,textarea,.btn,.label,.nav-link,.badge,.chip,.topnav,.toolbar,.stat,.file-stats,.user-meta,.user-name,.card-meta,.tag{font-family:'Poppins', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif}
h1,h2,h3,h4,.display,.file-title,.chapter-title,.brand,.rating-avg{font-family:'Playfair Display', Georgia, serif;letter-spacing:-.01em}
a{color:inherit;text-decoration:none}
button{font-family:inherit}
.container{max-width:1240px;margin:0 auto;padding:28px 20px 80px}
.container-narrow{max-width:440px;margin:0 auto;padding:56px 20px}
h1{font-size:30px;font-weight:700;letter-spacing:-.02em;margin:0 0 6px;line-height:1.2}
h2{font-size:20px;font-weight:700;letter-spacing:-.01em;margin:0;line-height:1.25}
h3{font-size:17px;font-weight:600;margin:0 0 4px;letter-spacing:-.005em}
p{margin:0}
.sub{margin:0 0 22px;color:#71717a;font-size:14.5px;font-family:'Merriweather', serif}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:19px;letter-spacing:-.01em}
.brand a{display:flex;align-items:center;gap:10px;color:#18181b}
.brand-mark{width:34px;height:34px;background:#18181b;color:#fafafa;display:flex;align-items:center;justify-content:center;font-size:15px}
.brand-mark i{font-size:15px}
.topnav{background:#fff;border-bottom:1px solid #e4e4e7;position:sticky;top:0;z-index:50;backdrop-filter:blur(8px)}
.topnav-inner{max-width:1240px;margin:0 auto;padding:0 20px;display:flex;align-items:center;gap:20px;height:64px}
.topnav .brand{font-size:17px}
.topnav .brand-mark{width:28px;height:28px}
.topnav .brand-mark i{font-size:13px}
.nav-links{display:flex;gap:2px;margin-left:16px}
.nav-link{padding:8px 13px;font-size:13px;color:#52525b;font-weight:500;border:1px solid transparent;display:inline-flex;align-items:center;gap:8px;transition:background-color .15s ease,color .15s ease,border-color .15s ease}
.nav-link i{font-size:12px}
.nav-link:hover{color:#18181b;background:#f4f4f5}
.nav-link.active{color:#18181b;background:#f4f4f5;border-color:#e4e4e7}
.nav-right{margin-left:auto;display:flex;align-items:center;gap:8px}
.card{background:#fff;border:1px solid #e4e4e7;padding:26px;box-shadow:0 1px 2px rgba(24,24,27,.04)}
.avatar{background:#18181b;color:#fafafa;display:flex;align-items:center;justify-content:center;font-weight:600;flex:0 0 auto;font-family:'Playfair Display', serif;overflow:hidden}
.avatar-sm{background:#18181b;color:#fafafa;display:flex;align-items:center;justify-content:center;font-weight:600;flex:0 0 auto;font-family:'Playfair Display',serif;overflow:hidden}
.avatar-img{border:1px solid #e4e4e7}
.guest-badge{width:22px;height:22px;background:#e4e4e7;color:#52525b;display:flex;align-items:center;justify-content:center;font-size:11px;flex:0 0 auto}
.field{display:flex;flex-direction:column;gap:7px;margin-bottom:18px}
.label{font-size:12.5px;font-weight:500;color:#3f3f46;letter-spacing:.01em}
.input,.textarea,.select{width:100%;padding:11px 13px;font-size:14px;font-family:'Poppins',sans-serif;color:#18181b;background:#fafafa;border:1px solid #e4e4e7;outline:none;transition:border-color .15s ease,box-shadow .15s ease,background-color .15s ease}
.textarea{min-height:110px;resize:vertical;line-height:1.55}
.input:focus,.textarea:focus,.select:focus{background:#fff;border-color:#a1a1aa;box-shadow:0 0 0 3px rgba(161,161,170,.22)}
.input::placeholder,.textarea::placeholder{color:#a1a1aa}
.select{appearance:none;background-image:linear-gradient(45deg,transparent 50%,#71717a 50%),linear-gradient(135deg,#71717a 50%,transparent 50%);background-position:calc(100% - 18px) 50%,calc(100% - 13px) 50%;background-size:5px 5px,5px 5px;background-repeat:no-repeat;padding-right:36px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:40px;padding:0 16px;font-size:13.5px;font-weight:500;border:1px solid transparent;cursor:pointer;white-space:nowrap;font-family:'Poppins',sans-serif;transition:background-color .15s ease,border-color .15s ease,color .15s ease,transform .05s ease}
.btn i{font-size:13px}
.btn:active{transform:translateY(1px)}
.btn-primary{background:#18181b;color:#fafafa}
.btn-primary:hover{background:#27272a}
.btn-outline{background:#fff;color:#18181b;border-color:#e4e4e7}
.btn-outline:hover{background:#f4f4f5;border-color:#d4d4d8}
.btn-ghost{background:transparent;color:#3f3f46;border-color:transparent}
.btn-ghost:hover{background:#f4f4f5;color:#18181b}
.btn-danger{background:#fff;color:#b91c1c;border-color:#fecaca}
.btn-danger:hover{background:#fef2f2}
.btn-danger-solid{background:#b91c1c;color:#fff;border-color:#b91c1c}
.btn-danger-solid:hover{background:#991b1b;border-color:#991b1b}
.btn-block{width:100%}
.btn-xs{height:32px;padding:0 11px;font-size:12.5px}
.btn-xs i{font-size:11.5px}
.btn-lg{height:46px;padding:0 22px;font-size:14.5px}
.btn-lg i{font-size:15px}
.btn-icon-xs{width:32px;height:32px;padding:0;font-size:12.5px}
.alert{padding:12px 15px;font-size:13.5px;margin-bottom:18px;border:1px solid #e4e4e7;background:#f4f4f5;color:#3f3f46;font-family:'Poppins',sans-serif;display:flex;align-items:flex-start;gap:10px}
.alert i{font-size:14px;margin-top:2px}
.alert-error{background:#fef2f2;border-color:#fecaca;color:#b91c1c}
.alert-success{background:#f0fdf4;border-color:#bbf7d0;color:#166534}
.alert-warning{background:#fefce8;border-color:#fde68a;color:#854d0e}
.alert-info{background:#f0f9ff;border-color:#bae6fd;color:#075985}
.auth-wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:calc(100vh - 64px);padding:40px 20px}
.auth-card{width:100%;max-width:440px;background:#fff;border:1px solid #e4e4e7;padding:32px;box-shadow:0 1px 3px rgba(24,24,27,.05)}
.auth-brand{margin-bottom:26px;display:flex;flex-direction:column;align-items:center;gap:14px}
.foot-note{text-align:center;color:#71717a;font-size:13.5px;margin-top:20px;font-family:'Poppins',sans-serif}
.foot-note a{color:#18181b;font-weight:500;text-decoration:underline;text-underline-offset:3px}
.auth-divider{display:flex;align-items:center;gap:12px;margin:20px 0;color:#a1a1aa;font-family:'Poppins',sans-serif;font-size:11.5px;letter-spacing:.15em;text-transform:uppercase}
.auth-divider::before,.auth-divider::after{content:'';flex:1;height:1px;background:#e4e4e7}
.banner{display:flex;flex-wrap:wrap;gap:16px;align-items:center;justify-content:space-between;background:#fff;border:1px solid #e4e4e7;padding:20px 22px;margin-bottom:22px;box-shadow:0 1px 2px rgba(24,24,27,.04)}
.user-info{display:flex;align-items:center;gap:14px;min-width:0}
.user-name{font-weight:600;font-size:17px;letter-spacing:-.01em;font-family:'Playfair Display', serif}
.user-meta{color:#71717a;font-size:12.5px;word-break:break-word;font-family:'Poppins',sans-serif}
.guest-banner{background:#f0f9ff;border:1px solid #bae6fd;padding:14px 18px;margin-bottom:22px;display:flex;align-items:center;gap:14px;flex-wrap:wrap;font-family:'Poppins',sans-serif;font-size:13.5px;color:#075985}
.guest-banner i{font-size:16px;color:#0284c7}
.guest-banner-text{flex:1;min-width:0}
.guest-banner-actions{display:flex;gap:8px;flex-wrap:wrap}
.toolbar{background:#fff;border:1px solid #e4e4e7;padding:14px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:22px}
.toolbar .input{flex:1 1 240px;height:38px;padding:8px 12px 8px 36px;font-size:13.5px;background-image:url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%2371717a' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='11' cy='11' r='7'/%3E%3Cpath d='m20 20-3.5-3.5'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:12px center}
.toolbar .select{width:auto;min-width:160px;height:38px;padding:8px 34px 8px 12px;font-size:13.5px}
.chips{display:flex;border:1px solid #e4e4e7;background:#fafafa;flex-wrap:wrap}
.chip{padding:8px 13px;font-size:12.5px;color:#52525b;border-right:1px solid #e4e4e7;background:#fff;cursor:pointer;font-weight:500;font-family:'Poppins',sans-serif;display:inline-flex;align-items:center;gap:6px}
.chip i{font-size:11px}
.chip:last-child{border-right:0}
.chip:hover{background:#f4f4f5;color:#18181b}
.chip.active{background:#18181b;color:#fafafa;border-color:#18181b}
.section-head{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:16px;gap:12px}
.count{color:#71717a;font-size:12.5px;font-family:'Poppins',sans-serif}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:18px}
.file-card{background:#fff;border:1px solid #e4e4e7;display:flex;flex-direction:column;transition:border-color .18s ease,box-shadow .18s ease,transform .18s ease}
.file-card:hover{border-color:#d4d4d8;box-shadow:0 4px 14px rgba(24,24,27,.08);transform:translateY(-2px)}
.preview{position:relative;display:flex;align-items:center;justify-content:center;height:280px;background:linear-gradient(135deg,#f4f4f5 0%,#e8e8ea 100%);border-bottom:1px solid #e4e4e7;overflow:hidden;padding:18px}
.preview::before{content:'';position:absolute;inset:0;background-image:linear-gradient(rgba(228,228,231,.55) 1px,transparent 1px),linear-gradient(90deg,rgba(228,228,231,.55) 1px,transparent 1px);background-size:22px 22px;opacity:.35;pointer-events:none}
.a4-thumb{position:relative;aspect-ratio:210 / 297;height:100%;max-width:100%;background:#fff;border:1px solid #d4d4d8;box-shadow:0 4px 14px rgba(24,24,27,.14),0 1px 3px rgba(24,24,27,.08);overflow:hidden;transition:transform .22s ease,box-shadow .22s ease;z-index:1}
.file-card:hover .a4-thumb{transform:translateY(-3px) scale(1.015);box-shadow:0 10px 24px rgba(24,24,27,.18),0 2px 5px rgba(24,24,27,.10)}
.a4-thumb img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;background:#fff}
.a4-fallback{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:14px 12px;background:#fff}
.a4-fallback::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:#18181b}
.a4-fallback i{font-size:38px;color:#a1a1aa}
.a4-fallback .ext-badge{font-family:'Poppins',sans-serif;font-size:11px;font-weight:700;letter-spacing:.1em;color:#18181b;padding:5px 10px;background:#f4f4f5;border:1px solid #e4e4e7}
.a4-fallback .lines{width:78%;display:flex;flex-direction:column;gap:5px;margin-top:8px}
.a4-fallback .lines span{height:2px;background:#e4e4e7;display:block}
.a4-fallback .lines span:nth-child(1){width:100%}
.a4-fallback .lines span:nth-child(2){width:88%}
.a4-fallback .lines span:nth-child(3){width:94%}
.a4-fallback .lines span:nth-child(4){width:62%}
.preview .type-badge{position:absolute;top:12px;left:12px;background:rgba(24,24,27,.88);color:#fafafa;font-size:10px;font-weight:600;letter-spacing:.09em;padding:4px 7px;font-family:'Poppins',sans-serif;backdrop-filter:blur(4px);z-index:2}
.preview .vis-badge{position:absolute;bottom:12px;right:12px;background:rgba(255,255,255,.95);color:#18181b;font-size:10px;font-weight:600;letter-spacing:.09em;padding:4px 7px;border:1px solid #e4e4e7;font-family:'Poppins',sans-serif;backdrop-filter:blur(4px);z-index:2}
.preview .comment-count-badge{position:absolute;bottom:12px;left:12px;background:rgba(24,24,27,.88);color:#fafafa;font-size:10px;font-weight:600;letter-spacing:.09em;padding:4px 7px;font-family:'Poppins',sans-serif;backdrop-filter:blur(4px);z-index:2;display:inline-flex;align-items:center;gap:4px}
.ribbon{position:absolute;top:0;right:0;z-index:3;background:#facc15;color:#18181b;font-family:'Poppins',sans-serif;font-size:9.5px;font-weight:700;letter-spacing:.14em;padding:7px 12px;text-transform:uppercase;box-shadow:0 2px 6px rgba(24,24,27,.18);display:inline-flex;align-items:center;gap:5px}
.ribbon i{font-size:10px}
.preview .play-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,.95);background:rgba(24,24,27,.22);pointer-events:none;transition:background-color .2s ease;z-index:1}
.preview .play-overlay i{font-size:48px;filter:drop-shadow(0 2px 4px rgba(0,0,0,.4))}
.file-card:hover .play-overlay{background:rgba(24,24,27,.32)}
.file-body{padding:15px;display:flex;flex-direction:column;gap:9px;flex:1}
.file-top{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.badge{display:inline-flex;align-items:center;gap:5px;height:23px;padding:0 8px;font-size:10.5px;font-weight:600;letter-spacing:.05em;background:#f4f4f5;color:#3f3f46;border:1px solid #e4e4e7;font-family:'Poppins',sans-serif;text-transform:uppercase}
.badge i{font-size:10px}
.badge-dark{background:#18181b;color:#fafafa;border-color:#18181b}
.badge-type{background:#fff}
.badge-tag{background:#fff;color:#3f3f46;text-transform:none;letter-spacing:0;font-weight:500}
.file-title{font-size:17px;font-weight:600;letter-spacing:-.005em;line-height:1.3;color:#18181b;margin:0;word-break:break-word}
.file-title a:hover{text-decoration:underline;text-underline-offset:3px;text-decoration-color:#a1a1aa}
.file-sub{color:#71717a;font-size:12px;margin:0;word-break:break-word;font-family:'Poppins',sans-serif}
.file-desc{color:#3f3f46;font-size:13px;margin:0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.55}
.file-stats{display:flex;gap:14px;align-items:center;flex-wrap:wrap;color:#71717a;font-size:12px;margin-top:2px;font-family:'Poppins',sans-serif}
.stat{display:inline-flex;align-items:center;gap:5px}
.stat i{font-size:11.5px;color:#a1a1aa}
.stat-rating i{color:#facc15}
.stat-rating .stars{display:inline-flex;gap:1px;color:#facc15;line-height:0}
.stat-rating .stars i{font-size:11.5px;color:#facc15}
.file-foot{margin-top:auto;padding-top:11px;border-top:1px solid #f4f4f5;display:flex;align-items:center;justify-content:space-between;gap:8px}
.uploader-mini{display:flex;align-items:center;gap:8px;color:#3f3f46;font-size:12.5px;min-width:0;font-family:'Poppins',sans-serif}
.uploader-mini a{color:#18181b;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.uploader-mini a:hover{text-decoration:underline;text-underline-offset:2px}
.owner-actions{display:inline-flex;gap:6px;align-items:center}
.empty{text-align:center;padding:64px 24px;border:1px dashed #e4e4e7;background:#fff;color:#71717a}
.empty i{font-size:44px;color:#d4d4d8;margin-bottom:14px;display:block}
.empty h3{font-size:18px;color:#18181b;margin-bottom:6px;font-family:'Playfair Display',serif}
.empty p{margin:0 0 20px;font-size:13.5px}
.tabs{display:flex;border-bottom:1px solid #e4e4e7;margin-bottom:22px;gap:0}
.tab{padding:13px 20px;background:none;border:0;border-bottom:2px solid transparent;margin-bottom:-1px;cursor:pointer;font-family:'Poppins',sans-serif;font-size:13.5px;font-weight:500;color:#71717a;display:inline-flex;align-items:center;gap:8px;transition:color .15s ease,border-color .15s ease,background-color .15s ease}
.tab i{font-size:13px}
.tab:hover{color:#18181b;background:#f4f4f5}
.tab.active{color:#18181b;border-bottom-color:#18181b}
.tab-panel{display:none}
.tab-panel.active{display:block}
.dropzone{position:relative;border:2px dashed #d4d4d8;background:#fafafa;padding:44px 24px;text-align:center;cursor:pointer;transition:border-color .18s ease,background-color .18s ease,transform .12s ease}
.dropzone:hover{border-color:#a1a1aa;background:#f4f4f5}
.dropzone.dragover{border-color:#18181b;background:#f4f4f5;transform:scale(1.005)}
.dropzone.has-file{border-style:solid;border-color:#18181b;background:#fff;padding:24px}
.dropzone input[type=file]{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%}
.dropzone-inner{display:flex;flex-direction:column;align-items:center;gap:14px;pointer-events:none}
.dropzone-icon{width:64px;height:64px;background:#18181b;color:#fafafa;display:flex;align-items:center;justify-content:center;font-size:26px;margin-bottom:2px;transition:transform .18s ease}
.dropzone.dragover .dropzone-icon{transform:scale(1.08) translateY(-2px)}
.dropzone-title{font-family:'Playfair Display',serif;font-size:19px;font-weight:600;letter-spacing:-.01em;color:#18181b;line-height:1.3}
.dropzone-title .browse{color:#18181b;text-decoration:underline;text-underline-offset:3px;text-decoration-color:#a1a1aa}
.dropzone-hint{font-family:'Poppins',sans-serif;font-size:12.5px;color:#71717a;letter-spacing:.01em}
.dropzone-hint strong{color:#3f3f46;font-weight:500}
.file-chip{display:flex;align-items:center;gap:14px;width:100%;text-align:left;pointer-events:auto}
.file-chip-icon{width:52px;height:52px;background:#18181b;color:#fafafa;display:flex;align-items:center;justify-content:center;font-size:22px;flex:0 0 auto}
.file-chip-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.file-chip-name{font-family:'Poppins',sans-serif;font-size:13.5px;font-weight:500;color:#18181b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.file-chip-meta{font-family:'Poppins',sans-serif;font-size:11.5px;color:#71717a;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.file-chip-meta .dot{width:3px;height:3px;background:#d4d4d8}
.file-chip-remove{pointer-events:auto;width:34px;height:34px;background:#fff;border:1px solid #e4e4e7;color:#71717a;display:flex;align-items:center;justify-content:center;cursor:pointer;flex:0 0 auto;transition:background-color .15s ease,color .15s ease,border-color .15s ease}
.file-chip-remove:hover{background:#fef2f2;color:#b91c1c;border-color:#fecaca}
.file-chip-remove i{font-size:14px}
.progress{height:3px;background:#e4e4e7;overflow:hidden;margin-top:14px;width:100%;display:none}
.progress.on{display:block}
.progress-bar{height:100%;width:0;background:#18181b;transition:width .25s ease}
.tags-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
@media (max-width:640px){.tags-grid{grid-template-columns:1fr}}
.tag-field{position:relative}
.tag-field .tag-prefix{position:absolute;top:50%;left:12px;transform:translateY(-50%);color:#a1a1aa;font-family:'Poppins',sans-serif;font-size:14px;font-weight:500;pointer-events:none}
.tag-field .input{padding-left:28px}
.tag-hint{font-size:11.5px;color:#a1a1aa;font-family:'Poppins',sans-serif;margin-top:6px;display:flex;align-items:center;gap:6px}
.detail-grid{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(300px,1fr);gap:22px;align-items:start}
@media (max-width:880px){.detail-grid{grid-template-columns:1fr}}
.detail-preview{background:#0a0a0a;border:1px solid #18181b;min-height:320px;display:flex;align-items:center;justify-content:center;overflow:hidden;position:relative}
.detail-preview img{max-width:100%;max-height:620px;display:block}
.detail-preview video{max-width:100%;max-height:620px;display:block;background:#000}
.detail-preview audio{width:100%;padding:28px}
.detail-preview .placeholder{color:#a1a1aa;display:flex;flex-direction:column;align-items:center;gap:14px;padding:70px 20px;text-align:center}
.detail-preview .placeholder i{font-size:64px;color:#52525b}
.detail-preview .placeholder .kind-label{font-size:11px;letter-spacing:.16em;font-weight:600;color:#fafafa;font-family:'Poppins',sans-serif}
.detail-preview-light{background: linear-gradient(135deg,#fafafa 0%,#f0f0f1 100%);border-color:#e4e4e7;padding:26px;min-height:460px}
.detail-preview-light::before{content:'';position:absolute;inset:0;background-image:linear-gradient(rgba(228,228,231,.55) 1px,transparent 1px),linear-gradient(90deg,rgba(228,228,231,.55) 1px,transparent 1px);background-size:22px 22px;opacity:.5;pointer-events:none}
.detail-preview-light iframe{position:relative;z-index:1;width:100%;height:640px;border:1px solid #d4d4d8;background:#fff}
.detail-preview-light .detail-a4-wrap{position:relative;z-index:1;padding:0;min-height:auto;background:transparent;border:0;display:flex;align-items:center;justify-content:center}
.detail-a4-wrap{display:flex;align-items:center;justify-content:center;min-height:420px;padding:0}
.detail-a4{aspect-ratio:210/297;width:100%;max-width:420px;background:#fff;border:1px solid #d4d4d8;box-shadow:0 8px 30px rgba(24,24,27,.18),0 2px 6px rgba(24,24,27,.08);position:relative;overflow:hidden}
.detail-a4 .a4-fallback i{font-size:64px}
.detail-a4 .a4-fallback .ext-badge{font-size:13px;padding:7px 14px}
.detail-a4 .a4-fallback .lines{width:70%;gap:7px}
.detail-a4 .a4-fallback .lines span{height:2px}
.a4-thumb-card{background:#fff;border:1px solid #e4e4e7;display:flex;flex-direction:column}
.a4-thumb-card-head{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid #f4f4f5;font-family:'Poppins',sans-serif;font-size:12.5px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:#52525b}
.a4-thumb-card-head i{font-size:12px;color:#a1a1aa}
.a4-thumb-card-body{padding:20px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#fafafa 0%,#f0f0f1 100%);position:relative;min-height:280px}
.a4-thumb-card-body::before{content:'';position:absolute;inset:0;background-image:linear-gradient(rgba(228,228,231,.5) 1px,transparent 1px),linear-gradient(90deg,rgba(228,228,231,.5) 1px,transparent 1px);background-size:18px 18px;opacity:.4;pointer-events:none}
.a4-thumb-card-body .a4-thumb{height:auto;aspect-ratio:210/297;width:100%;max-width:230px}
.share-card{background:#fff;border:1px solid #e4e4e7;padding:18px;display:flex;flex-direction:column;gap:14px}
.share-card-head{font-family:'Poppins',sans-serif;font-size:12.5px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:#52525b;display:flex;align-items:center;gap:8px}
.share-card-head i{font-size:12px;color:#a1a1aa}
.share-buttons{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.share-btn{height:46px;background:#fff;border:1px solid #e4e4e7;color:#3f3f46;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:16px;text-decoration:none;transition:background-color .15s ease,color .15s ease,border-color .15s ease,transform .05s ease}
.share-btn i{font-size:17px}
.share-btn:active{transform:translateY(1px)}
.share-btn:hover{background:#f4f4f5;color:#18181b;border-color:#d4d4d8}
.share-btn.wa:hover{background:#dcfce7;color:#166534;border-color:#bbf7d0}
.share-btn.fb:hover{background:#dbeafe;color:#1e40af;border-color:#bfdbfe}
.share-btn.tw:hover{background:#f4f4f5;color:#0f172a;border-color:#d4d4d8}
.share-btn.li:hover{background:#dbeafe;color:#1e40af;border-color:#bfdbfe}
.share-btn.tg:hover{background:#dbeafe;color:#1e40af;border-color:#bfdbfe}
.share-btn.rd:hover{background:#fee2e2;color:#b91c1c;border-color:#fecaca}
.share-btn.em:hover{background:#f4f4f5;color:#18181b;border-color:#d4d4d8}
.share-btn.cp:hover{background:#f4f4f5;color:#18181b;border-color:#d4d4d8}
.share-btn.cp.copied{background:#dcfce7;color:#166534;border-color:#bbf7d0}
.share-hint{font-size:11.5px;color:#a1a1aa;font-family:'Poppins',sans-serif;margin-top:-4px}
.meta-grid{display:grid;grid-template-columns:1fr 1fr;gap:0;margin-top:18px;border-top:1px solid #f4f4f5}
.meta-item{display:flex;flex-direction:column;gap:3px;border-bottom:1px solid #f4f4f5;padding:12px 0}
.meta-item:nth-child(odd){padding-right:14px}
.meta-item .k{font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:#a1a1aa;font-weight:600;font-family:'Poppins',sans-serif}
.meta-item .v{font-size:13.5px;color:#18181b;word-break:break-word;font-family:'Poppins',sans-serif}
.rating-block{display:flex;flex-direction:column;gap:14px;border:1px solid #e4e4e7;padding:18px;background:#fff}
.rating-head{display:flex;align-items:center;gap:16px}
.rating-avg{font-size:38px;font-weight:700;letter-spacing:-.03em;line-height:1;font-family:'Playfair Display',serif}
.rating-count{color:#71717a;font-size:12.5px;font-family:'Poppins',sans-serif}
.rating-stars{display:inline-flex;gap:2px;color:#facc15;line-height:0;margin-bottom:3px}
.rating-stars i{font-size:14px}
.rating-input{display:inline-flex;gap:3px;align-items:center;margin-top:2px}
.star-btn{background:none;border:0;padding:5px;cursor:pointer;color:#d4d4d8;line-height:0;transition:color .12s ease,transform .12s ease}
.star-btn i{font-size:22px}
.star-btn:hover{color:#facc15;transform:translateY(-2px) scale(1.05)}
.star-btn.on{color:#facc15}
.star-btn:disabled{opacity:.55;cursor:default;transform:none}
.rating-hint{font-size:12.5px;color:#71717a;font-family:'Poppins',sans-serif;margin-top:4px}
.uploader-card{background:#fff;border:1px solid #e4e4e7;padding:18px;display:flex;flex-direction:column;gap:14px}
.uploader-row{display:flex;align-items:center;gap:12px}
.uploader-meta{min-width:0}
.uploader-meta .name{font-weight:600;font-size:15px;letter-spacing:-.01em;font-family:'Playfair Display',serif}
.uploader-meta .handle{color:#71717a;font-size:12.5px;font-family:'Poppins',sans-serif}
.uploader-meta .handle:hover{color:#18181b;text-decoration:underline;text-underline-offset:2px}
.uploader-stats{display:flex;gap:16px;color:#71717a;font-size:12px;flex-wrap:wrap;font-family:'Poppins',sans-serif}
.uploader-stats span{display:inline-flex;align-items:center;gap:6px}
.uploader-stats i{font-size:11.5px;color:#a1a1aa}
.comments-card{background:#fff;border:1px solid #e4e4e7;padding:22px;margin-top:22px}
.comments-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px;padding-bottom:14px;border-bottom:1px solid #f4f4f5}
.comments-head h2{font-size:17px;display:flex;align-items:center;gap:10px}
.comments-head h2 i{font-size:15px;color:#a1a1aa}
.comments-head .comment-count-pill{background:#f4f4f5;color:#3f3f46;border:1px solid #e4e4e7;font-family:'Poppins',sans-serif;font-size:11.5px;font-weight:600;padding:3px 9px;letter-spacing:.04em}
.comment-form{display:flex;flex-direction:column;gap:10px;margin-bottom:22px}
.comment-form textarea{min-height:90px}
.comment-form-actions{display:flex;justify-content:flex-end;gap:10px}
.comment-list{display:flex;flex-direction:column;gap:0}
.comment{display:flex;gap:12px;padding:14px 0;border-top:1px solid #f4f4f5}
.comment:first-child{border-top:0;padding-top:0}
.comment-avatar-wrap{flex:0 0 auto}
.comment-body{flex:1;min-width:0}
.comment-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:5px}
.comment-author{font-family:'Poppins',sans-serif;font-size:13.5px;font-weight:600;color:#18181b}
.comment-author a:hover{text-decoration:underline;text-underline-offset:2px}
.comment-time{font-family:'Poppins',sans-serif;font-size:11.5px;color:#a1a1aa}
.comment-text{font-family:'Merriweather',serif;font-size:14px;line-height:1.6;color:#3f3f46;white-space:pre-wrap;word-wrap:break-word}
.comment-actions{margin-left:auto;display:flex;gap:6px}
.comment-delete{background:none;border:0;padding:4px;color:#a1a1aa;cursor:pointer;font-size:12px;transition:color .15s ease}
.comment-delete:hover{color:#b91c1c}
.comments-empty{text-align:center;padding:30px 20px;color:#71717a;font-family:'Poppins',sans-serif;font-size:13.5px}
.comments-empty i{display:block;font-size:32px;color:#d4d4d8;margin-bottom:10px}
.comment-signin-prompt{background:#f0f9ff;border:1px solid #bae6fd;padding:16px 18px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-family:'Poppins',sans-serif;font-size:13.5px;color:#075985;margin-bottom:22px}
.comment-signin-prompt i{font-size:16px;color:#0284c7}
.profile-manage-card{background:#fff;border:1px solid #e4e4e7;padding:20px;margin-bottom:22px}
.profile-manage-title{font-family:'Playfair Display',serif;font-size:16px;font-weight:600;letter-spacing:-.005em;margin:0 0 6px;color:#18181b}
.profile-manage-desc{font-family:'Poppins',sans-serif;font-size:12.5px;color:#71717a;margin:0 0 14px}
.profile-manage-actions{display:flex;gap:10px;flex-wrap:wrap}
.avatar-card{background:#fff;border:1px solid #e4e4e7;padding:20px;display:flex;align-items:center;gap:20px;flex-wrap:wrap;margin-bottom:22px}
.avatar-card-img{width:88px;height:88px;overflow:hidden;background:#18181b;color:#fafafa;display:flex;align-items:center;justify-content:center;font-family:'Playfair Display',serif;font-size:32px;font-weight:600;flex:0 0 auto}
.avatar-card-img img{width:100%;height:100%;object-fit:cover;display:block}
.avatar-card-info{flex:1;min-width:0}
.avatar-card-title{font-family:'Playfair Display',serif;font-size:18px;font-weight:600;letter-spacing:-.01em;margin:0 0 2px}
.avatar-card-desc{font-family:'Poppins',sans-serif;font-size:12.5px;color:#71717a;margin:0 0 12px}
.avatar-card-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.avatar-file-input{font-family:'Poppins',sans-serif;font-size:12.5px;color:#52525b;max-width:230px}
.avatar-file-input::file-selector-button{font-family:'Poppins',sans-serif;font-size:12.5px;font-weight:500;height:32px;padding:0 11px;margin-right:10px;background:#fff;color:#18181b;border:1px solid #e4e4e7;cursor:pointer;transition:background-color .15s ease,border-color .15s ease}
.avatar-file-input::file-selector-button:hover{background:#f4f4f5;border-color:#d4d4d8}
.error-page{text-align:center;padding:72px 26px}
.error-page h1{font-size:64px;margin-bottom:6px;font-family:'Playfair Display',serif;font-weight:700}
.error-page p{color:#71717a;margin:0 0 24px}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.flex-between{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.inline-form{display:inline}
.text-muted{color:#71717a}
.text-strong{color:#18181b;font-weight:500}
.form-divider{height:1px;background:#f4f4f5;margin:22px 0;border:0}
.upload-header{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:18px;flex-wrap:wrap}
.upload-header .eyebrow{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#a1a1aa;font-weight:600;font-family:'Poppins',sans-serif;margin-bottom:4px}
.upload-header h1{font-size:28px}
.modal-backdrop{position:fixed;inset:0;z-index:1000;background:rgba(24,24,27,.55);display:flex;align-items:center;justify-content:center;padding:20px;animation:bnFadeIn .15s ease}
.modal-backdrop[hidden]{display:none}
@keyframes bnFadeIn{from{opacity:0}to{opacity:1}}
.modal{background:#fff;border:1px solid #e4e4e7;max-width:440px;width:100%;padding:26px;box-shadow:0 20px 50px rgba(0,0,0,.35),0 8px 20px rgba(0,0,0,.25);animation:bnModalIn .18s ease}
@keyframes bnModalIn{from{transform:translateY(8px);opacity:0}to{transform:none;opacity:1}}
.modal-icon{width:48px;height:48px;margin-bottom:16px;display:flex;align-items:center;justify-content:center;font-size:22px;background:#f4f4f5;color:#18181b}
.modal[data-variant="danger"] .modal-icon{background:#fef2f2;color:#b91c1c}
.modal[data-variant="warning"] .modal-icon{background:#fefce8;color:#854d0e}
.modal[data-variant="primary"] .modal-icon{background:#f4f4f5;color:#18181b}
.modal-title{font-family:'Playfair Display',serif;font-size:21px;font-weight:700;letter-spacing:-.015em;margin:0 0 8px;color:#18181b}
.modal-message{font-family:'Merriweather',serif;font-size:14px;line-height:1.6;color:#52525b;margin:0 0 22px}
.modal-actions{display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap}
.modal-actions .btn{min-width:110px}
@media (max-width:640px){
  .container{padding:18px 14px 60px}
  .container-narrow{padding:32px 14px}
  .auth-card{padding:24px}
  .banner{flex-direction:column;align-items:stretch}
  .banner .actions{width:100%}
  .banner .actions .btn{flex:1}
  .card{padding:20px}
  .nav-links{display:none}
  .meta-grid{grid-template-columns:1fr}
  .meta-item:nth-child(odd){padding-right:0}
  h1{font-size:24px}
  .dropzone{padding:32px 16px}
  .dropzone-icon{width:56px;height:56px;font-size:22px}
  .dropzone-title{font-size:17px}
  .preview{height:240px;padding:14px}
  .detail-preview-light{padding:16px}
  .detail-preview-light iframe{height:420px}
  .tabs{gap:0}
  .tab{padding:11px 14px;font-size:12.5px}
  .modal{padding:20px}
  .modal-actions .btn{min-width:0;flex:1}
  .comments-card{padding:16px}
  .comment{padding:12px 0}
}
`;

/* ------------------------------------------------------------------ *
 * Confirm modal + layout
 * ------------------------------------------------------------------ */
const CONFIRM_MODAL_HTML =
  '<div class="modal-backdrop" id="bn-modal" hidden aria-hidden="true">' +
    '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="bn-modal-title" id="bn-modal-inner" data-variant="danger">' +
      '<div class="modal-icon" id="bn-modal-icon"><i class="fa-solid fa-triangle-exclamation"></i></div>' +
      '<h2 class="modal-title" id="bn-modal-title">Are you sure?</h2>' +
      '<p class="modal-message" id="bn-modal-message">This action cannot be undone.</p>' +
      '<div class="modal-actions">' +
        '<button type="button" class="btn btn-outline" id="bn-modal-cancel">Cancel</button>' +
        '<button type="button" class="btn btn-danger-solid" id="bn-modal-confirm">Confirm</button>' +
      '</div>' +
    '</div>' +
  '</div>';

const CONFIRM_MODAL_SCRIPT =
  '<script>(function(){' +
    'var backdrop=document.getElementById("bn-modal");if(!backdrop)return;' +
    'var inner=document.getElementById("bn-modal-inner");' +
    'var titleEl=document.getElementById("bn-modal-title");' +
    'var msgEl=document.getElementById("bn-modal-message");' +
    'var iconEl=document.getElementById("bn-modal-icon");' +
    'var cancelBtn=document.getElementById("bn-modal-cancel");' +
    'var confirmBtn=document.getElementById("bn-modal-confirm");' +
    'var resolveFn=null;' +
    'function open(opts){' +
      'opts=opts||{};' +
      'titleEl.textContent=opts.title||"Are you sure?";' +
      'msgEl.textContent=opts.message||"This action cannot be undone.";' +
      'confirmBtn.textContent=opts.confirmText||"Confirm";' +
      'cancelBtn.textContent=opts.cancelText||"Cancel";' +
      'var variant=opts.variant||"danger";' +
      'inner.setAttribute("data-variant",variant);' +
      'confirmBtn.className="btn "+(variant==="primary"?"btn-primary":(variant==="warning"?"btn-primary":"btn-danger-solid"));' +
      'iconEl.innerHTML=\'<i class="fa-solid \'+(opts.icon|| (variant==="danger"?"fa-triangle-exclamation":(variant==="warning"?"fa-circle-exclamation":"fa-circle-question")) )+\'"></i>\';' +
      'backdrop.hidden=false;backdrop.setAttribute("aria-hidden","false");' +
      'document.body.style.overflow="hidden";' +
      'setTimeout(function(){confirmBtn.focus();},30);' +
    '}' +
    'function close(result){' +
      'backdrop.hidden=true;backdrop.setAttribute("aria-hidden","true");' +
      'document.body.style.overflow="";' +
      'if(resolveFn){var r=resolveFn;resolveFn=null;r(result);}' +
    '}' +
    'function bnConfirm(opts){return new Promise(function(resolve){resolveFn=resolve;open(opts||{});});}' +
    'cancelBtn.addEventListener("click",function(){close(false);});' +
    'confirmBtn.addEventListener("click",function(){close(true);});' +
    'backdrop.addEventListener("click",function(e){if(e.target===backdrop)close(false);});' +
    'document.addEventListener("keydown",function(e){if(!backdrop.hidden&&e.key==="Escape")close(false);});' +
    'window.bnConfirm=bnConfirm;' +
    'document.addEventListener("submit",function(e){' +
      'var form=e.target;if(!form||form.tagName!=="FORM")return;' +
      'var msg=form.getAttribute("data-confirm");' +
      'if(!msg)return;' +
      'if(form.dataset.bnConfirmed==="1"){delete form.dataset.bnConfirmed;return;}' +
      'e.preventDefault();' +
      'bnConfirm({' +
        'title:form.getAttribute("data-confirm-title")||"Please confirm",' +
        'message:msg,' +
        'confirmText:form.getAttribute("data-confirm-action")||"Confirm",' +
        'cancelText:form.getAttribute("data-confirm-cancel")||"Cancel",' +
        'variant:form.getAttribute("data-confirm-variant")||"danger",' +
        'icon:form.getAttribute("data-confirm-icon")||""' +
      '}).then(function(ok){if(ok){form.dataset.bnConfirmed="1";form.submit();}});' +
    '},true);' +
  '})();</script>';

function layout(seo, req, body) {
  seo = seo || {};
  const base = SITE_URL || (req.protocol + '://' + req.get('host'));
  const seoHead = buildSeoHead(seo, req);

  return '<!DOCTYPE html>\n' +
    '<html lang="en">\n' +
    '<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    GOOGLE_VERIFICATION_META + '\n' +
    '<link rel="icon" type="image/svg+xml" href="' + FAVICON_DATA_URI + '">\n' +
    '<link rel="alternate icon" href="' + FAVICON_DATA_URI + '">\n' +
    '<link rel="apple-touch-icon" href="' + FAVICON_DATA_URI + '">\n' +
    '<link rel="mask-icon" href="' + FAVICON_DATA_URI + '" color="#18181b">\n' +
    '<meta name="theme-color" content="#18181b">\n' +
    '<meta name="application-name" content="BiologyNotes">\n' +
    '<meta name="apple-mobile-web-app-title" content="BiologyNotes">\n' +
    seoHead +
    FONTS_LINK + '\n' +
    FA_LINK + '\n' +
    '<style>' + CSS + '</style>\n' +
    '</head>\n<body>\n' +
    body +
    CONFIRM_MODAL_HTML +
    CONFIRM_MODAL_SCRIPT +
    '\n</body>\n</html>';
}

function brandMark() {
  return '<div class="brand"><a href="/"><span class="brand-mark"><i class="fa-solid fa-dna"></i></span><span>BiologyNotes</span></a></div>';
}

function renderTopNav(user, active, publicViewer) {
  const isActive = (name) => (active === name ? ' active' : '');
  const authed = !!user;
  const pub = !!publicViewer;

  return '' +
    '<header class="topnav"><div class="topnav-inner">' +
    brandMark() +
    '<nav class="nav-links">' +
      '<a class="nav-link' + isActive('dashboard') + '" href="/"><i class="fa-solid fa-gauge-high"></i>' + (authed ? 'Dashboard' : 'Home') + '</a>' +
      '<a class="nav-link' + isActive('gallery') + '" href="/gallery"><i class="fa-solid fa-compass"></i>Gallery</a>' +
      (authed ? '<a class="nav-link' + isActive('upload') + '" href="/upload"><i class="fa-solid fa-cloud-arrow-up"></i>Upload</a>' : '') +
    '</nav>' +
    '<div class="nav-right">' +
      (authed
        ? '<a class="btn btn-outline btn-xs" href="/users/' + encodeURIComponent(user.username) + '">' +
            renderAvatar(user, 22) + '<span>@' + escapeHtml(user.username) + '</span>' +
          '</a>' +
          '<a class="btn btn-primary btn-xs" href="/upload"><i class="fa-solid fa-plus"></i>Upload</a>' +
          '<a class="btn btn-ghost btn-xs" href="/logout" title="Logout"><i class="fa-solid fa-right-from-bracket"></i></a>'
        : '<a class="btn btn-outline btn-xs" href="/login"><i class="fa-solid fa-arrow-right-to-bracket"></i>Sign in</a>' +
          '<a class="btn btn-primary btn-xs" href="/register"><i class="fa-solid fa-user-plus"></i>Create account</a>'
      ) +
    '</div>' +
    '</div></header>';
}

/* ------------------------------------------------------------------ *
 * Auth pages
 * ------------------------------------------------------------------ */
function renderRegister(ctx) {
  const { error = '', values = {}, info = '', isExplicitGuest = false } = ctx || {};
  const req = ctx.req;

  const seo = {
    title: 'Create an account · BiologyNotes',
    description: 'Join BiologyNotes to upload, rate, and comment on biology notes, chapters, and study files. Free forever.',
    canonical: '/register',
    ogType: 'website',
    noindex: false
  };

  const body = '' +
    renderTopNav(null, 'register', false) +
    '<div class="auth-wrap"><div class="auth-card">' +
      '<div class="auth-brand">' +
        '<div class="brand-mark" style="width:48px;height:48px"><i class="fa-solid fa-dna" style="font-size:22px"></i></div>' +
        '<h1 style="font-size:26px;margin:0">Create your account</h1>' +
        '<p class="sub" style="margin:0;text-align:center">Register to upload, rate, comment, and subscribe.</p>' +
      '</div>' +
      (info ? '<div class="alert alert-info"><i class="fa-solid fa-circle-info"></i><span>' + escapeHtml(info) + '</span></div>' : '') +
      (error ? '<div class="alert alert-error"><i class="fa-solid fa-circle-exclamation"></i><span>' + escapeHtml(error) + '</span></div>' : '') +
      '<form method="POST" action="/register">' +
        '<div class="field"><label class="label" for="f-name">Full name</label>' +
          '<input class="input" id="f-name" name="name" type="text" value="' + escapeHtml(values.name || '') + '" placeholder="Jane Doe" required autocomplete="name"></div>' +
        '<div class="field"><label class="label" for="f-email">Email address</label>' +
          '<input class="input" id="f-email" name="email" type="email" value="' + escapeHtml(values.email || '') + '" placeholder="jane@example.com" required autocomplete="email"></div>' +
        '<div class="field"><label class="label" for="f-username">Username</label>' +
          '<input class="input" id="f-username" name="username" type="text" value="' + escapeHtml(values.username || '') + '" placeholder="janedoe" required autocomplete="username" minlength="3" maxlength="20"></div>' +
        '<div class="field"><label class="label" for="f-password">Password</label>' +
          '<input class="input" id="f-password" name="password" type="password" placeholder="At least 6 characters" required autocomplete="new-password" minlength="6"></div>' +
        '<button type="submit" class="btn btn-primary btn-block btn-lg"><i class="fa-solid fa-user-plus"></i>Create account</button>' +
      '</form>' +
      (!isExplicitGuest
        ? '<div class="auth-divider">or</div>' +
          '<form method="POST" action="/guest">' +
            '<button type="submit" class="btn btn-outline btn-block btn-lg"><i class="fa-solid fa-user-secret"></i>Continue as Guest</button>' +
          '</form>' +
          '<p class="foot-note" style="margin-top:12px;font-size:12.5px">Guests can browse public files, download, and share — but cannot rate, comment, or upload.</p>'
        : '<div class="alert alert-info" style="margin-top:18px;margin-bottom:0">' +
            '<i class="fa-solid fa-circle-info"></i><span>You\'re already browsing as a guest. Registering below upgrades you to a full account.</span>' +
          '</div>') +
      '<p class="foot-note">Already registered? <a href="/login">Sign in</a></p>' +
    '</div></div>';
  return layout(seo, req, body);
}

function renderLogin(ctx) {
  const { error = '', values = {}, info = '', isExplicitGuest = false } = ctx || {};
  const req = ctx.req;

  const seo = {
    title: 'Sign in · BiologyNotes',
    description: 'Sign in to BiologyNotes to manage your notes and files.',
    canonical: '/login',
    ogType: 'website',
    noindex: false
  };

  const body = '' +
    renderTopNav(null, 'login', false) +
    '<div class="auth-wrap"><div class="auth-card">' +
      '<div class="auth-brand">' +
        '<div class="brand-mark" style="width:48px;height:48px"><i class="fa-solid fa-dna" style="font-size:22px"></i></div>' +
        '<h1 style="font-size:26px;margin:0">Welcome back</h1>' +
        '<p class="sub" style="margin:0;text-align:center">Sign in to access your dashboard and files.</p>' +
      '</div>' +
      (info ? '<div class="alert alert-info"><i class="fa-solid fa-circle-info"></i><span>' + escapeHtml(info) + '</span></div>' : '') +
      (error ? '<div class="alert alert-error"><i class="fa-solid fa-circle-exclamation"></i><span>' + escapeHtml(error) + '</span></div>' : '') +
      '<form method="POST" action="/login">' +
        '<div class="field"><label class="label" for="f-username">Username</label>' +
          '<input class="input" id="f-username" name="username" type="text" value="' + escapeHtml(values.username || '') + '" placeholder="janedoe" required autocomplete="username"></div>' +
        '<div class="field"><label class="label" for="f-password">Password</label>' +
          '<input class="input" id="f-password" name="password" type="password" placeholder="Your password" required autocomplete="current-password"></div>' +
        '<button type="submit" class="btn btn-primary btn-block btn-lg"><i class="fa-solid fa-arrow-right-to-bracket"></i>Sign in</button>' +
      '</form>' +
      (!isExplicitGuest
        ? '<div class="auth-divider">or</div>' +
          '<form method="POST" action="/guest">' +
            '<button type="submit" class="btn btn-outline btn-block btn-lg"><i class="fa-solid fa-user-secret"></i>Continue as Guest</button>' +
          '</form>' +
          '<p class="foot-note" style="margin-top:12px;font-size:12.5px">Guests can browse public files, download, and share — but cannot rate, comment, or upload.</p>'
        : '<div class="alert alert-info" style="margin-top:18px;margin-bottom:0">' +
            '<i class="fa-solid fa-circle-info"></i><span>You\'re currently browsing as a guest. Signing in below logs you into your real account.</span>' +
          '</div>') +
      '<p class="foot-note">Need an account? <a href="/register">Register</a></p>' +
    '</div></div>';
  return layout(seo, req, body);
}

/* ------------------------------------------------------------------ *
 * Preview renderer
 * ------------------------------------------------------------------ */
function renderA4ThumbInner(record, kind) {
  const ext = fileExtUpper(record.originalName);
  const fallback =
    '<div class="a4-fallback">' +
      '<i class="' + kindIconClass(kind) + '"></i>' +
      '<div class="ext-badge">' + escapeHtml(ext) + '</div>' +
      '<div class="lines"><span></span><span></span><span></span><span></span></div>' +
    '</div>';
  const thumbUrl = record.thumbnailUrl || buildA4ThumbnailUrl(record);
  const img = thumbUrl
    ? '<img src="' + escapeHtml(thumbUrl) + '" alt="' + escapeHtml(record.chapterName) + '" loading="lazy" onerror="this.style.display=\'none\'">'
    : '';
  return fallback + img;
}

function renderPreview(record) {
  const kind = fileKind(record.mimeType, record.originalName);
  const isNote = record.kind === 'note';
  const typeBadge = '<span class="type-badge">' + kindLabel(kind) + '</span>';
  const visBadge = '<span class="vis-badge">' + (record.visibility === 'public' ? 'PUBLIC' : 'PRIVATE') + '</span>';
  const commentCount = (record.comments && record.comments.length) || 0;
  const commentBadge = commentCount > 0
    ? '<span class="comment-count-badge"><i class="fa-regular fa-comment"></i>' + commentCount + '</span>'
    : '';
  const ribbon = isNote ? '<span class="ribbon"><i class="fa-solid fa-book"></i>NOTES</span>' : '';
  const href = '/files/' + encodeURIComponent(String(record._id));
  const playOverlay = (kind === 'video') ? '<div class="play-overlay"><i class="fa-solid fa-circle-play"></i></div>' : '';

  return '<a class="preview" href="' + href + '">' +
    typeBadge + visBadge + ribbon + commentBadge +
    '<div class="a4-thumb">' + renderA4ThumbInner(record, kind) + '</div>' +
    playOverlay +
    '</a>';
}

function renderCard(record, viewer, publicViewer) {
  const avg = averageRating(record);
  const ratingCount = record.ratings ? record.ratings.length : 0;
  const commentCount = (record.comments && record.comments.length) || 0;
  const kind = fileKind(record.mimeType, record.originalName);
  const isNote = record.kind === 'note';
  const owner = record.owner && typeof record.owner === 'object' ? record.owner : null;
  const ownerName = owner ? owner.name : record.ownerUsername;
  const ownerHandle = owner ? owner.username : record.ownerUsername;
  const ownerId = owner ? String(owner._id) : String(record.owner);
  const viewerId = viewer ? String(viewer._id) : null;
  const subscribed = viewer && viewerId !== ownerId && isSubscribed(viewer, ownerId);
  const isSelf = viewer && viewerId === ownerId;
  const fileId = String(record._id);

  const badges = [];
  if (isNote) {
    badges.push('<span class="badge badge-dark"><i class="fa-solid fa-bookmark"></i>CH ' + escapeHtml(record.chapterNo) + '</span>');
    badges.push('<span class="badge badge-type"><i class="' + kindIconClass(kind) + '"></i>' + kindLabel(kind) + '</span>');
    if (record.subject) badges.push('<span class="badge"><i class="fa-solid fa-tag"></i>' + escapeHtml(record.subject) + '</span>');
  } else {
    badges.push('<span class="badge badge-type"><i class="' + kindIconClass(kind) + '"></i>' + kindLabel(kind) + '</span>');
    const tags = Array.isArray(record.tags) ? record.tags.filter(Boolean).slice(0, 3) : [];
    if (tags.length) tags.forEach((t) => badges.push('<span class="badge badge-tag"><i class="fa-solid fa-hashtag"></i>' + escapeHtml(t) + '</span>'));
    else badges.push('<span class="badge badge-tag"><i class="fa-solid fa-box-open"></i>Other</span>');
  }

  let actionBtn = '';
  if (publicViewer) {
    actionBtn = '<a href="/login" class="btn btn-xs btn-outline"><i class="fa-solid fa-arrow-right-to-bracket"></i>Sign in</a>';
  } else if (viewer && isSelf) {
    actionBtn =
      '<div class="owner-actions">' +
        '<a href="/files/' + encodeURIComponent(fileId) + '/edit" class="btn btn-xs btn-outline btn-icon-xs" title="Edit"><i class="fa-solid fa-pen"></i></a>' +
        '<form method="POST" action="/files/' + encodeURIComponent(fileId) + '/delete" class="inline-form" data-confirm="This file will be permanently deleted." data-confirm-title="Delete this file?" data-confirm-action="Delete" data-confirm-variant="danger" data-confirm-icon="fa-trash-can">' +
          '<button type="submit" class="btn btn-xs btn-danger btn-icon-xs" title="Delete"><i class="fa-solid fa-trash-can"></i></button>' +
        '</form>' +
      '</div>';
  } else if (viewer) {
    actionBtn = '<form method="POST" action="/users/' + ownerId + '/subscribe" class="inline-form">' +
      '<button type="submit" class="btn btn-xs ' + (subscribed ? 'btn-outline' : 'btn-primary') + '">' +
        (subscribed ? '<i class="fa-solid fa-user-check"></i>Following' : '<i class="fa-solid fa-user-plus"></i>Follow') +
      '</button></form>';
  }

  const stars = renderStars(avg, 11);
  const ownerAvatar = owner ? renderAvatar(owner, 28) : renderAvatar({ username: ownerHandle }, 28);
  const ownerLink = publicViewer
    ? '<span style="color:#18181b;font-weight:500">@' + escapeHtml(ownerHandle) + '</span>'
    : '<a href="/users/' + encodeURIComponent(ownerHandle) + '">@' + escapeHtml(ownerHandle) + '</a>';

  return '' +
    '<article class="file-card">' +
      renderPreview(record) +
      '<div class="file-body">' +
        '<div class="file-top">' + badges.join('') + '</div>' +
        '<h3 class="file-title"><a href="/files/' + encodeURIComponent(fileId) + '">' + escapeHtml(record.chapterName) + '</a></h3>' +
        '<p class="file-sub"><i class="fa-solid fa-pen-nib"></i> ' + escapeHtml(record.writer || ownerName || 'Unknown') + ' &middot; ' + escapeHtml(formatBytes(record.size)) + '</p>' +
        (record.description ? '<p class="file-desc">' + escapeHtml(record.description) + '</p>' : '') +
        '<div class="file-stats">' +
          '<span class="stat stat-rating">' + stars + ' <span style="color:#18181b;font-weight:500">' + avg.toFixed(1) + '</span> <span style="color:#a1a1aa">(' + ratingCount + ')</span></span>' +
          '<span class="stat"><i class="fa-solid fa-download"></i>' + (record.downloads || 0) + '</span>' +
          '<span class="stat"><i class="fa-regular fa-eye"></i>' + (record.views || 0) + '</span>' +
          '<span class="stat"><i class="fa-regular fa-comment"></i>' + commentCount + '</span>' +
        '</div>' +
        '<div class="file-foot">' +
          '<div class="uploader-mini">' + ownerAvatar + ownerLink + '</div>' +
          actionBtn +
        '</div>' +
      '</div>' +
    '</article>';
}

/* ------------------------------------------------------------------ *
 * Listing pages
 * ------------------------------------------------------------------ */
function renderListing(ctx) {
  const {
    viewer, publicViewer, title, subtitle, records, activeNav,
    filter = 'all', sort = 'recent', query = '', showFilters = true, req
  } = ctx;

  const cards = records.map((r) => renderCard(r, viewer, publicViewer)).join('');

  const main = records.length
    ? '<div class="grid">' + cards + '</div>'
    : '<div class="empty">' +
        '<i class="fa-regular fa-folder-open"></i>' +
        '<h3>' + (query ? 'No files match your search' : 'No files yet') + '</h3>' +
        '<p>' + (query ? 'Try a different keyword or clear the filters.' : 'Upload your first file to see it appear here.') + '</p>' +
        (publicViewer ? '' : '<a class="btn btn-primary" href="/upload"><i class="fa-solid fa-cloud-arrow-up"></i>Upload File</a>') +
      '</div>';

  let chips = '';
  if (showFilters && !publicViewer) {
    chips = '<div class="chips">' +
        '<a class="chip' + (filter === 'all' ? ' active' : '') + '" href="/?filter=all&sort=' + encodeURIComponent(sort) + '&q=' + encodeURIComponent(query) + '"><i class="fa-solid fa-layer-group"></i>All</a>' +
        '<a class="chip' + (filter === 'notes' ? ' active' : '') + '" href="/?filter=notes&sort=' + encodeURIComponent(sort) + '&q=' + encodeURIComponent(query) + '"><i class="fa-solid fa-book"></i>Notes</a>' +
        '<a class="chip' + (filter === 'other' ? ' active' : '') + '" href="/?filter=other&sort=' + encodeURIComponent(sort) + '&q=' + encodeURIComponent(query) + '"><i class="fa-solid fa-box-open"></i>Other</a>' +
        '<a class="chip' + (filter === 'mine' ? ' active' : '') + '" href="/?filter=mine&sort=' + encodeURIComponent(sort) + '&q=' + encodeURIComponent(query) + '"><i class="fa-regular fa-user"></i>Mine</a>' +
        '<a class="chip' + (filter === 'subscribed' ? ' active' : '') + '" href="/?filter=subscribed&sort=' + encodeURIComponent(sort) + '&q=' + encodeURIComponent(query) + '"><i class="fa-solid fa-user-check"></i>Following</a>' +
        '<a class="chip' + (filter === 'public' ? ' active' : '') + '" href="/?filter=public&sort=' + encodeURIComponent(sort) + '&q=' + encodeURIComponent(query) + '"><i class="fa-solid fa-globe"></i>Public</a>' +
      '</div>';
  }

  const toolbar = '' +
    '<form class="toolbar" method="GET" action="' + (activeNav === 'gallery' ? '/gallery' : '/') + '">' +
      '<input class="input" type="text" name="q" placeholder="Search by chapter, subject, writer, tag, or @user..." value="' + escapeHtml(query) + '">' +
      '<select class="select" name="sort">' +
        '<option value="recent"' + (sort === 'recent' ? ' selected' : '') + '>Most recent</option>' +
        '<option value="downloads"' + (sort === 'downloads' ? ' selected' : '') + '>Most downloaded</option>' +
        '<option value="rating"' + (sort === 'rating' ? ' selected' : '') + '>Top rated</option>' +
        '<option value="name"' + (sort === 'name' ? ' selected' : '') + '>Name (A–Z)</option>' +
      '</select>' +
      '<input type="hidden" name="filter" value="' + escapeHtml(filter) + '">' +
      '<button class="btn btn-primary" type="submit"><i class="fa-solid fa-magnifying-glass"></i>Search</button>' +
      chips +
    '</form>';

  const guestBanner = publicViewer
    ? '<div class="guest-banner">' +
        '<i class="fa-solid fa-user-secret"></i>' +
        '<div class="guest-banner-text">' +
          '<b>You\'re browsing as a guest.</b> You can view public files, download, and share. ' +
          'Sign in to upload, rate, comment, and follow other users.' +
        '</div>' +
        '<div class="guest-banner-actions">' +
          '<a class="btn btn-outline btn-xs" href="/login"><i class="fa-solid fa-arrow-right-to-bracket"></i>Sign in</a>' +
          '<a class="btn btn-primary btn-xs" href="/register"><i class="fa-solid fa-user-plus"></i>Create account</a>' +
        '</div>' +
      '</div>'
    : '';

  const body = '' +
    renderTopNav(viewer, activeNav, publicViewer) +
    '<div class="container">' +
      guestBanner +
      '<div class="banner">' +
        '<div class="user-info">' +
          (publicViewer
            ? '<div class="guest-badge" style="width:46px;height:46px;font-size:20px"><i class="fa-solid fa-user-secret"></i></div>' +
              '<div><div class="user-name">' + escapeHtml(title) + '</div><div class="user-meta">' + escapeHtml(subtitle) + '</div></div>'
            : renderAvatar(viewer, 46) +
              '<div><div class="user-name">' + escapeHtml(title) + '</div><div class="user-meta">' + escapeHtml(subtitle) + '</div></div>') +
        '</div>' +
        '<div class="actions row">' +
          (publicViewer
            ? '<a class="btn btn-outline" href="/gallery"><i class="fa-solid fa-compass"></i>Gallery</a>'
            : '<a class="btn btn-primary" href="/upload"><i class="fa-solid fa-cloud-arrow-up"></i>Upload File</a>' +
              '<a class="btn btn-outline" href="/gallery"><i class="fa-solid fa-compass"></i>Gallery</a>') +
        '</div>' +
      '</div>' +
      toolbar +
      '<div class="section-head">' +
        '<h2>Files</h2>' +
        '<span class="count">' + records.length + ' file' + (records.length === 1 ? '' : 's') + '</span>' +
      '</div>' +
      main +
    '</div>';

  return body;
}

function renderHome(ctx) {
  const { user, publicViewer, records, notice = '', filter = 'all', sort = 'recent', query = '', req } = ctx;

  let title, subtitle, seo;
  if (user) {
    const subs = user.subscribers ? user.subscribers.length : 0;
    title = user.name;
    subtitle = '@' + user.username + ' · ' + user.email + ' · ' + subs + ' subscriber' + (subs === 1 ? '' : 's');
    seo = seoForHome(user, false);
  } else {
    title = 'Welcome to BiologyNotes';
    subtitle = 'Browse public biology notes, chapters, and study files — no account needed';
    seo = seoForHome(null, true);
  }

  const noticeHtml = notice
    ? '<div class="alert alert-success"><i class="fa-solid fa-circle-check"></i><span>' + escapeHtml(notice) + '</span></div>'
    : '';

  const inner = renderListing({
    viewer: user, publicViewer, title, subtitle, records,
    activeNav: 'dashboard', filter, sort, query, showFilters: !publicViewer, req
  });

  const body = notice
    ? inner.replace('<div class="container">', '<div class="container">' + noticeHtml)
    : inner;

  return layout(seo, req, body);
}

function renderGallery(ctx) {
  const { user, publicViewer, records, filter = 'public', sort = 'recent', query = '', req } = ctx;
  const seo = seoForGallery();
  const body = renderListing({
    viewer: user, publicViewer,
    title: 'Public Gallery',
    subtitle: 'Browse every public file shared across BiologyNotes.',
    records, activeNav: 'gallery', filter, sort, query, showFilters: false, req
  });
  return layout(seo, req, body);
}

/* ------------------------------------------------------------------ *
 * Upload page
 * ------------------------------------------------------------------ */
function renderUpload(ctx) {
  const { user, error = '', values = {}, activeTab = 'notes', req } = ctx;
  const visibility = values.visibility === 'private' ? 'private' : 'public';
  const safeActiveTab = activeTab === 'other' ? 'other' : 'notes';
  const seo = { title: 'Upload · BiologyNotes', description: 'Upload a note or file to BiologyNotes.', canonical: '/upload', noindex: true };

  const body = '' +
    renderTopNav(user, 'upload', false) +
    '<div class="container">' +
      '<div class="banner">' +
        '<div class="user-info">' + renderAvatar(user, 46) +
          '<div><div class="user-name">' + escapeHtml(user.name) + '</div>' +
          '<div class="user-meta">@' + escapeHtml(user.username) + ' · ' + escapeHtml(user.email) + '</div></div>' +
        '</div>' +
        '<div class="actions row">' +
          '<a class="btn btn-outline" href="/"><i class="fa-solid fa-arrow-left"></i>Back to dashboard</a>' +
          '<a class="btn btn-ghost" href="/logout"><i class="fa-solid fa-right-from-bracket"></i>Logout</a>' +
        '</div>' +
      '</div>' +

      '<div class="card">' +
        '<div class="upload-header">' +
          '<div><div class="eyebrow">New upload</div><h1>Publish something</h1>' +
          '<p class="sub" style="margin:6px 0 0">Choose a tab. Upload a chapter note, or share any file with tags. Max file size is 100 MB.</p></div>' +
        '</div>' +
        (error ? '<div class="alert alert-error"><i class="fa-solid fa-circle-exclamation"></i><span>' + escapeHtml(error) + '</span></div>' : '') +

        '<div class="tabs" role="tablist">' +
          '<button type="button" role="tab" class="tab' + (safeActiveTab === 'notes' ? ' active' : '') + '" data-tab="notes"><i class="fa-solid fa-book"></i>Notes</button>' +
          '<button type="button" role="tab" class="tab' + (safeActiveTab === 'other' ? ' active' : '') + '" data-tab="other"><i class="fa-solid fa-box-open"></i>Upload Other Things</button>' +
        '</div>' +

        '<div class="tab-panel' + (safeActiveTab === 'notes' ? ' active' : '') + '" id="panel-notes">' +
          '<form method="POST" action="/upload" enctype="multipart/form-data" id="upload-form-notes">' +
            '<input type="hidden" name="kind" value="note">' +
            '<div class="field"><label class="label" for="notes-file">File</label>' +
              '<div class="dropzone" id="notes-dropzone" tabindex="0" role="button" aria-label="Upload a note file">' +
                '<input type="file" id="notes-file" name="file" required aria-label="Choose a file">' +
                '<div class="dropzone-inner" id="notes-dropzone-default">' +
                  '<div class="dropzone-icon"><i class="fa-solid fa-cloud-arrow-up"></i></div>' +
                  '<div class="dropzone-title">Drag &amp; drop your note here, or <span class="browse">browse</span></div>' +
                  '<div class="dropzone-hint">Any file type &middot; <strong>up to 100 MB</strong></div>' +
                '</div>' +
                '<div class="file-chip" id="notes-dropzone-selected" style="display:none">' +
                  '<div class="file-chip-icon" id="notes-chip-icon"><i class="fa-regular fa-file"></i></div>' +
                  '<div class="file-chip-body"><div class="file-chip-name" id="notes-chip-name">filename.ext</div>' +
                  '<div class="file-chip-meta"><span id="notes-chip-size">0 B</span><span class="dot"></span><span id="notes-chip-type">file</span></div></div>' +
                  '<button type="button" class="file-chip-remove" id="notes-chip-remove" title="Remove file"><i class="fa-solid fa-xmark"></i></button>' +
                '</div>' +
                '<div class="progress" id="notes-progress"><div class="progress-bar" id="notes-progress-bar"></div></div>' +
              '</div>' +
            '</div>' +
            '<div class="form-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:0 16px">' +
              '<div class="field"><label class="label" for="f-chapterNo">Chapter No</label><input class="input" id="f-chapterNo" name="chapterNo" type="number" min="0" step="1" value="' + escapeHtml(values.chapterNo || '') + '" placeholder="1" required></div>' +
              '<div class="field"><label class="label" for="f-chapterName">Chapter Name</label><input class="input" id="f-chapterName" name="chapterName" type="text" value="' + escapeHtml(values.chapterName || '') + '" placeholder="Introduction to Algebra" required></div>' +
              '<div class="field"><label class="label" for="f-subject">Subject</label><input class="input" id="f-subject" name="subject" type="text" value="' + escapeHtml(values.subject || '') + '" placeholder="Biology" required></div>' +
              '<div class="field"><label class="label" for="f-writer">Writer</label><input class="input" id="f-writer" name="writer" type="text" value="' + escapeHtml(values.writer || user.name || '') + '" placeholder="John Smith" required></div>' +
            '</div>' +
            '<div class="field"><label class="label" for="f-description">Description</label>' +
              '<textarea class="textarea" id="f-description" name="description" placeholder="Short summary of the chapter contents...">' + escapeHtml(values.description || '') + '</textarea></div>' +
            '<div class="field"><label class="label" for="f-visibility">Visibility</label>' +
              '<select class="select" id="f-visibility" name="visibility">' +
                '<option value="public"' + (visibility === 'public' ? ' selected' : '') + '>Public — visible to everyone</option>' +
                '<option value="private"' + (visibility === 'private' ? ' selected' : '') + '>Private — visible only to you</option>' +
              '</select></div>' +
            '<div class="form-actions" style="display:flex;gap:10px;align-items:center;margin-top:8px;flex-wrap:wrap">' +
              '<button type="submit" class="btn btn-primary btn-lg" id="notes-submit-btn"><i class="fa-solid fa-cloud-arrow-up"></i>Publish note</button>' +
              '<a class="btn btn-outline btn-lg" href="/">Cancel</a></div>' +
          '</form>' +
        '</div>' +

        '<div class="tab-panel' + (safeActiveTab === 'other' ? ' active' : '') + '" id="panel-other">' +
          '<form method="POST" action="/upload" enctype="multipart/form-data" id="upload-form-other">' +
            '<input type="hidden" name="kind" value="other">' +
            '<div class="field"><label class="label" for="other-file">File</label>' +
              '<div class="dropzone" id="other-dropzone" tabindex="0" role="button" aria-label="Upload any file">' +
                '<input type="file" id="other-file" name="file" required aria-label="Choose a file">' +
                '<div class="dropzone-inner" id="other-dropzone-default">' +
                  '<div class="dropzone-icon"><i class="fa-solid fa-cloud-arrow-up"></i></div>' +
                  '<div class="dropzone-title">Drag &amp; drop any file here, or <span class="browse">browse</span></div>' +
                  '<div class="dropzone-hint">Any file type &middot; <strong>up to 100 MB</strong></div>' +
                '</div>' +
                '<div class="file-chip" id="other-dropzone-selected" style="display:none">' +
                  '<div class="file-chip-icon" id="other-chip-icon"><i class="fa-regular fa-file"></i></div>' +
                  '<div class="file-chip-body"><div class="file-chip-name" id="other-chip-name">filename.ext</div>' +
                  '<div class="file-chip-meta"><span id="other-chip-size">0 B</span><span class="dot"></span><span id="other-chip-type">file</span></div></div>' +
                  '<button type="button" class="file-chip-remove" id="other-chip-remove" title="Remove file"><i class="fa-solid fa-xmark"></i></button>' +
                '</div>' +
                '<div class="progress" id="other-progress"><div class="progress-bar" id="other-progress-bar"></div></div>' +
              '</div>' +
            '</div>' +
            '<div class="field"><label class="label" for="other-writer">Your name</label>' +
              '<input class="input" id="other-writer" name="writer" type="text" value="' + escapeHtml(values.writer || user.name || '') + '" placeholder="Your name" required maxlength="120"></div>' +
            '<div class="field"><label class="label">Tags <span style="color:#a1a1aa;font-weight:400">(up to 3)</span></label>' +
              '<div class="tags-grid">' +
                '<div class="tag-field"><span class="tag-prefix">#</span><input class="input" name="tag1" type="text" placeholder="Tag 1" maxlength="30" value="' + escapeHtml(values.tag1 || '') + '"></div>' +
                '<div class="tag-field"><span class="tag-prefix">#</span><input class="input" name="tag2" type="text" placeholder="Tag 2" maxlength="30" value="' + escapeHtml(values.tag2 || '') + '"></div>' +
                '<div class="tag-field"><span class="tag-prefix">#</span><input class="input" name="tag3" type="text" placeholder="Tag 3" maxlength="30" value="' + escapeHtml(values.tag3 || '') + '"></div>' +
              '</div>' +
              '<p class="tag-hint"><i class="fa-solid fa-circle-info"></i>Add up to 3 tags. At least one tag is required.</p></div>' +
            '<div class="field"><label class="label" for="other-description">Description <span style="color:#a1a1aa;font-weight:400">(optional)</span></label>' +
              '<textarea class="textarea" id="other-description" name="description" placeholder="Short description of what you are sharing...">' + escapeHtml(values.description || '') + '</textarea></div>' +
            '<div class="field"><label class="label" for="other-visibility">Visibility</label>' +
              '<select class="select" id="other-visibility" name="visibility">' +
                '<option value="public"' + (visibility === 'public' ? ' selected' : '') + '>Public — visible to everyone</option>' +
                '<option value="private"' + (visibility === 'private' ? ' selected' : '') + '>Private — visible only to you</option>' +
              '</select></div>' +
            '<div class="form-actions" style="display:flex;gap:10px;align-items:center;margin-top:8px;flex-wrap:wrap">' +
              '<button type="submit" class="btn btn-primary btn-lg" id="other-submit-btn"><i class="fa-solid fa-cloud-arrow-up"></i>Upload</button>' +
              '<a class="btn btn-outline btn-lg" href="/">Cancel</a></div>' +
          '</form>' +
        '</div>' +

      '</div>' +
    '</div>' +

    '<script>' +
    '(function(){' +
      'var tabs=document.querySelectorAll(".tab");' +
      'var panels={notes:document.getElementById("panel-notes"),other:document.getElementById("panel-other")};' +
      'function activateTab(name){tabs.forEach(function(t){t.classList.toggle("active",t.getAttribute("data-tab")===name);});Object.keys(panels).forEach(function(k){if(panels[k])panels[k].classList.toggle("active",k===name);});try{history.replaceState(null,"","/upload?tab="+name);}catch(e){}}' +
      'tabs.forEach(function(t){t.addEventListener("click",function(){activateTab(t.getAttribute("data-tab"));});});' +
      'function fmt(b){if(!b&&b!==0)return "0 B";var u=["B","KB","MB","GB"],i=Math.min(Math.floor(Math.log(b)/Math.log(1024)),u.length-1);var v=b/Math.pow(1024,i);return v.toFixed(i===0?0:1)+" "+u[i];}' +
      'function iconFor(name,mime){var ext=(name.split(".").pop()||"").toLowerCase();var m=(mime||"").toLowerCase();if(m.indexOf("image/")===0)return ["fa-regular fa-image","Image"];if(m.indexOf("video/")===0)return ["fa-solid fa-video","Video"];if(m.indexOf("audio/")===0)return ["fa-solid fa-music","Audio"];if(m==="application/pdf"||ext==="pdf")return ["fa-regular fa-file-pdf","PDF"];if(m.indexOf("text/")===0||["txt","md","csv","json","js","ts","html","css","xml","yml","yaml"].indexOf(ext)>=0)return ["fa-regular fa-file-lines","Text"];return ["fa-regular fa-file","File"];}' +
      'function initDropzone(prefix,formId,submitBtnId){' +
        'var dz=document.getElementById(prefix+"-dropzone");var input=document.getElementById(prefix+"-file");var def=document.getElementById(prefix+"-dropzone-default");var sel=document.getElementById(prefix+"-dropzone-selected");var iconEl=document.getElementById(prefix+"-chip-icon");var nameEl=document.getElementById(prefix+"-chip-name");var sizeEl=document.getElementById(prefix+"-chip-size");var typeEl=document.getElementById(prefix+"-chip-type");var rm=document.getElementById(prefix+"-chip-remove");var prog=document.getElementById(prefix+"-progress");var bar=document.getElementById(prefix+"-progress-bar");var form=document.getElementById(formId);var btn=document.getElementById(submitBtnId);if(!dz||!input)return;' +
        'function showFile(f){if(!f){def.style.display="";sel.style.display="none";dz.classList.remove("has-file");return;}var info=iconFor(f.name,f.type);iconEl.innerHTML=\'<i class="\'+info[0]+\'"></i>\';nameEl.textContent=f.name;sizeEl.textContent=fmt(f.size);typeEl.textContent=info[1];def.style.display="none";sel.style.display="flex";dz.classList.add("has-file");}' +
        'function clearFile(){input.value="";showFile(null);}' +
        'input.addEventListener("change",function(){showFile(input.files&&input.files[0]);});' +
        'rm.addEventListener("click",function(e){e.stopPropagation();e.preventDefault();clearFile();});' +
        '["dragenter","dragover"].forEach(function(ev){dz.addEventListener(ev,function(e){e.preventDefault();e.stopPropagation();dz.classList.add("dragover");});});' +
        '["dragleave","drop"].forEach(function(ev){dz.addEventListener(ev,function(e){e.preventDefault();e.stopPropagation();dz.classList.remove("dragover");});});' +
        'dz.addEventListener("drop",function(e){e.preventDefault();var dt=e.dataTransfer;if(!dt||!dt.files||!dt.files.length)return;try{var d=new DataTransfer();for(var i=0;i<dt.files.length;i++)d.items.add(dt.files[i]);input.files=d.files;}catch(err){}showFile(dt.files[0]);});' +
        'dz.addEventListener("click",function(e){if(e.target===input)return;if(rm.contains(e.target))return;input.click();});' +
        'if(form){form.addEventListener("submit",function(){var f=input.files&&input.files[0];if(!f)return;prog.classList.add("on");bar.style.width="8%";var t=setInterval(function(){var w=parseFloat(bar.style.width)||0;if(w<92){bar.style.width=(w+Math.random()*7)+"%";}else{clearInterval(t);}},180);if(btn){btn.disabled=true;btn.innerHTML=\'<i class="fa-solid fa-circle-notch fa-spin"></i>Uploading...\';}});}' +
      '}' +
      'initDropzone("notes","upload-form-notes","notes-submit-btn");' +
      'initDropzone("other","upload-form-other","other-submit-btn");' +
    '})();' +
    '</script>';

  return layout(seo, req, body);
}

/* ------------------------------------------------------------------ *
 * Share card
 * ------------------------------------------------------------------ */
function renderShareCard() {
  return '<div class="share-card">' +
      '<div class="share-card-head"><i class="fa-solid fa-share-nodes"></i>Share this file</div>' +
      '<div class="share-buttons">' +
        '<button type="button" class="share-btn wa" data-share="whatsapp" title="Share on WhatsApp" aria-label="Share on WhatsApp"><i class="fa-brands fa-whatsapp"></i></button>' +
        '<button type="button" class="share-btn fb" data-share="facebook" title="Share on Facebook" aria-label="Share on Facebook"><i class="fa-brands fa-facebook-f"></i></button>' +
        '<button type="button" class="share-btn tw" data-share="twitter" title="Share on X (Twitter)" aria-label="Share on X"><i class="fa-brands fa-x-twitter"></i></button>' +
        '<button type="button" class="share-btn li" data-share="linkedin" title="Share on LinkedIn" aria-label="Share on LinkedIn"><i class="fa-brands fa-linkedin-in"></i></button>' +
        '<button type="button" class="share-btn tg" data-share="telegram" title="Share on Telegram" aria-label="Share on Telegram"><i class="fa-brands fa-telegram"></i></button>' +
        '<button type="button" class="share-btn rd" data-share="reddit" title="Share on Reddit" aria-label="Share on Reddit"><i class="fa-brands fa-reddit-alien"></i></button>' +
        '<button type="button" class="share-btn em" data-share="email" title="Share via Email" aria-label="Share via Email"><i class="fa-solid fa-envelope"></i></button>' +
        '<button type="button" class="share-btn cp" data-share="copy" title="Copy link" aria-label="Copy link"><i class="fa-solid fa-link"></i></button>' +
      '</div>' +
      '<p class="share-hint">Tip: use <b>Copy Link</b> to share to GitHub, Notion, Discord, or anywhere else.</p>' +
    '</div>';
}

/* ------------------------------------------------------------------ *
 * Comments
 * ------------------------------------------------------------------ */
function renderCommentsSection(record, viewer, publicViewer) {
  const comments = Array.isArray(record.comments) ? record.comments.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)) : [];
  const count = comments.length;
  const isOwner = viewer && String(viewer._id) === String(record.owner);

  const items = comments.map((c) => {
    const canDelete = viewer && (String(c.user) === String(viewer._id) || isOwner);
    const avatar = c.avatarUrl
      ? '<img class="avatar-sm avatar-img" src="' + escapeHtml(c.avatarUrl) + '" alt="' + escapeHtml(c.name) + '" style="width:34px;height:34px;object-fit:cover;display:block">'
      : '<div class="avatar-sm" style="width:34px;height:34px;font-size:13px">' + escapeHtml((c.name || '?').trim().charAt(0).toUpperCase()) + '</div>';

    return '<div class="comment">' +
      '<div class="comment-avatar-wrap">' + avatar + '</div>' +
      '<div class="comment-body">' +
        '<div class="comment-head">' +
          '<span class="comment-author">' +
            (publicViewer ? escapeHtml(c.name) : '<a href="/users/' + encodeURIComponent(c.username) + '">' + escapeHtml(c.name) + '</a>') +
            ' <span style="color:#a1a1aa;font-weight:400">@' + escapeHtml(c.username) + '</span>' +
          '</span>' +
          '<span class="comment-time" title="' + escapeHtml(formatDate(c.createdAt)) + '">' + escapeHtml(timeAgo(c.createdAt)) + '</span>' +
          (canDelete
            ? '<form method="POST" action="/files/' + encodeURIComponent(String(record._id)) + '/comment/' + encodeURIComponent(String(c._id)) + '/delete" class="inline-form comment-actions" data-confirm="This comment will be permanently deleted." data-confirm-title="Delete comment?" data-confirm-action="Delete" data-confirm-variant="danger" data-confirm-icon="fa-trash-can">' +
                '<button type="submit" class="comment-delete" title="Delete comment"><i class="fa-solid fa-trash-can"></i></button></form>'
            : '') +
        '</div>' +
        '<div class="comment-text">' + escapeHtml(c.text) + '</div>' +
      '</div>' +
    '</div>';
  }).join('');

  const emptyState = count === 0
    ? '<div class="comments-empty"><i class="fa-regular fa-comments"></i>' + (publicViewer ? 'No comments yet.' : 'No comments yet. Be the first to comment!') + '</div>'
    : '';

  const formBlock = publicViewer
    ? '<div class="comment-signin-prompt">' +
        '<i class="fa-solid fa-circle-info"></i>' +
        '<div style="flex:1;min-width:0">Sign in or create an account to leave a comment.</div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
          '<a class="btn btn-outline btn-xs" href="/login"><i class="fa-solid fa-arrow-right-to-bracket"></i>Sign in</a>' +
          '<a class="btn btn-primary btn-xs" href="/register"><i class="fa-solid fa-user-plus"></i>Register</a>' +
        '</div>' +
      '</div>'
    : '<form method="POST" action="/files/' + encodeURIComponent(String(record._id)) + '/comment" class="comment-form">' +
        '<textarea class="textarea" name="text" placeholder="Write a comment… (max ' + MAX_COMMENT_LEN + ' characters)" maxlength="' + MAX_COMMENT_LEN + '" required></textarea>' +
        '<div class="comment-form-actions"><button type="submit" class="btn btn-primary"><i class="fa-solid fa-paper-plane"></i>Post comment</button></div>' +
      '</form>';

  return '<section class="comments-card" id="comments">' +
    '<div class="comments-head"><h2><i class="fa-regular fa-comments"></i>Comments <span class="comment-count-pill">' + count + '</span></h2></div>' +
    formBlock +
    (count > 0 ? '<div class="comment-list">' + items + '</div>' : emptyState) +
  '</section>';
}

/* ------------------------------------------------------------------ *
 * File detail
 * ------------------------------------------------------------------ */
function renderFileDetail(ctx) {
  const { user, publicViewer, record, owner, notice = '', error = '', req } = ctx;
  const kind = fileKind(record.mimeType, record.originalName);
  const isNote = record.kind === 'note';
  const fid = String(record._id);
  const src = record.fileUrl;
  const avg = averageRating(record);
  const ratingCount = record.ratings.length;
  const myRating = user ? userRating(record, user._id) : 0;
  const ownerId = owner ? String(owner._id) : String(record.owner);
  const viewerId = user ? String(user._id) : null;
  const subscribed = !publicViewer && user && viewerId !== ownerId && isSubscribed(user, ownerId);
  const isSelf = !publicViewer && user && viewerId === ownerId;

  const seo = seoForFile(record, owner);

  // JSON-LD for the file
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'CreativeWork',
    name: record.chapterName,
    description: record.description || ('Biology note on ' + (record.subject || 'biology')),
    author: { '@type': 'Person', name: record.writer || (owner ? owner.name : record.ownerUsername) },
    datePublished: record.createdAt,
    url: (SITE_URL || (req.protocol + '://' + req.get('host'))) + '/files/' + fid,
    about: record.subject || '',
    keywords: (Array.isArray(record.tags) ? record.tags.join(', ') : ''),
    genre: isNote ? 'Biology Notes' : 'Study File'
  };
  if (record.thumbnailUrl) jsonLd.image = record.thumbnailUrl;
  if (avg > 0) {
    jsonLd.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: avg.toFixed(1),
      ratingCount: ratingCount,
      bestRating: 5,
      worstRating: 1
    };
  }

  let preview;
  let previewExtraClass = '';
  if (kind === 'image') preview = '<img src="' + escapeHtml(src) + '" alt="' + escapeHtml(record.chapterName) + '">';
  else if (kind === 'video') preview = '<video src="' + escapeHtml(src) + '" controls preload="metadata"></video>';
  else if (kind === 'audio') preview = '<audio src="' + escapeHtml(src) + '" controls preload="metadata"></audio>';
  else if (kind === 'pdf') { previewExtraClass = ' detail-preview-light'; preview = '<iframe src="' + escapeHtml(src) + '" title="PDF preview"></iframe>'; }
  else {
    previewExtraClass = ' detail-preview-light';
    const thumbUrl = record.thumbnailUrl || buildA4ThumbnailUrl(record);
    const inner = thumbUrl ? '<img src="' + escapeHtml(thumbUrl) + '" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover" onerror="this.style.display=\'none\'">' : '';
    preview = '<div class="detail-a4-wrap"><div class="detail-a4">' +
      '<div class="a4-fallback">' +
        '<i class="' + kindIconClass(kind) + '"></i>' +
        '<div class="ext-badge">' + escapeHtml(fileExtUpper(record.originalName)) + '</div>' +
        '<div class="lines"><span></span><span></span><span></span><span></span></div>' +
      '</div>' + inner +
    '</div></div>';
  }

  let ratingBlock = '';
  if (publicViewer) {
    ratingBlock = '<div class="rating-block">' +
      '<div class="rating-head"><div class="rating-avg">' + avg.toFixed(1) + '</div>' +
      '<div><div class="rating-stars">' + renderStars(avg, 15) + '</div>' +
      '<div class="rating-count">' + ratingCount + ' rating' + (ratingCount === 1 ? '' : 's') + '</div></div></div>' +
      '<div class="comment-signin-prompt" style="margin:0"><i class="fa-solid fa-circle-info"></i>' +
      '<div style="flex:1;min-width:0">Sign in to rate this file.</div>' +
      '<a class="btn btn-outline btn-xs" href="/login"><i class="fa-solid fa-arrow-right-to-bracket"></i>Sign in</a></div></div>';
  } else {
    let stars = '';
    for (let i = 1; i <= 5; i++) {
      stars += '<button type="button" class="star-btn' + (myRating >= i ? ' on' : '') + '" data-value="' + i + '" aria-label="Rate ' + i + ' star' + (i > 1 ? 's' : '') + '"><i class="' + (myRating >= i ? 'fa-solid' : 'fa-regular') + ' fa-star"></i></button>';
    }
    ratingBlock = '<div class="rating-block" id="rating-block" data-file-id="' + escapeHtml(fid) + '">' +
      '<div class="rating-head"><div class="rating-avg" id="rating-avg">' + avg.toFixed(1) + '</div>' +
      '<div><div class="rating-stars" id="rating-stars">' + renderStars(avg, 15) + '</div>' +
      '<div class="rating-count"><span id="rating-count">' + ratingCount + '</span> rating' + (ratingCount === 1 ? '' : 's') + '</div></div></div>' +
      '<div><div class="label" style="margin-bottom:4px">Your rating</div>' +
      '<div class="rating-input" id="rating-input" data-current="' + myRating + '">' + stars + '</div>' +
      '<div class="rating-hint" id="rating-hint">' + (myRating ? 'You rated ' + myRating + ' star' + (myRating > 1 ? 's' : '') + '.' : 'Click a star to rate this file.') + '</div></div></div>';
  }

  const ownerSubscribers = owner && owner.subscribers ? owner.subscribers.length : 0;
  const ownerPublicFiles = ctx.ownerPublicFiles || 0;

  let subscribeBtn = '';
  if (publicViewer) subscribeBtn = '<a class="btn btn-outline btn-block" href="/login"><i class="fa-solid fa-arrow-right-to-bracket"></i>Sign in to subscribe</a>';
  else if (!isSelf && owner) subscribeBtn = '<form method="POST" action="/users/' + ownerId + '/subscribe" class="inline-form" style="width:100%"><button type="submit" class="btn ' + (subscribed ? 'btn-outline' : 'btn-primary') + ' btn-block">' + (subscribed ? '<i class="fa-solid fa-user-check"></i>Subscribed' : '<i class="fa-solid fa-user-plus"></i>Subscribe') + '</button></form>';
  else if (isSelf) subscribeBtn = '<a class="btn btn-outline btn-block" href="/users/' + encodeURIComponent(user.username) + '"><i class="fa-regular fa-user"></i>View my profile</a>';

  const editBtn = (!publicViewer && isSelf)
    ? '<a class="btn btn-outline btn-xs" href="/files/' + encodeURIComponent(fid) + '/edit"><i class="fa-solid fa-pen"></i>Edit</a>' : '';
  const deleteBtn = (!publicViewer && isSelf)
    ? '<form method="POST" action="/files/' + encodeURIComponent(fid) + '/delete" class="inline-form" data-confirm="This file will be permanently deleted." data-confirm-title="Delete this file?" data-confirm-action="Delete" data-confirm-variant="danger" data-confirm-icon="fa-trash-can"><button type="submit" class="btn btn-danger btn-xs"><i class="fa-solid fa-trash-can"></i>Delete</button></form>' : '';

  const sideThumbHtml =
    '<div class="a4-thumb-card"><div class="a4-thumb-card-head"><i class="fa-solid fa-file-image"></i>A4 Preview</div>' +
    '<div class="a4-thumb-card-body"><div class="a4-thumb">' + renderA4ThumbInner(record, kind) + '</div></div></div>';

  const detailBadges = [];
  if (isNote) {
    detailBadges.push('<span class="badge badge-dark"><i class="fa-solid fa-bookmark"></i>Chapter ' + escapeHtml(record.chapterNo) + '</span>');
    detailBadges.push('<span class="badge" style="background:#facc15;color:#18181b;border-color:#facc15"><i class="fa-solid fa-book"></i>NOTES</span>');
  } else detailBadges.push('<span class="badge" style="background:#f4f4f5;color:#3f3f46;border-color:#e4e4e7"><i class="fa-solid fa-box-open"></i>OTHER</span>');
  detailBadges.push('<span class="badge badge-type"><i class="' + kindIconClass(kind) + '"></i>' + kindLabel(kind) + '</span>');
  detailBadges.push('<span class="badge"><i class="fa-solid fa-eye"></i>' + escapeHtml(record.visibility.toUpperCase()) + '</span>');

  const tagsRow = (!isNote && Array.isArray(record.tags) && record.tags.filter(Boolean).length)
    ? '<div class="file-top" style="margin-top:12px">' + record.tags.filter(Boolean).map((t) =>
        '<a href="/?filter=all&q=' + encodeURIComponent(t) + '" class="badge badge-tag" style="text-decoration:none"><i class="fa-solid fa-hashtag"></i>' + escapeHtml(t) + '</a>').join('') + '</div>'
    : '';
  const subjectLine = isNote && record.subject ? '<i class="fa-solid fa-tag"></i> ' + escapeHtml(record.subject) + ' &middot; ' : '';

  const guestBanner = publicViewer
    ? '<div class="guest-banner"><i class="fa-solid fa-user-secret"></i>' +
      '<div class="guest-banner-text"><b>You\'re browsing as a guest.</b> You can download and share this file. Sign in to rate it, leave a comment, and follow the uploader.</div>' +
      '<div class="guest-banner-actions"><a class="btn btn-outline btn-xs" href="/login"><i class="fa-solid fa-arrow-right-to-bracket"></i>Sign in</a>' +
      '<a class="btn btn-primary btn-xs" href="/register"><i class="fa-solid fa-user-plus"></i>Register</a></div></div>'
    : '';

  const commentsHtml = renderCommentsSection(record, user, publicViewer);

  const body = '' +
    renderTopNav(user, '', publicViewer) +
    '<script type="application/ld+json">' + JSON.stringify(jsonLd) + '</script>' +
    '<div class="container">' +
      '<div class="flex-between" style="margin-bottom:16px">' +
        '<a class="btn btn-ghost btn-xs" href="' + (record.visibility === 'public' ? '/gallery' : '/') + '"><i class="fa-solid fa-arrow-left"></i>Back</a>' +
        '<div class="row">' + editBtn + deleteBtn +
          '<a class="btn btn-primary btn-xs" href="/files/' + encodeURIComponent(fid) + '/download"><i class="fa-solid fa-download"></i>Download</a>' +
        '</div>' +
      '</div>' +

      guestBanner +
      (notice ? '<div class="alert alert-success"><i class="fa-solid fa-circle-check"></i><span>' + escapeHtml(notice) + '</span></div>' : '') +
      (error ? '<div class="alert alert-error"><i class="fa-solid fa-circle-exclamation"></i><span>' + escapeHtml(error) + '</span></div>' : '') +

      '<div class="detail-grid"><div>' +
        '<div class="detail-preview' + previewExtraClass + '">' + preview + '</div>' +
        '<div class="card" style="margin-top:16px">' +
          '<div class="file-top" style="margin-bottom:10px">' + detailBadges.join('') + '</div>' +
          '<h1 style="font-size:26px">' + escapeHtml(record.chapterName) + '</h1>' +
          '<p class="sub" style="margin:6px 0 0">' + subjectLine + '<i class="fa-solid fa-pen-nib"></i> ' + escapeHtml(record.writer || (owner ? owner.name : record.ownerUsername)) + '</p>' +
          tagsRow +
          '<div style="margin-top:16px">' + (record.description ? '<p style="color:#3f3f46;white-space:pre-wrap">' + escapeHtml(record.description) + '</p>' : '<p class="text-muted">No description provided.</p>') + '</div>' +
          '<div class="meta-grid">' +
            '<div class="meta-item"><span class="k">File name</span><span class="v">' + escapeHtml(record.originalName) + '</span></div>' +
            '<div class="meta-item"><span class="k">Type</span><span class="v">' + escapeHtml(record.mimeType || kindLabel(kind)) + '</span></div>' +
            '<div class="meta-item"><span class="k">Size</span><span class="v">' + escapeHtml(formatBytes(record.size)) + '</span></div>' +
            '<div class="meta-item"><span class="k">Uploaded</span><span class="v">' + escapeHtml(formatDate(record.createdAt)) + '</span></div>' +
            '<div class="meta-item"><span class="k">Downloads</span><span class="v">' + (record.downloads || 0) + '</span></div>' +
            '<div class="meta-item"><span class="k">Views</span><span class="v">' + (record.views || 0) + '</span></div>' +
          '</div>' +
        '</div>' +
        commentsHtml +
      '</div>' +

      '<aside>' + sideThumbHtml + '<div style="height:14px"></div>' + renderShareCard() + '<div style="height:14px"></div>' + ratingBlock + '<div style="height:14px"></div>' +
        '<div class="uploader-card">' +
          '<div class="uploader-row">' + renderAvatar(owner || { username: record.ownerUsername, name: record.ownerUsername }, 42) +
            '<div class="uploader-meta"><div class="name">' + escapeHtml(owner ? owner.name : record.ownerUsername) + '</div>' +
            (publicViewer ? '<span class="handle">@' + escapeHtml(record.ownerUsername) + '</span>' : '<a class="handle" href="/users/' + encodeURIComponent(record.ownerUsername) + '">@' + escapeHtml(record.ownerUsername) + '</a>') +
            '</div>' +
          '</div>' +
          '<div class="uploader-stats"><span><i class="fa-solid fa-user-group"></i>' + ownerSubscribers + ' subscriber' + (ownerSubscribers === 1 ? '' : 's') + '</span>' +
          '<span><i class="fa-regular fa-file"></i>' + ownerPublicFiles + ' public file' + (ownerPublicFiles === 1 ? '' : 's') + '</span></div>' +
          subscribeBtn +
        '</div>' +
      '</aside></div>' +
    '</div>' +

    (!publicViewer ? '<script>(function(){' +
      'var block=document.getElementById("rating-block");if(!block)return;' +
      'var fileId=block.getAttribute("data-file-id");var input=document.getElementById("rating-input");var hint=document.getElementById("rating-hint");var avgEl=document.getElementById("rating-avg");var cntEl=document.getElementById("rating-count");var starsEl=document.getElementById("rating-stars");' +
      'function paintStars(n){var out="";for(var i=1;i<=5;i++){var on=i<=Math.round(n);out+=\'<i class="\'+(on?"fa-solid":"fa-regular")+\' fa-star"></i>\';}return out;}' +
      'function paintInput(n){var btns=input.querySelectorAll(".star-btn");for(var i=0;i<btns.length;i++){var v=parseInt(btns[i].getAttribute("data-value"),10);var on=v<=n;btns[i].classList.toggle("on",on);btns[i].innerHTML=\'<i class="\'+(on?"fa-solid":"fa-regular")+\' fa-star"></i>\';}}' +
      'function setBusy(b){var btns=input.querySelectorAll(".star-btn");for(var i=0;i<btns.length;i++)btns[i].disabled=b;}' +
      'input.addEventListener("click",function(e){var b=e.target.closest(".star-btn");if(!b)return;var v=parseInt(b.getAttribute("data-value"),10);setBusy(true);' +
        'fetch("/files/"+encodeURIComponent(fileId)+"/rate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({value:v}),credentials:"same-origin"})' +
        '.then(function(r){return r.ok?r.json():Promise.reject(r);})' +
        '.then(function(d){paintInput(v);starsEl.innerHTML=paintStars(d.average);avgEl.textContent=d.average.toFixed(1);cntEl.textContent=d.count;hint.textContent="You rated "+v+" star"+(v>1?"s":"")+".";})' +
        '.catch(function(){hint.textContent="Could not save your rating.";})' +
        '.then(function(){setBusy(false);});});' +
    '})();</script>' : '') +

    '<script>(function(){var buttons=document.querySelectorAll("[data-share]");if(!buttons.length)return;' +
      'var pageUrl=window.location.href;var pageTitle=document.title;var shareText=pageTitle+" — shared from BiologyNotes";' +
      'function copyFallback(text){var ta=document.createElement("textarea");ta.value=text;ta.setAttribute("readonly","");ta.style.position="absolute";ta.style.left="-9999px";document.body.appendChild(ta);ta.select();try{document.execCommand("copy");}catch(e){}document.body.removeChild(ta);}' +
      'buttons.forEach(function(btn){btn.addEventListener("click",function(e){e.preventDefault();var type=btn.getAttribute("data-share");var url="";' +
        'switch(type){' +
          'case "whatsapp":url="https://wa.me/?text="+encodeURIComponent(shareText+" "+pageUrl);break;' +
          'case "facebook":url="https://www.facebook.com/sharer/sharer.php?u="+encodeURIComponent(pageUrl);break;' +
          'case "twitter":url="https://twitter.com/intent/tweet?text="+encodeURIComponent(shareText)+"&url="+encodeURIComponent(pageUrl);break;' +
          'case "linkedin":url="https://www.linkedin.com/sharing/share-offsite/?url="+encodeURIComponent(pageUrl);break;' +
          'case "telegram":url="https://t.me/share/url?url="+encodeURIComponent(pageUrl)+"&text="+encodeURIComponent(shareText);break;' +
          'case "reddit":url="https://www.reddit.com/submit?url="+encodeURIComponent(pageUrl)+"&title="+encodeURIComponent(pageTitle);break;' +
          'case "email":url="mailto:?subject="+encodeURIComponent(pageTitle)+"&body="+encodeURIComponent("Check this out on BiologyNotes:\\n\\n"+pageUrl);break;' +
          'case "copy":var original=btn.innerHTML;var done=function(){btn.classList.add("copied");btn.innerHTML=\'<i class="fa-solid fa-check"></i>\';setTimeout(function(){btn.classList.remove("copied");btn.innerHTML=original;},1500);};' +
            'if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(pageUrl).then(done).catch(function(){copyFallback(pageUrl);done();});}else{copyFallback(pageUrl);done();}return;' +
        '}if(url)window.open(url,"_blank","noopener,noreferrer,width=640,height=640");});});' +
    '})();</script>';

  return layout(seo, req, body);
}

/* ------------------------------------------------------------------ *
 * File edit
 * ------------------------------------------------------------------ */
function renderFileEdit(ctx) {
  const { user, record, error = '', values, req } = ctx;
  const kind = fileKind(record.mimeType, record.originalName);
  const isNote = record.kind === 'note';
  const v = values || {
    chapterNo: record.chapterNo || '', chapterName: record.chapterName || '', subject: record.subject || '',
    writer: record.writer || '', description: record.description || '', visibility: record.visibility || 'public',
    tag1: (record.tags && record.tags[0]) || '', tag2: (record.tags && record.tags[1]) || '', tag3: (record.tags && record.tags[2]) || ''
  };
  const visibility = v.visibility === 'private' ? 'private' : 'public';
  const fid = String(record._id);
  const seo = { title: 'Edit file · BiologyNotes', description: '', canonical: '/files/' + fid + '/edit', noindex: true };

  const fieldsHtml = isNote
    ? '<div class="form-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:0 16px">' +
        '<div class="field"><label class="label" for="e-chapterNo">Chapter No</label><input class="input" id="e-chapterNo" name="chapterNo" type="number" min="0" step="1" value="' + escapeHtml(v.chapterNo) + '" placeholder="1" required></div>' +
        '<div class="field"><label class="label" for="e-chapterName">Chapter Name</label><input class="input" id="e-chapterName" name="chapterName" type="text" value="' + escapeHtml(v.chapterName) + '" placeholder="Introduction to Algebra" required maxlength="200"></div>' +
        '<div class="field"><label class="label" for="e-subject">Subject</label><input class="input" id="e-subject" name="subject" type="text" value="' + escapeHtml(v.subject) + '" placeholder="Biology" required maxlength="120"></div>' +
        '<div class="field"><label class="label" for="e-writer">Writer</label><input class="input" id="e-writer" name="writer" type="text" value="' + escapeHtml(v.writer) + '" placeholder="John Smith" required maxlength="120"></div>' +
      '</div>'
    : '<div class="field"><label class="label" for="e-chapterName">Title</label><input class="input" id="e-chapterName" name="chapterName" type="text" value="' + escapeHtml(v.chapterName) + '" placeholder="Title of your upload" required maxlength="200"></div>' +
      '<div class="field"><label class="label" for="e-writer">Your name</label><input class="input" id="e-writer" name="writer" type="text" value="' + escapeHtml(v.writer) + '" placeholder="Your name" required maxlength="120"></div>' +
      '<div class="field"><label class="label">Tags <span style="color:#a1a1aa;font-weight:400">(up to 3)</span></label>' +
      '<div class="tags-grid">' +
        '<div class="tag-field"><span class="tag-prefix">#</span><input class="input" name="tag1" type="text" placeholder="Tag 1" maxlength="30" value="' + escapeHtml(v.tag1 || '') + '"></div>' +
        '<div class="tag-field"><span class="tag-prefix">#</span><input class="input" name="tag2" type="text" placeholder="Tag 2" maxlength="30" value="' + escapeHtml(v.tag2 || '') + '"></div>' +
        '<div class="tag-field"><span class="tag-prefix">#</span><input class="input" name="tag3" type="text" placeholder="Tag 3" maxlength="30" value="' + escapeHtml(v.tag3 || '') + '"></div>' +
      '</div>' +
      '<p class="tag-hint"><i class="fa-solid fa-circle-info"></i>Add up to 3 tags. At least one tag is required.</p></div>';

  const body = '' +
    renderTopNav(user, '', false) +
    '<div class="container">' +
      '<div class="flex-between" style="margin-bottom:16px">' +
        '<a class="btn btn-ghost btn-xs" href="/files/' + encodeURIComponent(fid) + '"><i class="fa-solid fa-arrow-left"></i>Back to file</a>' +
        '<div class="row">' +
          '<span class="badge ' + (isNote ? 'badge-dark' : '') + '">' + (isNote ? '<i class="fa-solid fa-book"></i>NOTE' : '<i class="fa-solid fa-box-open"></i>OTHER') + '</span>' +
          '<span class="badge badge-type"><i class="' + kindIconClass(kind) + '"></i>' + kindLabel(kind) + '</span>' +
        '</div>' +
      '</div>' +

      '<div class="card">' +
        '<div class="upload-header"><div><div class="eyebrow">Edit file</div><h1>Update details</h1>' +
        '<p class="sub" style="margin:6px 0 0">Update the metadata, or upload a new file to replace the current one.</p></div></div>' +
        (error ? '<div class="alert alert-error"><i class="fa-solid fa-circle-exclamation"></i><span>' + escapeHtml(error) + '</span></div>' : '') +
        '<form method="POST" action="/files/' + encodeURIComponent(fid) + '/edit" enctype="multipart/form-data" data-confirm="These changes will be saved to the file." data-confirm-title="Save changes?" data-confirm-action="Save changes" data-confirm-variant="primary" data-confirm-icon="fa-floppy-disk">' +
          fieldsHtml +
          '<div class="field"><label class="label" for="e-description">Description</label><textarea class="textarea" id="e-description" name="description" placeholder="Short description...">' + escapeHtml(v.description || '') + '</textarea></div>' +
          '<div class="field"><label class="label" for="e-visibility">Visibility</label>' +
            '<select class="select" id="e-visibility" name="visibility">' +
              '<option value="public"' + (visibility === 'public' ? ' selected' : '') + '>Public — visible to everyone</option>' +
              '<option value="private"' + (visibility === 'private' ? ' selected' : '') + '>Private — visible only to you</option>' +
            '</select></div>' +
          '<hr class="form-divider">' +
          '<div class="field"><label class="label">Replace file <span style="color:#a1a1aa;font-weight:400">(optional)</span></label>' +
            '<div class="alert alert-warning" style="margin-bottom:12px"><i class="fa-solid fa-circle-info"></i>' +
            '<span>Leave this empty to keep the current file (<b>' + escapeHtml(record.originalName) + '</b>). Uploading a new file here will permanently replace the old one.</span></div>' +
            '<div class="dropzone" id="edit-dropzone" tabindex="0" role="button" aria-label="Replace file (optional)">' +
              '<input type="file" id="edit-file" name="newFile" aria-label="Replace file (optional)">' +
              '<div class="dropzone-inner" id="edit-dropzone-default">' +
                '<div class="dropzone-icon"><i class="fa-solid fa-arrows-rotate"></i></div>' +
                '<div class="dropzone-title">Drag &amp; drop a new file here to replace, or <span class="browse">browse</span></div>' +
                '<div class="dropzone-hint">Leave empty to keep the current file &middot; <strong>up to 100 MB</strong></div>' +
              '</div>' +
              '<div class="file-chip" id="edit-dropzone-selected" style="display:none">' +
                '<div class="file-chip-icon" id="edit-chip-icon"><i class="fa-regular fa-file"></i></div>' +
                '<div class="file-chip-body"><div class="file-chip-name" id="edit-chip-name">filename.ext</div>' +
                '<div class="file-chip-meta"><span id="edit-chip-size">0 B</span><span class="dot"></span><span id="edit-chip-type">file</span></div></div>' +
                '<button type="button" class="file-chip-remove" id="edit-chip-remove" title="Cancel replacement"><i class="fa-solid fa-xmark"></i></button>' +
              '</div>' +
              '<div class="progress" id="edit-progress"><div class="progress-bar" id="edit-progress-bar"></div></div>' +
            '</div></div>' +
          '<div class="form-actions" style="display:flex;gap:10px;align-items:center;margin-top:8px;flex-wrap:wrap">' +
            '<button type="submit" class="btn btn-primary btn-lg" id="edit-submit-btn"><i class="fa-solid fa-floppy-disk"></i>Save changes</button>' +
            '<a class="btn btn-outline btn-lg" href="/files/' + encodeURIComponent(fid) + '">Cancel</a></div>' +
        '</form>' +
      '</div>' +
    '</div>' +
    '<script>(function(){var dz=document.getElementById("edit-dropzone");var input=document.getElementById("edit-file");var def=document.getElementById("edit-dropzone-default");var sel=document.getElementById("edit-dropzone-selected");var iconEl=document.getElementById("edit-chip-icon");var nameEl=document.getElementById("edit-chip-name");var sizeEl=document.getElementById("edit-chip-size");var typeEl=document.getElementById("edit-chip-type");var rm=document.getElementById("edit-chip-remove");var prog=document.getElementById("edit-progress");var bar=document.getElementById("edit-progress-bar");var form=document.querySelector("form[action$=\'/edit\']");var btn=document.getElementById("edit-submit-btn");if(!dz||!input)return;' +
      'function fmt(b){if(!b&&b!==0)return "0 B";var u=["B","KB","MB","GB"],i=Math.min(Math.floor(Math.log(b)/Math.log(1024)),u.length-1);return (b/Math.pow(1024,i)).toFixed(i===0?0:1)+" "+u[i];}' +
      'function iconFor(name,mime){var ext=(name.split(".").pop()||"").toLowerCase();var m=(mime||"").toLowerCase();if(m.indexOf("image/")===0)return ["fa-regular fa-image","Image"];if(m.indexOf("video/")===0)return ["fa-solid fa-video","Video"];if(m.indexOf("audio/")===0)return ["fa-solid fa-music","Audio"];if(m==="application/pdf"||ext==="pdf")return ["fa-regular fa-file-pdf","PDF"];if(m.indexOf("text/")===0||["txt","md","csv","json","js","ts","html","css","xml","yml","yaml"].indexOf(ext)>=0)return ["fa-regular fa-file-lines","Text"];return ["fa-regular fa-file","File"];}' +
      'function showFile(f){if(!f){def.style.display="";sel.style.display="none";dz.classList.remove("has-file");return;}var info=iconFor(f.name,f.type);iconEl.innerHTML=\'<i class="\'+info[0]+\'"></i>\';nameEl.textContent=f.name;sizeEl.textContent=fmt(f.size);typeEl.textContent=info[1];def.style.display="none";sel.style.display="flex";dz.classList.add("has-file");}' +
      'function clearFile(){input.value="";showFile(null);}' +
      'input.addEventListener("change",function(){showFile(input.files&&input.files[0]);});' +
      'rm.addEventListener("click",function(e){e.stopPropagation();e.preventDefault();clearFile();});' +
      '["dragenter","dragover"].forEach(function(ev){dz.addEventListener(ev,function(e){e.preventDefault();e.stopPropagation();dz.classList.add("dragover");});});' +
      '["dragleave","drop"].forEach(function(ev){dz.addEventListener(ev,function(e){e.preventDefault();e.stopPropagation();dz.classList.remove("dragover");});});' +
      'dz.addEventListener("drop",function(e){e.preventDefault();var dt=e.dataTransfer;if(!dt||!dt.files||!dt.files.length)return;try{var d=new DataTransfer();for(var i=0;i<dt.files.length;i++)d.items.add(dt.files[i]);input.files=d.files;}catch(err){}showFile(dt.files[0]);});' +
      'dz.addEventListener("click",function(e){if(e.target===input)return;if(rm.contains(e.target))return;input.click();});' +
      'if(form){form.addEventListener("submit",function(){var f=input.files&&input.files[0];if(!f)return;prog.classList.add("on");bar.style.width="8%";var t=setInterval(function(){var w=parseFloat(bar.style.width)||0;if(w<92){bar.style.width=(w+Math.random()*7)+"%";}else{clearInterval(t);}},180);if(btn){btn.disabled=true;btn.innerHTML=\'<i class="fa-solid fa-circle-notch fa-spin"></i>Saving...\';}});}' +
    '})();</script>';

  return layout(seo, req, body);
}

/* ------------------------------------------------------------------ *
 * Profile edit
 * ------------------------------------------------------------------ */
function renderProfileEdit(ctx) {
  const { user, error = '', values, notice = '', req } = ctx;
  const v = values || { name: user.name, email: user.email, username: user.username };
  const seo = { title: 'Edit profile · BiologyNotes', description: '', canonical: '/profile/edit', noindex: true };

  const body = '' +
    renderTopNav(user, '', false) +
    '<div class="container">' +
      '<div class="flex-between" style="margin-bottom:16px">' +
        '<a class="btn btn-ghost btn-xs" href="/users/' + encodeURIComponent(user.username) + '"><i class="fa-solid fa-arrow-left"></i>Back to profile</a>' +
        '<div class="row"><span class="badge badge-dark"><i class="fa-regular fa-user"></i>Account</span></div>' +
      '</div>' +
      '<div class="card" style="max-width:640px;margin:0 auto">' +
        '<div class="upload-header"><div><div class="eyebrow">Account settings</div><h1>Edit profile</h1>' +
        '<p class="sub" style="margin:6px 0 0">Update your name, email, username, or change your password.</p></div></div>' +
        (error ? '<div class="alert alert-error"><i class="fa-solid fa-circle-exclamation"></i><span>' + escapeHtml(error) + '</span></div>' : '') +
        (notice ? '<div class="alert alert-success"><i class="fa-solid fa-circle-check"></i><span>' + escapeHtml(notice) + '</span></div>' : '') +
        '<form method="POST" action="/profile/edit" data-confirm="Your profile details will be updated." data-confirm-title="Save profile changes?" data-confirm-action="Save changes" data-confirm-variant="primary" data-confirm-icon="fa-floppy-disk">' +
          '<div class="field"><label class="label" for="p-name">Full name</label><input class="input" id="p-name" name="name" type="text" value="' + escapeHtml(v.name || '') + '" placeholder="Jane Doe" required maxlength="80" autocomplete="name"></div>' +
          '<div class="field"><label class="label" for="p-email">Email address</label><input class="input" id="p-email" name="email" type="email" value="' + escapeHtml(v.email || '') + '" placeholder="jane@example.com" required autocomplete="email"></div>' +
          '<div class="field"><label class="label" for="p-username">Username</label><input class="input" id="p-username" name="username" type="text" value="' + escapeHtml(v.username || '') + '" placeholder="janedoe" required minlength="3" maxlength="20" autocomplete="username">' +
            '<p class="tag-hint"><i class="fa-solid fa-circle-info"></i>3–20 characters — letters, numbers, underscores only.</p></div>' +
          '<hr class="form-divider">' +
          '<h2 style="font-size:16px;margin:0 0 6px">Change password</h2>' +
          '<p class="sub" style="margin:0 0 14px;font-size:13px">Leave these fields blank if you don\'t want to change your password.</p>' +
          '<div class="field"><label class="label" for="p-current-password">Current password</label><input class="input" id="p-current-password" name="currentPassword" type="password" placeholder="Your current password" autocomplete="current-password"></div>' +
          '<div class="field"><label class="label" for="p-new-password">New password</label><input class="input" id="p-new-password" name="newPassword" type="password" placeholder="At least 6 characters" minlength="6" autocomplete="new-password"></div>' +
          '<div class="field"><label class="label" for="p-confirm-password">Confirm new password</label><input class="input" id="p-confirm-password" name="confirmPassword" type="password" placeholder="Re-enter new password" minlength="6" autocomplete="new-password"></div>' +
          '<div class="form-actions" style="display:flex;gap:10px;align-items:center;margin-top:8px;flex-wrap:wrap">' +
            '<button type="submit" class="btn btn-primary btn-lg"><i class="fa-solid fa-floppy-disk"></i>Save changes</button>' +
            '<a class="btn btn-outline btn-lg" href="/users/' + encodeURIComponent(user.username) + '">Cancel</a></div>' +
        '</form>' +
      '</div>' +
    '</div>';

  return layout(seo, req, body);
}

/* ------------------------------------------------------------------ *
 * User profile
 * ------------------------------------------------------------------ */
function renderUserProfile(ctx) {
  const { viewer, profileUser, records, subscribed, isSelf, avatarNotice = '', avatarError = '', req } = ctx;
  const initial = (profileUser.name || profileUser.username || '?').trim().charAt(0).toUpperCase() || '?';
  const subscriberCount = profileUser.subscribers ? profileUser.subscribers.length : 0;
  const followingCount = profileUser.subscribedTo ? profileUser.subscribedTo.length : 0;
  const seo = seoForUser(profileUser, isSelf);

  const subscribeBtn = !isSelf
    ? '<form method="POST" action="/users/' + String(profileUser._id) + '/subscribe" class="inline-form"><button type="submit" class="btn ' + (subscribed ? 'btn-outline' : 'btn-primary') + '">' + (subscribed ? '<i class="fa-solid fa-user-check"></i>Subscribed' : '<i class="fa-solid fa-user-plus"></i>Subscribe') + '</button></form>'
    : '<span class="badge badge-dark"><i class="fa-regular fa-user"></i>This is you</span>';

  const avatarImgHtml = profileUser.avatarUrl ? '<img src="' + escapeHtml(profileUser.avatarUrl) + '" alt="' + escapeHtml(profileUser.name) + '">' : escapeHtml(initial);

  const avatarCard = isSelf
    ? '<div class="avatar-card"><div class="avatar-card-img">' + avatarImgHtml + '</div>' +
        '<div class="avatar-card-info"><h2 class="avatar-card-title">Profile picture</h2>' +
        '<p class="avatar-card-desc">' + (profileUser.avatarUrl ? 'Your current avatar. Upload a new one or remove it.' : 'Upload a picture to personalise your profile. This is optional.') + '</p>' +
        (avatarNotice ? '<div class="alert alert-success" style="margin-bottom:10px"><i class="fa-solid fa-circle-check"></i><span>' + escapeHtml(avatarNotice) + '</span></div>' : '') +
        (avatarError ? '<div class="alert alert-error" style="margin-bottom:10px"><i class="fa-solid fa-circle-exclamation"></i><span>' + escapeHtml(avatarError) + '</span></div>' : '') +
        '<div class="avatar-card-actions">' +
          '<form method="POST" action="/profile/avatar" enctype="multipart/form-data" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
            '<input class="avatar-file-input" type="file" name="avatar" accept="image/*" required>' +
            '<button type="submit" class="btn btn-primary btn-xs"><i class="fa-solid fa-cloud-arrow-up"></i>Upload</button></form>' +
          (profileUser.avatarUrl ? '<form method="POST" action="/profile/avatar/remove" class="inline-form" data-confirm="Your profile picture will be removed." data-confirm-title="Remove profile picture?" data-confirm-action="Remove" data-confirm-variant="danger" data-confirm-icon="fa-trash-can"><button type="submit" class="btn btn-danger btn-xs"><i class="fa-solid fa-trash-can"></i>Remove</button></form>' : '') +
        '</div></div></div>'
    : '';

  const manageCard = isSelf
    ? '<div class="profile-manage-card"><h2 class="profile-manage-title">Account settings</h2>' +
        '<p class="profile-manage-desc">Edit your profile details, change your password, or delete your account.</p>' +
        '<div class="profile-manage-actions">' +
          '<a class="btn btn-outline btn-xs" href="/profile/edit"><i class="fa-solid fa-pen"></i>Edit profile</a>' +
          '<form method="POST" action="/profile/delete" class="inline-form" data-confirm="Your account and ALL your uploaded files will be permanently deleted. This cannot be undone." data-confirm-title="Delete your account?" data-confirm-action="Delete account" data-confirm-variant="danger" data-confirm-icon="fa-user-xmark"><button type="submit" class="btn btn-danger btn-xs"><i class="fa-solid fa-user-xmark"></i>Delete account</button></form>' +
        '</div></div>'
    : '';

  const cards = records.map((r) => renderCard(r, viewer, false)).join('');
  const main = records.length
    ? '<div class="grid">' + cards + '</div>'
    : '<div class="empty"><i class="fa-regular fa-folder-open"></i><h3>No public files yet</h3><p>This user has not shared anything publicly.</p></div>';

  const body = '' +
    renderTopNav(viewer, '', false) +
    '<div class="container">' +
      avatarCard + manageCard +
      '<div class="banner"><div class="user-info">' + renderAvatar(profileUser, 46) +
        '<div><div class="user-name">' + escapeHtml(profileUser.name) + '</div>' +
        '<div class="user-meta">@' + escapeHtml(profileUser.username) + ' · ' + subscriberCount + ' subscriber' + (subscriberCount === 1 ? '' : 's') + ' · ' + followingCount + ' following</div></div></div>' +
        '<div class="actions">' + subscribeBtn + '</div></div>' +
      '<div class="section-head"><h2>' + (isSelf ? 'Your files' : 'Public files') + '</h2>' +
        '<span class="count">' + records.length + ' file' + (records.length === 1 ? '' : 's') + '</span></div>' +
      main +
    '</div>';
  return layout(seo, req, body);
}

function renderErrorPage(status, title, message, req) {
  const seo = { title: status + ' · ' + title + ' · BiologyNotes', description: message || title, canonical: '/', noindex: true };
  const body = '' +
    renderTopNav(null, '', false) +
    '<div class="container-narrow">' + brandMark() +
      '<div class="card error-page"><h1>' + escapeHtml(status) + '</h1>' +
      '<p>' + escapeHtml(message || title) + '</p>' +
      '<a class="btn btn-primary" href="/"><i class="fa-solid fa-house"></i>Back to home</a></div>' +
    '</div>';
  return layout(seo, req, body);
}

/* ------------------------------------------------------------------ *
 * Express app
 * ------------------------------------------------------------------ */
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
      fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https://res.cloudinary.com'],
      mediaSrc: ["'self'", 'blob:', 'https://res.cloudinary.com'],
      frameSrc: ["'self'", 'https://res.cloudinary.com'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: null
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));

app.use(session({
  name: 'bn.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: MONGO_URI, collectionName: 'sessions', ttl: 60 * 60 * 24 * 7, autoRemove: 'native', touchAfter: 24 * 3600 }),
  cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 1000 * 60 * 60 * 8 }
}));

/**
 * Session / auth detection middleware.
 * Sets:
 *   req.user          — logged-in real user (or null)
 *   req.isGuest       — explicit guest (clicked "Continue as Guest")
 *   req.publicViewer  — true for BOTH guests and anonymous visitors
 */
app.use(async (req, res, next) => {
  req.user = null;
  req.isGuest = false;
  req.publicViewer = false;

  if (req.session && req.session.isGuest) {
    req.isGuest = true;
    req.publicViewer = true;
    return next();
  }

  if (req.session && req.session.userId) {
    try {
      const u = await User.findById(req.session.userId)
        .select('name email username avatarUrl avatarPublicId subscribers subscribedTo').lean();
      if (u) req.user = u;
      else req.session.userId = null;
    } catch (err) { req.user = null; }
  }

  // Anonymous visitors (no session, no user) are treated as public viewers
  // for reading purposes. They can view, download, and share public files.
  if (!req.user) {
    req.publicViewer = true;
  }

  next();
});

/** Everyone passes — routes handle their own permissions. */
function requireAuth(req, res, next) { return next(); }

/** Only logged-in real users. Guests and anonymous visitors get redirected to login. */
function requireRealUser(req, res, next) {
  if (req.user) return next();
  if (req.isGuest) return res.redirect('/login?guestBlocked=1');
  return res.redirect('/login?signinRequired=1');
}

/* ------------------------------------------------------------------ *
 * Multer
 * ------------------------------------------------------------------ */
const uploadFile = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_SIZE, files: 1 } });
const uploadAvatar = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_AVATAR_SIZE, files: 1 } });

function handleFileUpload(fieldName) {
  const name = fieldName || 'file';
  return function (req, res, next) {
    uploadFile.single(name)(req, res, (err) => {
      if (!err) return next();
      let message = 'Upload failed. Please try again.';
      if (err.code === 'LIMIT_FILE_SIZE') message = 'File is too large. Max 100 MB.';
      else if (err.code === 'LIMIT_UNEXPECTED_FILE') message = 'Unexpected file field.';
      else if (err.code === 'LIMIT_FILE_COUNT') message = 'Only one file per upload.';
      if (!req.user) return res.redirect('/login');
      if (name === 'newFile') {
        return res.status(400).send(renderFileEdit({ user: req.user, record: { _id: req.params.id, chapterName: 'file', chapterNo: '', subject: '', writer: '', description: '', visibility: 'public', tags: [], kind: 'note', mimeType: '', originalName: '', fileUrl: '', owner: req.user._id, comments: [], ratings: [] }, error: message, req }));
      }
      const activeTab = (req.body && req.body.kind === 'other') ? 'other' : 'notes';
      return res.status(400).send(renderUpload({ user: req.user, error: message, values: req.body || {}, activeTab, req }));
    });
  };
}

function handleAvatarUpload(req, res, next) {
  uploadAvatar.single('avatar')(req, res, (err) => {
    if (!err) return next();
    let message = 'Upload failed. Please try again.';
    if (err.code === 'LIMIT_FILE_SIZE') message = 'Image is too large. Max 4 MB.';
    else if (err.code === 'LIMIT_UNEXPECTED_FILE') message = 'Unexpected file field.';
    if (!req.user) return res.redirect('/login');
    return res.redirect('/users/' + encodeURIComponent(req.user.username) + '?avatarError=' + encodeURIComponent(message));
  });
}

/* ------------------------------------------------------------------ *
 * Static + SEO
 * ------------------------------------------------------------------ */
app.get('/favicon.ico', (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(FAVICON_SVG);
});

app.get('/favicon.svg', (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(FAVICON_SVG);
});

app.get('/robots.txt', (req, res) => {
  const base = SITE_URL || (req.protocol + '://' + req.get('host'));
  res.type('text/plain').send(
    'User-agent: *\n' +
    'Allow: /\n' +
    'Disallow: /upload\n' +
    'Disallow: /profile/\n' +
    'Disallow: /logout\n' +
    'Disallow: /files/*/edit\n' +
    'Disallow: /files/*/raw\n' +
    'Disallow: /files/*/download\n' +
    'Allow: /files/\n' +
    'Allow: /gallery\n' +
    'Allow: /users/\n' +
    'Allow: /login\n' +
    'Allow: /register\n' +
    '\n' +
    'Sitemap: ' + base + '/sitemap.xml\n'
  );
});

app.get('/sitemap.xml', async (req, res, next) => {
  try {
    const base = SITE_URL || (req.protocol + '://' + req.get('host'));
    const files = await File.find({ visibility: 'public' })
      .select('_id createdAt updatedAt')
      .sort({ createdAt: -1 })
      .limit(5000)
      .lean();

    const users = await User.find({})
      .select('username updatedAt')
      .sort({ createdAt: -1 })
      .limit(2000)
      .lean();

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

    const today = new Date().toISOString().split('T')[0];
    xml += '  <url><loc>' + escapeXml(base + '/') + '</loc><lastmod>' + today + '</lastmod><changefreq>daily</changefreq><priority>1.0</priority></url>\n';
    xml += '  <url><loc>' + escapeXml(base + '/gallery') + '</loc><lastmod>' + today + '</lastmod><changefreq>daily</changefreq><priority>0.9</priority></url>\n';

    for (const f of files) {
      const lm = (f.updatedAt || f.createdAt || new Date()).toISOString().split('T')[0];
      xml += '  <url><loc>' + escapeXml(base + '/files/' + String(f._id)) + '</loc><lastmod>' + lm + '</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>\n';
    }

    for (const u of users) {
      const lm = (u.updatedAt || new Date()).toISOString().split('T')[0];
      xml += '  <url><loc>' + escapeXml(base + '/users/' + encodeURIComponent(u.username)) + '</loc><lastmod>' + lm + '</lastmod><changefreq>weekly</changefreq><priority>0.6</priority></url>\n';
    }

    xml += '</urlset>\n';

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(xml);
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------------ *
 * Home + gallery (publicViewer = guest OR anonymous)
 * ------------------------------------------------------------------ */
app.get('/', requireAuth, async (req, res, next) => {
  try {
    const user = req.user;
    const publicViewer = req.publicViewer;

    if (publicViewer) {
      const records = await File.find({ visibility: 'public' })
        .populate('owner', 'name username avatarUrl')
        .sort({ createdAt: -1 })
        .limit(200)
        .lean();
      return res.send(renderHome({ user: null, publicViewer: true, records, req }));
    }

    const filter = typeof req.query.filter === 'string' ? req.query.filter : 'all';
    const sort = typeof req.query.sort === 'string' ? req.query.sort : 'recent';
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';

    const q = {};
    if (filter === 'mine') q.owner = user._id;
    else if (filter === 'subscribed') { q.visibility = 'public'; q.owner = { $in: (user.subscribedTo || []) }; }
    else if (filter === 'public') q.visibility = 'public';
    else if (filter === 'notes') { q.kind = 'note'; q.$or = [{ visibility: 'public' }, { owner: user._id }]; }
    else if (filter === 'other') { q.kind = 'other'; q.$or = [{ visibility: 'public' }, { owner: user._id }]; }
    else q.$or = [{ visibility: 'public' }, { owner: user._id }];

    if (query) {
      const rx = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      q.$and = (q.$and || []).concat([{
        $or: [{ chapterName: rx }, { subject: rx }, { writer: rx }, { description: rx }, { ownerUsername: rx }, { tags: rx }]
      }]);
    }

    let sortSpec = { createdAt: -1 };
    if (sort === 'downloads') sortSpec = { downloads: -1, createdAt: -1 };
    else if (sort === 'name') sortSpec = { chapterName: 1 };

    let records = await File.find(q).populate('owner', 'name username avatarUrl').sort(sortSpec).limit(300).lean();
    if (sort === 'rating') records = records.sort((a, b) => averageRating(b) - averageRating(a));

    let notice = '';
    if (req.query.upload === 'success') notice = 'Your file was uploaded successfully.';
    else if (req.query.deleted === 'success') notice = 'The file was deleted successfully.';

    res.send(renderHome({ user, publicViewer: false, records, notice, filter, sort, query, req }));
  } catch (err) { next(err); }
});

app.get('/gallery', requireAuth, async (req, res, next) => {
  try {
    const user = req.user;
    const publicViewer = req.publicViewer;
    const sort = typeof req.query.sort === 'string' ? req.query.sort : 'recent';
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';

    const q = { visibility: 'public' };
    if (query) {
      const rx = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      q.$or = [{ chapterName: rx }, { subject: rx }, { writer: rx }, { description: rx }, { ownerUsername: rx }, { tags: rx }];
    }

    let sortSpec = { createdAt: -1 };
    if (sort === 'downloads') sortSpec = { downloads: -1, createdAt: -1 };
    else if (sort === 'name') sortSpec = { chapterName: 1 };

    let records = await File.find(q).populate('owner', 'name username avatarUrl').sort(sortSpec).limit(300).lean();
    if (sort === 'rating') records = records.sort((a, b) => averageRating(b) - averageRating(a));

    res.send(renderGallery({ user, publicViewer, records, sort, query, req }));
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */
app.get('/register', (req, res) => {
  if (req.user) return res.redirect('/');
  const info = req.query.guestBlocked ? 'Please sign in or create an account to use that feature.' : '';
  res.send(renderRegister({ info, isExplicitGuest: req.isGuest, req }));
});

app.post('/register', async (req, res, next) => {
  try {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const values = { name, email, username };

    if (!name || !email || !username || !password) return res.status(400).send(renderRegister({ error: 'All fields are required.', values, isExplicitGuest: req.isGuest, req }));
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).send(renderRegister({ error: 'Please enter a valid email address.', values, isExplicitGuest: req.isGuest, req }));
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return res.status(400).send(renderRegister({ error: 'Username must be 3–20 characters — letters, numbers, or underscores.', values, isExplicitGuest: req.isGuest, req }));
    if (password.length < 6) return res.status(400).send(renderRegister({ error: 'Password must be at least 6 characters.', values, isExplicitGuest: req.isGuest, req }));

    const dupe = await User.findOne({
      $or: [{ username: new RegExp('^' + username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') }, { email }]
    }).lean();

    if (dupe) {
      const msg = String(dupe.username).toLowerCase() === username.toLowerCase() ? 'That username is already taken.' : 'That email address is already registered.';
      return res.status(409).send(renderRegister({ error: msg, values, isExplicitGuest: req.isGuest, req }));
    }

    await User.create({ name, email, username, passwordHash: hashPassword(password) });

    req.session.regenerate((err) => {
      if (err) console.error('[biologynotes] register regenerate error:', err);
      req.session.registered = true;
      req.session.save(() => res.redirect('/login'));
    });
  } catch (err) {
    if (err && err.code === 11000) return res.status(409).send(renderRegister({ error: 'That username or email is already registered.', values: req.body || {}, isExplicitGuest: req.isGuest, req }));
    next(err);
  }
});

app.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  const info = req.query.guestBlocked
    ? 'That feature requires a real account. Sign in or register to continue.'
    : (req.query.signinRequired ? 'Please sign in or create an account to continue.' : (req.query.accountDeleted ? 'Your account was deleted successfully.' : ''));
  res.send(renderLogin({ info, isExplicitGuest: req.isGuest, req }));
});

app.post('/login', async (req, res, next) => {
  try {
    const body = req.body || {};
    const username = String(body.username || '').trim();
    const password = String(body.password || '');

    if (!username || !password) return res.status(400).send(renderLogin({ error: 'Username and password are required.', values: { username }, isExplicitGuest: req.isGuest, req }));

    const user = await User.findOne({ username: new RegExp('^' + username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') });
    if (!user || !verifyPassword(password, user.passwordHash)) return res.status(401).send(renderLogin({ error: 'Invalid username or password.', values: { username }, isExplicitGuest: req.isGuest, req }));

    req.session.regenerate((err) => {
      if (err) return res.status(500).send(renderLogin({ error: 'Something went wrong. Please try again.', values: { username }, isExplicitGuest: req.isGuest, req }));
      req.session.userId = String(user._id);
      req.session.registered = true;
      req.session.save(() => res.redirect('/'));
    });
  } catch (err) { next(err); }
});

app.post('/guest', (req, res) => {
  req.session.regenerate((err) => {
    if (err) { console.error('[biologynotes] guest regenerate error:', err); return res.redirect('/register'); }
    req.session.isGuest = true;
    req.session.registered = true;
    req.session.save(() => res.redirect('/'));
  });
});

app.get('/logout', (req, res) => {
  if (!req.session) return res.redirect('/login');
  req.session.destroy((err) => {
    if (err) console.error('[biologynotes] logout destroy error:', err);
    res.clearCookie('bn.sid');
    res.redirect('/login');
  });
});

/* ------------------------------------------------------------------ *
 * Upload (real users only)
 * ------------------------------------------------------------------ */
app.get('/upload', requireRealUser, (req, res) => {
  const tab = req.query.tab === 'other' ? 'other' : 'notes';
  res.send(renderUpload({ user: req.user, values: {}, activeTab: tab, req }));
});

app.post('/upload', requireRealUser, handleFileUpload('file'), async (req, res, next) => {
  const kind = (req.body && req.body.kind === 'other') ? 'other' : 'note';
  const activeTab = kind === 'other' ? 'other' : 'notes';

  try {
    const user = req.user;
    const body = req.body || {};
    const writer = String(body.writer || '').trim();
    const description = String(body.description || '').trim();
    const visibility = body.visibility === 'private' ? 'private' : 'public';

    const baseValues = { writer, description, visibility, chapterNo: body.chapterNo, chapterName: body.chapterName, subject: body.subject, tag1: body.tag1, tag2: body.tag2, tag3: body.tag3 };

    const fail = (message, status) => res.status(status).send(renderUpload({ user, error: message, values: baseValues, activeTab, req }));

    if (!req.file) return fail('Please choose a file to upload.', 400);
    if (!writer) return fail('Please enter your name.', 400);
    if (req.file.size > MAX_FILE_SIZE) return fail('File is too large. Max 100 MB.', 413);

    let chapterNo = '', chapterName = '', subject = '', tags = [];

    if (kind === 'note') {
      chapterNo = String(body.chapterNo || '').trim();
      chapterName = String(body.chapterName || '').trim();
      subject = String(body.subject || '').trim();
      if (!chapterNo || Number.isNaN(Number(chapterNo))) return fail('Chapter number must be a valid number.', 400);
      if (!chapterName) return fail('Chapter name is required.', 400);
      if (!subject) return fail('Subject is required.', 400);
      if (chapterName.length > 200 || subject.length > 120 || writer.length > 120 || description.length > 2000) return fail('One or more fields exceed the maximum length.', 400);
    } else {
      const rawTags = [body.tag1, body.tag2, body.tag3].map((t) => String(t || '').trim().replace(/^#+/, '').trim()).filter(Boolean);
      const seen = new Set();
      for (const t of rawTags) { const k = t.toLowerCase(); if (!seen.has(k)) { seen.add(k); tags.push(t); } if (tags.length >= MAX_TAGS) break; }
      if (!tags.length) return fail('Please add at least one tag.', 400);
      if (tags.some((t) => t.length > 30)) return fail('Each tag must be 30 characters or less.', 400);
      if (description.length > 2000) return fail('Description is too long.', 400);
      chapterName = stripExtension(normalizeOriginalName(req.file.originalname)).slice(0, 200) || 'Untitled';
    }

    const result = await uploadBufferToCloudinary(req.file.buffer, req.file.originalname);
    const normalizedName = normalizeOriginalName(req.file.originalname);
    const pseudoRecord = { mimeType: req.file.mimetype || 'application/octet-stream', originalName: normalizedName, storedName: result.public_id };
    const thumbnailUrl = buildA4ThumbnailUrl(pseudoRecord);

    await File.create({
      owner: user._id, ownerUsername: user.username, kind, chapterNo, chapterName, subject, writer, description, tags, visibility,
      originalName: normalizedName, storedName: result.public_id, fileUrl: result.secure_url,
      resourceType: result.resource_type || 'image', thumbnailUrl: thumbnailUrl || '',
      size: result.bytes || req.file.size, mimeType: pseudoRecord.mimeType
    });

    res.redirect('/?upload=success');
  } catch (err) { console.error('[biologynotes] upload failed:', err); next(err); }
});

/* ------------------------------------------------------------------ *
 * File edit (real users only)
 * ------------------------------------------------------------------ */
app.get('/files/:id/edit', requireRealUser, async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!isValidObjectId(id)) return res.status(404).send(renderErrorPage(404, 'Not found', 'That file does not exist.', req));
    const record = await File.findById(id).lean();
    if (!record) return res.status(404).send(renderErrorPage(404, 'Not found', 'That file does not exist.', req));
    if (String(record.owner) !== String(req.user._id)) return res.status(403).send(renderErrorPage(403, 'Forbidden', 'You can only edit your own files.', req));
    res.send(renderFileEdit({ user: req.user, record, req }));
  } catch (err) { next(err); }
});

app.post('/files/:id/edit', requireRealUser, handleFileUpload('newFile'), async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!isValidObjectId(id)) return res.status(404).send(renderErrorPage(404, 'Not found', 'That file does not exist.', req));
    const record = await File.findById(id);
    if (!record) return res.status(404).send(renderErrorPage(404, 'Not found', 'That file does not exist.', req));
    if (String(record.owner) !== String(req.user._id)) return res.status(403).send(renderErrorPage(403, 'Forbidden', 'You can only edit your own files.', req));

    const body = req.body || {};
    const kind = record.kind;
    const writer = String(body.writer || '').trim();
    const description = String(body.description || '').trim();
    const visibility = body.visibility === 'private' ? 'private' : 'public';
    const chapterName = String(body.chapterName || '').trim();
    const values = { chapterName, writer, description, visibility, chapterNo: body.chapterNo, subject: body.subject, tag1: body.tag1, tag2: body.tag2, tag3: body.tag3 };
    const fail = (message, status) => res.status(status).send(renderFileEdit({ user: req.user, record, error: message, values, req }));

    if (!chapterName) return fail('Title / Chapter name is required.', 400);
    if (!writer) return fail('Writer name is required.', 400);
    if (chapterName.length > 200 || writer.length > 120 || description.length > 2000) return fail('One or more fields exceed the maximum length.', 400);

    if (kind === 'note') {
      const chapterNo = String(body.chapterNo || '').trim();
      const subject = String(body.subject || '').trim();
      if (!chapterNo || Number.isNaN(Number(chapterNo))) return fail('Chapter number must be valid.', 400);
      if (!subject) return fail('Subject is required.', 400);
      if (subject.length > 120) return fail('Subject is too long.', 400);
      record.chapterNo = chapterNo;
      record.subject = subject;
    } else {
      const rawTags = [body.tag1, body.tag2, body.tag3].map((t) => String(t || '').trim().replace(/^#+/, '').trim()).filter(Boolean);
      const seen = new Set(); const tags = [];
      for (const t of rawTags) { const k = t.toLowerCase(); if (!seen.has(k)) { seen.add(k); tags.push(t); } if (tags.length >= MAX_TAGS) break; }
      if (!tags.length) return fail('Please add at least one tag.', 400);
      if (tags.some((t) => t.length > 30)) return fail('Each tag must be 30 characters or less.', 400);
      record.tags = tags;
    }

    record.chapterName = chapterName;
    record.writer = writer;
    record.description = description;
    record.visibility = visibility;

    if (req.file) {
      if (req.file.size > MAX_FILE_SIZE) return fail('Replacement file is too large.', 413);
      try { await deleteFromCloudinary(record.storedName, record.resourceType); } catch (err) { console.warn('[biologynotes] old asset delete failed:', err.message); }
      const result = await uploadBufferToCloudinary(req.file.buffer, req.file.originalname);
      const normalizedName = normalizeOriginalName(req.file.originalname);
      const pseudoRecord = { mimeType: req.file.mimetype || 'application/octet-stream', originalName: normalizedName, storedName: result.public_id };
      const thumbnailUrl = buildA4ThumbnailUrl(pseudoRecord);
      record.originalName = normalizedName;
      record.storedName = result.public_id;
      record.fileUrl = result.secure_url;
      record.resourceType = result.resource_type || 'image';
      record.thumbnailUrl = thumbnailUrl || '';
      record.size = result.bytes || req.file.size;
      record.mimeType = pseudoRecord.mimeType;
    }

    await record.save();
    return res.redirect('/files/' + encodeURIComponent(id) + '?updated=success');
  } catch (err) { console.error('[biologynotes] file edit failed:', err); next(err); }
});

/* ------------------------------------------------------------------ *
 * Avatar (real users only)
 * ------------------------------------------------------------------ */
app.post('/profile/avatar', requireRealUser, handleAvatarUpload, async (req, res, next) => {
  try {
    if (!req.file) return res.redirect('/users/' + encodeURIComponent(req.user.username) + '?avatarError=' + encodeURIComponent('Please choose an image.'));
    if (!String(req.file.mimetype || '').startsWith('image/')) return res.redirect('/users/' + encodeURIComponent(req.user.username) + '?avatarError=' + encodeURIComponent('Profile picture must be an image.'));
    if (req.user.avatarPublicId) await deleteFromCloudinary(req.user.avatarPublicId, 'image');
    const result = await uploadBufferToCloudinary(req.file.buffer, req.file.originalname, 'biologynotes/avatars');
    await User.updateOne({ _id: req.user._id }, { $set: { avatarUrl: result.secure_url, avatarPublicId: result.public_id } });
    return res.redirect('/users/' + encodeURIComponent(req.user.username) + '?avatarUpdated=1');
  } catch (err) {
    console.error('[biologynotes] avatar upload failed:', err);
    return res.redirect('/users/' + encodeURIComponent(req.user.username) + '?avatarError=' + encodeURIComponent('Could not upload avatar.'));
  }
});

app.post('/profile/avatar/remove', requireRealUser, async (req, res, next) => {
  try {
    if (req.user.avatarPublicId) await deleteFromCloudinary(req.user.avatarPublicId, 'image');
    await User.updateOne({ _id: req.user._id }, { $set: { avatarUrl: '', avatarPublicId: '' } });
    return res.redirect('/users/' + encodeURIComponent(req.user.username) + '?avatarUpdated=1');
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------------ *
 * Profile edit + delete (real users only)
 * ------------------------------------------------------------------ */
app.get('/profile/edit', requireRealUser, (req, res) => {
  res.send(renderProfileEdit({ user: req.user, notice: req.query.updated ? 'Your profile was updated successfully.' : '', req }));
});

app.post('/profile/edit', requireRealUser, async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.redirect('/login');

    const body = req.body || {};
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const username = String(body.username || '').trim();
    const currentPassword = String(body.currentPassword || '');
    const newPassword = String(body.newPassword || '');
    const confirmPassword = String(body.confirmPassword || '');
    const values = { name, email, username };

    const fail = (message, status) => res.status(status || 400).send(renderProfileEdit({ user: req.user, error: message, values, req }));

    if (!name || !email || !username) return fail('Name, email, and username are required.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('Please enter a valid email address.');
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return fail('Username must be 3–20 characters — letters, numbers, or underscores.');
    if (name.length > 80) return fail('Name is too long.');

    const dupe = await User.findOne({
      _id: { $ne: user._id },
      $or: [{ username: new RegExp('^' + username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') }, { email }]
    }).lean();

    if (dupe) {
      const msg = String(dupe.username).toLowerCase() === username.toLowerCase() ? 'That username is already taken.' : 'That email address is already registered.';
      return fail(msg, 409);
    }

    if (newPassword || confirmPassword || currentPassword) {
      if (!currentPassword) return fail('Please enter your current password.');
      if (!verifyPassword(currentPassword, user.passwordHash)) return fail('Current password is incorrect.', 401);
      if (!newPassword) return fail('Please enter a new password.');
      if (newPassword.length < 6) return fail('New password must be at least 6 characters.');
      if (newPassword !== confirmPassword) return fail('New passwords do not match.');
      user.passwordHash = hashPassword(newPassword);
    }

    user.name = name;
    user.email = email;
    const usernameChanged = user.username.toLowerCase() !== username.toLowerCase();
    if (usernameChanged) user.username = username;

    await user.save();

    if (usernameChanged) await File.updateMany({ owner: user._id }, { $set: { ownerUsername: username } });

    return res.redirect('/profile/edit?updated=1');
  } catch (err) {
    if (err && err.code === 11000) return res.status(409).send(renderProfileEdit({ user: req.user, error: 'That username or email is already registered.', values: req.body || {}, req }));
    next(err);
  }
});

app.post('/profile/delete', requireRealUser, async (req, res, next) => {
  try {
    const userId = req.user._id;
    if (req.user.avatarPublicId) await deleteFromCloudinary(req.user.avatarPublicId, 'image');
    const userFiles = await File.find({ owner: userId }).lean();
    for (const f of userFiles) { try { await deleteFromCloudinary(f.storedName, f.resourceType); } catch (err) { console.warn('[biologynotes] delete account asset error:', err.message); } }
    await File.deleteMany({ owner: userId });
    await User.updateMany({ subscribers: userId }, { $pull: { subscribers: userId } });
    await User.updateMany({ subscribedTo: userId }, { $pull: { subscribedTo: userId } });
    await User.deleteOne({ _id: userId });
    if (req.session) {
      req.session.destroy(() => { res.clearCookie('bn.sid'); return res.redirect('/login?accountDeleted=1'); });
    } else {
      res.clearCookie('bn.sid');
      return res.redirect('/login?accountDeleted=1');
    }
  } catch (err) { console.error('[biologynotes] delete account failed:', err); next(err); }
});

/* ------------------------------------------------------------------ *
 * File view / raw / download / rate / comment / delete
 * ------------------------------------------------------------------ */
async function findAccessibleFile(req, id) {
  if (!isValidObjectId(id)) return { error: 'notfound' };
  const record = await File.findById(id).lean();
  if (!record) return { error: 'notfound' };

  // Public files are visible to everyone (user, guest, anonymous)
  if (record.visibility === 'public') return { record };

  // Private files: only the owner (a real user) can view
  if (req.user && String(record.owner) === String(req.user._id)) return { record };

  return { error: 'forbidden' };
}

app.get('/files/:id', requireAuth, async (req, res, next) => {
  try {
    const result = await findAccessibleFile(req, req.params.id);
    if (result.error === 'notfound') return res.status(404).send(renderErrorPage(404, 'Not found', 'That file does not exist.', req));
    if (result.error === 'forbidden') return res.status(403).send(renderErrorPage(403, 'Forbidden', 'You do not have access to this file.', req));

    const record = await File.findByIdAndUpdate(result.record._id, { $inc: { views: 1 } }, { new: true }).lean();
    const owner = await User.findById(record.owner).select('name username avatarUrl subscribers').lean();
    const ownerPublicFiles = owner ? await File.countDocuments({ owner: owner._id, visibility: 'public' }) : 0;

    let notice = '';
    if (req.query.rated === '1') notice = 'Thanks for rating!';
    else if (req.query.updated === 'success') notice = 'File updated successfully.';
    else if (req.query.commented === '1') notice = 'Comment posted.';

    res.send(renderFileDetail({ user: req.user, publicViewer: req.publicViewer, record, owner, ownerPublicFiles, notice, req }));
  } catch (err) { next(err); }
});

app.get('/files/:id/raw', requireAuth, async (req, res, next) => {
  try {
    const result = await findAccessibleFile(req, req.params.id);
    if (result.error === 'notfound') return res.status(404).send(renderErrorPage(404, 'Not found', 'That file does not exist.', req));
    if (result.error === 'forbidden') return res.status(403).send(renderErrorPage(403, 'Forbidden', 'You do not have access to this file.', req));
    return res.redirect(result.record.fileUrl);
  } catch (err) { next(err); }
});

app.get('/files/:id/download', requireAuth, async (req, res, next) => {
  try {
    const result = await findAccessibleFile(req, req.params.id);
    if (result.error === 'notfound') return res.status(404).send(renderErrorPage(404, 'Not found', 'That file does not exist.', req));
    if (result.error === 'forbidden') return res.status(403).send(renderErrorPage(403, 'Forbidden', 'You do not have access to this file.', req));

    await File.updateOne({ _id: result.record._id }, { $inc: { downloads: 1 } });

    const dl = buildCloudinaryDownloadUrl(result.record.fileUrl, result.record.originalName, result.record.mimeType);
    return res.redirect(dl);
  } catch (err) { next(err); }
});

app.post('/files/:id/delete', requireRealUser, async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!isValidObjectId(id)) return res.status(404).send(renderErrorPage(404, 'Not found', 'That file does not exist.', req));
    const record = await File.findById(id).lean();
    if (!record) return res.status(404).send(renderErrorPage(404, 'Not found', 'That file does not exist.', req));
    if (String(record.owner) !== String(req.user._id)) return res.status(403).send(renderErrorPage(403, 'Forbidden', 'You can only delete your own files.', req));
    const destroyResult = await deleteFromCloudinary(record.storedName, record.resourceType);
    if (!destroyResult.ok) console.warn('[biologynotes] Cloudinary delete skipped:', record.storedName, destroyResult.error);
    await File.deleteOne({ _id: record._id });
    return res.redirect('/?deleted=success');
  } catch (err) { next(err); }
});

app.post('/files/:id/rate', requireRealUser, async (req, res, next) => {
  try {
    const result = await findAccessibleFile(req, req.params.id);
    if (result.error === 'notfound') return res.status(404).json({ error: 'notfound' });
    if (result.error === 'forbidden') return res.status(403).json({ error: 'forbidden' });

    const value = parseInt(req.body && req.body.value, 10);
    if (!Number.isInteger(value) || value < 1 || value > 5) return res.status(400).json({ error: 'Rating must be 1–5.' });

    const record = await File.findById(result.record._id);
    const uid = req.user._id;
    const existing = record.ratings.find((r) => String(r.user) === String(uid));
    if (existing) { existing.value = value; existing.createdAt = Date.now(); }
    else record.ratings.push({ user: uid, value, createdAt: Date.now() });
    await record.save();

    const doc = record.toObject();
    return res.json({ ok: true, average: averageRating(doc), count: doc.ratings.length, yourRating: value });
  } catch (err) { next(err); }
});

app.post('/files/:id/comment', requireRealUser, async (req, res, next) => {
  try {
    const result = await findAccessibleFile(req, req.params.id);
    if (result.error === 'notfound') return res.status(404).send(renderErrorPage(404, 'Not found', 'That file does not exist.', req));
    if (result.error === 'forbidden') return res.status(403).send(renderErrorPage(403, 'Forbidden', 'You do not have access to this file.', req));

    const text = String((req.body && req.body.text) || '').trim();
    if (!text || text.length > MAX_COMMENT_LEN) return res.redirect('/files/' + encodeURIComponent(result.record._id) + '#comments');

    const record = await File.findById(result.record._id);
    record.comments.push({ user: req.user._id, username: req.user.username, name: req.user.name, avatarUrl: req.user.avatarUrl || '', text, createdAt: Date.now() });
    await record.save();

    return res.redirect('/files/' + encodeURIComponent(result.record._id) + '?commented=1#comments');
  } catch (err) { next(err); }
});

app.post('/files/:id/comment/:commentId/delete', requireRealUser, async (req, res, next) => {
  try {
    const id = req.params.id; const commentId = req.params.commentId;
    if (!isValidObjectId(id) || !isValidObjectId(commentId)) return res.status(404).send(renderErrorPage(404, 'Not found', 'That comment does not exist.', req));
    const record = await File.findById(id);
    if (!record) return res.status(404).send(renderErrorPage(404, 'Not found', 'That file does not exist.', req));
    const comment = record.comments.id(commentId);
    if (!comment) return res.redirect('/files/' + encodeURIComponent(id) + '#comments');
    const isAuthor = String(comment.user) === String(req.user._id);
    const isFileOwner = String(record.owner) === String(req.user._id);
    if (!isAuthor && !isFileOwner) return res.status(403).send(renderErrorPage(403, 'Forbidden', 'You can only delete your own comments.', req));
    comment.deleteOne();
    await record.save();
    return res.redirect('/files/' + encodeURIComponent(id) + '#comments');
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------------ *
 * User profile (viewable by anyone logged in)
 * ------------------------------------------------------------------ */
app.get('/users/:username', requireRealUser, async (req, res, next) => {
  try {
    const viewer = req.user;
    const profileUser = await User.findOne({ username: new RegExp('^' + String(req.params.username).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') }).lean();
    if (!profileUser) return res.status(404).send(renderErrorPage(404, 'Not found', 'That user does not exist.', req));

    const isSelf = String(profileUser._id) === String(viewer._id);
    const q = { owner: profileUser._id };
    if (!isSelf) q.visibility = 'public';

    const records = await File.find(q).populate('owner', 'name username avatarUrl').sort({ createdAt: -1 }).limit(300).lean();
    const avatarNotice = req.query.avatarUpdated ? 'Profile picture updated.' : '';
    const avatarError = typeof req.query.avatarError === 'string' ? req.query.avatarError : '';

    res.send(renderUserProfile({ viewer, profileUser, records, subscribed: isSubscribed(viewer, profileUser._id), isSelf, avatarNotice, avatarError, req }));
  } catch (err) { next(err); }
});

app.post('/users/:id/subscribe', requireRealUser, async (req, res, next) => {
  try {
    const viewer = req.user;
    const targetId = req.params.id;
    if (!isValidObjectId(targetId)) return res.redirect(safeBackUrl(req));
    if (String(targetId) === String(viewer._id)) return res.redirect(safeBackUrl(req));
    const target = await User.findById(targetId);
    const me = await User.findById(viewer._id);
    if (!target || !me) return res.redirect(safeBackUrl(req));
    const alreadySubscribed = target.subscribers.some((id) => String(id) === String(me._id));
    if (alreadySubscribed) {
      target.subscribers = target.subscribers.filter((id) => String(id) !== String(me._id));
      me.subscribedTo = me.subscribedTo.filter((id) => String(id) !== String(target._id));
    } else {
      target.subscribers.push(me._id);
      if (!me.subscribedTo.some((id) => String(id) === String(target._id))) me.subscribedTo.push(target._id);
    }
    await Promise.all([target.save(), me.save()]);
    res.redirect(safeBackUrl(req));
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------------ *
 * Fallbacks
 * ------------------------------------------------------------------ */
app.use((req, res) => {
  res.status(404).send(renderErrorPage(404, 'Not found', 'The page you requested could not be found.', req));
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[biologynotes] Unhandled error:', err);
  if (res.headersSent) return;
  res.status(500).send(renderErrorPage(500, 'Server error', 'Something went wrong on our side.', req));
});

/* ------------------------------------------------------------------ *
 * Start
 * ------------------------------------------------------------------ */
async function start() {
  try {
    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 30000, connectTimeoutMS: 30000, socketTimeoutMS: 45000,
      family: 4, maxPoolSize: 20, autoIndex: !IS_PROD
    });
    console.log('[biologynotes] Connected to MongoDB');

    const server = app.listen(PORT, () => {
      console.log('[biologynotes] Running at http://localhost:' + PORT);
      console.log('[biologynotes] Environment: ' + NODE_ENV);
      console.log('[biologynotes] SITE_URL: ' + SITE_URL);
      console.log('[biologynotes] Storage: Cloudinary (' + CLOUDINARY_CLOUD_NAME + ')');
    });

    const shutdown = async (signal) => {
      console.log('\n[biologynotes] ' + signal + ' received. Shutting down...');
      server.close(async () => { try { await mongoose.connection.close(); } catch (e) {} process.exit(0); });
      setTimeout(() => process.exit(1), 10000).unref();
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (err) {
    console.error('\n[biologynotes] Failed to connect to MongoDB.\n');
    console.error('Error:', err.message);
    process.exit(1);
  }
}

start();

module.exports = app;
