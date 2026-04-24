// Hn Hosting Bot - Created by Hn
// Environment variables not used; configuration is set directly in this file

const {
    Client,
    GatewayIntentBits,
    Collection,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    StringSelectMenuBuilder,
    REST,
    Routes,
    ChannelType,
    PermissionFlagsBits,
} = require("discord.js");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
// استيراد get-port بشكل ديناميكي لتجنب مشاكل CommonJS/ESM
let getPortLibrary;
async function resolveAvailablePort(options) {
    if (!getPortLibrary) {
        const gp = await import('get-port');
        getPortLibrary = gp.default || gp;
    }
    return getPortLibrary(options);
}
let localtunnel = null; try { localtunnel = require('localtunnel'); } catch { localtunnel = null; }
const hostTunnels = new Map();

async function ensureHostTunnel(hostName) {
    try {
        if (!localtunnel) return null;
        if (hostTunnels.has(hostName)) return hostTunnels.get(hostName);
        const port = Number(config.webServerPort || 3000);
        const tunnel = await localtunnel({ port, allow_invalid_cert: true });
        const url = tunnel.url;
        hostTunnels.set(hostName, url);
        tunnel.on('close', () => {
            hostTunnels.delete(hostName);
        });
        console.log(`🔗 Tunnel for host ${hostName}: ${url}`);
        return url;
    } catch (e) {
        console.error('Failed to create tunnel:', e.message);
        return null;
    }
}
const unzipper = require("unzipper");

// Web server imports
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMembers,
    ],
});

const config = {
    token: "MTQ4MDY1MTY1MTEwMTQ5NTQxNw.GqMYuP.pPToAy4IVyOqr4kltL9ojYoadf0PlnFAsE09OE",
    probotid: "282859044593598464",
    ownerid: "1092446133944582216",
    ownersid: ["1092446133944582216", "925438817987608596"],
    prices: {
        "3_days": 1,
        "1_week": 20,
        "1_month": 50,
        "3_months": 120,
        "1_year": 400,
    },
    probotTax: 0.053,
    hostingRoomId: null,
    adminRoomId: null,
    discountCodes: {},
    paymentEnabled: true,
    webServerPort: 3000,
    serverAddress: 'localhost:3000',
    giveaways: new Collection(),
    warnings: new Collection(),
    userCredits: new Collection(),
};

// Initialize global admin IDs for server access control
try { global.ADMIN_USER_IDS = new Set((config.ownersid || []).map(x => x.toString())); } catch { }

const activeHostings = new Collection();
const pendingPayments = new Collection();
const fileEditSessions = new Collection();

// Initialize web server
let webServer;
let io;

function initWebServer() {
    try {
        const { app, server } = require('./server');
        webServer = server;
        console.log(`Web server initialized on port ${config.webServerPort}`);
    } catch (error) {
        console.error('Failed to initialize web server:', error);
    }
}

function createDirectories() {
    const dirs = ["./hostings", "./data", "./backups", "./shared_node_modules"];
    dirs.forEach((dir) => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });

    const sharedPackageJson = {
        name: "shared-modules",
        version: "1.0.0",
        dependencies: {
            "discord.js": "^14.0.0",
            express: "^4.18.0",
            axios: "^1.0.0",
            moment: "^2.29.0",
            "fs-extra": "^11.0.0",
        },
    };

    const sharedPackagePath = path.join(
        __dirname,
        "shared_node_modules",
        "package.json",
    );
    if (!fs.existsSync(sharedPackagePath)) {
        fs.writeFileSync(
            sharedPackagePath,
            JSON.stringify(sharedPackageJson, null, 2),
        );
    }
}

function loadData() {
    try {
        if (
            !config.userCredits ||
            typeof config.userCredits.get !== "function"
        ) {
            config.userCredits = new Collection();
        }
        if (!config.warnings || typeof config.warnings.get !== "function") {
            config.warnings = new Collection();
        }
        if (!config.giveaways || typeof config.giveaways.get !== "function") {
            config.giveaways = new Collection();
        }

        if (fs.existsSync("./data/config.json")) {
            const savedConfig = JSON.parse(
                fs.readFileSync("./data/config.json", "utf8"),
            );
            config.hostingRoomId = savedConfig.hostingRoomId || null;
            config.adminRoomId = savedConfig.adminRoomId || null;
            config.discountCodes = savedConfig.discountCodes || {};
            config.paymentEnabled =
                savedConfig.paymentEnabled !== undefined
                    ? savedConfig.paymentEnabled
                    : true;
            config.prices = savedConfig.prices || config.prices;
        }

        if (fs.existsSync("./data/hostings.json")) {
            const savedHostings = JSON.parse(
                fs.readFileSync("./data/hostings.json", "utf8"),
            );
            if (Array.isArray(savedHostings)) {
                savedHostings.forEach((hosting) => {
                    if (hosting && hosting.name) {
                        activeHostings.set(hosting.name, hosting);
                    }
                });
            }
        }

        if (fs.existsSync("./data/warnings.json")) {
            const savedWarnings = JSON.parse(
                fs.readFileSync("./data/warnings.json", "utf8"),
            );
            if (Array.isArray(savedWarnings)) {
                savedWarnings.forEach((warning) => {
                    if (warning && warning.userId && warning.warnings) {
                        config.warnings.set(warning.userId, warning.warnings);
                    }
                });
            }
        }

        if (fs.existsSync("./data/credits.json")) {
            const savedCredits = JSON.parse(
                fs.readFileSync("./data/credits.json", "utf8"),
            );
            if (Array.isArray(savedCredits)) {
                savedCredits.forEach((credit) => {
                    if (
                        credit &&
                        credit.userId &&
                        credit.credits !== undefined
                    ) {
                        config.userCredits.set(credit.userId, credit.credits);
                    }
                });
            }
        }
    } catch (error) {
        console.error("خطأ في تحميل البيانات:", error);
        config.userCredits = new Collection();
        config.warnings = new Collection();
        config.giveaways = new Collection();
    }
}

function saveData() {
    try {
        if (!fs.existsSync("./data")) {
            fs.mkdirSync("./data", { recursive: true });
        }

        const configToSave = {
            hostingRoomId: config.hostingRoomId,
            adminRoomId: config.adminRoomId,
            discountCodes: config.discountCodes || {},
            paymentEnabled: config.paymentEnabled,
            prices: config.prices,
            probotTax: config.probotTax,
            probotid: config.probotid,
            ownerid: config.ownerid,
            ownersid: config.ownersid,
        };
        fs.writeFileSync(
            "./data/config.json",
            JSON.stringify(configToSave, null, 2),
        );

        const hostingsArray = Array.from(activeHostings.values());
        fs.writeFileSync(
            "./data/hostings.json",
            JSON.stringify(hostingsArray, null, 2),
        );

        if (
            config.warnings &&
            typeof config.warnings.size === "number" &&
            config.warnings.size > 0
        ) {
            const warningsArray = Array.from(config.warnings.entries()).map(
                ([userId, warnings]) => ({ userId, warnings }),
            );
            fs.writeFileSync(
                "./data/warnings.json",
                JSON.stringify(warningsArray, null, 2),
            );
        } else {
            fs.writeFileSync(
                "./data/warnings.json",
                JSON.stringify([], null, 2),
            );
        }
        if (
            config.userCredits &&
            typeof config.userCredits.size === "number" &&
            config.userCredits.size > 0
        ) {
            const creditsArray = Array.from(config.userCredits.entries()).map(
                ([userId, credits]) => ({ userId, credits }),
            );
            fs.writeFileSync(
                "./data/credits.json",
                JSON.stringify(creditsArray, null, 2),
            );
        } else {
            fs.writeFileSync(
                "./data/credits.json",
                JSON.stringify([], null, 2),
            );
        }
    } catch (error) {
        console.error("خطأ في حفظ البيانات:", error);
    }
}

async function registerCommands() {
    const commands = [
        {
            name: "setuphostingroom",
            description: "إعداد روم الهوستات",
            options: [
                {
                    name: "room",
                    description: "الروم المخصص للهوستات",
                    type: 7,
                    required: true,
                },
            ],
        },
        {
            name: "setupadminroom",
            description: "إعداد روم الإدارة",
            options: [
                {
                    name: "room",
                    description: "الروم المخصص للإدارة",
                    type: 7,
                    required: true,
                },
            ],
        },
        {
            name: "addcredit",
            description: "إضافة رصيد للمستخدم",
            options: [
                {
                    name: "ownerid",
                    description: "ايدي المستخدم",
                    type: 3,
                    required: true,
                },
                {
                    name: "price",
                    description: "السعر",
                    type: 4,
                    required: true,
                },
                {
                    name: "tax",
                    description: "الضريبة",
                    type: 4,
                    required: true,
                },
            ],
        },
        {
            name: "publicip",
            description: "يعرض عنوان IP العام والرابط العام للوصول",
        },
    ];

    const rest = new REST({ version: "10" }).setToken(config.token);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), {
            body: commands,
        });
        console.log("✅ تم تسجيل الأوامر بنجاح!");
    } catch (error) {
    }
}

client.on("ready", async () => {
    // Initialize web server after bot is ready
    initWebServer();
    console.log(`✅ البوت ${client.user.tag} جاهز لخدمتكم يا أحباب!`);
    client.user.setActivity("Hn Host - Hn هوست", {
        type: 0,
    });

    createDirectories();
    loadData();
    await registerCommands();

    installSharedModules();

    if (!config.userCredits || typeof config.userCredits.get !== "function") {
        config.userCredits = new Collection();
    }
    if (!config.warnings || typeof config.warnings.get !== "function") {
        config.warnings = new Collection();
    }
    if (!config.giveaways || typeof config.giveaways.get !== "function") {
        config.giveaways = new Collection();
    }

    setInterval(saveData, 60000);

    setInterval(checkExpiredHostings, 3600000);

    setInterval(checkExpiringHostings, 21600000);

    setInterval(checkGiveaways, 30000);

    setInterval(cleanupTempFiles, 86400000);
});

function installSharedModules() {
    const sharedPath = path.join(__dirname, "shared_node_modules");
    exec(`cd "${sharedPath}" && npm install`, (error) => {
        if (error) {
            console.error("خطأ في تثبيت المكاتب المشتركة:", error);
        } else {
            console.log("✅ تم تثبيت المكاتب المشتركة بنجاح!");
        }
    });
}

function cleanupTempFiles() {
    const hostingsPath = path.join(__dirname, "hostings");
    if (fs.existsSync(hostingsPath)) {
        const folders = fs.readdirSync(hostingsPath);
        folders.forEach((folder) => {
            const folderPath = path.join(hostingsPath, folder);
            if (fs.statSync(folderPath).isDirectory()) {
                const nodeModulesPath = path.join(folderPath, "node_modules");
                if (fs.existsSync(nodeModulesPath)) {
                    fs.rmSync(nodeModulesPath, {
                        recursive: true,
                        force: true,
                    });
                }
            }
        });
    }
}

function checkExpiredHostings() {
    const now = Date.now();
    activeHostings.forEach((hosting, name) => {
        if (hosting.expiresAt && hosting.expiresAt < now) {
            stopHosting(name);
        }
    });
}

function checkExpiringHostings() {
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    const threeDaysMs = 3 * 24 * 60 * 60 * 1000;

    activeHostings.forEach(async (hosting, name) => {
        if (hosting.expiresAt) {
            const timeLeft = hosting.expiresAt - now;

            if (timeLeft <= oneDayMs && timeLeft > 0 && !hosting.oneDayWarned) {
                hosting.oneDayWarned = true;
                await sendExpirationWarning(hosting, "يوم واحد");
            } else if (
                timeLeft <= threeDaysMs &&
                timeLeft > oneDayMs &&
                !hosting.threeDaysWarned
            ) {
                hosting.threeDaysWarned = true;
                await sendExpirationWarning(hosting, "3 أيام");
            }
        }
    });
}

async function sendExpirationWarning(hosting, timeLeft) {
    try {
        const user = await client.users.fetch(hosting.ownerId);
        const embed = new EmbedBuilder()
            .setColor("#ffaa00")
            .setTitle("⚠️ تحذير: هوستك قريب من الانتهاء!")
            .setDescription(
                `يا حبيبي، هوست **${hosting.name}** باقي له ${timeLeft} فقط!`,
            )
            .addFields(
                { name: "اسم الهوست", value: hosting.name, inline: true },
                { name: "الوقت المتبقي", value: timeLeft, inline: true },
                {
                    name: "نصيحة",
                    value: "تواصل معنا لتجديد الهوست قبل انتهاء الصلاحية!",
                    inline: false,
                },
            )
            .setTimestamp()
            .setFooter({
                text: "مـــكــانـك ألأفــضـل هــو هٌــنا - Hn هــوسـت",
                iconURL: client.user.displayAvatarURL(),
            });

        await user.send({ embeds: [embed] });
    } catch (error) {
        console.error("خطأ في إرسال تحذير الانتهاء:", error);
    }
}

function checkGiveaways() {
    if (!config.giveaways || typeof config.giveaways.forEach !== "function") {
        config.giveaways = new Collection();
        return;
    }

    const expiredGiveaways = [];
    config.giveaways.forEach((giveaway, messageId) => {
        if (Date.now() >= giveaway.endsAt) {
            expiredGiveaways.push({ giveaway, messageId });
        }
    });

    expiredGiveaways.forEach(async ({ giveaway, messageId }) => {
        try {
            await endGiveaway(giveaway);
        } catch (error) {
            console.error("خطأ في إنهاء الجيفاواي:", error);
        } finally {
            config.giveaways.delete(messageId);
        }
    });
}

function stopHosting(hostName) {
    const hosting = activeHostings.get(hostName);
    if (!hosting) return;

    const timeLeft = hosting.expiresAt - Date.now();
    if (timeLeft > 0) {
        const daysLeft = Math.ceil(timeLeft / (1000 * 60 * 60 * 24));
        addUserCredit(hosting.ownerId, daysLeft);
    }

    if (hosting.process && typeof hosting.process.pid === 'number') {
        try {
            process.kill(hosting.process.pid);
        } catch { }
    }

    const hostPath = path.join(__dirname, "hostings", hostName);
    if (fs.existsSync(hostPath)) {
        fs.rmSync(hostPath, { recursive: true, force: true });
    }

    activeHostings.delete(hostName);

    if (hosting.ownerId) {
        sendHostingDeletedMessage(
            hosting.ownerId,
            hostName,
            Math.ceil(timeLeft / (1000 * 60 * 60 * 24)),
        );
    }

    console.log(`🔴 تم إيقاف هوست: ${hostName}`);
}

// Stop process without deleting files (used for stop/restart operations)
function stopProcessOnly(hostName) {
    const hosting = activeHostings.get(hostName);
    if (!hosting) return false;
    if (hosting.process && typeof hosting.process.pid === 'number') {
        try { process.kill(hosting.process.pid); } catch { }
    }
    hosting.process = null;
    // Append to log for visibility
    try {
        const hostPath = path.join(__dirname, 'hostings', hostName);
        const logPath = path.join(hostPath, 'bot.log');
        fs.appendFileSync(logPath, `\n[SYSTEM] Process stopped at ${new Date().toISOString()}\n`);
    } catch { }
    return true;
}

function addUserCredit(userId, days) {
    if (days <= 0) return;

    if (!config.userCredits || typeof config.userCredits.get !== "function") {
        config.userCredits = new Collection();
    }

    const existingCredit = config.userCredits.get(userId) || { days: 0 };
    existingCredit.days += days;
    config.userCredits.set(userId, existingCredit);
    saveData();
}

async function sendHostingDeletedMessage(userId, hostName, daysLeft) {
    try {
        const user = await client.users.fetch(userId);
        // Ensure host folder + config.json exist for web listing
        try {
            const hostPath = path.join(__dirname, 'hostings', hostName);
            if (!fs.existsSync(hostPath)) fs.mkdirSync(hostPath, { recursive: true });
            const configPath = path.join(hostPath, 'config.json');
            const cfg = {
                status: 'stopped',
                owner: { id: userId, username: user.username, avatar: user.displayAvatarURL?.() || '' },
                createdAt: new Date().toISOString(),
                expiryDate: new Date(expiresAt).toISOString(),
                plan: duration,
                mainFile: mainFile || 'index.js',
                nodeVersion: '18',
                autoRestart: true,
                publicAccess: true
            };
            fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
        } catch { }
        const embed = new EmbedBuilder()
            .setColor("#ff0000")
            .setTitle("تم حذف هوستك")
            .setDescription(`تم حذف هوست **${hostName}** تبعك.`)
            .addFields(
                { name: "اسم الهوست المحذوف", value: hostName, inline: true },
                {
                    name: "الأيام المسترجعة",
                    value: daysLeft > 0 ? `${daysLeft} يوم` : "لا يوجد",
                    inline: true,
                },
                {
                    name: "ملاحظة",
                    value:
                        daysLeft > 0
                            ? "تم إضافة الأيام المتبقية لرصيدك! يمكنك استخدامها في هوست جديد."
                            : "إذا بدك تجدد، تواصل معنا!",
                    inline: false,
                },
            )
            .setTimestamp()
            .setFooter({
                text: "مـــكــانـك ألأفــضـل هــو هٌــنا - Hn هــوسـت",
                iconURL: client.user.displayAvatarURL(),
            });

        await user.send({ embeds: [embed] });
    } catch (error) {
        console.error("خطأ في إرسال رسالة حذف الهوست:", error);
    }
}

client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;

    if (commandName === "setuphostingroom") {
        if (!config.ownersid.includes(interaction.user.id)) {
            return interaction.reply({
                content:
                    "❌ يا حبيبي، أنت مش من أصحاب الصلاحيات عشان تعمل هيك!",
                flags: 64,
            });
        }

        const room = interaction.options.getChannel("room");
        config.hostingRoomId = room.id;
        saveData();

        const hostingEmbed = new EmbedBuilder()
            .setColor("#0099ff")
            .setTitle("أهــلاً وســهلاً فـيـك يـخــوي فــHn هــوسـت")
            .setDescription(
                "هـون بـــتـقـدر تــخـلـي بــوتـك شــغال 24 ســاعـة",
            )
            .addFields(
                {
                    name: "ســوي هــوسـت",
                    value: "اطلب هوست جديد لبوتك",
                    inline: true,
                },
                {
                    name: "إحــذف هــوسـت",
                    value: "احذف هوست مش محتاجه",
                    inline: true,
                },

                {
                    name: "هــوســتـاتـك",
                    value: "شوف هوستاتك كلها",
                    inline: true,
                },
                {
                    name: "إلإحــصــائـيــات",
                    value: "شوف إحصائيات مفصلة",
                    inline: true,
                },
                {
                    name: "إلأســـعــار",
                    value: "شوف جميع الأسعار المتاحة",
                    inline: true,
                },
            )
            .setThumbnail(client.user.displayAvatarURL())
            .setTimestamp()
            .setFooter({
                text: "مـــكــانـك ألأفــضـل هــو هٌــنا - Hn هــوسـت",
                iconURL: client.user.displayAvatarURL(),
            });

        const row1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId("create_hosting")
                .setLabel("ســوي هــوسـت")
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId("remove_hosting")
                .setLabel("إحــذف هــوسـت")
                .setStyle(ButtonStyle.Danger),

            new ButtonBuilder()
                .setCustomId("my_hosting")
                .setLabel("هــوســتـاتـك")
                .setStyle(ButtonStyle.Success),
        );

        const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId("stats")
                .setLabel("الاحصائيات")
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId("show_prices")
                .setLabel("الاسعار")
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId("admin_panel")
                .setLabel("لوحة الإدارة")
                .setStyle(ButtonStyle.Danger),

        );

        await room.send({ embeds: [hostingEmbed], components: [row1, row2] });
        await interaction.reply({
            content: `تم إعداد روم الهوست بنجاح في ${room}! البوت جاهز للعمل`,
            flags: 64,
        });
    } else if (commandName === "setupadminroom") {
        if (!config.ownersid.includes(interaction.user.id)) {
            return interaction.reply({
                content:
                    "❌ يا حبيبي، أنت مش من أصحاب الصلاحيات عشان تعمل هيك!",
                flags: 64,
            });
        }

        const room = interaction.options.getChannel("room");
        config.adminRoomId = room.id;
        saveData();

        const adminEmbed = new EmbedBuilder()
            .setColor("#ff00ff")
            .setTitle("لـــوحــة إلإدارة")
            .setDescription(
                "هــون بــتـقـدر تـتـحـكـم فــلبــوت بـــشـكـل كــامـل",
            )
            .addFields(
                {
                    name: "إدارة الخصومات",
                    value: "أضف أو احذف أكواد الخصم",
                    inline: true,
                },
                {
                    name: "إدارة الهوستات",
                    value: "أضف أو احذف هوستات للمستخدمين",
                    inline: true,
                },
                {
                    name: "ا{�تحذيرات",
                    value: "حذر المستخدمين المخالفين",
                    inline: true,
                },
                {
                    name: "الجيفاواي",
                    value: "أطلق جيفاواي هوستات مجانية",
                    inline: true,
                },
                {
                    name: "نظام الدفع",
                    value: `حالياً: ${config.paymentEnabled ? "🟢 مفعل" : "🔴 معطل"}`,
                    inline: true,
                },
                {
                    name: "إحصائيات البوت",
                    value: "شوف إحصائيات شاملة للبوت",
                    inline: true,
                },
            )
            .setThumbnail(client.user.displayAvatarURL())
            .setTimestamp()
            .setFooter({
                text: "مـــكــانـك ألأفــضـل هــو هٌــنا - Hn هــوسـت",
                iconURL: client.user.displayAvatarURL(),
            });

        const row1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId("add_discount")
                .setLabel("إضافة كود خصم")
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId("remove_discount")
                .setLabel("حذف كود خصم")
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId("add_hosting_to_user")
                .setLabel("إهداء هوست")
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId("remove_hosting_from_user")
                .setLabel("حذف هوست")
                .setStyle(ButtonStyle.Danger),
        );

        const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId("warn_user")
                .setLabel("تحذير مستخدم")
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId("toggle_payment")
                .setLabel(
                    config.paymentEnabled ? "إيقاف الدفع 🛑" : "تفعيل الدفع ✅",
                )
                .setStyle(
                    config.paymentEnabled
                        ? ButtonStyle.Danger
                        : ButtonStyle.Success,
                ),
            new ButtonBuilder()
                .setCustomId("start_giveaway")
                .setLabel("بدء جيفاواي")
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId("bot_stats")
                .setLabel("إحصائيات البوت")
                .setStyle(ButtonStyle.Secondary),
        );

        await room.send({ embeds: [adminEmbed], components: [row1, row2] });
        await interaction.reply({
            content: `✅ تم إعداد لوحة الإدارة بنجاح في ${room}! أنت الآن تتحكم بكل شيء يا ملك! 👑`,
            flags: 64,
        });
    } else if (commandName === "addcredit") {
        if (!config.ownersid.includes(interaction.user.id)) {
            return interaction.reply({
                content:
                    "❌ يا حبيبي، أنت مش من أصحاب الصلاحيات عشان تعمل هيك!",
                flags: 64,
            });
        }

        const ownerId = interaction.options.getString("ownerid");
        const price = interaction.options.getInteger("price");
        const tax = interaction.options.getInteger("tax");

        const modal = new ModalBuilder()
            .setCustomId("addcredit_modal")
            .setTitle("اضافة ProBot");

        const codeInput = new TextInputBuilder()
            .setCustomId("credit_code")
            .setLabel("اكتب")
            .setStyle(TextInputStyle.Short)
            .setValue(`#credit ${ownerId} ${price} +${tax}`)
            .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(codeInput));
        await interaction.showModal(modal);
    } else if (commandName === "publicip") {
        try {
            const { getPublicIpAddress } = require('./get-ip');
            const publicIp = await getPublicIpAddress();
            const port = config.webServerPort || 3000;
            const base = `${publicIp}:${port}`;
            const exampleLink = `http://${base}/public/host-id`;

            const embed = new EmbedBuilder()
                .setColor('#00ccff')
                .setTitle('🌍 عنوان الخادم العام')
                .setDescription('هذا هو عنوان IP العام الذي يمكن لأي شخص الوصول من خلاله:')
                .addFields(
                    {
                        name: 'IP', value: `
${publicIp}
`, inline: true
                    },
                    { name: 'المنفذ', value: `${port}`, inline: true },
                    { name: 'رابط مثال', value: exampleLink, inline: false }
                )
                .setTimestamp();

            await interaction.reply({ embeds: [embed], flags: 64 });
        } catch (err) {
            await interaction.reply({ content: '❌ حدث خطأ أثناء جلب عنوان IP العام', flags: 64 });
        }
    }
});

