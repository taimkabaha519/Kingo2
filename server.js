const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
// Also try loading from current working directory as a fallback
require('dotenv').config({ path: path.join(process.cwd(), '.env') });
const express = require('express');
const http = require('http');
const fs = require('fs-extra');
const socketIo = require('socket.io');
const { exec, spawn } = require('child_process');
const ejs = require('ejs');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const compression = require('compression');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const unzipper = require('unzipper');
const archiver = require('archiver');
const { createProxyMiddleware } = require('http-proxy-middleware');
const mongoose = require('mongoose');
const { connectDB, reconnectDB, isConnected, User, Hosting, Log } = require('./models');
const { logActivity, logCustomActivity, logError } = require('./middleware/logger');
const Notification = require('./models/notification');
const { Types } = require('mongoose');
const { HostingService, FileService, ProxyService } = require('./services');
const config = require('./config');
// Removed IP utilities – we no longer expose server IPs publicly

// Create Express app
const app = express();
const server = http.createServer(app);
const io = socketIo(server);
global.io = io;

// Middleware
// Compression middleware - يجب أن يكون أول middleware لضغط جميع الاستجابات
app.use(compression({
    level: 6, // مستوى الضغط (1-9، 6 توازن جيد بين السرعة والضغط)
    filter: (req, res) => {
        // لا تضغط إذا كان العميل لا يدعم compression
        if (req.headers['x-no-compression']) {
            return false;
        }
        // استخدم compression للجميع
        return compression.filter(req, res);
    }
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());
app.use(session({
    secret: process.env.SESSION_SECRET || 'abualqasabualqasabualqasabualqasabualqasabualqas',
    resave: false,
    saveUninitialized: false,
    cookie: {
        sameSite: 'lax'
    }
}));
app.use(passport.initialize());
app.use(passport.session());
app.use(cors());

// Static files with caching headers for better performance
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: '1y', // Cache static files for 1 year
    etag: true, // Enable ETag for better caching
    lastModified: true, // Enable Last-Modified headers
    setHeaders: (res, path) => {
        // Set cache-control for different file types
        if (path.endsWith('.html')) {
            res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
        } else if (path.match(/\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$/)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
    }
}));

// Middleware for logging specific activities only
app.use((req, res, next) => {
    // Only log for specific routes to avoid conflicts
    const logRoutes = ['/admin', '/hosting', '/console', '/files', '/api'];
    const shouldLog = logRoutes.some(route => req.path.startsWith(route));

    if (shouldLog) {
        try {
            logActivity(req, res, next);
        } catch (error) {
            console.error('Logger middleware error:', error);
            next(); // Continue without logging
        }
    } else {
        next();
    }
});

// ===== Database Connection Middleware =====
const ensureDBConnection = async (req, res, next) => {
    if (!isConnected()) {
        console.log('⚠️ قاعدة البيانات غير متصلة، محاولة إعادة الاتصال...');
        const reconnected = await reconnectDB();
        if (!reconnected) {
            return res.status(503).json({
                success: false,
                message: 'خدمة قاعدة البيانات غير متاحة حالياً'
            });
        }
    }
    next();
};

// دالة مساعدة لتنفيذ استعلامات قاعدة البيانات مع معالجة الأخطاء
const safeDBQuery = async (queryFunction, errorMessage = 'خطأ في قاعدة البيانات') => {
    try {
        // التحقق من حالة الاتصال
        if (!isConnected()) {
            console.log('⚠️ قاعدة البيانات غير متصلة، محاولة إعادة الاتصال...');
            const reconnected = await reconnectDB();
            if (!reconnected) {
                throw new Error('خدمة قاعدة البيانات غير متاحة حالياً');
            }
        }

        // انتظار الاتصال إذا لم يكن مكتملاً
        if (mongoose.connection.readyState === 1) {
            return await queryFunction();
        } else {
            // انتظار الاتصال
            await new Promise((resolve, reject) => {
                if (mongoose.connection.readyState === 1) {
                    resolve();
                } else {
                    mongoose.connection.once('connected', resolve);
                    mongoose.connection.once('error', reject);
                    setTimeout(() => reject(new Error('Connection timeout')), 10000);
                }
            });
            return await queryFunction();
        }
    } catch (error) {
        console.error('خطأ في استعلام قاعدة البيانات:', error);
        if (error.name === 'MongooseError' && (error.message.includes('buffering timed out') || error.message.includes('before initial connection'))) {
            console.log('🔄 محاولة إعادة الاتصال بسبب مشكلة الاتصال...');
            try {
                await reconnectDB();
                return await queryFunction();
            } catch (retryError) {
                console.error('فشل في إعادة المحاولة:', retryError);
                throw new Error(errorMessage);
            }
        }
        throw new Error(errorMessage);
    }
};

// ===== IP Ban middleware =====
const banDataDir = path.join(__dirname, 'data');
const bannedIpsFile = path.join(banDataDir, 'banned_ips.json');
const bannedUserIdsFile = path.join(banDataDir, 'banned_user_ids.json');

function readBannedIps() {
    try {
        if (!fs.existsSync(banDataDir)) fs.mkdirSync(banDataDir);
        if (!fs.existsSync(bannedIpsFile)) fs.writeFileSync(bannedIpsFile, '[]');
        return new Set(JSON.parse(fs.readFileSync(bannedIpsFile, 'utf8')));
    } catch { return new Set(); }
}

function writeBannedIps(set) {
    try { fs.writeFileSync(bannedIpsFile, JSON.stringify(Array.from(set), null, 2)); } catch { }
}

function readBannedUserIds() {
    try {
        if (!fs.existsSync(banDataDir)) fs.mkdirSync(banDataDir);
        if (!fs.existsSync(bannedUserIdsFile)) fs.writeFileSync(bannedUserIdsFile, '[]');
        return JSON.parse(fs.readFileSync(bannedUserIdsFile, 'utf8'));
    } catch { return []; }
}

function writeBannedUserIds(ids) {
    try { fs.writeFileSync(bannedUserIdsFile, JSON.stringify(ids, null, 2)); } catch { }
}

function getClientIp(req) {
    const xf = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim();
    return xf || req.ip || req.connection?.remoteAddress || '';
}
app.use((req, res, next) => {
    // Check IP ban
    const bannedIps = readBannedIps();
    const ip = getClientIp(req);
    if (ip && bannedIps.has(ip)) {
        return res.status(403).send('Your IP is banned');
    }

    // Check user ID ban
    if (req.user) {
        const bannedUserIds = readBannedUserIds();
        if (bannedUserIds.includes(req.user.id)) {
            req.logout(() => {
                return res.status(403).send('Your account has been banned');
            });
            return;
        }
    }

    next();
});

// Set view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// File upload configuration
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Logo upload configuration
const uploadsDir = path.join(__dirname, 'public', 'uploads', 'logos');
fs.ensureDirSync(uploadsDir);

const logoStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, `logo-${uniqueSuffix}${ext}`);
    }
});

const logoUpload = multer({
    storage: logoStorage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|webp|svg/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);

        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb(new Error('يرجى رفع صورة فقط (jpg, png, gif, webp, svg)'));
        }
    }
});

// Discord OAuth setup
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

