const { User } = require('../models');

/**
 * خدمة إدارة الرصيد
 */
class CreditService {
    /**
     * إضافة رصيد للمستخدم
     * @param {String} userId - معرف المستخدم
     * @param {Number} amount - المبلغ المراد إضافته
     * @param {String} reason - سبب الإضافة
     * @returns {Promise<Object>} - المستخدم بعد التحديث
     */
    static async addCredit(userId, amount, reason = 'إضافة رصيد') {
        try {
            const user = await User.findById(userId);
            if (!user) {
                throw new Error('المستخدم غير موجود');
            }
            
            // التأكد من أن المبلغ موجب
            amount = Math.abs(amount);
            
            // إضافة الرصيد
            user.credits = (user.credits || 0) + amount;
            
            // إضافة سجل المعاملة
            if (!user.transactions) {
                user.transactions = [];
            }
            
            user.transactions.push({
                type: 'credit',
                amount,
                reason,
                timestamp: new Date()
            });
            
            await user.save();
            return user;
        } catch (error) {
            console.error('خطأ في إضافة رصيد:', error);
            throw error;
        }
    }
    
    /**
     * خصم رصيد من المستخدم
     * @param {String} userId - معرف المستخدم
     * @param {Number} amount - المبلغ المراد خصمه
     * @param {String} reason - سبب الخصم
     * @returns {Promise<Object>} - المستخدم بعد التحديث
     */
    static async deductCredit(userId, amount, reason = 'خصم رصيد') {
        try {
            const user = await User.findById(userId);
            if (!user) {
                throw new Error('المستخدم غير موجود');
            }
            
            // التأكد من أن المبلغ موجب
            amount = Math.abs(amount);
            
            // التحقق من كفاية الرصيد
            if ((user.credits || 0) < amount) {
                throw new Error('الرصيد غير كافٍ');
            }
            
            // خصم الرصيد
            user.credits -= amount;
            
            // إضافة سجل المعاملة
            if (!user.transactions) {
                user.transactions = [];
            }
            
            user.transactions.push({
                type: 'debit',
                amount,
                reason,
                timestamp: new Date()
            });
            
            await user.save();
            return user;
        } catch (error) {
            console.error('خطأ في خصم رصيد:', error);
            throw error;
        }
    }
    
    /**
     * الحصول على رصيد المستخدم
     * @param {String} userId - معرف المستخدم
     * @returns {Promise<Number>} - رصيد المستخدم
     */
    static async getUserCredit(userId) {
        try {
            const user = await User.findById(userId);
            if (!user) {
                throw new Error('المستخدم غير موجود');
            }
            
            return user.credits || 0;
        } catch (error) {
            console.error('خطأ في الحصول على رصيد المستخدم:', error);
            throw error;
        }
    }
    
    /**
     * الحصول على سجل معاملات المستخدم
     * @param {String} userId - معرف المستخدم
     * @param {Number} limit - عدد المعاملات المراد استرجاعها
     * @returns {Promise<Array>} - سجل المعاملات
     */
    static async getUserTransactions(userId, limit = 10) {
        try {
            const user = await User.findById(userId);
            if (!user) {
                throw new Error('المستخدم غير موجود');
            }
            
            // إذا لم تكن هناك معاملات، قم بإرجاع مصفوفة فارغة
            if (!user.transactions) {
                return [];
            }
            
            // ترتيب المعاملات حسب التاريخ (الأحدث أولاً) وتحديد العدد
            return user.transactions
                .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
                .slice(0, limit);
        } catch (error) {
            console.error('خطأ في الحصول على سجل معاملات المستخدم:', error);
            throw error;
        }
    }
    
    /**
     * تحويل رصيد بين مستخدمين
     * @param {String} fromUserId - معرف المستخدم المرسل
     * @param {String} toUserId - معرف المستخدم المستلم
     * @param {Number} amount - المبلغ المراد تحويله
     * @param {String} reason - سبب التحويل
     * @returns {Promise<Object>} - نتيجة التحويل
     */
    static async transferCredit(fromUserId, toUserId, amount, reason = 'تحويل رصيد') {
        try {
            // التأكد من أن المبلغ موجب
            amount = Math.abs(amount);
            
            // التحقق من وجود المستخدمين
            const fromUser = await User.findById(fromUserId);
            const toUser = await User.findById(toUserId);
            
            if (!fromUser || !toUser) {
                throw new Error('أحد المستخدمين غير موجود');
            }
            
            // التحقق من كفاية الرصيد
            if ((fromUser.credits || 0) < amount) {
                throw new Error('الرصيد غير كافٍ');
            }
            
            // خصم الرصيد من المرسل
            await this.deductCredit(fromUserId, amount, `تحويل إلى ${toUser.username}: ${reason}`);
            
            // إضافة الرصيد للمستلم
            await this.addCredit(toUserId, amount, `تحويل من ${fromUser.username}: ${reason}`);
            
            return {
                success: true,
                fromUser,
                toUser,
                amount
            };
        } catch (error) {
            console.error('خطأ في تحويل الرصيد:', error);
            throw error;
        }
    }
    
    /**
     * شراء رصيد باستخدام كود خصم
     * @param {String} userId - معرف المستخدم
     * @param {String} code - كود الخصم
     * @returns {Promise<Object>} - نتيجة الشراء
     */
    static async redeemCode(userId, code) {
        try {
            const user = await User.findById(userId);
            if (!user) {
                throw new Error('المستخدم غير موجود');
            }
            
            // التحقق من وجود الكود
            const discountCodes = require('../config').payment.discountCodes;
            if (!discountCodes || !discountCodes[code]) {
                throw new Error('كود الخصم غير صالح');
            }
            
            const codeData = discountCodes[code];
            
            // التحقق من صلاحية الكود
            if (codeData.used >= (codeData.maxUses || Infinity)) {
                throw new Error('تم استخدام كود الخصم بالكامل');
            }
            
            if (codeData.expiryDate && new Date() > new Date(codeData.expiryDate)) {
                throw new Error('انتهت صلاحية كود الخصم');
            }
            
            // إضافة الرصيد
            await this.addCredit(userId, codeData.amount, `استخدام كود خصم: ${code}`);
            
            // تحديث عدد مرات استخدام الكود
            discountCodes[code].used = (discountCodes[code].used || 0) + 1;
            
            return {
                success: true,
                code,
                amount: codeData.amount
            };
        } catch (error) {
            console.error('خطأ في استخدام كود الخصم:', error);
            throw error;
        }
    }
}

module.exports = CreditService;
