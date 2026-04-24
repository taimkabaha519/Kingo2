const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
    title: {
        type: String,
        required: true,
        trim: true,
        maxlength: 200
    },
    message: {
        type: String,
        required: true,
        trim: true,
        maxlength: 1000
    },
    type: {
        type: String,
        enum: ['info', 'warning', 'success', 'error', 'ticket', 'message', 'announcement'],
        default: 'info'
    },
    targetType: {
        type: String,
        enum: ['all', 'specific'],
        required: true
    },
    targetUsers: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    readBy: [{
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        },
        readAt: {
            type: Date,
            default: Date.now
        }
    }],
    link: {
        type: String,
        default: null
    },
    priority: {
        type: String,
        enum: ['low', 'medium', 'high', 'urgent'],
        default: 'medium'
    },
    expiresAt: {
        type: Date,
        default: null
    },
    isActive: {
        type: Boolean,
        default: true
    }
}, {
    timestamps: true
});

// Index for better performance
notificationSchema.index({ targetType: 1, isActive: 1, createdAt: -1 });
notificationSchema.index({ targetUsers: 1, isActive: 1, createdAt: -1 });
notificationSchema.index({ 'readBy.user': 1, createdAt: -1 });

// Virtual for unread count
notificationSchema.virtual('unreadCount').get(function() {
    return this.readBy.length;
});

// Method to mark as read for a specific user
notificationSchema.methods.markAsRead = function(userId) {
    const existingRead = this.readBy.find(read => read.user.toString() === userId.toString());
    if (!existingRead) {
        this.readBy.push({ user: userId, readAt: new Date() });
        return this.save();
    }
    return Promise.resolve(this);
};

// Method to check if read by user
notificationSchema.methods.isReadBy = function(userId) {
    return this.readBy.some(read => read.user.toString() === userId.toString());
};

// Static method to get notifications for a user
notificationSchema.statics.getUserNotifications = function(userId, limit = 50) {
    return this.find({
        $and: [
            { isActive: true },
            {
                $or: [
                    { targetType: 'all' },
                    { targetUsers: userId }
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
    .limit(limit);
};

// Static method to create notification
notificationSchema.statics.createNotification = function(data) {
    const notification = new this(data);
    return notification.save();
};

module.exports = mongoose.model('Notification', notificationSchema);
