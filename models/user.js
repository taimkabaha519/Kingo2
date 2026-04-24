const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
    type: {
        type: String,
        enum: ['credit', 'debit'],
        required: true
    },
    amount: {
        type: Number,
        required: true
    },
    reason: String,
    timestamp: {
        type: Date,
        default: Date.now
    }
});

const userSchema = new mongoose.Schema({
    discordId: {
        type: String,
        required: true,
        unique: true
    },
    username: {
        type: String,
        required: true
    },
    avatar: String,
    email: String,
    isAdmin: {
        type: Boolean,
        default: false
    },
    isBanned: {
        type: Boolean,
        default: false
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    lastLogin: Date,
    credits: {
        type: Number,
        default: 0
    },
    transactions: [transactionSchema],
    hostings: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Hosting'
    }]
});

module.exports = mongoose.model('User', userSchema);
