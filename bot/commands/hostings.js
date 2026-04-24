const { SlashCommandBuilder } = require('@discordjs/builders');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { User, Hosting } = require('../../models');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('hostings')
        .setDescription('عرض قائمة الهوستات الخاصة بك'),
    
    async execute(interaction) {
        try {
            // التحقق من وجود المستخدم في قاعدة البيانات
            const user = await User.findOne({ discordId: interaction.user.id });
            if (!user) {
                return await interaction.reply({
                    content: '❌ يجب عليك تسجيل الدخول إلى الموقع أولاً لعرض الهوستات الخاصة بك.',
                    ephemeral: true
                });
            }
            
            // الحصول على هوستات المستخدم
            const hostings = await Hosting.find({ owner: user._id });
            
            if (hostings.length === 0) {
                return await interaction.reply({
                    content: '❌ ليس لديك أي هوستات حاليًا. يمكنك شراء هوست جديد باستخدام الأمر `/buy`.',
                    ephemeral: true
                });
            }
            
            // إنشاء الرسالة
            const embed = new EmbedBuilder()
                .setColor('#3498db')
                .setTitle('🖥️ الهوستات الخاصة بك')
                .setDescription(`لديك ${hostings.length} هوست. يمكنك إدارة الهوستات الخاصة بك من خلال موقعنا.`)
                .addFields(
                    hostings.map(hosting => ({
                        name: `📦 ${hosting.name} (${getServiceTypeName(hosting.serviceType)})`,
                        value: `🔄 الحالة: ${getStatusEmoji(hosting.status)} ${getStatusName(hosting.status)}\n⏱️ ينتهي في: ${new Date(hosting.expiryDate).toLocaleDateString()}\n🖥️ المواصفات: RAM: ${hosting.specs.ram}MB | CPU: ${hosting.specs.cpu} | Storage: ${hosting.specs.storage}GB`
                    }))
                )
                .setFooter({ text: 'HnStore - أفضل استضافة للبوتات والمواقع' });
            
            // إنشاء زر للوصول إلى لوحة التحكم
            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setLabel('الوصول إلى لوحة التحكم')
                        .setStyle(ButtonStyle.Link)
                        .setURL(process.env.WEBSITE_URL || 'https://sivano-host.com/dashboard')
                        .setEmoji('🔗')
                );
            
            // إرسال الرسالة
            await interaction.reply({
                embeds: [embed],
                components: [row],
                ephemeral: true
            });
        } catch (error) {
            console.error('Error in hostings command:', error);
            await interaction.reply({
                content: '❌ حدث خطأ أثناء تنفيذ الأمر. الرجاء المحاولة مرة أخرى لاحقًا.',
                ephemeral: true
            });
        }
    }
};

// دالة مساعدة للحصول على اسم نوع الخدمة
function getServiceTypeName(serviceType) {
    switch (serviceType) {
        case 'discord': return 'بوت ديسكورد';
        case 'web': return 'استضافة ويب';
        case 'mta': return 'سيرفر MTA';
        case 'fivem': return 'سيرفر FiveM';
        default: return 'هوست';
    }
}

// دالة مساعدة للحصول على اسم الحالة
function getStatusName(status) {
    switch (status) {
        case 'running': return 'يعمل';
        case 'stopped': return 'متوقف';
        case 'restarting': return 'إعادة تشغيل';
        case 'error': return 'خطأ';
        default: return 'غير معروف';
    }
}

// دالة مساعدة للحصول على رمز الحالة
function getStatusEmoji(status) {
    switch (status) {
        case 'running': return '🟢';
        case 'stopped': return '🔴';
        case 'restarting': return '🔄';
        case 'error': return '⚠️';
        default: return '❓';
    }
}
