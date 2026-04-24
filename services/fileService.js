const fs = require('fs-extra');
const path = require('path');
const stream = require('stream');
const { Readable } = stream;
const { File } = require('../models');
const mongoose = require('mongoose');
const admin = require('firebase-admin');
const config = require('../config');

// تهيئة Firebase Admin SDK
let firebaseStorage;
if (config.firebase) {
    try {
        // محاولة تحميل service account من الملف أو من متغير البيئة
        let serviceAccount = null;
        if (config.firebase.serviceAccountPath) {
            try {
                serviceAccount = require(config.firebase.serviceAccountPath);
            } catch (err) {
                console.warn('⚠️ تحذير: لا يمكن تحميل ملف Service Account:', err.message);
            }
        } else if (config.firebase.serviceAccount) {
            serviceAccount = config.firebase.serviceAccount;
        }

        if (serviceAccount) {
            if (!admin.apps.length) {
                // تحديد storageBucket - استخدم من config أو من serviceAccount
                let storageBucket = config.firebase.storageBucket;
                if (!storageBucket && serviceAccount.project_id) {
                    // إذا لم يتم تحديد bucket، استخدم الافتراضي من project_id
                    storageBucket = `${serviceAccount.project_id}.appspot.com`;
                }

                if (!storageBucket) {
                    throw new Error('يجب تحديد storageBucket في config.js أو في service account');
                }

                admin.initializeApp({
                    credential: admin.credential.cert(serviceAccount),
                    storageBucket: storageBucket
                });
            }
            firebaseStorage = admin.storage();
            const bucket = firebaseStorage.bucket();
            console.log(`✅ تم تهيئة Firebase Storage بنجاح (Bucket: ${bucket.name})`);
        } else {
            console.warn('⚠️ تحذير: Firebase service account غير متوفر - سيتم حفظ الملفات محلياً');
        }
    } catch (error) {
        console.error('❌ خطأ في تهيئة Firebase:', error.message);
        console.error('   تأكد من:');
        console.error('   1. وجود ملف service account في:', config.firebase.serviceAccountPath);
        console.error('   2. صحة اسم Storage Bucket');
        console.error('   3. تفعيل Firebase Storage في Firebase Console');
        console.error('   4. صلاحيات Service Account (Storage Admin)');
    }
} else {
    console.warn('⚠️ تحذير: Firebase Storage غير مُكون في config.js');
}

/**
 * خدمة إدارة الملفات باستخدام Firebase Storage
 */
