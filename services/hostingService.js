const { Hosting, User } = require('../models');
const FileService = require('./fileService');
const fs = require('fs-extra');
const path = require('path');
const { spawn, exec } = require('child_process');
const unzipper = require('unzipper');
const archiver = require('archiver');
const { promisify } = require('util');
const execPromise = promisify(exec);
const HostingModel = require('../models/hosting'); // للتأمين

function stripAnsi(text) {
    if (typeof text !== 'string') return text;
    // Regex to remove ANSI escape codes
    return text.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}

const pathToNodeForVersion = (version) => {
    try {
        const v = String(version || '').replace(/[^0-9]/g, '') || '16';
        const envMap = {
            '14': process.env.NODE_14_PATH,
            '16': process.env.NODE_16_PATH,
            '18': process.env.NODE_18_PATH,
            '20': process.env.NODE_20_PATH
        };
        const candidate = envMap[v];
        if (candidate && fs.existsSync(candidate)) return candidate;
    } catch { }
    return 'node';
};
// استيراد get-port بشكل ديناميكي لتجنب مشاكل CommonJS/ESM
let getPortLibrary;
let publicIp = 'localhost';
try {
    const http = require('http');
    http.get({ host: 'api.ipify.org', port: 80, path: '/' }, (resp) => {
        resp.on('data', (chunk) => { publicIp = chunk.toString(); });
    }).on('error', () => { });
} catch (e) { }

async function resolveAvailablePort(options) {
    if (!getPortLibrary) {
        const gp = await import('get-port');
        getPortLibrary = gp.default || gp;
    }
    return getPortLibrary(options);
}
const runningProcesses = new Map();

/**
 * خدمة إدارة الهوستات
 */
class HostingService {
    /**
     * الحصول على الأيبي العام للخادم
     */
    static getPublicIp() {
        return publicIp;
    }

    /**
     * إنشاء هوست جديد
     * @param {Object} hostingData - بيانات الهوست
     * @returns {Promise<Object>} - الهوست الجديد
     */
    static async createHosting(hostingData) {
        try {
            // التحقق من وجود المستخدم
            const user = await User.findById(hostingData.owner);
            if (!user) {
                throw new Error('المستخدم غير موجود');
            }

            // تعيين منفذ إذا لم يتم تحديده
            if (!hostingData.port) {
                const defaultPorts = {
                    'discord': 3000,
                    'web': 8080,
                    'mta': 22003,
                    'fivem': 30120,
                    'minecraft': 25565
                };

                const basePort = defaultPorts[hostingData.serviceType] || 3000;
                hostingData.port = await resolveAvailablePort({ port: basePort });
            }

            // إنشاء الهوست
            const hosting = new Hosting(hostingData);

            // إذا كان نوع الخدمة Minecraft، تعيين الملف الرئيسي
            if (hostingData.serviceType === 'minecraft' && !hostingData.mainFile) {
                hosting.mainFile = 'server.jar';
            }

            await hosting.save();

            // إضافة الهوست إلى المستخدم
            user.hostings.push(hosting._id);
            await user.save();

            // إذا كان نوع الخدمة Minecraft، نسخ ملف server.jar أو فك ضغط قالب (إلا إذا تم طلب تخطي ذلك)
            if (hostingData.serviceType === 'minecraft' && !hostingData.skipTemplate) {
                try {
                    const minecraftDir = path.join(__dirname, '..', 'minecraft');
                    const hostingPath = path.join(__dirname, '..', 'hostings', hosting._id.toString());

                    // التأكد من وجود مجلد الهوست
                    await fs.ensureDir(hostingPath);

                    // البحث عن ملفات في مجلد minecraft
                    if (await fs.pathExists(minecraftDir)) {
                        const files = await fs.readdir(minecraftDir);
                        const zipFile = files.find(f => f.endsWith('.zip'));
                        const jarFile = files.find(f => f.endsWith('.jar'));

                        if (zipFile) {
                            // فك ضغط القالب
                            const zipPath = path.join(minecraftDir, zipFile);
                            console.log(`📦 فك ضغط القالب: ${zipPath}`);
                            await fs.createReadStream(zipPath)
                                .pipe(unzipper.Extract({ path: hostingPath }))
                                .promise();
                            console.log(`✅ تم فك الضغط إلى ${hostingPath}`);
                        } else if (jarFile) {
                            // نسخ ملف الـ jar
                            const srcPath = path.join(minecraftDir, jarFile);
                            const destPath = path.join(hostingPath, 'server.jar');
                            await fs.copy(srcPath, destPath);
                            console.log(`✅ تم نسخ ${jarFile} إلى ${destPath}`);
                        }

                        // إنشاء ملف eula.txt (مطلوب لتشغيل Minecraft)
                        const eulaPath = path.join(hostingPath, 'eula.txt');
                        if (!await fs.pathExists(eulaPath)) {
                            await fs.writeFile(eulaPath, 'eula=true\n');
                            console.log(`✅ تم إنشاء eula.txt`);
                        }

                        // إنشاء ملف server.properties إذا لم يكن موجوداً
                        const serverPropertiesPath = path.join(hostingPath, 'server.properties');
                        if (!await fs.pathExists(serverPropertiesPath)) {
                            const serverProperties = `server-port=${hosting.port}\nmax-players=20\nonline-mode=false\ndifficulty=normal\ngamemode=survival\npvp=true\nspawn-protection=16\nmotd=§bMinecraft Server §7- §6Powered by §eHnStore\n`;
                            await fs.writeFile(serverPropertiesPath, serverProperties);
                            console.log(`✅ تم إنشاء server.properties`);
                        }

                        // تسجيل جميع الملفات في قاعدة البيانات
                        const allFiles = await this.getAllFilesRecursive(hostingPath);
                        for (const f of allFiles) {
                            const relativePath = path.relative(hostingPath, f).replace(/\\/g, '/');
                            const fileContent = await fs.readFile(f);
                            await FileService.uploadFile(hosting._id, relativePath, fileContent, 'application/octet-stream');
                        }

                        // تحديث الملف الرئيسي تلقائياً إذا كان jar
                        if (jarFile || await fs.pathExists(path.join(hostingPath, 'server.jar'))) {
                            hosting.mainFile = 'server.jar';
                            await hosting.save();
                        }
                    } else {
                        console.warn(`⚠️ مجلد Minecraft غير موجود في ${minecraftDir}`);
                    }
                } catch (minecraftError) {
                    console.error('❌ خطأ في تجهيز ملفات Minecraft:', minecraftError);
                }
            }

            return hosting;
        } catch (error) {
            console.error('خطأ في إنشاء الهوست:', error);
            throw error;
        }
    }

