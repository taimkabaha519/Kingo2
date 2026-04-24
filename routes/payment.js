const express = require('express');
const router = express.Router();
const { CreditService } = require('../services');
const { User } = require('../models');
const config = require('../config');

// التحقق من تسجيل الدخول
function ensureAuthenticated(req, res, next) {
    if (req.isAuthenticated()) {
        return next();
    }
    res.status(401).json({ success: false, message: 'يجب تسجيل الدخول أولاً' });
}

// التحقق من الإدارة
function ensureAdmin(req, res, next) {
    if (req.isAuthenticated() && req.user.isAdmin) {
        return next();
    }
    res.status(403).json({ success: false, message: 'غير مصرح لك بالوصول' });
}

// الحصول على رصيد المستخدم
router.get('/credit', ensureAuthenticated, async (req, res) => {
    try {
        const credit = await CreditService.getUserCredit(req.user._id);
        res.json({ success: true, credit });
    } catch (error) {
        console.error('خطأ في الحصول على الرصيد:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// الحصول على سجل المعاملات
router.get('/transactions', ensureAuthenticated, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 10;
        const transactions = await CreditService.getUserTransactions(req.user._id, limit);
        res.json({ success: true, transactions });
    } catch (error) {
        console.error('خطأ في الحصول على سجل المعاملات:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// شراء رصيد باستخدام كردت
router.post('/buy-credit', ensureAuthenticated, async (req, res) => {
    try {
        const { amount } = req.body;
        
        // التحقق من المبلغ
        const numAmount = parseFloat(amount);
        if (isNaN(numAmount) || numAmount <= 0) {
            return res.status(400).json({ success: false, message: 'المبلغ غير صالح' });
        }
        
        // التحقق من حدود المبلغ
        const minAmount = config.payment.credit.minAmount || 1;
        const maxAmount = config.payment.credit.maxAmount || 1000;
        
        if (numAmount < minAmount || numAmount > maxAmount) {
            return res.status(400).json({ 
                success: false, 
                message: `المبلغ يجب أن يكون بين ${minAmount} و ${maxAmount}` 
            });
        }
        
        // إنشاء معاملة وهمية (يمكن استبدالها بمعالج دفع حقيقي)
        const transactionId = 'CREDIT_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
        
        // إضافة الرصيد للمستخدم
        await CreditService.addCredit(req.user._id, numAmount, `شراء رصيد (${transactionId})`);
        
        res.json({ 
            success: true, 
            message: `تمت إضافة ${numAmount} إلى رصيدك بنجاح`,
            transactionId,
            newCredit: await CreditService.getUserCredit(req.user._id)
        });
    } catch (error) {
        console.error('خطأ في شراء الرصيد:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// استخدام كود خصم
router.post('/redeem-code', ensureAuthenticated, async (req, res) => {
    try {
        const { code } = req.body;
        
        if (!code) {
            return res.status(400).json({ success: false, message: 'يجب إدخال كود الخصم' });
        }
        
        const result = await CreditService.redeemCode(req.user._id, code);
        
        res.json({ 
            success: true, 
            message: `تمت إضافة ${result.amount} إلى رصيدك بنجاح`,
            amount: result.amount,
            newCredit: await CreditService.getUserCredit(req.user._id)
        });
    } catch (error) {
        console.error('خطأ في استخدام كود الخصم:', error);
        res.status(400).json({ success: false, message: error.message });
    }
});

// تحويل رصيد لمستخدم آخر
router.post('/transfer', ensureAuthenticated, async (req, res) => {
    try {
        const { username, amount, reason } = req.body;
        
        if (!username || !amount) {
            return res.status(400).json({ success: false, message: 'يجب إدخال اسم المستخدم والمبلغ' });
        }
        
        // التحقق من المبلغ
        const numAmount = parseFloat(amount);
        if (isNaN(numAmount) || numAmount <= 0) {
            return res.status(400).json({ success: false, message: 'المبلغ غير صالح' });
        }
        
        // البحث عن المستخدم المستلم
        const toUser = await User.findOne({ username });
        if (!toUser) {
            return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
        }
        
        // التأكد من أن المستخدم لا يحول لنفسه
        if (toUser._id.toString() === req.user._id.toString()) {
            return res.status(400).json({ success: false, message: 'لا يمكن التحويل لنفسك' });
        }
        
        // تنفيذ التحويل
        await CreditService.transferCredit(req.user._id, toUser._id, numAmount, reason || 'تحويل رصيد');
        
        res.json({ 
            success: true, 
            message: `تم تحويل ${numAmount} إلى ${toUser.username} بنجاح`,
            newCredit: await CreditService.getUserCredit(req.user._id)
        });
    } catch (error) {
        console.error('خطأ في تحويل الرصيد:', error);
        res.status(400).json({ success: false, message: error.message });
    }
});

// إضافة رصيد لمستخدم (للإدارة فقط)
router.post('/admin/add-credit', ensureAdmin, async (req, res) => {
    try {
        const { userId, username, amount, reason } = req.body;
        
        if ((!userId && !username) || !amount) {
            return res.status(400).json({ success: false, message: 'يجب إدخال معرف المستخدم أو اسم المستخدم والمبلغ' });
        }
        
        // التحقق من المبلغ
        const numAmount = parseFloat(amount);
        if (isNaN(numAmount)) {
            return res.status(400).json({ success: false, message: 'المبلغ غير صالح' });
        }
        
        // البحث عن المستخدم
        let user;
        if (userId) {
            user = await User.findById(userId);
        } else {
            user = await User.findOne({ username });
        }
        
        if (!user) {
            return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
        }
        
        // إضافة الرصيد
        await CreditService.addCredit(user._id, numAmount, reason || 'إضافة رصيد من الإدارة');
        
        res.json({ 
            success: true, 
            message: `تمت إضافة ${numAmount} إلى رصيد ${user.username} بنجاح`,
            newCredit: await CreditService.getUserCredit(user._id)
        });
    } catch (error) {
        console.error('خطأ في إضافة رصيد:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// إنشاء كود خصم (للإدارة فقط)
router.post('/admin/create-code', ensureAdmin, async (req, res) => {
    try {
        const { code, amount, maxUses, expiryDate } = req.body;
        
        if (!code || !amount) {
            return res.status(400).json({ success: false, message: 'يجب إدخال الكود والمبلغ' });
        }
        
        // التحقق من المبلغ
        const numAmount = parseFloat(amount);
        if (isNaN(numAmount) || numAmount <= 0) {
            return res.status(400).json({ success: false, message: 'المبلغ غير صالح' });
        }
        
        // التحقق من وجود الكود
        if (config.payment.discountCodes[code]) {
            return res.status(400).json({ success: false, message: 'الكود موجود بالفعل' });
        }
        
        // إنشاء الكود
        config.payment.discountCodes[code] = {
            amount: numAmount,
            maxUses: maxUses ? parseInt(maxUses) : undefined,
            expiryDate: expiryDate || undefined,
            used: 0,
            createdAt: new Date(),
            createdBy: req.user._id
        };
        
        res.json({ 
            success: true, 
            message: `تم إنشاء كود الخصم ${code} بنجاح`,
            code: config.payment.discountCodes[code]
        });
    } catch (error) {
        console.error('خطأ في إنشاء كود خصم:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
