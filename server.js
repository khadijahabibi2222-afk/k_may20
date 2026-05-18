'use strict';
const express    = require('express');
const path       = require('path');
const mongoose   = require('mongoose');
const multer     = require('multer');
const sharp      = require('sharp');
const compression = require('compression');
const fs         = require('fs');

const app = express();

// ── gzip compression برای همه پاسخ‌ها ──
app.use(compression({ level: 6 }));

// ── Static files با cache headers ──
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1d',
  etag: true,
  lastModified: true
}));
app.use(express.json({ limit: '1mb' }));

// ── آپلود فایل — uploads/ خارج از DB ──
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.memoryStorage(); // در memory نگه دار، سپس compress کن
const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 }, // 200 KB حداکثر
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg','image/png','image/webp','image/gif'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('فقط تصاویر (jpg/png/webp) مجاز است'));
  }
});

// ── MongoDB ──
const dbUrl = process.env.MONGODB_URI;
if (!dbUrl) { console.error('❌ MONGODB_URI تنظیم نشده!'); process.exit(1); }

const MONGO_OPTS = {
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
  connectTimeoutMS: 10000,
  maxPoolSize: 5,
  retryWrites: true,
  retryReads: true,
  heartbeatFrequencyMS: 10000,
};

async function connectWithRetry(attempt) {
  attempt = attempt || 1;
  try {
    await mongoose.connect(dbUrl, MONGO_OPTS);
    console.log('✅ MongoDB وصل شد (تلاش ' + attempt + ')');
  } catch (err) {
    console.error('❌ خطا (تلاش ' + attempt + '):', err.message);
    if (attempt < 5) {
      const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
      setTimeout(() => connectWithRetry(attempt + 1), delay);
    }
  }
}
connectWithRetry(1);

mongoose.connection.on('disconnected', () => {
  console.warn('⚠️ MongoDB قطع شد'); setTimeout(() => connectWithRetry(1), 5000);
});
mongoose.connection.on('reconnected', () => console.log('🔄 MongoDB وصل شد'));
mongoose.connection.on('error', err => console.error('❌ MongoDB:', err.message));

// ── Schemas با index ──
const storeSchema = new mongoose.Schema({
  key:       { type: String, required: true, unique: true, index: true },
  valueStr:  { type: String, required: true },
  updatedAt: { type: Date, default: Date.now, index: true }
});
// Compound index برای سریع‌ترین lookup
storeSchema.index({ key: 1, updatedAt: -1 });
const Store = mongoose.model('Store', storeSchema);

// Schema برای فایل‌های آپلود — فقط metadata در DB، فایل روی disk
const fileSchema = new mongoose.Schema({
  fileId:    { type: String, required: true, unique: true, index: true },
  filename:  String,
  mimetype:  String,
  size:      Number,
  refType:   { type: String, index: true },  // 'donation','logo','doc' etc.
  refId:     { type: String, index: true },
  createdAt: { type: Date, default: Date.now }
});
fileSchema.index({ refType: 1, refId: 1 });
const FileRef = mongoose.model('FileRef', fileSchema);

// ── DB helpers با lean() ──
async function dbGet(key) {
  const doc = await Store.findOne({ key }).lean().select('valueStr');
  if (!doc) return null;
  try { return JSON.parse(doc.valueStr); } catch { return null; }
}

async function dbSave(key, value) {
  const valueStr = JSON.stringify(value);
  const now = new Date();
  await Store.findOneAndUpdate(
    { key },
    { $set: { valueStr, updatedAt: now } },
    { upsert: true, new: true, lean: true }
  );
  return now.toISOString();
}

// ── Middleware ──
function requireDB(req, res, next) {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({
      ok: false,
      error: 'دیتابیس هنوز وصل نشده. چند ثانیه صبر کنید.',
      dbState: mongoose.connection.readyState
    });
  }
  next();
}

// ── API: Health ──
app.get('/api/health', (req, res) => {
  const state = mongoose.connection.readyState;
  const names = ['disconnected','connected','connecting','disconnecting'];
  res.json({
    ok: state === 1,
    mongoConnected: state === 1,
    mongoState: names[state] || 'unknown',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// ── API: Main DB ──
app.get('/api/db', requireDB, async (req, res) => {
  try {
    const data = await dbGet('mainDB');
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/db', requireDB, async (req, res) => {
  try {
    if (!req.body?.data) return res.status(400).json({ ok: false, error: 'no data' });
    // حذف base64 تصاویر قبل از ذخیره در DB (فایل‌ها جداگانه ذخیره می‌شوند)
    const data = JSON.parse(JSON.stringify(req.body.data));
    const savedAt = await dbSave('mainDB', data);
    res.json({ ok: true, lastSaved: savedAt });
  } catch (e) {
    console.error('❌ ذخیره:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── API: آپلود تصویر با sharp compress ──
app.post('/api/upload', requireDB, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'فایل ارسال نشد' });

    const fileId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const ext = '.webp';
    const filename = fileId + ext;
    const filePath = path.join(uploadsDir, filename);

    // Compress با sharp — WebP با کیفیت ۷۵
    await sharp(req.file.buffer)
      .resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 75 })
      .toFile(filePath);

    const stat = fs.statSync(filePath);

    // ذخیره metadata در DB
    await FileRef.create({
      fileId,
      filename,
      mimetype: 'image/webp',
      size: stat.size,
      refType: req.body.refType || 'general',
      refId: req.body.refId || '',
    });

    res.json({ ok: true, fileId, url: '/api/file/' + fileId });
  } catch (e) {
    if (e.message && e.message.includes('too large')) {
      return res.status(413).json({ ok: false, error: 'حجم فایل بیش از ۲۰۰KB است' });
    }
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── API: دریافت فایل با cache ──
app.get('/api/file/:fileId', async (req, res) => {
  try {
    const meta = await FileRef.findOne({ fileId: req.params.fileId }).lean();
    if (!meta) return res.status(404).json({ error: 'فایل پیدا نشد' });
    const filePath = path.join(uploadsDir, meta.filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'فایل حذف شده' });
    res.set('Cache-Control', 'public, max-age=86400'); // 1 day cache
    res.set('Content-Type', meta.mimetype);
    res.sendFile(filePath);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: Logo (backward compat — store as file) ──
app.get('/api/logo', requireDB, async (req, res) => {
  try {
    const logo = await dbGet('logo');
    res.json({ ok: true, logo: logo || '' });
  } catch (e) {
    res.json({ ok: true, logo: '' });
  }
});

app.post('/api/logo', requireDB, async (req, res) => {
  try {
    await dbSave('logo', req.body.logo || '');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Pagination API برای گزارش‌ها ──
app.get('/api/transactions', requireDB, async (req, res) => {
  try {
    const data = await dbGet('mainDB');
    if (!data) return res.json({ ok: true, rows: [], total: 0 });
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const type  = req.query.type || 'expense';
    const projectId = req.query.projectId ? parseInt(req.query.projectId) : null;
    let rows = (data.transactions || []).filter(t => {
      if (type && t.type !== type) return false;
      if (projectId && t.projectId !== projectId) return false;
      return true;
    }).reverse();
    const total = rows.length;
    rows = rows.slice((page - 1) * limit, page * limit);
    res.json({ ok: true, rows, total, page, limit, pages: Math.ceil(total / limit) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Error handler برای multer ──
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ ok: false, error: 'حجم فایل بیش از ۲۰۰KB است' });
  }
  next(err);
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('🚀 سرور در پورت ' + PORT);
  console.log('🗜️  Compression: gzip فعال');
  console.log('📁 Uploads dir:', uploadsDir);
});