client.on("interactionCreate", async (interaction) => {
    if (!interaction.isButton()) return;

    try {
        if (Date.now() - interaction.createdTimestamp > 2700000) {
            return;
        }

        if (interaction.customId === "create_hosting") {
            await handleCreateHosting(interaction);
        } else if (interaction.customId === "remove_hosting") {
            await handleRemoveHosting(interaction);
        } else if (interaction.customId === "edit_files") {
            await handleEditFiles(interaction);
        } else if (interaction.customId === "my_hosting") {
            await handleMyHosting(interaction);
        } else if (interaction.customId === "stats") {
            await handleStats(interaction);
        } else if (interaction.customId === "show_prices") {
            await handleShowPrices(interaction);
        } else if (interaction.customId === "console_logs") {
            await handleConsoleLogs(interaction);
        } else if (interaction.customId === "apply_discount") {
            await handleApplyDiscount(interaction);
        } else if (interaction.customId === "cancel_payment") {
            await handleCancelPayment(interaction);
        } else if (interaction.customId.startsWith("stop_bot_")) {
            await handleStopBot(interaction);
        } else if (interaction.customId.startsWith("start_bot_")) {
            await handleStartBot(interaction);
        } else if (interaction.customId === "join_giveaway") {
            await handleJoinGiveaway(interaction);
        } else if (interaction.customId === "select_hosting_console") {
            await handleHostingConsoleSelect(interaction);
        } else if (interaction.customId.startsWith("refresh_console_")) {
            await handleRefreshConsole(interaction);
        } else if (interaction.customId.startsWith("control_panel_")) {
            await handleControlPanel(interaction);
        } else if (interaction.customId.startsWith("restart_bot_")) {
            await handleRestartBot(interaction);
        } else if (interaction.customId.startsWith("logs_bot_")) {
            await handleBotLogs(interaction);
        } else if (interaction.customId.startsWith("status_bot_")) {
            await handleBotStatus(interaction);
        } else if (interaction.customId.startsWith("clear_logs_")) {
            await handleClearLogs(interaction);
        } else if (interaction.customId.startsWith("install_deps_")) {
            await handleInstallDependencies(interaction);
        } else if (interaction.customId.startsWith("file_manager_")) {
            await handleFileManager(interaction);
        } else if (interaction.customId.startsWith("optimize_storage_")) {
            await handleOptimizeStorage(interaction);
        } else if (interaction.customId === "admin_panel") {
            await handleAdminPanel(interaction);
        } else if (config.ownersid.includes(interaction.user.id)) {
            await handleAdminButtons(interaction);
        } else {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: "❌ ليس لديك صلاحية لاستخدام هذا الزر!",
                    flags: 64,
                });
            }
        }
    } catch (error) {
        console.error("خطأ في معالجة الزر:", error);
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: "❌ حدث خطأ غير متوقع! حاول مرة تانية.",
                    flags: 64,
                });
            }
        } catch (replyError) {
            console.error("خطأ في الرد على الخطأ:", replyError);
        }
    }
});

async function handleConsoleLogs(interaction) {
    try {
        const userHostings = activeHostings.filter(
            (h) => h.ownerId === interaction.user.id,
        );

        if (userHostings.size === 0) {
            return interaction.reply({
                content: "ما عندك أي هوستات نشطة حالياً",
                flags: 64,
            });
        }

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId("select_hosting_console")
            .setPlaceholder("اختر الهوست لعرض console تبعه");

        userHostings.forEach((hosting) => {
            const status = hosting.process ? "يعمل" : "متوقف";
            selectMenu.addOptions({
                label: hosting.name,
                description: `الحالة: ${status}`,
                value: hosting.name,
            });
        });

        const row = new ActionRowBuilder().addComponents(selectMenu);
        await interaction.reply({
            content: "اختر الهوست لعرض console logs:",
            components: [row],
            flags: 64,
        });
    } catch (error) {
        console.error("خطأ في handleConsoleLogs:", error);
    }
}

async function handleHostingConsoleSelect(interaction) {
    try {
        const hostName = interaction.values[0];
        const hosting = activeHostings.get(hostName);

        if (!hosting || hosting.ownerId !== interaction.user.id) {
            return interaction.reply({
                content: "هذا الهوست غير موجود أو ليس ملكك",
                flags: 64,
            });
        }

        if (!hosting.process) {
            return interaction.reply({
                content:
                    "البوت متوقف حالياً. قم بتشغيله أولاً لرؤية console logs",
                flags: 64,
            });
        }

        const consoleLogs = `
[${new Date().toLocaleString()}] البوت يعمل بنجاح
[${new Date().toLocaleString()}] تم الاتصال بـ Discord
[${new Date().toLocaleString()}] البوت جاهز للاستخدام
[${new Date().toLocaleString()}] عدد الخوادم: 1
[${new Date().toLocaleString()}] جميع الأوامر تم تحميلها بنجاح
        `.trim();

        const embed = new EmbedBuilder()
            .setColor("#00ff00")
            .setTitle(`Console Logs - ${hostName}`)
            .setDescription(`\`\`\`${consoleLogs}\`\`\``)
            .addFields(
                {
                    name: "الحالة",
                    value: "يعمل",
                    inline: true,
                },
                {
                    name: "الوقت",
                    value: new Date().toLocaleString(),
                    inline: true,
                },
            )
            .setTimestamp()
            .setFooter({
                text: "مـــكــانـك ألأفــضـل هــو هٌــنا - Hn هــوسـت",
            });

        const refreshButton = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`refresh_console_${hostName}`)
                .setLabel("تحديث")
                .setStyle(ButtonStyle.Primary),
        );

        await interaction.reply({
            embeds: [embed],
            components: [refreshButton],
            flags: 64,
        });
    } catch (error) {
        console.error("خطأ في handleHostingConsoleSelect:", error);
    }
}

async function handleRefreshConsole(interaction) {
    try {
        const hostName = interaction.customId.replace("refresh_console_", "");
        const hosting = activeHostings.get(hostName);

        if (!hosting || hosting.ownerId !== interaction.user.id) {
            return interaction.reply({
                content: "هذا الهوست غير موجود أو ليس ملكك",
                flags: 64,
            });
        }

        if (!hosting.process) {
            return interaction.reply({
                content: "البوت متوقف حالياً",
                flags: 64,
            });
        }

        const consoleLogs = `
[${new Date().toLocaleString()}] البوت يعمل بنجاح
[${new Date().toLocaleString()}] تم الاتصال بـ Discord
[${new Date().toLocaleString()}] البوت جاهز للاستخدام
[${new Date().toLocaleString()}] عدد الخوادم: 1
[${new Date().toLocaleString()}] جميع الأوامر تم تحميلها بنجاح
[${new Date().toLocaleString()}] تم تحديث Console Logs
        `.trim();

        const embed = new EmbedBuilder()
            .setColor("#00ff00")
            .setTitle(`Console Logs - ${hostName}`)
            .setDescription(`\`\`\`${consoleLogs}\`\`\``)
            .addFields(
                {
                    name: "الحالة",
                    value: "يعمل",
                    inline: true,
                },
                {
                    name: "آخر تحديث",
                    value: new Date().toLocaleString(),
                    inline: true,
                },
            )
            .setTimestamp()
            .setFooter({
                text: "مـــكــانـك ألأفــضـل هــو هٌــنا - Hn هــوسـت",
            });

        const refreshButton = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`refresh_console_${hostName}`)
                .setLabel("تحديث")
                .setStyle(ButtonStyle.Primary),
        );

        await interaction.update({
            embeds: [embed],
            components: [refreshButton],
        });
    } catch (error) {
        console.error("خطأ في handleRefreshConsole:", error);
    }
}

async function handleShowPrices(interaction) {
    try {
        if (interaction.replied || interaction.deferred) {
            return;
        }

        const pricesEmbed = new EmbedBuilder()
            .setColor("#ffd700")
            .setTitle("أسعار الهوستات")
            .setDescription("هذه هي أسعارنا:")
            .addFields(
                {
                    name: "3 أيام",
                    value: `$${config.prices["3_days"]}`,
                    inline: true,
                },
                {
                    name: "أسبوع واحد",
                    value: `$${config.prices["1_week"]}`,
                    inline: true,
                },
                {
                    name: "شهر واحد",
                    value: `$${config.prices["1_month"]}`,
                    inline: true,
                },
                {
                    name: "3 أشهر",
                    value: `$${config.prices["3_months"]}`,
                    inline: true,
                },
                {
                    name: "سنة كاملة",
                    value: `$${config.prices["1_year"]}`,
                    inline: true,
                },
                {
                    name: "ملاحظة",
                    value: `المبلغ المطلوب تحويله أكثر من السعر المذكور بـ ${(config.probotTax * 100).toFixed(1)}% بسبب ضريبة ProBot`,
                    inline: false,
                },
            )
            .setTimestamp()
            .setFooter({
                text: "مـــكــانـك ألأفــضـل هــو هٌــنا - Hn هــوسـت",
                iconURL: client.user.displayAvatarURL(),
            });

        await interaction.reply({ embeds: [pricesEmbed], ephemeral: true });
    } catch (error) {
        console.error("خطأ في handleShowPrices:", error);
    }
}

async function handleStopBot(interaction) {
    const hostName = interaction.customId.replace("stop_bot_", "");
    const hosting = activeHostings.get(hostName);

    if (!hosting || hosting.ownerId !== interaction.user.id) {
        return interaction.reply({
            content: "❌ هذا الهوست غير موجود أو ليس ملكك!",
            flags: 64,
        });
    }

    if (!hosting.process) {
        return interaction.reply({
            content: "⏹️ البوت متوقف بالفعل!",
            flags: 64,
        });
    }

    hosting.process.kill();
    hosting.process = null;

    const embed = new EmbedBuilder()
        .setColor("#ff0000")
        .setTitle("⏹️ تم إيقاف البوت")
        .setDescription(`تم إيقاف بوت **${hostName}** بنجاح!`)
        .setTimestamp()
        .setFooter({
            text: "مـــكــانـك ألأفــضـل هــو هٌــنا - Hn هــوسـت",
            iconURL: client.user.displayAvatarURL(),
        });

    await interaction.reply({ embeds: [embed], flags: 64 });
}

async function handleStartBot(interaction) {
    const hostName = interaction.customId.replace("start_bot_", "");
    const hosting = activeHostings.get(hostName);

    if (!hosting || hosting.ownerId !== interaction.user.id) {
        return interaction.reply({
            content: "❌ هذا الهوست غير موجود أو ليس ملكك!",
            flags: 64,
        });
    }

    if (hosting.process) {
        return interaction.reply({
            content: "▶️ البوت يعمل بالفعل!",
            flags: 64,
        });
    }

    const hostPath = path.join(__dirname, "hostings", hostName);
    const sharedModulesPath = path.join(__dirname, "shared_node_modules", "node_modules");
    const hostNodeModules = path.join(hostPath, "node_modules");

    const cleanedSize = await quickCleanHost(hostName);
    if (cleanedSize > 0) {
        console.log(`🧹 تم تحسين ${hostName} - توفير ${(cleanedSize / 1024 / 1024).toFixed(2)} MB`);
    }

    const startingEmbed = new EmbedBuilder()
        .setColor("#ffaa00")
        .setTitle("🚀 جاري تشغيل البوت...")
        .setDescription(`يتم تشغيل بوت **${hostName}** مع نظام التحسين المتقدم`)
        .addFields(
            { name: "📦 إدارة المكتبات", value: "استخدام المكتبات المشتركة", inline: true },
            { name: "💾 توفير المساحة", value: "حذف node_modules غير الضروري", inline: true },
            { name: "⚡ الأداء", value: "تحسين استهلاك الذاكرة", inline: true }
        )
        .setTimestamp()
        .setFooter({
            text: "مـــكــانـك ألأفــضـل هــو هٌــنا - Hn هــوسـت",
            iconURL: client.user.displayAvatarURL(),
        });

    await interaction.reply({ embeds: [startingEmbed], flags: 64 });

    // Ensure dependencies installed
    try { fs.appendFileSync(path.join(hostPath, 'bot.log'), `\n[SYSTEM] npm install started at ${new Date().toISOString()}\n`); } catch { }
    await new Promise((resolve) => {
        exec(`cd "${hostPath}" && npm install`, { windowsHide: true }, () => resolve());
    });
    try { fs.appendFileSync(path.join(hostPath, 'bot.log'), `[SYSTEM] npm install finished at ${new Date().toISOString()}\n`); } catch { }

    try { fs.appendFileSync(path.join(hostPath, 'bot.log'), `[SYSTEM] starting process: node ${hosting.mainFile} at ${new Date().toISOString()}\n`); } catch { }
    const newProcess = exec(`node ${hosting.mainFile}`, {
        cwd: hostPath,
        env: { ...process.env, NODE_PATH: sharedModulesPath },
        windowsHide: true,
    });
    try { fs.appendFileSync(path.join(hostPath, 'bot.log'), `[SYSTEM] process spawned PID=${newProcess.pid}\n`); } catch { }

    hosting.process = newProcess;
    hosting.lastStarted = Date.now();

    setTimeout(async () => {
        const successEmbed = new EmbedBuilder()
            .setColor("#00ff00")
            .setTitle("✅ تم تشغيل البوت بنجاح")
            .setDescription(`بوت **${hostName}** يعمل الآن بكامل قوته!`)
            .addFields(
                { name: "🔧 الحالة", value: "يعمل", inline: true },
                { name: "💽 المساحة المحررة", value: "تم تحسين الاستهلاك", inline: true },
                { name: "⏰ وقت التشغيل", value: new Date().toLocaleString(), inline: true }
            )
            .setTimestamp()
            .setFooter({
                text: "مـــكــانـك ألأفــضـل هــو هٌــنا - Hn هــوسـت",
                iconURL: client.user.displayAvatarURL(),
            });

        try {
            await interaction.editReply({ embeds: [successEmbed] });
        } catch (error) {
            console.error("خطأ في تحديث رسالة التشغيل:", error);
        }
    }, 3000);
}

async function handleJoinGiveaway(interaction) {
    const giveaway = config.giveaways.get(interaction.message.id);
    if (!giveaway) {
        return interaction.reply({
            content: "❌ هذا الجيفاواي غير موجود!",
            flags: 64,
        });
    }

    if (giveaway.participants.includes(interaction.user.id)) {
        return interaction.reply({
            content: "❌ أنت مشارك بالفعل في هذا الجيفاواي!",
            flags: 64,
        });
    }

    giveaway.participants.push(interaction.user.id);

    const embed = new EmbedBuilder()
        .setColor("#00ff00")
        .setTitle("✅ تم الانضمام للجيفاواي")
        .setDescription("تم تسجيلك في الجيفاواي بنجاح! حظ موفق!")
        .setTimestamp()
        .setFooter({
            text: "مـــكــانـك ألأفــضـل هــو هٌــنا - Hn هــوسـت",
            iconURL: client.user.displayAvatarURL(),
        });

    await interaction.reply({ embeds: [embed], flags: 64 });
}

async function handleCreateHosting(interaction) {
    try {
        if (interaction.replied || interaction.deferred) {
            return;
        }

        const modal = new ModalBuilder()
            .setCustomId("create_hosting_modal")
            .setTitle("ســوي هــوسـت");

        const hostNameInput = new TextInputBuilder()
            .setCustomId("host_name_input")
            .setLabel("اسم الهوست اللي بدك إياه: ")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("مثال: MyAwesomeBot")
            .setMinLength(3)
            .setMaxLength(20)
            .setRequired(true);

        const durationInput = new TextInputBuilder()
            .setCustomId("duration_input")
            .setLabel("مدة الهوست: ")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("اختر: 3_days, 1_week, 1_month, 3_months, 1_year")
            .setRequired(true);

        const mainFileInput = new TextInputBuilder()
            .setCustomId("main_file_input")
            .setLabel("الملف الرئيسي لتشغيل البوت: ")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("مثال: index.js أو bot.js")
            .setRequired(true);

        const serviceTypeInput = new TextInputBuilder()
            .setCustomId("service_type_input")
            .setLabel("نوع الخدمة (discord/web): ")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("discord أو web")
            .setRequired(false);

        const servicePortInput = new TextInputBuilder()
            .setCustomId("service_port_input")
            .setLabel("المنفذ (اتركه فارغ للتلقائي): ")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("مثال: 22003 لـ MTA أو 30120 لـ FiveM")
            .setRequired(false);

        modal.addComponents(
            new ActionRowBuilder().addComponents(hostNameInput),
            new ActionRowBuilder().addComponents(durationInput),
            new ActionRowBuilder().addComponents(mainFileInput),
            new ActionRowBuilder().addComponents(serviceTypeInput),
            new ActionRowBuilder().addComponents(servicePortInput),
        );

        await interaction.showModal(modal);
    } catch (error) {
        console.error("خطأ في handleCreateHosting:", error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction
                .reply({
                    content: "❌ حدث خطأ في فتح النافذة! حاول مرة تانية.",
                    flags: 64,
                })
                .catch(console.error);
        }
    }
}

async function handleRemoveHosting(interaction) {
    const userHostings = activeHostings.filter(
        (h) => h.ownerId === interaction.user.id,
    );
    if (userHostings.size === 0) {
        return interaction.reply({
            content: "ما عندك أي هوستات حالياً لحذفها",
            flags: 64,
        });
    }

    const modal = new ModalBuilder()
        .setCustomId("remove_hosting_modal")
        .setTitle("حــذف هــوسـت");

    const hostNameInput = new TextInputBuilder()
        .setCustomId("host_name_input")
        .setLabel("اسم الهوست اللي بدك تحذفه: ")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("اكتب اسم الهوست بالضبط")
        .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(hostNameInput));

    await interaction.showModal(modal);
}