const discordClientId = "1281081410404225095".trim();
const discordClientSecret = "SkZSo_lFHaItW-WTT0KZDT4dVDC2_aW5".trim();
const discordCallback = "http://localhost:3000/auth/discord/callback".trim();
const discordAuthEnabled = discordClientId.length > 0 && discordClientSecret.length > 0;
console.log('[Auth] Discord OAuth configured:', discordAuthEnabled);
console.log('[Auth] Has DISCORD_CLIENT_ID:', discordClientId.length > 0);
console.log('[Auth] Has DISCORD_CLIENT_SECRET:', discordClientSecret.length > 0);
console.log('[Auth] DISCORD_CALLBACK_URL:', discordCallback);
if (discordAuthEnabled) {
    passport.use(new DiscordStrategy({
        clientID: discordClientId,
        clientSecret: discordClientSecret,
        callbackURL: discordCallback,
        scope: ['identify']
    }, async (accessToken, refreshToken, profile, done) => {
        try {
            const avatarUrl = profile.avatar ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png` : 'https://cdn.discordapp.com/embed/avatars/0.png';
            await safeDBQuery(
                () => User.findOneAndUpdate(
                    { discordId: profile.id },
                    {
                        discordId: profile.id,
                        username: profile.username,
                        avatar: avatarUrl,
                        lastLogin: new Date()
                    },
                    { upsert: true, new: true, setDefaultsOnInsert: true }
                ),
                'خطأ في تحديث بيانات المستخدم'
            );
            const user = {
                id: profile.id,
                username: profile.username,
                tag: `${profile.username}#${profile.discriminator}`,
                avatar: avatarUrl
            };
            return done(null, user);
        } catch (err) {
            console.error('Mongo upsert user error:', err);
            const fallback = {
                id: profile.id,
                username: profile.username,
                tag: `${profile.username}#${profile.discriminator}`,
                avatar: profile.avatar ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png` : 'https://cdn.discordapp.com/embed/avatars/0.png'
            };
            return done(null, fallback);
        }
    }));
}
// Ensure the logged-in Discord user exists in Mongo and return it
async function ensureDbUser(discordId, username, avatar) {
    try {
        if (!discordId) return null;
        const avatarUrl = avatar || 'https://cdn.discordapp.com/embed/avatars/0.png';
        const user = await safeDBQuery(
            () => User.findOneAndUpdate(
                { discordId },
                { discordId, username: username || 'user', avatar: avatarUrl, lastLogin: new Date() },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            ),
            'خطأ في إنشاء/تحديث المستخدم'
        );
        return user;
    } catch (e) {
        console.error('ensureDbUser error', e);
        return null;
    }
}


// Helper functions
function getHostingPath(hostName) {
    return path.join(__dirname, 'hostings', hostName);
}

function getHostingBasePath(hostId) {
    try {
        // أولاً، جرب المجلد المؤقت
        const tmpBase = path.join('/tmp', 'hostings', hostId);
        if (fs.existsSync(tmpBase)) {
            return tmpBase;
        }

        // إذا لم يوجد المجلد المؤقت، استخدم المجلد الدائم
        const physicalPath = getHostingPath(hostId);
        if (fs.existsSync(physicalPath)) {
            return physicalPath;
        }

        // إذا لم يوجد أي منهما، أنشئ المجلد الدائم
        fs.ensureDirSync(physicalPath);
        return physicalPath;
    } catch (e) {
        console.error('Error in getHostingBasePath:', e.message);
        return getHostingPath(hostId);
    }
}

// Resolve a relative path safely within a base directory; return null if escapes the base
function safeResolve(baseDir, relativePath) {
    try {
        const normalized = path.normalize(relativePath || '/');
        const resolved = path.resolve(baseDir, '.' + (normalized.startsWith('/') ? normalized : '/' + normalized));
        const baseResolved = path.resolve(baseDir);
        if (!resolved.startsWith(baseResolved + path.sep) && resolved !== baseResolved) {
            return null;
        }
        return resolved;
    } catch { return null; }
}

// Preserve/restore essential fields in root config.json so hosting stays visible
function getHostIdFromBasePath(basePath) {
    try {
        const parts = basePath.replace(/\\/g, '/').split('/').filter(Boolean);
        return parts[parts.length - 1] || null;
    } catch { return null; }
}

function readRootConfig(basePath) {
    try {
        // Try basePath first
        const configPathTmp = path.join(basePath, 'config.json');
        if (fs.existsSync(configPathTmp)) {
            return JSON.parse(fs.readFileSync(configPathTmp, 'utf8'));
        }
        // Fallback to physical hostings path
        const hostId = getHostIdFromBasePath(basePath);
        if (hostId) {
            const configPathPhysical = path.join(getHostingPath(hostId), 'config.json');
            if (fs.existsSync(configPathPhysical)) {
                return JSON.parse(fs.readFileSync(configPathPhysical, 'utf8'));
            }
        }
    } catch { }
    return null;
}

function writeRootConfig(basePath, configObject) {
    try {
        const configPathTmp = path.join(basePath, 'config.json');
        const configJson = JSON.stringify(configObject, null, 2);

        // كتابة الإعدادات في المجلد المؤقت
        fs.writeFileSync(configPathTmp, configJson);

        // كتابة الإعدادات في المجلد الدائم أيضاً للمزامنة
        const hostId = getHostIdFromBasePath(basePath);
        if (hostId) {
            const configPathPhysical = path.join(getHostingPath(hostId), 'config.json');
            try {
                fs.writeFileSync(configPathPhysical, configJson);
            } catch (e) {
                console.error('Failed to write physical config:', e.message);
            }
        }
    } catch (e) {
        console.error('Failed to write root config.json:', e.message);
    }
}

function reconcileRootConfig(basePath, oldConfig, skipRecreation = false) {
    try {
        const hostId = getHostIdFromBasePath(basePath);
        const configPathTmp = path.join(basePath, 'config.json');
        const configPathPhysical = hostId ? path.join(getHostingPath(hostId), 'config.json') : null;

        // إذا لم يكن هناك config قديم، لا نفعل شيئاً
        if (!oldConfig) return;

        // إذا كان الملف غير موجود ولا نريد إعادة إنشاؤه، لا نفعل شيئاً
        if (skipRecreation && !fs.existsSync(configPathTmp) && (!configPathPhysical || !fs.existsSync(configPathPhysical))) {
            console.log(`Info: config.json not found, skipping reconciliation (may have been deleted intentionally)`);
            return;
        }

        // قراءة الإعدادات الحالية
        let newConfig = {};
        try {
            if (fs.existsSync(configPathTmp)) {
                newConfig = JSON.parse(fs.readFileSync(configPathTmp, 'utf8')) || {};
            } else if (configPathPhysical && fs.existsSync(configPathPhysical)) {
                newConfig = JSON.parse(fs.readFileSync(configPathPhysical, 'utf8')) || {};
            }
        } catch (e) {
            console.error('Error reading config:', e.message);
        }

        // دمج الإعدادات مع الحفاظ على البيانات المهمة
        const merged = {
            ...newConfig,
            // الحفاظ على البيانات الأساسية من الإعدادات القديمة
            owner: oldConfig.owner || newConfig.owner,
            name: newConfig.name || oldConfig.name || (hostId || path.basename(basePath)),
            serviceType: newConfig.serviceType || oldConfig.serviceType || 'discord',
            siteMode: newConfig.siteMode || oldConfig.siteMode || 'nodejs',
            port: newConfig.port || oldConfig.port || 0,
            mainFile: newConfig.mainFile || oldConfig.mainFile || 'index.js',
            status: newConfig.status || oldConfig.status || 'stopped',
            createdAt: newConfig.createdAt || oldConfig.createdAt || new Date().toISOString(),
            expiryDate: newConfig.expiryDate || oldConfig.expiryDate || new Date().toISOString()
        };

        // كتابة الإعدادات المدمجة
        writeRootConfig(basePath, merged);

        // التأكد من أن الإعدادات محفوظة في المجلد الدائم أيضاً
        if (hostId && configPathPhysical) {
            try {
                fs.writeFileSync(configPathPhysical, JSON.stringify(merged, null, 2));
            } catch (e) {
                console.error('Failed to write physical config:', e.message);
            }
        }
    } catch (e) {
        console.error('Failed to reconcile root config.json:', e.message);
    }
}

function getHostingData(hostName) {
    try {
        const hostingPath = getHostingPath(hostName);
        const configPath = path.join(hostingPath, 'config.json');

        if (fs.existsSync(configPath)) {
            return JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
        return null;
    } catch (error) {
        console.error(`Error getting hosting data for ${hostName}:`, error);
        return null;
    }
}

async function getAllHostings() {
    try {
        // محاولة جلب الهوستات من قاعدة البيانات أولاً
        try {
            const dbHostings = await safeDBQuery(
                () => Hosting.find({}).populate('owner'),
                'خطأ في جلب الهوستات من قاعدة البيانات'
            );

            if (dbHostings && dbHostings.length > 0) {
                return dbHostings.map(hosting => {
                    // احسب استخدام المساحة
                    let usedStorage = '0 Bytes';
                    try {
                        const hostingPath = getHostingPath(hosting._id.toString());
                        const sizeBytes = getFolderSize(hostingPath);
                        usedStorage = formatBytes(sizeBytes);
                    } catch { }

                    return {
                        _id: hosting._id,
                        id: hosting._id.toString(),
                        name: hosting.name,
                        status: hosting.status || 'stopped',
                        owner: hosting.owner ? {
                            id: hosting.owner.discordId || hosting.owner._id,
                            username: hosting.owner.username,
                            avatar: hosting.owner.avatar
                        } : null,
                        createdAt: hosting.createdAt,
                        expiryDate: hosting.expiryDate,
                        usedStorage,
                        plan: 'Basic',
                        mainFile: hosting.mainFile || 'index.js',
                        nodeVersion: hosting.nodeVersion || '16',
                        autoRestart: false,
                        publicAccess: false,
                        serviceType: hosting.serviceType || 'discord',
                        port: hosting.port || 0
                    };
                });
            }
        } catch (e) {
            console.error('Error getting hostings from database:', e);
        }

        // Fallback إلى نظام الملفات
        const hostingsDir = path.join(__dirname, 'hostings');
        if (!fs.existsSync(hostingsDir)) {
            return [];
        }

        const hostingFolders = fs.readdirSync(hostingsDir).filter(name =>
            fs.statSync(path.join(hostingsDir, name)).isDirectory()
        );

        return hostingFolders.map(name => {
            const hostingData = getHostingData(name) || {};
            return {
                id: name,
                name: name,
                status: hostingData.status || 'stopped',
                owner: hostingData.owner || { id: 'unknown', username: 'Unknown', avatar: 'https://cdn.discordapp.com/embed/avatars/0.png' },
                createdAt: hostingData.createdAt || 'Unknown',
                expiryDate: hostingData.expiryDate || 'Unknown',
                plan: hostingData.plan || 'Basic',
                mainFile: hostingData.mainFile || 'index.js',
                nodeVersion: hostingData.nodeVersion || '16',
                autoRestart: hostingData.autoRestart || false,
                publicAccess: hostingData.publicAccess || false,
                serviceType: hostingData.serviceType || 'discord',
                port: hostingData.port || (hostingData.serviceType === 'mta' ? 22003 : hostingData.serviceType === 'fivem' ? 30120 : hostingData.serviceType === 'web' ? 4000 : 0)
            };
        });
    } catch (error) {
        console.error('Error getting all hostings:', error);
        return [];
    }
}

async function findWebHostingByUserAndSite(username, siteName) {
    try {
        const owner = await User.findOne({ username });
        if (!owner) return null;
        const hosting = await Hosting.findOne({ owner: owner._id, serviceType: 'web', name: siteName });
        if (!hosting) return null;
        return {
            id: hosting._id.toString(),
            name: hosting.name,
            status: hosting.status || 'stopped',
            owner: { id: owner.discordId, username: owner.username, avatar: owner.avatar },
            serviceType: hosting.serviceType,
            port: hosting.port || 0
        };
    } catch {
        return null;
    }
}

function writeHtml(res, statusCode, html) {
    try {
        if (typeof res.status === 'function' && typeof res.send === 'function') {
            return res.status(statusCode).send(html);
        }
        res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
    } catch (e) {
        try { res.end(); } catch { }
    }
}

function sendStaticFallback(hosting, res) {
    try {
        const hostingRoot = getHostingPath(hosting.id);
        const publicDir = path.join(hostingRoot, 'public');
        const tryDir = fs.existsSync(publicDir) ? publicDir : hostingRoot;
        const indexPath = path.join(tryDir, 'index.html');
        if (fs.existsSync(indexPath)) {
            const html = fs.readFileSync(indexPath);
            if (typeof res.sendFile === 'function') {
                return res.sendFile(indexPath);
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end(html);
        }
        return writeHtml(res, 502, '<!doctype html><meta charset="utf-8"><title>No index.html</title><body style="font-family:sans-serif;background:#0d1117;color:#c9d1d9"><div style="max-width:600px;margin:10% auto;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:20px">لا يوجد ملف index.html لعرضه</div></body>');
    } catch (e) {
        console.error('static fallback error', e);
        return writeHtml(res, 502, '<!doctype html><meta charset="utf-8"><title>Error</title><body>Static fallback error</body>');
    }
}

function sendOfflinePage(hosting, res) {
    const html = `<!doctype html><html lang="ar" dir="rtl"><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>الموقع غير متاح</title>
    <style>body{margin:0;font-family:Tahoma,Arial,sans-serif;background:#0d1117;color:#c9d1d9;display:flex;align-items:center;justify-content:center;min-height:100vh}
    .card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:24px;max-width:520px;box-shadow:0 6px 20px rgba(0,0,0,.35)}
    h1{margin:0 0 8px;font-size:22px}p{margin:6px 0;color:#8b949e}code{background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:2px 6px}
    .badge{display:inline-block;background:#21262d;border:1px solid #30363d;border-radius:999px;padding:2px 10px;margin-left:6px;color:#8b949e;font-size:12px}
    </style></head><body>
    <div class="card">
      <h1>الموقع غير متاح حالياً</h1>
      <p>موقع <strong>${(hosting.owner?.username || 'user')}</strong>/<code>${hosting.name}</code> مُطفأ حالياً.</p>
      <p>إذا كنت مالك الموقع، قم بتشغيله من لوحة التحكم أو ارفع ملفات HTML داخل <code>public/</code>.</p>
      <p class="badge">الحالة: ${hosting.status || 'stopped'}</p>
    </div></body></html>`;
    res.status(503).send(html);
}

// Reverse proxy for Node.js web hostings (legacy path)
app.use('/sites/:user/:site', async (req, res, next) => {
    const { user, site } = req.params;
    const hosting = await findWebHostingByUserAndSite(user, site);
    if (!hosting) return res.status(404).send('Site not found');
    if ((hosting.status || 'stopped') !== 'running') return sendOfflinePage(hosting, res);
    if (!hosting.port) return sendStaticFallback(hosting, res);
    const target = `http://127.0.0.1:${hosting.port}`;
    return createProxyMiddleware({
        target,
        changeOrigin: true,
        ws: true,
        pathRewrite: { [`^/sites/${user}/${site}`]: '' },
        onError(err, _req, _res, _target) {
            return sendStaticFallback(hosting, _res);
        }
    })(req, res, next);
});

// Primary path: https://base/<user>/<site>
app.use('/:user/:site', async (req, res, next) => {
    const { user, site } = req.params;
    // skip if collides with known app routes
    const reservedFirst = new Set(['hosting', 'hostings', 'console', 'files', 'support', 'auth', 'pricing', 'buy-hosting', 'logout', 'debug', 'api', 'admin', 'css', 'js', 'img', 'images', 'fonts', 'assets', 'static', 'favicon.ico']);
    if (reservedFirst.has(user)) return next();
    // Avoid intercepting static asset paths like /user/file.css
    if (site.includes('.')) return next();
    // Only handle browser navigations
    if (req.method !== 'GET') return next();
    const accept = req.headers['accept'] || '';
    if (!accept.includes('text/html')) return next();
    const hosting = await findWebHostingByUserAndSite(user, site);
    if (!hosting) return res.status(404).send('Site not found');
    if ((hosting.status || 'stopped') !== 'running') return sendOfflinePage(hosting, res);
    if (!hosting.port) return sendStaticFallback(hosting, res);
    const target = `http://127.0.0.1:${hosting.port}`;
    return createProxyMiddleware({
        target,
        changeOrigin: true,
        ws: true,
        pathRewrite: { [`^/${user}/${site}`]: '' },
        onError(err, _req, _res, _target) {
            return sendStaticFallback(hosting, _res);
        }
    })(req, res, next);
});

// API: set site mode (html | node) for web hosting
app.post('/api/hosting/:id/site-type', (req, res) => {
    try {
        const hostId = req.params.id;
        const { type } = req.body || {};
        const hosting = getHostingById(hostId);
        if (!hosting || hosting.serviceType !== 'web') {
            return res.status(400).json({ success: false, message: 'Not a web hosting' });
        }
        const mode = (type || '').toLowerCase() === 'node' ? 'node' : 'html';
        const cfgPath = path.join(getHostingPath(hostId), 'config.json');
        const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
        cfg.siteMode = mode;
        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
        return res.json({ success: true, mode });
    } catch (e) {
        console.error('set site-type error', e);
        return res.status(500).json({ success: false });
    }
});

// ========== Admin and Tickets ==========
// Admin list comes from global set (populated by index.js via config.ownersid)
const ADMIN_USER_IDS = (global.ADMIN_USER_IDS instanceof Set) ? global.ADMIN_USER_IDS : new Set();

// Helper function to convert duration to milliseconds
function getDurationInMs(duration) {
    const durations = {
        '3_days': 3 * 24 * 60 * 60 * 1000,
        '1_week': 7 * 24 * 60 * 60 * 1000,
        '1_month': 30 * 24 * 60 * 60 * 1000,
        '3_months': 90 * 24 * 60 * 60 * 1000,
        '1_year': 365 * 24 * 60 * 60 * 1000
    };
    return durations[duration] || durations['3_days'];
}
function isAdmin(req) {
    if (!req.user) return false;
    // Strict: require the user's Discord ID to be in admin list
    const uid = (req.user.discordId || req.user.id || '').toString();
    return ADMIN_USER_IDS.has(uid);
}

function isOwner(req) {
    if (!req.user) return false;
    // Check if user is the owner (first admin in the list)
    const uid = (req.user.discordId || req.user.id || '').toString();
    const ownerIds = Array.from(ADMIN_USER_IDS);
    return ownerIds.length > 0 && uid === ownerIds[0];
}

// Get all admin users
function getAllAdmins() {
    // If no admins configured, return empty array
    if (ADMIN_USER_IDS.size === 0) return [];
    return Array.from(ADMIN_USER_IDS).map(id => ({ id }));
}

const dataDir = path.join(__dirname, 'data');
const ticketsFile = path.join(dataDir, 'tickets.json');
function ensureDataDir() { if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir); if (!fs.existsSync(ticketsFile)) fs.writeFileSync(ticketsFile, '[]'); }
function readTickets() { ensureDataDir(); try { return JSON.parse(fs.readFileSync(ticketsFile, 'utf8')); } catch { return []; } }
function writeTickets(t) { ensureDataDir(); fs.writeFileSync(ticketsFile, JSON.stringify(t, null, 2), 'utf8'); }
function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

app.post('/api/tickets', (req, res) => {
    try {
        const user = req.user || { id: 'guest', username: 'Guest', avatar: '' };
        const { subject, type, details, urgent } = req.body || {};
        if (!subject || !type || !details) return res.status(400).json({ success: false, message: 'missing fields' });

        const tickets = readTickets();
        const ticketId = newId();
        const ticket = {
            id: ticketId,
            subject,
            type,
            details,
            urgent: !!urgent,
            status: 'open',
            user,
            createdAt: new Date().toISOString(),
            updates: []
        };

        tickets.unshift(ticket);
        writeTickets(tickets);

        // Create empty messages file
        const ticketMessagesDir = path.join(__dirname, 'data', 'ticket_messages');
        const ticketMessagesPath = path.join(ticketMessagesDir, `${ticketId}.json`);

        if (!fs.existsSync(ticketMessagesDir)) {
            fs.mkdirSync(ticketMessagesDir, { recursive: true });
        }

        // Add system message
        const systemMessage = {
            id: Date.now().toString(36),
            userId: 'system',
            username: 'النظام',
            avatar: '/img/system-avatar.png',
            message: 'تم إنشاء التذكرة بنجاح. سيقوم فريق الدعم بالرد عليك قريباً.',
            timestamp: new Date().toISOString(),
            isSystem: true
        };

        fs.writeFileSync(ticketMessagesPath, JSON.stringify([systemMessage], null, 2));

        // Notify admins about new ticket
        io.emit('new-ticket', {
            id: ticketId,
            subject,
            username: user.username,
            urgent: !!urgent,
            type
        });

        return res.json({ success: true, ticket });
    } catch (e) {
        console.error('create ticket error', e);
        return res.status(500).json({ success: false });
    }
});

// Admin dashboard and stats
app.get('/admin', async (req, res) => {
    if (!req.user) return res.redirect('/auth/discord');
    if (!isAdmin(req)) return renderWithLayout(res, '403', { user: req.user, active: '' });

    const tickets = readTickets();
    const allHostings = await getAllHostings();
    const bannedIps = Array.from(readBannedIps());

    // Calculate statistics
    const stats = {
        totalHostings: allHostings.length,
        activeHostings: allHostings.filter(h => h.status === 'running').length,
        totalUsers: new Set(allHostings.map(h => h.owner?.id).filter(Boolean)).size,
        totalStorage: 0,
        totalTickets: tickets.length,
        openTickets: tickets.filter(t => t.status === 'open').length,
        bannedIdsCount: 0
    };

    // Calculate storage usage
    try {
        const hostingsDir = path.join(__dirname, 'hostings');
        if (fs.existsSync(hostingsDir)) {
            const dirs = fs.readdirSync(hostingsDir);
            let totalSize = 0;
            dirs.forEach(dir => {
                const dirPath = path.join(hostingsDir, dir);
                if (fs.statSync(dirPath).isDirectory()) {
                    totalSize += getFolderSize(dirPath);
                }
            });
            stats.totalStorage = formatBytes(totalSize);
        }
    } catch (error) {
        console.error('Error calculating storage:', error);
        stats.totalStorage = 'Error';
    }

    // Count banned user IDs
    try {
        const bannedIdsPath = path.join(dataDir, 'banned_user_ids.json');
        if (fs.existsSync(bannedIdsPath)) {
            const bannedIds = JSON.parse(fs.readFileSync(bannedIdsPath, 'utf8'));
            stats.bannedIdsCount = bannedIds.length;
        }
    } catch (error) {
        console.error('Error counting banned IDs:', error);
    }

    // Get notifications for admin panel
    const notifications = await Notification.find({ isActive: true })
        .populate('createdBy', 'username avatar')
        .sort({ createdAt: -1 })
        .limit(50);

    return renderWithLayout(res, 'admin', {
        user: req.user || null,
        tickets,
        hostings: allHostings,
        bannedIps,
        stats,
        notifications,
        isOwner: isOwner(req),
        config,
        active: 'admin'
    });
});

// Admin hostings control page
app.get('/admin/hostings-control', async (req, res) => {
    if (!req.user) return res.redirect('/auth/discord');
    if (!isAdmin(req)) return renderWithLayout(res, '403', { user: req.user, active: '' });

    try {
        const allHostings = await getAllHostings();
        return renderWithLayout(res, 'admin-hostings', {
            user: req.user || null,
            isOwner: isOwner(req),
            hostings: allHostings,
            active: 'admin'
        });
    } catch (error) {
        console.error('Error loading hostings control page:', error);
        return renderWithLayout(res, 'error', {
            message: 'خطأ في تحميل صفحة إدارة الهوستات',
            user: req.user || null,
            active: 'admin'
        });
    }
});

// API: Renew hosting expiry
app.post('/api/admin/renew-hosting/:id', async (req, res) => {
    if (!req.user) return res.status(401).json({ success: false, message: 'غير مصرح' });
    if (!isAdmin(req)) return res.status(403).json({ success: false, message: 'غير مصرح' });

    try {
        const hostId = req.params.id;
        const { days = 30 } = req.body; // تجديد لمدة 30 يوم افتراضياً

        // البحث عن الهوست في قاعدة البيانات
        const hosting = await getHostingById(hostId);
        if (!hosting) {
            return res.status(404).json({ success: false, message: 'الهوست غير موجود' });
        }

        // حساب التاريخ الجديد
        const currentDate = hosting.expiryDate ? new Date(hosting.expiryDate) : new Date();
        const newExpiryDate = new Date(currentDate.getTime() + (days * 24 * 60 * 60 * 1000));

        // تحديث قاعدة البيانات
        if (Types.ObjectId.isValid(hostId)) {
            await safeDBQuery(
                () => Hosting.findByIdAndUpdate(hostId, { expiryDate: newExpiryDate }),
                'خطأ في تحديث مدة الهوست'
            );
        }

        // تحديث config.json
        const basePath = getHostingBasePath(hostId);
        const configPath = path.join(basePath, 'config.json');
        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            config.expiryDate = newExpiryDate.toISOString();
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        }

        // تحديث hostings.json
        const userDataDir = path.join(__dirname, 'data');
        const hostingsFile = path.join(userDataDir, 'hostings.json');
        if (fs.existsSync(hostingsFile)) {
            const hostingsData = JSON.parse(fs.readFileSync(hostingsFile, 'utf8'));
            const hostingIndex = hostingsData.findIndex(h => h.id === hostId);
            if (hostingIndex !== -1) {
                hostingsData[hostingIndex].expiryDate = newExpiryDate.toISOString();
                fs.writeFileSync(hostingsFile, JSON.stringify(hostingsData, null, 2));
            }
        }

        res.json({
            success: true,
            message: `تم تجديد مدة الهوست لمدة ${days} يوم`,
            newExpiryDate: newExpiryDate.toISOString()
        });

    } catch (error) {
        console.error('Error renewing hosting:', error);
        res.status(500).json({ success: false, message: 'خطأ في تجديد مدة الهوست' });
    }
});

// Create notification route
app.post('/admin/create-notification', async (req, res) => {
    if (!req.user) return res.status(401).json({ success: false, message: 'غير مصرح' });
    if (!isAdmin(req)) return res.status(403).json({ success: false, message: 'غير مصرح' });

    try {
        const { title, message, type, priority, targetType, targetUsers, link, expiryDate } = req.body;

        console.log('User object:', req.user);
        console.log('User ID:', req.user?._id || req.user?.id);

        // Validation
        if (!title || !message || !type || !targetType) {
            return res.status(400).json({
                success: false,
                message: 'يرجى ملء جميع الحقول المطلوبة'
            });
        }

        if (!req.user || (!req.user._id && !req.user.id)) {
            return res.status(400).json({
                success: false,
                message: 'معلومات المستخدم غير صحيحة'
            });
        }

        // Get the actual user from database
        const dbUser = await User.findOne({ discordId: req.user.id });
        if (!dbUser) {
            return res.status(400).json({
                success: false,
                message: 'المستخدم غير موجود في قاعدة البيانات'
            });
        }

        // Prepare notification data
        const notificationData = {
            title: title.trim(),
            message: message.trim(),
            type,
            priority: priority || 'medium',
            targetType,
            createdBy: dbUser._id,
            link: link || null,
            isActive: true
        };

        // Handle expiry date
        if (expiryDate) {
            notificationData.expiresAt = new Date(expiryDate);
        }

        // Handle target users
        if (targetType === 'specific' && targetUsers && targetUsers.length > 0) {
            // Find users by username
            const users = await User.find({
                username: { $in: targetUsers }
            });

            if (users.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'لم يتم العثور على المستخدمين المحددين'
                });
            }

            notificationData.targetUsers = users.map(user => user._id);
        }

        // Create notification
        const notification = await Notification.create(notificationData);

        // Populate the created notification
        await notification.populate('createdBy', 'username avatar');

        console.log('Notification created successfully:', notification);

        // Send notification via Socket.IO
        if (notification.targetType === 'all') {
            // Send to all connected users
            io.emit('new-notification', {
                id: notification._id,
                title: notification.title,
                message: notification.message,
                type: notification.type,
                priority: notification.priority,
                link: notification.link,
                timestamp: notification.createdAt,
                createdBy: notification.createdBy
            });
        } else if (notification.targetUsers && notification.targetUsers.length > 0) {
            // Send to specific users
            for (const userId of notification.targetUsers) {
                const targetUser = await User.findById(userId);
                if (targetUser) {
                    io.to(targetUser.discordId).emit('new-notification', {
                        id: notification._id,
                        title: notification.title,
                        message: notification.message,
                        type: notification.type,
                        priority: notification.priority,
                        link: notification.link,
                        timestamp: notification.createdAt,
                        createdBy: notification.createdBy
                    });
                }
            }
        }

        res.json({
            success: true,
            message: 'تم إرسال الإشعار بنجاح',
            notification
        });

    } catch (error) {
        console.error('Error creating notification:', error);
        res.status(500).json({
            success: false,
            message: 'خطأ في إنشاء الإشعار: ' + error.message
        });
    }
});

// Toggle notification status route
app.post('/admin/toggle-notification-status', async (req, res) => {
    if (!req.user) return res.status(401).json({ success: false, message: 'غير مصرح' });
    if (!isAdmin(req)) return res.status(403).json({ success: false, message: 'غير مصرح' });

    try {
        const { id, isActive } = req.body;

        if (!id || typeof isActive !== 'boolean') {
            return res.status(400).json({
                success: false,
                message: 'بيانات غير صحيحة'
            });
        }

        const notification = await Notification.findByIdAndUpdate(
            id,
            { isActive },
            { new: true }
        );

        if (!notification) {
            return res.status(404).json({
                success: false,
                message: 'الإشعار غير موجود'
            });
        }

        res.json({
            success: true,
            message: `تم ${isActive ? 'تفعيل' : 'إيقاف'} الإشعار بنجاح`,
            notification
        });
    } catch (error) {
        console.error('Error toggling notification status:', error);
        res.status(500).json({ success: false, message: 'خطأ في تحديث حالة الإشعار: ' + error.message });
    }
});

// Delete notification route
app.post('/admin/delete-notification', async (req, res) => {
    if (!req.user) return res.status(401).json({ success: false, message: 'غير مصرح' });
    if (!isAdmin(req)) return res.status(403).json({ success: false, message: 'غير مصرح' });

    try {
        const { id } = req.body;

        if (!id) {
            return res.status(400).json({
                success: false,
                message: 'معرف الإشعار مطلوب'
            });
        }

        const notification = await Notification.findByIdAndDelete(id);

        if (!notification) {
            return res.status(404).json({
                success: false,
                message: 'الإشعار غير موجود'
            });
        }

        res.json({
            success: true,
            message: 'تم حذف الإشعار بنجاح'
        });
    } catch (error) {
        console.error('Error deleting notification:', error);
        res.status(500).json({ success: false, message: 'خطأ في حذف الإشعار: ' + error.message });
    }
});

app.post('/admin/tickets/:id/status', (req, res) => {
    try {
        if (!req.user) return res.status(401).json({ success: false, message: 'Not authenticated' });
        // السماح للمالِك أيضاً بالإضافة للأدمن
        if (!isAdmin(req) && !isOwner(req)) return res.status(403).json({ success: false, message: 'Not authorized' });
        const { id } = req.params;
        const { status, note } = req.body || {};
        const tickets = readTickets();
        const t = tickets.find(x => x.id === id);
        if (!t) return res.status(404).json({ success: false, message: 'Ticket not found' });
        if (!['open', 'closed', 'pending'].includes(status)) return res.status(400).json({ success: false, message: 'Bad status' });

        const oldStatus = t.status;
        t.status = status;

        const timestamp = new Date().toISOString();
        const updateEntry = {
            at: timestamp,
            by: req.user?.username || 'admin',
            status,
            note: note || `Status changed from ${oldStatus} to ${status}`
        };

        t.updates = Array.isArray(t.updates) ? t.updates : [];
        t.updates.push(updateEntry);
        writeTickets(tickets);

        const ticketMessagesPath = path.join(__dirname, 'data', 'ticket_messages', `${id}.json`);
        try {
            let messages = [];
            if (fs.existsSync(ticketMessagesPath)) {
                try { messages = JSON.parse(fs.readFileSync(ticketMessagesPath, 'utf8')) || []; } catch { }
            }
            const systemMessage = {
                id: Date.now().toString(36),
                userId: 'system',
                username: 'النظام',
                avatar: '/img/system-avatar.png',
                message: `تم تغيير حالة التذكرة إلى "${status}" بواسطة ${req.user?.username || 'admin'}${note ? `: ${note}` : ''}`,
                timestamp,
                isSystem: true
            };
            messages.push(systemMessage);
            fs.writeFileSync(ticketMessagesPath, JSON.stringify(messages, null, 2));
            io.to(`ticket-${id}`).emit('support-chat-message', systemMessage);
        } catch (error) {
            console.error(`Error updating chat for ticket ${id}:`, error);
        }

        io.emit('ticket-status-changed', {
            ticketId: id,
            status,
            updatedBy: req.user?.username || 'admin',
            timestamp
        });

        return res.json({ success: true });
    } catch (e) {
        console.error('ticket status error', e);
        return res.status(500).json({ success: false, message: e.message });
    }
});

// Admin ban/unban IP
app.post('/admin/ban-ip', (req, res) => {
    if (!isAdmin(req) && !isOwner(req)) return res.status(403).json({ success: false });
    const { ip } = req.body || {};
    if (!ip) return res.status(400).json({ success: false });
    const set = readBannedIps();
    set.add(ip);
    writeBannedIps(set);

    // Send notification to admins
    const admins = getAllAdmins();
    admins.forEach(admin => {
        io.to(admin.id).emit('notification', {
            type: 'security',
            message: `IP ${ip} has been banned`,
            timestamp: new Date().toISOString()
        });
    });

    return res.json({ success: true });
});

app.post('/admin/unban-ip', (req, res) => {
    if (!isAdmin(req) && !isOwner(req)) return res.status(403).json({ success: false });
    const { ip } = req.body || {};
    if (!ip) return res.status(400).json({ success: false });
    const set = readBannedIps();
    set.delete(ip);
    writeBannedIps(set);

    // Send notification to admins
    const admins = getAllAdmins();
    admins.forEach(admin => {
        io.to(admin.id).emit('notification', {
            type: 'security',
            message: `IP ${ip} has been unbanned`,
            timestamp: new Date().toISOString()
        });
    });

    return res.json({ success: true });
});

// Get all banned IPs
app.get('/admin/banned-ips', (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ success: false });
    const bannedIps = Array.from(readBannedIps());
    return res.json({ success: true, bannedIps });
});

// Admin ban/unban user ID
app.post('/admin/ban-user', (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ success: false });
    const { userId, username } = req.body || {};
    if (!userId) return res.status(400).json({ success: false });

    const bannedIds = readBannedUserIds();
    if (!bannedIds.includes(userId)) {
        bannedIds.push(userId);
        writeBannedUserIds(bannedIds);

        // Send notification to admins
        const admins = getAllAdmins();
        admins.forEach(admin => {
            io.to(admin.id).emit('notification', {
                type: 'security',
                message: `User ${username || userId} has been banned`,
                timestamp: new Date().toISOString()
            });
        });
    }

    return res.json({ success: true });
});

app.post('/admin/unban-user', (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ success: false });
    const { userId, username } = req.body || {};
    if (!userId) return res.status(400).json({ success: false });

    const bannedIds = readBannedUserIds();
    const index = bannedIds.indexOf(userId);
    if (index !== -1) {
        bannedIds.splice(index, 1);
        writeBannedUserIds(bannedIds);

        // Send notification to admins
        const admins = getAllAdmins();
        admins.forEach(admin => {
            io.to(admin.id).emit('notification', {
                type: 'security',
                message: `User ${username || userId} has been unbanned`,
                timestamp: new Date().toISOString()
            });
        });
    }

    return res.json({ success: true });
});