class FileService {
    /**
     * تحميل ملف إلى Firebase Storage
     * @param {String} hostingId - معرف الهوست
     * @param {String} filePath - مسار الملف
     * @param {Buffer|Stream} content - محتوى الملف
     * @param {String} contentType - نوع المحتوى
     * @param {Boolean} isDirectory - هل هو مجلد
     * @returns {Promise<Object>} - معلومات الملف المحفوظ
     */
    static async uploadFile(hostingId, filePath, content, contentType = 'text/plain', isDirectory = false) {
        try {
            const filename = path.basename(filePath);
            const parent = path.dirname(filePath).replace(/\\/g, '/');

            // إذا كان مجلدًا، قم بإنشاء سجل فقط
            if (isDirectory) {
                const file = new File({
                    filename,
                    path: filePath.replace(/\\/g, '/'),
                    hosting: hostingId,
                    fileId: new mongoose.Types.ObjectId(),
                    contentType: 'directory',
                    size: 0,
                    isDirectory: true,
                    parent
                });
                await file.save();
                return file;
            }

            // إذا لم يكن Firebase Storage مُكوناً، احفظ الملف محلياً
            if (!firebaseStorage) {
                console.warn('⚠️ Firebase Storage غير مُكون - سيتم حفظ الملف محلياً');

                // تنظيف مسار الملف
                const normalizedPath = filePath.replace(/\\/g, '/');

                // إنشاء مسار محلي للملف
                const localBasePath = path.join(__dirname, '..', 'hostings', hostingId.toString());
                const localFilePath = path.join(localBasePath, normalizedPath);

                // التأكد من وجود المجلد
                await fs.ensureDir(path.dirname(localFilePath));

                // تحويل المحتوى إلى Buffer إذا لزم الأمر
                let buffer;
                if (Buffer.isBuffer(content)) {
                    buffer = content;
                } else if (typeof content === 'string') {
                    buffer = Buffer.from(content);
                } else if (content instanceof stream.Readable) {
                    buffer = await new Promise((resolve, reject) => {
                        const chunks = [];
                        content.on('data', chunk => chunks.push(chunk));
                        content.on('end', () => resolve(Buffer.concat(chunks)));
                        content.on('error', reject);
                    });
                } else {
                    throw new Error('محتوى الملف غير صالح');
                }

                // حفظ الملف محلياً
                await fs.writeFile(localFilePath, buffer);

                // إنشاء سجل الملف
                const fileRecord = new File({
                    filename,
                    path: normalizedPath,
                    hosting: hostingId,
                    fileId: new mongoose.Types.ObjectId(),
                    firebaseUrl: null, // لا يوجد Firebase URL
                    contentType,
                    size: buffer.length,
                    isDirectory: false,
                    parent
                });

                await fileRecord.save();
                console.log(`✅ تم حفظ الملف محلياً: ${localFilePath}`);
                return fileRecord;
            }

            // تنظيف مسار الملف
            const normalizedPath = filePath.replace(/\\/g, '/');

            // التحقق من وجود ملف بنفس المسار وحذفه إذا كان موجوداً
            const existingFile = await File.findOne({
                hosting: hostingId,
                path: normalizedPath,
                isDirectory: false
            });

            if (existingFile && existingFile.firebaseUrl) {
                // حذف الملف القديم من Firebase Storage
                await this.deleteFileFromFirebase(existingFile.firebaseUrl);
                // حذف السجل القديم
                await File.deleteOne({ _id: existingFile._id });
            }

            // إنشاء مسار Firebase Storage
            const firebasePath = `hostings/${hostingId}/${normalizedPath}`;
            const bucket = firebaseStorage.bucket();
            const file = bucket.file(firebasePath);

            // تحويل المحتوى إلى Buffer إذا لزم الأمر
            let buffer;
            if (Buffer.isBuffer(content)) {
                buffer = content;
            } else if (typeof content === 'string') {
                buffer = Buffer.from(content);
            } else if (content instanceof stream.Readable) {
                // تحويل Stream إلى Buffer
                buffer = await new Promise((resolve, reject) => {
                    const chunks = [];
                    content.on('data', chunk => chunks.push(chunk));
                    content.on('end', () => resolve(Buffer.concat(chunks)));
                    content.on('error', reject);
                });
            } else {
                throw new Error('محتوى الملف غير صالح');
            }

            // رفع الملف إلى Firebase Storage
            await file.save(buffer, {
                metadata: {
                    contentType: contentType,
                    metadata: {
                        hostingId: hostingId.toString(),
                        filename: filename,
                        path: normalizedPath
                    }
                }
            });

            // الحصول على URL العام للملف
            try {
                await file.makePublic();
            } catch (publicError) {
                // إذا فشل makePublic، قد يكون الـ bucket غير عام - هذا ليس خطأ فادح
                console.warn(`تحذير: فشل جعل الملف عام: ${publicError.message}`);
            }

            // الحصول على URL الموقع (signed URL أو public URL)
            let publicUrl;
            try {
                // محاولة الحصول على signed URL صالح لمدة سنة
                const [url] = await file.getSignedUrl({
                    action: 'read',
                    expires: Date.now() + 365 * 24 * 60 * 60 * 1000 // سنة
                });
                publicUrl = url;
            } catch (signedUrlError) {
                // إذا فشل، استخدم public URL
                publicUrl = `https://storage.googleapis.com/${bucket.name}/${firebasePath}`;
            }

            // الحصول على حجم الملف
            const fileSize = buffer.length;

            // إنشاء سجل الملف
            const fileRecord = new File({
                filename,
                path: normalizedPath,
                hosting: hostingId,
                fileId: new mongoose.Types.ObjectId(),
                firebaseUrl: publicUrl,
                contentType,
                size: fileSize,
                isDirectory: false,
                parent
            });

            await fileRecord.save();
            return fileRecord;
        } catch (error) {
            console.error('خطأ في تحميل الملف:', error);
            throw error;
        }
    }

