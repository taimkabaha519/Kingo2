const mongoose = require('mongoose');

const domainSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        unique: true
    },
    hosting: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Hosting',
        required: true
    },
    owner: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    status: {
        type: String,
        enum: ['pending', 'active', 'error'],
        default: 'pending'
    },
    sslEnabled: {
        type: Boolean,
        default: false
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    },
    verificationToken: String,
    verifiedAt: Date,
    dnsRecords: [{
        type: {
            type: String,
            enum: ['A', 'CNAME', 'TXT', 'MX'],
            required: true
        },
        name: String,
        value: String,
        priority: Number
    }]
});

module.exports = mongoose.model('Domain', domainSchema);
