const { Log } = require('../models');
let geoip;
try {
    geoip = require('geoip-lite');
} catch (error) {
    console.warn('geoip-lite not available, using fallback');
    geoip = null;
}

// دالة للحصول على معلومات IP
function getIPInfo(req) {
    const ip = req.ip || req.connection.remoteAddress || req.socket.remoteAddress || 
               (req.connection.socket ? req.connection.socket.remoteAddress : null) ||
               req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown';
    
    // تنظيف IP من IPv6
    const cleanIP = ip.replace(/^::ffff:/, '');
    
    // الحصول على معلومات الموقع
    const geo = geoip ? geoip.lookup(cleanIP) : null;
    
    return {
        ip: cleanIP,
        country: geo ? geo.country : 'Unknown',
        city: geo ? geo.city : 'Unknown',
        region: geo ? geo.region : 'Unknown'
    };
}

// دالة لتسجيل العمليات
async function logActivity(req, res, next) {
    const startTime = Date.now();
    const originalSend = res.send;
    
    // معلومات IP والموقع
    const ipInfo = getIPInfo(req);
    
    // معلومات المستخدم
    const user = req.user || null;
    
    // معلومات الطلب
    const requestInfo = {
        method: req.method,
        url: req.originalUrl,
        userAgent: req.get('User-Agent'),
        referer: req.get('Referer'),
        sessionId: req.sessionID
    };
    
    // اعتراض response.send
    res.send = function(data) {
        const endTime = Date.now();
        const duration = endTime - startTime;
        
        // تسجيل العملية
        logRequest({
            user,
            ipInfo,
            requestInfo,
            response: {
                statusCode: res.statusCode,
                duration
            }
        }).catch(err => {
            console.error('Error logging request:', err);
        });
        
        // استدعاء الدالة الأصلية
        originalSend.call(this, data);
    };
    
    next();
}

// دالة تسجيل الطلبات
async function logRequest(data) {
    try {
        const { user, ipInfo, requestInfo, response } = data;
        
        // تحديد نوع العملية
        const action = determineAction(requestInfo.url, requestInfo.method);
        
        // تحديد مستوى الخطورة
        const severity = determineSeverity(response.statusCode, action);
        
        // تحديد حالة العملية
        const status = response.statusCode >= 400 ? 'failed' : 'success';
        
        // إنشاء السجل
        const logData = {
            userId: user ? user.discordId : null,
            username: user ? user.username : null,
            userAvatar: user ? user.avatar : null,
            ipAddress: ipInfo.ip,
            userAgent: requestInfo.userAgent,
            country: ipInfo.country,
            city: ipInfo.city,
            action: action,
            description: generateDescription(action, requestInfo.url, user),
            details: {
                method: requestInfo.method,
                url: requestInfo.url,
                statusCode: response.statusCode,
                duration: response.duration,
                referer: requestInfo.referer,
                sessionId: requestInfo.sessionId
            },
            resource: extractResource(requestInfo.url),
            resourceId: extractResourceId(requestInfo.url),
            severity: severity,
            status: status,
            method: requestInfo.method,
            url: requestInfo.url,
            statusCode: response.statusCode,
            sessionId: requestInfo.sessionId,
            referer: requestInfo.referer,
            tags: generateTags(action, requestInfo.url)
        };
        
        // حفظ السجل
        const log = new Log(logData);
        await log.save();
        
    } catch (error) {
        console.error('Error creating log:', error);
    }
}

// دالة تحديد نوع العملية
function determineAction(url, method) {
    // تسجيل الدخول والخروج
    if (url.includes('/auth/discord')) return 'login';
    if (url.includes('/logout')) return 'logout';
    
    // عمليات الاستضافة
    if (url.includes('/hosting/') && method === 'POST') return 'hosting_create';
    if (url.includes('/hosting/') && method === 'DELETE') return 'hosting_delete';
    if (url.includes('/start-bot')) return 'hosting_start';
    if (url.includes('/stop-bot')) return 'hosting_stop';
    if (url.includes('/restart-bot')) return 'hosting_restart';
    
    // عمليات الملفات
    if (url.includes('/upload')) return 'file_upload';
    if (url.includes('/delete') && url.includes('/file')) return 'file_delete';
    if (url.includes('/edit') && url.includes('/file')) return 'file_edit';
    if (url.includes('/download')) return 'file_download';
    
    // عمليات الكونسل
    if (url.includes('/console') && method === 'POST') return 'console_command';
    
    // عمليات الدفع
    if (url.includes('/payment') && url.includes('/success')) return 'payment_success';
    if (url.includes('/payment') && url.includes('/failed')) return 'payment_failed';
    
    // عمليات الإدارة
    if (url.includes('/admin')) return 'admin_action';
    if (url.includes('/ban')) return 'user_ban';
    if (url.includes('/unban')) return 'user_unban';
    
    // API calls
    if (url.includes('/api/')) return 'api_call';
    
    // زيارة الصفحات
    if (method === 'GET' && !url.includes('/api/')) return 'page_visit';
    
    return 'unknown';
}

