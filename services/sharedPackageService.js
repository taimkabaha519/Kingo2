const { SharedPackage } = require('../models');
const FileService = require('./fileService');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const stream = require('stream');
const { Readable } = stream;

/**
 * خدمة إدارة الحزم المشتركة
 */
class SharedPackageService {
    /**
     * إضافة حزمة مشتركة جديدة
     * @param {String} name - اسم الحزمة
     * @param {String} version - إصدار الحزمة
     * @param {Buffer|Stream} content - محتوى الحزمة
     * @returns {Promise<Object>} - الحزمة المشتركة الجديدة
     */
    static async addSharedPackage(name, version, content) {
        try {
            // التحقق من وجود الحزمة
            const existingPackage = await SharedPackage.findOne({ name, version });
            if (existingPackage) {
                throw new Error(`الحزمة ${name}@${version} موجودة بالفعل`);
            }
            
            // تحويل المحتوى إلى تيار إذا كان مخزنًا
            let packageStream;
            if (Buffer.isBuffer(content)) {
                packageStream = new Readable();
                packageStream.push(content);
                packageStream.push(null);
            } else if (content instanceof stream.Readable) {
                packageStream = content;
            } else {
                throw new Error('محتوى الحزمة غير صالح');
            }
            
            // إنشاء تيار كتابة GridFS
            const uploadStream = global.gridFSBucket.openUploadStream(`${name}@${version}`);
            
            // إنشاء وعد لانتظار اكتمال التحميل
            const uploadPromise = new Promise((resolve, reject) => {
                uploadStream.on('error', reject);
                uploadStream.on('finish', resolve);
            });
            
            // كتابة المحتوى إلى GridFS
            packageStream.pipe(uploadStream);
            
            // انتظار اكتمال التحميل
            await uploadPromise;
            
            // إنشاء سجل الحزمة المشتركة
            const sharedPackage = new SharedPackage({
                name,
                version,
                fileId: uploadStream.id,
                size: uploadStream.length,
                dependencies: []
            });
            
            await sharedPackage.save();
            return sharedPackage;
        } catch (error) {
            console.error('خطأ في إضافة حزمة مشتركة:', error);
            throw error;
        }
    }
    
    /**
     * الحصول على حزمة مشتركة
     * @param {String} name - اسم الحزمة
     * @param {String} version - إصدار الحزمة (اختياري)
     * @returns {Promise<Object>} - الحزمة المشتركة
     */
    static async getSharedPackage(name, version = null) {
        try {
            const query = { name };
            if (version) {
                query.version = version;
            } else {
                // إذا لم يتم تحديد الإصدار، قم بإرجاع أحدث إصدار
                const packages = await SharedPackage.find({ name }).sort({ createdAt: -1 }).limit(1);
                if (packages.length === 0) {
                    throw new Error(`الحزمة ${name} غير موجودة`);
                }
                return packages[0];
            }
            
            const sharedPackage = await SharedPackage.findOne(query);
            if (!sharedPackage) {
                throw new Error(`الحزمة ${name}@${version} غير موجودة`);
            }
            
            return sharedPackage;
        } catch (error) {
            console.error('خطأ في الحصول على حزمة مشتركة:', error);
            throw error;
        }
    }
    
    /**
     * تنزيل حزمة مشتركة إلى مجلد محلي
     * @param {String} name - اسم الحزمة
     * @param {String} version - إصدار الحزمة (اختياري)
     * @param {String} targetDir - المجلد المستهدف
     * @returns {Promise<String>} - مسار الحزمة المنزلة
     */
    static async downloadSharedPackage(name, version = null, targetDir) {
        try {
            // الحصول على الحزمة
            const sharedPackage = await this.getSharedPackage(name, version);
            
            // التأكد من وجود المجلد المستهدف
            await fs.ensureDir(targetDir);
            
            // تنزيل الحزمة
            const readStream = global.gridFSBucket.openDownloadStream(sharedPackage.fileId);
            const packagePath = path.join(targetDir, `${name}@${sharedPackage.version}.tgz`);
            const writeStream = fs.createWriteStream(packagePath);
            
            await new Promise((resolve, reject) => {
                readStream.pipe(writeStream);
                writeStream.on('finish', resolve);
                writeStream.on('error', reject);
            });
            
            // تحديث عداد الاستخدام
            sharedPackage.usageCount += 1;
            await sharedPackage.save();
            
            return packagePath;
        } catch (error) {
            console.error('خطأ في تنزيل حزمة مشتركة:', error);
            throw error;
        }
    }
    
