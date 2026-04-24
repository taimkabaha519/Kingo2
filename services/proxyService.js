const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const Hosting = require('../models/hosting');

class ProxyService {
    constructor() {
        this.proxiesFile = path.join(__dirname, '../proxies.txt');
        this.protocol = 'http';
        this.timeout = 10000;
        this.country = 'all';
        this.ssl = 'all';
        this.anonymity = 'all';
    }

    /**
     * توليد قائمة الـ proxies عبر API كما طلب المستخدم
     */
    async generateProxies() {
        const apiUrl = `https://api.proxyscrape.com/v2/?request=getproxies&protocol=${this.protocol}&timeout=${this.timeout}&country=${this.country}&ssl=${this.ssl}&anonymity=${this.anonymity}`;

        try {
            console.log('🔄 جاري توليد قائمة البروكسيات من API...');
            const response = await axios.get(apiUrl, {
                responseType: 'text',
            });

            const proxies = response.data.split('\n')
                .map(line => line.trim())
                .filter(line => line !== '');

            if (proxies.length === 0) {
                console.log('⚠️ لم يتم العثور على proxies. جرب تغيير الإعدادات.');
                return [];
            }

            console.log(`✅ تم توليد ${proxies.length} proxy.`);

            // إضافة بروتوكول للبروكسيات إذا لم يكن موجوداً
            const formattedProxies = proxies.map(p => p.includes('://') ? p : `${this.protocol}://${p}`);

            // حفظ في ملف txt
            await fs.writeFile(this.proxiesFile, formattedProxies.join('\n'));
            console.log('📂 تم حفظ القائمة في ملف proxies.txt');

            return formattedProxies;
        } catch (error) {
            console.error(`❌ خطأ في توليد البروكسيات: ${error.message}`);
            return [];
        }
    }

    /**
     * توزيع البروكسيات على جميع الاستضافات التي لا تملك بروكسي
     */
    async distributeProxies() {
        try {
            let proxies = [];
            if (await fs.pathExists(this.proxiesFile)) {
                const content = await fs.readFile(this.proxiesFile, 'utf8');
                proxies = content.split('\n').filter(p => p.trim() !== '');
            }

            if (proxies.length === 0) {
                proxies = await this.generateProxies();
            }

            if (proxies.length === 0) return;

            const hostings = await Hosting.find({ proxyAddress: null });
            console.log(`分配 البروكسيات لـ ${hostings.length} استضافة...`);

            for (let i = 0; i < hostings.length; i++) {
                // نأخذ بروكسي عشوائي أو بالترتيب
                const proxy = proxies[i % proxies.length];
                hostings[i].proxyAddress = proxy;
                await hostings[i].save();
            }

            console.log('✅ تم توزيع البروكسيات بنجاح.');
        } catch (error) {
            console.error('❌ خطأ في توزيع البروكسيات:', error);
        }
    }

    /**
     * الحصول على بروكسي لاستضافة محددة
     */
    async getProxyForHosting(hostingId) {
        const hosting = await Hosting.findById(hostingId);
        if (hosting && hosting.proxyAddress) {
            return hosting.proxyAddress;
        }

        // إذا لم يكن لديه بروكسي، نولد ونوزع
        await this.distributeProxies();
        const updated = await Hosting.findById(hostingId);
        return updated ? updated.proxyAddress : null;
    }
}

module.exports = new ProxyService();