    /**
     * الحصول على هوست بواسطة المعرف
     * @param {String} id - معرف الهوست
     * @returns {Promise<Object>} - الهوست
     */
    static async getHostingById(id) {
        try {
            return await Hosting.findById(id).populate('owner');
        } catch (error) {
            console.error('خطأ في الحصول على الهوست:', error);
            throw error;
        }
    }

    /**
     * الحصول على جميع الهوستات
     * @returns {Promise<Array>} - قائمة الهوستات
     */
    static async getAllHostings() {
        try {
            return await Hosting.find().populate('owner');
        } catch (error) {
            console.error('خطأ في الحصول على الهوستات:', error);
            throw error;
        }
    }

    /**
     * الحصول على هوستات المستخدم
     * @param {String} userId - معرف المستخدم
     * @returns {Promise<Array>} - قائمة الهوستات
     */
    static async getUserHostings(userId) {
        try {
            return await Hosting.find({ owner: userId });
        } catch (error) {
            console.error('خطأ في الحصول على هوستات المستخدم:', error);
            throw error;
        }
    }

    /**
     * تحديث حالة الهوست
     * @param {String} id - معرف الهوست
     * @param {String} status - الحالة الجديدة
     * @returns {Promise<Object>} - الهوست بعد التحديث
     */
    static async updateHostingStatus(id, status) {
        try {
            const hosting = await Hosting.findById(id);
            if (!hosting) {
                throw new Error('الهوست غير موجود');
            }

            hosting.status = status;
            await hosting.save();

            return hosting;
        } catch (error) {
            console.error('خطأ في تحديث حالة الهوست:', error);
            throw error;
        }
    }

