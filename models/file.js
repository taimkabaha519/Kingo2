const mongoose = require('mongoose');

const fileSchema = new mongoose.Schema({
    filename: {
        type: String,
        required: true
    },
    path: {
        type: String,
        required: true
    },
    hosting: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Hosting',
        required: true
    },
    fileId: {
        type: mongoose.Schema.Types.ObjectId,
        required: false
    },
    firebaseUrl: {
        type: String,
        required: false
    },
    contentType: {
        type: String,
        default: 'text/plain'
    },
    size: {
        type: Number,
        required: true
    },
    isDirectory: {
        type: Boolean,
        default: false
    },
    parent: {
        type: String,
        default: '/'
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
});

// طريقة مساعدة للحصول على المسار الكامل
fileSchema.methods.getFullPath = function() {
    return `${this.parent}/${this.filename}`.replace(/\/+/g, '/');
};

module.exports = mongoose.model('File', fileSchema);