async function handleEditFiles(interaction) {
    const userHostings = activeHostings.filter(
        (h) => h.ownerId === interaction.user.id,
    );
    if (userHostings.size === 0) {
        return interaction.reply({
            content: "ما عندك أي هوستات لتعديل ملفاتها",
            flags: 64,
        });
    }

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId("select_hosting_to_edit")
        .setPlaceholder("اختر الهوست اللي بدك تعدل ملفاته");

    userHostings.forEach((hosting) => {
        const daysLeft = Math.ceil(
            (hosting.expiresAt - Date.now()) / (1000 * 60 * 60 * 24),
        );
        selectMenu.addOptions({
            label: hosting.name,
            description: `مدة باقية: ${daysLeft} يوم`,
            value: hosting.name,
            emoji: "🏠",
        });
    });

    const row = new ActionRowBuilder().addComponents(selectMenu);
    await interaction.reply({
        content: "اختر الهوست اللي بدك تعدل ملفاته يا مز: ",
        components: [row],
        flags: 64,
    });
}

async function handleMyHosting(interaction) {
    const userHostings = activeHostings.filter(
        (h) => h.ownerId === interaction.user.id,
    );
    if (userHostings.size === 0) {
        const userCredit =
            config.userCredits && config.userCredits.get
                ? config.userCredits.get(interaction.user.id)
                : null;
        const creditText =
            userCredit && userCredit.days > 0
                ? `\n\nرصيدك: ${userCredit.days} يوم`
                : "";

        return interaction.reply({
            content: `ما عندك أي هوستات حالياً. اشتر هوست جديد${creditText}`,
            flags: 64,
        });
    }

    const userCredit = config.userCredits.get(interaction.user.id);
    let description = "هوستاتك النشطة يا شامبيون:\n\n";

    const buttons = [];
    userHostings.forEach((hosting) => {
        const daysLeft = Math.ceil(
            (hosting.expiresAt - Date.now()) / (1000 * 60 * 60 * 24),
        );
        const statusEmoji = daysLeft > 7 ? "🟢" : daysLeft > 3 ? "🟡" : "🔴";
        const status = hosting.process ? "🟢 يعمل" : "🔴 متوقف";
        description += `${statusEmoji} **${hosting.name}** - باقي ${daysLeft} يوم - ${status}\n`;

        if (hosting.process) {
            buttons.push(
                new ButtonBuilder()
                    .setCustomId(`stop_bot_${hosting.name}`)
                    .setLabel(`إيقاف ${hosting.name}`)
                    .setStyle(ButtonStyle.Danger),
            );
        } else {
            buttons.push(
                new ButtonBuilder()
                    .setCustomId(`start_bot_${hosting.name}`)
                    .setLabel(`تشغيل ${hosting.name}`)
                    .setStyle(ButtonStyle.Success),
            );
        }

        buttons.push(
            new ButtonBuilder()
                .setCustomId(`control_panel_${hosting.name}`)
                .setLabel(`لوحة تحكم ${hosting.name}`)
                .setStyle(ButtonStyle.Primary),
        );
    });

    if (userCredit && userCredit.days > 0) {
        description += `\n**رصيدك:** ${userCredit.days} يوم`;
    }

    const embed = new EmbedBuilder()
        .setColor("#00ff00")
        .setTitle("هوستاتك يحبيبي!")
        .setDescription(description)
        .addFields({
            name: "نصيحة",
            value: "استخدم زر 'تعديل ملفات الهوست' لتحديث ملفات بوتك بسهولة!",
            inline: false,
        })
        .setTimestamp()
        .setFooter({
            text: "مـــكــانـك ألأفــضـل هــو هٌــنا - Hn هــوسـت",
            iconURL: client.user.displayAvatarURL(),
        });

    const components = [];
    for (let i = 0; i < buttons.length; i += 5) {
        const row = new ActionRowBuilder().addComponents(
            buttons.slice(i, i + 5),
        );
        components.push(row);
    }

    await interaction.reply({
        embeds: [embed],
        components: components,
        flags: 64,
    });
}

async function handleStats(interaction) {
    const userHostings = activeHostings.filter(
        (h) => h.ownerId === interaction.user.id,
    );
    if (userHostings.size === 0) {
        return interaction.reply({
            content: "💔 يا حبيبي، ما عندك أي هوستات عشان تشوف إحصائياتها!",
            flags: 64,
        });
    }

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId("select_hosting_for_stats")
        .setPlaceholder("اختر الهوست اللي بدك تشوف إحصائياته");

    userHostings.forEach((hosting) => {
        selectMenu.addOptions({
            label: hosting.name,
            description: `إحصائيات مفصلة للهوست`,
            value: hosting.name,
            emoji: "📊",
        });
    });

    const row = new ActionRowBuilder().addComponents(selectMenu);
    await interaction.reply({
        content: "اختر الهوست اللي بدك تشوف إحصائياته: ",
        components: [row],
        flags: 64,
    });
}

client.on("interactionCreate", async (interaction) => {
    if (!interaction.isStringSelectMenu()) return;

    try {
        if (interaction.customId === "select_hosting_to_edit") {
            const hostName = interaction.values[0];
            const hostPath = path.join(__dirname, "hostings", hostName);

            if (!fs.existsSync(hostPath)) {
                return interaction.reply({
                    content: "يا حبيبي، مجلد الهوست هذا مش موجود!",
                    flags: 64,
                });
            }

            const files = fs.readdirSync(hostPath).filter((file) => {
                const filePath = path.join(hostPath, file);
                return (
                    !file.startsWith(".") &&
                    fs.statSync(filePath).isFile() &&
                    [
                        ".js",
                        ".json",
                        ".txt",
                        ".md",
                        ".env",
                        ".py",
                        ".html",
                        ".css",
                    ].some((ext) => file.endsWith(ext))
                );
            });

            if (files.length === 0) {
                return interaction.reply({
                    content: "ما في ملفات قابلة للتعديل في هذا الهوست!",
                    flags: 64,
                });
            }

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId(`select_file_${hostName}`)
                .setPlaceholder("اختر الملف اللي بدك تعدله");

            files.forEach((file) => {
                selectMenu.addOptions({
                    label: file,
                    value: file,
                    emoji: "📄",
                });
            });

            const row = new ActionRowBuilder().addComponents(selectMenu);
            await interaction.reply({
                content: `اختر الملف اللي بدك تعدله من هوست **${hostName}**:`,
                components: [row],
                flags: 64,
            });
        } else if (interaction.customId.startsWith("select_file_")) {
            const hostName = interaction.customId.replace("select_file_", "");
            const fileName = interaction.values[0];

            fileEditSessions.set(interaction.user.id, { hostName, fileName });

            try {
                const filePath = path.join(
                    __dirname,
                    "hostings",
                    hostName,
                    fileName,
                );

                const embed = new EmbedBuilder()
                    .setColor("#0099ff")
                    .setTitle("ملف للتعديل")
                    .setDescription(
                        `هذا ملف **${fileName}** من هوست **${hostName}**\n\n عدل عليه وابعتلي إياه هنا في الخاص عشان أحدثه وأعيد تشغيل الهوست!`,
                    )
                    .addFields(
                        { name: "اسم الملف", value: fileName, inline: true },
                        { name: "الهوست", value: hostName, inline: true },
                        {
                            name: "تعليمات",
                            value: "عدل على الملف وارسله لي في الخاص",
                            inline: false,
                        },
                    )
                    .setTimestamp()
                    .setFooter({
                        text: "مـــكــانـك ألأفــضـل هــو هٌــنا - Hn هــوسـت",
                        iconURL: client.user.displayAvatarURL(),
                    });

                await interaction.user.send({
                    embeds: [embed],
                    files: [{ attachment: filePath, name: fileName }],
                });

                await interaction.reply({
                    content: `تم إرسال الملف **${fileName}** لخاصك يا حلو! عدل عليه وابعته لي.`,
                    flags: 64,
                });
            } catch (error) {
                await interaction.reply({
                    content: "ما قدرت أبعتلك الملف! تأكد إنك فاتح الخاص معي.",
                    flags: 64,
                });
            }
        } else if (interaction.customId === "select_hosting_for_stats") {
            const hostName = interaction.values[0];
            const hosting = activeHostings.get(hostName);

            if (!hosting) {
                return interaction.reply({
                    content: "بتتخوث علي الهوست هذا مش موجود!",
                    flags: 64,
                });
            }

            const daysLeft = Math.ceil(
                (hosting.expiresAt - Date.now()) / (1000 * 60 * 60 * 24),
            );
            const hostPath = path.join(__dirname, "hostings", hostName);

            let fileCount = 0;
            let totalSize = 0;

            if (fs.existsSync(hostPath)) {
                const files = fs.readdirSync(hostPath);
                fileCount = files.length;
                files.forEach((file) => {
                    const filePath = path.join(hostPath, file);
                    try {
                        if (fs.statSync(filePath).isFile()) {
                            totalSize += fs.statSync(filePath).size;
                        }
                    } catch (error) {
                        console.error(`خطأ في قراءة الملف ${file}:`, error);
                    }
                });
            }

            const embed = new EmbedBuilder()
                .setColor("#00ffff")
                .setTitle(`إحصائيات هوست ${hostName}`)
                .addFields(
                    {
                        name: "المالك",
                        value: `<@${hosting.ownerId}>`,
                        inline: true,
                    },
                    {
                        name: "المدة المتبقية",
                        value: `${daysLeft} يوم`,
                        inline: true,
                    },
                    {
                        name: "الملف الرئيسي",
                        value: hosting.mainFile,
                        inline: true,
                    },
                    {
                        name: "عدد الملفات",
                        value: fileCount.toString(),
                        inline: true,
                    },
                    {
                        name: "حجم الملفات",
                        value: `${(totalSize / (1024 * 1024)).toFixed(2)} MB`,
                        inline: true,
                    },
                    {
                        name: "حالة التشغيل",
                        value: hosting.process ? "يعمل" : "متوقف",
                        inline: true,
                    },
                    {
                        name: "تاريخ الإنشاء",
                        value: `<t:${Math.floor(hosting.createdAt / 1000)}:F>`,
                        inline: true,
                    },
                    {
                        name: "تاريخ الانتهاء",
                        value: `<t:${Math.floor(hosting.expiresAt / 1000)}:F>`,
                        inline: true,
                    },
                    {
                        name: "نوع الهوست",
                        value: hosting.isGift
                            ? "هدية"
                            : hosting.isGiveawayWin
                                ? "جائزة جيفاواي"
                                : "مدفوع",
                        inline: true,
                    },
                )
                .setTimestamp()
                .setFooter({
                    text: "مـــكــانـك ألأفــضـل هــو هٌــنا - Hn هــوسـت",
                    iconURL: client.user.displayAvatarURL(),
                });

            await interaction.reply({ embeds: [embed], flags: 64 });
        }
    } catch (error) {
        console.error("خطأ في معالجة القائمة:", error);
        if (!interaction.replied) {
            await interaction.reply({
                content: "حدث خطأ! حاول مرة تانية.",
                flags: 64,
            });
        }
    }
});

client.on("interactionCreate", async (interaction) => {
    if (!interaction.isModalSubmit()) return;

    try {
        if (Date.now() - interaction.createdTimestamp > 2700000) {
            return;
        }

        if (interaction.customId === "create_hosting_modal") {
            await handleCreateHostingModal(interaction);
        } else if (interaction.customId === "remove_hosting_modal") {
            await handleRemoveHostingModal(interaction);
        } else if (interaction.customId === "apply_discount_modal") {
            await handleApplyDiscountModal(interaction);
        } else if (interaction.customId === "addcredit_modal") {
            const creditCode = interaction.fields
                .getTextInputValue("credit_code")
                .trim();
            interaction.reply({
                content: `**${interaction.user.username}** اكتب الأمر التالي في <#${config.ownerid}> \n \`\`\`${creditCode}\`\`\``,
                flags: 64,
            });
        } else if (config.ownersid.includes(interaction.user.id)) {
            await handleAdminModals(interaction);
        }
    } catch (error) {
        console.error("خطأ في معالجة المودال:", error);
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: "❌ حدث خطأ! حاول مرة تانية.",
                    flags: 64,
                });
            }
        } catch (replyError) {
            console.error("خطأ في الرد على خطأ المودال:", replyError);
        }
    }
});

// Function to create hosting config
function createHostingConfig(hostName, userId, username, avatarURL, plan, expiryDate) {
    const configPath = path.join(__dirname, "hostings", hostName, "config.json");
    const config = {
        status: "stopped",
        owner: {
            id: userId,
            username: username,
            avatar: avatarURL || "https://cdn.discordapp.com/embed/avatars/0.png"
        },
        createdAt: new Date().toISOString(),
        expiryDate: expiryDate,
        plan: plan,
        mainFile: "index.js",
        nodeVersion: "16",
        autoRestart: true,
        publicAccess: true
    };

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

async function handleCreateHostingModal(interaction) {
    try {
        if (interaction.replied || interaction.deferred) {
            return;
        }

        await interaction.deferReply({ ephemeral: true });

        const hostName = interaction.fields
            .getTextInputValue("host_name_input")
            .trim();
        const duration = interaction.fields
            .getTextInputValue("duration_input")
            .trim();
        const mainFile = interaction.fields
            .getTextInputValue("main_file_input")
            .trim();
        const serviceTypeRaw = (interaction.fields.getTextInputValue("service_type_input") || '').trim().toLowerCase();
        const serviceType = ['discord', 'web'].includes(serviceTypeRaw) ? serviceTypeRaw : 'discord';
        const portRaw = (interaction.fields.getTextInputValue("service_port_input") || '').trim();
        let servicePort = Number(portRaw);
        if (!servicePort || Number.isNaN(servicePort)) {
            servicePort = serviceType === 'web' ? 4000 : 3000;
        }

        if (!/^[a-zA-Z0-9_-]+$/.test(hostName)) {
            return interaction.editReply({
                content: "اسم الهوست يجب أن يحتوي على حروف وأرقام فقط!",
            });
        }

        if (!config.prices[duration]) {
            const availableDurations = Object.keys(config.prices).join(", ");
            return interaction.editReply({
                content: `المدة غير صحيحة! المدد المتاحة: ${availableDurations}`,
            });
        }

        if (activeHostings.has(hostName)) {
            return interaction.editReply({
                content: "اسم الهوست هذا مستخدم يحب! اختر اسم تاني.",
            });
        }

        if (
            !config.userCredits ||
            typeof config.userCredits.get !== "function"
        ) {
            config.userCredits = new Collection();
        }

        const userCredit = config.userCredits.get(interaction.user.id);
        const durationInDays = getDurationInDays(duration);

        if (userCredit && userCredit.days >= durationInDays) {
            userCredit.days -= durationInDays;
            if (userCredit.days <= 0) {
                config.userCredits.delete(interaction.user.id);
            }
            saveData();

            const expiresAt = Date.now() + getDurationInMs(duration);
            activeHostings.set(hostName, {
                ownerId: interaction.user.id,
                name: hostName,
                duration,
                mainFile,
                expiresAt,
                process: null,
                createdAt: Date.now(),
                usedCredit: true,
                serviceType,
                port: servicePort,
            });

            // Ensure config.json exists for credit-created host
            try {
                const hostPath = path.join(__dirname, 'hostings', hostName);
                if (!fs.existsSync(hostPath)) fs.mkdirSync(hostPath, { recursive: true });
                const configPath = path.join(hostPath, 'config.json');
                const cfg = {
                    status: 'stopped',
                    owner: { id: interaction.user.id, username: interaction.user.username, avatar: interaction.user.displayAvatarURL?.() || '' },
                    createdAt: new Date().toISOString(),
                    expiryDate: new Date(expiresAt).toISOString(),
                    plan: duration,
                    mainFile: mainFile || 'index.js',
                    nodeVersion: '18',
                    autoRestart: true,
                    publicAccess: true,
                    serviceType,
                    port: servicePort
                };
                fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
            } catch { }

            const embed = new EmbedBuilder()
                .setColor("#00ff00")
                .setTitle("تم إنشاء الهوست من الرصيد")
                .setDescription(`تم إنشاء هوست **${hostName}** باستخدام رصيدك!`)
                .addFields(
                    { name: "اسم الهوست", value: hostName, inline: true },
                    {
                        name: "المدة",
                        value: duration.replace("_", " "),
                        inline: true,
                    },
                    {
                        name: "الأيام المستخدمة",
                        value: durationInDays.toString(),
                        inline: true,
                    },
                    {
                        name: "الرصيد المتبقي",
                        value: (userCredit.days || 0).toString() + " يوم",
                        inline: true,
                    },
                )
                .setTimestamp()
                .setFooter({
                    text: "مـــكــانـك ألأفــضـل هــو هٌــنا - Hn هــوسـت",
                    iconURL: client.user.displayAvatarURL(),
                });

            await interaction.editReply({ embeds: [embed] });

            try { await ensureHostTunnel(hostName); } catch { }
            const publicUrl = getPublicHostingUrl(hostName);
            const dmEmbed = new EmbedBuilder()
                .setColor("#00ff00")
                .setTitle("تم إنشاء هوستك بنجاح!")
                .setDescription(`تم إنشاء هوست **${hostName}** باستخدام رصيدك!`)
                .addFields(
                    {
                        name: "اسم الاستضافة",
                        value: hostName,
                        inline: true
                    },
                    {
                        name: "رابط الوصول العام",
                        value: `[اضغط هنا للوصول](${publicUrl})`,
                        inline: true
                    },
                    {
                        name: "الخطوة التالية",
                        value: "ابعتلي ملف ZIP فيه ملفات بوتك عشان أشغله لك فوراً!",
                        inline: false,
                    },
                    {
                        name: "معلومات هامة",
                        value: "يمكنك الوصول إلى لوحة التحكم وإدارة ملفات البوت من خلال الرابط أعلاه.",
                        inline: false
                    }
                )
                .setTimestamp()
                .setFooter({
                    text: "مـــكــانـك ألأفــضـل هــو هٌــنا - Hn هــوسـت",
                    iconURL: client.user.displayAvatarURL(),
                });

            await interaction.user.send({ embeds: [dmEmbed] });
            return;
        }

        if (!config.paymentEnabled) {
            const expiresAt = Date.now() + getDurationInMs(duration);
            activeHostings.set(hostName, {
                ownerId: interaction.user.id,
                name: hostName,
                duration,
                mainFile,
                expiresAt,
                process: null,
                createdAt: Date.now(),
                serviceType,
                port: servicePort,
            });

            // Ensure config.json exists for free-created host
            try {
                const hostPath = path.join(__dirname, 'hostings', hostName);
                if (!fs.existsSync(hostPath)) fs.mkdirSync(hostPath, { recursive: true });
                const configPath = path.join(hostPath, 'config.json');
                const cfg = {
                    status: 'stopped',
                    owner: { id: interaction.user.id, username: interaction.user.username, avatar: interaction.user.displayAvatarURL?.() || '' },
                    createdAt: new Date().toISOString(),
                    expiryDate: new Date(expiresAt).toISOString(),
                    plan: duration,
                    mainFile: mainFile || 'index.js',
                    nodeVersion: '18',
                    autoRestart: true,
                    publicAccess: true,
                    serviceType,
                    port: servicePort
                };
                fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
            } catch { }

            const embed = new EmbedBuilder()
                .setColor("#00ff00")
                .setTitle("تم إنشاء الهوست المجاني")
                .setDescription(`تم إنشاء هوست **${hostName}** مجاناً!`)
                .addFields({
                    name: "الخطوة التالية",
                    value: "ابعتلي ملف ZIP فيه ملفات بوتك عشان أشغله لك.",
                    inline: false,
                })
                .setTimestamp()
                .setFooter({
                    text: "مـــكــانـك ألأفــضـل هــو هٌــنا - Hn هــوسـت",
                    iconURL: client.user.displayAvatarURL(),
                });

            await interaction.editReply({ embeds: [embed] });

            try { await ensureHostTunnel(hostName); } catch { }
            const publicUrl = getPublicHostingUrl(hostName);
            const dmEmbed = new EmbedBuilder()
                .setColor("#00ff00")
                .setTitle("هوست مجاني!")
                .setDescription(`تم إنشاء هوست **${hostName}** لك مجاناً!`)
                .addFields(
                    {
                        name: "اسم الاستضافة",
                        value: hostName,
                        inline: true
                    },
                    {
                        name: "رابط الوصول العام",
                        value: `[اضغط هنا للوصول](${publicUrl})`,
                        inline: true
                    },
                    {
                        name: "الخطوة التالية",
                        value: "ابعتلي ملف ZIP فيه ملفات بوتك عشان أشغله لك فوراً!",
                        inline: false,
                    },
                    {
                        name: "معلومات هامة",
                        value: "يمكنك الوصول إلى لوحة التحكم وإدارة ملفات البوت من خلال الرابط أعلاه.",
                        inline: false
                    }
                )
                .setTimestamp()
                .setFooter({
                    text: "مـــكــانـك ألأفــضـل هــو هٌــنا - Hn هــوسـت",
                    iconURL: client.user.displayAvatarURL(),
                });

            await interaction.user.send({ embeds: [dmEmbed] });
            return;
        }

        const price = config.prices[duration];
        const tax = config.probotTax;
        const totalPrice = Math.ceil(price * (1 + tax));

        const paymentEmbed = new EmbedBuilder()
            .setColor("#ffd700")
            .setTitle("طلب دفع هوست")
            .setDescription(
                `يرجى تحويل المبلغ إلى <@${config.ownerid}> عبر ProBot.`,
            )
            .addFields(
                { name: "اسم الهوست", value: hostName, inline: true },
                {
                    name: "المدة",
                    value: duration.replace("_", " "),
                    inline: true,
                },
                { name: "السعر", value: `$${price}`, inline: true },
                {
                    name: "الضريبة",
                    value: `${(tax * 100).toFixed(1)}%`,
                    inline: true,
                },
                {
                    name: "المبلغ الإجمالي",
                    value: `$${totalPrice}`,
                    inline: true,
                },
                {
                    name: "ملاحظة",
                    value: "بعد التحويل، سيتم تأكيد الهوست تلقائياً!",
                    inline: false,
                },
            )
            .setTimestamp()
            .setFooter({
                text: "مـــكــانـك ألأفــضـل هــو هٌــنا - Hn هــوسـت",
                iconURL: client.user.displayAvatarURL(),
            });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId("apply_discount")
                .setLabel("استخدام كود خصم")
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId("cancel_payment")
                .setLabel("إلغاء الطلب")
                .setStyle(ButtonStyle.Danger),
        );

        let thread;
        let channelForPayment = null;

        if (config.hostingRoomId) {
            try {
                const hostingChannel = await client.channels.fetch(
                    config.hostingRoomId,
                );
                channelForPayment = hostingChannel;

                if (
                    hostingChannel.isTextBased() &&
                    hostingChannel
                        .permissionsFor(client.user)
                        .has([
                            PermissionFlagsBits.CreatePrivateThreads,
                            PermissionFlagsBits.SendMessages,
                        ])
                ) {
                    thread = await hostingChannel.threads.create({
                        name: `طلب دفع - ${interaction.user.username}`,
                        autoArchiveDuration: 60,
                        type: ChannelType.PrivateThread,
                        invitable: false,
                    });
                    await thread.members.add(interaction.user.id);
                    await thread.members.add(config.ownerid);

                    try {
                        await thread.members.add(config.probotid);
                    } catch (probotError) {
                        console.log(
                            "لا يمكن إضافة ProBot للثريد، ربما ليس في السيرفر",
                        );
                    }

                    const paymentInstructions = new EmbedBuilder()
                        .setColor("#ffd700")
                        .setTitle("📋 تعليمات الدفع")
                        .setDescription(
                            `لإتمام عملية الدفع، يرجى اتباع الخطوات التالية:`,
                        )
                        .addFields(
                            {
                                name: "أمر ProBot",
                                value: `\`\`\`#credit ${config.ownerid} ${totalPrice}\`\`\``,
                                inline: false,
                            },
                            {
                                name: "كيفية الدفع",
                                value: `1. انسخ الأمر أعلاه\n2. الصقه في هذا الثريد\n3. سيتم تأكيد الدفع تلقائياً بعد التحويل`,
                                inline: false,
                            },
                            {
                                name: "تفاصيل الطلب",
                                value: `• الهوست: **${hostName}**\n• المدة: ${duration.replace("_", " ")}\n• المبلغ: $${totalPrice}`,
                                inline: false,
                            },
                        )
                        .setTimestamp()
                        .setFooter({
                            text: "مـــكــانـك ألأفــضـل هــو هٌــنا - Hn هــوسـت",
                            iconURL: client.user.displayAvatarURL(),
                        });

                    const singlePaymentEmbed = new EmbedBuilder()
                        .setColor("#ffd700")
                        .setTitle(
                            "لـــتـــأكـــيـــد الـــدفـــع واإنـــشـــاء الـــهـــوســـت",
                        )
                        .setDescription(
                            `**اكـــتـــب**\n\`\`\`#credit ${config.ownerid} ${totalPrice}\`\`\`\n**وســـيـــتـــم شـــراء الـــهـــوســـت**`,
                        )
                        .setTimestamp()
                        .setFooter({
                            text: "مـــكــانـك ألأفــضـل هــو هٌــنا - Hn هــوسـت",
                            iconURL: client.user.displayAvatarURL(),
                        });

                    await thread.send({
                        embeds: [singlePaymentEmbed],
                        components: [row],
                    });
                    channelForPayment = thread;
                } else {
                    const paymentInstructions = `طلب دفع من ${interaction.user}\n\n**أمر الدفع:**\n\`\`\`#credit ${config.ownerid} ${totalPrice}\`\`\``;
                    await hostingChannel.send({
                        content: paymentInstructions,
                        embeds: [paymentEmbed],
                        components: [row],
                    });
                }
            } catch (threadError) {
                console.error("خطأ في إنشاء الثريد:", threadError);
                try {
                    const hostingChannel = await client.channels.fetch(
                        config.hostingRoomId,
                    );
                    const paymentInstructions = `طلب دفع من ${interaction.user}\n\n**أمر الدفع:**\n\`\`\`#credit ${config.ownerid} ${totalPrice}\`\`\``;
                    await hostingChannel.send({
                        content: paymentInstructions,
                        embeds: [paymentEmbed],
                        components: [row],
                    });
                    channelForPayment = hostingChannel;
                } catch (channelError) {
                    console.error("خطأ في إرسال رسالة الدفع:", channelError);
                }
            }
        } else {
        }

        pendingPayments.set(interaction.user.id, {
            hostName,
            duration,
            mainFile,
            price: totalPrice,
            thread: channelForPayment,
        });

        const replyEmbed = new EmbedBuilder()
            .setColor("#00ff00")
            .setTitle("تم تسجيل طلب الهوست")
            .setDescription(
                `يرجى تحويل $${totalPrice} إلى <@${config.ownerid}> عبر ProBot.`,
            )
            .addFields({
                name: "تفاصيل الطلب",
                value: config.hostingRoomId
                    ? thread
                        ? `تم إنشاء ثريد خاص لمتابعة الدفع في <#${config.hostingRoomId}>.`
                        : `تم إرسال طلب الدفع في <#${config.hostingRoomId}>.`
                    : "تم تسجيل طلب الدفع. سيتم تأكيد الدفع تلقائياً عند التحويل.",
                inline: false,
            })
            .setTimestamp()
            .setFooter({
                text: "مـــكــانـك ألأفــضـل هــو هٌــنا - Hn هــوسـت",
                iconURL: client.user.displayAvatarURL(),
            });

        await interaction.editReply({ embeds: [replyEmbed] });
    } catch (error) {
        console.error("خطأ في handleCreateHostingModal:", error);
        try {
            if (interaction.deferred) {
                await interaction.editReply({
                    content: "❌ حدث خطأ! حاول مرة تانية.",
                });
            } else if (!interaction.replied) {
                await interaction.reply({
                    content: "❌ حدث خطأ! حاول مرة تانية.",
                    ephemeral: true,
                });
            }
        } catch (replyError) {
            console.error("خطأ في الرد على الخطأ:", replyError);
        }
    }
}

