const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');

class WebProxyService {
    /**
     * تنفيذ طلب البروكسي
     * @param {Object} req - طلب Express
     * @param {Object} res - استجابة Express
     * @param {String} targetUrl - الرابط المطلوب
     * @param {String} hostId - معرف الهوست (لاستخدام كوكيز منفصلة لكل هوست)
     */
    static async handleProxy(req, res, targetUrl, hostId) {
        if (!targetUrl) {
            return res.status(400).send('URL is required');
        }

        // تنظيف الرابط
        if (!targetUrl.startsWith('http')) {
            targetUrl = 'http://' + targetUrl;
        }

        try {
            const parsedUrl = new URL(targetUrl);
            const baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}`;

            // إعداد الترويسات (Headers)
            const headers = { ...req.headers };
            delete headers.host;
            delete headers.referer;
            headers['user-agent'] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

            // دعم الكوكيز حسب الهوست
            const cookieKey = `proxy_cookies_${hostId}`;
            if (req.cookies && req.cookies[cookieKey]) {
                headers.cookie = req.cookies[cookieKey];
            }

            // تنفيذ الطلب باستخدام Axios
            const response = await axios({
                method: req.method,
                url: targetUrl,
                data: req.method === 'POST' ? req.body : undefined,
                headers: headers,
                responseType: 'arraybuffer', // مهم لدعم الصور والملفات
                validateStatus: null, // لا ترمي خطأ لأكواد الحالة غير الـ 200
                maxRedirects: 10
            });

            // معالجة الكوكيز من الرد
            const setCookie = response.headers['set-cookie'];
            if (setCookie) {
                res.cookie(cookieKey, setCookie.join('; '), { maxAge: 7 * 24 * 60 * 60 * 1000, path: '/' });
            }

            // نقل ترويسات الاستجابة
            const responseHeaders = { ...response.headers };
            delete responseHeaders['content-encoding'];
            delete responseHeaders['transfer-encoding'];
            delete responseHeaders['content-security-policy'];
            delete responseHeaders['x-frame-options'];

            Object.entries(responseHeaders).forEach(([key, value]) => {
                res.setHeader(key, value);
            });

            let body = response.data;
            const contentType = response.headers['content-type'] || '';

            // إذا كان المحتوى HTML، نقوم بتعديل الروابط
            if (contentType.includes('text/html')) {
                let html = body.toString('utf8');
                const $ = cheerio.load(html);

                // تعديل الروابط (href, src, action)
                const proxyPath = `/api/hosting/${hostId}/proxy-view?url=`;

                $('a[href], link[href]').each((i, el) => {
                    const href = $(el).attr('href');
                    if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
                        $(el).attr('href', proxyPath + encodeURIComponent(this.resolveUrl(baseUrl, href)));
                    }
                });

                $('img[src], script[src], iframe[src]').each((i, el) => {
                    const src = $(el).attr('src');
                    if (src) {
                        $(el).attr('src', proxyPath + encodeURIComponent(this.resolveUrl(baseUrl, src)));
                    }
                });

                $('form[action]').each((i, el) => {
                    const action = $(el).attr('action');
                    if (action) {
                        $(el).attr('action', proxyPath + encodeURIComponent(this.resolveUrl(baseUrl, action)));
                    }
                });

                body = $.html();
            }

            res.status(response.status).send(body);

        } catch (error) {
            console.error('Proxy Error:', error.message);
            res.status(500).send(`Proxy Error: ${error.message}`);
        }
    }

    static resolveUrl(base, relative) {
        try {
            return new URL(relative, base).href;
        } catch (e) {
            return relative;
        }
    }
}

module.exports = WebProxyService;