// Get all banned user IDs
app.get('/admin/banned-users', (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ success: false });
    const bannedUserIds = readBannedUserIds();
    return res.json({ success: true, bannedUserIds });
});

// Admin create hosting
app.post('/admin/create-hosting', async (req, res) => {
    console.log('Create hosting request:', req.body);

    if (!isAdmin(req)) {
        return res.status(403).json({ success: false, message: 'ليس لديك صلاحية' });
    }

    const { discordId, name, serviceType, port, duration, mainFile, specs } = req.body;

    if (!discordId || !serviceType || !duration) {
        return res.status(400).json({ success: false, message: 'بيانات ناقصة' });
    }

    try {
        const user = await User.findOne({ discordId: discordId });
        if (!user) {
            return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
        }

        // حساب تاريخ الانتهاء
        const expiryDate = new Date(Date.now() + getDurationInMs(duration));

        // تجهيز بيانات الهوست
        const hostingData = {
            owner: user._id,
            name: name || `${user.username}_${serviceType}_${Date.now()}`,
            serviceType,
            port: port || null,
            mainFile: mainFile || 'index.js',
            specs: specs || { cpu: 1, ram: 512, storage: 1 },
            expiryDate
        };

        console.log('Creating hosting via HostingService:', hostingData);

        // استخدام الخدمة لضمان تنفيذ كافة العمليات (مثل فك ضغط ملفات الماينكرافت)
        const hosting = await HostingService.createHosting(hostingData);

        return res.json({
            success: true,
            message: `تم إنشاء الهوست بنجاح باسم: ${hosting.name}`,
            hosting: {
                id: hosting._id,
                name: hosting.name,
                serviceType: hosting.serviceType,
                status: hosting.status,
                owner: user.username
            }
        });
    } catch (error) {
        console.error('Error creating hosting:', error);
        return res.status(500).json({
            success: false,
            message: 'خطأ في إنشاء الهوست: ' + error.message
        });
    }
});

