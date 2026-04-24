const mongoose = require('mongoose');

const logSchema = new mongoose.Schema({
    // معلومات المستخدم
    userId: {
        type: String,
        required: false,
        index: true
    },
    username: {
        type: String,
        required: false
    },
    userAvatar: {
        type: String,
        required: false
    },
    
    // معلومات IP والموقع
    ipAddress: {
        type: String,
        required: true,
        index: true
    },
    userAgent: {
        type: String,
        required: false
    },
    country: {
        type: String,
        required: false
    },
    city: {
        type: String,
        required: false
    },
    
    // نوع العملية
    action: {
        type: String,
        required: true,
        enum: [
            'login', 'logout', 'register',
            'hosting_create', 'hosting_delete', 'hosting_start', 'hosting_stop', 'hosting_restart',
            'file_upload', 'file_delete', 'file_edit', 'file_download',
            'console_command', 'console_output',
            'payment_success', 'payment_failed',
            'admin_action', 'user_ban', 'user_unban',
            'api_call', 'error', 'security_alert',
            'page_visit', 'download', 'upload'
        ],
        index: true
    },
    
    // تفاصيل العملية
    description: {
        type: String,
        required: true
    },
    details: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    },
    
    // معلومات إضافية
    resource: {
        type: String, // مثل: hosting_id, file_path, etc.
        required: false
    },
    resourceId: {
        type: String,
        required: false,
        index: true
    },
    
    // مستوى الخطورة
    severity: {
        type: String,
        enum: ['info', 'warning', 'error', 'critical'],
        default: 'info',
        index: true
    },
    
    // حالة العملية
    status: {
        type: String,
        enum: ['success', 'failed', 'pending'],
        default: 'success',
        index: true
    },
    
    // معلومات HTTP
    method: {
        type: String,
        required: false
    },
    url: {
        type: String,
        required: false
    },
    statusCode: {
        type: Number,
        required: false
    },
    
    // معلومات إضافية
    sessionId: {
        type: String,
        required: false,
        index: true
    },
    referer: {
        type: String,
        required: false
    },
    
    // الطوابع الزمنية
    timestamp: {
        type: Date,
        default: Date.now,
        index: true
    },
    
    // معلومات إضافية للبحث
    tags: [{
        type: String,
        index: true
    }]
}, {
    timestamps: true
});

// فهارس للبحث السريع
logSchema.index({ timestamp: -1 });
logSchema.index({ userId: 1, timestamp: -1 });
logSchema.index({ ipAddress: 1, timestamp: -1 });
logSchema.index({ action: 1, timestamp: -1 });
logSchema.index({ severity: 1, timestamp: -1 });
logSchema.index({ status: 1, timestamp: -1 });

// دالة للبحث المتقدم
logSchema.statics.searchLogs = function(query) {
    const {
        userId,
        ipAddress,
        action,
        severity,
        status,
        startDate,
        endDate,
        search,
        limit = 100,
        skip = 0
    } = query;
    
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
    
    return this.find(filter)
        .sort({ timestamp: -1 })
        .limit(limit)
        .skip(skip);
};

// دالة للحصول على إحصائيات
logSchema.statics.getStats = function(startDate, endDate) {
    const filter = {};
    if (startDate || endDate) {
        filter.timestamp = {};
        if (startDate) filter.timestamp.$gte = new Date(startDate);
        if (endDate) filter.timestamp.$lte = new Date(endDate);
    }
    
    return this.aggregate([
        { $match: filter },
        {
            $group: {
                _id: null,
                total: { $sum: 1 },
                byAction: {
                    $push: {
                        action: '$action',
                        count: 1
                    }
                },
                bySeverity: {
                    $push: {
                        severity: '$severity',
                        count: 1
                    }
                },
                byStatus: {
                    $push: {
                        status: '$status',
                        count: 1
                    }
                },
                uniqueUsers: { $addToSet: '$userId' },
                uniqueIPs: { $addToSet: '$ipAddress' }
            }
        },
        {
            $project: {
                total: 1,
                uniqueUsersCount: { $size: '$uniqueUsers' },
                uniqueIPsCount: { $size: '$uniqueIPs' },
                byAction: 1,
                bySeverity: 1,
                byStatus: 1
            }
        }
    ]);
};

module.exports = mongoose.model('Log', logSchema);