    /**
     * قراءة ملف من Firebase Storage
     * @param {String} fileId - معرف الملف (أو firebaseUrl)
     * @returns {Promise<Stream>} - تيار قراءة الملف
     */
    static async readFile(fileIdOrUrl) {
        try {
            // البحث عن الملف باستخدام fileId أو firebaseUrl
            const file = await File.findOne({
                $or: [
                    { fileId: fileIdOrUrl },
                    { firebaseUrl: fileIdOrUrl }
                ]
            });

            if (!file) {
                throw new Error('الملف غير موجود');
            }

            if (file.isDirectory) {
                throw new Error('لا يمكن قراءة المجلدات');
            }

            if (!file.firebaseUrl) {
                // إذا لم يكن هناك URL لـ Firebase، حاول القراءة من المسار المحلي
                const localFilePath = path.join(__dirname, '..', 'hostings', file.hosting.toString(), file.path);

                if (await fs.pathExists(localFilePath)) {
                    return fs.createReadStream(localFilePath);
                } else {
                    throw new Error('الملف غير موجود محلياً ولا في Firebase Storage');
                }
            }

            if (!firebaseStorage) {
                // إذا كان Firebase Storage غير مُكون ولكن هناك URL، فهناك مشكلة
                // ولكن سنحاول البحث عنه محلياً كخيار أخير
                const localFilePath = path.join(__dirname, '..', 'hostings', file.hosting.toString(), file.path);
                if (await fs.pathExists(localFilePath)) {
                    return fs.createReadStream(localFilePath);
                }
                throw new Error('Firebase Storage غير مُكون والملف غير موجود محلياً');
            }

            // استخراج مسار الملف من URL
            const urlParts = file.firebaseUrl.split('/');
            // ... بقية كود قراءة Firebase
            const bucketName = urlParts[3];
            const firebasePath = urlParts.slice(4).join('/');

            const bucket = firebaseStorage.bucket(bucketName);
            const firebaseFile = bucket.file(firebasePath);

            // تنزيل الملف كـ Stream
            return firebaseFile.createReadStream();
        } catch (error) {
            console.error('خطأ في قراءة الملف:', error);
            throw error;
        }
    }

    /**
     * قراءة محتوى الملف كنص
     * @param {String} fileId - معرف الملف
     * @returns {Promise<String>} - محتوى الملف كنص
     */
    static async readFileAsString(fileId) {
        try {
            const stream = await this.readFile(fileId);

            return new Promise((resolve, reject) => {
                let data = '';
                stream.on('data', chunk => {
                    data += chunk.toString();
                });
                stream.on('end', () => {
                    resolve(data);
                });
                stream.on('error', reject);
            });
        } catch (error) {
            console.error('خطأ في قراءة الملف كنص:', error);
            throw error;
        }
    }

    /**
     * حذف ملف من Firebase Storage
     * @param {String} fileId - معرف الملف
     * @returns {Promise<Boolean>} - نجاح الحذف
     */
    static async deleteFile(fileIdOrUrl) {
        try {
            // البحث عن الملف باستخدام fileId أو firebaseUrl
            const file = await File.findOne({
                $or: [
                    { fileId: fileIdOrUrl },
                    { firebaseUrl: fileIdOrUrl }
                ]
            });

            if (!file) {
                return false;
            }

            // إذا كان مجلدًا، قم بحذف جميع الملفات داخله
            if (file.isDirectory) {
                const files = await File.find({
                    hosting: file.hosting,
                    path: { $regex: `^${file.path}/` }
                });

                for (const childFile of files) {
                    if (!childFile.isDirectory && childFile.firebaseUrl) {
                        await this.deleteFileFromFirebase(childFile.firebaseUrl);
                    }
                    await File.deleteOne({ _id: childFile._id });
                }
            } else {
                // حذف الملف من Firebase Storage
                if (file.firebaseUrl) {
                    await this.deleteFileFromFirebase(file.firebaseUrl);
                }
            }

            // حذف سجل الملف
            await File.deleteOne({ _id: file._id });
            return true;
        } catch (error) {
            console.error('خطأ في حذف الملف:', error);
            throw error;
        }
    }

    /**
     * حذف ملف من Firebase Storage
     * @param {String} firebaseUrl - رابط الملف في Firebase
     * @returns {Promise<void>}
     */
    static async deleteFileFromFirebase(firebaseUrl) {
        try {
            if (!firebaseStorage) {
                return;
            }

            // استخراج مسار الملف من URL
            const urlParts = firebaseUrl.split('/');
            const bucketName = urlParts[3];
            const filePath = urlParts.slice(4).join('/');

            const bucket = firebaseStorage.bucket(bucketName);
            const firebaseFile = bucket.file(filePath);

            await firebaseFile.delete();
        } catch (error) {
            console.error('خطأ في حذف الملف من Firebase:', error);
            // لا نرمي الخطأ لأن الملف قد يكون محذوفًا بالفعل
        }
    }

