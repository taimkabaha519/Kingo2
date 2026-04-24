const mongoose = require('mongoose');
const fs = require('fs-extra');
const path = require('path');
const { GridFSBucket, ServerApiVersion } = require('mongodb');
const config = require('../config');

// تكوين اتصال MongoDB
const connectDB = async () => {
    try {
        // إغلاق الاتصال الحالي إذا كان موجود
        if (mongoose.connection.readyState !== 0) {
            await mongoose.disconnect();
        }

        const mongoURI = (config && config.mongodb && config.mongodb.uri) ? config.mongodb.uri : (process.env.MONGO_URI || 'mongodb://localhost:27017/hn-hosting');
        const configOptions = (config && config.mongodb && config.mongodb.options) ? config.mongodb.options : {};
        
        // دمج serverApi options مع الخيارات الأخرى
        const mongoOptions = {
            ...configOptions,
            serverApi: {
                version: ServerApiVersion.v1,
                strict: true,
                deprecationErrors: true,
            }
        };
        
        console.log('🔄 محاولة الاتصال بقاعدة البيانات MongoDB...');
        
        // إضافة معالجات الأحداث قبل الاتصال
        mongoose.connection.on('connected', () => {
            console.log('🔌 تم الاتصال بقاعدة البيانات MongoDB بنجاح');
            console.log('📡 استخدام MongoDB Stable API v1');
        });
        
        mongoose.connection.on('error', (err) => {
            console.error('❌ خطأ في اتصال MongoDB:', err);
        });
        
        mongoose.connection.on('disconnected', () => {
            console.log('⚠️ تم قطع الاتصال بقاعدة البيانات MongoDB');
        });

        // الاتصال بقاعدة البيانات
        await mongoose.connect(mongoURI, mongoOptions);
        
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

        // إنشاء GridFS Bucket للملفات
        const db = mongoose.connection.db;
        const bucket = new GridFSBucket(db, { bucketName: 'files' });
        global.gridFSBucket = bucket;
        
        return true;
    } catch (err) {
        console.error('❌ خطأ في الاتصال بقاعدة البيانات:', err.message);
        
        // رسائل أوضح للمشاكل الشائعة
        if (err.message.includes('authentication failed') || err.code === 8000) {
            console.error('⚠️ فشل المصادقة: يرجى التحقق من بيانات MongoDB في ملف config.js أو متغيرات البيئة');
            console.error('   تأكد من صحة اسم المستخدم وكلمة المرور في connection string');
            console.error('   مثال: mongodb+srv://username:password@cluster.mongodb.net/');
        } else if (err.message.includes('ENOTFOUND') || err.message.includes('getaddrinfo')) {
            console.error('⚠️ لا يمكن الوصول إلى خادم MongoDB: تحقق من اتصال الإنترنت أو عنوان الخادم');
        } else if (err.message.includes('Connection timeout')) {
            console.error('⚠️ انتهت مهلة الاتصال: تحقق من إعدادات الشبكة أو جدار الحماية');
        }
        
        console.error('تفاصيل الخطأ:', err);
        return false;
    }
};

// دالة إعادة الاتصال التلقائي
const reconnectDB = async () => {
    if (mongoose.connection.readyState === 0) {
        console.log('🔄 محاولة إعادة الاتصال بقاعدة البيانات...');
        return await connectDB();
    } else if (mongoose.connection.readyState === 1) {
        return true;
    } else {
        // انتظار الاتصال إذا كان في حالة اتصال
        try {
            await new Promise((resolve, reject) => {
                if (mongoose.connection.readyState === 1) {
                    resolve();
                } else {
                    mongoose.connection.once('connected', resolve);
                    mongoose.connection.once('error', reject);
                    setTimeout(() => reject(new Error('Reconnection timeout')), 30000);
                }
            });
            return true;
        } catch (error) {
            console.error('خطأ في انتظار الاتصال:', error);
            return await connectDB();
        }
    }
};

// دالة للتحقق من حالة الاتصال
const isConnected = () => {
    return mongoose.connection.readyState === 1;
};

// تصدير النماذج
module.exports = {
    connectDB,
    reconnectDB,
    isConnected,
    User: require('./user'),
    Hosting: require('./hosting'),
    Ticket: require('./ticket'),
    File: require('./file'),
    SharedPackage: require('./sharedPackage'),
    Domain: require('./domain'),
    Log: require('./log')
};
