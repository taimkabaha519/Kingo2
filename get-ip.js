const { networkInterfaces } = require('os');
const http = require('http');
const https = require('https');

// Function to get local IP address
function getLocalIpAddress() {
    const nets = networkInterfaces();
    const results = {};

    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            // Skip over non-IPv4 and internal (i.e. 127.0.0.1) addresses
            if (net.family === 'IPv4' && !net.internal) {
                if (!results[name]) {
                    results[name] = [];
                }
                results[name].push(net.address);
            }
        }
    }
    
    // Try to find a non-local IP
    for (const name of Object.keys(results)) {
        for (const ip of results[name]) {
            if (!ip.startsWith('192.168.') && !ip.startsWith('10.') && !ip.startsWith('172.')) {
                return ip;
            }
        }
    }
    
    // If no non-local IP found, return the first one
    for (const name of Object.keys(results)) {
        if (results[name].length > 0) {
            return results[name][0];
        }
    }
    
    return '127.0.0.1';
}

// Function to get public IP address
function getPublicIpAddress() {
    return new Promise((resolve, reject) => {
        // Try multiple services in case one fails
        const services = [
            'https://api.ipify.org',
            'https://api.my-ip.io/ip',
            'https://checkip.amazonaws.com/',
            'https://api.ip.sb/ip',
            'https://ifconfig.me/ip',
            'https://icanhazip.com/',
            'https://wtfismyip.com/text',
            'https://ip.42.pl/raw'
        ];
        
        console.log('🔍 جاري البحث عن عنوان IP العام...');
        
        function tryNextService(index) {
            if (index >= services.length) {
                console.log('⚠️ فشلت جميع محاولات الحصول على عنوان IP العام. سيتم استخدام عنوان IP المحلي.');
                // If all services fail, use local IP
                resolve(getLocalIpAddress());
                return;
            }
            
            const service = services[index];
            const client = service.startsWith('https') ? https : http;
            
            console.log(`🌐 محاولة الحصول على عنوان IP العام من ${service}`);
            
            const req = client.get(service, {
                timeout: 5000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36'
                }
            }, (res) => {
                if (res.statusCode !== 200) {
                    console.log(`❌ فشلت الخدمة ${service} بكود الحالة ${res.statusCode}`);
                    tryNextService(index + 1);
                    return;
                }
                
                let data = '';
                res.on('data', (chunk) => {
                    data += chunk;
                });
                
                res.on('end', () => {
                    // Clean up the response (remove any whitespace)
                    const ip = data.trim();
                    if (ip && /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/.test(ip)) {
                        console.log(`✅ تم الحصول على عنوان IP العام: ${ip}`);
                        resolve(ip);
                    } else {
                        console.log(`❌ استجابة غير صالحة من ${service}: ${ip}`);
                        tryNextService(index + 1);
                    }
                });
            });
            
            req.on('error', (error) => {
                console.log(`❌ خطأ في الاتصال بـ ${service}: ${error.message}`);
                tryNextService(index + 1);
            });
            
            req.on('timeout', () => {
                console.log(`⏱️ انتهت مهلة الاتصال بـ ${service}`);
                req.destroy();
                tryNextService(index + 1);
            });
            
            req.end();
        }
        
        tryNextService(0);
    });
}

// Export both functions
module.exports = {
    getLocalIpAddress,
    getPublicIpAddress
};