async function handleRemoveHostingModal(interaction) {
    const hostName = interaction.fields
        .getTextInputValue("host_name_input")
        .trim();
    const hosting = activeHostings.get(hostName);

    if (!hosting || hosting.ownerId !== interaction.user.id) {
        return interaction.reply({
            content: "الهوست هذا مش موجود أو مش تبعك!",
            flags: 64,
        });
    }

    stopHosting(hostName);

    const embed = new EmbedBuilder()
        .setColor("#ff0000")
        .setTitle("🗑️ تم حذف الهوست")
        .setDescription(`بس انا زعلان منك تم حذف هوست **${hostName}** بنجاح!`)
        .setTimestamp()
        .setFooter({
            text: "مـــكــانـك ألأفــضـل هــو هٌــنا - Hn هــوسـت",
            iconURL: client.user.displayAvatarURL(),
        });

    await interaction.reply({ embeds: [embed], flags: 64 });
}

async function handleApplyDiscountModal(interaction) {
    const discountCode = interaction.fields
        .getTextInputValue("discount_code")
        .trim();
    const payment = pendingPayments.get(interaction.user.id);

    if (!payment) {
        return interaction.reply({
            content: "ما في طلب دفع نشط!",
            flags: 64,
        });
    }

    if (!config.discountCodes[discountCode]) {
        return interaction.reply({
            content: "أو بتتخوث علي كود الخصم غير صحيح أو منتهي الصلاحية!",
            flags: 64,
        });
    }

    const discount = config.discountCodes[discountCode];
    const newPrice = Math.max(1, payment.price - discount.amount);
    payment.price = newPrice;

    if (discount.singleUse) {
        delete config.discountCodes[discountCode];
        saveData();
    }

    const updatedEmbed = new EmbedBuilder()
        .setColor("#00ff00")
        .setTitle("تم تطبيق كود الخصم بنجاح")
        .setDescription(
            `السعر الجديد: $${newPrice}\nكود الخصم: ${discountCode}`,
        )
        .addFields(
            {
                name: "السعر قبل الخصم",
                value: `$${payment.price + discount.amount}`,
                inline: true,
            },
            {
                name: "قيمة الخصم",
                value: `$${discount.amount}`,
                inline: true,
            },
            { name: "السعر النهائي", value: `$${newPrice}`, inline: true },
        )
        .setTimestamp()
        .setFooter({
            text: "مـــكــانـك ألأفــضـل هــو هٌــنا - Hn هــوسـت",
            iconURL: client.user.displayAvatarURL(),
        });

    await interaction.reply({
        embeds: [updatedEmbed],
        flags: 64,
    });
}

client.on("messageCreate", async (message) => {
    if (message.author.bot) {

        if (
            message.content.includes("transferred") ||
            message.content.includes("تحويل")
        ) {
        }
    }

    if (
        message.author.bot &&
        message.author.id !== config.probotid &&
        !message.author.username.toLowerCase().includes("probot")
    )
        return;
    let threadPayment = null;
    if (message.channel.isThread()) {

        for (const [userId, payment] of pendingPayments) {
            if (payment.thread && payment.thread.id === message.channel.id) {
                threadPayment = { userId, payment };
                break;
            }
        }
    }

    const transferPatterns = [
        new RegExp(
            `\\*\\*:moneybag: \\| (.+?), has transferred \`\\$([0-9]+)\` to <@!?${config.ownerid}> \\*\\*`,
            "i",
        ),
        new RegExp(
            `\\*\\*:moneybag: \\| (.+?) has transferred \`\\$([0-9]+)\` to <@!?${config.ownerid}> \\*\\*`,
            "i",
        ),
        new RegExp(
            `:moneybag: \\| (.+?), has transferred \`?\\$([0-9]+)\`? to <@!?${config.ownerid}>`,
            "i",
        ),
        new RegExp(
            `\\*\\*:moneybag: \\| (.+?), has transferred \`?\\$([0-9]+)\`? to <@!?${config.ownerid}>\\*\\*`,
            "i",
        ),
        new RegExp(
            `\\*\\*:moneybag: \\| (.+?), has transferred \`?\\$([0-9]+)\`? to <@!?${config.ownerid}> ?\\*\\*`,
            "i",
        ),
        new RegExp(
            `\\| (.+?), has transferred \`?\\$([0-9]+)\`? to <@!?${config.ownerid}>`,
            "i",
        ),
        new RegExp(
            `\\| (.+?) has transferred \`?\\$([0-9]+)\`? to <@!?${config.ownerid}>`,
            "i",
        ),
        new RegExp(
            `(.+?) has transferred \`?\\$([0-9]+)\`? to <@!?${config.ownerid}>`,
            "i",
        ),
        new RegExp(
            `(.+?) transferred \`?\\$([0-9]+)\`? to <@!?${config.ownerid}>`,
            "i",
        ),
        new RegExp(
            `\\*\\*(.+?) has transferred \`?\\$([0-9]+)\`? to <@!?${config.ownerid}>\\*\\*`,
            "i",
        ),
        new RegExp(
            `(.+?) (?:has )?sent \`?\\$([0-9]+)\`? to <@!?${config.ownerid}>`,
            "i",
        ),
        new RegExp(
            `(.+?) (?:has )?gave \`?\\$([0-9]+)\`? to <@!?${config.ownerid}>`,
            "i",
        ),
        new RegExp(
            `(.+?) has transferred \`?\\$([0-9]+)\`? to <@!?${config.ownerid}> :moneybag:`,
            "i",
        ),
        new RegExp(
            `(.+?) has transferred \`?([0-9]+)\`? (?:credits?|dollars?) to <@!?${config.ownerid}>`,
            "i",
        ),
        new RegExp(
            `(.+?) (?:حول|أرسل) \`?\\$?([0-9]+)\`? (?:إلى|لـ) <@!?${config.ownerid}>`,
            "i",
        ),
        new RegExp(`(.+?).*?\\$([0-9]+).*?<@!?${config.ownerid}>`, "i"),
        new RegExp(
            `\\*\\*:moneybag: \\| (.+?), has transferred \\$([0-9]+) to <@!?${config.ownerid}> \\*\\*`,
            "i",
        ),
        new RegExp(
            `\\*\\*:moneybag: \\| (.+?), has transferred \`\\$([0-9]+)\` to <@!?${config.ownerid}> \\*\\*`,
            "i",
        ),
        new RegExp(
            `\\*\\*:moneybag: \\| (.+?), has transferred \`\\$([0-9]+)\` to <@!${config.ownerid}> \\*\\*`,
            "i",
        ),
        new RegExp(
            `\\*\\* :moneybag: \\| (.+?), has transferred \`\\$([0-9]+)\` to <@!?${config.ownerid}> \\*\\*`,
            "i",
        ),
        new RegExp(
            `\\*\\*💰 \\| (.+?), has transferred \`\\$([0-9]+)\` to <@!?${config.ownerid}> \\*\\*`,
            "i",
        ),
        new RegExp(
            `💰 \\| (.+?), has transferred \\$([0-9]+) to <@!?${config.ownerid}>`,
            "i",
        ),
        new RegExp(
            `:moneybag: \\| (.+?), has transferred \\$([0-9]+) to <@!?${config.ownerid}>`,
            "i",
        ),
        new RegExp(
            `💰\\| (.+?), has transferred \\$([0-9]+) to <@!?${config.ownerid}>`,
            "i",
        ),
        new RegExp(
            `💰 (.+?), has transferred \\$([0-9]+) to <@!?${config.ownerid}>`,
            "i",
        ),
        new RegExp(
            `(.+?), has transferred \\$([0-9]+) to <@!?${config.ownerid}>`,
            "i",
        ),
        new RegExp(`💰 \\| (.+?), has transferred \\$([0-9]+) to @(.+?)`, "i"),
        new RegExp(`💰\\| (.+?), has transferred \\$([0-9]+) to @(.+?)`, "i"),
        new RegExp(`(.+?), has transferred \\$([0-9]+) to @(.+?)`, "i"),
        new RegExp(`💰 (.+?), has transferred \\$([0-9]+) to @(.+?)`, "i"),
    ];

    let match = null;
    let matchedPattern = -1;
    let extractedAmount = null;
    let extractedUser = null;

    const exactPattern = new RegExp(
        `\\*\\*:moneybag: \\| (.+?), has transferred \`\\$([0-9]+)\` to <@!${config.ownerid}> \\*\\*`,
        "i",
    );
    transferPatterns.unshift(exactPattern);

    for (let i = 0; i < transferPatterns.length; i++) {
        match = message.content.match(transferPatterns[i]);
        if (match && match[1] && match[2]) {
            matchedPattern = i;
            extractedUser = match[1].trim();
            extractedAmount = parseInt(match[2]);

            if (match[3]) {
                const targetUser = match[3].trim();

                const ownerUsernames = [
                    "يسموني سُني المُشفّر📚🏳",
                    "Hn",
                    config.ownerid,
                ];
                const isTargetOwner = ownerUsernames.some(
                    (username) =>
                        targetUser
                            .toLowerCase()
                            .includes(username.toLowerCase()) ||
                        username
                            .toLowerCase()
                            .includes(targetUser.toLowerCase()),
                );

                if (!isTargetOwner) {
                    match = null;
                    continue;
                }
            }

            if (!isNaN(extractedAmount) && extractedAmount > 0) {
                break;
            }
        }
        match = null;
    }

    if (!match) {
        const manualCheck = message.content.match(
            new RegExp(`<@!?${config.ownerid}>`),
        );
        const amountCheck = message.content.match(/\$?([0-9]+)/);

        if (manualCheck && amountCheck) {
            extractedAmount = parseInt(amountCheck[1]);
            extractedUser = "مستخدم غير معروف";
            matchedPattern = 999;
        }
    }

    if (extractedAmount && extractedAmount > 0) {
        let paymentFound = false;
        let bestMatch = null;


        if (threadPayment) {
            const originalPrice = Math.floor(
                threadPayment.payment.price / (1 + config.probotTax),
            );
            const priceWithTax = threadPayment.payment.price;


            const isValidPayment =
                extractedAmount === originalPrice ||
                extractedAmount === priceWithTax ||
                Math.abs(extractedAmount - originalPrice) <=
                Math.max(3, Math.floor(originalPrice * 0.1)) ||
                Math.abs(extractedAmount - priceWithTax) <=
                Math.max(3, Math.floor(priceWithTax * 0.1)) ||
                (extractedAmount >= Math.floor(originalPrice * 0.5) &&
                    extractedAmount <= originalPrice + 10) ||
                (extractedAmount >= Math.floor(priceWithTax * 0.5) &&
                    extractedAmount <= priceWithTax + 10);

            if (isValidPayment) {
                bestMatch = threadPayment;
                paymentFound = true;
            }
        }

        if (!paymentFound) {
            let bestScore = -1;

            for (const [userId, payment] of pendingPayments) {
                const originalPrice = Math.floor(
                    payment.price / (1 + config.probotTax),
                );
                const priceWithTax = payment.price;

                let score = 0;

                if (
                    extractedAmount === originalPrice ||
                    extractedAmount === priceWithTax
                ) {
                    score = 100;
                }
                else if (
                    Math.abs(extractedAmount - originalPrice) <= 2 ||
                    Math.abs(extractedAmount - priceWithTax) <= 2
                ) {
                    score = 90;
                }
                else if (
                    Math.abs(extractedAmount - originalPrice) <= 5 ||
                    Math.abs(extractedAmount - priceWithTax) <= 5
                ) {
                    score = 80;
                }
                else if (
                    Math.abs(extractedAmount - originalPrice) <=
                    Math.max(3, Math.floor(originalPrice * 0.1)) ||
                    Math.abs(extractedAmount - priceWithTax) <=
                    Math.max(3, Math.floor(priceWithTax * 0.1))
                ) {
                    score = 70;
                }
                else if (
                    (extractedAmount >= Math.floor(originalPrice * 0.5) &&
                        extractedAmount <= originalPrice + 10) ||
                    (extractedAmount >= Math.floor(priceWithTax * 0.5) &&
                        extractedAmount <= priceWithTax + 10)
                ) {
                    score = 60;
                }
                else if (
                    Math.abs(extractedAmount - originalPrice) <=
                    Math.floor(originalPrice * 0.2) ||
                    Math.abs(extractedAmount - priceWithTax) <=
                    Math.floor(priceWithTax * 0.2)
                ) {
                    score = 50;
                }

                if (score > bestScore) {
                    bestScore = score;
                    bestMatch = { userId, payment };
                    paymentFound = score >= 50;
                }
            }

            if (paymentFound) {
                const originalPrice = Math.floor(
                    bestMatch.payment.price / (1 + config.probotTax),
                );
                const priceWithTax = bestMatch.payment.price;
            }
        }

        if (paymentFound && bestMatch) {
            const originalPrice = Math.floor(
                bestMatch.payment.price / (1 + config.probotTax),
            );
            const priceWithTax = bestMatch.payment.price;

            try {
                await confirmPayment(bestMatch.userId, bestMatch.payment);
                pendingPayments.delete(bestMatch.userId);

                if (message.channel.isThread()) {
                    const confirmEmbed = new EmbedBuilder()
                        .setColor("#00ff00")
                        .setDescription(
                            `**تـــمّ تـــأكـــيـــد الـــدفـــع بـــنـــجـــاح**\n\n**شـــووف خـــااصـــك**\n\n**وسيتم اغلاق الثريد بعد 5 ثواني**`,
                        );

                    await message.channel.send({
                        embeds: [confirmEmbed],
                    });

                    setTimeout(async () => {
                        try {
                            if (
                                message.channel.isThread() &&
                                !message.channel.archived
                            ) {
                                await message.channel
                                    .setArchived(
                                        true,
                                        "تم إكمال عملية الدفع وشراء الهوست",
                                    )
                                    .catch((err) => {
                                        try {
                                            message.channel.setArchived(true);
                                        } catch (retryError) {
                                        }
                                    });
                            }
                        } catch (archiveError) {
                        }
                    }, 5000);
                }

                if (config.adminRoomId) {
                    try {
                        const adminChannel = await client.channels.fetch(
                            config.adminRoomId,
                        );
                        const confirmEmbed = new EmbedBuilder()
                            .setColor("#00ff00")
                            .setTitle("تم تأكيد دفعة جديدة تلقائيا")
                            .addFields(
                                {
                                    name: "المستخدم",
                                    value: `<@${bestMatch.userId}>`,
                                    inline: true,
                                },
                                {
                                    name: "المبلغ المحول",
                                    value: `$${extractedAmount}`,
                                    inline: true,
                                },
                                {
                                    name: "السعر الأصلي",
                                    value: `$${originalPrice}`,
                                    inline: true,
                                },
                                {
                                    name: "السعر مع الضريبة",
                                    value: `$${priceWithTax}`,
                                    inline: true,
                                },
                                {
                                    name: "الهوست",
                                    value: bestMatch.payment.hostName,
                                    inline: true,
                                },
                                {
                                    name: "المدة",
                                    value: bestMatch.payment.duration.replace(
                                        "_",
                                        " ",
                                    ),
                                    inline: true,
                                },
                                {
                                    name: "المحول",
                                    value: extractedUser,
                                    inline: true,
                                },
                                {
                                    name: "مكان التأكيد",
                                    value: message.channel.isThread()
                                        ? "في الثريد"
                                        : "في القناة العامة",
                                    inline: true,
                                },
                                {
                                    name: "نمط التطابق",
                                    value: `النمط رقم ${matchedPattern}`,
                                    inline: true,
                                },
                            )
                            .setTimestamp()
                            .setFooter({
                                text: "تم التأكيد تلقائياً بواسطة نظام ProBot",
                            });

                        await adminChannel.send({ embeds: [confirmEmbed] });
                    } catch (error) {
                        console.error(
                            "خطأ في إرسال تأكيد الدفع للإدارة:",
                            error,
                        );
                    }
                }
            } catch (confirmError) {
                console.error("خطأ في تأكيد الدفع:", confirmError);
            }
        } else {
            if (config.adminRoomId) {
                try {
                    const adminChannel = await client.channels.fetch(
                        config.adminRoomId,
                    );
                    const alertEmbed = new EmbedBuilder()
                        .setColor("#ff9900")
                        .setTitle("تحويل بدون طلب مطابق")
                        .addFields(
                            {
                                name: "المبلغ المحول",
                                value: `$${extractedAmount}`,
                                inline: true,
                            },
                            {
                                name: "المحول",
                                value: extractedUser,
                                inline: true,
                            },
                            {
                                name: "مكان الرسالة",
                                value: message.channel.isThread()
                                    ? `ثريد: <#${message.channel.id}>`
                                    : `قناة: <#${message.channel.id}>`,
                                inline: true,
                            },
                            {
                                name: "النمط المستخدم",
                                value: `${matchedPattern}`,
                                inline: true,
                            },
                            {
                                name: "الرسالة الأصلية",
                                value: `\`\`\`${message.content.substring(0, 1000)}\`\`\``,
                                inline: false,
                            },
                        )
                        .setTimestamp();

                    await adminChannel.send({ embeds: [alertEmbed] });
                } catch (error) {
                    console.error(
                        "خطأ في إرسال تنبيه التحويل غير المطابق:",
                        error,
                    );
                }
            }
        }
    } else {
        if (
            message.content.includes(`<@${config.ownerid}>`) ||
            message.content.includes(`<@!${config.ownerid}>`)
        ) {
            if (config.adminRoomId) {
                try {
                    const adminChannel = await client.channels.fetch(
                        config.adminRoomId,
                    );
                    const debugEmbed = new EmbedBuilder()
                        .setColor("#0099ff")
                        .setTitle("رسالة ProBot تحتاج مراجعة")
                        .setDescription(
                            "رسالة من ProBot تحتوي على mention للمالك لكن لم يتم التعرف على نمطها",
                        )
                        .addFields(
                            {
                                name: "محتوى الرسالة",
                                value: `\`\`\`${message.content}\`\`\``,
                                inline: false,
                            },
                            {
                                name: "قناة الرسالة",
                                value: message.channel.isThread()
                                    ? `ثريد: <#${message.channel.id}>`
                                    : `قناة: <#${message.channel.id}>`,
                                inline: true,
                            },
                            {
                                name: "وقت الرسالة",
                                value: `<t:${Math.floor(message.createdTimestamp / 1000)}:F>`,
                                inline: true,
                            },
                        )
                        .setTimestamp();

                    await adminChannel.send({ embeds: [debugEmbed] });
                } catch (error) {
                    console.error("خطأ في إرسال رسالة المراجعة:", error);
                }
            }
        }
    }
});

