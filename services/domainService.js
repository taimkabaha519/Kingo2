const { Domain, Hosting } = require('../models');
const dns = require('dns').promises;
const crypto = require('crypto');

/**
 * خدمة إدارة النطاقات
 */
class DomainService {
    /**
     * إضافة نطاق جديد
     * @param {String} name - اسم النطاق
     * @param {String} hostingId - معرف الهوست
     * @param {String} userId - معرف المستخدم
     * @returns {Promise<Object>} - النطاق الجديد
     */
    static async addDomain(name, hostingId, userId) {
        try {
            // تنظيف اسم النطاق
            name = name.toLowerCase().trim();
            
            // التحقق من وجود الهوست
            const hosting = await Hosting.findById(hostingId);
            if (!hosting) {
                throw new Error('الهوست غير موجود');
            }
            
            // التحقق من ملكية الهوست
            if (hosting.owner.toString() !== userId) {
                throw new Error('ليس لديك صلاحية لإضافة نطاق لهذا الهوست');
            }
            
            // التحقق من وجود النطاق
            const existingDomain = await Domain.findOne({ name });
            if (existingDomain) {
                throw new Error('النطاق مستخدم بالفعل');
            }
            
            // إنشاء رمز التحقق
            const verificationToken = crypto.randomBytes(32).toString('hex');
            
            // إنشاء النطاق
            const domain = new Domain({
                name,
                hosting: hostingId,
                owner: userId,
                status: 'pending',
                verificationToken,
                dnsRecords: [
                    {
                        type: 'A',
                        name: '@',
                        value: process.env.SERVER_IP || '127.0.0.1'
                    },
                    {
                        type: 'TXT',
                        name: '_sivano-verify',
                        value: `verify=${verificationToken}`
                    }
                ]
            });
            
            await domain.save();
            
            // إضافة النطاق إلى الهوست
            hosting.domains.push(domain._id);
            await hosting.save();
            
            return domain;
        } catch (error) {
            console.error('خطأ في إضافة نطاق:', error);
            throw error;
        }
    }
    
    /**
     * التحقق من نطاق
     * @param {String} id - معرف النطاق
     * @returns {Promise<Object>} - نتيجة التحقق
     */
    static async verifyDomain(id) {
        try {
            const domain = await Domain.findById(id);
            if (!domain) {
                throw new Error('النطاق غير موجود');
            }
            
            // التحقق من حالة النطاق
            if (domain.status === 'active') {
                return { success: true, message: 'النطاق مفعل بالفعل' };
            }
            
            // الحصول على سجلات TXT
            try {
                const txtRecords = await dns.resolveTxt(`_sivano-verify.${domain.name}`);
                const expectedValue = `verify=${domain.verificationToken}`;
                
                // التحقق من وجود السجل المطلوب
                const isVerified = txtRecords.some(record => record.join('') === expectedValue);
                
                if (isVerified) {
                    // تحديث حالة النطاق
                    domain.status = 'active';
                    domain.verifiedAt = new Date();
                    await domain.save();
                    
                    return { success: true, message: 'تم التحقق من النطاق بنجاح' };
                } else {
                    return { success: false, message: 'فشل التحقق من النطاق، سجل TXT غير صحيح' };
                }
            } catch (error) {
                return { success: false, message: 'فشل التحقق من النطاق، تأكد من إضافة سجل TXT بشكل صحيح' };
            }
        } catch (error) {
            console.error('خطأ في التحقق من النطاق:', error);
            throw error;
        }
    }
    
    /**
     * تفعيل SSL لنطاق
     * @param {String} id - معرف النطاق
     * @returns {Promise<Object>} - نتيجة التفعيل
     */
    static async enableSSL(id) {
        try {
            const domain = await Domain.findById(id);
            if (!domain) {
                throw new Error('النطاق غير موجود');
            }
            
            // التحقق من حالة النطاق
            if (domain.status !== 'active') {
                throw new Error('يجب التحقق من النطاق أولاً');
            }
            
            // تفعيل SSL
            domain.sslEnabled = true;
            await domain.save();
            
            // هنا يمكن إضافة رمز لتفعيل SSL باستخدام Let's Encrypt أو خدمة أخرى
            
            return { success: true, message: 'تم تفعيل SSL بنجاح' };
        } catch (error) {
            console.error('خطأ في تفعيل SSL:', error);
            throw error;
        }
    }
    
