'use strict';

/**
 * BiologyNotes — production single-file Node.js application.
 * Stack: Express · express-session · connect-mongo · Multer · Mongoose · dotenv · Helmet · Cloudinary
 * Typography: Playfair Display · Merriweather · Poppins
 * Icons: Font Awesome 6
 * Storage: Cloudinary (works on Render free tier)
 * Thumbnails: A4 aspect-ratio (210:297) generated via Cloudinary transformations
 * Features: auth, uploads, ratings, subscriptions, delete, share
 *
 * Run with: node server.js
 */

require('dotenv').config();

/* ------------------------------------------------------------------ *
 * DNS FIX — public resolvers for mongodb+srv:// on restrictive ISPs
 * ------------------------------------------------------------------ */
const dns = require('dns');
try {
  dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);
  if (typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
  }
  console.log('[biologynotes] DNS resolvers set to 8.8.8.8 / 8.8.4.4 / 1.1.1.1');
} catch (e) {
  console.warn('[biologynotes] Could not override DNS servers:', e.message);
}

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
 * connect-mongo — tolerant loader (v3 / v4 / v5)
 * ------------------------------------------------------------------ */
let MongoStore;
(function loadMongoStore() {
  const mod = require('connect-mongo');
  const candidate = mod && mod.default ? mod.default : mod;

  if (candidate && typeof candidate.create === 'function') {
    MongoStore = candidate;
    return;
  }

  if (typeof mod === 'function') {
    try {
      const v3 = mod(session);
      MongoStore = { create(opts) { return new v3(opts); } };
      console.warn('[biologynotes] Legacy connect-mongo v3 detected — using compatibility shim.');
      return;
    } catch (e) { /* fall through */ }
  }

  throw new Error(
    'connect-mongo export shape not recognised.\n' +
    'Run: npm uninstall connect-mongo && npm install connect-mongo@5.1.0'
  );
})();

/* ------------------------------------------------------------------ *
 * Configuration from environment
 * ------------------------------------------------------------------ */

const PORT = parseInt(process.env.PORT, 10) || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'biologynotes-insecure-dev-secret-change-me';
const MONGO_URI = process.env.MONGO_URI;
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';

const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;

if (!MONGO_URI) {
  console.error('\n[FATAL] MONGO_URI is not set. Create a .env file with MONGO_URI=...\n');
  process.exit(1);
}
if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
  console.error('\n[FATAL] Cloudinary env vars missing.');
  console.error('Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET in .env\n');
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

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

// A4 thumbnail dimensions (210mm × 297mm → ~0.707 ratio).
const A4_THUMB_W = 620;
const A4_THUMB_H = 877;

/* ------------------------------------------------------------------ *
 * Mongoose schemas
 * ------------------------------------------------------------------ */

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    username: { type: String, required: true, unique: true, trim: true, index: true },
    passwordHash: { type: String, required: true },
    subscribers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    subscribedTo: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
  },
  { timestamps: true }
);

const ratingSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    value: { type: Number, min: 1, max: 5, required: true },
    createdAt: { type: Date, default: Date.now }
  },
  { _id: false }
);

const fileSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    ownerUsername: { type: String, required: true, index: true },
    chapterNo: { type: String, required: true, trim: true, maxlength: 20 },
    chapterName: { type: String, required: true, trim: true, maxlength: 200 },
    subject: { type: String, required: true, trim: true, maxlength: 120 },
    writer: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: '', maxlength: 2000 },
    visibility: { type: String, enum: ['public', 'private'], default: 'public', index: true },
    originalName: { type: String, required: true, maxlength: 300 },
    storedName: { type: String, required: true },     // Cloudinary public_id
    fileUrl: { type: String, required: true },        // Cloudinary secure_url
    resourceType: { type: String, default: 'image' }, // Cloudinary resource_type: image|video|raw
    thumbnailUrl: { type: String, default: '' },      // Cloudinary A4 thumb URL (may be '')
    size: { type: Number, required: true, min: 0 },
    mimeType: { type: String, default: 'application/octet-stream' },
    downloads: { type: Number, default: 0 },
    views: { type: Number, default: 0 },
    ratings: [ratingSchema]
  },
  { timestamps: true }
);

fileSchema.index({ createdAt: -1 });
fileSchema.index({ downloads: -1 });
fileSchema.index({ chapterName: 'text', subject: 'text', writer: 'text', description: 'text' });

const User = mongoose.model('User', userSchema);
const File = mongoose.model('File', fileSchema);

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
  } catch (err) {
    return false;
  }
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const value = n / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(ts) {
  try {
    return new Date(ts).toLocaleString('en-US', {
      year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    });
  } catch (err) {
    return '';
  }
}

function normalizeOriginalName(name) {
  try {
    return Buffer.from(String(name), 'latin1').toString('utf8');
  } catch (err) {
    return String(name);
  }
}

function fileKind(mime, name) {
  const m = String(mime || '').toLowerCase();
  const ext = path.extname(String(name || '')).toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'application/pdf' || ext === '.pdf') return 'pdf';
  if (
    m.startsWith('text/') ||
    ['.txt', '.md', '.csv', '.json', '.js', '.ts', '.html', '.css', '.xml', '.yml', '.yaml'].includes(ext)
  ) return 'text';
  return 'file';
}

function kindLabel(kind) {
  switch (kind) {
    case 'image': return 'IMAGE';
    case 'video': return 'VIDEO';
    case 'audio': return 'AUDIO';
    case 'pdf': return 'PDF';
    case 'text': return 'TEXT';
    default: return 'FILE';
  }
}

function kindIconClass(kind) {
  switch (kind) {
    case 'image': return 'fa-regular fa-image';
    case 'video': return 'fa-solid fa-video';
    case 'audio': return 'fa-solid fa-music';
    case 'pdf': return 'fa-regular fa-file-pdf';
    case 'text': return 'fa-regular fa-file-lines';
    default: return 'fa-regular fa-file';
  }
}

function averageRating(file) {
  if (!file.ratings || !file.ratings.length) return 0;
  let sum = 0;
  for (const r of file.ratings) sum += Number(r.value) || 0;
  return sum / file.ratings.length;
}

function userRating(file, userId) {
  if (!file.ratings || !file.ratings.length) return 0;
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
    try {
      const u = new URL(back);
      back = u.pathname + (u.search || '');
    } catch (err) {
      back = '/';
    }
  }
  if (!back.startsWith('/')) back = '/';
  return back;
}

function renderStars(value, size) {
  const sz = size || 13;
  let html = '<span class="stars" style="font-size:' + sz + 'px">';
  for (let i = 1; i <= 5; i++) {
    const filled = value >= i - 0.5;
    html += filled ? '<i class="fa-solid fa-star"></i>' : '<i class="fa-regular fa-star"></i>';
  }
  html += '</span>';
  return html;
}

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

function fileExtUpper(name) {
  const parts = String(name || '').split('.');
  if (parts.length < 2) return 'FILE';
  return (parts[parts.length - 1] || 'FILE').toUpperCase().slice(0, 5);
}

/* ------------------------------------------------------------------ *
 * Cloudinary helpers
 * ------------------------------------------------------------------ */

function uploadBufferToCloudinary(buffer, originalName) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: 'biologynotes',
        resource_type: 'auto',
        use_filename: true,
        unique_filename: true,
        filename_override: originalName
      },
      (error, result) => (error ? reject(error) : resolve(result))
    );
    stream.end(buffer);
  });
}

function deleteFromCloudinary(publicId, resourceType) {
  return new Promise((resolve) => {
    if (!publicId) return resolve({ ok: false, error: 'no-public-id' });
    const type = ['image', 'video', 'raw'].includes(resourceType) ? resourceType : 'image';
    cloudinary.uploader.destroy(
      publicId,
      { resource_type: type, invalidate: true },
      (err, result) => {
        if (err) {
          console.warn('[biologynotes] Cloudinary destroy error:', err.message);
          return resolve({ ok: false, error: err.message });
        }
        resolve({ ok: true, result: result });
      }
    );
  });
}

function buildA4ThumbnailUrl(record) {
  const kind = fileKind(record.mimeType, record.originalName);
  const pid = record.storedName;
  if (!pid) return '';

  try {
    if (kind === 'image') {
      return cloudinary.url(pid, {
        resource_type: 'image',
        secure: true,
        transformation: [
          { width: A4_THUMB_W, height: A4_THUMB_H, crop: 'fill', gravity: 'auto' },
          { quality: 'auto', fetch_format: 'auto' }
        ]
      });
    }
    if (kind === 'pdf') {
      return cloudinary.url(pid, {
        resource_type: 'image',
        secure: true,
        format: 'jpg',
        page: 1,
        transformation: [
          { width: A4_THUMB_W, height: A4_THUMB_H, crop: 'fill' },
          { quality: 'auto' }
        ]
      });
    }
    if (kind === 'video') {
      return cloudinary.url(pid, {
        resource_type: 'video',
        secure: true,
        format: 'jpg',
        transformation: [
          { width: A4_THUMB_W, height: A4_THUMB_H, crop: 'fill', start_offset: '0' },
          { quality: 'auto' }
        ]
      });
    }
  } catch (err) {
    console.warn('[biologynotes] thumbnail build failed:', err.message);
  }

  return '';
}