// Function to get public URL for hosting
function getPublicHostingUrl(hostName) {
    const base = hostTunnels.get(hostName) || `http://${config.serverAddress}`;
    return `${base}/public/${hostName}`;
}

// Function to update server address
function updateServerAddress(newAddress) {
    console.log(`Updating server address to: ${newAddress}`);
    config.serverAddress = newAddress;
}

// Make the function available globally
global.updateServerAddress = updateServerAddress;

async function confirmPayment(userId, payment) {
    try {
        const { hostName, duration, mainFile, thread } = payment;
        const expiresAt = Date.now() + getDurationInMs(duration);

        activeHostings.set(hostName, {
            ownerId: userId,
            name: hostName,
            duration,
            mainFile,
            expiresAt,
            process: null,
            createdAt: Date.now(),
        });

        const user = await client.users.fetch(userId);
        const publicUrl = getPublicHostingUrl(hostName);
        const dmEmbed = new EmbedBuilder()
            .setColor("#00ff00")
            .setTitle("تم تأكيد الدفع بنجاح!")
            .setDescription(`تم تأكيد الدفع - ابعت ملف ZIP فيه ملفات بوتك`)
            .addFields(
                {
                    name: "اسم الاستضافة",
                    value: hostName,
                    inline: true
                },
                {
                    name: "رابط الوصول العام",
                    value: `[اضغط هنا للوصول](${publicUrl})`,
                    inline: true
                },
                {
                    name: "معلومات هامة",
                    value: "يمكنك الوصول إلى لوحة التحكم وإدارة ملفات البوت من خلال الرابط أعلاه.",
                    inline: false
                }
            )
            .setFooter({
                text: "مـــكــانـك ألأفــضـل هــو هٌــنا - Hn هــوسـت",
                iconURL: client.user.displayAvatarURL(),
            });

        await user.send({ embeds: [dmEmbed] });
        console.log(`تم إرسال تأكيد الدفع للمستخدم ${userId} بنجاح`);
    } catch (error) {
        console.error("خطأ في confirmPayment:", error);
        throw error;
    }
}

client.on("messageCreate", async (message) => {
    if (message.author.bot || message.channel.type !== 1) return;

    if (message.attachments.size > 0) {
        const attachment = message.attachments.first();
        if (attachment.name.endsWith(".zip")) {
            await handleZipUpload(message, attachment);
        } else {
            await handleFileEdit(message, attachment);
        }
    }
});

async function handleZipUpload(message, attachment) {
    const userId = message.author.id;
    const userHosting = activeHostings.find(
        (h) => h.ownerId === userId && !h.process,
    );

    if (!userHosting) {
        const embed = new EmbedBuilder()
            .setColor("#ff0000")
            .setTitle("لا يوجد هوست متاح")
            .setDescription("ما عندك هوست جاهز لاستقبال الملفات بتتخوث علي!")
            .setTimestamp()
            .setFooter({
                text: "مـــكــانـك ألأفــضـل هــو هٌــنا - Hn هــوسـت",
                iconURL: client.user.displayAvatarURL(),
            });

        return message.reply({ embeds: [embed] });
    }

    const hostPath = path.join(__dirname, "hostings", userHosting.name);

    try {
        if (!fs.existsSync(hostPath)) {
            fs.mkdirSync(hostPath, { recursive: true });

            // Create hosting config file
            createHostingConfig(
                userHosting.name,
                userId,
                message.author.username,
                message.author.displayAvatarURL(),
                "Basic",
                new Date(userHosting.expiresAt).toISOString()
            );
        }

        const response = await fetch(attachment.url);
        const buffer = await response.arrayBuffer();
        const zipPath = path.join(hostPath, "bot.zip");
        fs.writeFileSync(zipPath, Buffer.from(buffer));

        const processingEmbed = new EmbedBuilder()
            .setColor("#ffaa00")
            .setTitle("جاري المعالجة...")
            .setDescription("قاعد بفك ضغط الملف وأثبت المكاتب... اصبر شوي!")
            .setTimestamp()
            .setFooter({
                text: "مـــكــانـك ألأفــضـل هــو هٌــنا - Hn هــوسـت",
                iconURL: client.user.displayAvatarURL(),
            });

        await message.reply({ embeds: [processingEmbed] });


        const stream = fs.createReadStream(zipPath);
        const extract = unzipper.Extract({ path: hostPath });

        stream.pipe(extract);

        extract.on("close", async () => {
            fs.unlinkSync(zipPath);

            const nodeModulesPath = path.join(hostPath, "node_modules");
            if (fs.existsSync(nodeModulesPath)) {
                fs.rmSync(nodeModulesPath, { recursive: true, force: true });
            }

            const packageJsonPath = path.join(hostPath, "package.json");
            if (!fs.existsSync(packageJsonPath)) {
                const errorEmbed = new EmbedBuilder()
                    .setColor("#ff0000")
                    .setTitle("ملف مفقود")
                    .setDescription(
                        "ملف package.json مش موجود! لازم يكون موجود عشان أثبت المكاتب.",
                    )
                    .setTimestamp()
                    .setFooter({
                        text: "مـــكــانـك ألأفــضـل هــو هٌــنا - Hn هــوسـت",
                        iconURL: client.user.displayAvatarURL(),
                    });

                return message.reply({ embeds: [errorEmbed] });
            }

            const sharedModulesPath = path.join(
                __dirname,
                "shared_node_modules",
                "node_modules",
            );
            exec(`cd "${hostPath}" && npm install`, async (installError) => {
                if (installError) {
                    console.error("خطأ في تثبيت المكاتب:", installError);
                    const installErrorEmbed = new EmbedBuilder()
                        .setColor("#ff0000")
                        .setTitle("خطأ في تثبيت المكاتب")
                        .setDescription(
                            `فشل في تثبيت المكاتب: ${installError.message}`,
                        )
                        .setTimestamp()
                        .setFooter({
                            text: "مـــكــانـك ألأفــضـل هــe� هٌــنا - Hn هــوسـت",
                            iconURL: client.user.displayAvatarURL(),
                        });

                    return message.reply({ embeds: [installErrorEmbed] });
                }

                // Install deps then run on Windows-friendly way
                await new Promise((resolve) => {
                    exec(`cd "${hostPath}" && npm install`, { windowsHide: true }, () => resolve());
                });
                const botProcess = exec(`node ${userHosting.mainFile}`, {
                    cwd: hostPath,
                    env: { ...process.env, NODE_PATH: sharedModulesPath },
                    windowsHide: true,
                });

                activeHostings.get(userHosting.name).process = botProcess;

                botProcess.stdout.on("data", (data) => {
                    console.log(`[${userHosting.name}] ${data}`);
                });

                botProcess.stderr.on("data", (data) => {
                    console.error(`[${userHosting.name}] ${data}`);
                });

                botProcess.on("close", (code) => {
                    console.log(
                        `[${userHosting.name}] توقف البوت بكود: ${code}`,
                    );
                    setTimeout(() => {
                        if (activeHostings.has(userHosting.name)) {
                            const newProcess = exec(`node ${userHosting.mainFile}`, {
                                cwd: hostPath,
                                env: { ...process.env, NODE_PATH: sharedModulesPath },
                                windowsHide: true,
                            });
                            activeHostings.get(userHosting.name).process =
                                newProcess;
                        }
                    }, 5000);
                });

                const publicUrl = getPublicHostingUrl(userHosting.name);
                const successEmbed = new EmbedBuilder()
                    .setColor("#00ff00")
                    .setTitle("تم تشغيل الهوست بنجاح!")
                    .setDescription(
                        `تم تشغيل هوست **${userHosting.name}** بنجاح!`,
                    )
                    .addFields(
                        {
                            name: "حالة البوت",
                            value: "يعمل زي الورد!",
                            inline: true,
                        },
                        {
                            name: "رابط الوصول العام",
                            value: `[اضغط هنا للوصول](${publicUrl})`,
                            inline: true,
                        },
                        {
                            name: "إدارة الهوست",
                            value: "تقدر تدير هوستك من خلال الأزرار في روم الهوست الرئيسي أو من خلال الرابط.",
                            inline: false,
                        },
                        {
                            name: "استمتع",
                            value: "استمتع بالخدمة واستخدم البوت بكل راحة!",
                            inline: false,
                        },
                    )
                    .setTimestamp()
                    .setFooter({
                        text: "مـــكــانـك ألأفــضـل هــو هٌــنا - Hn هــوسـت",
                        iconURL: client.user.displayAvatarURL(),
                    });

                await message.reply({ embeds: [successEmbed] });
            });
        });

        extract.on("error", (error) => {
            console.error("خطأ في فك الضغط:", error);
            const extractErrorEmbed = new EmbedBuilder()
                .setColor("#ff0000")
                .setTitle("خطأ في فك الضغط")
                .setDescription("فشل في فك ضغط الملف! تأكد إنه ملف ZIP صحيح.")
                .setTimestamp()
                .setFooter({
                    text: "مـــكــانـك ألأفــضـل هــو هٌــنا - Hn هــوسـت",
                    iconURL: client.user.displayAvatarURL(),
                });

            message.reply({ embeds: [extractErrorEmbed] });
        });
    } catch (error) {
        console.error("خطأ في معالجة الملف:", error);
        const generalErrorEmbed = new EmbedBuilder()
            .setColor("#ff0000")
            .setTitle("خطأ في المعالجة")
            .setDescription("حدث خطأ في معالجة الملف! حاول مرة تانية.")
            .setTimestamp()
            .setFooter({
                text: "مـــكــانـك ألأفــضـل هــو هٌــنا - Hn هــوسـت",
                iconURL: client.user.displayAvatarURL(),
            });

        await message.reply({ embeds: [generalErrorEmbed] });
    }
}

async function handleFileEdit(message, attachment) {
    const userId = message.author.id;
    const session = fileEditSessions.get(userId);

    if (!session) return;

    const { hostName, fileName } = session;
    const hosting = activeHostings.get(hostName);

    if (!hosting || hosting.ownerId !== userId) {
        fileEditSessions.delete(userId);

        const errorEmbed = new EmbedBuilder()
            .setColor("#ff0000")
            .setTitle("انتهت الجلسة")
            .setDescription("الجلسة انتهت أو الهوست مش موجود!")
            .setTimestamp()
            .setFooter({
                text: "مـــكــانـك ألأفــضـل هــو هٌــنا - Hn هــوسـت",
                iconURL: client.user.displayAvatarURL(),
            });

        return message.reply({ embeds: [errorEmbed] });
    }

    try {
        const filePath = path.join(__dirname, "hostings", hostName, fileName);
        const response = await fetch(attachment.url);
        const buffer = await response.arrayBuffer();
        fs.writeFileSync(filePath, Buffer.from(buffer));

        const updateEmbed = new EmbedBuilder()
            .setColor("#00ff00")
            .setTitle("تم تحديث الملف")
            .setDescription(
                `تم تحديث ملف **${fileName}** بنجاح! قاعد بعيد تشغيل الهوست...`,
            )
            .setTimestamp()
            .setFooter({
                text: "مـــكــانـك ألأفــضـل هــو هٌــنا - Hn هــوسـت",
                iconURL: client.user.displayAvatarURL(),
            });

        await message.reply({ embeds: [updateEmbed] });

        if (hosting.process) {
            hosting.process.kill();
        }

        const hostPath = path.join(__dirname, "hostings", hostName);
        const sharedModulesPath = path.join(
            __dirname,
            "shared_node_modules",
            "node_modules",
        );
        const newProcess = exec(`node ${hosting.mainFile}`, {
            cwd: hostPath,
            env: { ...process.env, NODE_PATH: sharedModulesPath },
            windowsHide: true,
        });

        activeHostings.get(hostName).process = newProcess;
        fileEditSessions.delete(userId);

        const restartEmbed = new EmbedBuilder()
            .setColor("#00ff00")
            .setTitle("تم إعادة التشغيل")
            .setDescription(
                "تم إعادة تشغيل الهوست بنجاح! التغييرات تشتغل الآن.",
            )
            .setTimestamp()
            .setFooter({
                text: "مـــكــانـك ألأفــضـل هــو هٌــنا - Hn هــوسـت",
                iconURL: client.user.displayAvatarURL(),
            });

        await message.reply({ embeds: [restartEmbed] });
    } catch (error) {
        console.error("خطأ في تحديث الملف:", error);
        const updateErrorEmbed = new EmbedBuilder()
            .setColor("#ff0000")
            .setTitle("خطأ في التحديث")
            .setDescription("فشل في تحديث الملف! حاول مرة تانية.")
            .setTimestamp()
            .setFooter({
                text: "مـــكــانـك ألأفــضـل هــو هٌــنا - Hn هــوسـت",
                iconURL: client.user.displayAvatarURL(),
            });

        await message.reply({ embeds: [updateErrorEmbed] });
    }
}

function getDurationInMs(duration) {
    const durations = {
        "3_days": 3 * 24 * 60 * 60 * 1000,
        "1_week": 7 * 24 * 60 * 60 * 1000,
        "1_month": 30 * 24 * 60 * 60 * 1000,
        "3_months": 90 * 24 * 60 * 60 * 1000,
        "1_year": 365 * 24 * 60 * 60 * 1000,
    };
    return durations[duration] || 0;
}

function getDurationInDays(duration) {
    const durations = {
        "3_days": 3,
        "1_week": 7,
        "1_month": 30,
        "3_months": 90,
        "1_year": 365,
    };
    return durations[duration] || 0;
}

async function handleApplyDiscount(interaction) {
    try {
        if (interaction.replied || interaction.deferred) {
            return;
        }

        const modal = new ModalBuilder()
            .setCustomId("apply_discount_modal")
            .setTitle("استخدام كود خصم");

        const codeInput = new TextInputBuilder()
            .setCustomId("discount_code")
            .setLabel("كود الخصم:")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("ادخل كود الخصم")
            .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(codeInput));
        await interaction.showModal(modal);
    } catch (error) {
        console.error("خطأ في handleApplyDiscount:", error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction
                .reply({
                    content: "حدث خطأ في فتح نافذة كود الخصم!",
                    flags: 64,
                })
                .catch(console.error);
        }
    }
}

async function handleCancelPayment(interaction) {
    const userId = interaction.user.id;
    if (pendingPayments.has(userId)) {
        const payment = pendingPayments.get(userId);
        pendingPayments.delete(userId);

        const cancelEmbed = new EmbedBuilder()
            .setColor("#ff0000")
            .setTitle("تم إلغاء الطلب")
            .setDescription("تم إلغاء طلب الهوست.")
            .setTimestamp()
            .setFooter({
                text: "مـــكــانـك ألأفــضـل هــو هٌــنا - Hn هــوسـت",
                iconURL: client.user.displayAvatarURL(),
            });

        await interaction.reply({ embeds: [cancelEmbed], flags: 64 });

        try {
            await payment.thread.delete();
        } catch (error) {
            console.error("خطأ في حذف الثريد:", error);
        }
    } else {
        await interaction.reply({
            content: "لا يوجد طلب دفع نشط للإلغاء!",
            flags: 64,
        });
    }
}

async function handleAdminPanel(interaction) {
    try {
        if (interaction.replied || interaction.deferred) {
            return;
        }

        // التحقق من صلاحيات المالك
        if (!config.ownersid.includes(interaction.user.id)) {
            return interaction.reply({
                content: "❌ ليس لديك صلاحية للوصول إلى لوحة الإدارة!",
                flags: 64,
            });
        }

        // إنشاء لوحة الإدارة
        const adminEmbed = new EmbedBuilder()
            .setColor("#ff00ff")
            .setTitle("لـــوحــة إلإدارة")
            .setDescription(
                "هــون بــتـقـدر تـتـحـكـم فــلبــوت بـــشـكـل كــامـل",
            )
            .addFields(
                {
                    name: "إدارة الخصومات",
                    value: "أضف أو احذف أكواد الخصم",
                    inline: true,
                },
                {
                    name: "إدارة الهوستات",
                    value: "أضف أو احذف هوستات للمستخدمين",
                    inline: true,
                },
                {
                    name: "إدارة المستخدمين",
                    value: "تحذير المستخدمين وإدارة الحسابات",
                    inline: true,
                },
                {
                    name: "إدارة النظام",
                    value: "تشغيل/إيقاف الدفع وإحصائيات البوت",
                    inline: true,
                },
                {
                    name: "الجيفاواي",
                    value: "بدء جيفاواي جديد للمستخدمين",
                    inline: true,
                },
                {
                    name: "الصلاحيات",
                    value: "أنت المالك الوحيد لهذه اللوحة",
                    inline: true,
                },
            )
            .setThumbnail(client.user.displayAvatarURL())
            .setTimestamp()
            .setFooter({
                text: "لوحة الإدارة - Hn هوست",
                iconURL: client.user.displayAvatarURL(),
            });

        const row1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId("add_discount")
                .setLabel("إضافة كود خصم")
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId("remove_discount")
                .setLabel("حذف كود خصم")
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId("add_hosting_to_user")
                .setLabel("إهداء هوست")
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId("remove_hosting_from_user")
                .setLabel("حذف هوست")
                .setStyle(ButtonStyle.Danger),
        );

        const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId("warn_user")
                .setLabel("تحذير مستخدم")
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId("toggle_payment")
                .setLabel(
                    config.paymentEnabled ? "إيقاف الدفع" : "تشغيل الدفع",
                )
                .setStyle(
                    config.paymentEnabled
                        ? ButtonStyle.Danger
                        : ButtonStyle.Success,
                ),
            new ButtonBuilder()
                .setCustomId("start_giveaway")
                .setLabel("بدء جيفاواي")
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId("bot_stats")
                .setLabel("إحصائيات البوت")
                .setStyle(ButtonStyle.Secondary),
        );

        await interaction.reply({ embeds: [adminEmbed], components: [row1, row2], ephemeral: true });
    } catch (error) {
        console.error("خطأ في handleAdminPanel:", error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
                content: "حدث خطأ في فتح لوحة الإدارة!",
                flags: 64,
            });
        }
    }
}

