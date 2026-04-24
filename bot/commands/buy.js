const { SlashCommandBuilder } = require('@discordjs/builders');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const { HostingService } = require('../../services');
const { User } = require('../../models');
const config = require('../../config');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('buy')
        .setDescription('شراء هوست جديد')
        .addStringOption(option =>
            option.setName('type')
                .setDescription('نوع الهوست')
                .setRequired(true)
                .addChoices(
                    { name: 'Discord Bot', value: 'discord' },
                    { name: 'Web Hosting', value: 'web' },
                    { name: 'MTA Server', value: 'mta' },
                    { name: 'FiveM Server', value: 'fivem' }
                )
        ),
    
    async execute(interaction) {
        try {
            // التحقق من وجود المستخدم في قاعدة البيانات
            let user = await User.findOne({ discordId: interaction.user.id });
            if (!user) {
                return await interaction.reply({
                    content: '❌ يجب عليك تسجيل الدخول إلى الموقع أولاً قبل شراء هوست.',
                    ephemeral: true
                });
            }
            
            // الحصول على نوع الهوست
            const serviceType = interaction.options.getString('type');
            
            // إنشاء قائمة الباقات
            const packages = config.prices[serviceType] || config.prices.default;
            
            // إنشاء قائمة الاختيار
            const row = new ActionRowBuilder()
                .addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId('select_package')
                        .setPlaceholder('اختر الباقة المناسبة')
                        .addOptions(
                            packages.map((pkg, index) => ({
                                label: `${pkg.name} (${pkg.price} $)`,
                                description: `${pkg.ram}MB RAM, ${pkg.cpu} CPU, ${pkg.storage}GB Storage`,
                                value: `${serviceType}_${index}`
                            }))
                        )
                );
            
            // إنشاء الرسالة
            const embed = new EmbedBuilder()
                .setColor('#3498db')
                .setTitle(`🛒 شراء هوست ${getServiceTypeName(serviceType)}`)
                .setDescription('اختر الباقة المناسبة لك من القائمة أدناه:')
                .addFields(
                    packages.map(pkg => ({
                        name: `📦 ${pkg.name} - ${pkg.price} $`,
                        value: `RAM: ${pkg.ram}MB | CPU: ${pkg.cpu} | Storage: ${pkg.storage}GB | المدة: ${pkg.duration} يوم`
                    }))
                )
                .setFooter({ text: 'HnStore - أفضل استضافة للبوتات والمواقع' });
            
            // إرسال الرسالة
            await interaction.reply({
                embeds: [embed],
                components: [row],
                ephemeral: true
            });
        } catch (error) {
            console.error('Error in buy command:', error);
            await interaction.reply({
                content: '❌ حدث خطأ أثناء تنفيذ الأمر. الرجاء المحاولة مرة أخرى لاحقًا.',
                ephemeral: true
            });
        }
    },
    
    // معالج التفاعل مع القائمة
    async handleSelectPackage(interaction) {
        try {
            // الحصول على المعلومات المحددة
            const [serviceType, packageIndex] = interaction.values[0].split('_');
            const packages = config.prices[serviceType] || config.prices.default;
            const selectedPackage = packages[parseInt(packageIndex)];
            
            if (!selectedPackage) {
                return await interaction.update({
                    content: '❌ حدث خطأ في اختيار الباقة. الرجاء المحاولة مرة أخرى.',
                    embeds: [],
                    components: []
                });
            }
            
            // إنشاء أزرار الدفع
            const paymentRow = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`pay_credits_${serviceType}_${packageIndex}`)
                        .setLabel('الدفع بالرصيد')
                        .setStyle(ButtonStyle.Primary)
                        .setEmoji('💰'),
                    new ButtonBuilder()
                        .setCustomId(`pay_paypal_${serviceType}_${packageIndex}`)
                        .setLabel('الدفع بـ PayPal')
                        .setStyle(ButtonStyle.Success)
                        .setEmoji('💳'),
                    new ButtonBuilder()
                        .setCustomId('cancel_purchase')
                        .setLabel('إلغاء')
                        .setStyle(ButtonStyle.Danger)
                        .setEmoji('❌')
                );
            
            // إنشاء الرسالة
            const embed = new EmbedBuilder()
                .setColor('#2ecc71')
                .setTitle(`🛒 تأكيد شراء هوست ${getServiceTypeName(serviceType)}`)
                .setDescription(`أنت على وشك شراء الباقة **${selectedPackage.name}**. الرجاء اختيار طريقة الدفع:`)
                .addFields(
                    { name: '📦 الباقة', value: selectedPackage.name, inline: true },
                    { name: '💰 السعر', value: `${selectedPackage.price} $`, inline: true },
                    { name: '⏱️ المدة', value: `${selectedPackage.duration} يوم`, inline: true },
                    { name: '🖥️ المواصفات', value: `RAM: ${selectedPackage.ram}MB | CPU: ${selectedPackage.cpu} | Storage: ${selectedPackage.storage}GB` }
                )
                .setFooter({ text: 'HnStore - أفضل استضافة للبوتات والمواقع' });
            
            // تحديث الرسالة
            await interaction.update({
                embeds: [embed],
                components: [paymentRow]
            });
        } catch (error) {
            console.error('Error in handleSelectPackage:', error);
            await interaction.update({
                content: '❌ حدث خطأ أثناء معالجة اختيارك. الرجاء المحاولة مرة أخرى لاحقًا.',
                embeds: [],
                components: []
            });
        }
    },
    
    // معالج الدفع بالرصيد
    async handlePayWithCredits(interaction) {
        try {
            // الحصول على المعلومات المحددة
            const [serviceType, packageIndex] = interaction.customId.split('_').slice(2);
            const packages = config.prices[serviceType] || config.prices.default;
            const selectedPackage = packages[parseInt(packageIndex)];
            
            if (!selectedPackage) {
                return await interaction.update({
                    content: '❌ حدث خطأ في اختيار الباقة. الرجاء المحاولة مرة أخرى.',
                    embeds: [],
                    components: []
                });
            }
            
            // التحقق من رصيد المستخدم
            const user = await User.findOne({ discordId: interaction.user.id });
            if (!user) {
                return await interaction.update({
                    content: '❌ يجب عليك تسجيل الدخول إلى الموقع أولاً قبل شراء هوست.',
                    embeds: [],
                    components: []
                });
            }
            
            if (user.credits < selectedPackage.price) {
                return await interaction.update({
                    content: `❌ رصيدك غير كافٍ. رصيدك الحالي: ${user.credits}$، المطلوب: ${selectedPackage.price}$`,
                    embeds: [],
                    components: []
                });
            }
            
            // خصم المبلغ من رصيد المستخدم
            user.credits -= selectedPackage.price;
            await user.save();
            
            // إنشاء مودال لإدخال اسم الهوست
            await interaction.showModal({
                title: 'إنشاء هوست جديد',
                custom_id: `create_hosting_modal_${serviceType}_${packageIndex}`,
                components: [
                    {
                        type: 1, // Action Row
                        components: [
                            {
                                type: 4, // Text Input
                                custom_id: 'hosting_name',
                                label: 'اسم الهوست',
                                style: 1, // Short
                                min_length: 3,
                                max_length: 32,
                                placeholder: 'أدخل اسمًا للهوست الخاص بك',
                                required: true
                            }
                        ]
                    }
                ]
            });
        } catch (error) {
            console.error('Error in handlePayWithCredits:', error);
            await interaction.update({
                content: '❌ حدث خطأ أثناء معالجة الدفع. الرجاء المحاولة مرة أخرى لاحقًا.',
                embeds: [],
                components: []
            });
        }
    },
    
    // معالج إنشاء الهوست
    async handleCreateHostingModal(interaction) {
        try {
            // الحصول على المعلومات المحددة
            const [serviceType, packageIndex] = interaction.customId.split('_').slice(3);
            const packages = config.prices[serviceType] || config.prices.default;
            const selectedPackage = packages[parseInt(packageIndex)];
            
            if (!selectedPackage) {
                return await interaction.reply({
                    content: '❌ حدث خطأ في اختيار الباقة. الرجاء المحاولة مرة أخرى.',
                    ephemeral: true
                });
            }
            
            // الحصول على اسم الهوست
            const hostingName = interaction.fields.getTextInputValue('hosting_name');
            
            // التحقق من وجود المستخدم
            const user = await User.findOne({ discordId: interaction.user.id });
            if (!user) {
                return await interaction.reply({
                    content: '❌ يجب عليك تسجيل الدخول إلى الموقع أولاً قبل شراء هوست.',
                    ephemeral: true
                });
            }
            
            // حساب تاريخ انتهاء الصلاحية
            const expiryDate = new Date();
            expiryDate.setDate(expiryDate.getDate() + selectedPackage.duration);
            
            // إنشاء الهوست
            const hosting = await HostingService.createHosting({
                name: hostingName,
                owner: user._id,
                serviceType,
                mainFile: 'index.js',
                expiryDate,
                specs: {
                    cpu: selectedPackage.cpu,
                    ram: selectedPackage.ram,
                    storage: selectedPackage.storage
                }
            });
            
            // إنشاء الرسالة
            const embed = new EmbedBuilder()
                .setColor('#2ecc71')
                .setTitle('✅ تم إنشاء الهوست بنجاح')
                .setDescription(`تم إنشاء هوست **${hostingName}** بنجاح! يمكنك الآن الوصول إليه من خلال موقعنا.`)
                .addFields(
                    { name: '📦 الباقة', value: selectedPackage.name, inline: true },
                    { name: '💰 السعر', value: `${selectedPackage.price} $`, inline: true },
                    { name: '⏱️ المدة', value: `${selectedPackage.duration} يوم`, inline: true },
                    { name: '🖥️ المواصفات', value: `RAM: ${selectedPackage.ram}MB | CPU: ${selectedPackage.cpu} | Storage: ${selectedPackage.storage}GB` },
                    { name: '🔗 رابط الموقع', value: `[اضغط هنا للوصول إلى لوحة التحكم](${process.env.WEBSITE_URL || 'https://sivano-host.com'}/dashboard)` }
                )
                .setFooter({ text: 'HnStore - أفضل استضافة للبوتات والمواقع' });
            
            // إرسال الرسالة
            await interaction.reply({
                embeds: [embed],
                ephemeral: true
            });
            
            // إرسال رسالة للإدارة
            if (config.adminRoomId) {
                try {
                    const adminChannel = await interaction.client.channels.fetch(config.adminRoomId);
                    if (adminChannel) {
                        const adminEmbed = new EmbedBuilder()
                            .setColor('#3498db')
                            .setTitle('🆕 تم إنشاء هوست جديد')
                            .setDescription(`تم إنشاء هوست جديد بواسطة <@${interaction.user.id}>`)
                            .addFields(
                                { name: '👤 المستخدم', value: interaction.user.tag, inline: true },
                                { name: '🏷️ اسم الهوست', value: hostingName, inline: true },
                                { name: '🖥️ النوع', value: getServiceTypeName(serviceType), inline: true },
                                { name: '📦 الباقة', value: selectedPackage.name, inline: true },
                                { name: '💰 السعر', value: `${selectedPackage.price} $`, inline: true },
                                { name: '⏱️ المدة', value: `${selectedPackage.duration} يوم`, inline: true }
                            )
                            .setTimestamp();
                        
                        await adminChannel.send({ embeds: [adminEmbed] });
                    }
                } catch (error) {
                    console.error('Error sending admin notification:', error);
                }
            }
        } catch (error) {
            console.error('Error in handleCreateHostingModal:', error);
            await interaction.reply({
                content: '❌ حدث خطأ أثناء إنشاء الهوست. الرجاء المحاولة مرة أخرى لاحقًا.',
                ephemeral: true
            });
        }
    },
    
    // معالج إلغاء الشراء
    async handleCancelPurchase(interaction) {
        await interaction.update({
            content: '✅ تم إلغاء عملية الشراء.',
            embeds: [],
            components: []
        });
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