    /**
     * تشغيل الهوست
     * @param {String} id - معرف الهوست
     * @returns {Promise<Object>} - الهوست بعد التشغيل
     */
    static async startHosting(id) {
        try {
            const hosting = await Hosting.findById(id);
            if (!hosting) {
                throw new Error('الهوست غير موجود');
            }

            // التحقق من انتهاء الصلاحية
            if (hosting.isExpired()) {
                throw new Error('انتهت صلاحية الهوست');
            }

            // إيقاف الهوست إذا كان يعمل
            if (hosting.status === 'running' && hosting.pid) {
                await this.stopHosting(id);
            }

            // 0. مسح السجلات السابقة وتحديث الحالة
            hosting.logs = [];
            hosting.status = 'restarting';
            await hosting.save();

            // استخراج الملفات إلى مجلد مؤقت
            const tempDir = await FileService.extractToTemp(hosting._id);

            // تحديد الأمر المناسب حسب نوع الخدمة
            let command, args;
            const mainFilePath = path.join(tempDir, hosting.mainFile);

            switch (hosting.serviceType) {
                case 'discord':
                    command = 'node';
                    args = [hosting.mainFile];
                    break;
                case 'web':
                    if (hosting.siteMode === 'nodejs') {
                        command = 'node';
                        args = [hosting.mainFile];
                    } else {
                        // إذا كان موقعًا ثابتًا، لا نحتاج لتشغيل عملية
                        await this.updateHostingStatus(id, 'running');
                        return hosting;
                    }
                    break;
                case 'mta':
                    command = './mta-server';
                    args = [];
                    break;
                case 'fivem':
                    command = './run.sh';
                    args = [];
                    break;
                case 'minecraft':
                    // استخدام Java لتشغيل سيرفر Minecraft
                    command = 'java';
                    const javaMemory = Math.floor(hosting.specs?.ram || 1024);
                    // البحث عن الملف الرئيسي
                    const mcJarFile = hosting.mainFile || 'server.jar';
                    args = [
                        '-Xmx' + javaMemory + 'M',
                        '-Xms' + Math.floor(javaMemory / 2) + 'M',
                        '-jar', mcJarFile,
                        'nogui'
                    ];
                    console.log(`🚀 Starting Minecraft: ${command} ${args.join(' ')}`);
                    break;
                default:
                    command = 'node';
                    args = [hosting.mainFile];
            }

            // إنشاء مجلد السجلات إذا لم يكن موجودًا
            const logsDir = path.join(tempDir, 'logs');
            await fs.ensureDir(logsDir);

            // تنفيذ عمليات ما قبل التشغيل (Pre-startup)
            try {
                // Minecraft specific pre-startup
                if (hosting.serviceType === 'minecraft') {
                    const jarFile = hosting.mainFile || 'server.jar';
                    const jarPath = path.join(tempDir, jarFile);

                    if (await fs.pathExists(jarPath)) {
                        // التحقق مما إذا كانت الملفات مستخرجة بالفعل (مثلاً وجود مجلد libraries أو versions)
                        const isExtracted = await fs.pathExists(path.join(tempDir, 'libraries')) || await fs.pathExists(path.join(tempDir, 'versions'));

                        if (!isExtracted) {
                            await this.logToConsole(id, '📦 جاري استخراج ملفات السيرفر الأساسية لتجهيز البيئة...');
                            try {
                                if (process.platform === 'win32') {
                                    // محاولة الاستخراج باستخدام powershell
                                    await execPromise(`powershell -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${jarPath.replace(/'/g, "''")}', '${tempDir.replace(/'/g, "''")}')"`, { cwd: tempDir }).catch(async () => {
                                        // إذا فشل، جرب Expand-Archive
                                        await execPromise(`powershell -Command "Expand-Archive -Path '${jarPath}' -DestinationPath '${tempDir}' -Force"`, { cwd: tempDir });
                                    });
                                } else {
                                    await execPromise(`jar xf ${jarFile}`, { cwd: tempDir });
                                }
                                await this.logToConsole(id, '✅ تم الاستخراج بنجاح.');
                            } catch (err) {
                                await this.logToConsole(id, `ℹ️ ملاحظة: فشل الاستخراج التلقائي، جاري محاولة التشغيل المباشر.`);
                            }
                        }
                    }

                    // تأكد من وجود eula.txt
                    const eulaPath = path.join(tempDir, 'eula.txt');
                    if (!(await fs.pathExists(eulaPath))) {
                        await fs.writeFile(eulaPath, 'eula=true');
                        await this.logToConsole(id, '✅ تم الموافقة على eula.txt تلقائياً.');
                    }

                    // تحديث أو إنشاء server.properties
                    const propsPath = path.join(tempDir, 'server.properties');
                    let props = '';
                    if (await fs.pathExists(propsPath)) {
                        props = await fs.readFile(propsPath, 'utf8');
                        // استبدال الاسم القديم بالجديد
                        props = props.replace(/sivano\s*host/gi, 'HnStore');
                    } else {
                        // إعدادات افتراضية إذا لم يكن الملف موجوداً
                        props = `server-port=${hosting.port}
motd=§bMinecraft Server §7- §6Powered by §eHnStore
online-mode=false
max-players=20
enable-command-block=true
view-distance=10`;
                    }

                    // تحديث المنفذ دائماً لضمان عمل السيرفر على المنفذ المخصص
                    if (props.includes('server-port=')) {
                        props = props.replace(/server-port=\d+/g, `server-port=${hosting.port}`);
                    } else {
                        props += `\nserver-port=${hosting.port}\n`;
                    }

                    // تحديث MOTD دائماً
                    if (props.includes('motd=')) {
                        props = props.replace(/motd=.*/g, `motd=§bMinecraft Server §7- §6Powered by §eHnStore`);
                    } else {
                        props += `\nmotd=§bMinecraft Server §7- §6Powered by §eHnStore\n`;
                    }

                    await fs.writeFile(propsPath, props);
                    await this.logToConsole(id, '📝 تم ضبط إعدادات server.properties بنجاح.');
                }

                // 1. تثبيت المكتبات الإضافية
                if (hosting.additionalPackages) {
                    const packages = hosting.additionalPackages.split(' ').filter(p => p.trim());
                    if (packages.length > 0) {
                        await this.logToConsole(id, `ℹ️ جاري تثبيت المكتبات الإضافية: ${packages.join(', ')}`);
                        const nodeCmd = pathToNodeForVersion(hosting.nodeVersion || '16');
                        const npmPath = nodeCmd.replace('node.exe', 'npm.cmd').replace('node', 'npm');
                        await execPromise(`${npmPath} install ${packages.join(' ')}`, { cwd: tempDir });
                    }
                }
            } catch (err) {
                await this.logToConsole(id, `⚠️ خطأ في عمليات ما قبل التشغيل: ${err.message}`);
            }

            // تشغيل العملية
            let childProcess;

            // تحديد الأمر النهائي للتشغيل
            const defaultNodeCommand = 'npm install; node ${MAIN_FILE}';

            // تحقق مما إذا كان الأمر المخزن هو الأمر القديم المكسور (bash-style)
            const legacyBrokenCommand = 'if [[ -d .git ]]';
            let startupCmd = hosting.startupCommand;

            if (startupCmd && startupCmd.includes(legacyBrokenCommand)) {
                console.log(`⚠️ تم اكتشاف أمر تشغيل قديم مكسور للهوست ${hosting.name}، سيتم استخدام الافتراضي.`);
                startupCmd = (hosting.serviceType === 'minecraft') ? null : defaultNodeCommand;
            }

            const startCmd = startupCmd || (hosting.serviceType !== 'minecraft' ? defaultNodeCommand : null);

            if (startCmd) {
                await this.logToConsole(id, '🚀 تشغيل باستخدام أمر مخصص...');

                // استبدال المتغيرات في الأمر
                let finalCommand = startCmd
                    .replace(/\${NODE_PACKAGES}/g, hosting.additionalPackages || '')
                    .replace(/\${UNNODE_PACKAGES}/g, '')
                    .replace(/\${MAIN_FILE}/g, hosting.mainFile || 'index.js')
                    .replace(/\${NODE_ARGS}/g, '')
                    .replace(/\/home\/container\//g, './'); // استبدال مسار الحاوية بالمسار المحلي

                const shell = process.platform === 'win32' ? 'powershell' : 'bash';
                childProcess = spawn(shell, [process.platform === 'win32' ? '-Command' : '-c', finalCommand], {
                    cwd: tempDir,
                    env: {
                        ...process.env,
                        PORT: hosting.port,
                        NODE_ENV: 'production',
                        NODE_PACKAGES: hosting.additionalPackages || '',
                        MAIN_FILE: hosting.mainFile || 'index.js',
                        NODE_ARGS: ''
                    }
                });
            } else if (hosting.serviceType === 'minecraft') {
                // Minecraft يستخدم Java مباشرة
                childProcess = spawn(command, args, {
                    cwd: tempDir,
                    env: {
                        ...process.env,
                        PORT: hosting.port
                    }
                });
            } else {
                const nodeCmd = pathToNodeForVersion(hosting.nodeVersion || '16');
                childProcess = spawn(nodeCmd, args, {
                    cwd: tempDir,
                    env: {
                        ...process.env,
                        PORT: hosting.port,
                        NODE_ENV: 'production'
                    }
                });
            }
            runningProcesses.set(hosting._id.toString(), childProcess);

            // تحديث حالة الهوست
            hosting.status = 'running';
            hosting.pid = childProcess.pid;
            await hosting.save();

            // إرسال رسالة ترحيبية وجميلة عند التشغيل بنجاح
            if (hosting.serviceType === 'minecraft') {
                const joinMsg = `
***************************************************
*                                                 *
*   🚀 تم تشغيل سيرفر الماينكرافت بنجاح!          *
*                                                 *
*   🎮 تفاصيل الدخول:                             *
*   IP: ${publicIp}                                  *
*   PORT: ${hosting.port}                               *
*                                                 *
*   ✨ استمتع باللعب مع HnStore                   *
*                                                 *
***************************************************`;
                await this.logToConsole(id, joinMsg);
            }

            // معالجة مخرجات العملية بشكل سليم (سطر بسطر)
            const HostingModel = require('../models').Hosting; // Moved outside to avoid re-requiring
            let stdoutBuffer = '';
            childProcess.stdout.on('data', (data) => {
                stdoutBuffer += data.toString();
                const lines = stdoutBuffer.split(/\r?\n/);
                stdoutBuffer = lines.pop(); // اترك الجزء الأخير غير المكتمل في البفر

                lines.forEach(line => {
                    if (!line.trim()) return;
                    const clean = stripAnsi(line);
                    console.log(`[${hosting.name}] ${clean}`);

                    HostingModel.updateOne(
                        { _id: hosting._id },
                        {
                            $push: {
                                logs: {
                                    $each: [clean],
                                    $slice: -500
                                }
                            }
                        }
                    ).catch(() => { });

                    try {
                        const io = require('../server').io;
                        if (io) io.to(`console-${hosting._id.toString()}`).emit('console-output', { type: 'info', message: clean });
                    } catch { }
                });

                // أيضاً احفظ في ملف bot.log
                try {
                    const logPath = path.join(tempDir, 'bot.log');
                    fs.appendFileSync(logPath, data.toString());
                } catch { }
            });

            let stderrBuffer = '';
            childProcess.stderr.on('data', (data) => {
                stderrBuffer += data.toString();
                const lines = stderrBuffer.split(/\r?\n/);
                stderrBuffer = lines.pop();

                lines.forEach(line => {
                    if (!line.trim()) return;
                    const clean = stripAnsi(line);
                    console.error(`[${hosting.name}] Error: ${clean}`);

                    HostingModel.updateOne(
                        { _id: hosting._id },
                        {
                            $push: {
                                logs: {
                                    $each: [`Error: ${clean}`],
                                    $slice: -500
                                }
                            }
                        }
                    ).catch(() => { });

                    try {
                        const io = require('../server').io;
                        if (io) io.to(`console-${hosting._id.toString()}`).emit('console-output', { type: 'error', message: clean });
                    } catch { }
                });
                try {
                    const logPath = path.join(tempDir, 'bot.log');
                    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ERROR: ${data.toString()}`);
                } catch { }
            });

            childProcess.on('close', (code) => {
                console.log(`[${hosting.name}] Process exited with code ${code}`);
                runningProcesses.delete(hosting._id.toString());

                // تحديث حالة الهوست
                this.updateHostingStatus(id, 'stopped').catch(err => {
                    console.error('خطأ في تحديث حالة الهوست بعد الإغلاق:', err);
                });

                // لا نحذف المجلد لضمان بقاء السجلات وملفات التشغيل
                try { if (global.io) global.io.to(`console-${hosting._id.toString()}`).emit('console-output', { type: 'warning', message: `Process exited with code ${code}` }); } catch { }
            });

            return hosting;
        } catch (error) {
            console.error('خطأ في تشغيل الهوست:', error);
            throw error;
        }
    }

    /**
     * إيقاف الهوست
     * @param {String} id - معرف الهوست
     * @returns {Promise<Object>} - الهوست بعد الإيقاف
     */
    static async stopHosting(id) {
        try {
            const hosting = await Hosting.findById(id);
            if (!hosting) {
                throw new Error('الهوست غير موجود');
            }

            // إيقاف العملية إذا كانت تعمل
            const key = hosting._id.toString();
            const child = runningProcesses.get(key);
            if (child && !child.killed) {
                try { child.kill(); } catch (e) { }
                runningProcesses.delete(key);
            } else if (hosting.pid) {
                try {
                    if (process.platform === 'win32') {
                        exec(`taskkill /PID ${hosting.pid} /T /F`, () => { });
                    } else {
                        process.kill(hosting.pid);
                    }
                } catch (err) {
                    if (err && err.code !== 'ESRCH') {
                        console.error('خطأ في إيقاف العملية:', err);
                    }
                }
            }

            // تنظيف المجلد المؤقت
            const tempDir = path.join('/tmp', 'hostings', hosting._id.toString());
            await fs.remove(tempDir).catch(err => {
                console.error('خطأ في تنظيف المجلد المؤقت:', err);
            });

            // تحديث حالة الهوست
            hosting.status = 'stopped';
            hosting.pid = null;
            hosting.logs = []; // مسح السجلات عند الإيقاف
            await hosting.save();

            return hosting;
        } catch (error) {
            console.error('خطأ في إيقاف الهوست:', error);
            throw error;
        }
    }

    /**
     * إعادة تشغيل الهوست
     * @param {String} id - معرف الهوست
     * @returns {Promise<Object>} - الهوست بعد إعادة التشغيل
     */
    static async restartHosting(id) {
        try {
            // تحديث حالة الهوست
            await this.updateHostingStatus(id, 'restarting');

            // إيقاف الهوست
            await this.stopHosting(id);

            // تشغيل الهوست
            return await this.startHosting(id);
        } catch (error) {
            console.error('خطأ في إعادة تشغيل الهوست:', error);
            throw error;
        }
    }

    /**
     * حذف الهوست
     * @param {String} id - معرف الهوست
     * @returns {Promise<Boolean>} - نجاح الحذف
     */
    static async deleteHosting(id) {
        try {
            const hosting = await Hosting.findById(id);
            if (!hosting) {
                throw new Error('الهوست غير موجود');
            }

            // إيقاف الهوست إذا كان يعمل
            if (hosting.status === 'running') {
                await this.stopHosting(id);
            }

            // حذف ملفات الهوست
            const files = await File.find({ hosting: id });
            for (const file of files) {
                await FileService.deleteFile(file.fileId);
            }

            // حذف الهوست من المستخدم
            const user = await User.findById(hosting.owner);
            if (user) {
                user.hostings = user.hostings.filter(h => h.toString() !== id);
                await user.save();
            }

            // حذف الهوست
            await Hosting.deleteOne({ _id: id });

            return true;
        } catch (error) {
            console.error('خطأ في حذف الهوست:', error);
            throw error;
        }
    }

    /**
     * تمديد صلاحية الهوست
     * @param {String} id - معرف الهوست
     * @param {Number} days - عدد الأيام
     * @returns {Promise<Object>} - الهوست بعد التمديد
     */
    static async extendHosting(id, days) {
        try {
            const hosting = await Hosting.findById(id);
            if (!hosting) {
                throw new Error('الهوست غير موجود');
            }

            // حساب تاريخ انتهاء الصلاحية الجديد
            const expiryDate = new Date(hosting.expiryDate);
            expiryDate.setDate(expiryDate.getDate() + days);

            // تحديث تاريخ انتهاء الصلاحية
            hosting.expiryDate = expiryDate;
            await hosting.save();

            return hosting;
        } catch (error) {
            console.error('خطأ في تمديد صلاحية الهوست:', error);
            throw error;
        }
    }

    /**
     * تنظيف المساحة المستخدمة
     * @param {String} id - معرف الهوست (اختياري)
     * @returns {Promise<Object>} - معلومات التنظيف
     */
    static async cleanupStorage(id = null) {
        try {
            let totalRemoved = 0;

            // إذا تم تحديد هوست معين
            if (id) {
                const hosting = await Hosting.findById(id);
                if (!hosting) {
                    throw new Error('الهوست غير موجود');
                }

                // تنظيف المجلد المؤقت
                const tempDir = path.join('/tmp', 'hostings', hosting._id.toString());
                if (await fs.pathExists(tempDir)) {
                    const stats = await fs.stat(tempDir);
                    totalRemoved += stats.size;
                    await fs.remove(tempDir);
                }
            } else {
                // تنظيف جميع المجلدات المؤقتة
                const tempDir = path.join('/tmp', 'hostings');
                if (await fs.pathExists(tempDir)) {
                    const dirs = await fs.readdir(tempDir);

                    for (const dir of dirs) {
                        const dirPath = path.join(tempDir, dir);
                        const stats = await fs.stat(dirPath);
                        totalRemoved += stats.size;
                        await fs.remove(dirPath);
                    }
                }
            }

            return {
                removedBytes: totalRemoved,
                removedHuman: this.formatBytes(totalRemoved)
            };
        } catch (error) {
            console.error('خطأ في تنظيف المساحة:', error);
            throw error;
        }
    }

    /**
     * تنسيق حجم الملف
     * @param {Number} bytes - الحجم بالبايت
     * @returns {String} - الحجم المنسق
     */
    static formatBytes(bytes) {
        if (bytes === 0) return '0 Bytes';

        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));

        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    /**
     * الحصول على جميع الملفات في مجلد بشكل متكرر
     * @param {String} dir - المجلد
     * @returns {Promise<Array>} - قائمة بمسارات الملفات
     */
    static async getAllFilesRecursive(dir) {
        let results = [];
        const list = await fs.readdir(dir);
        for (const file of list) {
            const filePath = path.join(dir, file);
            const stat = await fs.stat(filePath);
            if (stat && stat.isDirectory()) {
                results = results.concat(await this.getAllFilesRecursive(filePath));
            } else {
                results.push(filePath);
            }
        }
        return results;
    }


    /**
     * إنشاء نسخة احتياطية
     */
    static async createBackup(hostingId) {
        const hosting = await Hosting.findById(hostingId);
        const hostDir = path.join(__dirname, '..', 'hostings', hostingId.toString());
        const backupDir = path.join(__dirname, '..', 'backups', hostingId.toString());
        await fs.ensureDir(backupDir);

        const backupName = `backup_${Date.now()}.zip`;
        const backupPath = path.join(backupDir, backupName);

        return new Promise((resolve, reject) => {
            const output = fs.createWriteStream(backupPath);
            const archive = archiver('zip', { zlib: { level: 9 } });

            output.on('close', async () => {
                const stats = await fs.stat(backupPath);
                hosting.backups.push({
                    name: backupName,
                    size: (stats.size / (1024 * 1024)).toFixed(2) + ' MB',
                    path: backupPath
                });
                await hosting.save();
                resolve(true);
            });

            archive.on('error', (err) => reject(err));
            archive.pipe(output);
            archive.directory(hostDir, false);
            archive.finalize();
        });
    }

    /**
     * حذف نسخة احتياطية
     */
    static async deleteBackup(hostingId, backupId) {
        const hosting = await Hosting.findById(hostingId);
        const backup = hosting.backups.id(backupId);
        if (backup) {
            if (await fs.pathExists(backup.path)) {
                await fs.remove(backup.path);
            }
            hosting.backups.pull(backupId);
            await hosting.save();
        }
    }

    /**
     * استعادة نسخة احتياطية
     */
    static async restoreBackup(hostingId, backupId) {
        const hosting = await Hosting.findById(hostingId);
        const backup = hosting.backups.id(backupId);
        if (!backup) throw new Error('النسخة غير موجودة');

        const hostDir = path.join(__dirname, '..', 'hostings', hostingId.toString());
        await fs.emptyDir(hostDir);

        await fs.createReadStream(backup.path)
            .pipe(unzipper.Extract({ path: hostDir }))
            .promise();

        return true;
    }

    /**
     * تسجيل رسالة في كونسل الهوست
     */
    static async logToConsole(hostId, message) {
        try {
            const cleanMessage = stripAnsi(message);
            const io = require('../server').io; // الوصول لـ io إذا كان متاحاً
            if (io) {
                io.to(`console-${hostId}`).emit('console-output', {
                    type: 'info',
                    message: cleanMessage,
                    timestamp: new Date().toISOString()
                });
            }

            await HostingModel.updateOne(
                { _id: hostId },
                {
                    $push: {
                        logs: {
                            $each: cleanMessage.split('\n').filter(l => l.trim()),
                            $slice: -500
                        }
                    }
                }
            );
        } catch (e) {
            console.error('Error logging to console:', e);
        }
    }
}

module.exports = HostingService;