function buildCloudinaryDownloadUrl(fileUrl, originalName, mimeType) {
  if (!fileUrl) return fileUrl;

  const kind = fileKind(mimeType, originalName);

  if (kind === 'file' || kind === 'text') {
    return fileUrl;
  }

  let baseName = String(originalName || 'download');
  baseName = baseName.replace(/\.[^.]+$/, '');
  baseName = baseName.replace(/[^a-zA-Z0-9_\- ]/g, '_');
  baseName = baseName.slice(0, 60) || 'download';

  return fileUrl.replace('/upload/', '/upload/fl_attachment:' + encodeURIComponent(baseName) + '/');
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
body{
  font-family:'Merriweather', Georgia, 'Times New Roman', serif;
  background:#fafafa;color:#18181b;font-size:15px;line-height:1.65;
  -webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;
}
.ui,button,input,select,textarea,.btn,.label,.nav-link,.badge,.chip,.topnav,.toolbar,.stat,.file-stats,.user-meta,.user-name,.card-meta,.tag{
  font-family:'Poppins', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
}
h1,h2,h3,h4,.display,.file-title,.chapter-title,.brand,.rating-avg{
  font-family:'Playfair Display', Georgia, serif;
  letter-spacing:-.01em;
}
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

.alert{padding:12px 15px;font-size:13.5px;margin-bottom:18px;border:1px solid #e4e4e7;background:#f4f4f5;color:#3f3f46;font-family:'Poppins',sans-serif;display:flex;align-items:flex-start;gap:10px}
.alert i{font-size:14px;margin-top:2px}
.alert-error{background:#fef2f2;border-color:#fecaca;color:#b91c1c}
.alert-success{background:#f0fdf4;border-color:#bbf7d0;color:#166534}

.auth-wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:calc(100vh - 64px);padding:40px 20px}
.auth-card{width:100%;max-width:440px;background:#fff;border:1px solid #e4e4e7;padding:32px;box-shadow:0 1px 3px rgba(24,24,27,.05)}
.auth-brand{margin-bottom:26px;display:flex;flex-direction:column;align-items:center;gap:14px}
.foot-note{text-align:center;color:#71717a;font-size:13.5px;margin-top:20px;font-family:'Poppins',sans-serif}
.foot-note a{color:#18181b;font-weight:500;text-decoration:underline;text-underline-offset:3px}

.banner{display:flex;flex-wrap:wrap;gap:16px;align-items:center;justify-content:space-between;background:#fff;border:1px solid #e4e4e7;padding:20px 22px;margin-bottom:22px;box-shadow:0 1px 2px rgba(24,24,27,.04)}
.user-info{display:flex;align-items:center;gap:14px;min-width:0}
.avatar{width:46px;height:46px;background:#18181b;color:#fafafa;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:17px;flex:0 0 auto;font-family:'Playfair Display', serif}
.avatar-sm{width:28px;height:28px;background:#18181b;color:#fafafa;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:12px;flex:0 0 auto;font-family:'Playfair Display',serif}
.user-name{font-weight:600;font-size:17px;letter-spacing:-.01em;font-family:'Playfair Display', serif}
.user-meta{color:#71717a;font-size:12.5px;word-break:break-word;font-family:'Poppins',sans-serif}

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

.preview{
  position:relative;display:flex;align-items:center;justify-content:center;
  height:280px;background:
    linear-gradient(135deg,#f4f4f5 0%,#e8e8ea 100%);
  border-bottom:1px solid #e4e4e7;overflow:hidden;padding:18px;
}
.preview::before{
  content:'';position:absolute;inset:0;
  background-image:
    linear-gradient(rgba(228,228,231,.55) 1px,transparent 1px),
    linear-gradient(90deg,rgba(228,228,231,.55) 1px,transparent 1px);
  background-size:22px 22px;
  opacity:.35;pointer-events:none;
}
.a4-thumb{
  position:relative;
  aspect-ratio:210 / 297;
  height:100%;
  max-width:100%;
  background:#fff;
  border:1px solid #d4d4d8;
  box-shadow:
    0 4px 14px rgba(24,24,27,.14),
    0 1px 3px rgba(24,24,27,.08);
  overflow:hidden;
  transition:transform .22s ease,box-shadow .22s ease;
  z-index:1;
}
.file-card:hover .a4-thumb{transform:translateY(-3px) scale(1.015);box-shadow:0 10px 24px rgba(24,24,27,.18),0 2px 5px rgba(24,24,27,.10)}
.a4-thumb img{
  position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;
  background:#fff;
}
.a4-fallback{
  position:absolute;inset:0;
  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;
  padding:14px 12px;background:#fff;
}
.a4-fallback::before{
  content:'';position:absolute;top:0;left:0;right:0;height:3px;background:#18181b;
}
.a4-fallback i{font-size:38px;color:#a1a1aa}
.a4-fallback .ext-badge{
  font-family:'Poppins',sans-serif;font-size:11px;font-weight:700;letter-spacing:.1em;
  color:#18181b;padding:5px 10px;background:#f4f4f5;border:1px solid #e4e4e7;
}
.a4-fallback .lines{width:78%;display:flex;flex-direction:column;gap:5px;margin-top:8px}
.a4-fallback .lines span{height:2px;background:#e4e4e7;display:block}
.a4-fallback .lines span:nth-child(1){width:100%}
.a4-fallback .lines span:nth-child(2){width:88%}
.a4-fallback .lines span:nth-child(3){width:94%}
.a4-fallback .lines span:nth-child(4){width:62%}

.preview .type-badge{position:absolute;top:12px;left:12px;background:rgba(24,24,27,.88);color:#fafafa;font-size:10px;font-weight:600;letter-spacing:.09em;padding:4px 7px;font-family:'Poppins',sans-serif;backdrop-filter:blur(4px);z-index:2}
.preview .vis-badge{position:absolute;top:12px;right:12px;background:rgba(255,255,255,.95);color:#18181b;font-size:10px;font-weight:600;letter-spacing:.09em;padding:4px 7px;border:1px solid #e4e4e7;font-family:'Poppins',sans-serif;backdrop-filter:blur(4px);z-index:2}

.preview .play-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,.95);background:rgba(24,24,27,.22);pointer-events:none;transition:background-color .2s ease;z-index:1}
.preview .play-overlay i{font-size:48px;filter:drop-shadow(0 2px 4px rgba(0,0,0,.4))}
.file-card:hover .play-overlay{background:rgba(24,24,27,.32)}

.file-body{padding:15px;display:flex;flex-direction:column;gap:9px;flex:1}
.file-top{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.badge{display:inline-flex;align-items:center;gap:5px;height:23px;padding:0 8px;font-size:10.5px;font-weight:600;letter-spacing:.05em;background:#f4f4f5;color:#3f3f46;border:1px solid #e4e4e7;font-family:'Poppins',sans-serif;text-transform:uppercase}
.badge i{font-size:10px}
.badge-dark{background:#18181b;color:#fafafa;border-color:#18181b}
.badge-type{background:#fff}
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

.empty{text-align:center;padding:64px 24px;border:1px dashed #e4e4e7;background:#fff;color:#71717a}
.empty i{font-size:44px;color:#d4d4d8;margin-bottom:14px;display:block}
.empty h3{font-size:18px;color:#18181b;margin-bottom:6px;font-family:'Playfair Display',serif}
.empty p{margin:0 0 20px;font-size:13.5px}

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

/* ------------------------------------------------------------------ *
 * DETAIL PAGE
 * ------------------------------------------------------------------ */
.detail-grid{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(300px,1fr);gap:22px;align-items:start}
@media (max-width:880px){.detail-grid{grid-template-columns:1fr}}

/* Base preview (dark, for media) */
.detail-preview{background:#0a0a0a;border:1px solid #18181b;min-height:320px;display:flex;align-items:center;justify-content:center;overflow:hidden;position:relative}
.detail-preview img{max-width:100%;max-height:620px;display:block}
.detail-preview video{max-width:100%;max-height:620px;display:block;background:#000}
.detail-preview audio{width:100%;padding:28px}
.detail-preview .placeholder{color:#a1a1aa;display:flex;flex-direction:column;align-items:center;gap:14px;padding:70px 20px;text-align:center}
.detail-preview .placeholder i{font-size:64px;color:#52525b}
.detail-preview .placeholder .kind-label{font-size:11px;letter-spacing:.16em;font-weight:600;color:#fafafa;font-family:'Poppins',sans-serif}

/* Light preview for documents (pdf, docx, txt, etc.) */
.detail-preview-light{
  background: linear-gradient(135deg,#fafafa 0%,#f0f0f1 100%);
  border-color:#e4e4e7;
  padding:26px;
  min-height:460px;
}
.detail-preview-light::before{
  content:'';position:absolute;inset:0;
  background-image:
    linear-gradient(rgba(228,228,231,.55) 1px,transparent 1px),
    linear-gradient(90deg,rgba(228,228,231,.55) 1px,transparent 1px);
  background-size:22px 22px;opacity:.5;pointer-events:none;
}
.detail-preview-light iframe{
  position:relative;z-index:1;
  width:100%;height:640px;border:1px solid #d4d4d8;background:#fff;
}
.detail-preview-light .detail-a4-wrap{position:relative;z-index:1;padding:0;min-height:auto;background:transparent;border:0;display:flex;align-items:center;justify-content:center}

/* A4 sheet on detail page */
.detail-a4-wrap{display:flex;align-items:center;justify-content:center;min-height:420px;padding:0}
.detail-a4{
  aspect-ratio:210/297;width:100%;max-width:420px;background:#fff;border:1px solid #d4d4d8;
  box-shadow:0 8px 30px rgba(24,24,27,.18),0 2px 6px rgba(24,24,27,.08);
  position:relative;overflow:hidden;
}
.detail-a4 .a4-fallback i{font-size:64px}
.detail-a4 .a4-fallback .ext-badge{font-size:13px;padding:7px 14px}
.detail-a4 .a4-fallback .lines{width:70%;gap:7px}
.detail-a4 .a4-fallback .lines span{height:2px}

/* Sidebar A4 thumbnail card */
.a4-thumb-card{background:#fff;border:1px solid #e4e4e7;display:flex;flex-direction:column}
.a4-thumb-card-head{
  display:flex;align-items:center;gap:8px;
  padding:12px 16px;border-bottom:1px solid #f4f4f5;
  font-family:'Poppins',sans-serif;font-size:12.5px;font-weight:600;
  letter-spacing:.05em;text-transform:uppercase;color:#52525b;
}
.a4-thumb-card-head i{font-size:12px;color:#a1a1aa}
.a4-thumb-card-body{
  padding:20px;display:flex;align-items:center;justify-content:center;
  background:
    linear-gradient(135deg,#fafafa 0%,#f0f0f1 100%);
  position:relative;
  min-height:280px;
}
.a4-thumb-card-body::before{
  content:'';position:absolute;inset:0;
  background-image:
    linear-gradient(rgba(228,228,231,.5) 1px,transparent 1px),
    linear-gradient(90deg,rgba(228,228,231,.5) 1px,transparent 1px);
  background-size:18px 18px;opacity:.4;pointer-events:none;
}
.a4-thumb-card-body .a4-thumb{
  height:auto;
  aspect-ratio:210/297;
  width:100%;
  max-width:230px;
}

/* Share card */
.share-card{background:#fff;border:1px solid #e4e4e7;padding:18px;display:flex;flex-direction:column;gap:14px}
.share-card-head{
  font-family:'Poppins',sans-serif;font-size:12.5px;font-weight:600;
  letter-spacing:.05em;text-transform:uppercase;color:#52525b;
  display:flex;align-items:center;gap:8px;
}
.share-card-head i{font-size:12px;color:#a1a1aa}
.share-buttons{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.share-btn{
  height:46px;background:#fff;border:1px solid #e4e4e7;color:#3f3f46;
  display:flex;align-items:center;justify-content:center;cursor:pointer;
  font-size:16px;text-decoration:none;
  transition:background-color .15s ease,color .15s ease,border-color .15s ease,transform .05s ease;
}
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
.uploader-row .avatar{width:42px;height:42px;font-size:15px}
.uploader-meta{min-width:0}
.uploader-meta .name{font-weight:600;font-size:15px;letter-spacing:-.01em;font-family:'Playfair Display',serif}
.uploader-meta .handle{color:#71717a;font-size:12.5px;font-family:'Poppins',sans-serif}
.uploader-meta .handle:hover{color:#18181b;text-decoration:underline;text-underline-offset:2px}
.uploader-stats{display:flex;gap:16px;color:#71717a;font-size:12px;flex-wrap:wrap;font-family:'Poppins',sans-serif}
.uploader-stats span{display:inline-flex;align-items:center;gap:6px}
.uploader-stats i{font-size:11.5px;color:#a1a1aa}

.error-page{text-align:center;padding:72px 26px}
.error-page h1{font-size:64px;margin-bottom:6px;font-family:'Playfair Display',serif;font-weight:700}
.error-page p{color:#71717a;margin:0 0 24px}

.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.flex-between{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.inline-form{display:inline}
.hr{height:1px;background:#f4f4f5;margin:18px 0;border:0}
.text-muted{color:#71717a}
.text-strong{color:#18181b;font-weight:500}

.upload-header{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:18px;flex-wrap:wrap}
.upload-header .eyebrow{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#a1a1aa;font-weight:600;font-family:'Poppins',sans-serif;margin-bottom:4px}
.upload-header h1{font-size:28px}

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
}
`;

/* ------------------------------------------------------------------ *
 * Layout + shared UI
 * ------------------------------------------------------------------ */

function layout(title, body) {
  return '<!DOCTYPE html>\n' +
    '<html lang="en">\n' +
    '<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<title>' + escapeHtml(title) + '</title>\n' +
    FONTS_LINK + '\n' +
    FA_LINK + '\n' +
    '<style>' + CSS + '</style>\n' +
    '</head>\n<body>\n' +
    body +
    '\n</body>\n</html>';
}

function brandMark() {
  return '<div class="brand"><a href="/"><span class="brand-mark"><i class="fa-solid fa-dna"></i></span><span>BiologyNotes</span></a></div>';
}

function renderTopNav(user, active) {
  const isActive = (name) => (active === name ? ' active' : '');
  const authed = !!user;
  return '' +
    '<header class="topnav"><div class="topnav-inner">' +
    brandMark() +
    (authed
      ? '<nav class="nav-links">' +
          '<a class="nav-link' + isActive('dashboard') + '" href="/"><i class="fa-solid fa-gauge-high"></i>Dashboard</a>' +
          '<a class="nav-link' + isActive('gallery') + '" href="/gallery"><i class="fa-solid fa-compass"></i>Gallery</a>' +
          '<a class="nav-link' + isActive('upload') + '" href="/upload"><i class="fa-solid fa-cloud-arrow-up"></i>Upload</a>' +
        '</nav>' +
        '<div class="nav-right">' +
          '<a class="btn btn-outline btn-xs" href="/users/' + encodeURIComponent(user.username) + '"><i class="fa-regular fa-circle-user"></i>@' + escapeHtml(user.username) + '</a>' +
          '<a class="btn btn-primary btn-xs" href="/upload"><i class="fa-solid fa-plus"></i>Upload</a>' +
          '<a class="btn btn-ghost btn-xs" href="/logout" title="Logout"><i class="fa-solid fa-right-from-bracket"></i></a>' +
        '</div>'
      : '<div class="nav-right">' +
          '<a class="btn btn-outline btn-xs" href="/login"><i class="fa-solid fa-arrow-right-to-bracket"></i>Login</a>' +
          '<a class="btn btn-primary btn-xs" href="/register"><i class="fa-solid fa-user-plus"></i>Register</a>' +
        '</div>') +
    '</div></header>';
}

/* ------------------------------------------------------------------ *
 * Auth pages
 * ------------------------------------------------------------------ */

function renderRegister(ctx) {
  const { error = '', values = {} } = ctx || {};
  const body = '' +
    renderTopNav(null, 'register') +
    '<div class="auth-wrap"><div class="auth-card">' +
      '<div class="auth-brand">' +
        '<div class="brand-mark" style="width:48px;height:48px"><i class="fa-solid fa-dna" style="font-size:22px"></i></div>' +
        '<h1 style="font-size:26px;margin:0">Create your account</h1>' +
        '<p class="sub" style="margin:0;text-align:center">Register to start uploading, rating, and subscribing.</p>' +
      '</div>' +
      (error ? '<div class="alert alert-error"><i class="fa-solid fa-circle-exclamation"></i><span>' + escapeHtml(error) + '</span></div>' : '') +
      '<div class="alert alert-error" id="client-error" style="display:none"><i class="fa-solid fa-circle-exclamation"></i><span></span></div>' +
      '<form id="register-form" method="POST" action="/register">' +
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
      '<p class="foot-note">Already registered? <a href="/login">Sign in</a></p>' +
    '</div></div>' +
    '<script>(function(){var f=document.getElementById("register-form");var b=document.getElementById("client-error");if(!f||!b)return;f.addEventListener("submit",function(e){var p=f.querySelector("[name=password]").value||"";var s=b.querySelector("span");if(p.length<6){e.preventDefault();s.textContent="Password must be at least 6 characters long.";b.style.display="flex";}else{b.style.display="none";}});})();</script>';
  return layout('Register · BiologyNotes', body);
}

function renderLogin(ctx) {
  const { error = '', values = {} } = ctx || {};
  const body = '' +
    renderTopNav(null, 'login') +
    '<div class="auth-wrap"><div class="auth-card">' +
      '<div class="auth-brand">' +
        '<div class="brand-mark" style="width:48px;height:48px"><i class="fa-solid fa-dna" style="font-size:22px"></i></div>' +
        '<h1 style="font-size:26px;margin:0">Welcome back</h1>' +
        '<p class="sub" style="margin:0;text-align:center">Sign in to access your dashboard and files.</p>' +
      '</div>' +
      (error ? '<div class="alert alert-error"><i class="fa-solid fa-circle-exclamation"></i><span>' + escapeHtml(error) + '</span></div>' : '') +
      '<form method="POST" action="/login">' +
        '<div class="field"><label class="label" for="f-username">Username</label>' +
          '<input class="input" id="f-username" name="username" type="text" value="' + escapeHtml(values.username || '') + '" placeholder="janedoe" required autocomplete="username"></div>' +
        '<div class="field"><label class="label" for="f-password">Password</label>' +
          '<input class="input" id="f-password" name="password" type="password" placeholder="Your password" required autocomplete="current-password"></div>' +
        '<button type="submit" class="btn btn-primary btn-block btn-lg"><i class="fa-solid fa-arrow-right-to-bracket"></i>Sign in</button>' +
      '</form>' +
      '<p class="foot-note">Need an account? <a href="/register">Register</a></p>' +
    '</div></div>';
  return layout('Login · BiologyNotes', body);
}

/* ------------------------------------------------------------------ *
 * Preview / thumbnail renderer (A4)
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
  const typeBadge = '<span class="type-badge">' + kindLabel(kind) + '</span>';
  const visBadge = '<span class="vis-badge">' + (record.visibility === 'public' ? 'PUBLIC' : 'PRIVATE') + '</span>';
  const href = '/files/' + encodeURIComponent(String(record._id));

  const playOverlay = (kind === 'video')
    ? '<div class="play-overlay"><i class="fa-solid fa-circle-play"></i></div>'
    : '';

  return '<a class="preview" href="' + href + '">' +
    typeBadge + visBadge +
    '<div class="a4-thumb">' + renderA4ThumbInner(record, kind) + '</div>' +
    playOverlay +
    '</a>';
}

function renderCard(record, viewer) {
  const avg = averageRating(record);
  const ratingCount = record.ratings ? record.ratings.length : 0;
  const kind = fileKind(record.mimeType, record.originalName);
  const owner = record.owner && typeof record.owner === 'object' ? record.owner : null;
  const ownerName = owner ? owner.name : record.ownerUsername;
  const ownerHandle = owner ? owner.username : record.ownerUsername;
  const ownerId = owner ? String(owner._id) : String(record.owner);
  const viewerId = viewer ? String(viewer._id) : null;
  const subscribed = viewer && viewerId !== ownerId && isSubscribed(viewer, ownerId);
  const isSelf = viewer && viewerId === ownerId;

  let actionBtn = '';
  if (viewer && isSelf) {
    actionBtn = '<form method="POST" action="/files/' + encodeURIComponent(String(record._id)) + '/delete" class="inline-form" onsubmit="return confirm(\'Delete this file permanently? This cannot be undone.\');">' +
      '<button type="submit" class="btn btn-xs btn-danger" title="Delete file">' +
        '<i class="fa-solid fa-trash-can"></i>Delete' +
      '</button></form>';
  } else if (viewer) {
    actionBtn = '<form method="POST" action="/users/' + ownerId + '/subscribe" class="inline-form">' +
      '<button type="submit" class="btn btn-xs ' + (subscribed ? 'btn-outline' : 'btn-primary') + '">' +
        (subscribed
          ? '<i class="fa-solid fa-user-check"></i>Following'
          : '<i class="fa-solid fa-user-plus"></i>Follow') +
      '</button></form>';
  }

  const stars = renderStars(avg, 11);

  return '' +
    '<article class="file-card">' +
      renderPreview(record) +
      '<div class="file-body">' +
        '<div class="file-top">' +
          '<span class="badge badge-dark"><i class="fa-solid fa-bookmark"></i>CH ' + escapeHtml(record.chapterNo) + '</span>' +
          '<span class="badge badge-type"><i class="' + kindIconClass(kind) + '"></i>' + kindLabel(kind) + '</span>' +
          '<span class="badge"><i class="fa-solid fa-tag"></i>' + escapeHtml(record.subject) + '</span>' +
        '</div>' +
        '<h3 class="file-title"><a href="/files/' + encodeURIComponent(String(record._id)) + '">' + escapeHtml(record.chapterName) + '</a></h3>' +
        '<p class="file-sub"><i class="fa-solid fa-pen-nib"></i> ' + escapeHtml(record.writer) + ' &middot; ' + escapeHtml(formatBytes(record.size)) + '</p>' +
        (record.description ? '<p class="file-desc">' + escapeHtml(record.description) + '</p>' : '') +
        '<div class="file-stats">' +
          '<span class="stat stat-rating">' + stars + ' <span style="color:#18181b;font-weight:500">' + avg.toFixed(1) + '</span> <span style="color:#a1a1aa">(' + ratingCount + ')</span></span>' +
          '<span class="stat"><i class="fa-solid fa-download"></i>' + (record.downloads || 0) + '</span>' +
          '<span class="stat"><i class="fa-regular fa-eye"></i>' + (record.views || 0) + '</span>' +
        '</div>' +
        '<div class="file-foot">' +
          '<div class="uploader-mini">' +
            '<div class="avatar-sm">' + escapeHtml((ownerName || '?').trim().charAt(0).toUpperCase() || '?') + '</div>' +
            '<a href="/users/' + encodeURIComponent(ownerHandle) + '">@' + escapeHtml(ownerHandle) + '</a>' +
          '</div>' +
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
    viewer, title, subtitle, records, activeNav,
    filter = 'all', sort = 'recent', query = '', showFilters = true
  } = ctx;

  const cards = records.map((r) => renderCard(r, viewer)).join('');

  const main = records.length
    ? '<div class="grid">' + cards + '</div>'
    : '<div class="empty">' +
        '<i class="fa-regular fa-folder-open"></i>' +
        '<h3>' + (query ? 'No files match your search' : 'No files yet') + '</h3>' +
        '<p>' + (query ? 'Try a different keyword or clear the filters.' : 'Upload your first file to see it appear here.') + '</p>' +
        '<a class="btn btn-primary" href="/upload"><i class="fa-solid fa-cloud-arrow-up"></i>Upload File</a>' +
      '</div>';

  const chips = showFilters
    ? '<div class="chips">' +
        '<a class="chip' + (filter === 'all' ? ' active' : '') + '" href="/?filter=all&sort=' + encodeURIComponent(sort) + '&q=' + encodeURIComponent(query) + '"><i class="fa-solid fa-layer-group"></i>All</a>' +
        '<a class="chip' + (filter === 'mine' ? ' active' : '') + '" href="/?filter=mine&sort=' + encodeURIComponent(sort) + '&q=' + encodeURIComponent(query) + '"><i class="fa-regular fa-user"></i>Mine</a>' +
        '<a class="chip' + (filter === 'subscribed' ? ' active' : '') + '" href="/?filter=subscribed&sort=' + encodeURIComponent(sort) + '&q=' + encodeURIComponent(query) + '"><i class="fa-solid fa-user-check"></i>Following</a>' +
        '<a class="chip' + (filter === 'public' ? ' active' : '') + '" href="/?filter=public&sort=' + encodeURIComponent(sort) + '&q=' + encodeURIComponent(query) + '"><i class="fa-solid fa-globe"></i>Public</a>' +
      '</div>'
    : '';

  const toolbar = '' +
    '<form class="toolbar" method="GET" action="' + (activeNav === 'gallery' ? '/gallery' : '/') + '">' +
      '<input class="input" type="text" name="q" placeholder="Search by chapter, subject, writer, or @user..." value="' + escapeHtml(query) + '">' +
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

  const body = '' +
    renderTopNav(viewer, activeNav) +
    '<div class="container">' +
      '<div class="banner">' +
        '<div class="user-info">' +
          '<div class="avatar">' + escapeHtml((viewer.name || viewer.username || '?').trim().charAt(0).toUpperCase() || '?') + '</div>' +
          '<div>' +
            '<div class="user-name">' + escapeHtml(title) + '</div>' +
            '<div class="user-meta">' + escapeHtml(subtitle) + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="actions row">' +
          '<a class="btn btn-primary" href="/upload"><i class="fa-solid fa-cloud-arrow-up"></i>Upload File</a>' +
          '<a class="btn btn-outline" href="/gallery"><i class="fa-solid fa-compass"></i>Gallery</a>' +
        '</div>' +
      '</div>' +
      toolbar +
      '<div class="section-head">' +
        '<h2>Files</h2>' +
        '<span class="count">' + records.length + ' file' + (records.length === 1 ? '' : 's') + '</span>' +
      '</div>' +
      main +
    '</div>';
  return layout('Dashboard · BiologyNotes', body);
}

function renderHome(ctx) {
  const { user, records, notice = '', filter = 'all', sort = 'recent', query = '' } = ctx;
  const subs = user.subscribers ? user.subscribers.length : 0;
  const subtitle = '@' + user.username + ' · ' + user.email + ' · ' + subs + ' subscriber' + (subs === 1 ? '' : 's');
  const noticeHtml = notice
    ? '<div class="alert alert-success"><i class="fa-solid fa-circle-check"></i><span>' + escapeHtml(notice) + '</span></div>'
    : '';
  const page = renderListing({
    viewer: user, title: user.name, subtitle, records,
    activeNav: 'dashboard', filter, sort, query, showFilters: true
  });
  if (!notice) return page;
  return page.replace('<div class="container">', '<div class="container">' + noticeHtml);
}

function renderGallery(ctx) {
  const { user, records, filter = 'public', sort = 'recent', query = '' } = ctx;
  return renderListing({
    viewer: user, title: 'Public Gallery',
    subtitle: 'Browse every public file shared across BiologyNotes.',
    records, activeNav: 'gallery', filter, sort, query, showFilters: false
  });
}

/* ------------------------------------------------------------------ *
 * Upload page
 * ------------------------------------------------------------------ */

function renderUpload(ctx) {
  const { user, error = '', values = {} } = ctx;
  const visibility = values.visibility === 'private' ? 'private' : 'public';

  const body = '' +
    renderTopNav(user, 'upload') +
    '<div class="container">' +
      '<div class="banner">' +
        '<div class="user-info">' +
          '<div class="avatar">' + escapeHtml((user.name || user.username || '?').trim().charAt(0).toUpperCase() || '?') + '</div>' +
          '<div>' +
            '<div class="user-name">' + escapeHtml(user.name) + '</div>' +
            '<div class="user-meta">@' + escapeHtml(user.username) + ' · ' + escapeHtml(user.email) + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="actions row">' +
          '<a class="btn btn-outline" href="/"><i class="fa-solid fa-arrow-left"></i>Back to dashboard</a>' +
          '<a class="btn btn-ghost" href="/logout"><i class="fa-solid fa-right-from-bracket"></i>Logout</a>' +
        '</div>' +
      '</div>' +

      '<div class="card">' +
        '<div class="upload-header">' +
          '<div>' +
            '<div class="eyebrow">New upload</div>' +
            '<h1>Publish a file</h1>' +
            '<p class="sub" style="margin:6px 0 0">Attach a chapter document and describe it. Maximum file size is 100 MB.</p>' +
          '</div>' +
        '</div>' +

        (error ? '<div class="alert alert-error"><i class="fa-solid fa-circle-exclamation"></i><span>' + escapeHtml(error) + '</span></div>' : '') +

        '<form method="POST" action="/upload" enctype="multipart/form-data" id="upload-form">' +
          '<div class="field">' +
            '<label class="label" for="f-file">File</label>' +
            '<div class="dropzone" id="dropzone" tabindex="0" role="button" aria-label="Upload a file">' +
              '<input type="file" id="f-file" name="file" required aria-label="Choose a file">' +
              '<div class="dropzone-inner" id="dropzone-default">' +
                '<div class="dropzone-icon"><i class="fa-solid fa-cloud-arrow-up"></i></div>' +
                '<div class="dropzone-title">Drag &amp; drop your file here, or <span class="browse">browse</span></div>' +
                '<div class="dropzone-hint">Any file type &middot; <strong>up to 100 MB</strong></div>' +
              '</div>' +
              '<div class="file-chip" id="dropzone-selected" style="display:none">' +
                '<div class="file-chip-icon" id="chip-icon"><i class="fa-regular fa-file"></i></div>' +
                '<div class="file-chip-body">' +
                  '<div class="file-chip-name" id="chip-name">filename.ext</div>' +
                  '<div class="file-chip-meta">' +
                    '<span id="chip-size">0 B</span>' +
                    '<span class="dot"></span>' +
                    '<span id="chip-type">file</span>' +
                  '</div>' +
                '</div>' +
                '<button type="button" class="file-chip-remove" id="chip-remove" title="Remove file"><i class="fa-solid fa-xmark"></i></button>' +
              '</div>' +
              '<div class="progress" id="progress"><div class="progress-bar" id="progress-bar"></div></div>' +
            '</div>' +
          '</div>' +

          '<div class="form-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:0 16px">' +
            '<div class="field"><label class="label" for="f-chapterNo">Chapter No</label>' +
              '<input class="input" id="f-chapterNo" name="chapterNo" type="number" min="0" step="1" value="' + escapeHtml(values.chapterNo || '') + '" placeholder="1" required></div>' +
            '<div class="field"><label class="label" for="f-chapterName">Chapter Name</label>' +
              '<input class="input" id="f-chapterName" name="chapterName" type="text" value="' + escapeHtml(values.chapterName || '') + '" placeholder="Introduction to Algebra" required></div>' +
            '<div class="field"><label class="label" for="f-subject">Subject</label>' +
              '<input class="input" id="f-subject" name="subject" type="text" value="' + escapeHtml(values.subject || '') + '" placeholder="Mathematics" required></div>' +
            '<div class="field"><label class="label" for="f-writer">Writer</label>' +
              '<input class="input" id="f-writer" name="writer" type="text" value="' + escapeHtml(values.writer || '') + '" placeholder="John Smith" required></div>' +
          '</div>' +

          '<div class="field">' +
            '<label class="label" for="f-description">Description</label>' +
            '<textarea class="textarea" id="f-description" name="description" placeholder="Short summary of the chapter contents...">' + escapeHtml(values.description || '') + '</textarea>' +
          '</div>' +

          '<div class="field">' +
            '<label class="label" for="f-visibility">Visibility</label>' +
            '<select class="select" id="f-visibility" name="visibility">' +
              '<option value="public"' + (visibility === 'public' ? ' selected' : '') + '>Public — visible to everyone</option>' +
              '<option value="private"' + (visibility === 'private' ? ' selected' : '') + '>Private — visible only to you</option>' +
            '</select>' +
          '</div>' +

          '<div class="form-actions" style="display:flex;gap:10px;align-items:center;margin-top:8px;flex-wrap:wrap">' +
            '<button type="submit" class="btn btn-primary btn-lg" id="submit-btn"><i class="fa-solid fa-cloud-arrow-up"></i>Upload file</button>' +
            '<a class="btn btn-outline btn-lg" href="/">Cancel</a>' +
          '</div>' +
        '</form>' +
      '</div>' +
    '</div>' +

    '<script>' +
    '(function(){' +
      'var dz=document.getElementById("dropzone");' +
      'var input=document.getElementById("f-file");' +
      'var def=document.getElementById("dropzone-default");' +
      'var sel=document.getElementById("dropzone-selected");' +
      'var iconEl=document.getElementById("chip-icon");' +
      'var nameEl=document.getElementById("chip-name");' +
      'var sizeEl=document.getElementById("chip-size");' +
      'var typeEl=document.getElementById("chip-type");' +
      'var rm=document.getElementById("chip-remove");' +
      'var prog=document.getElementById("progress");' +
      'var bar=document.getElementById("progress-bar");' +
      'var form=document.getElementById("upload-form");' +
      'if(!dz||!input)return;' +
      'function fmt(b){if(!b&&b!==0)return "0 B";var u=["B","KB","MB","GB"],i=Math.min(Math.floor(Math.log(b)/Math.log(1024)),u.length-1);var v=b/Math.pow(1024,i);return v.toFixed(i===0?0:1)+" "+u[i];}' +
      'function iconFor(name,mime){var ext=(name.split(".").pop()||"").toLowerCase();var m=(mime||"").toLowerCase();if(m.indexOf("image/")===0)return ["fa-regular fa-image","Image"];if(m.indexOf("video/")===0)return ["fa-solid fa-video","Video"];if(m.indexOf("audio/")===0)return ["fa-solid fa-music","Audio"];if(m==="application/pdf"||ext==="pdf")return ["fa-regular fa-file-pdf","PDF"];if(m.indexOf("text/")===0||["txt","md","csv","json","js","ts","html","css","xml","yml","yaml"].indexOf(ext)>=0)return ["fa-regular fa-file-lines","Text"];return ["fa-regular fa-file","File"];}' +
      'function showFile(f){if(!f){def.style.display="";sel.style.display="none";dz.classList.remove("has-file");return;}var info=iconFor(f.name,f.type);iconEl.innerHTML=\'<i class="\'+info[0]+\'"></i>\';nameEl.textContent=f.name;sizeEl.textContent=fmt(f.size);typeEl.textContent=info[1];def.style.display="none";sel.style.display="flex";dz.classList.add("has-file");}' +
      'function clearFile(){input.value="";showFile(null);}' +
      'input.addEventListener("change",function(){showFile(input.files&&input.files[0]);});' +
      'rm.addEventListener("click",function(e){e.stopPropagation();e.preventDefault();clearFile();});' +
      '["dragenter","dragover"].forEach(function(ev){dz.addEventListener(ev,function(e){e.preventDefault();e.stopPropagation();dz.classList.add("dragover");});});' +
      '["dragleave","drop"].forEach(function(ev){dz.addEventListener(ev,function(e){e.preventDefault();e.stopPropagation();dz.classList.remove("dragover");});});' +
      'dz.addEventListener("drop",function(e){e.preventDefault();var dt=e.dataTransfer;if(!dt||!dt.files||!dt.files.length)return;try{var d=new DataTransfer();for(var i=0;i<dt.files.length;i++)d.items.add(dt.files[i]);input.files=d.files;}catch(err){}showFile(dt.files[0]);});' +
      'dz.addEventListener("click",function(e){if(e.target===input)return;if(rm.contains(e.target))return;input.click();});' +
      'form.addEventListener("submit",function(){var f=input.files&&input.files[0];if(!f)return;prog.classList.add("on");bar.style.width="8%";var t=setInterval(function(){var w=parseFloat(bar.style.width)||0;if(w<92){bar.style.width=(w+Math.random()*7)+"%";}else{clearInterval(t);}},180);var btn=document.getElementById("submit-btn");if(btn){btn.disabled=true;btn.innerHTML=\'<i class="fa-solid fa-circle-notch fa-spin"></i>Uploading...\';}});' +
    '})();' +
    '</script>';

  return layout('Upload · BiologyNotes', body);
}

/* ------------------------------------------------------------------ *
 * Share card (no print button)
 * ------------------------------------------------------------------ */

function renderShareCard() {
  return '' +
    '<div class="share-card">' +
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
 * File detail page
 * ------------------------------------------------------------------ */

function renderFileDetail(ctx) {
  const { user, record, owner, notice = '', error = '' } = ctx;
  const kind = fileKind(record.mimeType, record.originalName);
  const fid = String(record._id);
  const src = record.fileUrl;
  const avg = averageRating(record);
  const ratingCount = record.ratings.length;
  const myRating = userRating(record, user._id);
  const ownerId = owner ? String(owner._id) : String(record.owner);
  const viewerId = String(user._id);
  const subscribed = ownerId !== viewerId && isSubscribed(user, ownerId);
  const isSelf = ownerId === viewerId;

  // Build preview + choose container class.
  let preview;
  let previewExtraClass = '';

  if (kind === 'image') {
    preview = '<img src="' + escapeHtml(src) + '" alt="' + escapeHtml(record.chapterName) + '">';
  } else if (kind === 'video') {
    preview = '<video src="' + escapeHtml(src) + '" controls preload="metadata"></video>';
  } else if (kind === 'audio') {
    preview = '<audio src="' + escapeHtml(src) + '" controls preload="metadata"></audio>';
  } else if (kind === 'pdf') {
    previewExtraClass = ' detail-preview-light';
    preview = '<iframe src="' + escapeHtml(src) + '" title="PDF preview"></iframe>';
  } else {
    // Raw docs / text / unknown — light grid + centered A4 sheet.
    previewExtraClass = ' detail-preview-light';
    const thumbUrl = record.thumbnailUrl || buildA4ThumbnailUrl(record);
    const inner = thumbUrl
      ? '<img src="' + escapeHtml(thumbUrl) + '" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover" onerror="this.style.display=\'none\'">'
      : '';
    preview = '<div class="detail-a4-wrap"><div class="detail-a4">' +
      '<div class="a4-fallback">' +
        '<i class="' + kindIconClass(kind) + '"></i>' +
        '<div class="ext-badge">' + escapeHtml(fileExtUpper(record.originalName)) + '</div>' +
        '<div class="lines"><span></span><span></span><span></span><span></span></div>' +
      '</div>' +
      inner +
    '</div></div>';
  }

  let stars = '';
  for (let i = 1; i <= 5; i++) {
    stars += '<button type="button" class="star-btn' + (myRating >= i ? ' on' : '') + '" data-value="' + i + '" aria-label="Rate ' + i + ' star' + (i > 1 ? 's' : '') + '">' +
      '<i class="' + (myRating >= i ? 'fa-solid' : 'fa-regular') + ' fa-star"></i>' +
    '</button>';
  }

  const ownerSubscribers = owner && owner.subscribers ? owner.subscribers.length : 0;
  const ownerPublicFiles = ctx.ownerPublicFiles || 0;

  const subscribeBtn = (!isSelf && owner)
    ? '<form method="POST" action="/users/' + ownerId + '/subscribe" class="inline-form" style="width:100%">' +
        '<button type="submit" class="btn ' + (subscribed ? 'btn-outline' : 'btn-primary') + ' btn-block">' +
          (subscribed
            ? '<i class="fa-solid fa-user-check"></i>Subscribed'
            : '<i class="fa-solid fa-user-plus"></i>Subscribe') +
        '</button></form>'
    : (isSelf ? '<a class="btn btn-outline btn-block" href="/users/' + encodeURIComponent(user.username) + '"><i class="fa-regular fa-user"></i>View my profile</a>' : '');

  const deleteBtn = isSelf
    ? '<form method="POST" action="/files/' + encodeURIComponent(fid) + '/delete" class="inline-form" onsubmit="return confirm(\'Delete this file permanently? This cannot be undone.\');">' +
        '<button type="submit" class="btn btn-danger btn-xs"><i class="fa-solid fa-trash-can"></i>Delete</button>' +
      '</form>'
    : '';

  const sideThumbHtml =
    '<div class="a4-thumb-card">' +
      '<div class="a4-thumb-card-head"><i class="fa-solid fa-file-image"></i>A4 Preview</div>' +
      '<div class="a4-thumb-card-body">' +
        '<div class="a4-thumb">' + renderA4ThumbInner(record, kind) + '</div>' +
      '</div>' +
    '</div>';

  const ratingBlock = '' +
    '<div class="rating-block" id="rating-block" data-file-id="' + escapeHtml(fid) + '">' +
      '<div class="rating-head">' +
        '<div class="rating-avg" id="rating-avg">' + avg.toFixed(1) + '</div>' +
        '<div>' +
          '<div class="rating-stars" id="rating-stars">' + renderStars(avg, 15) + '</div>' +
          '<div class="rating-count"><span id="rating-count">' + ratingCount + '</span> rating' + (ratingCount === 1 ? '' : 's') + '</div>' +
        '</div>' +
      '</div>' +
      '<div>' +
        '<div class="label" style="margin-bottom:4px">Your rating</div>' +
        '<div class="rating-input" id="rating-input" data-current="' + myRating + '">' + stars + '</div>' +
        '<div class="rating-hint" id="rating-hint">' + (myRating ? 'You rated ' + myRating + ' star' + (myRating > 1 ? 's' : '') + '.' : 'Click a star to rate this file.') + '</div>' +
      '</div>' +
    '</div>';

  const body = '' +
    renderTopNav(user, '') +
    '<div class="container">' +
      '<div class="flex-between" style="margin-bottom:16px">' +
        '<a class="btn btn-ghost btn-xs" href="' + (record.visibility === 'public' ? '/gallery' : '/') + '"><i class="fa-solid fa-arrow-left"></i>Back</a>' +
        '<div class="row">' +
          deleteBtn +
          '<a class="btn btn-primary btn-xs" href="/files/' + encodeURIComponent(fid) + '/download"><i class="fa-solid fa-download"></i>Download</a>' +
        '</div>' +
      '</div>' +

      (notice ? '<div class="alert alert-success"><i class="fa-solid fa-circle-check"></i><span>' + escapeHtml(notice) + '</span></div>' : '') +
      (error ? '<div class="alert alert-error"><i class="fa-solid fa-circle-exclamation"></i><span>' + escapeHtml(error) + '</span></div>' : '') +

      '<div class="detail-grid">' +
        '<div>' +
          '<div class="detail-preview' + previewExtraClass + '">' + preview + '</div>' +
          '<div class="card" style="margin-top:16px">' +
            '<div class="file-top" style="margin-bottom:10px">' +
              '<span class="badge badge-dark"><i class="fa-solid fa-bookmark"></i>Chapter ' + escapeHtml(record.chapterNo) + '</span>' +
              '<span class="badge badge-type"><i class="' + kindIconClass(kind) + '"></i>' + kindLabel(kind) + '</span>' +
              '<span class="badge"><i class="fa-solid fa-eye"></i>' + escapeHtml(record.visibility.toUpperCase()) + '</span>' +
            '</div>' +
            '<h1 style="font-size:26px">' + escapeHtml(record.chapterName) + '</h1>' +
            '<p class="sub" style="margin:6px 0 16px"><i class="fa-solid fa-tag"></i> ' + escapeHtml(record.subject) + ' &middot; <i class="fa-solid fa-pen-nib"></i> ' + escapeHtml(record.writer) + '</p>' +
            (record.description ? '<p style="color:#3f3f46;white-space:pre-wrap">' + escapeHtml(record.description) + '</p>' : '<p class="text-muted">No description provided.</p>') +
            '<div class="meta-grid">' +
              '<div class="meta-item"><span class="k">File name</span><span class="v">' + escapeHtml(record.originalName) + '</span></div>' +
              '<div class="meta-item"><span class="k">Type</span><span class="v">' + escapeHtml(record.mimeType || kindLabel(kind)) + '</span></div>' +
              '<div class="meta-item"><span class="k">Size</span><span class="v">' + escapeHtml(formatBytes(record.size)) + '</span></div>' +
              '<div class="meta-item"><span class="k">Uploaded</span><span class="v">' + escapeHtml(formatDate(record.createdAt)) + '</span></div>' +
              '<div class="meta-item"><span class="k">Downloads</span><span class="v">' + (record.downloads || 0) + '</span></div>' +
              '<div class="meta-item"><span class="k">Views</span><span class="v">' + (record.views || 0) + '</span></div>' +
            '</div>' +
          '</div>' +
        '</div>' +

        '<aside>' +
          sideThumbHtml +
          '<div style="height:14px"></div>' +
          renderShareCard() +
          '<div style="height:14px"></div>' +
          ratingBlock +
          '<div style="height:14px"></div>' +
          '<div class="uploader-card">' +
            '<div class="uploader-row">' +
              '<div class="avatar">' + escapeHtml((owner ? owner.name : record.ownerUsername).trim().charAt(0).toUpperCase() || '?') + '</div>' +
              '<div class="uploader-meta">' +
                '<div class="name">' + escapeHtml(owner ? owner.name : record.ownerUsername) + '</div>' +
                '<a class="handle" href="/users/' + encodeURIComponent(record.ownerUsername) + '">@' + escapeHtml(record.ownerUsername) + '</a>' +
              '</div>' +
            '</div>' +
            '<div class="uploader-stats">' +
              '<span><i class="fa-solid fa-user-group"></i>' + ownerSubscribers + ' subscriber' + (ownerSubscribers === 1 ? '' : 's') + '</span>' +
              '<span><i class="fa-regular fa-file"></i>' + ownerPublicFiles + ' public file' + (ownerPublicFiles === 1 ? '' : 's') + '</span>' +
            '</div>' +
            subscribeBtn +
          '</div>' +
        '</aside>' +
      '</div>' +
    '</div>' +

    // Rating widget script
    '<script>(function(){' +
      'var block=document.getElementById("rating-block");if(!block)return;' +
      'var fileId=block.getAttribute("data-file-id");' +
      'var input=document.getElementById("rating-input");' +
      'var hint=document.getElementById("rating-hint");' +
      'var avgEl=document.getElementById("rating-avg");' +
      'var cntEl=document.getElementById("rating-count");' +
      'var starsEl=document.getElementById("rating-stars");' +
      'function paintStars(n){var out="";for(var i=1;i<=5;i++){var on=i<=Math.round(n);out+=\'<i class="\'+(on?"fa-solid":"fa-regular")+\' fa-star"></i>\';}return out;}' +
      'function paintInput(n){var btns=input.querySelectorAll(".star-btn");for(var i=0;i<btns.length;i++){var v=parseInt(btns[i].getAttribute("data-value"),10);var on=v<=n;btns[i].classList.toggle("on",on);btns[i].innerHTML=\'<i class="\'+(on?"fa-solid":"fa-regular")+\' fa-star"></i>\';}}' +
      'function setBusy(b){var btns=input.querySelectorAll(".star-btn");for(var i=0;i<btns.length;i++)btns[i].disabled=b;}' +
      'input.addEventListener("click",function(e){var b=e.target.closest(".star-btn");if(!b)return;var v=parseInt(b.getAttribute("data-value"),10);setBusy(true);' +
        'fetch("/files/"+encodeURIComponent(fileId)+"/rate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({value:v}),credentials:"same-origin"})' +
        '.then(function(r){return r.ok?r.json():Promise.reject(r);})' +
        '.then(function(d){paintInput(v);starsEl.innerHTML=paintStars(d.average);avgEl.textContent=d.average.toFixed(1);cntEl.textContent=d.count;hint.textContent="You rated "+v+" star"+(v>1?"s":"")+".";})' +
        '.catch(function(){hint.textContent="Could not save your rating. Please try again.";})' +
        '.then(function(){setBusy(false);});' +
      '});' +
    '})();</script>' +

    // Share script (print removed)
    '<script>(function(){' +
      'var buttons=document.querySelectorAll("[data-share]");if(!buttons.length)return;' +
      'var pageUrl=window.location.href;' +
      'var pageTitle=document.title;' +
      'var shareText=pageTitle+" — shared from BiologyNotes";' +
      'function copyFallback(text){' +
        'var ta=document.createElement("textarea");ta.value=text;ta.setAttribute("readonly","");ta.style.position="absolute";ta.style.left="-9999px";document.body.appendChild(ta);ta.select();' +
        'try{document.execCommand("copy");}catch(e){}' +
        'document.body.removeChild(ta);' +
      '}' +
      'buttons.forEach(function(btn){' +
        'btn.addEventListener("click",function(e){' +
          'e.preventDefault();' +
          'var type=btn.getAttribute("data-share");' +
          'var url="";' +
          'switch(type){' +
            'case "whatsapp":url="https://wa.me/?text="+encodeURIComponent(shareText+" "+pageUrl);break;' +
            'case "facebook":url="https://www.facebook.com/sharer/sharer.php?u="+encodeURIComponent(pageUrl);break;' +
            'case "twitter":url="https://twitter.com/intent/tweet?text="+encodeURIComponent(shareText)+"&url="+encodeURIComponent(pageUrl);break;' +
            'case "linkedin":url="https://www.linkedin.com/sharing/share-offsite/?url="+encodeURIComponent(pageUrl);break;' +
            'case "telegram":url="https://t.me/share/url?url="+encodeURIComponent(pageUrl)+"&text="+encodeURIComponent(shareText);break;' +
            'case "reddit":url="https://www.reddit.com/submit?url="+encodeURIComponent(pageUrl)+"&title="+encodeURIComponent(pageTitle);break;' +
            'case "email":url="mailto:?subject="+encodeURIComponent(pageTitle)+"&body="+encodeURIComponent("Check this out on BiologyNotes:\\n\\n"+pageUrl);break;' +
            'case "copy":' +
              'var original=btn.innerHTML;' +
              'var done=function(){btn.classList.add("copied");btn.innerHTML=\'<i class="fa-solid fa-check"></i>\';setTimeout(function(){btn.classList.remove("copied");btn.innerHTML=original;},1500);};' +
              'if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(pageUrl).then(done).catch(function(){copyFallback(pageUrl);done();});}' +
              'else{copyFallback(pageUrl);done();}' +
              'return;' +
          '}' +
          'if(url)window.open(url,"_blank","noopener,noreferrer,width=640,height=640");' +
        '});' +
      '});' +
    '})();</script>';

  return layout(record.chapterName + ' · BiologyNotes', body);
}

/* ------------------------------------------------------------------ *
 * User profile page
 * ------------------------------------------------------------------ */

function renderUserProfile(ctx) {
  const { viewer, profileUser, records, subscribed, isSelf } = ctx;
  const initial = (profileUser.name || profileUser.username || '?').trim().charAt(0).toUpperCase() || '?';
  const subscriberCount = profileUser.subscribers ? profileUser.subscribers.length : 0;
  const followingCount = profileUser.subscribedTo ? profileUser.subscribedTo.length : 0;

  const subscribeBtn = !isSelf
    ? '<form method="POST" action="/users/' + String(profileUser._id) + '/subscribe" class="inline-form">' +
        '<button type="submit" class="btn ' + (subscribed ? 'btn-outline' : 'btn-primary') + '">' +
          (subscribed
            ? '<i class="fa-solid fa-user-check"></i>Subscribed'
            : '<i class="fa-solid fa-user-plus"></i>Subscribe') +
        '</button></form>'
    : '<span class="badge badge-dark"><i class="fa-regular fa-user"></i>This is you</span>';

  const cards = records.map((r) => renderCard(r, viewer)).join('');
  const main = records.length
    ? '<div class="grid">' + cards + '</div>'
    : '<div class="empty"><i class="fa-regular fa-folder-open"></i><h3>No public files yet</h3><p>This user has not shared anything publicly.</p></div>';

  const body = '' +
    renderTopNav(viewer, '') +
    '<div class="container">' +
      '<div class="banner">' +
        '<div class="user-info">' +
          '<div class="avatar">' + escapeHtml(initial) + '</div>' +
          '<div>' +
            '<div class="user-name">' + escapeHtml(profileUser.name) + '</div>' +
            '<div class="user-meta">@' + escapeHtml(profileUser.username) + ' · ' + subscriberCount + ' subscriber' + (subscriberCount === 1 ? '' : 's') + ' · ' + followingCount + ' following</div>' +
          '</div>' +
        '</div>' +
        '<div class="actions">' + subscribeBtn + '</div>' +
      '</div>' +
      '<div class="section-head">' +
        '<h2>Public files</h2>' +
        '<span class="count">' + records.length + ' file' + (records.length === 1 ? '' : 's') + '</span>' +
      '</div>' +
      main +
    '</div>';
  return layout(profileUser.name + ' · BiologyNotes', body);
}

function renderErrorPage(status, title, message) {
  const body = '' +
    renderTopNav(null, '') +
    '<div class="container-narrow">' +
      brandMark() +
      '<div class="card error-page">' +
        '<h1>' + escapeHtml(status) + '</h1>' +
        '<p>' + escapeHtml(message || title) + '</p>' +
        '<a class="btn btn-primary" href="/"><i class="fa-solid fa-house"></i>Back to home</a>' +
      '</div>' +
    '</div>';
  return layout(status + ' · ' + title, body);
}

/* ------------------------------------------------------------------ *
 * Express app + middleware
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
  store: MongoStore.create({
    mongoUrl: MONGO_URI,
    collectionName: 'sessions',
    ttl: 60 * 60 * 24 * 7,
    autoRemove: 'native',
    touchAfter: 24 * 3600
  }),
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: 'auto',
    maxAge: 1000 * 60 * 60 * 8
  }
}));

app.use(async (req, res, next) => {
  req.user = null;
  if (req.session && req.session.userId) {
    try {
      const u = await User.findById(req.session.userId)
        .select('name email username subscribers subscribedTo')
        .lean();
      if (u) req.user = u;
      else req.session.userId = null;
    } catch (err) {
      req.user = null;
    }
  }
  next();
});

function requireAuth(req, res, next) {
  if (req.user) return next();
  if (req.session && req.session.registered) return res.redirect('/login');
  return res.redirect('/register');
}

/* ------------------------------------------------------------------ *
 * Multer — memory storage → Cloudinary
 * ------------------------------------------------------------------ */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: 1 }
});

function uploadSingle(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    let message = 'Upload failed. Please try again.';
    if (err.code === 'LIMIT_FILE_SIZE') message = 'File is too large. The maximum allowed size is 100 MB.';
    else if (err.code === 'LIMIT_UNEXPECTED_FILE') message = 'Unexpected file field. Use the provided input.';
    else if (err.code === 'LIMIT_FILE_COUNT') message = 'Only one file can be uploaded at a time.';

    if (!req.user) return res.redirect('/login');
    return res.status(400).send(renderUpload({
      user: req.user,
      error: message,
      values: req.body || {}
    }));
  });
}

/* ------------------------------------------------------------------ *
 * Routes — home / gallery
 * ------------------------------------------------------------------ */

app.get('/', requireAuth, async (req, res, next) => {
  try {
    const user = req.user;
    const filter = typeof req.query.filter === 'string' ? req.query.filter : 'all';
    const sort = typeof req.query.sort === 'string' ? req.query.sort : 'recent';
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';

    const q = {};
    if (filter === 'mine') {
      q.owner = user._id;
    } else if (filter === 'subscribed') {
      q.visibility = 'public';
      q.owner = { $in: (user.subscribedTo || []).map((id) => id) };
    } else if (filter === 'public') {
      q.visibility = 'public';
    } else {
      q.$or = [{ visibility: 'public' }, { owner: user._id }];
    }

    if (query) {
      const rx = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      q.$and = (q.$and || []).concat([{
        $or: [
          { chapterName: rx }, { subject: rx }, { writer: rx },
          { description: rx }, { ownerUsername: rx }
        ]
      }]);
    }

    let sortSpec = { createdAt: -1 };
    if (sort === 'downloads') sortSpec = { downloads: -1, createdAt: -1 };
    else if (sort === 'name') sortSpec = { chapterName: 1 };

    let records = await File.find(q)
      .populate('owner', 'name username')
      .sort(sortSpec)
      .limit(300)
      .lean();

    if (sort === 'rating') records = records.sort((a, b) => averageRating(b) - averageRating(a));

    let notice = '';
    if (req.query.upload === 'success') notice = 'Your file was uploaded successfully.';
    else if (req.query.deleted === 'success') notice = 'The file was deleted successfully.';

    res.send(renderHome({ user, records, notice, filter, sort, query }));
  } catch (err) { next(err); }
});

app.get('/gallery', requireAuth, async (req, res, next) => {
  try {
    const user = req.user;
    const sort = typeof req.query.sort === 'string' ? req.query.sort : 'recent';
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';

    const q = { visibility: 'public' };

    if (query) {
      const rx = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      q.$or = [
        { chapterName: rx }, { subject: rx }, { writer: rx },
        { description: rx }, { ownerUsername: rx }
      ];
    }

    let sortSpec = { createdAt: -1 };
    if (sort === 'downloads') sortSpec = { downloads: -1, createdAt: -1 };
    else if (sort === 'name') sortSpec = { chapterName: 1 };

    let records = await File.find(q)
      .populate('owner', 'name username')
      .sort(sortSpec)
      .limit(300)
      .lean();

    if (sort === 'rating') records = records.sort((a, b) => averageRating(b) - averageRating(a));

    res.send(renderGallery({ user, records, sort, query }));
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------------ *
 * Routes — auth
 * ------------------------------------------------------------------ */

app.get('/register', (req, res) => {
  if (req.user) return res.redirect('/');
  res.send(renderRegister({}));
});

app.post('/register', async (req, res, next) => {
  try {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const values = { name, email, username };

    if (!name || !email || !username || !password) {
      return res.status(400).send(renderRegister({ error: 'All fields are required.', values }));
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).send(renderRegister({ error: 'Please enter a valid email address.', values }));
    }
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      return res.status(400).send(renderRegister({ error: 'Username must be 3–20 characters and contain only letters, numbers, or underscores.', values }));
    }
    if (password.length < 6) {
      return res.status(400).send(renderRegister({ error: 'Password must be at least 6 characters long.', values }));
    }

    const dupe = await User.findOne({
      $or: [
        { username: new RegExp('^' + username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') },
        { email }
      ]
    }).lean();

    if (dupe) {
      const msg = String(dupe.username).toLowerCase() === username.toLowerCase()
        ? 'That username is already taken.'
        : 'That email address is already registered.';
      return res.status(409).send(renderRegister({ error: msg, values }));
    }

    await User.create({
      name, email, username,
      passwordHash: hashPassword(password)
    });

    req.session.registered = true;
    req.session.save((err) => {
      if (err) console.error('[biologynotes] register save error:', err);
      return res.redirect('/login');
    });
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(409).send(renderRegister({
        error: 'That username or email is already registered.',
        values: req.body || {}
      }));
    }
    next(err);
  }
});

app.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.send(renderLogin({}));
});

app.post('/login', async (req, res, next) => {
  try {
    const body = req.body || {};
    const username = String(body.username || '').trim();
    const password = String(body.password || '');

    if (!username || !password) {
      return res.status(400).send(renderLogin({ error: 'Username and password are required.', values: { username } }));
    }

    const user = await User.findOne({
      username: new RegExp('^' + username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i')
    });

    if (!user || !verifyPassword(password, user.passwordHash)) {
      return res.status(401).send(renderLogin({ error: 'Invalid username or password.', values: { username } }));
    }

    req.session.userId = String(user._id);
    req.session.registered = true;

    req.session.save((err) => {
      if (err) {
        console.error('[biologynotes] login save error:', err);
        return res.status(500).send(renderLogin({
          error: 'Something went wrong while signing you in. Please try again.',
          values: { username }
        }));
      }
      return res.redirect('/');
    });
  } catch (err) { next(err); }
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
 * Routes — upload (Cloudinary)
 * ------------------------------------------------------------------ */

app.get('/upload', requireAuth, (req, res) => {
  res.send(renderUpload({ user: req.user, values: {} }));
});

app.post('/upload', requireAuth, uploadSingle, async (req, res, next) => {
  try {
    const user = req.user;
    const body = req.body || {};
    const chapterNo = String(body.chapterNo || '').trim();
    const chapterName = String(body.chapterName || '').trim();
    const subject = String(body.subject || '').trim();
    const writer = String(body.writer || '').trim();
    const description = String(body.description || '').trim();
    const visibility = body.visibility === 'private' ? 'private' : 'public';
    const values = { chapterNo, chapterName, subject, writer, description, visibility };

    const fail = (message, status) => res.status(status).send(renderUpload({ user, error: message, values }));

    if (!req.file) return fail('Please choose a file to upload.', 400);
    if (!chapterNo || Number.isNaN(Number(chapterNo))) return fail('Chapter number is required and must be a valid number.', 400);
    if (!chapterName || !subject || !writer) return fail('Chapter name, subject, and writer are all required.', 400);
    if (chapterName.length > 200 || subject.length > 120 || writer.length > 120 || description.length > 2000) {
      return fail('One or more fields exceed the maximum allowed length.', 400);
    }
    if (req.file.size > MAX_FILE_SIZE) return fail('File is too large. The maximum allowed size is 100 MB.', 413);

    const result = await uploadBufferToCloudinary(req.file.buffer, req.file.originalname);

    const pseudoRecord = {
      mimeType: req.file.mimetype || 'application/octet-stream',
      originalName: normalizeOriginalName(req.file.originalname),
      storedName: result.public_id
    };
    const thumbnailUrl = buildA4ThumbnailUrl(pseudoRecord);

    await File.create({
      owner: user._id,
      ownerUsername: user.username,
      chapterNo, chapterName, subject, writer, description, visibility,
      originalName: pseudoRecord.originalName,
      storedName: result.public_id,
      fileUrl: result.secure_url,
      resourceType: result.resource_type || 'image',
      thumbnailUrl: thumbnailUrl || '',
      size: result.bytes || req.file.size,
      mimeType: pseudoRecord.mimeType
    });

    res.redirect('/?upload=success');
  } catch (err) {
    console.error('[biologynotes] Cloudinary upload failed:', err);
    next(err);
  }
});

/* ------------------------------------------------------------------ *
 * Routes — file detail / raw / download / rate / delete
 * ------------------------------------------------------------------ */

async function findAccessibleFile(req, id) {
  if (!isValidObjectId(id)) return { error: 'notfound' };
  const record = await File.findById(id).lean();
  if (!record) return { error: 'notfound' };
  if (record.visibility !== 'public' && String(record.owner) !== String(req.user._id)) {
    return { error: 'forbidden' };
  }
  return { record };
}

app.get('/files/:id', requireAuth, async (req, res, next) => {
  try {
    const result = await findAccessibleFile(req, req.params.id);
    if (result.error === 'notfound') return res.status(404).send(renderErrorPage(404, 'Not found', 'That file does not exist.'));
    if (result.error === 'forbidden') return res.status(403).send(renderErrorPage(403, 'Forbidden', 'You do not have access to this file.'));

    const record = await File.findByIdAndUpdate(
      result.record._id,
      { $inc: { views: 1 } },
      { new: true }
    ).lean();

    const owner = await User.findById(record.owner)
      .select('name username subscribers')
      .lean();

    const ownerPublicFiles = owner
      ? await File.countDocuments({ owner: owner._id, visibility: 'public' })
      : 0;

    const notice = req.query.rated === '1' ? 'Thanks for rating!' : '';
    res.send(renderFileDetail({ user: req.user, record, owner, ownerPublicFiles, notice }));
  } catch (err) { next(err); }
});

app.get('/files/:id/raw', requireAuth, async (req, res, next) => {
  try {
    const result = await findAccessibleFile(req, req.params.id);
    if (result.error === 'notfound') return res.status(404).send(renderErrorPage(404, 'Not found', 'That file does not exist.'));
    if (result.error === 'forbidden') return res.status(403).send(renderErrorPage(403, 'Forbidden', 'You do not have access to this file.'));
    return res.redirect(result.record.fileUrl);
  } catch (err) { next(err); }
});

app.get('/files/:id/download', requireAuth, async (req, res, next) => {
  try {
    const result = await findAccessibleFile(req, req.params.id);
    if (result.error === 'notfound') return res.status(404).send(renderErrorPage(404, 'Not found', 'That file does not exist.'));
    if (result.error === 'forbidden') return res.status(403).send(renderErrorPage(403, 'Forbidden', 'You do not have access to this file.'));

    await File.updateOne({ _id: result.record._id }, { $inc: { downloads: 1 } });

    const dl = buildCloudinaryDownloadUrl(
      result.record.fileUrl,
      result.record.originalName,
      result.record.mimeType
    );
    return res.redirect(dl);
  } catch (err) { next(err); }
});

app.post('/files/:id/delete', requireAuth, async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!isValidObjectId(id)) {
      return res.status(404).send(renderErrorPage(404, 'Not found', 'That file does not exist.'));
    }

    const record = await File.findById(id).lean();
    if (!record) {
      return res.status(404).send(renderErrorPage(404, 'Not found', 'That file does not exist.'));
    }
    if (String(record.owner) !== String(req.user._id)) {
      return res.status(403).send(renderErrorPage(403, 'Forbidden', 'You can only delete your own files.'));
    }

    const destroyResult = await deleteFromCloudinary(record.storedName, record.resourceType);
    if (!destroyResult.ok) {
      console.warn('[biologynotes] Cloudinary delete skipped/failed for', record.storedName, '-', destroyResult.error);
    }

    await File.deleteOne({ _id: record._id });

    return res.redirect('/?deleted=success');
  } catch (err) { next(err); }
});

app.post('/files/:id/rate', requireAuth, async (req, res, next) => {
  try {
    const result = await findAccessibleFile(req, req.params.id);
    if (result.error === 'notfound') return res.status(404).json({ error: 'notfound' });
    if (result.error === 'forbidden') return res.status(403).json({ error: 'forbidden' });

    const value = parseInt(req.body && req.body.value, 10);
    if (!Number.isInteger(value) || value < 1 || value > 5) {
      return res.status(400).json({ error: 'Rating must be an integer between 1 and 5.' });
    }

    const record = await File.findById(result.record._id);
    const uid = req.user._id;
    const existing = record.ratings.find((r) => String(r.user) === String(uid));
    if (existing) {
      existing.value = value;
      existing.createdAt = Date.now();
    } else {
      record.ratings.push({ user: uid, value, createdAt: Date.now() });
    }
    await record.save();

    const doc = record.toObject();
    return res.json({
      ok: true,
      average: averageRating(doc),
      count: doc.ratings.length,
      yourRating: value
    });
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------------ *
 * Routes — users & subscriptions
 * ------------------------------------------------------------------ */

app.get('/users/:username', requireAuth, async (req, res, next) => {
  try {
    const viewer = req.user;
    const profileUser = await User.findOne({
      username: new RegExp('^' + String(req.params.username).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i')
    }).lean();

    if (!profileUser) return res.status(404).send(renderErrorPage(404, 'Not found', 'That user does not exist.'));

    const isSelf = String(profileUser._id) === String(viewer._id);
    const q = { owner: profileUser._id };
    if (!isSelf) q.visibility = 'public';

    const records = await File.find(q)
      .populate('owner', 'name username')
      .sort({ createdAt: -1 })
      .limit(300)
      .lean();

    res.send(renderUserProfile({
      viewer,
      profileUser,
      records,
      subscribed: isSubscribed(viewer, profileUser._id),
      isSelf
    }));
  } catch (err) { next(err); }
});

app.post('/users/:id/subscribe', requireAuth, async (req, res, next) => {
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
      if (!me.subscribedTo.some((id) => String(id) === String(target._id))) {
        me.subscribedTo.push(target._id);
      }
    }

    await Promise.all([target.save(), me.save()]);
    res.redirect(safeBackUrl(req));
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------------ *
 * Fallbacks
 * ------------------------------------------------------------------ */

app.use((req, res) => {
  res.status(404).send(renderErrorPage(404, 'Not found', 'The page you requested could not be found.'));
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[biologynotes] Unhandled error:', err);
  if (res.headersSent) return;
  res.status(500).send(renderErrorPage(500, 'Server error', 'Something went wrong on our side.'));
});

/* ------------------------------------------------------------------ *
 * Start
 * ------------------------------------------------------------------ */

async function start() {
  try {
    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 30000,
      connectTimeoutMS: 30000,
      socketTimeoutMS: 45000,
      family: 4,
      maxPoolSize: 20,
      autoIndex: !IS_PROD
    });
    console.log('[biologynotes] Connected to MongoDB');

    const server = app.listen(PORT, () => {
      console.log('[biologynotes] Running at http://localhost:' + PORT);
      console.log('[biologynotes] Environment: ' + NODE_ENV);
      console.log('[biologynotes] Storage: Cloudinary (' + CLOUDINARY_CLOUD_NAME + ')');
      console.log('[biologynotes] A4 thumbnails: ' + A4_THUMB_W + 'x' + A4_THUMB_H);
      console.log('[biologynotes] Max upload size: ' + formatBytes(MAX_FILE_SIZE));
    });

    const shutdown = async (signal) => {
      console.log('\n[biologynotes] ' + signal + ' received. Shutting down...');
      server.close(async () => {
        try { await mongoose.connection.close(); } catch (e) {}
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 10000).unref();
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (err) {
    console.error('\n[biologynotes] Failed to connect to MongoDB.\n');
    console.error('Error:', err.message);
    console.error('\nCheck that (1) your Atlas cluster is not paused,');
    console.error('(2) your IP is whitelisted in Network Access,');
    console.error('(3) your DNS can resolve SRV records.\n');
    process.exit(1);
  }
}

start();

module.exports = app;