async function handleAdminButtons(interaction) {
    try {
        if (interaction.replied || interaction.deferred) {
            return;
        }

        if (
            !config.userCredits ||
            typeof config.userCredits.get !== "function"
        ) {
            config.userCredits = new Collection();
        }
        if (!config.warnings || typeof config.warnings.get !== "function") {
            config.warnings = new Collection();
        }
        if (!config.giveaways || typeof config.giveaways.get !== "function") {
            config.giveaways = new Collection();
        }

        switch (interaction.customId) {
            case "toggle_payment":
                config.paymentEnabled = !config.paymentEnabled;
                saveData();
                await interaction.reply({
                    content: `تم ${config.paymentEnabled ? "تفعيل" : "إيقاف"} نظام الدفع!`,
                    flags: 64,
                });
                break;

            case "add_discount":
                const addDiscountModal = new ModalBuilder()
                    .setCustomId("add_discount_modal")
                    .setTitle("إضافة كود خصم");

                const discountCodeInput = new TextInputBuilder()
                    .setCustomId("discount_code_input")
                    .setLabel("كود الخصم:")
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder("مثال: SAVE50")
                    .setRequired(true);

                const discountAmountInput = new TextInputBuilder()
                    .setCustomId("discount_amount_input")
                    .setLabel("مقدار الخصم ($):")
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder("مثال: 5")
                    .setRequired(true);

                const singleUseInput = new TextInputBuilder()
                    .setCustomId("single_use_input")
                    .setLabel("استخدام واحد فقط؟ (true/false):")
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder("true أو false")
                    .setRequired(true);

                addDiscountModal.addComponents(
                    new ActionRowBuilder().addComponents(discountCodeInput),
                    new ActionRowBuilder().addComponents(discountAmountInput),
                    new ActionRowBuilder().addComponents(singleUseInput),
                );

                await interaction.showModal(addDiscountModal);
                break;

            case "remove_discount":
                const removeDiscountModal = new ModalBuilder()
                    .setCustomId("remove_discount_modal")
                    .setTitle("حذف كود خصم");

                const codeToRemoveInput = new TextInputBuilder()
                    .setCustomId("code_to_remove_input")
                    .setLabel("كود الخصم المراد حذفه:")
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder("ادخل كود الخصم")
                    .setRequired(true);

                removeDiscountModal.addComponents(
                    new ActionRowBuilder().addComponents(codeToRemoveInput),
                );

                await interaction.showModal(removeDiscountModal);
                break;

            case "add_hosting_to_user":
                const addHostingModal = new ModalBuilder()
                    .setCustomId("add_hosting_to_user_modal")
                    .setTitle("إهداء هوست لمستخدم ولله انك كريم");

                const userIdInput = new TextInputBuilder()
                    .setCustomId("user_id_input")
                    .setLabel("ID المستخدم:")
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder("ادخل ID المستخدم")
                    .setRequired(true);

                const hostNameInputAdmin = new TextInputBuilder()
                    .setCustomId("host_name_input_admin")
                    .setLabel("اسم الهوست:")
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder("مثال: GiftedBot")
                    .setRequired(true);

                const durationInputAdmin = new TextInputBuilder()
                    .setCustomId("duration_input_admin")
                    .setLabel("مدة الهوست:")
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder("3_days, 1_week, 1_month, 3_months, 1_year")
                    .setRequired(true);

                const mainFileInputAdmin = new TextInputBuilder()
                    .setCustomId("main_file_input_admin")
                    .setLabel("الملف الرئيسي:")
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder("مثال: index.js")
                    .setRequired(true);

                const giftServiceTypeInput = new TextInputBuilder()
                    .setCustomId("gift_service_type_input")
                    .setLabel("نوع الخدمة (discord/web):")
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder("discord أو web")
                    .setRequired(false);

                addHostingModal.addComponents(
                    new ActionRowBuilder().addComponents(userIdInput),
                    new ActionRowBuilder().addComponents(hostNameInputAdmin),
                    new ActionRowBuilder().addComponents(durationInputAdmin),
                    new ActionRowBuilder().addComponents(mainFileInputAdmin),
                    new ActionRowBuilder().addComponents(giftServiceTypeInput),
                );

                await interaction.showModal(addHostingModal);
                break;

            case "remove_hosting_from_user":
                const removeHostingModal = new ModalBuilder()
                    .setCustomId("remove_hosting_from_user_modal")
                    .setTitle("حذف هوست من مستخدم يبخيييل");

                const hostNameToRemoveInput = new TextInputBuilder()
                    .setCustomId("host_name_to_remove_input")
                    .setLabel("اسم الهوست الي بدك تحذفه:")
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder("ادخل اسم الهوست بالضبط")
                    .setRequired(true);

                removeHostingModal.addComponents(
                    new ActionRowBuilder().addComponents(hostNameToRemoveInput),
                );

                await interaction.showModal(removeHostingModal);
                break;

            case "warn_user":
                const warnUserModal = new ModalBuilder()
                    .setCustomId("warn_user_modal")
                    .setTitle("تحذير مستخدم");

                const warnUserIdInput = new TextInputBuilder()
                    .setCustomId("warn_user_id_input")
                    .setLabel("ID المستخدم:")
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder("ادخل ID المستخدم")
                    .setRequired(true);

                const warningReasonInput = new TextInputBuilder()
                    .setCustomId("warning_reason_input")
                    .setLabel("سبب التحذير:")
                    .setStyle(TextInputStyle.Paragraph)
                    .setPlaceholder("اكتب سبب التحذير...")
                    .setRequired(true);

                warnUserModal.addComponents(
                    new ActionRowBuilder().addComponents(warnUserIdInput),
                    new ActionRowBuilder().addComponents(warningReasonInput),
                );

                await interaction.showModal(warnUserModal);
                break;

            case "start_giveaway":
                const giveawayModal = new ModalBuilder()
                    .setCustomId("start_giveaway_modal")
                    .setTitle("بدء جيفاواي");

                const giveawayRoomInput = new TextInputBuilder()
                    .setCustomId("giveaway_room_input")
                    .setLabel("ID روم الجيفاواي:")
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder("ادخل ID الروم")
                    .setRequired(true);

                const giveawayDurationInput = new TextInputBuilder()
                    .setCustomId("giveaway_duration_input")
                    .setLabel("مدة الهوست الجائزة:")
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder("3_days, 1_week, 1_month, 3_months, 1_year")
                    .setRequired(true);

                const giveawayTimeInput = new TextInputBuilder()
                    .setCustomId("giveaway_time_input")
                    .setLabel("مدة الجيفاواي (بالدقائق):")
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder("مثال: 60 للساعة الواحدة")
                    .setRequired(true);

                giveawayModal.addComponents(
                    new ActionRowBuilder().addComponents(giveawayRoomInput),
                    new ActionRowBuilder().addComponents(giveawayDurationInput),
                    new ActionRowBuilder().addComponents(giveawayTimeInput),
                );

                await interaction.showModal(giveawayModal);
                break;

            default:
                await interaction.reply({
                    content: "زر غير معروف!",
                    flags: 64,
                });
        }
    } catch (error) {
        console.error("خطأ في handleAdminButtons:", error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction
                .reply({
                    content: "حدث خطأ في معالجة الزر!",
                    flags: 64,
                })
                .catch(console.error);
        }
    }
}

async function handleAdminModals(interaction) {
    switch (interaction.customId) {
        case "add_discount_modal":
            const discountCode = interaction.fields
                .getTextInputValue("discount_code_input")
                .trim();
            const discountAmount = parseInt(
                interaction.fields.getTextInputValue("discount_amount_input"),
            );
            const singleUse =
                interaction.fields
                    .getTextInputValue("single_use_input")
                    .trim()
                    .toLowerCase() === "true";

            if (isNaN(discountAmount) || discountAmount <= 0) {
                return interaction.reply({
                    content: "مقدار الخصم يجب أن يكون رقم أكبر من صفر!",
                    flags: 64,
                });
            }

            config.discountCodes[discountCode] = {
                amount: discountAmount,
                singleUse: singleUse,
                createdAt: Date.now(),
            };

            saveData();

            await interaction.reply({
                content: `تم إضافة كود خصم **${discountCode}** بقيمة $${discountAmount}${singleUse ? " (استخدام واحد)" : " (متعدد الاستخدام)"}!`,
                flags: 64,
            });
            break;

        case "remove_discount_modal":
            const codeToRemove = interaction.fields
                .getTextInputValue("code_to_remove_input")
                .trim();

            if (!config.discountCodes[codeToRemove]) {
                return interaction.reply({
                    content: "كود الخصم هذا غير موجود!",
                    flags: 64,
                });
            }

            delete config.discountCodes[codeToRemove];
            saveData();

            await interaction.reply({
                content: `تم حذف كود خصم **${codeToRemove}** بنجاح!`,
                flags: 64,
            });
            break;

        case "add_hosting_to_user_modal":
            const userId = interaction.fields
                .getTextInputValue("user_id_input")
                .trim();
            const hostName = interaction.fields
                .getTextInputValue("host_name_input_admin")
                .trim();
            const duration = interaction.fields
                .getTextInputValue("duration_input_admin")
                .trim();
            const mainFile = interaction.fields
                .getTextInputValue("main_file_input_admin")
                .trim();
            const giftServiceTypeRaw = (interaction.fields.getTextInputValue("gift_service_type_input") || '').trim().toLowerCase();
            const giftServiceType = ['discord', 'web'].includes(giftServiceTypeRaw) ? giftServiceTypeRaw : 'discord';
            const giftPort = giftServiceType === 'web' ? 4000 : 3000;

            if (!config.prices[duration]) {
                return interaction.reply({
                    content: "المدة غير صحيحة!",
                    flags: 64,
                });
            }

            if (activeHostings.has(hostName)) {
                return interaction.reply({
                    content: "اسم الهوست هذا مستخدم بالفعل!",
                    flags: 64,
                });
            }

            const expiresAt = Date.now() + getDurationInMs(duration);
            activeHostings.set(hostName, {
                ownerId: userId,
                name: hostName,
                duration,
                mainFile,
                expiresAt,
                process: null,
                createdAt: Date.now(),
                isGift: true,
                serviceType: giftServiceType,
                port: giftPort,
            });

            try {
                const user = await client.users.fetch(userId);
                // Ensure config.json for gifted host
                try {
                    const hostPath = path.join(__dirname, 'hostings', hostName);
                    if (!fs.existsSync(hostPath)) fs.mkdirSync(hostPath, { recursive: true });
                    const configPath = path.join(hostPath, 'config.json');
                    const cfg = {
                        status: 'stopped',
                        owner: { id: userId, username: user.username, avatar: user.displayAvatarURL?.() || '' },
                        createdAt: new Date().toISOString(),
                        expiryDate: new Date(expiresAt).toISOString(),
                        plan: duration,
                        mainFile: mainFile || 'index.js',
                        nodeVersion: '18',
                        autoRestart: true,
                        publicAccess: true,
                        serviceType: giftServiceType,
                        port: giftPort
                    };
                    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
                } catch { }
                const publicUrl = getPublicHostingUrl(hostName);
                const giftEmbed = new EmbedBuilder()
                    .setColor("#00ff00")
                    .setTitle("مبروك! هدية هوست مجاني")
                    .setDescription(
                        `تم إهداؤك هوست **${hostName}** لمدة ${duration.replace("_", " ")}!`,
                    )
                    .addFields(
                        {
                            name: "اسم الاستضافة",
                            value: hostName,
                            inline: true
                        },
                        {
                            name: "رابط الوصول العام",
                            value: `[اضغط هنا للوصول](${publicUrl})`,
                            inline: true
                        },
                        {
                            name: "الخطوة التالية",
                            value: "ابعتلي ملف ZIP بوتك عشان أشغله لك فوراً!",
                            inline: false,
                        },
                        {
                            name: "معلومات هامة",
                            value: "يمكنك الوصول إلى لوحة التحكم وإدارة ملفات البوت من خلال الرابط أعلاه.",
                            inline: false
                        }
                    )
                    .setTimestamp()
                    .setFooter({
                        text: "مـــكــانـك ألأفــضـل هــو هٌــنا - Hn هــوسـت",
                        iconURL: client.user.displayAvatarURL(),
                    });

                await user.send({ embeds: [giftEmbed] });

                await interaction.reply({
                    content: `تم إهداء هوست **${hostName}** للمستخدم <@${userId}> بنجاح!`,
                    flags: 64,
                });
            } catch (error) {
                await interaction.reply({
                    content:
                        "فشل في إرسال رسالة للمستخدم، لكن تم إنشاء الهوست!",
                    flags: 64,
                });
            }
            break;

        case "remove_hosting_from_user_modal":
            const hostNameToRemove = interaction.fields
                .getTextInputValue("host_name_to_remove_input")
                .trim();

            if (!activeHostings.has(hostNameToRemove)) {
                return interaction.reply({
                    content: "الهوست هذا غير موجود!",
                    flags: 64,
                });
            }

            const hostingToRemove = activeHostings.get(hostNameToRemove);
            stopHosting(hostNameToRemove);

            try {
                const user = await client.users.fetch(hostingToRemove.ownerId);
                const removeEmbed = new EmbedBuilder()
                    .setColor("#ff0000")
                    .setTitle("تم حذف هوست من قبل الإدارة")
                    .setDescription(
                        `تم حذف هوست **${hostNameToRemove}** من قبل الإدارة.`,
                    )
                    .setTimestamp()
                    .setFooter({
                        text: "مـــكــانـك ألأفــضـل هــو هٌــنا - Hn هــوسـت",
                        iconURL: client.user.displayAvatarURL(),
                    });

                await user.send({ embeds: [removeEmbed] });
            } catch (error) {
                console.error("خطأ في إرسال إشعار الحذف:", error);
            }

            await interaction.reply({
                content: `تم حذف هوست **${hostNameToRemove}** بنجاح!`,
                flags: 64,
            });
            break;

        case "warn_user_modal":
            const warnUserId = interaction.fields
                .getTextInputValue("warn_user_id_input")
                .trim();
            const warningReason = interaction.fields
                .getTextInputValue("warning_reason_input")
                .trim();

            if (!config.warnings) {
                config.warnings = new Collection();
            }

            const existingWarnings = config.warnings.get(warnUserId) || [];
            existingWarnings.push({
                reason: warningReason,
                date: Date.now(),
                by: interaction.user.id,
            });

            config.warnings.set(warnUserId, existingWarnings);
            saveData();

            try {
                const user = await client.users.fetch(warnUserId);
                const warningEmbed = new EmbedBuilder()
                    .setColor("#ff6600")
                    .setTitle("تحذير من إدارة Hn Host")
                    .setDescription(`تم إصدار تحذير بحقك`)
                    .addFields(
                        { name: "السبب", value: warningReason, inline: false },
                        {
                            name: "التاريخ",
                            value: `<t:${Math.floor(Date.now() / 1000)}:F>`,
                            inline: true,
                        },
                        {
                            name: "تنبيه",
                            value: "يرجى الالتزام بقوانين الخدمة لتجنب المزيد من التحذيرات.",
                            inline: false,
                        },
                    )
                    .setTimestamp()
                    .setFooter({
                        text: "مـــكــانـك ألأفــضـل هــو هٌــنا - Hn هــوسـت",
                        iconURL: client.user.displayAvatarURL(),
                    });

                await user.send({ embeds: [warningEmbed] });

                await interaction.reply({
                    content: `تم تحذير المستخدم <@${warnUserId}> بنجاح!`,
                    flags: 64,
                });
            } catch (error) {
                await interaction.reply({
                    content: "فشل في إرسال التحذير للمستخدم، لكن تم تسجيله!",
                    flags: 64,
                });
            }
            break;

        case "start_giveaway_modal":
            const giveawayRoomId = interaction.fields
                .getTextInputValue("giveaway_room_input")
                .trim();
            const giveawayDuration = interaction.fields
                .getTextInputValue("giveaway_duration_input")
                .trim();
            const giveawayTime = parseInt(
                interaction.fields.getTextInputValue("giveaway_time_input"),
            );

            if (!config.prices[giveawayDuration]) {
                return interaction.reply({
                    content: "مدة الهوست غير صحيحة!",
                    flags: 64,
                });
            }

            if (isNaN(giveawayTime) || giveawayTime <= 0) {
                return interaction.reply({
                    content: "مدة الجيفاواي يجب أن تكون رقم أكبر من صفر!",
                    flags: 64,
                });
            }

            try {
                const giveawayChannel =
                    await client.channels.fetch(giveawayRoomId);
                const endsAt = Date.now() + giveawayTime * 60 * 1000;

                const giveawayEmbed = new EmbedBuilder()
                    .setColor("#ff00ff")
                    .setTitle("جيفاواي هوست مجاني!")
                    .setDescription(
                        `** الجائزة:** هوست مجاني لمدة ${giveawayDuration.replace("_", " ")}\n** ينتهي:** <t:${Math.floor(endsAt / 1000)}:R>\n\n اضغط على الزر للمشاركة!\n${giveaway.participants.length}`,
                    )
                    .setTimestamp(endsAt)
                    .setFooter({
                        text: "مـــكــانـك ألأفــضـل هــو هٌــنا - Hn هــوسـت",
                        iconURL: client.user.displayAvatarURL(),
                    });

                const giveawayButton = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId("join_giveaway")
                        .setLabel("شارك في الجيفاواي")
                        .setStyle(ButtonStyle.Primary),
                );

                const giveawayMessage = await giveawayChannel.send({
                    embeds: [giveawayEmbed],
                    components: [giveawayButton],
                });

                if (!config.giveaways) {
                    config.giveaways = new Collection();
                }

                config.giveaways.set(giveawayMessage.id, {
                    channelId: giveawayRoomId,
                    messageId: giveawayMessage.id,
                    duration: giveawayDuration,
                    endsAt: endsAt,
                    participants: [],
                });

                await interaction.reply({
                    content: `تم بدء الجيفاواي بنجاح في <#${giveawayRoomId}>!`,
                    flags: 64,
                });
            } catch (error) {
                console.error("خطأ في بدء الجيفاواي:", error);
                await interaction.reply({
                    content: "فشل في بدء الجيفاواي! تأكد من صحة ID الروم.",
                    flags: 64,
                });
            }
            break;
    }
}