    /**
     * تثبيت حزمة مشتركة في مجلد محلي
     * @param {String} name - اسم الحزمة
     * @param {String} version - إصدار الحزمة (اختياري)
     * @param {String} targetDir - المجلد المستهدف
     * @returns {Promise<Object>} - نتيجة التثبيت
     */
    static async installSharedPackage(name, version = null, targetDir) {
        try {
            // تنزيل الحزمة
            const packagePath = await this.downloadSharedPackage(name, version, targetDir);
            
            // التأكد من وجود مجلد node_modules
            const nodeModulesPath = path.join(targetDir, 'node_modules');
            await fs.ensureDir(nodeModulesPath);
            
            // تثبيت الحزمة
            const { stdout, stderr } = await execAsync(`npm install --no-save ${packagePath}`, { cwd: targetDir });
            
            // حذف ملف الحزمة بعد التثبيت
            await fs.remove(packagePath);
            
            return {
                success: true,
                stdout,
                stderr
            };
        } catch (error) {
            console.error('خطأ في تثبيت حزمة مشتركة:', error);
            throw error;
        }
    }
    
    /**
     * حزم حزمة من npm وإضافتها كحزمة مشتركة
     * @param {String} name - اسم الحزمة
     * @param {String} version - إصدار الحزمة (اختياري)
     * @returns {Promise<Object>} - الحزمة المشتركة الجديدة
     */
    static async packageFromNpm(name, version = 'latest') {
        try {
            // إنشاء مجلد مؤقت
            const tempDir = path.join('/tmp', 'npm-packages', `${name}-${Date.now()}`);
            await fs.ensureDir(tempDir);
            
            try {
                // تنزيل الحزمة من npm
                const { stdout } = await execAsync(`npm pack ${name}@${version}`, { cwd: tempDir });
                
                // الحصول على اسم ملف الحزمة
                const packageFileName = stdout.trim();
                const packagePath = path.join(tempDir, packageFileName);
                
                // قراءة ملف الحزمة
                const packageContent = await fs.readFile(packagePath);
                
                // استخراج معلومات الحزمة
                const packageInfo = packageFileName.split('-');
                const actualVersion = packageInfo[packageInfo.length - 1].replace('.tgz', '');
                
                // إضافة الحزمة كحزمة مشتركة
                const sharedPackage = await this.addSharedPackage(name, actualVersion, packageContent);
                
                // تنظيف المجلد المؤقت
                await fs.remove(tempDir);
                
                return sharedPackage;
            } catch (error) {
                // تنظيف المجلد المؤقت في حالة الخطأ
                await fs.remove(tempDir);
                throw error;
            }
        } catch (error) {
            console.error('خطأ في حزم حزمة من npm:', error);
            throw error;
        }
    }
    
    /**
     * الحصول على قائمة الحزم المشتركة
     * @returns {Promise<Array>} - قائمة الحزم المشتركة
     */
    static async listSharedPackages() {
        try {
            return await SharedPackage.find().sort({ name: 1, version: -1 });
        } catch (error) {
            console.error('خطأ في الحصول على قائمة الحزم المشتركة:', error);
            throw error;
        }
    }
    
    /**
     * حذف حزمة مشتركة
     * @param {String} id - معرف الحزمة المشتركة
     * @returns {Promise<Boolean>} - نجاح الحذف
     */
    static async deleteSharedPackage(id) {
        try {
            const sharedPackage = await SharedPackage.findById(id);
            if (!sharedPackage) {
                throw new Error('الحزمة المشتركة غير موجودة');
            }
            
            // حذف الملف من GridFS
            await global.gridFSBucket.delete(sharedPackage.fileId);
            
            // حذف سجل الحزمة المشتركة
            await SharedPackage.deleteOne({ _id: id });
            
            return true;
        } catch (error) {
            console.error('خطأ في حذف حزمة مشتركة:', error);
            throw error;
        }
    }
}

module.exports = SharedPackageService;
