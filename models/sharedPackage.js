const mongoose = require('mongoose');

const sharedPackageSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        unique: true
    },
    version: {
        type: String,
        required: true
    },
    fileId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true
    },
    size: {
        type: Number,
        required: true
    },
    dependencies: [{
        name: String,
        version: String
    }],
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    },
    usageCount: {
        type: Number,
        default: 0
    }
});

module.exports = mongoose.model('SharedPackage', sharedPackageSchema);
