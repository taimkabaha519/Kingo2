# مجلد التكوين (Config)

هذا المجلد يحتوي على ملفات التكوين الحساسة.

## ملفات Service Account

### خطوات الحصول على Service Account:

1. اذهب إلى [Firebase Console](https://console.firebase.google.com/)
2. اختر مشروعك (`hnstoreweb` أو مشروعك الخاص)
3. اذهب إلى **Project Settings** (⚙️) > **Service Accounts**
4. اضغط على **Generate new private key**
5. احفظ الملف الذي سيتم تنزيله باسم: `firebase-service-account.json`
6. ضع الملف في هذا المجلد: `config/firebase-service-account.json`

### ملاحظات أمنية:

- ⚠️ **لا ترفع ملف `firebase-service-account.json` إلى Git!**
- ✅ الملف موجود في `.gitignore` لحمايته
- ✅ استخدم `firebase-service-account.example.json` كقالب فقط
- ✅ في الإنتاج، استخدم متغيرات البيئة بدلاً من الملفات

### استخدام متغيرات البيئة (موصى به للإنتاج):

بدلاً من ملف JSON، يمكنك استخدام متغير البيئة:

```env
FIREBASE_SERVICE_ACCOUNT_PATH=./config/firebase-service-account.json
# أو
FIREBASE_SERVICE_ACCOUNT='{"type":"service_account",...}'
```

