// تصدير جميع الخدمات
module.exports = {
    FileService: require('./fileService'),
    HostingService: require('./hostingService'),
    SharedPackageService: require('./sharedPackageService'),
    DomainService: require('./domainService'),
    CreditService: require('./creditService'),
    ProxyService: require('./proxyService')
};
