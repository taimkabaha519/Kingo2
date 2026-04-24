/**
 * سكريبت لتهيئة الحزم المشتركة في MongoDB
 * 
 * هذا السكريبت يقوم بتحميل الحزم الشائعة الاستخدام إلى MongoDB
 * لتكون متاحة لجميع الهوستات بشكل مشترك
 */

const { connectDB } = require('../models');
const { SharedPackageService } = require('../services');

// قائمة الحزم الشائعة
const commonPackages = [
    { name: 'discord.js', version: '14.13.0' },
    { name: 'express', version: '4.18.2' },
    { name: 'axios', version: '1.6.2' },
    { name: 'mongoose', version: '8.0.1' },
    { name: 'socket.io', version: '4.7.2' },
    { name: 'moment', version: '2.29.4' },
    { name: 'fs-extra', version: '11.1.1' },
    { name: 'dotenv', version: '16.3.1' },
    { name: 'cors', version: '2.8.5' },
    { name: 'body-parser', version: '1.20.2' }
];

// تهيئة الحزم المشتركة
async function initSharedPackages() {
    try {
        console.log('🚀 بدء عملية تهيئة الحزم المشتركة...');
        
        // الاتصال بقاعدة البيانات
        await connectDB();
        console.log('✅ تم الاتصال بقاعدة البيانات MongoDB');
        
        // تحميل الحزم المشتركة
        for (const pkg of commonPackages) {
            try {
                console.log(`📦 جاري تحميل الحزمة ${pkg.name}@${pkg.version}...`);
                await SharedPackageService.packageFromNpm(pkg.name, pkg.version);
                console.log(`✅ تم تحميل الحزمة ${pkg.name}@${pkg.version} بنجاح`);
            } catch (error) {
                console.error(`❌ حدث خطأ أثناء تحميل الحزمة ${pkg.name}@${pkg.version}:`, error);
            }
        }
        
        console.log('✅ تمت عملية تهيئة الحزم المشتركة بنجاح!');
        process.exit(0);
    } catch (error) {
        console.error('❌ حدث خطأ أثناء عملية التهيئة:', error);
        process.exit(1);
    }
}

// تشغيل السكريبت
initSharedPackages();