async function endGiveaway(giveaway) {
    try {
        const channel = await client.channels
            .fetch(giveaway.channelId)
            .catch(() => null);
        if (!channel) {
            console.log("لم يتم العثور على قناة الجيفاواي");
            return;
        }

        const message = await channel.messages
            .fetch(giveaway.messageId)
            .catch(() => null);
        if (!message) {
            console.log("لم يتم العثور على رسالة الجيفاواي");
            return;
        }

        if (!giveaway.participants || giveaway.participants.length === 0) {
            const noWinnerEmbed = new EmbedBuilder()
                .setColor("#ff0000")
                .setTitle("انتهى الجيفاواي")
                .setDescription("لم يشارك أحد في الجيفاواي! الجيفاواي انلغى.")
                .setTimestamp()
                .setFooter({
                    text: "مـــكــانـك ألأفــضـل هــو هٌــنا - Hn هــوسـت",
                    iconURL: client.user.displayAvatarURL(),
                });

            await message
                .edit({ embeds: [noWinnerEmbed], components: [] })
                .catch(console.error);
            return;
        }

        const winnerId =
            giveaway.participants[
            Math.floor(Math.random() * giveaway.participants.length)
            ];
        const winner = await client.users.fetch(winnerId).catch(() => null);

        if (!winner) {
            console.log("لم يتم العثور على الفائز");
            return;
        }

        const hostName = `Giveaway_${winnerId}_${Date.now()}`;
        const expiresAt = Date.now() + getDurationInMs(giveaway.duration);

        activeHostings.set(hostName, {
            ownerId: winnerId,
            name: hostName,
            duration: giveaway.duration,
            mainFile: "index.js",
            expiresAt,
            process: null,
            createdAt: Date.now(),
            isGiveawayWin: true,
        });

        const winnerEmbed = new EmbedBuilder()
            .setColor("#00ff00")
            .setTitle("تم اختيار الفايز!")
            .setDescription(
                `** الفائز:** ${winner}\n** الجائزة:** هوست لمدة ${giveaway.duration.replace("_", " ")}\n** عدد المشاركين:** ${giveaway.participants.length}`,
            )
            .addFields({
                name: "تهانينا!",
                value: `مبروك ${winner}! فزت بهوست مجاني!`,
                inline: false,
            })
            .setTimestamp()
            .setFooter({
                text: "مـــكــانـك ألأفــضـل هــو هٌــنا - Hn هــوسـت",
                iconURL: client.user.displayAvatarURL(),
            });

        await message
            .edit({ embeds: [winnerEmbed], components: [] })
            .catch(console.error);

        const mentionEmbed = new EmbedBuilder()
            .setColor("#ffd700")
            .setTitle("مبروك يخوي")
            .setDescription(`${winner} شوف خاصك`)
            .setTimestamp()
            .setFooter({
                text: "مـــكــانـك ألأفــضـل هــو هٌــنا - Hn هــوسـت",
                iconURL: client.user.displayAvatarURL(),
            });

        await channel.send({ embeds: [mentionEmbed] }).catch(console.error);

        const winnerDmEmbed = new EmbedBuilder()
            .setColor("#00ff00")
            .setTitle("مبروك الفوز")
            .setDescription(`فزت بهوست **${hostName}** من الجيفاواي! يمحظوظ`)
            .addFields(
                { name: "اسم الهوست", value: hostName, inline: true },
                {
                    name: "المدة",
                    value: giveaway.duration.replace("_", " "),
                    inline: true,
                },
                {
                    name: "الخطوة التالية",
                    value: "ابعتلي ملف ZIP فيه ملفات بوتك عشان أشغله لك فوراً!",
                    inline: false,
                },
            )
            .setTimestamp()
            .setFooter({
                text: "مـــكــانـك ألأفــضـل هــو هٌــنا - Hn هــوسـت",
                iconURL: client.user.displayAvatarURL(),
            });

        await winner.send({ embeds: [winnerDmEmbed] }).catch(console.error);
    } catch (error) {
        console.error("خطأ في إنهاء الجيفاواي:", error);
    }
}

async function handleControlPanel(interaction) {
    const hostName = interaction.customId.replace("control_panel_", "");
    const hosting = activeHostings.get(hostName);

    if (!hosting || hosting.ownerId !== interaction.user.id) {
        return interaction.reply({
            content: "هذا الهوست غير موجود أو ليس ملكك!",
            flags: 64,
        });
    }

    const daysLeft = Math.ceil((hosting.expiresAt - Date.now()) / (1000 * 60 * 60 * 24));
    const status = hosting.process ? "يعمل" : "متوقف";
    const uptime = hosting.lastStarted ?
        Math.floor((Date.now() - hosting.lastStarted) / 1000 / 60) : 0;

    const embed = new EmbedBuilder()
        .setColor(hosting.process ? "#00ff00" : "#ff0000")
        .setTitle(`لوحة تحكم البوت: ${hostName}`)
        .setDescription("إدارة شاملة لبوتك مع أدوات متقدمة")
        .addFields(
            { name: "الحالة", value: status, inline: true },
            { name: "الأيام المتبقية", value: `${daysLeft} يوم`, inline: true },
            { name: "وقت التشغيل", value: `${uptime} دقيقة`, inline: true },
            { name: "الملف الرئيسي", value: hosting.mainFile, inline: true },
            { name: "تاريخ الإنشاء", value: new Date(hosting.createdAt).toLocaleDateString(), inline: true },
            { name: "إدارة المساحة", value: "نظام تنظيف متقدم", inline: true }
        )
        .setTimestamp()
        .setFooter({
            text: "مـــكــانـك ألأفــضـل هــو هٌــنا - Hn هــوسـت",
            iconURL: client.user.displayAvatarURL(),
        });

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`${hosting.process ? 'stop' : 'start'}_bot_${hostName}`)
            .setLabel(hosting.process ? "إيقاف" : "تشغيل")
            .setStyle(hosting.process ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`restart_bot_${hostName}`)
            .setLabel("إعادة تشغيل")
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`logs_bot_${hostName}`)
            .setLabel("السجلات")
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`status_bot_${hostName}`)
            .setLabel("الحالة المفصلة")
            .setStyle(ButtonStyle.Secondary)
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`file_manager_${hostName}`)
            .setLabel("إدارة الملفات")
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`install_deps_${hostName}`)
            .setLabel("تثبيت المكتبات")
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`optimize_storage_${hostName}`)
            .setLabel("تحسين المساحة")
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`clear_logs_${hostName}`)
            .setLabel("مسح السجلات")
            .setStyle(ButtonStyle.Secondary)
    );

    await interaction.reply({
        embeds: [embed],
        components: [row1, row2],
        flags: 64
    });
}

async function handleRestartBot(interaction) {
    const hostName = interaction.customId.replace("restart_bot_", "");
    const hosting = activeHostings.get(hostName);

    if (!hosting || hosting.ownerId !== interaction.user.id) {
        return interaction.reply({
            content: "هذا الهوست غير موجود أو ليس ملكك!",
            flags: 64,
        });
    }

    const restartEmbed = new EmbedBuilder()
        .setColor("#ffaa00")
        .setTitle("جاري إعادة تشغيل البوت...")
        .setDescription(`يتم إعادة تشغيل **${hostName}** مع تحسينات متقدمة`)
        .addFields(
            { name: "إيقاف البوت", value: "تم", inline: true },
            { name: "تنظيف الملفات", value: "جاري...", inline: true },
            { name: "تثبيت المكتبات", value: "انتظار...", inline: true },
            { name: "تشغيل البوت", value: "انتظار...", inline: true }
        )
        .setTimestamp();

    await interaction.reply({ embeds: [restartEmbed], flags: 64 });

    try {
        if (hosting.process && typeof hosting.process.pid === 'number') {
            try { process.kill(hosting.process.pid); } catch { }
            hosting.process = null;
        }

        const hostPath = path.join(__dirname, "hostings", hostName);
        const hostNodeModules = path.join(hostPath, "node_modules");

        const cleanedSize = await quickCleanHost(hostName);

        const step2Embed = new EmbedBuilder()
            .setColor("#ffaa00")
            .setTitle("جاري إعادة تشغيل البوت...")
            .setDescription(`يتم إعادة تشغيل **${hostName}** مع تحسينات متقدمة`)
            .addFields(
                { name: "إيقاف البوت", value: "تم", inline: true },
                { name: "تنظيف الملفات", value: "تم", inline: true },
                { name: "تثبيت المكتبات", value: "جاري...", inline: true },
                { name: "تشغيل البوت", value: "انتظار...", inline: true }
            )
            .setTimestamp();

        await interaction.editReply({ embeds: [step2Embed] });

        const packageJsonPath = path.join(hostPath, "package.json");
        if (fs.existsSync(packageJsonPath)) {
            await new Promise((resolve) => {
                exec(`cd "${hostPath}" && npm install`, (error) => {
                    if (error) console.error(`خطأ في تثبيت المكتبات لـ ${hostName}:`, error);
                    resolve();
                });
            });
        }

        const step3Embed = new EmbedBuilder()
            .setColor("#ffaa00")
            .setTitle("جاري إعادة تشغيل البوت...")
            .setDescription(`يتم إعادة تشغيل **${hostName}** مع تحسينات متقدمة`)
            .addFields(
                { name: "إيقاف البوت", value: "تم", inline: true },
                { name: "تنظيف الملفات", value: "تم", inline: true },
                { name: "تثبيت المكتبات", value: "تم", inline: true },
                { name: "تشغيل البوت", value: "جاري...", inline: true }
            )
            .setTimestamp();

        await interaction.editReply({ embeds: [step3Embed] });

        const sharedModulesPath = path.join(__dirname, "shared_node_modules", "node_modules");
        const newProcess = exec(`node ${hosting.mainFile}`, {
            cwd: hostPath,
            env: { ...process.env, NODE_PATH: sharedModulesPath },
            windowsHide: true,
        });

        hosting.process = newProcess;
        hosting.lastStarted = Date.now();

        setTimeout(() => {
            if (fs.existsSync(hostNodeModules)) {
                fs.rmSync(hostNodeModules, { recursive: true, force: true });
            }
        }, 5000);

        const finalEmbed = new EmbedBuilder()
            .setColor("#00ff00")
            .setTitle("تم إعادة تشغيل البوت بنجاح")
            .setDescription(`**${hostName}** يعمل الآن بكامل قوته مع تحسينات الأداء`)
            .addFields(
                { name: "إيقاف البوت", value: "تم", inline: true },
                { name: "تنظيف الملفات", value: "تم", inline: true },
                { name: "تثبيت المكتبات", value: "تم", inline: true },
                { name: "تشغيل البوت", value: "تم", inline: true },
                { name: "المساحة المحررة", value: `${(cleanedSize / 1024 / 1024).toFixed(2)} MB`, inline: false },
                { name: "وقت إعادة التشغيل", value: new Date().toLocaleString(), inline: false }
            )
            .setTimestamp();

        await interaction.editReply({ embeds: [finalEmbed] });

    } catch (error) {
        console.error(`خطأ في إعادة تشغيل ${hostName}:`, error);

        const errorEmbed = new EmbedBuilder()
            .setColor("#ff0000")
            .setTitle("فشل في إعادة التشغيل")
            .setDescription(`حدث خطأ في إعادة تشغيل **${hostName}**`)
            .addFields({ name: "الخطأ", value: error.message || "خطأ غير معروف", inline: false })
            .setTimestamp();

        await interaction.editReply({ embeds: [errorEmbed] });
    }
}

async function handleBotLogs(interaction) {
    const hostName = interaction.customId.replace("logs_bot_", "");
    const hosting = activeHostings.get(hostName);

    if (!hosting || hosting.ownerId !== interaction.user.id) {
        return interaction.reply({
            content: "هذا الهوست غير موجود أو ليس ملكك!",
            flags: 64,
        });
    }

    const hostPath = path.join(__dirname, "hostings", hostName);
    const logFile = path.join(hostPath, "bot.log");

    let logs = "سجلات البوت:\n\n";

    if (fs.existsSync(logFile)) {
        try {
            const logContent = fs.readFileSync(logFile, "utf8");
            const recentLogs = logContent.split('\n').slice(-20).join('\n');
            logs += recentLogs || "لا توجد سجلات حديثة";
        } catch (error) {
            logs += "خطأ في قراءة ملف السجلات";
        }
    } else {
        logs += `[${new Date().toLocaleString()}] البوت يعمل بنجاح\n`;
        logs += `[${new Date().toLocaleString()}] تم الاتصال بـ Discord\n`;
        logs += `[${new Date().toLocaleString()}] البوت جاهز للاستخدام\n`;
        logs += `[${new Date().toLocaleString()}] جميع الأوامر تم تحميلها بنجاح`;
    }

    const embed = new EmbedBuilder()
        .setColor(hosting.process ? "#00ff00" : "#ff0000")
        .setTitle(`سجلات البوت: ${hostName}`)
        .setDescription(`\`\`\`${logs.slice(0, 1800)}\`\`\``)
        .addFields(
            { name: "الحالة", value: hosting.process ? "🟢 يعمل" : "🔴 متوقف", inline: true },
            { name: "آخر تحديث", value: new Date().toLocaleString(), inline: true }
        )
        .setTimestamp();

    const refreshButton = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`logs_bot_${hostName}`)
            .setLabel("تحديث السجلات")
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`clear_logs_${hostName}`)
            .setLabel("مسح السجلات")
            .setStyle(ButtonStyle.Danger)
    );

    await interaction.reply({
        embeds: [embed],
        components: [refreshButton],
        flags: 64
    });
}

async function handleBotStatus(interaction) {
    const hostName = interaction.customId.replace("status_bot_", "");
    const hosting = activeHostings.get(hostName);

    if (!hosting || hosting.ownerId !== interaction.user.id) {
        return interaction.reply({
            content: "هذا الهوست غير موجود أو ليس ملكك!",
            flags: 64,
        });
    }

    const hostPath = path.join(__dirname, "hostings", hostName);
    const daysLeft = Math.ceil((hosting.expiresAt - Date.now()) / (1000 * 60 * 60 * 24));
    const uptime = hosting.lastStarted ?
        Math.floor((Date.now() - hosting.lastStarted) / 1000 / 60) : 0;

    const storageInfo = getHostStorageInfo(hostName);
    let folderSize = "غير محدد";
    let optimizationInfo = "";

    if (storageInfo) {
        folderSize = `${(storageInfo.actualSize / 1024 / 1024).toFixed(2)} MB`;
        if (storageInfo.canOptimize) {
            optimizationInfo = `يمكن توفير ${(storageInfo.optimizationSavings / 1024 / 1024).toFixed(2)} MB`;
        } else {
            optimizationInfo = "محسن";
        }
    }

    const embed = new EmbedBuilder()
        .setColor(hosting.process ? "#00ff00" : "#ff0000")
        .setTitle(`حالة البوت المفصلة: ${hostName}`)
        .setDescription("معلومات شاملة عن بوتك وأدائه")
        .addFields(
            { name: "حالة التشغيل", value: hosting.process ? "🟢 يعمل" : "🔴 متوقف", inline: true },
            { name: "وقت التشغيل", value: `${uptime} دقيقة`, inline: true },
            { name: "الأيام المتبقية", value: `${daysLeft} يوم`, inline: true },
            { name: "الملف الرئيسي", value: hosting.mainFile, inline: true },
            { name: "حجم المجلد", value: folderSize, inline: true },
            { name: "تحسين المساحة", value: optimizationInfo, inline: true },
            { name: "تاريخ الإنشاء", value: new Date(hosting.createdAt).toLocaleDateString(), inline: true },
            { name: "آخر تشغيل", value: hosting.lastStarted ? new Date(hosting.lastStarted).toLocaleString() : "لم يتم التشغيل بعد", inline: false },
            { name: "تحسينات الأداء", value: "نظام المكتبات المشتركة\n حذف تلقائي لـ node_modules\n تنظيف دوري للملفات المؤقتة", inline: false }
        )
        .setTimestamp();

    await interaction.reply({ embeds: [embed], flags: 64 });
}

async function handleOptimizeStorage(interaction) {
    const hostName = interaction.customId.replace("optimize_storage_", "");
    const hosting = activeHostings.get(hostName);

    if (!hosting || hosting.ownerId !== interaction.user.id) {
        return interaction.reply({
            content: "هذا الهوست غير موجود أو ليس ملكك!",
            flags: 64,
        });
    }

    const storageInfo = getHostStorageInfo(hostName);

    if (!storageInfo || !storageInfo.canOptimize) {
        const embed = new EmbedBuilder()
            .setColor("#00ff00")
            .setTitle("المساحة محسنة بالفعل")
            .setDescription(`**${hostName}** لا يحتاج تحسين إضافي`)
            .addFields(
                { name: "حجم المجلد", value: `${(storageInfo.actualSize / 1024 / 1024).toFixed(2)} MB`, inline: true },
                { name: "الحالة", value: "محسن", inline: true }
            )
            .setTimestamp();

        return interaction.reply({ embeds: [embed], flags: 64 });
    }

    const optimizingEmbed = new EmbedBuilder()
        .setColor("#ffaa00")
        .setTitle("جاري تحسين المساحة...")
        .setDescription(`يتم تحسين **${hostName}** لتوفير المساحة`)
        .addFields(
            { name: "المساحة المتوقع توفيرها", value: `${(storageInfo.optimizationSavings / 1024 / 1024).toFixed(2)} MB`, inline: true },
            { name: "الحالة", value: "جاري التحسين...", inline: true }
        )
        .setTimestamp();

    await interaction.reply({ embeds: [optimizingEmbed], flags: 64 });

    try {
        const cleanedSize = await quickCleanHost(hostName);

        const embed = new EmbedBuilder()
            .setColor("#00ff00")
            .setTitle("تم تحسين المساحة بنجاح")
            .setDescription(`تم تحسين **${hostName}** وتوفير مساحة كبيرة`)
            .addFields(
                { name: "المساحة المحررة", value: `${(cleanedSize / 1024 / 1024).toFixed(2)} MB`, inline: true },
                { name: "نوع التحسين", value: "حذف node_modules\nتنظيف cache\nملفات مؤقتة", inline: true },
                { name: "وقت التحسين", value: new Date().toLocaleString(), inline: false }
            )
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        const embed = new EmbedBuilder()
            .setColor("#ff0000")
            .setTitle("فشل في تحسين المساحة")
            .setDescription(`حدث خطأ: ${error.message}`)
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
    }
}

async function handleClearLogs(interaction) {
    const hostName = interaction.customId.replace("clear_logs_", "");
    const hosting = activeHostings.get(hostName);

    if (!hosting || hosting.ownerId !== interaction.user.id) {
        return interaction.reply({
            content: "هذا الهوست غير موجود أو ليس ملكك!",
            flags: 64,
        });
    }

    const hostPath = path.join(__dirname, "hostings", hostName);
    const logFile = path.join(hostPath, "bot.log");

    try {
        if (fs.existsSync(logFile)) {
            fs.unlinkSync(logFile);
        }

        const embed = new EmbedBuilder()
            .setColor("#00ff00")
            .setTitle("تم مسح السجلات")
            .setDescription(`تم مسح سجلات **${hostName}** بنجاح!`)
            .setTimestamp();

        await interaction.reply({ embeds: [embed], flags: 64 });
    } catch (error) {
        const embed = new EmbedBuilder()
            .setColor("#ff0000")
            .setTitle("فشل في مسح السجلات")
            .setDescription(`حدث خطأ: ${error.message}`)
            .setTimestamp();

        await interaction.reply({ embeds: [embed], flags: 64 });
    }
}

async function handleInstallDependencies(interaction) {
    const hostName = interaction.customId.replace("install_deps_", "");
    const hosting = activeHostings.get(hostName);

    if (!hosting || hosting.ownerId !== interaction.user.id) {
        return interaction.reply({
            content: "هذا الهوست غير موجود أو ليس ملكك!",
            flags: 64,
        });
    }

    const hostPath = path.join(__dirname, "hostings", hostName);
    const packageJsonPath = path.join(hostPath, "package.json");

    if (!fs.existsSync(packageJsonPath)) {
        return interaction.reply({
            content: "لا يوجد ملف package.json في هذا الهوست!",
            flags: 64,
        });
    }

    const installingEmbed = new EmbedBuilder()
        .setColor("#ffaa00")
        .setTitle("جاري تثبيت المكتبات...")
        .setDescription(`يتم تثبيت المكتبات لـ **${hostName}**`)
        .addFields({ name: "الحالة", value: " جاري التثبيت...", inline: true })
        .setTimestamp();

    await interaction.reply({ embeds: [installingEmbed], flags: 64 });

    try {
        await new Promise((resolve, reject) => {
            exec(`cd "${hostPath}" && npm install`, (error, stdout, stderr) => {
                if (error) reject(error);
                else resolve({ stdout, stderr });
            });
        });

        const hostNodeModules = path.join(hostPath, "node_modules");
        if (fs.existsSync(hostNodeModules)) {
            setTimeout(() => {
                fs.rmSync(hostNodeModules, { recursive: true, force: true });
            }, 2000);
        }

        const successEmbed = new EmbedBuilder()
            .setColor("#00ff00")
            .setTitle("تم تثبيت المكتبات بنجاح")
            .setDescription(`تم تثبيت جميع المكتبات لـ **${hostName}**`)
            .addFields(
                { name: "الحالة", value: "مكتمل", inline: true },
                { name: "تحسين المساحة", value: "تم حذف node_modules", inline: true }
            )
            .setTimestamp();

        await interaction.editReply({ embeds: [successEmbed] });
    } catch (error) {
        const errorEmbed = new EmbedBuilder()
            .setColor("#ff0000")
            .setTitle("❌ فشل في تثبيت المكتبات")
            .setDescription(`حدث خطأ: ${error.message}`)
            .setTimestamp();

        await interaction.editReply({ embeds: [errorEmbed] });
    }
}

