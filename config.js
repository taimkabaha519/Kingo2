// Hn Hosting Configuration
const path = require('path');

module.exports = {
    // MongoDB Configuration
    mongodb: {
        uri: process.env.MONGO_URI || 'mongodb+srv://kingoooo:2UF1Sr9651i0ozD6@cluster0.gfq8bqn.mongodb.net/',
        options: {
            // Removed useNewUrlParser and useUnifiedTopology (deprecated in MongoDB driver 4.0+)
            serverSelectionTimeoutMS: 10000, // 10 seconds (reduced for faster failure detection)
            connectTimeoutMS: 10000, // 10 seconds
            socketTimeoutMS: 45000, // 45 seconds
            maxPoolSize: 50, // Increased for better performance
            minPoolSize: 5, // Maintain minimum connections
            maxIdleTimeMS: 30000, // Close connections after 30 seconds of inactivity
            bufferCommands: false, // Disable mongoose buffering
            retryWrites: true,
            retryReads: true,
            heartbeatFrequencyMS: 10000 // Check connection health every 10 seconds
        }
    },

    // Server Configuration
    server: {
        port: process.env.PORT || 3001,
        address: process.env.SERVER_ADDRESS || 'localhost:3001',
        publicIp: process.env.SERVER_IP || 'localhost:3000'
    },

    // Discord Bot Configuration
    discord: {
        token: process.env.DISCORD_BOT_TOKEN,
        clientId: process.env.DISCORD_CLIENT_ID,
        clientSecret: process.env.DISCORD_CLIENT_SECRET,
        callbackUrl: process.env.DISCORD_CALLBACK_URL || 'http://localhost:3000/auth/discord/callback',
        adminIds: (process.env.DISCORD_ADMIN_IDS || '').split(',').filter(Boolean)
    },

    // Hosting Configuration
    hosting: {
        defaultMainFile: 'index.js',
        defaultNodeVersion: '16',
        tempDir: '/tmp/hostings',
        sharedNodeModules: '/tmp/shared_node_modules'
    },

    // Pricing Configuration
    prices: {
        discord: [
            {
                name: 'Basic',
                price: 2,
                ram: 512,
                cpu: 1,
                storage: 1,
                duration: 30
            },
            {
                name: 'Standard',
                price: 5,
                ram: 1024,
                cpu: 2,
                storage: 2,
                duration: 30
            },
            {
                name: 'Premium',
                price: 10,
                ram: 2048,
                cpu: 4,
                storage: 5,
                duration: 30
            }
        ],
        web: [
            {
                name: 'Basic Web',
                price: 3,
                ram: 512,
                cpu: 1,
                storage: 1,
                duration: 30
            },
            {
                name: 'Standard Web',
                price: 7,
                ram: 1024,
                cpu: 2,
                storage: 3,
                duration: 30
            },
            {
                name: 'Premium Web',
                price: 15,
                ram: 2048,
                cpu: 4,
                storage: 10,
                duration: 30
            }
        ],
        minecraft: [
            {
                name: 'Basic Minecraft',
                price: 5,
                ram: 1024,
                cpu: 1,
                storage: 2,
                duration: 30
            },
            {
                name: 'Standard Minecraft',
                price: 10,
                ram: 2048,
                cpu: 2,
                storage: 5,
                duration: 30
            },
            {
                name: 'Premium Minecraft',
                price: 20,
                ram: 4096,
                cpu: 4,
                storage: 10,
                duration: 30
            },
            {
                name: 'Ultra Minecraft',
                price: 35,
                ram: 8192,
                cpu: 6,
                storage: 20,
                duration: 30
            }
        ],
        default: [
            {
                name: 'Basic',
                price: 2,
                ram: 512,
                cpu: 1,
                storage: 1,
                duration: 30
            }
        ]
    },

    // Payment Configuration
    payment: {
        credit: {
            enabled: true,
            minAmount: 1,
            maxAmount: 1000
        },
        enabled: true,
        discountCodes: {},
        paypal: {
            clientId: process.env.PAYPAL_CLIENT_ID || 'AQtxQ9tIgSonKI8yDl6wX7xz0xccBXEgq4DUtb1XX3ERAv1HBd5ZsKt7yeJWZojosgl1ZCvwLCBZhlek',
            clientSecret: process.env.PAYPAL_CLIENT_SECRET || 'EAFgrDc2bQ6nOrCoYaW3antMSXkDyCIfMLvwa1eXkuf1mZB_HfmR6IaylRraMw3jIm3JhOEL_BPuiix3',
            mode: process.env.PAYPAL_MODE || 'sandbox', // 'sandbox' or 'live'
            enabled: true
        }
    },

    // Firebase Configuration - معطل مؤقتاً
    firebase: null
    // firebase: {
    //     storageBucket: process.env.FIREBASE_STORAGE_BUCKET || 'hnstoreweb.appspot.com',
    //     serviceAccount: process.env.FIREBASE_SERVICE_ACCOUNT ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT) : null,
    //     serviceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT_PATH || path.join(__dirname, 'config', 'firebase-service-account.json')
    // }
};