// Admin delete hosting
app.post('/admin/delete-hosting/:id', (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ success: false });

    const hostId = req.params.id;
    if (!hostId) return res.status(400).json({ success: false, message: 'Missing hosting ID' });

    try {
        const discordBot = require('./index.js');
        // First stop the hosting if it's running
        discordBot.stopHosting(hostId);

        // Delete the hosting directory
        const hostingPath = getHostingPath(hostId);
        if (fs.existsSync(hostingPath)) {
            fs.rmSync(hostingPath, { recursive: true, force: true });
        }

        // Remove from hostings.json
        const userDataDir = path.join(__dirname, 'data');
        const hostingsFile = path.join(userDataDir, 'hostings.json');

        if (fs.existsSync(hostingsFile)) {
            let hostingsData = JSON.parse(fs.readFileSync(hostingsFile, 'utf8'));
            hostingsData = hostingsData.filter(h => h.id !== hostId);
            fs.writeFileSync(hostingsFile, JSON.stringify(hostingsData, null, 2));
        }

        return res.json({ success: true, message: 'Hosting deleted successfully' });
    } catch (error) {
        console.error('Error deleting hosting:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

// Admin update hosting settings
app.post('/admin/update-hosting/:id', (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ success: false });

    const hostId = req.params.id;
    const { mainFile, serviceType, port, specs } = req.body;

    try {
        const hostingPath = getHostingPath(hostId);
        const configPath = path.join(hostingPath, 'config.json');

        if (!fs.existsSync(configPath)) {
            return res.status(404).json({ success: false, message: 'Hosting not found' });
        }

        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

        // Update config
        if (mainFile) config.mainFile = mainFile;
        if (serviceType) config.serviceType = serviceType;
        if (port) config.port = parseInt(port, 10);
        if (specs) config.specs = specs;

        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

        // Update hostings.json
        const userDataDir = path.join(__dirname, 'data');
        const hostingsFile = path.join(userDataDir, 'hostings.json');

        if (fs.existsSync(hostingsFile)) {
            let hostingsData = JSON.parse(fs.readFileSync(hostingsFile, 'utf8'));
            const hostingIndex = hostingsData.findIndex(h => h.id === hostId);

            if (hostingIndex !== -1) {
                if (mainFile) hostingsData[hostingIndex].mainFile = mainFile;
                if (serviceType) hostingsData[hostingIndex].serviceType = serviceType;
                if (port) hostingsData[hostingIndex].port = parseInt(port, 10);
                if (specs) hostingsData[hostingIndex].specs = specs;

                fs.writeFileSync(hostingsFile, JSON.stringify(hostingsData, null, 2));
            }
        }

        return res.json({ success: true, message: 'Hosting updated successfully' });
    } catch (error) {
        console.error('Error updating hosting:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

// Admin extend hosting duration
app.post('/admin/extend-hosting/:id', (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ success: false });

    const hostId = req.params.id;
    const { duration } = req.body;

    if (!duration) {
        return res.status(400).json({ success: false, message: 'Duration is required' });
    }

    try {
        const hostingPath = getHostingPath(hostId);
        const configPath = path.join(hostingPath, 'config.json');

        if (!fs.existsSync(configPath)) {
            return res.status(404).json({ success: false, message: 'Hosting not found' });
        }

        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

        // Calculate new expiry date
        let newExpiryDate;
        const currentExpiry = config.expiryDate ? new Date(config.expiryDate) : new Date();

        if (duration === '3_days') {
            newExpiryDate = new Date(currentExpiry.getTime() + (3 * 24 * 60 * 60 * 1000));
        } else if (duration === '1_week') {
            newExpiryDate = new Date(currentExpiry.getTime() + (7 * 24 * 60 * 60 * 1000));
        } else if (duration === '1_month') {
            newExpiryDate = new Date(currentExpiry);
            newExpiryDate.setMonth(newExpiryDate.getMonth() + 1);
        } else if (duration === '3_months') {
            newExpiryDate = new Date(currentExpiry);
            newExpiryDate.setMonth(newExpiryDate.getMonth() + 3);
        } else if (duration === '1_year') {
            newExpiryDate = new Date(currentExpiry);
            newExpiryDate.setFullYear(newExpiryDate.getFullYear() + 1);
        } else {
            return res.status(400).json({ success: false, message: 'Invalid duration' });
        }

        // Update config
        config.expiryDate = newExpiryDate.toISOString().split('T')[0]; // Format as YYYY-MM-DD
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

        // Update hostings.json
        const userDataDir = path.join(__dirname, 'data');
        const hostingsFile = path.join(userDataDir, 'hostings.json');

        if (fs.existsSync(hostingsFile)) {
            let hostingsData = JSON.parse(fs.readFileSync(hostingsFile, 'utf8'));
            const hostingIndex = hostingsData.findIndex(h => h.id === hostId);

            if (hostingIndex !== -1) {
                hostingsData[hostingIndex].expiryDate = config.expiryDate;
                fs.writeFileSync(hostingsFile, JSON.stringify(hostingsData, null, 2));
            }
        }

        return res.json({ success: true, message: 'Hosting extended successfully', newExpiryDate: config.expiryDate });
    } catch (error) {
        console.error('Error extending hosting:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

async function getUserHostings(userId) {
    try {
        const user = await safeDBQuery(
            () => User.findOne({ discordId: userId }),
            'خطأ في العثور على المستخدم'
        );
        let byOwnerId = [];
        if (user) {
            byOwnerId = await safeDBQuery(
                () => Hosting.find({ owner: user._id }),
                'خطأ في العثور على استضافات المستخدم'
            );
        }
        // Fallback: populate and filter by owner.discordId in case of mismatched owner refs
        const populated = await safeDBQuery(
            () => Hosting.find().populate('owner'),
            'خطأ في جلب الاستضافات'
        );
        const byDiscordId = populated.filter(h => h.owner && h.owner.discordId === userId);
        // Merge unique by _id
        const map = new Map();
        [...byOwnerId, ...byDiscordId].forEach(h => map.set(h._id.toString(), h));
        let result = Array.from(map.values());
        // Additional Fallback: scan filesystem hostings if DB is empty for this user
        if (result.length === 0) {
            try {
                const hostingsDir = path.join(__dirname, 'hostings');
                if (fs.existsSync(hostingsDir)) {
                    const dirs = fs.readdirSync(hostingsDir).filter(d => fs.statSync(path.join(hostingsDir, d)).isDirectory());
                    for (const d of dirs) {
                        const cfgPath = path.join(hostingsDir, d, 'config.json');
                        if (fs.existsSync(cfgPath)) {
                            const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
                            if (cfg && cfg.owner && cfg.owner.id === userId) {
                                // synthesize a hosting-like object
                                result.push({
                                    _id: d,
                                    name: cfg.name || d,
                                    status: cfg.status || 'stopped',
                                    owner: { discordId: userId, username: cfg.owner.username || 'user', avatar: cfg.owner.avatar || 'https://cdn.discordapp.com/embed/avatars/0.png' },
                                    createdAt: cfg.createdAt ? new Date(cfg.createdAt) : new Date(),
                                    expiryDate: cfg.expiryDate || null,
                                    mainFile: cfg.mainFile || 'index.js',
                                    serviceType: cfg.serviceType || 'discord',
                                    port: cfg.port || 0
                                });
                            }
                        }
                    }
                }
            } catch (fsErr) {
                console.error('FS fallback error', fsErr);
            }
        }
        return result.map(h => ({
            id: h._id.toString(),
            name: h.name,
            status: h.status || 'stopped',
            owner: h.owner ? { id: h.owner.discordId, username: h.owner.username, avatar: h.owner.avatar } : (user ? { id: user.discordId, username: user.username, avatar: user.avatar } : null),
            createdAt: h.createdAt,
            expiryDate: h.expiryDate,
            plan: 'Basic',
            mainFile: h.mainFile || 'index.js',
            nodeVersion: '16',
            autoRestart: false,
            publicAccess: false,
            serviceType: h.serviceType || 'discord',
            port: h.port || 0
        }));
    } catch (e) {
        console.error('getUserHostings error', e);
        return [];
    }
}

async function getHostingById(hostId) {
    console.log('getHostingById called with:', hostId);
    try {
        // التحقق من أن hostId هو ObjectId صحيح قبل البحث في قاعدة البيانات
        if (Types.ObjectId.isValid(hostId)) {
            console.log('hostId is valid ObjectId, searching in MongoDB');
            const hosting = await safeDBQuery(
                () => Hosting.findById(hostId).populate('owner'),
                'خطأ في العثور على الاستضافة'
            );
            if (hosting) {
                console.log('Found hosting in MongoDB:', hosting.name);
                // احسب استخدام المساحة من مجلد الاستضافة الفعلي
                let usedStorage = '0 Bytes';
                try {
                    const hostingPath = getHostingPath(hostId);
                    const sizeBytes = getFolderSize(hostingPath);
                    usedStorage = formatBytes(sizeBytes);
                } catch { }
                return {
                    id: hosting._id.toString(),
                    name: hosting.name,
                    status: hosting.status || 'stopped',
                    owner: hosting.owner ? { id: hosting.owner.discordId || hosting.owner._id, username: hosting.owner.username, avatar: hosting.owner.avatar } : null,
                    createdAt: hosting.createdAt,
                    expiryDate: hosting.expiryDate,
                    usedStorage,
                    plan: 'Basic',
                    mainFile: hosting.mainFile || 'index.js',
                    nodeVersion: hosting.nodeVersion || '16',
                    autoRestart: false,
                    publicAccess: false,
                    serviceType: hosting.serviceType || 'discord',
                    port: hosting.port || 0
                };
            }
        }
    } catch (e) {
        console.error('Error in getHostingById MongoDB query:', e);
    }

    // Fallback to filesystem hostings (legacy IDs or non-ObjectId IDs)
    console.log('Falling back to filesystem search');
    try {
        const base = getHostingBasePath(hostId);
        const cfgPath = path.join(base, 'config.json');
        if (fs.existsSync(cfgPath)) {
            console.log('Found config.json in filesystem');
            const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
            // إذا كان هناك ملف PID نشط، اعتبر الحالة قيد التشغيل
            let status = cfg.status || 'stopped';
            try {
                const pidPath = path.join(base, 'process.pid');
                if (fs.existsSync(pidPath)) {
                    status = 'running';
                }
            } catch { }
            // احسب استخدام المساحة
            let usedStorage = '0 Bytes';
            try {
                const sizeBytes = getFolderSize(base);
                usedStorage = formatBytes(sizeBytes);
            } catch { }
            return {
                id: hostId,
                name: cfg.name || hostId,
                status,
                owner: cfg.owner ? { id: cfg.owner.id, username: cfg.owner.username, avatar: cfg.owner.avatar } : null,
                createdAt: cfg.createdAt || new Date().toISOString(),
                expiryDate: cfg.expiryDate || null,
                usedStorage,
                plan: 'Basic',
                mainFile: cfg.mainFile || 'index.js',
                nodeVersion: cfg.nodeVersion || '16',
                autoRestart: !!cfg.autoRestart,
                publicAccess: !!cfg.publicAccess,
                serviceType: cfg.serviceType || 'discord',
                port: cfg.port || 0
            };
        } else {
            console.log('No config.json found in filesystem');
        }
    } catch (e) {
        console.error('FS fallback getHostingById error', e);
    }
    console.log('No hosting found, returning null');
    return null;
}

async function getHostingStats() {
    const allHostings = await getAllHostings();
    const activeHostings = allHostings.filter(hosting => hosting.status === 'running');
    const userIds = new Set();
    allHostings.forEach(hosting => {
        if (hosting.owner && hosting.owner.id) {
            userIds.add(hosting.owner.id);
        }
    });

    // Calculate service type statistics
    const minecraftHostings = allHostings.filter(h => h.serviceType === 'minecraft');
    const discordHostings = allHostings.filter(h => h.serviceType === 'discord');
    const webHostings = allHostings.filter(h => h.serviceType === 'web');

    let totalStorage = 0;
    for (const hosting of allHostings) {
        try {
            const hostingPath = getHostingPath(hosting.id);
            totalStorage += getFolderSize(hostingPath);
        } catch (error) {
            console.error(`Error calculating storage for ${hosting.id}:`, error);
        }
    }
    const formattedStorage = formatBytes(totalStorage);
    return {
        totalHostings: allHostings.length,
        activeHostings: activeHostings.length,
        users: userIds.size,
        usedStorage: formattedStorage,
        minecraftHostings: minecraftHostings.length,
        discordHostings: discordHostings.length,
        webHostings: webHostings.length
    };
}

function getFolderSize(folderPath) {
    let totalSize = 0;

    if (!fs.existsSync(folderPath)) {
        return 0;
    }

    const files = fs.readdirSync(folderPath);

    for (const file of files) {
        const filePath = path.join(folderPath, file);
        const stats = fs.statSync(filePath);

        if (stats.isDirectory()) {
            totalSize += getFolderSize(filePath);
        } else {
            totalSize += stats.size;
        }
    }

    return totalSize;
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';

    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function setHostingStatus(hostId, status) {
    try {
        const cfgPath = path.join(getHostingPath(hostId), 'config.json');
        const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
        cfg.status = status;
        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    } catch (e) {
        console.error('Failed to update hosting status', hostId, status, e);
    }
}

async function getPublicUrl(hostId) {
    // Public URL policy: Only web hostings get a public URL under /sites/:username/:site
    const hosting = await getHostingById(hostId);
    if (!hosting) return null;
    if ((hosting.serviceType || 'discord') === 'web') {
        const username = hosting.owner?.username || 'user';
        const siteName = hosting.name;
        return `/sites/${encodeURIComponent(username)}/${encodeURIComponent(siteName)}`;
    }
    return null;
}

// Helper function to format time ago
function formatTimeAgo(date) {
    if (!date) return 'منذ وقت غير محدد';

    const now = new Date();
    const diff = now - new Date(date);
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `منذ ${days} يوم`;
    if (hours > 0) return `منذ ${hours} ساعة`;
    if (minutes > 0) return `منذ ${minutes} دقيقة`;
    return 'الآن';
}

// Helper to render with layout
function renderWithLayout(res, viewName, params = {}) {
    try {
        console.log('🎨 Rendering view:', viewName);
        console.log('📋 Params keys:', Object.keys(params));

        const viewsDir = app.get('views');
        console.log('📁 Views directory:', viewsDir);

        const viewPath = path.join(viewsDir, `${viewName}.ejs`);
        console.log('📄 View path:', viewPath);

        // Check if view file exists
        if (!fs.existsSync(viewPath)) {
            console.error('❌ View file not found:', viewPath);
            return res.status(500).send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>View Not Found</title>
                    <meta charset="utf-8">
                </head>
                <body>
                    <h1>❌ View Not Found</h1>
                    <p>View file <strong>${viewName}.ejs</strong> not found</p>
                    <p><a href="/">Go Home</a></p>
                </body>
                </html>
            `);
        }

        ejs.renderFile(viewPath, { ...params, formatTimeAgo }, (err, html) => {
            if (err) {
                console.error('❌ EJS render error:', err);
                return res.status(500).send(`
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <title>Render Error</title>
                        <meta charset="utf-8">
                    </head>
                    <body>
                        <h1>❌ Render Error</h1>
                        <p><strong>Error:</strong> ${err.message}</p>
                        <p><a href="/">Go Home</a></p>
                    </body>
                    </html>
                `);
            }

            console.log('✅ EJS rendered successfully, length:', html.length);

            // Render the layout
            res.render('layout', {
                ...params,
                body: html,
                script: params.script || '',
                formatTimeAgo
            });
        });
    } catch (error) {
        console.error(`❌ Error in renderWithLayout for ${viewName}:`, error);
        res.status(500).send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Internal Error</title>
                <meta charset="utf-8">
            </head>
            <body>
                <h1>❌ Internal Error</h1>
                <p><strong>Error:</strong> ${error.message}</p>
                <p><a href="/">Go Home</a></p>
            </body>
            </html>
        `);
    }
}

// Routes
app.get('/', async (req, res) => {
    const user = req.user || null;
    if (!user) {
        return renderWithLayout(res, 'home', { user: null, active: 'dashboard' });
    }
    const stats = await getHostingStats();
    const userHostings = await getUserHostings(user.id);

    // Get announcements (notifications with type 'announcement')
    const dbUser = await User.findOne({ discordId: user.id });
    const userId = dbUser ? dbUser._id : null;

    const announcements = await Notification.find({
        type: 'announcement',
        isActive: true,
        $and: [
            {
                $or: [
                    { targetType: 'all' },
                    ...(userId ? [{ targetUsers: userId }] : [])
                ]
            },
            {
                $or: [
                    { expiresAt: null },
                    { expiresAt: { $gt: new Date() } }
                ]
            }
        ]
    })
        .populate('createdBy', 'username avatar')
        .sort({ createdAt: -1 })
        .limit(10)
        .lean();

    // Format announcements for display
    const formattedAnnouncements = announcements.map(a => ({
        id: a._id.toString(),
        title: a.title,
        content: a.message,
        date: new Date(a.createdAt).toLocaleDateString('ar-EG', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        }),
        type: a.type,
        priority: a.priority,
        link: a.link
    }));

    // Get active giveaways
    const giveaways = (config.webGiveaways || []).filter(g => !g.ended && new Date(g.endDate) > new Date())
        .map(g => ({
            id: g.id,
            title: g.title || 'جائزة',
            endDate: new Date(g.endDate).toLocaleDateString('ar-EG'),
            participants: g.participants?.length || 0,
            maxParticipants: g.maxParticipants || 0,
            progressPercent: g.maxParticipants > 0 ? Math.min(100, ((g.participants?.length || 0) / g.maxParticipants) * 100) : 0
        }))
        .sort((a, b) => new Date(b.endDate) - new Date(a.endDate))
        .slice(0, 5);

    // Get user's notifications
    const userNotifications = userId ? await Notification.getUserNotifications(userId) : [];

    return renderWithLayout(res, 'dashboard', {
        user,
        stats,
        userHostings,
        announcements: formattedAnnouncements,
        giveaways,
        notifications: userNotifications,
        isAdmin: isAdmin(req),
        active: 'dashboard'
    });
});

// Get user notifications
function getUserNotifications(userId) {
    try {
        const notificationsDir = path.join(__dirname, 'data', 'notifications');
        const userNotificationsFile = path.join(notificationsDir, `${userId}.json`);

        if (!fs.existsSync(notificationsDir)) {
            fs.mkdirSync(notificationsDir, { recursive: true });
        }

        if (!fs.existsSync(userNotificationsFile)) {
            fs.writeFileSync(userNotificationsFile, JSON.stringify([], null, 2));
            return [];
        }

        return JSON.parse(fs.readFileSync(userNotificationsFile, 'utf8'));
    } catch (error) {
        console.error(`Error getting notifications for user ${userId}:`, error);
        return [];
    }
}

app.get('/hostings', async (req, res) => {
    const user = req.user || null;
    const userHostings = user ? await getUserHostings(user.id) : [];
    return renderWithLayout(res, 'hostings', {
        user,
        hostings: userHostings,
        isAdmin: isAdmin(req),
        active: 'hostings'
    });
});

app.get('/hosting/:id', async (req, res) => {
    const user = req.user || null;
    const hostId = req.params.id;
    const hosting = await getHostingById(hostId);

    if (!hosting) {
        return res.redirect('/hostings');
    }

    // Check if user owns this hosting (allow admin to access any hosting)
    if (user && hosting.owner && hosting.owner.id !== user.id && !isAdmin(req)) {
        return res.redirect('/hostings');
    }

    const publicUrl = await getPublicUrl(hostId);
    // احسب إحصائيات الاستخدام الحقيقية
    let cpuUsage = 0, memoryUsage = 0, diskUsage = 0;
    try {
        // CPU/Memory للنظام بالكامل كقيمة تقريبية
        const os = require('os');
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        memoryUsage = Math.round(((totalMem - freeMem) / totalMem) * 100);
        // CPU تقدير مبسط باستخدام متوسط الحمل (قد لا يكون دقيقاً على ويندوز)
        const loadAvg = os.loadavg()[0] || 0;
        const cpuCount = os.cpus().length || 1;
        cpuUsage = Math.min(100, Math.round((loadAvg / cpuCount) * 100));
        // Disk usage فقط لمجلد الاستضافة
        try {
            const base = getHostingBasePath(hostId);
            const usedBytes = getFolderSize(base);
            // نفترض الحصة المتاحة 1GB إذا لم توجد خطة
            const quotaBytes = 1024 * 1024 * 1024;
            diskUsage = Math.min(100, Math.round((usedBytes / quotaBytes) * 100));
        } catch { }
    } catch { }

    const publicIp = HostingService.getPublicIp();
    const hostAddress = hosting.proxyAddress || `${publicIp || 'localhost'}:${hosting.port || (hosting.serviceType === 'minecraft' ? 25565 : 80)}`;

    return renderWithLayout(res, 'hosting-detail', {
        user,
        hosting: { ...hosting, cpuUsage, memoryUsage, diskUsage },
        publicUrl,
        hostAddress,
        active: 'hostings'
    });
});

app.get('/console/:id', async (req, res) => {
    const user = req.user || null;
    const hostId = req.params.id;
    const hosting = await getHostingById(hostId);

    if (!hosting) {
        return res.redirect('/hostings');
    }

    // Check if user owns this hosting (allow admin to access any hosting)
    if (user && hosting.owner && hosting.owner.id !== user.id && !isAdmin(req)) {
        return res.redirect('/hostings');
    }

    return renderWithLayout(res, 'console', {
        user,
        hosting,
        active: 'console'
    });
});

// Very simple test route
app.get('/test', (req, res) => {
    res.send('Server is working!');
});

// Route for logs page (admin only)
app.get('/admin/logs', async (req, res) => {
    const user = req.user || null;

    // Check if user is owner using the proper function
    if (!isOwner(req)) {
        return res.status(403).send('Access denied. Owner privileges required.');
    }

    return renderWithLayout(res, 'logs', {
        user,
        active: 'logs'
    });
});

// API Routes for logs
app.get('/api/admin/logs', async (req, res) => {
    try {
        const user = req.user || null;

        // Check if user is owner using the proper function
        if (!isOwner(req)) {
            return res.status(403).json({ error: 'Access denied. Admin privileges required.' });
        }

        const {
            page = 1,
            limit = 50,
            search,
            userId,
            ipAddress,
            action,
            severity,
            status,
            startDate,
            endDate
        } = req.query;

        const skip = (page - 1) * limit;

        // بناء الفلتر
        const filter = {};

        if (userId) filter.userId = userId;
        if (ipAddress) filter.ipAddress = new RegExp(ipAddress, 'i');
        if (action) filter.action = action;
        if (severity) filter.severity = severity;
        if (status) filter.status = status;

        if (startDate || endDate) {
            filter.timestamp = {};
            if (startDate) filter.timestamp.$gte = new Date(startDate);
            if (endDate) filter.timestamp.$lte = new Date(endDate);
        }

        if (search) {
            filter.$or = [
                { description: new RegExp(search, 'i') },
                { username: new RegExp(search, 'i') },
                { ipAddress: new RegExp(search, 'i') },
                { tags: { $in: [new RegExp(search, 'i')] } }
            ];
        }

        // جلب السجلات
        const logs = await Log.find(filter)
            .sort({ timestamp: -1 })
            .limit(parseInt(limit))
            .skip(skip);

        // جلب العدد الإجمالي
        const total = await Log.countDocuments(filter);
        const totalPages = Math.ceil(total / limit);

        res.json({
            success: true,
            logs: logs,
            pagination: {
                currentPage: parseInt(page),
                totalPages: totalPages,
                total: total,
                limit: parseInt(limit)
            }
        });

    } catch (error) {
        console.error('Error fetching logs:', error);
        res.status(500).json({ error: 'خطأ في جلب السجلات' });
    }
});

// API for logs statistics
app.get('/api/admin/logs/stats', async (req, res) => {
    try {
        const user = req.user || null;

        // Check if user is owner using the proper function
        if (!isOwner(req)) {
            return res.status(403).json({ error: 'Access denied. Admin privileges required.' });
        }

        const { startDate, endDate } = req.query;

        const filter = {};
        if (startDate || endDate) {
            filter.timestamp = {};
            if (startDate) filter.timestamp.$gte = new Date(startDate);
            if (endDate) filter.timestamp.$lte = new Date(endDate);
        }

        const stats = await Log.aggregate([
            { $match: filter },
            {
                $group: {
                    _id: null,
                    total: { $sum: 1 },
                    uniqueUsers: { $addToSet: '$userId' },
                    uniqueIPs: { $addToSet: '$ipAddress' },
                    errorsCount: {
                        $sum: {
                            $cond: [
                                { $in: ['$severity', ['error', 'critical']] },
                                1,
                                0
                            ]
                        }
                    }
                }
            },
            {
                $project: {
                    total: 1,
                    uniqueUsersCount: { $size: '$uniqueUsers' },
                    uniqueIPsCount: { $size: '$uniqueIPs' },
                    errorsCount: 1
                }
            }
        ]);

        const result = stats[0] || {
            total: 0,
            uniqueUsersCount: 0,
            uniqueIPsCount: 0,
            errorsCount: 0
        };

        res.json(result);

    } catch (error) {
        console.error('Error fetching logs stats:', error);
        res.status(500).json({ error: 'خطأ في جلب إحصائيات السجلات' });
    }
});

// API for exporting logs
app.get('/api/admin/logs/export', async (req, res) => {
    try {
        const user = req.user || null;

        // Check if user is owner using the proper function
        if (!isOwner(req)) {
            return res.status(403).json({ error: 'Access denied. Admin privileges required.' });
        }

        const { format = 'csv', ...filters } = req.query;

        // بناء الفلتر
        const filter = {};

        if (filters.userId) filter.userId = filters.userId;
        if (filters.ipAddress) filter.ipAddress = new RegExp(filters.ipAddress, 'i');
        if (filters.action) filter.action = filters.action;
        if (filters.severity) filter.severity = filters.severity;
        if (filters.status) filter.status = filters.status;

        if (filters.startDate || filters.endDate) {
            filter.timestamp = {};
            if (filters.startDate) filter.timestamp.$gte = new Date(filters.startDate);
            if (filters.endDate) filter.timestamp.$lte = new Date(filters.endDate);
        }

        if (filters.search) {
            filter.$or = [
                { description: new RegExp(filters.search, 'i') },
                { username: new RegExp(filters.search, 'i') },
                { ipAddress: new RegExp(filters.search, 'i') },
                { tags: { $in: [new RegExp(filters.search, 'i')] } }
            ];
        }

        // جلب السجلات
        const logs = await Log.find(filter)
            .sort({ timestamp: -1 })
            .limit(10000); // حد أقصى 10000 سجل

        if (format === 'csv') {
            // تصدير CSV
            const csvHeader = 'التاريخ,المستخدم,IP,البلد,المدينة,العملية,الوصف,المستوى,الحالة,الطريقة,كود الحالة\n';
            const csvRows = logs.map(log => {
                return [
                    log.timestamp.toISOString(),
                    log.username || 'مجهول',
                    log.ipAddress,
                    log.country,
                    log.city,
                    log.action,
                    log.description.replace(/,/g, ';'),
                    log.severity,
                    log.status,
                    log.method,
                    log.statusCode
                ].join(',');
            }).join('\n');

            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename=logs-${new Date().toISOString().split('T')[0]}.csv`);
            res.send('\ufeff' + csvHeader + csvRows); // BOM for UTF-8

        } else if (format === 'json') {
            // تصدير JSON
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', `attachment; filename=logs-${new Date().toISOString().split('T')[0]}.json`);
            res.json({
                exportedAt: new Date().toISOString(),
                total: logs.length,
                logs: logs
            });
        } else {
            res.status(400).json({ error: 'تنسيق غير مدعوم' });
        }

    } catch (error) {
        console.error('Error exporting logs:', error);
        res.status(500).json({ error: 'خطأ في تصدير السجلات' });
    }
});

// API for clearing old logs
app.delete('/api/admin/logs/clear-old', async (req, res) => {
    try {
        const user = req.user || null;

        // Check if user is owner using the proper function
        if (!isOwner(req)) {
            return res.status(403).json({ error: 'Access denied. Admin privileges required.' });
        }

        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const result = await Log.deleteMany({
            timestamp: { $lt: thirtyDaysAgo }
        });

        res.json({
            success: true,
            deletedCount: result.deletedCount,
            message: `تم مسح ${result.deletedCount} سجل قديم`
        });

    } catch (error) {
        console.error('Error clearing old logs:', error);
        res.status(500).json({ error: 'خطأ في مسح السجلات القديمة' });
    }
});

// API Routes for startup functionality
app.get('/api/hosting/:id/files', async (req, res) => {
    try {
        const hostId = req.params.id;
        const basePath = getHostingBasePath(hostId);

        if (!fs.existsSync(basePath)) {
            return res.json([]);
        }

        const files = fs.readdirSync(basePath).filter(file => {
            const filePath = path.join(basePath, file);
            return fs.statSync(filePath).isFile();
        });

        res.json(files);
    } catch (error) {
        console.error('Error getting files:', error);
        res.status(500).json({ error: 'خطأ في جلب الملفات' });
    }
});

app.get('/api/hosting/:id/packages', async (req, res) => {
    try {
        const hostId = req.params.id;
        const basePath = getHostingBasePath(hostId);
        const packageJsonPath = path.join(basePath, 'package.json');

        if (!fs.existsSync(packageJsonPath)) {
            return res.json([]);
        }

        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        const packages = [];

        if (packageJson.dependencies) {
            Object.entries(packageJson.dependencies).forEach(([name, version]) => {
                packages.push({ name, version });
            });
        }

        res.json(packages);
    } catch (error) {
        console.error('Error getting packages:', error);
        res.status(500).json({ error: 'خطأ في جلب المكتبات' });
    }
});

app.post('/api/hosting/:id/install-packages', async (req, res) => {
    try {
        const hostId = req.params.id;
        const { packages } = req.body;
        const basePath = getHostingBasePath(hostId);

        if (!packages || packages.length === 0) {
            return res.status(400).json({ error: 'لا توجد مكتبات لتثبيتها' });
        }

        // إنشاء package.json إذا لم يكن موجوداً
        const packageJsonPath = path.join(basePath, 'package.json');
        let packageJson = {};

        if (fs.existsSync(packageJsonPath)) {
            packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        }

        if (!packageJson.dependencies) {
            packageJson.dependencies = {};
        }

        // إضافة المكتبات
        packages.forEach(pkg => {
            packageJson.dependencies[pkg.name] = pkg.version || 'latest';
        });

        // حفظ package.json
        fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));

        // تثبيت المكتبات
        const { exec } = require('child_process');
        exec('npm install', { cwd: basePath }, (error, stdout, stderr) => {
            if (error) {
                console.error('Error installing packages:', error);
                return res.status(500).json({ error: 'خطأ في تثبيت المكتبات' });
            }

            res.json({ success: true, message: 'تم تثبيت المكتبات بنجاح' });
        });

    } catch (error) {
        console.error('Error installing packages:', error);
        res.status(500).json({ error: 'خطأ في تثبيت المكتبات' });
    }
});

app.post('/api/hosting/:id/main-file', async (req, res) => {
    try {
        const hostId = req.params.id;
        const { mainFile } = req.body;
        const basePath = getHostingBasePath(hostId);

        if (!mainFile) {
            return res.status(400).json({ error: 'يرجى تحديد الملف الرئيسي' });
        }

        // التحقق من وجود الملف
        const filePath = path.join(basePath, mainFile);
        if (!fs.existsSync(filePath)) {
            return res.status(400).json({ error: 'الملف غير موجود' });
        }

        // تحديث قاعدة البيانات
        await safeDBQuery(
            () => Hosting.findByIdAndUpdate(hostId, { mainFile: mainFile }),
            'خطأ في تحديث الملف الرئيسي'
        );

        // تحديث ملفات التكوين
        const configPath = path.join(basePath, 'config.json');
        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            config.mainFile = mainFile;
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        }

        res.json({ success: true, message: 'تم تحديث الملف الرئيسي بنجاح' });

    } catch (error) {
        console.error('Error updating main file:', error);
        res.status(500).json({ error: 'خطأ في تحديث الملف الرئيسي' });
    }
});

app.post('/api/hosting/:id/upload-bat', upload.single('batFile'), async (req, res) => {
    try {
        const hostId = req.params.id;
        const basePath = getHostingBasePath(hostId);

        if (!req.file) {
            return res.status(400).json({ error: 'يرجى اختيار ملف .bat' });
        }

        if (!req.file.originalname.endsWith('.bat')) {
            return res.status(400).json({ error: 'يرجى اختيار ملف .bat فقط' });
        }

        // نسخ الملف إلى مجلد الاستضافة
        const batPath = path.join(basePath, 'start.bat');
        fs.copyFileSync(req.file.path, batPath);

        // حذف الملف المؤقت
        fs.unlinkSync(req.file.path);

        res.json({ success: true, message: 'تم رفع ملف البداية بنجاح' });

    } catch (error) {
        console.error('Error uploading bat file:', error);
        res.status(500).json({ error: 'خطأ في رفع الملف' });
    }
});

app.delete('/api/hosting/:id/remove-bat', async (req, res) => {
    try {
        const hostId = req.params.id;
        const basePath = getHostingBasePath(hostId);
        const batPath = path.join(basePath, 'start.bat');

        if (fs.existsSync(batPath)) {
            fs.unlinkSync(batPath);
        }

        res.json({ success: true, message: 'تم حذف ملف البداية بنجاح' });

    } catch (error) {
        console.error('Error removing bat file:', error);
        res.status(500).json({ error: 'خطأ في حذف الملف' });
    }
});

app.get('/api/hosting/:id/advanced-settings', async (req, res) => {
    try {
        const hostId = req.params.id;
        const basePath = getHostingBasePath(hostId);
        const settingsPath = path.join(basePath, 'startup-settings.json');

        if (!fs.existsSync(settingsPath)) {
            return res.json({ envVars: '', preCommands: '' });
        }

        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        res.json(settings);

    } catch (error) {
        console.error('Error getting advanced settings:', error);
        res.status(500).json({ error: 'خطأ في جلب الإعدادات' });
    }
});

app.post('/api/hosting/:id/advanced-settings', async (req, res) => {
    try {
        const hostId = req.params.id;
        const { envVars, preCommands } = req.body;
        const basePath = getHostingBasePath(hostId);
        const settingsPath = path.join(basePath, 'startup-settings.json');

        const settings = {
            envVars: envVars || '',
            preCommands: preCommands || '',
            updatedAt: new Date().toISOString()
        };

        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

        res.json({ success: true, message: 'تم حفظ الإعدادات بنجاح' });

    } catch (error) {
        console.error('Error saving advanced settings:', error);
        res.status(500).json({ error: 'خطأ في حفظ الإعدادات' });
    }
});

app.post('/api/hosting/:id/test-config', async (req, res) => {
    try {
        const hostId = req.params.id;
        const basePath = getHostingBasePath(hostId);

        // التحقق من وجود الملفات الأساسية
        const checks = [];

        // فحص package.json
        const packageJsonPath = path.join(basePath, 'package.json');
        if (fs.existsSync(packageJsonPath)) {
            checks.push('✅ package.json موجود');
        } else {
            checks.push('⚠️ package.json غير موجود');
        }

        // فحص الملف الرئيسي
        const hosting = await getHostingById(hostId);
        const mainFile = hosting.mainFile || 'index.js';
        const mainFilePath = path.join(basePath, mainFile);
        if (fs.existsSync(mainFilePath)) {
            checks.push(`✅ الملف الرئيسي (${mainFile}) موجود`);
        } else {
            checks.push(`❌ الملف الرئيسي (${mainFile}) غير موجود`);
        }

        // فحص node_modules
        const nodeModulesPath = path.join(basePath, 'node_modules');
        if (fs.existsSync(nodeModulesPath)) {
            checks.push('✅ node_modules موجود');
        } else {
            checks.push('⚠️ node_modules غير موجود - قم بتثبيت المكتبات');
        }

        res.json({
            success: true,
            message: 'تم اختبار الإعدادات',
            checks: checks
        });

    } catch (error) {
        console.error('Error testing config:', error);
        res.status(500).json({ error: 'خطأ في اختبار الإعدادات' });
    }
});

// Web Proxy Route (Removed)

// Files picker route (no id) - يجب أن يأتي قبل /files/:id
app.get('/files', async (req, res) => {
    const user = req.user || null;
    if (!user) return res.redirect('/');
    const userHostings = await getUserHostings(user.id);
    if (!userHostings || userHostings.length === 0) {
        return renderWithLayout(res, 'hostings', { user, hostings: [], active: 'files' });
    }
    if (userHostings.length === 1) {
        return res.redirect(`/files/${userHostings[0].id}`);
    }
    return renderWithLayout(res, 'files-picker', { user, hostings: userHostings, isAdmin: isAdmin(req), active: 'files' });
});

app.get('/files/:id', async (req, res) => {
    const user = req.user || null;
    const hostId = req.params.id;
    console.log('Files route accessed with hostId:', hostId);
    console.log('User:', user ? user.username : 'No user');
    console.log('Is admin:', isAdmin(req));

    const hosting = await getHostingById(hostId);
    console.log('Found hosting:', hosting ? 'Yes' : 'No');

    if (!hosting) {
        console.log('No hosting found, redirecting to /hostings');
        return res.redirect('/hostings');
    }

    // Check if user owns this hosting (allow admin to access any hosting)
    if (user && hosting.owner && hosting.owner.id !== user.id && !isAdmin(req)) {
        console.log('User does not own hosting and is not admin, redirecting');
        return res.redirect('/hostings');
    }

    console.log('Rendering files page for hosting:', hosting.name);
    return renderWithLayout(res, 'files', {
        user,
        hosting,
        isAdmin: isAdmin(req),
        active: 'files'
    });
});

// Marketing pages
app.get('/pricing', (req, res) => {
    const user = req.user || null;
    return renderWithLayout(res, 'pricing', { user, active: 'pricing', config });
});

// Buy hosting page
app.get('/buy-hosting', (req, res) => {
    const user = req.user || null;
    return renderWithLayout(res, 'buy-hosting', { user, active: 'pricing', config });
});

app.get('/support', (req, res) => {
    const user = req.user || null;

    // Get user's tickets if logged in
    let userTickets = [];
    if (user) {
        const allTickets = readTickets();
        userTickets = allTickets.filter(ticket => ticket.user && ticket.user.id === user.id);
    }

    return renderWithLayout(res, 'support', { user, tickets: userTickets, active: 'support' });
});

// Support chat for a specific ticket
app.get('/support/ticket/:id', (req, res) => {
    const user = req.user;
    if (!user) return res.redirect('/auth/discord');

    const ticketId = req.params.id;
    const tickets = readTickets();
    const ticket = tickets.find(t => t.id === ticketId);

    if (!ticket) {
        return res.status(404).send('Ticket not found');
    }

    // Check if user is authorized to view this ticket (owner or admin)
    const isOwner = ticket.user && ticket.user.id === user.id;
    const isAdmin = ADMIN_USER_IDS.has(user.id);

    if (!isOwner && !isAdmin) {
        return res.status(403).send('You are not authorized to view this ticket');
    }

    return renderWithLayout(res, 'support-chat', {
        user,
        ticket,
        isAdmin,
        active: 'support'
    });
});

// Public server info (for homepage UI)
// Removed /api/server-info – IP info is no longer exposed

// Console picker route (no id)
app.get('/console', async (req, res) => {
    const user = req.user || null;
    if (!user) return res.redirect('/');
    const userHostings = await getUserHostings(user.id);
    if (!userHostings || userHostings.length === 0) {
        return renderWithLayout(res, 'hostings', { user, hostings: [], active: 'console' });
    }
    if (userHostings.length === 1) {
        return res.redirect(`/console/${userHostings[0].id}`);
    }
    return renderWithLayout(res, 'console-picker', { user, hostings: userHostings, isAdmin: isAdmin(req), active: 'console' });
});

// Lightweight storage optimization endpoint
// Removes node_modules, .git, temporary and log files over a size threshold
app.post('/api/optimize/storage', (req, res) => {
    try {
        const hostingsDir = path.join(__dirname, 'hostings');
        if (!fs.existsSync(hostingsDir)) return res.json({ success: true, removedBytes: 0 });

        const maxLogSizeBytes = 5 * 1024 * 1024; // 5MB
        let removedBytes = 0;

        const removeIfExists = (target) => {
            if (fs.existsSync(target)) {
                removedBytes += getFolderSize(target);
                fs.removeSync(target);
            }
        };

        const walk = (dir) => {
            const entries = fs.readdirSync(dir);
            for (const name of entries) {
                const full = path.join(dir, name);
                const stat = fs.statSync(full);
                if (stat.isDirectory()) {
                    // remove heavy dev folders
                    if (name === 'node_modules' || name === '.git' || name === '.cache') {
                        removeIfExists(full);
                        continue;
                    }
                    walk(full);
                } else {
                    // remove big logs and temporary files
                    const lower = name.toLowerCase();
                    if (lower.endsWith('.log') && stat.size > maxLogSizeBytes) {
                        removedBytes += stat.size;
                        fs.unlinkSync(full);
                        continue;
                    }
                    if (lower.endsWith('.tmp') || lower.endsWith('.temp') || lower.endsWith('.DS_Store'.toLowerCase())) {
                        removedBytes += stat.size;
                        fs.unlinkSync(full);
                        continue;
                    }
                }
            }
        };

        walk(hostingsDir);

        return res.json({ success: true, removedBytes, removedHuman: formatBytes(removedBytes) });
    } catch (err) {
        console.error('optimize error:', err);
        return res.status(500).json({ success: false, message: 'optimization failed' });
    }
});

// Public access routes
app.get('/public/:id', (req, res) => {
    const hostId = req.params.id;
    const hosting = getHostingById(hostId);

    if (!hosting || !hosting.publicAccess) {
        return res.status(404).send('Hosting not found or access denied');
    }
    // read last logs
    let logs = [];
    try {
        const logPath = path.join(getHostingPath(hostId), 'bot.log');
        if (fs.existsSync(logPath)) {
            logs = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
        }
    } catch { }
    return renderWithLayout(res, 'public-hosting', { hosting, logs });
});

// API Routes
app.get('/api/hosting/:id/logs', async (req, res) => {
    const hostId = req.params.id;
    try {
        let hosting = null;
        if (Types.ObjectId.isValid(hostId)) {
            hosting = await Hosting.findById(hostId);
        }
        if (!hosting) {
            // Fallback to filesystem logs if hosting id is not ObjectId (legacy id like "kingo2")
            const logPath = path.join(getHostingBasePath(hostId), 'bot.log');
            try {
                if (fs.existsSync(logPath)) {
                    const logs = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
                    return res.json({ success: true, logs });
                }
            } catch (e) { }
            return res.json({ success: true, logs: [] });
        }
        const logs = Array.isArray(hosting.logs) ? hosting.logs : [];
        return res.json({ success: true, logs });
    } catch (error) {
        console.error('Error reading logs:', error);
        return res.json({ success: false, message: 'Error reading logs' });
    }
});

// In-memory process tracking for filesystem-based hostings (non-ObjectId IDs)
const fsHostProcesses = new Map();

async function updateFsHostingStatus(hostId, status) {
    try {
        const cfgPath = path.join(getHostingPath(hostId), 'config.json');
        let cfg = {};
        if (fs.existsSync(cfgPath)) {
            try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) || {}; } catch { }
        }
        cfg.status = status;
        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    } catch (e) {
        console.error('updateFsHostingStatus error', e);
    }
}

async function startFsHosting(hostId) {
    const basePath = getHostingBasePath(hostId);

    // قراءة البيانات المحدثة من قاعدة البيانات أولاً
    let hosting = await getHostingById(hostId);
    let main = 'index.js';
    let serviceType = 'discord';

    if (hosting && hosting.mainFile) {
        main = hosting.mainFile;
        serviceType = hosting.serviceType || 'discord';
    } else {
        // fallback إلى config.json
        const cfg = getHostingData(hostId) || {};
        main = cfg.mainFile || 'index.js';
        serviceType = cfg.serviceType || 'discord';
    }
    let nodeVersion = '16';
    if (hosting && hosting.nodeVersion) {
        nodeVersion = hosting.nodeVersion;
    } else {
        const cfg = getHostingData(hostId) || {};
        nodeVersion = cfg.nodeVersion || '16';
    }

    let command = getNodeCommandForVersion(nodeVersion);
    let args = [main];

    // قراءة siteMode من config.json
    const cfg = getHostingData(hostId) || {};
    if (serviceType === 'web' && cfg.siteMode === 'html') {
        // For static sites, just mark running
        await updateFsHostingStatus(hostId, 'running');
        return;
    }
    return new Promise((resolve, reject) => {
        try {
            // استخدام detached: true لجعل العملية مستقلة
            const child = spawn(command, args, {
                cwd: basePath,
                stdio: 'pipe',
                shell: false,
                detached: true,  // جعل العملية مستقلة
                windowsHide: true
            });

            // فصل العملية عن العملية الأب
            child.unref();
            fsHostProcesses.set(hostId, child);
            updateFsHostingStatus(hostId, 'running');

            // حفظ PID في ملف للرجوع إليه لاحقاً
            const pidPath = path.join(basePath, 'process.pid');
            try {
                fs.writeFileSync(pidPath, child.pid.toString());
            } catch (e) {
                console.error('Error writing PID file:', e);
            }

            // إرسال مخرجات البوت إلى الكونسل
            child.stdout.on('data', (data) => {
                const output = data.toString();
                console.log(`[${hostId}] ${output}`);

                // إرسال المخرجات إلى جميع المستخدمين في الكونسل
                io.to(`console-${hostId}`).emit('console-output', output);

                // حفظ المخرجات في ملف السجل
                const logPath = path.join(basePath, 'bot.log');
                try {
                    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${output}`);
                } catch (e) {
                    console.error('Error writing to log file:', e);
                }
            });

            child.stderr.on('data', (data) => {
                const output = data.toString();
                console.error(`[${hostId}] ${output}`);

                // إرسال الأخطاء إلى الكونسل
                io.to(`console-${hostId}`).emit('console-output', `ERROR: ${output}`);

                // حفظ الأخطاء في ملف السجل
                const logPath = path.join(basePath, 'bot.log');
                try {
                    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ERROR: ${output}`);
                } catch (e) {
                    console.error('Error writing to log file:', e);
                }
            });

            child.on('exit', (code) => {
                console.log(`[${hostId}] Process exited with code ${code}`);
                io.to(`console-${hostId}`).emit('console-output', `Process exited with code ${code}`);
                fsHostProcesses.delete(hostId);
                updateFsHostingStatus(hostId, 'stopped');

                // حذف ملف PID
                const pidPath = path.join(basePath, 'process.pid');
                try {
                    if (fs.existsSync(pidPath)) {
                        fs.unlinkSync(pidPath);
                    }
                } catch (e) {
                    console.error('Error deleting PID file:', e);
                }

                // إرسال تحديث حالة البوت
                io.to(`console-${hostId}`).emit('bot-status-changed', { hostId, status: 'stopped' });
            });

            child.on('error', (error) => {
                console.error(`[${hostId}] Process error:`, error);
                io.to(`console-${hostId}`).emit('console-output', `Process error: ${error.message}`);
                fsHostProcesses.delete(hostId);
                updateFsHostingStatus(hostId, 'stopped');

                // حذف ملف PID
                const pidPath = path.join(basePath, 'process.pid');
                try {
                    if (fs.existsSync(pidPath)) {
                        fs.unlinkSync(pidPath);
                    }
                } catch (e) {
                    console.error('Error deleting PID file:', e);
                }
            });

            resolve();
        } catch (e) {
            reject(e);
        }
    });
}

async function stopFsHosting(hostId) {
    const child = fsHostProcesses.get(hostId);
    if (child && !child.killed) {
        try {
            child.kill();
        } catch (e) {
            console.error('Error killing process:', e);
        }
        fsHostProcesses.delete(hostId);
    }

    // محاولة إيقاف العملية باستخدام PID إذا لم تكن في الذاكرة
    const basePath = getHostingBasePath(hostId);
    const pidPath = path.join(basePath, 'process.pid');
    if (fs.existsSync(pidPath)) {
        try {
            const pid = parseInt(fs.readFileSync(pidPath, 'utf8'));
            if (pid && process.platform === 'win32') {
                // على Windows، استخدام taskkill
                const { exec } = require('child_process');
                exec(`taskkill /PID ${pid} /F`, (error) => {
                    if (error) {
                        console.log(`Process ${pid} may have already stopped`);
                    } else {
                        console.log(`Successfully killed process ${pid}`);
                    }
                });
            } else if (pid) {
                // على Unix-like systems، استخدام kill
                process.kill(pid, 'SIGTERM');
            }
        } catch (e) {
            console.error('Error killing process by PID:', e);
        }

        // حذف ملف PID
        try {
            fs.unlinkSync(pidPath);
        } catch (e) {
            console.error('Error deleting PID file:', e);
        }
    }

    await updateFsHostingStatus(hostId, 'stopped');
}

async function restartFsHosting(hostId) {
    await stopFsHosting(hostId);
    await startFsHosting(hostId);
}

function getNodeCommandForVersion(version) {
    try {
        const v = String(version).replace(/[^0-9]/g, '');
        if (!v) return 'node';
        const envMap = {
            '14': process.env.NODE_14_PATH,
            '16': process.env.NODE_16_PATH,
            '18': process.env.NODE_18_PATH,
            '20': process.env.NODE_20_PATH
        };
        const candidate = envMap[v];
        if (candidate && fs.existsSync(candidate)) {
            return candidate;
        }
    } catch { }
    // fallback to default
    return 'node';
}

// دالة لاستعادة العمليات عند إعادة تشغيل الخادم
async function restoreHostingProcesses() {
    console.log('🔄 محاولة استعادة العمليات المفقودة...');

    try {
        const hostingsDir = path.join(__dirname, 'hostings');
        if (!fs.existsSync(hostingsDir)) {
            return;
        }

        const hostDirs = fs.readdirSync(hostingsDir).filter(dir => {
            const dirPath = path.join(hostingsDir, dir);
            return fs.statSync(dirPath).isDirectory();
        });

        for (const hostDir of hostDirs) {
            const hostPath = path.join(hostingsDir, hostDir);
            const configPath = path.join(hostPath, 'config.json');
            const pidPath = path.join(hostPath, 'process.pid');

            if (fs.existsSync(configPath) && fs.existsSync(pidPath)) {
                try {
                    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                    const pid = parseInt(fs.readFileSync(pidPath, 'utf8'));

                    // التحقق من أن العملية لا تزال تعمل
                    if (pid && process.platform === 'win32') {
                        const { exec } = require('child_process');
                        exec(`tasklist /FI "PID eq ${pid}"`, (error, stdout) => {
                            if (!error && stdout.includes(pid.toString())) {
                                console.log(`✅ استعادة العملية ${hostDir} (PID: ${pid})`);
                                // إضافة العملية إلى الذاكرة
                                fsHostProcesses.set(hostDir, { pid: pid, killed: false });
                                updateFsHostingStatus(hostDir, 'running');
                            } else {
                                // حذف ملف PID إذا لم تعد العملية تعمل
                                fs.unlinkSync(pidPath);
                            }
                        });
                    }
                } catch (e) {
                    console.error(`خطأ في استعادة العملية ${hostDir}:`, e);
                }
            }
        }
    } catch (e) {
        console.error('خطأ في استعادة العمليات:', e);
    }
}

app.post('/api/hosting/:id/start', async (req, res) => {
    const hostId = req.params.id;

    try {
        const hosting = await Hosting.findById(hostId);
        const isMinecraft = hosting && hosting.serviceType === 'minecraft';
        const startMsg = isMinecraft ? 'يتم تشغيل السيرفر... (Starting server...)' : 'يتم تشغيل البوت... (Starting bot...)';
        const successMsg = isMinecraft ? 'تم تشغيل السيرفر بنجاح (Server started successfully)' : 'تم تشغيل البوت بنجاح (Bot started successfully)';

        try { io.to(`console-${hostId}`).emit('console-output', { type: 'info', message: startMsg }); } catch { }

        if (Types.ObjectId.isValid(hostId)) {
            await HostingService.startHosting(hostId);
        } else {
            await startFsHosting(hostId);
        }

        try { io.to(`console-${hostId}`).emit('bot-status-changed', { hostId, status: 'running' }); } catch { }
        try { io.to(`console-${hostId}`).emit('console-output', { type: 'success', message: successMsg }); } catch { }
        res.json({ success: true });
    } catch (error) {
        console.error('Error starting hosting:', error);
        const hosting = await Hosting.findById(hostId).catch(() => null);
        const isMinecraft = hosting && hosting.serviceType === 'minecraft';
        const errorMsgPrefix = isMinecraft ? 'Error starting server' : 'Error starting bot';

        try { io.to(`console-${hostId}`).emit('console-output', { type: 'error', message: `${errorMsgPrefix}: ${error.message}` }); } catch { }
        res.json({ success: false, message: error.message });
    }
});

app.post('/api/hosting/:id/stop', async (req, res) => {
    const hostId = req.params.id;

    try {
        try { io.to(`console-${hostId}`).emit('console-output', { type: 'info', message: 'Stopping bot...' }); } catch { }
        if (Types.ObjectId.isValid(hostId)) {
            await HostingService.stopHosting(hostId);
        } else {
            await stopFsHosting(hostId);
        }
        try { io.to(`console-${hostId}`).emit('bot-status-changed', { hostId, status: 'stopped' }); } catch { }
        try { io.to(`console-${hostId}`).emit('console-output', { type: 'success', message: 'Bot stopped successfully' }); } catch { }
        res.json({ success: true });
    } catch (error) {
        console.error('Error stopping hosting:', error);
        try { io.to(`console-${hostId}`).emit('console-output', { type: 'error', message: `Error stopping bot: ${error.message}` }); } catch { }
        res.json({ success: false, message: error.message });
    }
});

app.post('/api/hosting/:id/restart', async (req, res) => {
    const hostId = req.params.id;

    try {
        try { io.to(`console-${hostId}`).emit('console-output', { type: 'info', message: 'Restarting bot...' }); } catch { }
        if (Types.ObjectId.isValid(hostId)) {
            await HostingService.restartHosting(hostId);
        } else {
            await restartFsHosting(hostId);
        }
        try { io.to(`console-${hostId}`).emit('console-output', { type: 'success', message: 'Bot restarted successfully' }); } catch { }
        res.json({ success: true });
    } catch (error) {
        console.error('Error restarting hosting:', error);
        try { io.to(`console-${hostId}`).emit('console-output', { type: 'error', message: `Error restarting bot: ${error.message}` }); } catch { }
        res.json({ success: false, message: error.message });
    }
});

app.post('/api/hosting/:id/clear-logs', async (req, res) => {
    const hostId = req.params.id;
    try {
        const hosting = await Hosting.findById(hostId);
        if (!hosting) return res.json({ success: false, message: 'Hosting not found' });
        hosting.logs = [];
        await hosting.save();
        res.json({ success: true });
    } catch (error) {
        console.error('Error clearing logs:', error);
        res.json({ success: false, message: error.message });
    }
});

// معالج تنفيذ الأوامر في الكونسل - محسن ليدعم جميع الأوامر
app.post('/api/hosting/:id/command', async (req, res) => {
    const hostId = req.params.id;
    const { command } = req.body;

    try {
        const basePath = getHostingBasePath(hostId);
        const { spawn } = require('child_process');

        console.log(`🚀 تنفيذ الأمر: "${command}" في المسار: ${basePath}`);

        // تقسيم الأمر إلى أجزاء للتعامل مع المعاملات بشكل صحيح
        const commandParts = command.trim().split(/\s+/);
        const mainCommand = commandParts[0];
        const args = commandParts.slice(1);

        console.log(`📋 الأمر الرئيسي: ${mainCommand}`);
        console.log(`📋 المعاملات: ${JSON.stringify(args)}`);

        // إعدادات مختلفة للأوامر المختلفة
        let spawnOptions = {
            cwd: basePath,
            stdio: 'pipe',
            shell: true,
            env: { ...process.env }
        };

        // إعدادات خاصة لأوامر npm
        if (mainCommand === 'npm' || mainCommand === 'yarn' || mainCommand === 'pnpm') {
            spawnOptions.env.NODE_ENV = 'production';
            spawnOptions.env.npm_config_progress = 'false';
            spawnOptions.env.npm_config_loglevel = 'warn';
        }

        // تنفيذ الأمر
        const child = spawn(command, [], spawnOptions);

        let output = '';
        let errorOutput = '';

        // معالجة المخرجات
        child.stdout.on('data', (data) => {
            const dataStr = data.toString();
            output += dataStr;
            console.log(`📤 stdout: ${dataStr.substring(0, 100)}...`);
        });

        child.stderr.on('data', (data) => {
            const dataStr = data.toString();
            errorOutput += dataStr;
            console.log(`📤 stderr: ${dataStr.substring(0, 100)}...`);
        });

        // معالجة انتهاء العملية
        child.on('close', (code) => {
            console.log(`✅ انتهى الأمر بالكود: ${code}`);

            const result = {
                success: code === 0,
                output: output,
                error: errorOutput,
                exitCode: code,
                command: command,
                timestamp: new Date().toISOString()
            };

            // إرسال النتيجة
            res.json(result);

            // إرسال المخرجات عبر Socket.IO للعرض المباشر
            if (output) {
                io.to(`console-${hostId}`).emit('console-output', {
                    type: 'output',
                    message: output,
                    timestamp: new Date().toISOString()
                });
            }

            if (errorOutput) {
                io.to(`console-${hostId}`).emit('console-output', {
                    type: 'error',
                    message: errorOutput,
                    timestamp: new Date().toISOString()
                });
            }
        });

        // معالجة الأخطاء
        child.on('error', (error) => {
            console.error(`❌ خطأ في تنفيذ الأمر: ${error.message}`);

            const result = {
                success: false,
                output: output,
                error: error.message,
                exitCode: -1,
                command: command,
                timestamp: new Date().toISOString()
            };

            res.json(result);

            // إرسال الخطأ عبر Socket.IO
            io.to(`console-${hostId}`).emit('console-output', {
                type: 'error',
                message: `خطأ في تنفيذ الأمر: ${error.message}`,
                timestamp: new Date().toISOString()
            });
        });

        // إرسال رسالة بدء التنفيذ
        io.to(`console-${hostId}`).emit('console-output', {
            type: 'info',
            message: `🚀 بدء تنفيذ الأمر: ${command}`,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('❌ خطأ في معالج الأوامر:', error);

        const result = {
            success: false,
            output: '',
            error: error.message,
            exitCode: -1,
            command: command,
            timestamp: new Date().toISOString()
        };

        res.json(result);

        // إرسال الخطأ عبر Socket.IO
        io.to(`console-${hostId}`).emit('console-output', {
            type: 'error',
            message: `خطأ في معالج الأوامر: ${error.message}`,
            timestamp: new Date().toISOString()
        });
    }
});

app.post('/api/hosting/:id/optimize', (req, res) => {
    const hostId = req.params.id;

    // Call the Discord bot's optimizeStorage function
    try {
        const discordBot = require('./index.js');
        discordBot.quickCleanHost(hostId);
        res.json({ success: true });
    } catch (error) {
        console.error('Error optimizing storage:', error);
        res.json({ success: false, message: error.message });
    }
});

// Upload logo for hosting
app.post('/api/hosting/:id/upload-logo', logoUpload.single('logo'), async (req, res) => {
    try {
        const hostId = req.params.id;

        if (!req.file) {
            return res.status(400).json({ success: false, message: 'يرجى اختيار صورة' });
        }

        if (Types.ObjectId.isValid(hostId)) {
            const hosting = await Hosting.findById(hostId);
            if (!hosting) {
                // Delete uploaded file if hosting not found
                if (req.file.path) fs.unlinkSync(req.file.path);
                return res.status(404).json({ success: false, message: 'الاستضافة غير موجودة' });
            }

            // Delete old logo if exists
            if (hosting.logo) {
                const oldLogoPath = path.join(__dirname, 'public', hosting.logo);
                if (fs.existsSync(oldLogoPath)) {
                    fs.unlinkSync(oldLogoPath);
                }
            }

            // Save logo path (relative to public folder)
            hosting.logo = `/uploads/logos/${req.file.filename}`;
            await hosting.save();

            return res.json({ success: true, logo: hosting.logo });
        } else {
            return res.status(400).json({ success: false, message: 'معرف الاستضافة غير صحيح' });
        }
    } catch (error) {
        console.error('Error uploading logo:', error);
        // Delete uploaded file on error
        if (req.file && req.file.path) {
            try { fs.unlinkSync(req.file.path); } catch { }
        }
        return res.status(500).json({ success: false, message: error.message });
    }
});

// Delete logo
app.delete('/api/hosting/:id/logo', async (req, res) => {
    try {
        const hostId = req.params.id;

        if (Types.ObjectId.isValid(hostId)) {
            const hosting = await Hosting.findById(hostId);
            if (!hosting) {
                return res.status(404).json({ success: false, message: 'الاستضافة غير موجودة' });
            }

            if (hosting.logo) {
                const logoPath = path.join(__dirname, 'public', hosting.logo);
                if (fs.existsSync(logoPath)) {
                    fs.unlinkSync(logoPath);
                }
                hosting.logo = null;
                await hosting.save();
            }

            return res.json({ success: true });
        } else {
            return res.status(400).json({ success: false, message: 'معرف الاستضافة غير صحيح' });
        }
    } catch (error) {
        console.error('Error deleting logo:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/hosting/:id/settings', (req, res) => {
    const hostId = req.params.id;
    const { name, mainFile, nodeVersion, autoRestart, publicAccess, serviceType, port } = req.body;

    try {
        // إذا كان hostId كائن MongoDB، حدّث في DB وإلا حدّث ملف config
        if (Types.ObjectId.isValid(hostId)) {
            (async () => {
                try {
                    const hosting = await safeDBQuery(
                        () => Hosting.findById(hostId),
                        'خطأ في العثور على الاستضافة'
                    );
                    const {
                        name, mainFile, nodeVersion, autoRestart, publicAccess, serviceType, port,
                        startupCommand, autoUpdate, additionalPackages, gitUsername, gitAccessToken, gitRepo
                    } = req.body;
                    if (typeof name !== 'undefined') hosting.name = name;
                    if (typeof mainFile !== 'undefined') hosting.mainFile = mainFile;
                    if (typeof nodeVersion !== 'undefined') hosting.nodeVersion = String(nodeVersion);
                    if (typeof serviceType !== 'undefined' && serviceType) hosting.serviceType = serviceType;
                    if (typeof port !== 'undefined' && port) hosting.port = Number(port);

                    // الحقول الجديدة
                    if (typeof startupCommand !== 'undefined') hosting.startupCommand = startupCommand;
                    if (typeof autoUpdate !== 'undefined') hosting.autoUpdate = autoUpdate;
                    if (typeof additionalPackages !== 'undefined') hosting.additionalPackages = additionalPackages;
                    if (typeof gitUsername !== 'undefined') hosting.gitUsername = gitUsername;
                    if (typeof gitAccessToken !== 'undefined') hosting.gitAccessToken = gitAccessToken;
                    if (typeof gitRepo !== 'undefined') hosting.gitRepo = gitRepo;

                    await hosting.save();
                    return res.json({ success: true });
                } catch (e) {
                    console.error('Error updating DB settings:', e);
                    return res.json({ success: false, message: e.message });
                }
            })();
        }
    } catch (error) {
        console.error('Error updating settings:', error);
        res.json({ success: false, message: error.message });
    }
});

// مسارات النسخ الاحتياطي (Backups)
app.post('/api/hosting/:id/backups/create', async (req, res) => {
    try {
        const HostingService = require('./services/hostingService');
        await HostingService.createBackup(req.params.id);
        res.json({ success: true });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

app.delete('/api/hosting/:id/backups/:backupId', async (req, res) => {
    try {
        const HostingService = require('./services/hostingService');
        await HostingService.deleteBackup(req.params.id, req.params.backupId);
        res.json({ success: true });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

app.post('/api/hosting/:id/backups/:backupId/restore', async (req, res) => {
    try {
        const HostingService = require('./services/hostingService');
        await HostingService.restoreBackup(req.params.id, req.params.backupId);
        res.json({ success: true });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

app.get('/api/hosting/:id/backups/:backupId/download', async (req, res) => {
    try {
        const Hosting = require('./models/hosting');
        const hosting = await Hosting.findById(req.params.id);
        const backup = hosting.backups.id(req.params.backupId);
        if (!backup) return res.status(404).send('Backup not found');

        const fs = require('fs-extra');
        if (await fs.pathExists(backup.path)) {
            res.download(backup.path, backup.name);
        } else {
            res.status(404).send('Backup file not found on server');
        }
    } catch (error) {
        res.status(500).send(error.message);
    }
});

app.delete('/api/hosting/:id/delete', async (req, res) => {
    const hostId = req.params.id;

    try {
        await HostingService.deleteHosting(hostId);
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting hosting:', error);
        res.json({ success: false, message: error.message });
    }
});

// Socket.IO handlers
io.on('connection', (socket) => {
    console.log('A user connected');

    // Join user's personal room for notifications
    socket.on('join-user', (userId) => {
        if (userId) {
            socket.join(`user-${userId}`);
            socket.join(userId); // Also join with just the userId for notifications
            console.log(`User ${userId} joined their personal room`);
        }
    });

    // Handle notification read events
    socket.on('notification-read', async (data) => {
        try {
            const { notificationId, discordId } = data;
            if (notificationId && discordId) {
                const dbUser = await safeDBQuery(
                    () => User.findOne({ discordId }),
                    'خطأ في العثور على المستخدم'
                );
                if (dbUser) {
                    const notification = await safeDBQuery(
                        () => Notification.findById(notificationId),
                        'خطأ في العثور على الإشعار'
                    );
                    if (notification) {
                        await notification.markAsRead(dbUser._id);
                    }
                }
            }
        } catch (error) {
            console.error('Error handling notification read:', error);
        }
    });

    // Join console room
    socket.on('join-console', async (hostId) => {
        socket.join(`console-${hostId}`);
        console.log(`User joined console for ${hostId}`);

        // Send initial console output from MongoDB logs
        try {
            let sent = false;
            if (Types.ObjectId.isValid(hostId)) {
                const hosting = await safeDBQuery(
                    () => Hosting.findById(hostId),
                    'خطأ في جلب سجلات الاستضافة'
                );
                if (hosting && Array.isArray(hosting.logs)) {
                    hosting.logs.forEach(line => socket.emit('console-output', { type: 'info', message: line }));
                    sent = true;
                }
            }
            if (!sent) {
                const logPath = path.join(getHostingBasePath(hostId), 'bot.log');
                if (fs.existsSync(logPath)) {
                    const logs = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
                    logs.forEach(line => socket.emit('console-output', { type: 'info', message: line }));
                }
            }
        } catch (e) {
            console.error('load console logs error', e);
        }
    });

    // Join support chat room
    socket.on('join-support-chat', (ticketId, userId) => {
        if (!ticketId) return;

        socket.join(`ticket-${ticketId}`);
        console.log(`User ${userId} joined support chat for ticket ${ticketId}`);

        // Load previous messages
        const ticketMessagesPath = path.join(__dirname, 'data', 'ticket_messages', `${ticketId}.json`);
        if (fs.existsSync(ticketMessagesPath)) {
            try {
                const messages = JSON.parse(fs.readFileSync(ticketMessagesPath, 'utf8'));
                socket.emit('support-chat-history', messages);
            } catch (error) {
                console.error(`Error loading chat history for ticket ${ticketId}:`, error);
            }
        }
    });

    // Send command to bot
    socket.on('send-command', async (data) => {
        const { hostId, command } = data;
        const basePath = getHostingBasePath(hostId);

        try {
            // إرسال الأمر إلى الكونسل
            socket.emit('console-output', `$ ${command}`);

            // تنفيذ الأمر
            const { spawn } = require('child_process');
            const child = spawn(command, [], {
                cwd: basePath,
                stdio: 'pipe',
                shell: true
            });

            // إرسال المخرجات إلى الكونسل
            child.stdout.on('data', (data) => {
                const output = data.toString();
                socket.emit('console-output', output);
            });

            child.stderr.on('data', (data) => {
                const output = data.toString();
                socket.emit('console-output', `ERROR: ${output}`);
            });

            child.on('close', (code) => {
                if (code !== 0) {
                    socket.emit('console-output', `Command exited with code ${code}`);
                }
            });

            child.on('error', (error) => {
                socket.emit('console-output', `Command error: ${error.message}`);
            });

        } catch (error) {
            console.error('Error executing command:', error);
            socket.emit('console-output', `Error executing command: ${error.message}`);
        }
    });

    // معالج بدء البوت في الكونسل
    socket.on('start-bot', async (data) => {
        const { hostId } = data;

        try {
            // التحقق من أن البوت غير مشغل بالفعل
            const hosting = await getHostingById(hostId);
            if (hosting && hosting.status === 'running') {
                socket.emit('console-output', 'Bot is already running');
                return;
            }

            // بدء البوت
            socket.emit('console-output', 'Starting bot...');
            await startFsHosting(hostId);
            socket.emit('console-output', 'Bot started successfully');
            // إرسال تحديث حالة البوت
            io.to(`console-${hostId}`).emit('bot-status-changed', { hostId, status: 'running' });

        } catch (error) {
            console.error('Error starting bot:', error);
            socket.emit('console-output', `Error starting bot: ${error.message}`);
        }
    });

    // معالج إيقاف البوت في الكونسل
    socket.on('stop-bot', async (data) => {
        const { hostId } = data;

        try {
            // التحقق من أن البوت مشغل
            const hosting = await getHostingById(hostId);
            if (!hosting || hosting.status !== 'running') {
                socket.emit('console-output', 'Bot is not running');
                return;
            }

            // إيقاف البوت
            socket.emit('console-output', 'Stopping bot...');
            await stopFsHosting(hostId);
            socket.emit('console-output', 'Bot stopped successfully');
            // إرسال تحديث حالة البوت
            io.to(`console-${hostId}`).emit('bot-status-changed', { hostId, status: 'stopped' });

        } catch (error) {
            console.error('Error stopping bot:', error);
            socket.emit('console-output', `Error stopping bot: ${error.message}`);
        }
    });

    // معالج إعادة تشغيل البوت في الكونسل
    socket.on('restart-bot', async (data) => {
        const { hostId } = data;

        try {
            socket.emit('console-output', 'Restarting bot...');
            await restartFsHosting(hostId);
            socket.emit('console-output', 'Bot restarted successfully');
            // إرسال تحديث حالة البوت
            io.to(`console-${hostId}`).emit('bot-status-changed', { hostId, status: 'running' });

        } catch (error) {
            console.error('Error restarting bot:', error);
            socket.emit('console-output', `Error restarting bot: ${error.message}`);
        }
    });

    // معالج تثبيت المكتبات
    socket.on('install-libraries', async (data) => {
        const { hostId } = data;
        const basePath = getHostingBasePath(hostId);

        try {
            socket.emit('console-output', '🔍 جاري البحث عن المكتبات...');

            // البحث عن package.json
            const packageJsonPath = path.join(basePath, 'package.json');
            if (!fs.existsSync(packageJsonPath)) {
                socket.emit('console-output', '❌ لم يتم العثور على ملف package.json');
                socket.emit('install-libraries-complete', { success: false, message: 'No package.json found' });
                return;
            }

            // قراءة package.json
            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
            const dependencies = packageJson.dependencies || {};
            const devDependencies = packageJson.devDependencies || {};

            const allDependencies = { ...dependencies, ...devDependencies };
            const dependencyNames = Object.keys(allDependencies);

            if (dependencyNames.length === 0) {
                socket.emit('console-output', 'ℹ️ لا توجد مكتبات للتثبيت');
                socket.emit('install-libraries-complete', { success: true, message: 'No dependencies to install' });
                return;
            }

            socket.emit('console-output', `📦 تم العثور على ${dependencyNames.length} مكتبة:`);
            dependencyNames.forEach(dep => {
                socket.emit('console-output', `  - ${dep}@${allDependencies[dep]}`);
            });

            socket.emit('console-output', '📥 بدء تثبيت المكتبات...');

            // تنفيذ npm install
            const { spawn } = require('child_process');
            const child = spawn('npm', ['install'], {
                cwd: basePath,
                stdio: 'pipe',
                shell: true
            });

            child.stdout.on('data', (data) => {
                const output = data.toString();
                socket.emit('console-output', output);
            });

            child.stderr.on('data', (data) => {
                const output = data.toString();
                socket.emit('console-output', output);
            });

            child.on('close', (code) => {
                if (code === 0) {
                    socket.emit('console-output', '✅ تم تثبيت المكتبات بنجاح!');
                    socket.emit('install-libraries-complete', { success: true, message: 'Libraries installed successfully' });
                } else {
                    socket.emit('console-output', `❌ فشل في تثبيت المكتبات (كود الخروج: ${code})`);
                    socket.emit('install-libraries-complete', { success: false, message: `Installation failed with code ${code}` });
                }
            });

            child.on('error', (error) => {
                socket.emit('console-output', `❌ خطأ في تثبيت المكتبات: ${error.message}`);
                socket.emit('install-libraries-complete', { success: false, message: error.message });
            });

        } catch (error) {
            console.error('Error installing libraries:', error);
            socket.emit('console-output', `❌ خطأ في تثبيت المكتبات: ${error.message}`);
            socket.emit('install-libraries-complete', { success: false, message: error.message });
        }
    });

    // Support chat message
    socket.on('support-chat-message', (data) => {
        const { ticketId, userId, username, avatar, message, isAdmin } = data;
        if (!ticketId || !userId || !message) return;

        const timestamp = new Date().toISOString();
        const messageObj = {
            id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
            userId,
            username,
            avatar: avatar || 'https://cdn.discordapp.com/embed/avatars/0.png',
            message,
            timestamp,
            isAdmin: !!isAdmin
        };

        // Save message to file
        const ticketMessagesDir = path.join(__dirname, 'data', 'ticket_messages');
        const ticketMessagesPath = path.join(ticketMessagesDir, `${ticketId}.json`);

        if (!fs.existsSync(ticketMessagesDir)) {
            fs.mkdirSync(ticketMessagesDir, { recursive: true });
        }

        let messages = [];
        if (fs.existsSync(ticketMessagesPath)) {
            try {
                messages = JSON.parse(fs.readFileSync(ticketMessagesPath, 'utf8'));
            } catch (error) {
                console.error(`Error reading chat history for ticket ${ticketId}:`, error);
            }
        }

        messages.push(messageObj);
        fs.writeFileSync(ticketMessagesPath, JSON.stringify(messages, null, 2));

        // Broadcast to all clients in the room
        io.to(`ticket-${ticketId}`).emit('support-chat-message', messageObj);

        // Update ticket status to pending if admin responds
        if (isAdmin) {
            const tickets = readTickets();
            const ticketIndex = tickets.findIndex(t => t.id === ticketId);
            if (ticketIndex !== -1 && tickets[ticketIndex].status === 'open') {
                tickets[ticketIndex].status = 'pending';
                tickets[ticketIndex].updates.push({
                    at: timestamp,
                    by: username || 'admin',
                    status: 'pending',
                    note: 'Automatic status change: Admin responded'
                });
                writeTickets(tickets);

                // Send notification to all admins
                io.emit('ticket-status-changed', {
                    ticketId,
                    status: 'pending',
                    updatedBy: username || 'admin'
                });
            }
        }

        // Send notification for new message
        io.emit('new-support-message', {
            ticketId,
            from: username || (isAdmin ? 'الدعم الفني' : 'مستخدم'),
            preview: message.substring(0, 30) + (message.length > 30 ? '...' : '')
        });
    });

    // File manager operations
    socket.on('get-files', (data) => {
        const { hostId, path: dirPath } = data;
        const basePath = getHostingBasePath(hostId);
        const fullPath = safeResolve(basePath, dirPath);
        if (!fullPath) {
            return socket.emit('operation-result', { success: false, message: 'Invalid path' });
        }

        // التحقق من أن المسار ليس في مجلد config
        const dirPathRelative = path.relative(basePath, fullPath).replace(/\\/g, '/');
        if (dirPathRelative && (dirPathRelative.startsWith('config/') || dirPathRelative === 'config')) {
            socket.emit('operation-result', {
                success: false,
                message: 'Cannot access config directory'
            });
            return;
        }

        try {
            if (fs.existsSync(fullPath)) {
                const files = fs.readdirSync(fullPath).map(name => {
                    const filePath = path.join(fullPath, name);
                    const stats = fs.statSync(filePath);
                    return {
                        name,
                        type: stats.isDirectory() ? 'directory' : 'file',
                        size: stats.size,
                        modified: stats.mtime
                    };
                });

                // ترتيب الملفات: المجلدات أولاً، ثم الملفات
                files.sort((a, b) => {
                    if (a.type === 'directory' && b.type !== 'directory') return -1;
                    if (a.type !== 'directory' && b.type === 'directory') return 1;
                    return a.name.localeCompare(b.name);
                });

                // إرسال جميع الملفات بما في ذلك config.json
                socket.emit('file-list', { files: files, path: dirPath });
            } else {
                socket.emit('operation-result', {
                    success: false,
                    message: 'Directory not found'
                });
            }
        } catch (error) {
            console.error('Error getting files:', error);
            socket.emit('operation-result', {
                success: false,
                message: 'Error reading directory'
            });
        }
    });

    socket.on('read-file', (data) => {
        const { hostId, path: filePath } = data;
        const basePath = getHostingBasePath(hostId);
        const fullPath = safeResolve(basePath, filePath);
        if (!fullPath) {
            return socket.emit('operation-result', { success: false, message: 'Invalid path' });
        }

        // التحقق من أن المسار ليس في مجلد config
        const filePathRelative = path.relative(basePath, fullPath).replace(/\\/g, '/');
        if (filePathRelative && (filePathRelative.startsWith('config/') || filePathRelative === 'config')) {
            socket.emit('operation-result', {
                success: false,
                message: 'Cannot access files in config directory'
            });
            return;
        }

        try {
            if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
                // التحقق من أن الملف ليس config.json (مع السماح بقراءته مع تحذير)
                const fileName = path.basename(fullPath);
                if (fileName === 'config.json') {
                    // السماح بقراءة config.json مع تحذير
                    console.log(`Warning: User is reading config.json file from ${hostId}`);
                }

                // التحقق من حجم الملف قبل القراءة
                const stats = fs.statSync(fullPath);
                if (stats.size > 10 * 1024 * 1024) { // 10MB
                    socket.emit('operation-result', {
                        success: false,
                        message: 'File too large to read (max 10MB)'
                    });
                    return;
                }

                const content = fs.readFileSync(fullPath, 'utf8');
                socket.emit('file-content', { content });
            } else {
                socket.emit('operation-result', {
                    success: false,
                    message: 'File not found or is a directory'
                });
            }
        } catch (error) {
            console.error('Error reading file:', error);
            socket.emit('operation-result', {
                success: false,
                message: 'Error reading file'
            });
        }
    });

    socket.on('write-file', (data) => {
        const { hostId, path: filePath, content } = data;
        const basePath = getHostingBasePath(hostId);
        const fullPath = safeResolve(basePath, filePath);
        if (!fullPath) {
            return socket.emit('operation-result', { success: false, message: 'Invalid path' });
        }

        // التحقق من أن المسار ليس في مجلد config
        const filePathRelative = path.relative(basePath, fullPath).replace(/\\/g, '/');
        if (filePathRelative && (filePathRelative.startsWith('config/') || filePathRelative === 'config')) {
            socket.emit('operation-result', {
                success: false,
                message: 'Cannot write files to config directory'
            });
            return;
        }

        try {
            // التحقق من حجم المحتوى قبل الكتابة
            if (content.length > 50 * 1024 * 1024) { // 50MB
                socket.emit('operation-result', {
                    success: false,
                    message: 'File too large to save (max 50MB)'
                });
                return;
            }

            const oldConfig = readRootConfig(basePath);
            const dirPath = path.dirname(fullPath);
            if (!fs.existsSync(dirPath)) {
                fs.mkdirSync(dirPath, { recursive: true });
            }

            // التحقق من أن الملف ليس config.json (مع السماح بإنشائه مع تحذير)
            const fileName = path.basename(fullPath);
            if (fileName === 'config.json') {
                // السماح بإنشاء config.json مع تحذير
                console.log(`Warning: User is creating config.json file in ${hostId}`);
            }

            // التحقق من أن الملف ليس في مجلد config
            const filePathRelative = path.relative(basePath, fullPath).replace(/\\/g, '/');
            if (filePathRelative.startsWith('config/') || filePathRelative === 'config') {
                socket.emit('operation-result', {
                    success: false,
                    message: 'Cannot create files in config folder'
                });
                return;
            }

            fs.writeFileSync(fullPath, content, 'utf8');
            reconcileRootConfig(basePath, oldConfig);
            socket.emit('operation-result', {
                success: true,
                message: 'File saved successfully'
            });
        } catch (error) {
            console.error('Error writing file:', error);
            socket.emit('operation-result', {
                success: false,
                message: 'Error saving file'
            });
        }
    });

    socket.on('create-folder', (data) => {
        const { hostId, path: folderPath } = data;
        const basePath = getHostingBasePath(hostId);
        const fullPath = safeResolve(basePath, folderPath);
        if (!fullPath) {
            return socket.emit('operation-result', { success: false, message: 'Invalid path' });
        }

        try {
            if (!fs.existsSync(fullPath)) {
                // التحقق من أن اسم المجلد ليس config
                const folderName = path.basename(fullPath);
                if (folderName === 'config') {
                    socket.emit('operation-result', {
                        success: false,
                        message: 'Cannot create folder named "config"'
                    });
                    return;
                }

                // التحقق من أن المسار لا يحتوي على مجلد config
                const folderPathRelative = path.relative(basePath, fullPath).replace(/\\/g, '/');
                if (folderPathRelative.includes('/config/') || folderPathRelative.startsWith('config/') || folderPathRelative === 'config') {
                    socket.emit('operation-result', {
                        success: false,
                        message: 'Cannot create folder in config directory'
                    });
                    return;
                }

                fs.mkdirSync(fullPath, { recursive: true });

                // مزامنة الإعدادات بعد إنشاء المجلد
                const oldConfig = readRootConfig(basePath);
                if (oldConfig) {
                    reconcileRootConfig(basePath, oldConfig);
                }

                socket.emit('operation-result', {
                    success: true,
                    message: 'Folder created successfully'
                });
            } else {
                socket.emit('operation-result', {
                    success: false,
                    message: 'Folder already exists'
                });
            }
        } catch (error) {
            console.error('Error creating folder:', error);
            socket.emit('operation-result', {
                success: false,
                message: 'Error creating folder'
            });
        }
    });

    socket.on('delete', async (data) => {
        const { hostId, path: itemPath, isDirectory } = data;
        const basePath = getHostingBasePath(hostId);
        const fullPath = safeResolve(basePath, itemPath);
        if (!fullPath) {
            return socket.emit('operation-result', { success: false, message: 'Invalid path' });
        }

        // التحقق من أن المسار ليس في مجلد config (عدا config.json في الجذر)
        const itemPathRelative = path.relative(basePath, fullPath).replace(/\\/g, '/');
        const fileName = path.basename(fullPath);

        // السماح بحذف config.json في الجذر فقط
        if (fileName === 'config.json' && itemPathRelative === 'config.json') {
            // السماح بحذف config.json في الجذر
            console.log(`Info: User is deleting config.json file from ${hostId}`);
            console.log(`Debug: fullPath = ${fullPath}`);
            console.log(`Debug: itemPathRelative = ${itemPathRelative}`);
        } else if (itemPathRelative && (itemPathRelative.startsWith('config/') || itemPathRelative === 'config')) {
            socket.emit('operation-result', {
                success: false,
                message: 'لا يمكن حذف الملفات أو المجلدات في مجلد config (عدا config.json في الجذر)'
            });
            return;
        }

        // منع حذف مجلدات node_modules (تحتاج صلاحيات خاصة)
        if (itemPathRelative && (itemPathRelative.includes('node_modules') || itemPathRelative === 'node_modules')) {
            socket.emit('operation-result', {
                success: false,
                message: 'لا يمكن حذف مجلد node_modules مباشرة. استخدم "npm install" لإعادة تثبيت المكتبات'
            });
            return;
        }

        try {
            const oldConfig = readRootConfig(basePath);
            let rel = null;
            try { rel = path.relative(basePath, fullPath).replace(/\\/g, '/'); } catch { }
            if (fs.existsSync(fullPath)) {
                // الكود محمي بالفعل في الأعلى

                try {
                    console.log(`Debug: Attempting to delete ${isDirectory ? 'directory' : 'file'}: ${fullPath}`);
                    if (isDirectory) {
                        // حذف المجلد مع إعادة المحاولة
                        await deleteDirectoryWithRetry(fullPath);
                    } else {
                        // حذف الملف مع إعادة المحاولة
                        await deleteFileWithRetry(fullPath);
                    }
                    console.log(`Debug: Successfully deleted ${isDirectory ? 'directory' : 'file'}: ${fullPath}`);

                    // مزامنة الإعدادات بعد الحذف (تخطي إعادة الإنشاء إذا كان config.json)
                    const skipRecreation = (fileName === 'config.json' && itemPathRelative === 'config.json');
                    reconcileRootConfig(basePath, oldConfig, skipRecreation);
                    // رسالة خاصة عند حذف config.json
                    let successMessage = `تم حذف ${isDirectory ? 'المجلد' : 'الملف'} بنجاح`;
                    if (fileName === 'config.json' && itemPathRelative === 'config.json') {
                        successMessage = 'تم حذف ملف config.json بنجاح. يمكنك إنشاء ملف جديد أو رفع ملف آخر.';
                    }

                    socket.emit('operation-result', {
                        success: true,
                        message: successMessage
                    });

                    console.log(`✅ تم حذف ${isDirectory ? 'مجلد' : 'ملف'}: ${rel}`);

                } catch (deleteError) {
                    console.error(`خطأ في حذف ${isDirectory ? 'المجلد' : 'الملف'}:`, deleteError);

                    // محاولة حذف باستخدام PowerShell على Windows
                    if (process.platform === 'win32') {
                        try {
                            await deleteWithPowerShell(fullPath, isDirectory);
                            reconcileRootConfig(basePath, oldConfig);
                            socket.emit('operation-result', {
                                success: true,
                                message: `تم حذف ${isDirectory ? 'المجلد' : 'الملف'} باستخدام PowerShell`
                            });
                            console.log(`✅ تم حذف ${isDirectory ? 'مجلد' : 'ملف'} باستخدام PowerShell: ${rel}`);
                        } catch (psError) {
                            socket.emit('operation-result', {
                                success: false,
                                message: `فشل في حذف ${isDirectory ? 'المجلد' : 'الملف'}: ${deleteError.message}. قد يكون الملف قيد الاستخدام`
                            });
                        }
                    } else {
                        socket.emit('operation-result', {
                            success: false,
                            message: `فشل في حذف ${isDirectory ? 'المجلد' : 'الملف'}: ${deleteError.message}`
                        });
                    }
                }
            } else {
                socket.emit('operation-result', {
                    success: false,
                    message: `${isDirectory ? 'المجلد' : 'الملف'} غير موجود`
                });
            }
        } catch (error) {
            console.error('خطأ في حذف العنصر:', error);
            socket.emit('operation-result', {
                success: false,
                message: `خطأ في حذف ${isDirectory ? 'المجلد' : 'الملف'}: ${error.message}`
            });
        }
    });

    socket.on('rename', (data) => {
        const { hostId, oldPath, newPath } = data;
        const basePath = getHostingBasePath(hostId);
        const fullOldPath = safeResolve(basePath, oldPath);
        const fullNewPath = safeResolve(basePath, newPath);
        if (!fullOldPath || !fullNewPath) {
            return socket.emit('operation-result', { success: false, message: 'Invalid path' });
        }

        // التحقق من أن المسار القديم ليس في مجلد config
        const oldPathRelative = path.relative(basePath, fullOldPath).replace(/\\/g, '/');
        if (oldPathRelative && (oldPathRelative.startsWith('config/') || oldPathRelative === 'config')) {
            socket.emit('operation-result', {
                success: false,
                message: 'Cannot rename files or folders in config directory'
            });
            return;
        }

        // التحقق من أن المسار الجديد ليس في مجلد config
        const newPathRelative = path.relative(basePath, fullNewPath).replace(/\\/g, '/');
        if (newPathRelative && (newPathRelative.startsWith('config/') || newPathRelative === 'config')) {
            socket.emit('operation-result', {
                success: false,
                message: 'Cannot rename to config directory'
            });
            return;
        }

        try {
            const oldConfig = readRootConfig(basePath);
            if (fs.existsSync(fullOldPath)) {
                // التحقق من أن المسار القديم ليس config.json (مع السماح بإعادة تسميته مع تحذير)
                const oldPathRelative = path.relative(basePath, fullOldPath).replace(/\\/g, '/');
                if (oldPathRelative === 'config.json') {
                    // السماح بإعادة تسمية config.json مع تحذير
                    console.log(`Warning: User is renaming config.json file in ${hostId}`);
                }

                // التحقق من أن المسار القديم ليس في مجلد config
                if (oldPathRelative && (oldPathRelative.startsWith('config/') || oldPathRelative === 'config')) {
                    socket.emit('operation-result', {
                        success: false,
                        message: 'Cannot rename files or folders in config directory'
                    });
                    return;
                }

                // التحقق من أن المسار الجديد لا يتعارض مع ملف config.json (مع السماح بإعادة تسميته مع تحذير)
                const newPathRelative = path.relative(basePath, fullNewPath).replace(/\\/g, '/');
                if (newPathRelative === 'config.json') {
                    // السماح بإعادة تسمية إلى config.json مع تحذير
                    console.log(`Warning: User is renaming file to config.json in ${hostId}`);
                }

                // التحقق من أن المسار الجديد ليس في مجلد config
                if (newPathRelative && (newPathRelative.startsWith('config/') || newPathRelative === 'config')) {
                    socket.emit('operation-result', {
                        success: false,
                        message: 'Cannot rename to config directory'
                    });
                    return;
                }

                fs.renameSync(fullOldPath, fullNewPath);
                reconcileRootConfig(basePath, oldConfig);
                socket.emit('operation-result', {
                    success: true,
                    message: 'Renamed successfully'
                });
            } else {
                socket.emit('operation-result', {
                    success: false,
                    message: 'File or folder not found'
                });
            }
        } catch (error) {
            console.error('Error renaming:', error);
            socket.emit('operation-result', {
                success: false,
                message: 'Error renaming file or folder'
            });
        }
    });

    socket.on('upload-file', async (data) => {
        const { hostId, path: filePath, content } = data;

        try {
            // التحقق من صحة hostId
            if (!Types.ObjectId.isValid(hostId)) {
                return socket.emit('operation-result', { success: false, message: 'Invalid hosting ID' });
            }

            // تنظيف مسار الملف
            const normalizedPath = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
            const fileName = path.basename(normalizedPath);

            // التحقق من أن المسار ليس في مجلد config (عدا config.json في الجذر)
            if (fileName === 'config.json' && normalizedPath === 'config.json') {
                // السماح برفع config.json في الجذر فقط
                console.log(`Info: User is uploading config.json file to ${hostId}`);
            } else if (normalizedPath.startsWith('config/') || normalizedPath === 'config') {
                return socket.emit('operation-result', {
                    success: false,
                    message: 'لا يمكن رفع الملفات في مجلد config (عدا config.json في الجذر)'
                });
            }

            // Extract base64 data
            const base64Data = content.split(';base64,').pop();
            const buffer = Buffer.from(base64Data, 'base64');

            // التحقق من حجم الملف قبل الرفع
            if (buffer.length > 100 * 1024 * 1024) { // 100MB
                return socket.emit('operation-result', {
                    success: false,
                    message: 'File too large to upload (max 100MB)'
                });
            }

            // تحديد نوع المحتوى
            const ext = path.extname(fileName).toLowerCase();
            const contentTypeMap = {
                '.js': 'application/javascript',
                '.json': 'application/json',
                '.html': 'text/html',
                '.css': 'text/css',
                '.png': 'image/png',
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.gif': 'image/gif',
                '.svg': 'image/svg+xml',
                '.zip': 'application/zip',
                '.jar': 'application/java-archive'
            };
            const contentType = contentTypeMap[ext] || 'application/octet-stream';

            // رفع الملف إلى Firebase Storage
            await FileService.uploadFile(hostId, normalizedPath, buffer, contentType, false);

            socket.emit('operation-result', {
                success: true,
                message: 'File uploaded successfully'
            });
        } catch (error) {
            console.error('Error uploading file:', error);
            socket.emit('operation-result', {
                success: false,
                message: `Error uploading file: ${error.message}`
            });
        }
    });

    socket.on('extract-zip', (data) => {
        const { hostId, path: dirPath, zipContent } = data;
        const basePath = getHostingBasePath(hostId);
        const extractPath = safeResolve(basePath, dirPath || '/');
        if (!extractPath) {
            return socket.emit('operation-result', { success: false, message: 'Invalid path' });
        }

        // التحقق من أن المسار ليس في مجلد config
        const extractPathRelative = path.relative(basePath, extractPath).replace(/\\/g, '/');
        if (extractPathRelative && (extractPathRelative.startsWith('config/') || extractPathRelative === 'config')) {
            socket.emit('operation-result', {
                success: false,
                message: 'Cannot extract ZIP to config directory'
            });
            return;
        }

        try {
            const oldConfig = readRootConfig(basePath);
            // Extract base64 data
            const base64Data = zipContent.split(';base64,').pop();
            const buffer = Buffer.from(base64Data, 'base64');

            // التحقق من حجم الملف المضغوط قبل الاستخراج
            if (buffer.length > 200 * 1024 * 1024) { // 200MB
                socket.emit('operation-result', {
                    success: false,
                    message: 'ZIP file too large to extract (max 200MB)'
                });
                return;
            }

            // Securely extract the zip entries and prevent path traversal
            unzipper.Parse()
                .on('entry', (entry) => {
                    const entryPath = '/' + entry.path.replace(/\\\\/g, '/');
                    const destPath = safeResolve(extractPath, entryPath);
                    if (!destPath) {
                        entry.autodrain();
                        return;
                    }

                    // التحقق من أن الملف ليس config.json (مع السماح باستخراجه مع تحذير)
                    const fileName = path.basename(destPath);
                    if (fileName === 'config.json') {
                        // السماح باستخراج config.json مع تحذير
                        console.log(`Warning: User is extracting config.json file to ${hostId}`);
                    }

                    // التحقق من أن الملف ليس في مجلد config
                    const filePathRelative = path.relative(extractPath, destPath).replace(/\\/g, '/');
                    if (filePathRelative.startsWith('config/') || filePathRelative === 'config') {
                        entry.autodrain();
                        return;
                    }

                    if (entry.type === 'Directory') {
                        try { fs.mkdirSync(destPath, { recursive: true }); } catch { }
                        entry.autodrain();
                    } else {
                        const dir = path.dirname(destPath);
                        try { fs.mkdirSync(dir, { recursive: true }); } catch { }
                        entry.pipe(fs.createWriteStream(destPath));
                    }
                })
                .on('close', () => {
                    reconcileRootConfig(basePath, oldConfig);
                    socket.emit('operation-result', { success: true, message: 'ZIP extracted successfully' });
                })
                .on('error', (err) => {
                    console.error('Error extracting ZIP:', err);
                    socket.emit('operation-result', { success: false, message: 'Error extracting ZIP file' });
                })
                .end(buffer);
        } catch (error) {
            console.error('Error with ZIP extraction:', error);
            socket.emit('operation-result', {
                success: false,
                message: 'Error processing ZIP file'
            });
        }
    });

    // معالج استخراج الملفات المضغوطة المحسن
    socket.on('extract-archive', (data) => {
        const { hostId, path: dirPath, zipContent, fileName, fileSize } = data;
        const basePath = getHostingBasePath(hostId);
        const extractPath = safeResolve(basePath, dirPath || '/');

        if (!extractPath) {
            return socket.emit('operation-result', { success: false, message: 'مسار غير صالح' });
        }

        // التحقق من أن المسار ليس في مجلد config
        const extractPathRelative = path.relative(basePath, extractPath).replace(/\\/g, '/');
        if (extractPathRelative && (extractPathRelative.startsWith('config/') || extractPathRelative === 'config')) {
            socket.emit('operation-result', {
                success: false,
                message: 'لا يمكن استخراج الملفات المضغوطة في مجلد config'
            });
            return;
        }

        try {
            console.log(`📦 استخراج الملف المضغوط: ${fileName} (${fileSize} bytes)`);

            // Extract base64 data
            const base64Data = zipContent.split(';base64,').pop();
            const buffer = Buffer.from(base64Data, 'base64');

            // التحقق من حجم الملف المضغوط قبل الاستخراج
            if (buffer.length > 200 * 1024 * 1024) { // 200MB
                socket.emit('operation-result', {
                    success: false,
                    message: 'الملف المضغوط كبير جداً (أكثر من 200MB)'
                });
                return;
            }

            const oldConfig = readRootConfig(basePath);

            // تحديد نوع الملف المضغوط واستخراجه
            const fileExtension = fileName.split('.').pop().toLowerCase();
            let extractedFiles = [];

            if (fileExtension === 'zip') {
                // استخدام المعالج الحالي للـ ZIP
                unzipper.Parse()
                    .on('entry', (entry) => {
                        const entryPath = '/' + entry.path.replace(/\\\\/g, '/');
                        const destPath = safeResolve(extractPath, entryPath);
                        if (!destPath) {
                            entry.autodrain();
                            return;
                        }

                        const fileName = path.basename(destPath);
                        if (fileName === 'config.json') {
                            console.warn('تحذير: تم العثور على config.json في الملف المضغوط');
                        }

                        if (entry.type === 'Directory') {
                            try { fs.mkdirSync(destPath, { recursive: true }); } catch { }
                        } else {
                            const dir = path.dirname(destPath);
                            try { fs.mkdirSync(dir, { recursive: true }); } catch { }
                            entry.pipe(fs.createWriteStream(destPath));
                            extractedFiles.push(destPath);
                        }
                    })
                    .on('close', () => {
                        reconcileRootConfig(basePath, oldConfig);
                        socket.emit('operation-result', {
                            success: true,
                            message: `تم استخراج ${extractedFiles.length} ملف من ${fileName}`
                        });
                        console.log(`✅ تم استخراج ${extractedFiles.length} ملف من ${fileName}`);
                    })
                    .on('error', (err) => {
                        console.error('خطأ في استخراج الملف المضغوط:', err);
                        socket.emit('operation-result', {
                            success: false,
                            message: `خطأ في استخراج ${fileName}`
                        });
                    })
                    .end(buffer);
            } else {
                socket.emit('operation-result', {
                    success: false,
                    message: 'نوع الملف المضغوط غير مدعوم حالياً (ZIP فقط)'
                });
            }

        } catch (error) {
            console.error('خطأ في استخراج الملف المضغوط:', error);
            socket.emit('operation-result', {
                success: false,
                message: `خطأ في استخراج الملف: ${error.message}`
            });
        }
    });

    // معالج استخراج ملف مضغوط محدد
    socket.on('extract-file', (data) => {
        const { hostId, path: filePath, fileName } = data;
        const basePath = getHostingBasePath(hostId);
        const fullPath = safeResolve(basePath, filePath);

        if (!fullPath || !fs.existsSync(fullPath)) {
            return socket.emit('operation-result', { success: false, message: 'الملف غير موجود' });
        }

        try {
            const extractPath = path.dirname(fullPath);
            const buffer = fs.readFileSync(fullPath);
            const fileExtension = fileName.split('.').pop().toLowerCase();
            let extractedFiles = [];

            console.log(`📦 استخراج الملف: ${fileName}`);

            if (fileExtension === 'zip') {
                // استخدام unzipper لاستخراج ZIP
                unzipper.Parse()
                    .on('entry', (entry) => {
                        const entryPath = '/' + entry.path.replace(/\\\\/g, '/');
                        const destPath = safeResolve(extractPath, entryPath);
                        if (!destPath) {
                            entry.autodrain();
                            return;
                        }

                        if (entry.type === 'Directory') {
                            try { fs.mkdirSync(destPath, { recursive: true }); } catch { }
                        } else {
                            const dir = path.dirname(destPath);
                            try { fs.mkdirSync(dir, { recursive: true }); } catch { }
                            entry.pipe(fs.createWriteStream(destPath));
                            extractedFiles.push(destPath);
                        }
                    })
                    .on('close', () => {
                        // حذف الملف المضغوط بعد الاستخراج
                        fs.unlinkSync(fullPath);

                        socket.emit('operation-result', {
                            success: true,
                            message: `تم استخراج ${extractedFiles.length} ملف وحذف ${fileName}`
                        });

                        console.log(`✅ تم استخراج ${extractedFiles.length} ملف وحذف ${fileName}`);
                    })
                    .on('error', (err) => {
                        console.error('خطأ في استخراج الملف:', err);
                        socket.emit('operation-result', {
                            success: false,
                            message: `خطأ في استخراج الملف: ${err.message}`
                        });
                    })
                    .end(buffer);
            } else {
                socket.emit('operation-result', {
                    success: false,
                    message: 'نوع الملف المضغوط غير مدعوم حالياً (ZIP فقط)'
                });
            }

        } catch (error) {
            console.error('خطأ في استخراج الملف:', error);
            socket.emit('operation-result', {
                success: false,
                message: `خطأ في استخراج الملف: ${error.message}`
            });
        }
    });

    // معالج تنظيف node_modules بطريقة آمنة
    socket.on('clean-node-modules', async (data) => {
        const { hostId, path: dirPath } = data;
        const basePath = getHostingBasePath(hostId);
        const fullPath = safeResolve(basePath, dirPath);

        if (!fullPath) {
            return socket.emit('operation-result', { success: false, message: 'مسار غير صالح' });
        }

        try {
            const nodeModulesPath = path.join(fullPath, 'node_modules');

            if (fs.existsSync(nodeModulesPath)) {
                console.log(`🧹 تنظيف node_modules في: ${nodeModulesPath}`);

                // محاولة حذف باستخدام PowerShell على Windows
                if (process.platform === 'win32') {
                    try {
                        await deleteWithPowerShell(nodeModulesPath, true);
                        console.log('✅ تم حذف node_modules باستخدام PowerShell');
                    } catch (psError) {
                        console.error('❌ فشل حذف node_modules باستخدام PowerShell:', psError);
                        throw psError;
                    }
                } else {
                    // على أنظمة أخرى
                    fs.rmSync(nodeModulesPath, { recursive: true, force: true });
                    console.log('✅ تم حذف node_modules');
                }

                // تشغيل npm install لإعادة التثبيت
                console.log('📦 تشغيل npm install...');
                const { spawn } = require('child_process');

                const npmProcess = spawn('npm', ['install'], {
                    cwd: fullPath,
                    stdio: 'pipe'
                });

                let npmOutput = '';
                let npmError = '';

                npmProcess.stdout.on('data', (data) => {
                    npmOutput += data.toString();
                    console.log('npm:', data.toString());
                });

                npmProcess.stderr.on('data', (data) => {
                    npmError += data.toString();
                    console.error('npm error:', data.toString());
                });

                npmProcess.on('close', (code) => {
                    if (code === 0) {
                        socket.emit('operation-result', {
                            success: true,
                            message: 'تم تنظيف node_modules وإعادة تثبيت المكتبات بنجاح'
                        });
                        console.log('✅ تم إعادة تثبيت المكتبات بنجاح');
                    } else {
                        socket.emit('operation-result', {
                            success: false,
                            message: `فشل في إعادة تثبيت المكتبات. كود الخطأ: ${code}`
                        });
                        console.error(`❌ فشل npm install مع كود: ${code}`);
                    }
                });

                npmProcess.on('error', (error) => {
                    socket.emit('operation-result', {
                        success: false,
                        message: `خطأ في تشغيل npm install: ${error.message}`
                    });
                    console.error('❌ خطأ في npm install:', error);
                });

            } else {
                socket.emit('operation-result', {
                    success: false,
                    message: 'لا يوجد مجلد node_modules في هذا المسار'
                });
            }

        } catch (error) {
            console.error('خطأ في تنظيف node_modules:', error);
            socket.emit('operation-result', {
                success: false,
                message: `خطأ في تنظيف node_modules: ${error.message}`
            });
        }
    });
    socket.on('change-main-file', async (data) => {
        const { hostId, newMainFile, filePath } = data;
        const basePath = getHostingBasePath(hostId);

        try {
            // التحقق من أن الملف موجود
            const fullPath = safeResolve(basePath, filePath);
            if (!fullPath || !fs.existsSync(fullPath)) {
                socket.emit('operation-result', {
                    success: false,
                    message: 'الملف المحدد غير موجود'
                });
                return;
            }

            // التحقق من أن الملف ليس مجلد
            const stats = fs.statSync(fullPath);
            if (stats.isDirectory()) {
                socket.emit('operation-result', {
                    success: false,
                    message: 'لا يمكن استخدام مجلد كملف رئيسي'
                });
                return;
            }

            // التحقق من أن الملف له امتداد صالح للـ Node.js
            const ext = path.extname(newMainFile).toLowerCase();
            if (!['.js', '.mjs', '.ts'].includes(ext)) {
                socket.emit('operation-result', {
                    success: false,
                    message: 'يجب أن يكون الملف الرئيسي من نوع .js أو .mjs أو .ts'
                });
                return;
            }

            // تحديث الملف الرئيسي في قاعدة البيانات
            if (Types.ObjectId.isValid(hostId)) {
                await safeDBQuery(
                    () => Hosting.findByIdAndUpdate(hostId, { mainFile: newMainFile }),
                    'خطأ في تحديث الملف الرئيسي في قاعدة البيانات'
                );
            } else {
                // تحديث hostings.json للـ FS hostings
                const userDataDir = path.join(__dirname, 'data');
                const hostingsFile = path.join(userDataDir, 'hostings.json');
                if (fs.existsSync(hostingsFile)) {
                    const hostingsData = JSON.parse(fs.readFileSync(hostingsFile, 'utf8'));
                    const hostingIndex = hostingsData.findIndex(h => h.id === hostId);
                    if (hostingIndex !== -1) {
                        hostingsData[hostingIndex].mainFile = newMainFile;
                        fs.writeFileSync(hostingsFile, JSON.stringify(hostingsData, null, 2));
                    }
                }
            }

            // تحديث config.json
            const configPath = path.join(basePath, 'config.json');
            if (fs.existsSync(configPath)) {
                const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                config.mainFile = newMainFile;
                fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
            }

            // إيقاف البوت إذا كان يعمل لإعادة تشغيله بالملف الجديد
            const hosting = await getHostingById(hostId);
            if (hosting && hosting.status === 'running') {
                await stopFsHosting(hostId);
                setTimeout(async () => {
                    await startFsHosting(hostId);
                }, 1000);
            }

            socket.emit('operation-result', {
                success: true,
                message: `تم تغيير الملف الرئيسي إلى ${newMainFile} بنجاح`
            });

            // تحديث واجهة المستخدم
            socket.emit('main-file-changed', { newMainFile });

        } catch (error) {
            console.error('Error changing main file:', error);
            socket.emit('operation-result', {
                success: false,
                message: 'خطأ في تغيير الملف الرئيسي'
            });
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected');
    });
});

// Auth routes
app.get('/auth/discord', (req, res, next) => {
    if (!discordAuthEnabled) {
        return res.status(503).send('Discord login is not configured. Set DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, and DISCORD_CALLBACK_URL in .env');
    }
    return passport.authenticate('discord')(req, res, next);
});

app.get('/auth/discord/callback', (req, res, next) => {
    if (!discordAuthEnabled) {
        return res.redirect('/');
    }
    return passport.authenticate('discord', { failureRedirect: '/' })(req, res, () => {
        res.redirect('/');
    });
});

// Debug auth status (no secrets exposed)
app.get('/debug/auth', (req, res) => {
    res.json({
        discordAuthEnabled,
        hasClientId: discordClientId.length > 0,
        hasClientSecret: discordClientSecret.length > 0,
        callbackUrl: discordCallback || null
    });
});

app.get('/logout', (req, res, next) => {
    req.logout((err) => {
        if (err) return next(err);
        req.session.destroy(() => {
            res.redirect('/');
        });
    });
});

// Function to get server address (no public IP resolution)
async function getServerAddress() {
    const PORT = process.env.PORT || 3000;
    if (process.env.SERVER_ADDRESS) {
        console.log(`ℹ️ استخدام عنوان الخادم المحدد في الإعدادات: ${process.env.SERVER_ADDRESS}`);
        return process.env.SERVER_ADDRESS;
    }
    // Default to localhost:PORT and do not try to resolve public/local IP
    const serverAddress = `localhost:${PORT}`;
    process.env.SERVER_ADDRESS = serverAddress;
    return serverAddress;
}

// Add notification for user
function addNotification(userId, notification) {
    try {
        if (!userId || !notification) return false;

        const notificationsDir = path.join(__dirname, 'data', 'notifications');
        const userNotificationsFile = path.join(notificationsDir, `${userId}.json`);

        if (!fs.existsSync(notificationsDir)) {
            fs.mkdirSync(notificationsDir, { recursive: true });
        }

        let notifications = [];
        if (fs.existsSync(userNotificationsFile)) {
            notifications = JSON.parse(fs.readFileSync(userNotificationsFile, 'utf8'));
        }

        // Add new notification with ID and timestamp
        const newNotification = {
            id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
            ...notification,
            read: false,
            timestamp: new Date().toISOString()
        };

        notifications.unshift(newNotification);

        // Keep only the most recent 50 notifications
        if (notifications.length > 50) {
            notifications = notifications.slice(0, 50);
        }

        fs.writeFileSync(userNotificationsFile, JSON.stringify(notifications, null, 2));

        // Emit notification event to connected user
        io.to(`user-${userId}`).emit('new-notification', newNotification);

        return true;
    } catch (error) {
        console.error(`Error adding notification for user ${userId}:`, error);
        return false;
    }
}

// Get user notifications
app.get('/api/notifications', async (req, res) => {
    if (!req.user) return res.status(401).json({ success: false });

    try {
        const dbUser = await User.findOne({ discordId: req.user.id });
        if (!dbUser) {
            return res.json({ success: true, notifications: [] });
        }

        const notifications = await Notification.getUserNotifications(dbUser._id);

        // Format notifications for frontend
        const formattedNotifications = notifications.map(notification => ({
            id: notification._id,
            title: notification.title,
            message: notification.message,
            type: notification.type,
            priority: notification.priority,
            link: notification.link,
            timestamp: notification.createdAt,
            read: notification.isReadBy(dbUser._id),
            createdBy: notification.createdBy
        }));

        res.json({ success: true, notifications: formattedNotifications });
    } catch (error) {
        console.error('Error getting notifications:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// PayPal Payment Routes
app.post('/api/payment/verify-payment', async (req, res) => {
    if (!req.user) return res.status(401).json({ success: false, message: 'يجب تسجيل الدخول أولاً' });

    try {
        const { orderId, hostingName, serviceType, packageIndex } = req.body;

        if (!orderId || !hostingName || !serviceType || packageIndex === undefined) {
            return res.status(400).json({ success: false, message: 'بيانات غير مكتملة' });
        }

        // Get user from database
        const dbUser = await User.findOne({ discordId: req.user.id });
        if (!dbUser) {
            return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
        }

        // Get package details
        const packages = config.prices[serviceType] || config.prices.default;
        const selectedPackage = packages[parseInt(packageIndex)];

        if (!selectedPackage) {
            return res.status(400).json({ success: false, message: 'الباقة غير موجودة' });
        }

        // Calculate expiry date
        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + selectedPackage.duration);

        // Create hosting
        const hosting = await HostingService.createHosting({
            name: hostingName,
            owner: dbUser._id,
            serviceType: serviceType,
            mainFile: 'index.js',
            expiryDate: expiryDate,
            specs: {
                cpu: selectedPackage.cpu,
                ram: selectedPackage.ram,
                storage: selectedPackage.storage
            }
        });

        return res.json({
            success: true,
            message: 'تم إنشاء الاستضافة بنجاح',
            hostingId: hosting._id
        });
    } catch (error) {
        console.error('Error verifying payment:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

// Admin Pricing & Discount Codes API
app.get('/api/admin/pricing-config', (req, res) => {
    if (!isOwner(req)) return res.status(403).json({ success: false, message: 'Access denied' });
    return res.json({ success: true, prices: config.prices });
});

app.post('/api/admin/update-package', (req, res) => {
    if (!isOwner(req)) return res.status(403).json({ success: false, message: 'Access denied' });

    const { serviceType, index, package: packageData } = req.body;

    try {
        if (!config.prices[serviceType]) {
            config.prices[serviceType] = [];
        }

        if (index >= 0 && index < config.prices[serviceType].length) {
            config.prices[serviceType][index] = packageData;
        } else {
            config.prices[serviceType].push(packageData);
        }

        return res.json({ success: true });
    } catch (error) {
        console.error('Error updating package:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/delete-package', (req, res) => {
    if (!isOwner(req)) return res.status(403).json({ success: false, message: 'Access denied' });

    const { serviceType, index } = req.body;

    try {
        if (config.prices[serviceType] && index >= 0 && index < config.prices[serviceType].length) {
            config.prices[serviceType].splice(index, 1);
            return res.json({ success: true });
        }
        return res.status(404).json({ success: false, message: 'Package not found' });
    } catch (error) {
        console.error('Error deleting package:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/discount-codes', (req, res) => {
    if (!isOwner(req)) return res.status(403).json({ success: false, message: 'Access denied' });
    return res.json({ success: true, codes: config.payment.discountCodes || {} });
});

app.post('/api/admin/add-discount-code', (req, res) => {
    if (!isOwner(req)) return res.status(403).json({ success: false, message: 'Access denied' });

    const { code, discount, maxUses, used } = req.body;

    try {
        if (!config.payment.discountCodes) {
            config.payment.discountCodes = {};
        }

        config.payment.discountCodes[code] = {
            discount: discount || 0,
            maxUses: maxUses || null,
            used: used || 0
        };

        return res.json({ success: true });
    } catch (error) {
        console.error('Error adding discount code:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/update-discount-code', (req, res) => {
    if (!isOwner(req)) return res.status(403).json({ success: false, message: 'Access denied' });

    const { code, discount, maxUses } = req.body;

    try {
        if (!config.payment.discountCodes || !config.payment.discountCodes[code]) {
            return res.status(404).json({ success: false, message: 'Discount code not found' });
        }

        if (discount !== undefined) config.payment.discountCodes[code].discount = discount;
        if (maxUses !== undefined) config.payment.discountCodes[code].maxUses = maxUses;

        return res.json({ success: true });
    } catch (error) {
        console.error('Error updating discount code:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/delete-discount-code', (req, res) => {
    if (!isOwner(req)) return res.status(403).json({ success: false, message: 'Access denied' });

    const { code } = req.body;

    try {
        if (config.payment.discountCodes && config.payment.discountCodes[code]) {
            delete config.payment.discountCodes[code];
            return res.json({ success: true });
        }
        return res.status(404).json({ success: false, message: 'Discount code not found' });
    } catch (error) {
        console.error('Error deleting discount code:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

// Giveaways Management API
if (!config.webGiveaways) {
    config.webGiveaways = [];
}

app.get('/api/admin/giveaways', (req, res) => {
    if (!isOwner(req)) return res.status(403).json({ success: false, message: 'Access denied' });
    return res.json({ success: true, giveaways: config.webGiveaways || [] });
});

app.post('/api/admin/create-giveaway', (req, res) => {
    if (!isOwner(req)) return res.status(403).json({ success: false, message: 'Access denied' });

    const { title, description, prizeType, prizeDetails, maxParticipants, duration } = req.body;

    try {
        if (!config.webGiveaways) {
            config.webGiveaways = [];
        }

        const endsAt = Date.now() + (duration * 60 * 1000);

        const giveaway = {
            id: Date.now().toString(),
            title: title || 'جائزة جديدة',
            description: description || '',
            prizeType: prizeType || 'discord',
            prizeDetails: prizeDetails || {},
            maxParticipants: maxParticipants || null,
            duration: duration || 60,
            endsAt: endsAt,
            participants: [],
            createdAt: Date.now(),
            status: 'active'
        };

        config.webGiveaways.push(giveaway);

        return res.json({ success: true, giveaway });
    } catch (error) {
        console.error('Error creating giveaway:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/update-giveaway', (req, res) => {
    if (!isOwner(req)) return res.status(403).json({ success: false, message: 'Access denied' });

    const { id, title, description, prizeType, prizeDetails, maxParticipants, duration } = req.body;

    try {
        if (!config.webGiveaways) config.webGiveaways = [];
        const giveaway = config.webGiveaways.find(g => g.id === id);
        if (!giveaway) {
            return res.status(404).json({ success: false, message: 'Giveaway not found' });
        }

        if (title !== undefined) giveaway.title = title;
        if (description !== undefined) giveaway.description = description;
        if (prizeType !== undefined) giveaway.prizeType = prizeType;
        if (prizeDetails !== undefined) giveaway.prizeDetails = prizeDetails;
        if (maxParticipants !== undefined) giveaway.maxParticipants = maxParticipants;
        if (duration !== undefined) {
            giveaway.duration = duration;
            giveaway.endsAt = Date.now() + (duration * 60 * 1000);
        }

        return res.json({ success: true });
    } catch (error) {
        console.error('Error updating giveaway:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/delete-giveaway', (req, res) => {
    if (!isOwner(req)) return res.status(403).json({ success: false, message: 'Access denied' });

    const { id } = req.body;

    try {
        if (!config.webGiveaways) config.webGiveaways = [];
        const index = config.webGiveaways.findIndex(g => g.id === id);
        if (index === -1) {
            return res.status(404).json({ success: false, message: 'Giveaway not found' });
        }

        config.webGiveaways.splice(index, 1);
        return res.json({ success: true });
    } catch (error) {
        console.error('Error deleting giveaway:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/end-giveaway', (req, res) => {
    if (!isOwner(req)) return res.status(403).json({ success: false, message: 'Access denied' });

    const { id } = req.body;

    try {
        if (!config.webGiveaways) config.webGiveaways = [];
        const giveaway = config.webGiveaways.find(g => g.id === id);
        if (!giveaway) {
            return res.status(404).json({ success: false, message: 'Giveaway not found' });
        }

        giveaway.status = 'ended';
        giveaway.endsAt = Date.now();

        return res.json({ success: true });
    } catch (error) {
        console.error('Error ending giveaway:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

// Minecraft Servers Management API
app.get('/api/admin/minecraft-servers', async (req, res) => {
    if (!isOwner(req)) return res.status(403).json({ success: false, message: 'Access denied' });

    try {
        const allHostings = await getAllHostings();
        const minecraftServers = allHostings.filter(h => h.serviceType === 'minecraft');

        // Populate owner information
        const serversWithOwner = await Promise.all(minecraftServers.map(async (server) => {
            if (server.owner && Types.ObjectId.isValid(server.owner)) {
                const owner = await User.findById(server.owner).select('username avatar').lean();
                return { ...server, owner };
            }
            return server;
        }));

        return res.json({ success: true, servers: serversWithOwner });
    } catch (error) {
        console.error('Error getting Minecraft servers:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/extend-minecraft-server', async (req, res) => {
    if (!isOwner(req)) return res.status(403).json({ success: false, message: 'Access denied' });

    const { id, days } = req.body;

    try {
        if (!Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'Invalid server ID' });
        }

        const hosting = await Hosting.findById(id);
        if (!hosting) {
            return res.status(404).json({ success: false, message: 'Server not found' });
        }

        if (hosting.serviceType !== 'minecraft') {
            return res.status(400).json({ success: false, message: 'This is not a Minecraft server' });
        }

        const currentExpiry = new Date(hosting.expiryDate);
        const newExpiry = new Date(currentExpiry);
        newExpiry.setDate(newExpiry.getDate() + parseInt(days));

        hosting.expiryDate = newExpiry;
        await hosting.save();

        return res.json({ success: true, newExpiryDate: newExpiry });
    } catch (error) {
        console.error('Error extending Minecraft server:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/delete-minecraft-server', async (req, res) => {
    if (!isOwner(req)) return res.status(403).json({ success: false, message: 'Access denied' });

    const { id } = req.body;

    try {
        if (!Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'Invalid server ID' });
        }

        const hosting = await Hosting.findById(id);
        if (!hosting) {
            return res.status(404).json({ success: false, message: 'Server not found' });
        }

        if (hosting.serviceType !== 'minecraft') {
            return res.status(400).json({ success: false, message: 'This is not a Minecraft server' });
        }

        // Stop the server if running
        if (hosting.status === 'running') {
            await HostingService.stopHosting(id);
        }

        // Delete hosting files
        try {
            const hostingPath = path.join(__dirname, 'hostings', id.toString());
            if (fs.existsSync(hostingPath)) {
                fs.removeSync(hostingPath);
            }
        } catch (fileError) {
            console.error('Error deleting hosting files:', fileError);
        }

        // Remove from user's hostings
        const owner = await User.findById(hosting.owner);
        if (owner) {
            owner.hostings = owner.hostings.filter(h => h.toString() !== id.toString());
            await owner.save();
        }

        // Delete from database
        await Hosting.findByIdAndDelete(id);

        return res.json({ success: true });
    } catch (error) {
        console.error('Error deleting Minecraft server:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

// Mark notification as read
app.post('/api/notifications/read', async (req, res) => {
    if (!req.user) return res.status(401).json({ success: false });

    const { id } = req.body || {};
    if (!id) return res.status(400).json({ success: false, message: 'Notification ID required' });

    try {
        const dbUser = await User.findOne({ discordId: req.user.id });
        if (!dbUser) {
            return res.json({ success: true });
        }

        const userId = dbUser._id;

        if (id === 'all') {
            // Mark all notifications as read for this user
            await Notification.updateMany(
                {
                    $or: [
                        { targetType: 'all' },
                        { targetUsers: userId }
                    ],
                    isActive: true
                },
                {
                    $addToSet: {
                        readBy: { user: userId, readAt: new Date() }
                    }
                }
            );
        } else {
            // Mark specific notification as read
            const notification = await Notification.findById(id);
            if (notification) {
                await notification.markAsRead(userId);
            }
        }

        return res.json({ success: true });
    } catch (error) {
        console.error('Error marking notification as read:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', async () => {
    await connectDB();
    const serverAddress = await getServerAddress();
    console.log(`🚀 خادم الويب يعمل على المنفذ ${PORT}`);
    console.log(`🌐 العنوان: http://${serverAddress}`);

    // Update the server address in the parent module (index.js)
    if (process.env.SERVER_ADDRESS !== serverAddress) {
        process.env.SERVER_ADDRESS = serverAddress;
        if (global.updateServerAddress) {
            global.updateServerAddress(serverAddress);
        }
    }

    console.log('📋 روابط المواقع العامة (Web): /sites/<user>/<site>');

    // استعادة العمليات المفقودة وتوزيع البروكسيات
    setTimeout(async () => {
        restoreHostingProcesses();
        await ProxyService.distributeProxies();
    }, 2000);
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Error:', err);

    // Log the error
    logError(err, req, {
        errorType: 'unhandled_error',
        timestamp: new Date().toISOString()
    }).catch(logErr => {
        console.error('Failed to log error:', logErr);
    });

    res.status(500).send('Something went wrong!');
});

// ULTRA SIMPLE TEST ROUTE - NO MIDDLEWARE, NO AUTH, NO DATABASE
app.get('/ultra-test', (req, res) => {
    console.log('🔥 ULTRA TEST ROUTE CALLED');
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Ultra Test</title>
            <meta charset="utf-8">
            <style>
                body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f0f0f0; }
                .success { color: #27ae60; font-size: 24px; }
                .info { color: #3498db; margin: 20px 0; }
                a { color: #e74c3c; text-decoration: none; font-weight: bold; }
                a:hover { text-decoration: underline; }
            </style>
        </head>
        <body>
            <h1 class="success">🔥 ULTRA TEST SUCCESS!</h1>
            <p class="info">Server is working perfectly!</p>
            <p class="info">Time: ${new Date().toLocaleString()}</p>
            <hr>
            <p><a href="/test-startup">Test Startup Route</a></p>
            <p><a href="/startup-test/test123">Test Startup Page</a></p>
            <p><a href="/">Go Home</a></p>
        </body>
        </html>
    `);
});

// دوال مساعدة للحذف مع إعادة المحاولة
async function deleteFileWithRetry(filePath, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            fs.unlinkSync(filePath);
            return;
        } catch (error) {
            if (i === maxRetries - 1) throw error;
            await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
        }
    }
}

async function deleteDirectoryWithRetry(dirPath, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            fs.rmSync(dirPath, { recursive: true, force: true });
            return;
        } catch (error) {
            if (i === maxRetries - 1) throw error;
            await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
        }
    }
}

async function deleteWithPowerShell(path, isDirectory) {
    const { spawn } = require('child_process');

    return new Promise((resolve, reject) => {
        const command = isDirectory ? 'Remove-Item' : 'Remove-Item';
        const args = ['-Path', `"${path}"`, '-Recurse', '-Force'];

        const ps = spawn('powershell', ['-Command', `${command} ${args.join(' ')}`]);

        ps.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`PowerShell command failed with code ${code}`));
            }
        });

        ps.on('error', (error) => {
            reject(error);
        });
    });
}

module.exports = {
    app,
    server
};
