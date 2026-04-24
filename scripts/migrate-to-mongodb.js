/**
 * سكريبت لترحيل البيانات من الملفات إلى MongoDB
 * 
 * هذا السكريبت يقوم بترحيل البيانات الموجودة في الملفات المحلية إلى قاعدة بيانات MongoDB
 * يجب تشغيله مرة واحدة فقط قبل تفعيل النظام الجديد
 */

const fs = require('fs-extra');
const path = require('path');
const { connectDB, User, Hosting, File, Ticket } = require('../models');
const { FileService } = require('../services');
const config = require('../config');

// مسار الملفات المحلية
const DATA_DIR = path.join(__dirname, '../data');
const HOSTINGS_DIR = path.join(__dirname, '../hostings');
const TICKETS_DIR = path.join(DATA_DIR, 'tickets.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const HOSTINGS_FILE = path.join(DATA_DIR, 'hostings.json');
const TICKET_MESSAGES_DIR = path.join(DATA_DIR, 'ticket_messages');

// ترحيل البيانات
async function migrateData() {
    try {
        console.log('🚀 بدء عملية ترحيل البيانات إلى MongoDB...');
        
        // الاتصال بقاعدة البيانات
        await connectDB();
        console.log('✅ تم الاتصال بقاعدة البيانات MongoDB');
        
        // ترحيل المستخدمين
        await migrateUsers();
        
        // ترحيل الهوستات
        await migrateHostings();
        
        // ترحيل التذاكر
        await migrateTickets();
        
        console.log('✅ تمت عملية الترحيل بنجاح!');
        process.exit(0);
    } catch (error) {
        console.error('❌ حدث خطأ أثناء عملية الترحيل:', error);
        process.exit(1);
    }
}

// ترحيل المستخدمين
async function migrateUsers() {
    try {
        console.log('📋 ترحيل بيانات المستخدمين...');
        
        // التحقق من وجود ملف المستخدمين
        if (!fs.existsSync(USERS_FILE)) {
            console.log('⚠️ ملف المستخدمين غير موجود، تخطي الترحيل');
            return;
        }
        
        // قراءة بيانات المستخدمين
        const usersData = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
        
        // ترحيل كل مستخدم
        for (const userData of usersData) {
            // التحقق من وجود المستخدم
            const existingUser = await User.findOne({ discordId: userData.id });
            if (existingUser) {
                console.log(`⚠️ المستخدم ${userData.username} موجود بالفعل، تخطي الترحيل`);
                continue;
            }
            
            // إنشاء المستخدم الجديد
            const user = new User({
                discordId: userData.id,
                username: userData.username,
                avatar: userData.avatar,
                email: userData.email,
                isAdmin: userData.isAdmin || false,
                isBanned: userData.isBanned || false,
                createdAt: userData.createdAt || new Date(),
                lastLogin: userData.lastLogin || new Date(),
                credits: userData.credits || 0,
                transactions: []
            });
            
            // إضافة معاملة أولية إذا كان لديه رصيد
            if (userData.credits > 0) {
                user.transactions.push({
                    type: 'credit',
                    amount: userData.credits,
                    reason: 'رصيد مرحل من النظام القديم',
                    timestamp: new Date()
                });
            }
            
            // حفظ المستخدم
            await user.save();
            console.log(`✅ تم ترحيل المستخدم ${userData.username}`);
        }
        
        console.log(`✅ تم ترحيل ${usersData.length} مستخدم بنجاح`);
    } catch (error) {
        console.error('❌ حدث خطأ أثناء ترحيل المستخدمين:', error);
        throw error;
    }
}

// ترحيل الهوستات
async function migrateHostings() {
    try {
        console.log('📋 ترحيل بيانات الهوستات...');
        
        // التحقق من وجود ملف الهوستات
        if (!fs.existsSync(HOSTINGS_FILE)) {
            console.log('⚠️ ملف الهوستات غير موجود، تخطي الترحيل');
            return;
        }
        
        // قراءة بيانات الهوستات
        const hostingsData = JSON.parse(fs.readFileSync(HOSTINGS_FILE, 'utf8'));
        
        // ترحيل كل هوست
        for (const hostingData of hostingsData) {
            try {
                // البحث عن المستخدم
                const user = await User.findOne({ discordId: hostingData.owner });
                if (!user) {
                    console.log(`⚠️ المستخدم غير موجود للهوست ${hostingData.name}، تخطي الترحيل`);
                    continue;
                }
                
                // التحقق من وجود الهوست
                const existingHosting = await Hosting.findOne({ name: hostingData.name, owner: user._id });
                if (existingHosting) {
                    console.log(`⚠️ الهوست ${hostingData.name} موجود بالفعل، تخطي الترحيل`);
                    continue;
                }
                
                // إنشاء الهوست الجديد
                const hosting = new Hosting({
                    name: hostingData.name,
                    owner: user._id,
                    serviceType: hostingData.serviceType || 'discord',
                    siteMode: hostingData.siteMode || 'nodejs',
                    port: hostingData.port || 3000,
                    mainFile: hostingData.mainFile || 'index.js',
                    status: 'stopped',
                    createdAt: hostingData.createdAt || new Date(),
                    expiryDate: hostingData.expiryDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
                    specs: {
                        cpu: hostingData.cpu || 1,
                        ram: hostingData.ram || 512,
                        storage: hostingData.storage || 1
                    },
                    logs: hostingData.logs || []
                });
                
                // حفظ الهوست
                await hosting.save();
                
                // إضافة الهوست للمستخدم
                user.hostings.push(hosting._id);
                await user.save();
                
                // ترحيل ملفات الهوست
                await migrateHostingFiles(hostingData.id || hostingData.name, hosting._id);
                
                console.log(`✅ تم ترحيل الهوست ${hostingData.name}`);
            } catch (error) {
                console.error(`❌ حدث خطأ أثناء ترحيل الهوست ${hostingData.name}:`, error);
            }
        }
        
        console.log(`✅ تم ترحيل ${hostingsData.length} هوست بنجاح`);
    } catch (error) {
        console.error('❌ حدث خطأ أثناء ترحيل الهوستات:', error);
        throw error;
    }
}

// ترحيل ملفات الهوست
async function migrateHostingFiles(oldId, newId) {
    try {
        const hostingDir = path.join(HOSTINGS_DIR, oldId.toString());
        
        // التحقق من وجود مجلد الهوست
        if (!fs.existsSync(hostingDir)) {
            console.log(`⚠️ مجلد الهوست ${oldId} غير موجود، تخطي ترحيل الملفات`);
            return;
        }
        
        // قراءة جميع الملفات والمجلدات
        const files = await getAllFiles(hostingDir);
        
        // ترحيل كل ملف
        for (const file of files) {
            try {
                // الحصول على المسار النسبي
                const relativePath = path.relative(hostingDir, file);
                
                // التحقق مما إذا كان مجلدًا
                const stats = fs.statSync(file);
                const isDirectory = stats.isDirectory();
                
                if (isDirectory) {
                    // إنشاء مجلد في MongoDB
                    await FileService.uploadFile(newId, relativePath, null, 'directory', true);
                } else {
                    // قراءة محتوى الملف
                    const content = fs.readFileSync(file);
                    
                    // تحديد نوع المحتوى
                    const contentType = getContentType(file);
                    
                    // تحميل الملف إلى MongoDB
                    await FileService.uploadFile(newId, relativePath, content, contentType);
                }
            } catch (error) {
                console.error(`❌ حدث خطأ أثناء ترحيل الملف ${file}:`, error);
            }
        }
        
        console.log(`✅ تم ترحيل ${files.length} ملف للهوست ${oldId}`);
    } catch (error) {
        console.error(`❌ حدث خطأ أثناء ترحيل ملفات الهوست ${oldId}:`, error);
        throw error;
    }
}

// ترحيل التذاكر
async function migrateTickets() {
    try {
        console.log('📋 ترحيل بيانات التذاكر...');
        
        // التحقق من وجود ملف التذاكر
        if (!fs.existsSync(TICKETS_DIR)) {
            console.log('⚠️ ملف التذاكر غير موجود، تخطي الترحيل');
            return;
        }
        
        // قراءة بيانات التذاكر
        const ticketsData = JSON.parse(fs.readFileSync(TICKETS_DIR, 'utf8'));
        
        // ترحيل كل تذكرة
        for (const ticketData of ticketsData) {
            try {
                // البحث عن المستخدم
                const user = await User.findOne({ discordId: ticketData.userId });
                if (!user) {
                    console.log(`⚠️ المستخدم غير موجود للتذكرة ${ticketData.id}، تخطي الترحيل`);
                    continue;
                }
                
                // التحقق من وجود التذكرة
                const existingTicket = await Ticket.findOne({ id: ticketData.id });
                if (existingTicket) {
                    console.log(`⚠️ التذكرة ${ticketData.id} موجودة بالفعل، تخطي الترحيل`);
                    continue;
                }
                
                // قراءة رسائل التذكرة
                const messagesFile = path.join(TICKET_MESSAGES_DIR, `${ticketData.id}.json`);
                let messages = [];
                
                if (fs.existsSync(messagesFile)) {
                    try {
                        const messagesData = JSON.parse(fs.readFileSync(messagesFile, 'utf8'));
                        
                        // تحويل الرسائل إلى التنسيق الجديد
                        messages = messagesData.map(msg => ({
                            sender: msg.userId ? user._id : null,
                            senderName: msg.username || 'النظام',
                            content: msg.content,
                            timestamp: msg.timestamp ? new Date(msg.timestamp) : new Date(),
                            isSystem: msg.isSystem || false
                        }));
                    } catch (error) {
                        console.error(`❌ حدث خطأ أثناء قراءة رسائل التذكرة ${ticketData.id}:`, error);
                    }
                }
                
                // إنشاء التذكرة الجديدة
                const ticket = new Ticket({
                    id: ticketData.id,
                    subject: ticketData.subject || 'بدون عنوان',
                    type: ticketData.type || 'support',
                    description: ticketData.description || '',
                    user: user._id,
                    status: ticketData.status || 'open',
                    createdAt: ticketData.createdAt ? new Date(ticketData.createdAt) : new Date(),
                    updatedAt: ticketData.updatedAt ? new Date(ticketData.updatedAt) : new Date(),
                    messages
                });
                
                // حفظ التذكرة
                await ticket.save();
                
                console.log(`✅ تم ترحيل التذكرة ${ticketData.id}`);
            } catch (error) {
                console.error(`❌ حدث خطأ أثناء ترحيل التذكرة ${ticketData.id}:`, error);
            }
        }
        
        console.log(`✅ تم ترحيل ${ticketsData.length} تذكرة بنجاح`);
    } catch (error) {
        console.error('❌ حدث خطأ أثناء ترحيل التذاكر:', error);
        throw error;
    }
}

// الحصول على جميع الملفات في مجلد بشكل متكرر
async function getAllFiles(dir, fileList = []) {
    const files = fs.readdirSync(dir);
    
    for (const file of files) {
        const filePath = path.join(dir, file);
        const stats = fs.statSync(filePath);
        
        if (stats.isDirectory()) {
            fileList.push(filePath);
            await getAllFiles(filePath, fileList);
        } else {
            fileList.push(filePath);
        }
    }
    
    return fileList;
}

// تحديد نوع المحتوى بناءً على امتداد الملف
function getContentType(filePath) {
    const extension = path.extname(filePath).toLowerCase();
    
    const contentTypes = {
        '.html': 'text/html',
        '.css': 'text/css',
        '.js': 'application/javascript',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.pdf': 'application/pdf',
        '.txt': 'text/plain',
        '.md': 'text/markdown',
        '.mp3': 'audio/mpeg',
        '.mp4': 'video/mp4',
        '.zip': 'application/zip'
    };
    
    return contentTypes[extension] || 'application/octet-stream';
}

// تشغيل السكريبت
migrateData();
