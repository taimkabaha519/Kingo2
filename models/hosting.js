const mongoose = require('mongoose');

const hostingSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },
    owner: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    serviceType: {
        type: String,
        enum: ['discord', 'web', 'mta', 'fivem', 'minecraft'],
        default: 'discord'
    },
    siteMode: {
        type: String,
        enum: ['nodejs', 'html'],
        default: 'nodejs'
    },
    port: {
        type: Number
    },
    mainFile: {
        type: String,
        default: 'index.js'
    },
    nodeVersion: {
        type: String,
        default: '16'
    },
    status: {
        type: String,
        enum: ['running', 'stopped', 'restarting', 'error'],
        default: 'stopped'
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    expiryDate: {
        type: Date,
        required: true
    },
    specs: {
        cpu: {
            type: Number,
            default: 1
        },
        ram: {
            type: Number,
            default: 512
        },
        storage: {
            type: Number,
            default: 1
        }
    },
    files: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'File'
    }],
    domains: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Domain'
    }],
    pid: Number,
    logs: [String],
    logo: {
        type: String,
        default: null
    },
    // حقول البدء (Startup settings)
    startupCommand: {
        type: String,
        default: 'npm install; node ${MAIN_FILE}'
    },
    autoUpdate: {
        type: Boolean,
        default: false
    },
    additionalPackages: {
        type: String,
        default: ''
    },
    gitRepo: {
        type: String,
        default: ''
    },
    gitUsername: {
        type: String,
        default: ''
    },
    gitAccessToken: {
        type: String,
        default: ''
    },
    backups: [{
        name: String,
        size: String,
        createdAt: {
            type: Date,
            default: Date.now
        },
        path: String,
        firebaseUrl: String
    }],
    proxyAddress: {
        type: String,
        default: null
    }
});

// طريقة مساعدة للحصول على مسار الهوست
hostingSchema.methods.getPath = function () {
    return `/tmp/hostings/${this._id}`;
};

// طريقة مساعدة للتحقق مما إذا كان الهوست منتهي الصلاحية
hostingSchema.methods.isExpired = function () {
    return new Date() > this.expiryDate;
};

module.exports = mongoose.model('Hosting', hostingSchema);
