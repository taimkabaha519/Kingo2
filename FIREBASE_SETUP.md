# إعداد Firebase Storage

تم تحديث النظام لحفظ ملفات الاستضافات في Firebase Storage بدلاً من MongoDB GridFS.

## المتطلبات

1. حساب Firebase مع مشروع نشط
2. Service Account Key من Firebase
3. Storage Bucket name

## خطوات الإعداد

### 1. إنشاء Service Account

1. اذهب إلى [Firebase Console](https://console.firebase.google.com/)
2. اختر مشروعك (أو أنشئ مشروع جديد)
3. اذهب إلى Project Settings > Service Accounts
4. اضغط على "Generate new private key"
5. احفظ ملف JSON الذي سيتم تنزيله

### 2. تكوين Storage Bucket

1. في Firebase Console، اذهب إلى Storage
2. أنشئ bucket جديد إذا لم يكن موجوداً
3. انسخ اسم الـ bucket (مثلاً: `my-project.appspot.com`)

### 3. تكوين النظام

#### الطريقة الأولى: استخدام متغير البيئة (موصى به)

1. ضع ملف Service Account JSON في مجلد آمن (مثلاً: `config/firebase-service-account.json`)
2. أضف إلى ملف `.env`:

```env
FIREBASE_STORAGE_BUCKET=your-bucket-name.appspot.com
FIREBASE_SERVICE_ACCOUNT_PATH=./config/firebase-service-account.json
```

#### الطريقة الثانية: استخدام config.js

افتح `config.js` وعدّل قسم Firebase:

```javascript
firebase: {
    storageBucket: 'your-bucket-name.appspot.com',
    serviceAccountPath: './config/firebase-service-account.json'
}
```

**ملاحظة:** لا تضع محتوى Service Account مباشرة في الكود لأسباب أمنية.

### 4. التحقق من الإعداد

عند تشغيل السيرفر، يجب أن ترى رسالة:
```
✅ تم تهيئة Firebase Storage بنجاح
```

إذا رأيت تحذير، تحقق من:
- صحة مسار ملف Service Account
- صحة اسم Storage Bucket
- صلاحيات Service Account (يجب أن يكون لديه صلاحيات Storage Admin)

## الميزات

- ✅ حفظ جميع ملفات الاستضافات في Firebase Storage
- ✅ دعم رفع وتنزيل الملفات
- ✅ دعم Stream للتعامل مع الملفات الكبيرة
- ✅ حذف الملفات من Firebase عند الحذف
- ✅ استخراج الملفات إلى مجلد محلي للتشغيل

## هيكل الملفات في Firebase Storage

الملفات تُحفظ بالشكل التالي:
```
hostings/{hostingId}/{filePath}
```

مثال:
```
hostings/67890abcdef12345/index.js
hostings/67890abcdef12345/package.json
hostings/67890abcdef12345/server.jar
```