    /**
     * حذف نطاق
     * @param {String} id - معرف النطاق
     * @returns {Promise<Boolean>} - نجاح الحذف
     */
    static async deleteDomain(id) {
        try {
            const domain = await Domain.findById(id);
            if (!domain) {
                throw new Error('النطاق غير موجود');
            }
            
            // حذف النطاق من الهوست
            const hosting = await Hosting.findById(domain.hosting);
            if (hosting) {
                hosting.domains = hosting.domains.filter(d => d.toString() !== id);
                await hosting.save();
            }
            
            // حذف النطاق
            await Domain.deleteOne({ _id: id });
            
            return true;
        } catch (error) {
            console.error('خطأ في حذف النطاق:', error);
            throw error;
        }
    }
    
    /**
     * الحصول على نطاقات المستخدم
     * @param {String} userId - معرف المستخدم
     * @returns {Promise<Array>} - قائمة النطاقات
     */
    static async getUserDomains(userId) {
        try {
            return await Domain.find({ owner: userId }).populate('hosting');
        } catch (error) {
            console.error('خطأ في الحصول على نطاقات المستخدم:', error);
            throw error;
        }
    }
    
    /**
     * الحصول على نطاقات الهوست
     * @param {String} hostingId - معرف الهوست
     * @returns {Promise<Array>} - قائمة النطاقات
     */
    static async getHostingDomains(hostingId) {
        try {
            return await Domain.find({ hosting: hostingId });
        } catch (error) {
            console.error('خطأ في الحصول على نطاقات الهوست:', error);
            throw error;
        }
    }
    
    /**
     * تحديث سجلات DNS
     * @param {String} id - معرف النطاق
     * @param {Array} dnsRecords - سجلات DNS الجديدة
     * @returns {Promise<Object>} - النطاق بعد التحديث
     */
    static async updateDNSRecords(id, dnsRecords) {
        try {
            const domain = await Domain.findById(id);
            if (!domain) {
                throw new Error('النطاق غير موجود');
            }
            
            // تحديث سجلات DNS
            domain.dnsRecords = dnsRecords;
            domain.updatedAt = new Date();
            await domain.save();
            
            return domain;
        } catch (error) {
            console.error('خطأ في تحديث سجلات DNS:', error);
            throw error;
        }
    }
    
    /**
     * الحصول على URL العام للهوست
     * @param {String} hostingId - معرف الهوست
     * @returns {Promise<String>} - URL العام
     */
    static async getPublicUrl(hostingId) {
        try {
            // البحث عن نطاق نشط للهوست
            const domain = await Domain.findOne({
                hosting: hostingId,
                status: 'active'
            });
            
            if (domain) {
                // استخدام النطاق المخصص
                const protocol = domain.sslEnabled ? 'https' : 'http';
                return `${protocol}://${domain.name}`;
            } else {
                // استخدام URL الافتراضي
                const hosting = await Hosting.findById(hostingId);
                if (!hosting) {
                    throw new Error('الهوست غير موجود');
                }
                
                const serverAddress = process.env.SERVER_ADDRESS || 'localhost:3000';
                
                if (hosting.serviceType === 'web') {
                    // بالنسبة للمواقع، استخدم المسار المخصص
                    const owner = await User.findById(hosting.owner);
                    const username = owner ? owner.username : 'user';
                    return `http://${serverAddress}/${username}/${hosting.name}`;
                } else {
                    // بالنسبة للخدمات الأخرى، استخدم المنفذ
                    return `http://${serverAddress.split(':')[0]}:${hosting.port}`;
                }
            }
        } catch (error) {
            console.error('خطأ في الحصول على URL العام:', error);
            throw error;
        }
    }
}

module.exports = DomainService;