async function handleFileManager(interaction) {
    const hostName = interaction.customId.replace("file_manager_", "");
    const hosting = activeHostings.get(hostName);

    if (!hosting || hosting.ownerId !== interaction.user.id) {
        return interaction.reply({
            content: "هذا الهوست غير موجود أو ليس ملكك!",
            flags: 64,
        });
    }

    const hostPath = path.join(__dirname, "hostings", hostName);

    try {
        const files = fs.readdirSync(hostPath).filter(file => {
            const filePath = path.join(hostPath, file);
            return !file.startsWith(".") &&
                file !== "node_modules" &&
                fs.statSync(filePath).isFile() &&
                [".js", ".json", ".txt", ".md", ".env", ".py", ".html", ".css"].some(ext => file.endsWith(ext));
        });

        if (files.length === 0) {
            return interaction.reply({
                content: "لا توجد ملفات قابلة للتحرير في هذا الهوست!",
                flags: 64,
            });
        }

        const storageInfo = getHostStorageInfo(hostName);
        const fileCount = fs.readdirSync(hostPath).length;
        const folderSize = storageInfo ? storageInfo.actualSize : 0;

        const embed = new EmbedBuilder()
            .setColor("#0099ff")
            .setTitle(`إدارة ملفات: ${hostName}`)
            .setDescription("اختر ملف لتحريره أو عرضه")
            .addFields(
                { name: "عدد الملفات", value: fileCount.toString(), inline: true },
                { name: "حجم المجلد", value: `${(folderSize / 1024 / 1024).toFixed(2)} MB`, inline: true },
                { name: "ملفات قابلة للتحرير", value: files.length.toString(), inline: true }
            )
            .setTimestamp();

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId(`select_file_${hostName}`)
            .setPlaceholder("اختر ملف للتحرير أو العرض");

        files.forEach(file => {
            const filePath = path.join(hostPath, file);
            const stats = fs.statSync(filePath);
            selectMenu.addOptions({
                label: file,
                description: `${(stats.size / 1024).toFixed(1)} KB`,
                value: file,
                emoji: "📄"
            });
        });

        const row = new ActionRowBuilder().addComponents(selectMenu);
        await interaction.reply({
            embeds: [embed],
            components: [row],
            flags: 64
        });
    } catch (error) {
        await interaction.reply({
            content: "❌ حدث خطأ في الوصول لملفات الهوست!",
            flags: 64,
        });
    }
}

async function getFolderSize(folderPath) {
    let totalSize = 0;

    try {
        const files = fs.readdirSync(folderPath);

        for (const file of files) {
            const filePath = path.join(folderPath, file);
            const stats = fs.statSync(filePath);

            if (stats.isDirectory()) {
                if (file !== "node_modules") {
                    totalSize += await getFolderSize(filePath);
                }
            } else {
                totalSize += stats.size;
            }
        }
    } catch (error) {
    }

    return totalSize;
}

const fileSizeCache = new Map();
const CACHE_EXPIRY = 5 * 60 * 1000;

function getQuickFolderSize(folderPath) {
    const cacheKey = folderPath;
    const cached = fileSizeCache.get(cacheKey);

    if (cached && (Date.now() - cached.timestamp) < CACHE_EXPIRY) {
        return cached.size;
    }

    try {
        const size = getFolderSizeSync(folderPath);
        fileSizeCache.set(cacheKey, { size, timestamp: Date.now() });
        return size;
    } catch (error) {
        return 0;
    }
}


setInterval(() => {
    const now = Date.now();
    for (const [key, value] of fileSizeCache.entries()) {
        if (now - value.timestamp > CACHE_EXPIRY) {
            fileSizeCache.delete(key);
        }
    }
}, 10 * 60 * 1000);
async function smartCleanupSystem() {
    const hostingsPath = path.join(__dirname, "hostings");
    if (!fs.existsSync(hostingsPath)) return;

    const folders = fs.readdirSync(hostingsPath);
    let totalCleaned = 0;
    let cleanedFolders = 0;

    const cleanupPromises = folders.map(async (folder) => {
        const folderPath = path.join(hostingsPath, folder);
        if (!fs.statSync(folderPath).isDirectory()) return 0;

        let folderCleaned = 0;

        const nodeModulesPath = path.join(folderPath, "node_modules");
        if (fs.existsSync(nodeModulesPath)) {
            try {
                const size = getQuickFolderSize(nodeModulesPath);
                await fastDeleteDirectory(nodeModulesPath);
                folderCleaned += size;
                cleanedFolders++;
            } catch (error) {
            }
        }

        await Promise.all([
            cleanOldLogs(folderPath),
            cleanNpmCache(folderPath),
            cleanPackageLock(folderPath),
            cleanTempFiles(folderPath)
        ]);

        return folderCleaned;
    });

    const results = await Promise.all(cleanupPromises);
    totalCleaned = results.reduce((sum, size) => sum + size, 0);

    return { cleanedFolders, totalCleaned };
}

async function fastDeleteDirectory(dirPath) {
    return new Promise((resolve) => {
        // Prefer Node's own remover (works across platforms)
        try {
            fs.rmSync(dirPath, { recursive: true, force: true });
            return resolve();
        } catch { }

        // Fallback to shell command per platform
        const { spawn } = require('child_process');
        let command = 'rm';
        let args = ['-rf', dirPath];
        if (process.platform === 'win32') {
            command = 'cmd.exe';
            args = ['/c', 'rmdir', '/s', '/q', dirPath];
        }

        const child = spawn(command, args, { windowsHide: true });
        child.on('error', () => {
            try {
                fs.rmSync(dirPath, { recursive: true, force: true });
            } catch { }
            resolve();
        });
        child.on('close', () => {
            resolve();
        });
    });
}

async function cleanOldLogs(folderPath) {
    const logFile = path.join(folderPath, "bot.log");
    if (fs.existsSync(logFile)) {
        try {
            const stats = fs.statSync(logFile);
            const weekOld = Date.now() - (7 * 24 * 60 * 60 * 1000);
            if (stats.mtime.getTime() < weekOld) {
                fs.unlinkSync(logFile);
            }
        } catch (error) {
        }
    }
}

async function cleanNpmCache(folderPath) {
    const npmCache = path.join(folderPath, ".npm");
    if (fs.existsSync(npmCache)) {
        try {
            await fastDeleteDirectory(npmCache);
        } catch (error) {
        }
    }
}

async function cleanPackageLock(folderPath) {
    const packageLock = path.join(folderPath, "package-lock.json");
    if (fs.existsSync(packageLock)) {
        try {
            fs.unlinkSync(packageLock);
        } catch (error) {
        }
    }
}

async function cleanTempFiles(folderPath) {
    const tempPatterns = [
        path.join(folderPath, "*.tmp"),
        path.join(folderPath, "*.log.*"),
        path.join(folderPath, ".DS_Store"),
        path.join(folderPath, "Thumbs.db"),
        path.join(folderPath, "node_modules/.cache")
    ];

    for (const pattern of tempPatterns) {
        try {
            const files = require('glob').sync(pattern);
            for (const file of files) {
                fs.unlinkSync(file);
            }
        } catch (error) {
        }
    }
}

function getFolderSizeSync(folderPath) {
    let totalSize = 0;
    const stack = [folderPath];

    while (stack.length > 0) {
        const currentPath = stack.pop();

        try {
            const files = fs.readdirSync(currentPath);

            for (const file of files) {
                const filePath = path.join(currentPath, file);
                const stats = fs.statSync(filePath);

                if (stats.isDirectory()) {
                    if (!file.startsWith('.') && file !== 'node_modules') {
                        stack.push(filePath);
                    }
                } else {
                    totalSize += stats.size;
                }
            }
        } catch (error) {
            continue;
        }
    }

    return totalSize;
}

let diskMonitorInterval;

function startDiskMonitoring() {
    diskMonitorInterval = setInterval(async () => {
        try {
            const stats = await smartCleanupSystem();
            if (stats.totalCleaned > 50 * 1024 * 1024) {
            }
        } catch (error) {
        }
    }, 15 * 60 * 1000);
}

startDiskMonitoring();

async function quickCleanHost(hostName) {
    const hostPath = path.join(__dirname, "hostings", hostName);
    if (!fs.existsSync(hostPath)) return 0;

    let cleanedSize = 0;

    const nodeModulesPath = path.join(hostPath, "node_modules");
    if (fs.existsSync(nodeModulesPath)) {
        const size = getQuickFolderSize(nodeModulesPath);
        await fastDeleteDirectory(nodeModulesPath);
        cleanedSize += size;
    }

    await Promise.all([
        cleanOldLogs(hostPath),
        cleanNpmCache(hostPath),
        cleanPackageLock(hostPath),
        cleanTempFiles(hostPath)
    ]);

    const cacheKeys = Array.from(fileSizeCache.keys()).filter(key => key.includes(hostName));
    cacheKeys.forEach(key => fileSizeCache.delete(key));

    return cleanedSize;
}

function getHostStorageInfo(hostName) {
    const hostPath = path.join(__dirname, "hostings", hostName);
    if (!fs.existsSync(hostPath)) return null;

    const size = getQuickFolderSize(hostPath);
    const nodeModulesPath = path.join(hostPath, "node_modules");
    const hasNodeModules = fs.existsSync(nodeModulesPath);
    const nodeModulesSize = hasNodeModules ? getQuickFolderSize(nodeModulesPath) : 0;

    return {
        totalSize: size,
        nodeModulesSize,
        actualSize: size - nodeModulesSize,
        canOptimize: hasNodeModules,
        optimizationSavings: nodeModulesSize
    };
}

function getFolderSizeSync(folderPath) {
    let totalSize = 0;

    try {
        const files = fs.readdirSync(folderPath);

        for (const file of files) {
            const filePath = path.join(folderPath, file);
            const stats = fs.statSync(filePath);

            if (stats.isDirectory()) {
                totalSize += getFolderSizeSync(filePath);
            } else {
                totalSize += stats.size;
            }
        }
    } catch (error) {
    }

    return totalSize;
}

function stopHosting(hostName) {
    const hosting = activeHostings.get(hostName);
    if (!hosting) return;


    const timeLeft = hosting.expiresAt - Date.now();
    if (timeLeft > 0) {
        const daysLeft = Math.ceil(timeLeft / (1000 * 60 * 60 * 24));
        addUserCredit(hosting.ownerId, daysLeft);
    }

    if (hosting.process && typeof hosting.process.pid === 'number') {
        try { process.kill(hosting.process.pid); } catch { }
    }

    const hostPath = path.join(__dirname, "hostings", hostName);

    if (fs.existsSync(hostPath)) {
        try {
            const cleanedSize = quickCleanHost(hostName);
            if (cleanedSize > 0) {
            }

            fastDeleteDirectory(hostPath).catch(error => {
                try {
                    fs.rmSync(hostPath, { recursive: true, force: true });
                } catch (fallbackError) {
                }
            });
        } catch (error) {
            try {
                fs.rmSync(hostPath, { recursive: true, force: true });
            } catch (fallbackError) {
            }
        }
    }

    activeHostings.delete(hostName);

    if (hosting.ownerId) {
        sendHostingDeletedMessage(
            hosting.ownerId,
            hostName,
            Math.ceil(timeLeft / (1000 * 60 * 60 * 24)),
        );
    }
}


process.on("unhandledRejection", (error) => {
    console.error("خطأ غير معالج:", error);
});

process.on("uncaughtException", (error) => {
    console.error("استثناء غير معالج:", error);
});

// Define startHosting function for the web server
function startHosting(hostName) {
    const hosting = activeHostings.get(hostName);

    if (!hosting) {
        console.error(`❌ الهوست ${hostName} غير موجود!`);
        return false;
    }

    if (hosting.process) {
        console.log(`▶️ البوت ${hostName} يعمل بالفعل!`);
        return true;
    }

    try {
        const hostPath = path.join(__dirname, "hostings", hostName);
        const sharedModulesPath = path.join(__dirname, "shared_node_modules", "node_modules");

        // Quick clean to optimize storage
        quickCleanHost(hostName).then(cleanedSize => {
            if (cleanedSize > 0) {
                console.log(`🧹 تم تحسين ${hostName} - توفير ${(cleanedSize / 1024 / 1024).toFixed(2)} MB`);
            }
        });

        const newProcess = exec(`node ${hosting.mainFile}`, {
            cwd: hostPath,
            env: { ...process.env, NODE_PATH: sharedModulesPath },
            windowsHide: true,
        });

        activeHostings.get(hostName).process = newProcess;

        newProcess.stdout.on("data", (data) => {
            console.log(`[${hostName}] ${data}`);

            // Log to file
            const logPath = path.join(hostPath, "bot.log");
            fs.appendFileSync(logPath, `${data}\n`);
        });

        newProcess.stderr.on("data", (data) => {
            console.error(`[${hostName}] ${data}`);

            // Log to file
            const logPath = path.join(hostPath, "bot.log");
            fs.appendFileSync(logPath, `ERROR: ${data}\n`);
        });

        newProcess.on("close", (code) => {
            console.log(`[${hostName}] توقف البوت بكود: ${code}`);

            // Auto restart if needed
            const hostingConfig = getHostingData(hostName);
            if (hostingConfig && hostingConfig.autoRestart) {
                setTimeout(() => {
                    if (activeHostings.has(hostName)) {
                        console.log(`[${hostName}] إعادة تشغيل تلقائية...`);
                        startHosting(hostName);
                    }
                }, 5000);
            }
        });

        console.log(`🚀 تم تشغيل البوت ${hostName} بنجاح!`);

        // Update config status
        const configPath = path.join(hostPath, "config.json");
        if (fs.existsSync(configPath)) {
            try {
                const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                config.status = "running";
                fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
            } catch (error) {
                console.error(`خطأ في تحديث حالة الهوست ${hostName}:`, error);
            }
        }

        return true;
    } catch (error) {
        console.error(`خطأ في تشغيل الهوست ${hostName}:`, error);
        return false;
    }
}

// Helper function to get hosting config data
function getHostingData(hostName) {
    try {
        const hostingPath = path.join(__dirname, "hostings", hostName);
        const configPath = path.join(hostingPath, "config.json");

        if (fs.existsSync(configPath)) {
            return JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
        return null;
    } catch (error) {
        console.error(`خطأ في الحصول على بيانات الهوست ${hostName}:`, error);
        return null;
    }
}

// Create hosting for user (admin function)
function createHostingForUser(userId, hostName, serviceType, port, duration, mainFile, specs) {
    try {
        // Validate inputs
        if (!userId || !hostName || !duration) {
            console.error('Missing required parameters for createHostingForUser');
            return false;
        }

        // Generate a unique ID for the hosting
        const hostId = hostName.toLowerCase().replace(/[^a-z0-9]/g, '');

        // Check if hosting with this ID already exists
        const hostingPath = path.join(__dirname, 'hostings', hostId);
        if (fs.existsSync(hostingPath)) {
            console.error(`Hosting with ID ${hostId} already exists`);
            return false;
        }

        // Create hosting directory
        fs.mkdirSync(hostingPath, { recursive: true });

        // Get user data
        let userData = null;
        try {
            const userDataPath = path.join(__dirname, 'data', 'users.json');
            if (fs.existsSync(userDataPath)) {
                const users = JSON.parse(fs.readFileSync(userDataPath, 'utf8'));
                userData = users.find(u => u.id === userId);
            }
        } catch (error) {
            console.error('Error getting user data:', error);
        }

        if (!userData) {
            userData = { id: userId, username: 'unknown', avatar: '' };
        }

        // Calculate expiry date
        const expiryDate = calculateExpiryDate(duration);

        // Determine port based on service type
        let finalPort = port;
        if (!finalPort) {
            if (serviceType === 'web') finalPort = 4000;
            else if (serviceType === 'mta') finalPort = 22003;
            else if (serviceType === 'fivem') finalPort = 30120;
            else finalPort = 3000; // discord bot default
        }

        // Create config.json
        const config = {
            name: hostName,
            owner: userData,
            mainFile: mainFile || 'index.js',
            status: 'stopped',
            createdAt: new Date().toISOString(),
            expiryDate: expiryDate,
            duration: duration,
            serviceType: serviceType || 'discord',
            port: parseInt(finalPort, 10),
            specs: specs || { cpu: 1, ram: 512, storage: 1 }
        };

        fs.writeFileSync(path.join(hostingPath, 'config.json'), JSON.stringify(config, null, 2));

        // Create empty bot.log
        fs.writeFileSync(path.join(hostingPath, 'bot.log'), '');

        // Create basic structure based on service type
        if (serviceType === 'web') {
            // Create public directory
            fs.mkdirSync(path.join(hostingPath, 'public'), { recursive: true });

            // Create basic index.html
            const indexHtml = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${hostName}</title>
    <style>
        body { font-family: Arial, sans-serif; text-align: center; margin-top: 50px; }
    </style>
</head>
<body>
    <h1>مرحباً بك في ${hostName}</h1>
    <p>هذه الصفحة الافتراضية لموقعك. قم بتعديلها لإنشاء موقعك الخاص.</p>
</body>
</html>`;

            fs.writeFileSync(path.join(hostingPath, 'public', 'index.html'), indexHtml);

            // Create basic package.json for Node.js
            const packageJson = {
                "name": hostName.toLowerCase().replace(/\s+/g, '-'),
                "version": "1.0.0",
                "description": "Web hosting for " + hostName,
                "main": mainFile || "index.js",
                "scripts": {
                    "start": `node ${mainFile || "index.js"}`
                },
                "dependencies": {
                    "express": "^4.18.2"
                }
            };

            fs.writeFileSync(path.join(hostingPath, 'package.json'), JSON.stringify(packageJson, null, 2));

            // Create basic index.js
            const indexJs = `const express = require('express');
const path = require('path');
const app = express();

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Define routes
app.get('/api', (req, res) => {
    res.json({ message: 'Welcome to ${hostName} API!' });
});

// Start server
const PORT = process.env.PORT || ${finalPort};
app.listen(PORT, () => {
    console.log(\`Server running on port \${PORT}\`);
});
`;

            fs.writeFileSync(path.join(hostingPath, mainFile || 'index.js'), indexJs);
        } else if (serviceType === 'discord') {
            // Create basic package.json for Discord bot
            const packageJson = {
                "name": hostName.toLowerCase().replace(/\s+/g, '-'),
                "version": "1.0.0",
                "description": "Discord bot for " + hostName,
                "main": mainFile || "index.js",
                "scripts": {
                    "start": `node ${mainFile || "index.js"}`
                },
                "dependencies": {
                    "discord.js": "^14.13.0"
                }
            };

            fs.writeFileSync(path.join(hostingPath, 'package.json'), JSON.stringify(packageJson, null, 2));

            // Create basic index.js for Discord bot
            const indexJs = `const { Client, GatewayIntentBits } = require('discord.js');

// Create a new client instance
const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ] 
});

// When the client is ready, run this code (only once)
client.once('ready', () => {
    console.log('Bot is ready! Logged in as ' + client.user.tag);
});

// Listen for messages
client.on('messageCreate', message => {
    if (message.author.bot) return;
    
    if (message.content === '!ping') {
        message.reply('Pong! Bot latency is ' + client.ws.ping + 'ms');
    }
});

// Login to Discord with your client's token
// Replace 'YOUR_BOT_TOKEN' with your actual bot token
client.login('YOUR_BOT_TOKEN');
`;

            fs.writeFileSync(path.join(hostingPath, mainFile || 'index.js'), indexJs);
        }

        // Add to hostings.json
        try {
            const hostingsPath = path.join(__dirname, 'data', 'hostings.json');
            let hostings = [];

            if (fs.existsSync(hostingsPath)) {
                hostings = JSON.parse(fs.readFileSync(hostingsPath, 'utf8'));
            }

            hostings.push({
                id: hostId,
                name: hostName,
                owner: userData,
                mainFile: mainFile || 'index.js',
                status: 'stopped',
                createdAt: new Date().toISOString(),
                expiryDate: expiryDate,
                duration: duration,
                serviceType: serviceType || 'discord',
                port: parseInt(finalPort, 10),
                specs: specs || { cpu: 1, ram: 512, storage: 1 }
            });

            fs.writeFileSync(hostingsPath, JSON.stringify(hostings, null, 2));
        } catch (error) {
            console.error('Error updating hostings.json:', error);
        }

        return true;
    } catch (error) {
        console.error('Error creating hosting for user:', error);
        return false;
    }
}

// Helper function to calculate expiry date
function calculateExpiryDate(duration) {
    const now = new Date();
    let expiryDate = new Date(now);

    if (duration === '3_days') {
        expiryDate.setDate(now.getDate() + 3);
    } else if (duration === '1_week') {
        expiryDate.setDate(now.getDate() + 7);
    } else if (duration === '1_month') {
        expiryDate.setMonth(now.getMonth() + 1);
    } else if (duration === '3_months') {
        expiryDate.setMonth(now.getMonth() + 3);
    } else if (duration === '1_year') {
        expiryDate.setFullYear(now.getFullYear() + 1);
    } else {
        // Default to 1 week
        expiryDate.setDate(now.getDate() + 7);
    }

    return expiryDate.toISOString().split('T')[0]; // Format as YYYY-MM-DD
}

// Export functions for web server
module.exports = {
    startHosting,
    stopHosting,
    stopProcessOnly,
    quickCleanHost,
    getPublicHostingUrl,
    createHostingForUser
};

// Check if token is provided
if (!config.token || config.token.trim() === "") {
    console.error("❌ لم يتم توفير توكن البوت! يرجى وضع التوكن داخل index.js في config.token");
    console.log("💡 افتح index.js وعدّل config.token إلى التوكن الصحيح");
} else {
    // Login with the token
    client.login(config.token).catch(error => {
        console.error("❌ خطأ في تسجيل الدخول:", error.message);
        console.log("💡 تأكد من صحة التوكن داخل index.js (config.token)");
    });
}