// دالة تحديد مستوى الخطورة
function determineSeverity(statusCode, action) {
    if (statusCode >= 500) return 'critical';
    if (statusCode >= 400) return 'error';
    if (action === 'security_alert' || action === 'user_ban') return 'warning';
    return 'info';
}

// دالة إنشاء الوصف
function generateDescription(action, url, user) {
    const username = user ? user.username : 'مجهول';
    
    switch (action) {
        case 'login':
            return `${username} قام بتسجيل الدخول`;
        case 'logout':
            return `${username} قام بتسجيل الخروج`;
        case 'hosting_create':
            return `${username} قام بإنشاء استضافة جديدة`;
        case 'hosting_delete':
            return `${username} قام بحذف استضافة`;
        case 'hosting_start':
            return `${username} قام بتشغيل البوت`;
        case 'hosting_stop':
            return `${username} قام بإيقاف البوت`;
        case 'hosting_restart':
            return `${username} قام بإعادة تشغيل البوت`;
        case 'file_upload':
            return `${username} قام برفع ملف`;
        case 'file_delete':
            return `${username} قام بحذف ملف`;
        case 'file_edit':
            return `${username} قام بتعديل ملف`;
        case 'file_download':
            return `${username} قام بتحميل ملف`;
        case 'console_command':
            return `${username} قام بتنفيذ أمر في الكونسل`;
        case 'payment_success':
            return `${username} قام بدفع ناجح`;
        case 'payment_failed':
            return `${username} فشل في الدفع`;
        case 'admin_action':
            return `${username} قام بعمل إداري`;
        case 'user_ban':
            return `${username} تم حظره`;
        case 'user_unban':
            return `${username} تم إلغاء حظره`;
        case 'api_call':
            return `${username} قام باستدعاء API`;
        case 'page_visit':
            return `${username} زار صفحة: ${url}`;
        default:
            return `${username} قام بعملية: ${action}`;
    }
}

// دالة استخراج المورد
function extractResource(url) {
    if (url.includes('/hosting/')) return 'hosting';
    if (url.includes('/file/')) return 'file';
    if (url.includes('/console/')) return 'console';
    if (url.includes('/admin/')) return 'admin';
    if (url.includes('/api/')) return 'api';
    return 'page';
}

// دالة استخراج معرف المورد
function extractResourceId(url) {
    const matches = url.match(/\/([a-f0-9]{24})\//);
    return matches ? matches[1] : null;
}

// دالة إنشاء العلامات
function generateTags(action, url) {
    const tags = [action];
    
    if (url.includes('/admin')) tags.push('admin');
    if (url.includes('/api/')) tags.push('api');
    if (url.includes('/hosting/')) tags.push('hosting');
    if (url.includes('/file/')) tags.push('file');
    if (url.includes('/console/')) tags.push('console');
    if (url.includes('/payment/')) tags.push('payment');
    
    return tags;
}

// دالة تسجيل عمليات مخصصة
async function logCustomActivity(data) {
    try {
        const log = new Log(data);
        await log.save();
        return log;
    } catch (error) {
        console.error('Error logging custom activity:', error);
        throw error;
    }
}

// دالة تسجيل الأخطاء
async function logError(error, req, additionalData = {}) {
    try {
        const ipInfo = getIPInfo(req);
        const user = req.user || null;
        
        const logData = {
            userId: user ? user.discordId : null,
            username: user ? user.username : null,
            userAvatar: user ? user.avatar : null,
            ipAddress: ipInfo.ip,
            userAgent: req.get('User-Agent'),
            country: ipInfo.country,
            city: ipInfo.city,
            action: 'error',
            description: `خطأ: ${error.message}`,
            details: {
                error: error.message,
                stack: error.stack,
                url: req.originalUrl,
                method: req.method,
                ...additionalData
            },
            severity: 'error',
            status: 'failed',
            method: req.method,
            url: req.originalUrl,
            tags: ['error', 'system']
        };
        
        const log = new Log(logData);
        await log.save();
        return log;
    } catch (logError) {
        console.error('Error logging error:', logError);
    }
}

module.exports = {
    logActivity,
    logCustomActivity,
    logError,
    getIPInfo
};