    /**
     * استخراج الملفات إلى مجلد مؤقت
     * @param {String} hostingId - معرف الهوست
     * @param {String} tempDir - مسار المجلد المؤقت
     * @returns {Promise<String>} - مسار المجلد المؤقت
     */
    static async extractToTemp(hostingId, tempDir = null) {
        try {
            // إنشاء مجلد مؤقت إذا لم يتم تحديده
            if (!tempDir) {
                // استخدم مجلد hostings داخل المشروع ليعمل بشكل موثوق على Windows
                tempDir = path.join(__dirname, '..', 'hostings', hostingId.toString());
            }

            // التأكد من وجود المجلد المؤقت
            await fs.ensureDir(tempDir);

            // الحصول على جميع ملفات الهوست
            const files = await File.find({ hosting: hostingId }).sort({ path: 1 });

            // إنشاء المجلدات أولاً
            for (const file of files) {
                if (file.isDirectory) {
                    const dirPath = path.join(tempDir, file.path);
                    await fs.ensureDir(dirPath);
                }
            }

            // ثم استخراج الملفات
            for (const file of files) {
                if (!file.isDirectory) {
                    const filePath = path.join(tempDir, file.path);
                    const fileDir = path.dirname(filePath);

                    // التأكد من وجود مجلد الملف
                    await fs.ensureDir(fileDir);

                    // قراءة الملف من Firebase Storage وكتابته إلى المجلد المؤقت
                    // إذا كان الملف محلياً بالفعل في نفس المكان، سنتخطى النسخ لتجنب تلف الملف
                    const fileRecord = await File.findOne({ fileId: file.fileId || file.firebaseUrl });
                    const isLocal = !fileRecord?.firebaseUrl;
                    const destinationPath = path.resolve(filePath);
                    const localSourcePath = isLocal ? path.resolve(path.join(__dirname, '..', 'hostings', hostingId.toString(), file.path)) : null;

                    if (isLocal && destinationPath === localSourcePath && await fs.pathExists(destinationPath)) {
                        console.log(`📄 الملف موجود محلياً بالفعل: ${file.path}`);
                        continue;
                    }

                    const readStream = await this.readFile(file.fileId || file.firebaseUrl);
                    const writeStream = fs.createWriteStream(filePath);

                    await new Promise((resolve, reject) => {
                        readStream.pipe(writeStream);
                        writeStream.on('finish', resolve);
                        writeStream.on('error', reject);
                    });
                }
            }

            return tempDir;
        } catch (error) {
            console.error('خطأ في استخراج الملفات:', error);
            throw error;
        }
    }

    /**
     * الحصول على قائمة الملفات في مجلد
     * @param {String} hostingId - معرف الهوست
     * @param {String} directory - المجلد
     * @returns {Promise<Array>} - قائمة الملفات
     */
    static async listFiles(hostingId, directory = '/') {
        try {
            // تنظيف المسار
            directory = directory.replace(/\\/g, '/');
            if (!directory.endsWith('/')) {
                directory += '/';
            }

            // الحصول على الملفات في المجلد المحدد
            const files = await File.find({
                hosting: hostingId,
                parent: directory
            }).sort({ isDirectory: -1, filename: 1 });

            return files;
        } catch (error) {
            console.error('خطأ في قائمة الملفات:', error);
            throw error;
        }
    }

    /**
     * نقل ملف من مجلد إلى آخر
     * @param {String} fileId - معرف الملف
     * @param {String} newParent - المجلد الجديد
     * @returns {Promise<Object>} - الملف بعد التحديث
     */
    static async moveFile(fileIdOrUrl, newParent) {
        try {
            // البحث عن الملف باستخدام fileId أو firebaseUrl
            const file = await File.findOne({
                $or: [
                    { fileId: fileIdOrUrl },
                    { firebaseUrl: fileIdOrUrl }
                ]
            });

            if (!file) {
                throw new Error('الملف غير موجود');
            }

            // تنظيف المسار الجديد
            newParent = newParent.replace(/\\/g, '/');
            if (!newParent.endsWith('/')) {
                newParent += '/';
            }

            // تحديث مسار الملف
            const newPath = `${newParent}${file.filename}`;
            file.parent = newParent;
            file.path = newPath;
            file.updatedAt = new Date();

            await file.save();

            // إذا كان مجلدًا، قم بتحديث مسارات الملفات داخله
            if (file.isDirectory) {
                const childFiles = await File.find({
                    hosting: file.hosting,
                    path: { $regex: `^${file.path}/` }
                });

                for (const childFile of childFiles) {
                    const relativePath = childFile.path.substring(file.path.length);
                    childFile.path = `${newPath}/${relativePath}`;
                    childFile.updatedAt = new Date();
                    await childFile.save();
                }
            }

            return file;
        } catch (error) {
            console.error('خطأ في نقل الملف:', error);
            throw error;
        }
    }
}

module.exports = FileService;